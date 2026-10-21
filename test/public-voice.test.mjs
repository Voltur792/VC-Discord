import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),core=require('./artifact/plugin.cjs');
const guild='111111111111111111',channel='222222222222222222',guest='333333333333333333';
const settings=()=>core.normalizeSettings({textEnabled:true,textChannelId:channel,guildId:guild});
const voice=(extra={})=>({channelId:channel,connected:true,radio:false,listeners:0,...extra});
test('empty public voice expires at the configured deadline, including when music is playing',()=>{
  let now=1000;const exit=new core.PublicVoiceExit(()=>now);exit.start(channel);
  assert.equal(exit.tick(settings(),voice()),false);now+=119999;assert.equal(exit.tick(settings(),voice()),false);now++;assert.equal(exit.tick(settings(),voice()),true);
});
test('returning people, disconnects, another channel, disabled timeout and radio cancel the countdown',()=>{
  for(const [s,v] of [[settings(),voice({listeners:1})],[settings(),voice({connected:false})],[settings(),voice({radio:true})],[settings(),voice({channelId:guest})],[{...settings(),publicVoiceAutoLeaveEnabled:false},voice()]]){
    let now=1000;const exit=new core.PublicVoiceExit(()=>now);exit.start(channel);exit.tick(settings(),voice());now+=119000;assert.equal(exit.tick(s,v),false);
    now+=2000;assert.equal(exit.tick(settings(),voice()),false);now+=120000;assert.equal(exit.tick(settings(),voice()),true);
  }
});
test('a manual or replaced voice session cannot inherit an old public countdown',()=>{
  let now=0;const exit=new core.PublicVoiceExit(()=>now);assert.equal(exit.tick(settings(),voice()),false);exit.start(channel);exit.tick(settings(),voice());now+=120000;exit.stop();assert.equal(exit.tick(settings(),voice()),false);
  exit.start(channel);assert.equal(exit.tick(settings(),voice()),false);
});
test('changing timeout restarts countdown and settings clamp invalid intervals',()=>{
  let now=1000;const exit=new core.PublicVoiceExit(()=>now);exit.start(channel);exit.tick(settings(),voice());now+=119000;
  const changed={...settings(),publicVoiceEmptySeconds:30};assert.equal(exit.tick(changed,voice()),false);now+=30000;assert.equal(exit.tick(changed,voice()),true);
  assert.equal(core.normalizeSettings({publicVoiceEmptySeconds:0}).publicVoiceEmptySeconds,30);assert.equal(core.normalizeSettings({publicVoiceEmptySeconds:99999}).publicVoiceEmptySeconds,1800);
});
function bridgeHarness(){
  const bridge=new core.VoiceBridge();bridge.settings=settings();bridge.summonedChannelId=channel;let stops=0;
  bridge.transport={connected:true,participants:()=>[{id:guest}],disconnect:()=>{stops++;bridge.transport.connected=false;}};bridge.providers={stop:()=>{}};
  return {bridge,message:{userId:guest,guildId:guild,channelId:channel},stops:()=>stops};
}
test('a participant can end a public session without acquiring PC access',async()=>{
  const h=bridgeHarness();assert.match(await h.bridge.publicLeave(h.message,()=>true),/Вышла/);assert.equal(h.stops(),1);assert.deepEqual(h.bridge.settings.allowedUserIds,[]);assert.equal(h.bridge.settings.textEnabled,true);h.bridge.diagnostics.stop();
});
test('public leave rejects absent users, revoked permission, wrong text channel, manual sessions and radio',async()=>{
  for(const kind of ['absent','disabled','wrong-channel','manual','radio','revoked']){
    const h=bridgeHarness();if(kind==='absent')h.bridge.transport.participants=()=>[];if(kind==='disabled')h.bridge.settings.publicVoiceLeaveEnabled=false;if(kind==='wrong-channel')h.message.channelId=guest;if(kind==='manual')h.bridge.summonedChannelId='';if(kind==='radio')h.bridge.radioStarting=true;
    await assert.rejects(h.bridge.publicLeave(h.message,()=>kind!=='revoked'));assert.equal(h.stops(),0);h.bridge.diagnostics.stop();
  }
});
test('voice leave permission applies only to the current public session and never a radio shift',()=>{
  const h=bridgeHarness();assert.equal(h.bridge.canPublicVoiceLeave(guest),true);assert.equal(h.bridge.canPublicVoiceLeave(channel),false);
  h.bridge.radioShift.active={run_id:'a'};assert.equal(h.bridge.canPublicVoiceLeave(guest),false);h.bridge.radioShift.active=undefined;h.bridge.summonedChannelId='';assert.equal(h.bridge.canPublicVoiceLeave(guest),false);h.bridge.diagnostics.stop();
});
test('bridge starts the public countdown and actually disconnects only after the empty deadline',()=>{
  const h=bridgeHarness();let now=1000;h.bridge.publicVoiceExit=new core.PublicVoiceExit(()=>now);h.bridge.transport.participants=()=>[];
  h.bridge.startPublicVoiceExit(channel);now+=119999;h.bridge.checkPublicVoiceExit();assert.equal(h.stops(),0);now++;h.bridge.checkPublicVoiceExit();
  assert.equal(h.stops(),1);assert.equal(h.bridge.publicVoiceExitTimer,undefined);assert.equal(h.bridge.summonedChannelId,'');assert.equal(h.bridge.settings.textEnabled,true);h.bridge.diagnostics.stop();
});
