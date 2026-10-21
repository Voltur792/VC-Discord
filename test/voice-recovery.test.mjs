import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),core=require('./artifact/plugin.cjs');
const {VoiceConnectionStatus}=require('@discordjs/voice');
const guild='111111111111111111',channel='222222222222222222',otherGuild='333333333333333333',bot='444444444444444444';
const shift={run_id:'a'.repeat(32),shift_id:'b'.repeat(32),name:'Test radio',ends_at:Date.parse('2030-01-01T20:00:00Z')/1000,guild_id:guild,channel_id:channel,music:{service:'spotify',mode:'wave'},every:3,when:'end',announce_next:true,skip_empty:true};

function session() {
  let now=Date.parse('2030-01-01T18:00:00Z'),connected=false,pending=false,stops=0,resumes=0;
  const events=[];
  const radio=new core.RadioShiftSession(()=>true,()=>connected,async()=>{connected=true;},()=>{stops++;connected=false;},()=>now,{
    pending:()=>pending,resume:async(_shift,valid)=>{assert.ok(valid());resumes++;},trace:code=>events.push(code),
  });
  return {radio,events,get stops(){return stops;},get resumes(){return resumes;},set connected(v){connected=v;},set pending(v){pending=v;},advance:ms=>{now+=ms;}};
}

test('a transient Discord reconnection keeps the schedule and resumes once when ready',async()=>{
  const s=session();try{
    await s.radio.start(shift);s.connected=false;s.pending=true;s.radio.tick();
    assert.equal(s.stops,0);assert.equal(s.radio.state().active.phase,'recovering');
    s.advance(25000);s.radio.tick();assert.ok(s.radio.active);assert.equal(s.stops,0);
    s.connected=true;s.pending=false;s.radio.tick();await new Promise(r=>setImmediate(r));s.radio.tick();
    assert.equal(s.resumes,1);assert.equal(s.stops,0);assert.equal(s.radio.state().active.phase,'playing');
    assert.deepEqual(s.events,['RADIO_CONNECTION_RECOVERING','RADIO_CONNECTION_RECOVERED']);
  }finally{s.radio.stop();}
});

test('recovery is bounded and explicit disconnects and the scheduled deadline still stop the broadcast',async()=>{
  for(const kind of ['timeout','removed','deadline']){
    const s=session();await s.radio.start(shift);s.connected=false;s.pending=kind!=='removed';s.radio.tick();
    if(kind==='timeout'){s.advance(30000);s.radio.tick();assert.match(s.radio.state().message,/30 секунд/);}
    if(kind==='deadline'){s.advance(7200000);s.radio.tick();}
    assert.equal(s.radio.active,undefined);assert.equal(s.stops,1);
  }
});

test('a cancelled recovery cannot clear or stop a newer scheduled session',async()=>{
  let connected=false,pending=false,release,stops=0;
  const radio=new core.RadioShiftSession(()=>true,()=>connected,async()=>{connected=true;},()=>{connected=false;stops++;},()=>Date.parse('2030-01-01T18:00:00Z'),{
    pending:()=>pending,resume:async(_shift,valid)=>{await new Promise(r=>release=r);if(!valid())throw new Error('Cancelled old recovery');},
  });
  try{
    await radio.start(shift);connected=false;pending=true;radio.tick();connected=true;pending=false;radio.tick();
    radio.stop();await radio.start({...shift,run_id:'c'.repeat(32)});release();await new Promise(r=>setImmediate(r));
    assert.equal(radio.active.run_id,'c'.repeat(32));assert.equal(stops,1);assert.equal(radio.state().active.phase,'playing');
  }finally{radio.stop();}
});

