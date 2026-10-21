import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require=createRequire(import.meta.url),core=require('./artifact/plugin.cjs');
const runId='a'.repeat(32),shiftId='b'.repeat(32);
const now=new Date(2030,0,7,18,0).getTime();
const shift=(changes={})=>({run_id:runId,shift_id:shiftId,name:'Evening radio',ends_at:now/1000+7200,guild_id:'111111111111111111',channel_id:'222222222222222222',music:{service:'spotify',mode:'wave'},every:3,when:'end',announce_next:true,...changes});

test('scheduled shift starts once, enables radio and expires without the timer plugin',async()=>{
 let clock=now,connected=false,starts=0,stops=0;
 const session=new core.RadioShiftSession(()=>true,()=>connected,async s=>{starts++;connected=true;assert.equal(s.music.service,'spotify');},()=>{stops++;connected=false;},()=>clock);
 try {
  await session.start(shift());await session.start(shift());assert.equal(starts,1);assert.equal(session.state().active.phase,'playing');
  assert.equal(session.stop('c'.repeat(32)).stopped,false);assert.equal(connected,true);
  clock+=7200000;session.tick();assert.equal(connected,false);assert.equal(stops,1);assert.equal(session.active,undefined);
  connected=true;session.stop(runId);assert.equal(connected,true);assert.equal(stops,1);
 }finally{session.stop();}
});

test('disabled and busy schedules do not displace a manual connection',async()=>{
 let allowed=false,connected=false,starts=0,stops=0;
 const session=new core.RadioShiftSession(()=>allowed,()=>connected,async()=>starts++,()=>stops++,()=>now);
 await assert.rejects(session.start(shift()),/Разрешите/);
 allowed=true;connected=true;await assert.rejects(session.start(shift()),/уже занят/);
 assert.equal(starts,0);assert.equal(stops,0);assert.equal(session.active,undefined);
});

test('deadline or cancellation during connection cannot leave a late broadcast running',async()=>{
 let clock=now,release,stops=0;
 const session=new core.RadioShiftSession(()=>true,()=>false,async(s,valid)=>{await new Promise(r=>release=r);assert.equal(valid(),false);},()=>stops++,()=>clock);
 const starting=session.start(shift());clock+=7200000;session.tick();release();
 assert.equal((await starting).cancelled,true);assert.equal(session.active,undefined);assert.equal(stops,1);
});

test('shift validation rejects arbitrary actions and bounds metadata',()=>{
 for(const data of [shift({ends_at:now/1000}),shift({channel_id:'nickname'}),shift({music:{service:'vk',mode:'wave'}}),shift({music:{service:'spotify',mode:'playlist',playlist_id:''}})]) assert.throws(()=>core.validateRadioShift(data,now));
 const data=core.validateRadioShift(shift({name:'X'.repeat(500),token:'secret',music:{service:'spotify',mode:'playlist',playlist_id:'abc',private:'secret'}}),now);
 assert.equal(data.name.length,100);assert.equal(JSON.stringify(data).includes('secret'),false);
});

test('scheduled connection uses temporary channel and radio settings and preserves user settings',async()=>{
 const bridge=new core.VoiceBridge();let connected=false,played;
 bridge.settings=core.normalizeSettings({radioScheduleEnabled:true,radioEnabled:false,guildId:'333333333333333333',channelId:'444444444444444444'});
 const before={...bridge.settings};
 bridge.transport={get connected(){return connected;},connect:async()=>{assert.equal(bridge.effectiveSettings().channelId,'222222222222222222');connected=true;},disconnect:()=>{connected=false;},moderationRooms:()=>[]};
 bridge.music={play:async value=>{played=value;assert.equal(bridge.effectiveSettings().radioEnabled,true);return {ok:true};},cancelRadio:()=>{}};
 const data=shift({ends_at:Date.now()/1000+120});
 await bridge.radioShift.start(data);assert.equal(played.mode,'wave');assert.deepEqual(bridge.settings,before);
 bridge.disconnect();assert.equal(connected,false);assert.equal(bridge.effectiveSettings().radioEnabled,false);assert.deepEqual(bridge.settings,before);
 await bridge.shutdown();
});

test('cancelled shift cannot connect after slow speech provider preparation',async()=>{
 const bridge=new core.VoiceBridge();let release,entered=false,connections=0;
 bridge.settings=core.normalizeSettings({radioScheduleEnabled:true,sttEngine:'whisper',sttUseAstra:false});
 bridge.providers={whisper:{start:async()=>{entered=true;await new Promise(r=>release=r);}},stop:()=>{}};
 bridge.transport={connected:false,connect:async()=>connections++,disconnect:()=>{}};
 const starting=bridge.radioShift.start(shift({ends_at:Date.now()/1000+120}));
 assert.equal(entered,true);
 await assert.rejects(bridge.connect(),/уже выполняется/);
 bridge.radioShift.stop();release();
 await assert.rejects(starting,/отменено/);
 assert.equal(connections,0);assert.equal(bridge.radioShift.active,undefined);
 bridge.diagnostics.stop();
});

