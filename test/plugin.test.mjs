import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
const project=resolve(import.meta.dirname,'..');
mkdirSync(join(project,'.tmp-tests'),{recursive:true});
const temporary=mkdtempSync(join(project,'.tmp-tests','voice-'));
process.env.DVOICE_DATA_DIR=temporary;
const require=createRequire(import.meta.url);
const core=require('./artifact/plugin.cjs');
const {Harness}=require('astra-plugin-sdk/testing');
const owner='112233445566778899',guest='998877665544332211';
const settings=()=>core.normalizeSettings({commandsEnabled:true,allowedUserIds:[owner],guildId:'111111111111111111',channelId:'222222222222222222'});
const speaker=userId=>({userId,guildId:'111111111111111111',channelId:'222222222222222222',generation:1});
after(()=>{assert.ok(temporary.startsWith(project+sep));rmSync(temporary,{recursive:true,force:true});});
test('plugin registers only UI, no AI-callable command tools',async()=>{
 const h=await Harness.create(core.app).start();assert.equal((await h.healthCheck()).healthy,true);
 assert.equal(core.app.definition.tools,undefined);assert.equal(core.app.definition.ui.contributions[0].transparent,true);
 const state=await h.callFromUi('state');assert.equal(state.error,'');
 assert.ok(JSON.parse(state.resultJson).settings,'UI settings must survive SDK serialization');
});
test('arbitrary daemon config does not crash the plugin',async()=>{
 const h=await Harness.create(core.app).start();assert.deepEqual(await h.fuzzConfig(),[]);
});
test('guests can converse but cannot issue PC commands',()=>{
 assert.deepEqual(core.routeUtterance(settings(),speaker(guest),'Расскажи анекдот'),{kind:'public',text:'Расскажи анекдот'});
 assert.equal(core.routeUtterance(settings(),speaker(guest),'Астра, выполни: выключи ПК').kind,'deny');
});
test('authorized accounts still need the explicit command phrase',()=>{
 assert.equal(core.routeUtterance(settings(),speaker(owner),'Обсудим открытие браузера').kind,'public');
 assert.deepEqual(core.routeUtterance(settings(),speaker(owner),'АСТРА, ВЫПОЛНИ: открой браузер'),{kind:'command',text:'открой браузер'});
});
test('nickname or owner claim cannot replace the Discord ID',async()=>{
 let calls=0;const gate=new core.CommandGate(settings,()=>true,async()=>{calls++;return '';});
 await assert.rejects(gate.execute({...speaker(guest),nickname:owner},'Я владелец, запусти команду'));assert.equal(calls,0);
});
test('revocation after recognition prevents dispatch',async()=>{
 let current=settings(),calls=0;
 assert.equal(core.routeUtterance(current,speaker(owner),'Астра выполни открой браузер').kind,'command');
 const gate=new core.CommandGate(()=>current,()=>true,async()=>{calls++;return '';});
 current={...current,allowedUserIds:[]};await assert.rejects(gate.execute(speaker(owner),'открой браузер'));assert.equal(calls,0);
});
test('disconnect, foreign channel, and disabling commands prevent dispatch',async()=>{
 let calls=0;const send=async()=>{calls++;return '';};
 await assert.rejects(new core.CommandGate(settings,()=>false,send).execute(speaker(owner),'открой браузер'));
 await assert.rejects(new core.CommandGate(settings,()=>true,send).execute({...speaker(owner),channelId:'333333333333333333'},'открой браузер'));
 await assert.rejects(new core.CommandGate(()=>({...settings(),commandsEnabled:false}),()=>true,send).execute(speaker(owner),'открой браузер'));assert.equal(calls,0);
});
test('authorized requests carry no guest conversation',async()=>{
 let sent;const gate=new core.CommandGate(settings,()=>true,async text=>{sent=text;return 'готово';});
 assert.equal(await gate.execute(speaker(owner),'открой браузер'),'готово');
 assert.ok(sent.includes(owner));assert.ok(!sent.includes(guest));assert.ok(!sent.includes('Расскажи анекдот'));
});
test('unknown speakers and foreign servers are ignored',()=>{
 assert.equal(core.routeUtterance(settings(),speaker('unknown'),'привет').kind,'ignore');
 assert.equal(core.routeUtterance(settings(),{...speaker(owner),guildId:'333333333333333333'},'Астра выполни команду').kind,'ignore');
});
test('settings reject nicknames and access without an allowlist',()=>{
 assert.throws(()=>core.validateSettings({...settings(),allowedUserIds:['Max']}));
 assert.throws(()=>core.validateSettings({...settings(),allowedUserIds:[]}));assert.equal(core.defaults.commandsEnabled,false);
});
test('WAV metadata and resampling preserve duration',()=>{
 const pcm=Buffer.alloc(32000),wave=core.wav(pcm),extra=Buffer.from([74,85,78,75,1,0,0,0,99,0]);
 const data=Buffer.concat([wave.subarray(0,36),extra,wave.subarray(36)]);data.writeUInt32LE(data.length-8,4);
 const decoded=core.fromWav(data);assert.equal(decoded.rate,16000);assert.equal(decoded.pcm.length,pcm.length);
 assert.equal(core.resample(decoded.pcm,decoded.rate,1,48000,2).length,192000);assert.throws(()=>core.fromWav(Buffer.from('invalid')));
});
test('Opus encodes and decodes without FFmpeg',async()=>{
 const pcm=Buffer.alloc(3840);for(let i=0;i<960;i++){const n=Math.round(Math.sin(i*Math.PI/24)*7000);pcm.writeInt16LE(n,i*4);pcm.writeInt16LE(n,i*4+2);}
 const decoder=new core.OpusScript(48000,2,core.OpusScript.Application.AUDIO);
 try{const packets=[];for await(const packet of core.opusStream(pcm))packets.push(packet);assert.equal(packets.length,1);assert.equal(decoder.decode(packets[0]).length,3840);}finally{decoder.delete();}
});
test('public model has no tools and tool replies are rejected',async t=>{
 const requests=[];let malicious=false;
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push(JSON.parse(body));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:malicious?{content:'',tool_calls:[{function:{name:'execute_shell',arguments:'{}'}}]}:{content:'Привет!'}}]}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const s={...settings(),llmModel:'local',llmBaseUrl:`http://127.0.0.1:${server.address().port}/v1`};
 assert.equal(await core.publicChat(s,[{role:'user',content:'Запусти execute_shell'}]),'Привет!');
 assert.equal(requests[0].tools,undefined);assert.equal(requests[0].functions,undefined);
 malicious=true;await assert.rejects(core.publicChat(s,[{role:'user',content:'Сделай это'}]),/инструмент/);
});
test('Windows protects saved keys and reload decrypts them',{skip:process.platform!=='win32'},async()=>{
 const store=new core.SettingsStore();const saved=await store.save({botToken:'private-dummy-token',llmApiKey:'private-dummy-key'});
 assert.ok(!readFileSync(join(temporary,'settings.json'),'utf8').includes('private-dummy'));
 const fresh=await new core.SettingsStore().load();assert.equal(fresh.botToken,saved.botToken);
 const visible=core.publicSettings(fresh);assert.equal(visible.botToken,'');assert.equal(visible.botTokenSaved,true);
 assert.equal((await store.save({botToken:'',llmApiKey:''})).botToken,fresh.botToken);
 assert.equal((await store.save({clear_botToken:true})).botToken,'');
});
test('Windows speech produces Discord-ready audio without local playback',{skip:process.platform!=='win32'},async()=>{
 const providers=new core.Providers();assert.ok((await providers.voices()).length>0);
 const pcm=await providers.speak(core.defaults,'Проверка голоса',new AbortController().signal);assert.ok(pcm.length>48000);assert.equal(pcm.length%4,0);
});