test('the bridge resumes Spotify after reconnection without reconnecting voice or announcing a new shift',async()=>{
  const bridge=new core.VoiceBridge();let connected=false,pending=false,connects=0,following=false;const plays=[];
  bridge.settings=core.normalizeSettings({radioScheduleEnabled:true});bridge.diagnostics.stop();
  bridge.transport={get connected(){return connected;},get recovering(){return pending;},disconnect:()=>{connected=false;}};
  bridge.connect=async()=>{connects++;connected=true;};bridge.providers={stop:()=>{}};
  bridge.music={state:()=>({following}),play:async value=>{plays.push(value);following=true;return {};},stop:()=>{following=false;}};
  let announcements=0;bridge.announceScheduledStart=async()=>{announcements++;};
  const current={...shift,ends_at:Date.now()/1000+7200};
  try{
    await bridge.startRadio(current);connected=false;pending=true;following=false;bridge.radioShift.tick();
    assert.equal(bridge.radioShift.active.run_id,current.run_id);
    connected=true;pending=false;bridge.radioShift.tick();await new Promise(r=>setImmediate(r));
    assert.equal(connects,1);assert.equal(plays.length,2);assert.deepEqual(plays[1],{service:'spotify'});assert.equal(announcements,1);assert.ok(following);
  }finally{bridge.radioShift.stop();}
});

test('foreign-server voice events cannot disconnect the bot, while a real removal is respected',()=>{
  const events=[],states=[];
  const transport=new core.VoiceTransport(()=>core.normalizeSettings({}),()=>{},(...args)=>states.push(args),()=>{},()=>{},code=>events.push(code));
  const client={isReady:()=>true,user:{id:bot}};
  transport.client=client;transport.guildId=guild;transport.channelId=channel;transport.connection={state:{status:VoiceConnectionStatus.Ready}};
  let disconnects=0;transport.disconnect=()=>{disconnects++;transport.connection=undefined;};
  transport.voiceStateChanged(client,{channelId:channel},{guild:{id:otherGuild},id:bot,channelId:null});
  assert.equal(disconnects,0);assert.equal(transport.connected,true);
  transport.connection.state.status=VoiceConnectionStatus.Disconnected;assert.equal(transport.recovering,true);
  transport.connection.state.status=VoiceConnectionStatus.Connecting;assert.equal(transport.recovering,true);
  transport.connection.state.status=VoiceConnectionStatus.Ready;assert.equal(transport.recovering,false);
  transport.voiceStateChanged(client,{channelId:channel},{guild:{id:guild},id:bot,channelId:null});
  assert.equal(disconnects,1);assert.deepEqual(events,['VOICE_BOT_REMOVED']);assert.equal(transport.recovering,false);assert.match(states.at(-1)[0],/отключён или перемещён/);
});

test('voice errors retain their category and safe diagnostic detail without exposing credentials',()=>{
  const logs=[],states=[];const secret='private-bot-token-value';
  const transport=new core.VoiceTransport(()=>core.normalizeSettings({botToken:secret}),()=>{},(...args)=>states.push(args),()=>{},()=>{},(code,error)=>logs.push({code,error}));
  transport.connectionError(new Error(`UDP send failed at 203.0.113.17:5555 token=${secret} secret_key=[1,2,3,4,5] https://voice.example/?auth=private`));
  assert.match(states.at(-1)[0],/передачи звука Discord.*UDP/);assert.equal(states.at(-1)[2],'voice_connection');
  assert.equal(logs.at(-1).error,true);assert.match(logs.at(-1).code,/kind=VOICE_UDP_ERROR/);
  assert.doesNotMatch(logs.at(-1).code,/private|203\.0\.113|1,2,3,4/);
  transport.connectionError(new Error('DAVE MLS transition failed'));
  assert.match(states.at(-1)[0],/защищённого голосового соединения.*DAVE/);
  transport.connectionError(new TypeError('network error',{cause:Object.assign(new Error('closed'),{code:'ECONNRESET'})}));
  assert.match(states.at(-1)[0],/Голосовой сервер Discord прервал/);assert.match(logs.at(-1).code,/NETWORK_CONNECTION_CLOSED/);
});

test('a restored voice connection clears its own UI warning without clearing unrelated failures',()=>{
  const bridge=new core.VoiceBridge();bridge.diagnostics.stop();
  bridge.transport.connectionError(new Error('UDP send failed'));
  assert.match(bridge.state().error,/VOICE_UDP_ERROR/);
  bridge.transport.onState('Голосовая связь Discord восстановлена.',false,'voice_connection');
  assert.equal(bridge.state().error,'');
  bridge.recordError(new Error('Нет доступа к текстовому каналу.'),'text_discord');
  bridge.transport.onState('Голосовая связь Discord восстановлена.',false,'voice_connection');
  assert.equal(bridge.state().error,'Нет доступа к текстовому каналу.');
});