test('public requests cannot replace scheduled music while search and conversation stay separate',async()=>{
 const bridge=new core.VoiceBridge();bridge.settings=core.normalizeSettings({textMusicEnabled:true,textEnabled:true,textSummonEnabled:true});
 let plays=0;bridge.music={request:async()=>{plays++;return {};}};
 bridge.radioShift.active=shift({ends_at:Date.now()/1000+120});
 await assert.rejects(bridge.publicPlay({service:'vk',mode:'playlist',playlist_id:'-123:456:hash'},{},()=>true,new AbortController().signal),/Идёт смена/);
 assert.equal(plays,0);bridge.radioShift.active=undefined;bridge.diagnostics.stop();
});

test('a confirmed scheduled start announces once with start, end and voice destination, even when AI chat is disabled',async()=>{
 const bridge=new core.VoiceBridge();let connected=false,plays=0;const sent=[];
 bridge.settings=core.normalizeSettings({radioScheduleEnabled:true,textEnabled:true,textChatEnabled:false,guildId:'111111111111111111',textChannelId:'666666666666666666'});
 bridge.transport={get connected(){return connected;},disconnect:()=>{connected=false;}};
 bridge.connect=async valid=>{assert.ok(valid());connected=true;};
 bridge.music={play:async()=>{plays++;return {};},stop:()=>{}};bridge.providers={stop:()=>{}};
 bridge.textDiscord.announce=async(content,valid)=>{assert.ok(valid());sent.push(content);return true;};
 const data=shift({ends_at:Date.now()/1000+120});
 await bridge.startRadio(data);await bridge.startRadio(data);
 assert.equal(plays,1);assert.equal(sent.length,1);assert.match(sent[0],/Начала работу по расписанию/);assert.match(sent[0],/Начало:/);
 assert.ok(sent[0].includes(`<#${data.channel_id}>`));assert.ok(sent[0].includes(bridge.radioDate(data.ends_at*1000)));assert.match(sent[0],/UTC\+5/);
 bridge.radioShift.stop();bridge.diagnostics.stop();
});

test('failed playback and disabled announcements never announce a start; a failed send does not stop the broadcast',async()=>{
 for(const kind of ['failed-play','disabled','failed-send']){
  const bridge=new core.VoiceBridge();let connected=false,sends=0;
  bridge.diagnostics.stop();bridge.settings=core.normalizeSettings({radioScheduleEnabled:true,radioScheduleAnnounce:kind!=='disabled',textEnabled:true,guildId:'111111111111111111',textChannelId:'666666666666666666'});
  bridge.transport={get connected(){return connected;},disconnect:()=>{connected=false;}};
  bridge.connect=async()=>{connected=true;};bridge.providers={stop:()=>{}};
  bridge.music={play:async()=>{if(kind==='failed-play')throw new Error('Не удалось включить музыку.');return {};},stop:()=>{}};
  bridge.textDiscord.announce=async()=>{sends++;throw new Error('Нет доступа к текстовому каналу.');};
  const pending=bridge.startRadio(shift({ends_at:Date.now()/1000+120}));
  if(kind==='failed-play')await assert.rejects(pending,/Не удалось включить/);else await pending;
  assert.equal(sends,kind==='failed-send'?1:0);assert.equal(!!bridge.radioShift.active,kind!=='failed-play');
  bridge.radioShift.stop();
 }
});

test('schedule priority takes over a publicly summoned session, preserves settings and leaves text online',async()=>{
 const bridge=new core.VoiceBridge();let connected=true,stops=0,played=0;
 bridge.settings=core.normalizeSettings({botToken:'test-token',guildId:'111111111111111111',textChannelId:'666666666666666666',radioScheduleEnabled:true,textEnabled:true,textSummonEnabled:true,channelId:'444444444444444444'});
 bridge.summonedChannelId='555555555555555555';const before={...bridge.settings};let resets=0;
 bridge.textRoom={reset:()=>resets++};bridge.transport={get connected(){return connected;},disconnect:()=>{stops++;connected=false;},connect:async()=>{connected=true;}};
 bridge.providers={stop:()=>{}};bridge.music={play:async()=>{played++;return {};},cancelRadio:()=>{}};
 await bridge.startRadio(shift({ends_at:Date.now()/1000+120}));assert.equal(played,1);assert.equal(stops,1);assert.equal(resets,1);
 assert.equal(bridge.summonedChannelId,'');assert.deepEqual(bridge.settings,before);
 bridge.radioShift.stop();assert.equal(stops,2);assert.equal(bridge.settings.textEnabled,true);bridge.diagnostics.stop();
});

test('disabled schedule priority and manual sessions keep their voice connection',async()=>{
 for(const [takeover,summoned] of [[false,true],[true,false]]) {
  const bridge=new core.VoiceBridge();bridge.settings=core.normalizeSettings({radioScheduleEnabled:true,radioScheduleTakeover:takeover});bridge.summonedChannelId=summoned?'555555555555555555':'';
  let stopped=0;bridge.transport={connected:true,disconnect:()=>stopped++};
  await assert.rejects(bridge.startRadio(shift({ends_at:Date.now()/1000+120})),/уже занят/);assert.equal(stopped,0);bridge.diagnostics.stop();
 }
});

test('takeover waits for old summon cleanup before starting a new scheduled connection',async()=>{
 const bridge=new core.VoiceBridge();let release,cleaned=false,starts=0;
 bridge.settings=core.normalizeSettings({radioScheduleEnabled:true});bridge.summonedChannelId='555555555555555555';
 bridge.transport={connected:false,disconnect:()=>{}};bridge.providers={stop:()=>{}};
 bridge.publicJoinWork=new Promise(r=>{release=()=>{cleaned=true;r('cancelled');};});
 bridge.connect=async()=>{assert.equal(cleaned,true);starts++;};bridge.music={play:async()=>({})};
 // The session checks connected after the start callback; emulate a live connection.
 bridge.connect=async()=>{assert.equal(cleaned,true);starts++;bridge.transport.connected=true;};
 const pending=bridge.startRadio(shift({ends_at:Date.now()/1000+120}));assert.equal(starts,0);release();await pending;
 assert.equal(starts,1);bridge.radioShift.stop();bridge.diagnostics.stop();
});

test('local timer bridge authenticates, limits methods and preserves another descriptor on close',async t=>{
 const project=resolve(import.meta.dirname,'..'),folder=await mkdtemp(join(project,'.tmp-radio-'));
 const old=process.env.SPT_INTEGRATION_DIR;process.env.SPT_INTEGRATION_DIR=folder;
 const server=new core.TimerIntegration({radio_state:()=>({allowed:true,active:null})},e=>e.message);
 t.after(async()=>{await server.close();if(old===undefined)delete process.env.SPT_INTEGRATION_DIR;else process.env.SPT_INTEGRATION_DIR=old;assert.ok(folder.startsWith(project+sep));await rm(folder,{recursive:true,force:true});});
 await server.start();const descriptor=JSON.parse(await readFile(join(folder,'discord.json'),'utf8')),url=`http://127.0.0.1:${descriptor.port}/api`;
 const send=(method,auth=descriptor.token,extra={})=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json',...extra},body:JSON.stringify({method,params:{}})});
 assert.equal((await send('radio_state','wrong')).status,403);assert.equal((await send('radio_state',descriptor.token,{Origin:'https://example.com'})).status,403);
 assert.equal((await send('arbitrary_command')).status,404);assert.deepEqual(await(await send('radio_state')).json(),{allowed:true,active:null});
 assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+descriptor.token},body:'x'.repeat(33000)})).status,413);
 await writeFile(join(folder,'discord.json'),JSON.stringify({port:1,token:'replacement'}));await server.close();
 assert.equal(JSON.parse(await readFile(join(folder,'discord.json'),'utf8')).token,'replacement');
});

test('real Python timer scheduler starts and stops the Node bridge through authenticated IPC',{skip:!process.env.SPT_TEST_PROJECT_ROOT},async t=>{
 const project=resolve(import.meta.dirname,'..'),folder=await mkdtemp(join(project,'.tmp-radio-ipc-'));
 const old=process.env.SPT_INTEGRATION_DIR;process.env.SPT_INTEGRATION_DIR=folder;
 let connected=false;const heard=[];
 const session=new core.RadioShiftSession(()=>true,()=>connected,async s=>{connected=true;heard.push(s.music);},()=>{connected=false;},()=>now);
 const server=new core.TimerIntegration({radio_start:p=>session.start(p),radio_state:()=>session.state(),radio_stop:p=>session.stop(p.run_id)},e=>e.message);
 t.after(async()=>{session.stop();await server.close();if(old===undefined)delete process.env.SPT_INTEGRATION_DIR;else process.env.SPT_INTEGRATION_DIR=old;assert.ok(folder.startsWith(project+sep));await rm(folder,{recursive:true,force:true});});
 await server.start();
 const source=`import asyncio,json,sys\nfrom pathlib import Path\nfrom datetime import datetime\nsys.path.insert(0,sys.argv[1])\nfrom src.radio_schedule import RadioSchedule\nasync def run():\n clock=[datetime(2030,1,7,18,0)]\n store=RadioSchedule(Path(sys.argv[2])/'shifts.json',lambda:clock[0])\n await store.upsert({'start':'18:00','end':'20:00','days':[0],'guild_id':'111111111111111111','channel_id':'222222222222222222','music':{'service':'spotify','mode':'wave'}})\n await store.tick()\n assert store.rows[0]['result']=='В эфире'\n assert store.active\n clock[0]=datetime(2030,1,7,20,0)\n await store.tick()\n assert store.active is None\n print(json.dumps({'starts':1,'ended':True}))\nasyncio.run(run())`;
 const result=await promisify(execFile)(process.env.SPT_TEST_PYTHON||'python',['-c',source,resolve(process.env.SPT_TEST_PROJECT_ROOT),folder],{timeout:15000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 assert.deepEqual(JSON.parse(result.stdout),{starts:1,ended:true});assert.equal(connected,false);assert.deepEqual(heard,[{service:'spotify',mode:'wave',playlist_id:''}]);
});
