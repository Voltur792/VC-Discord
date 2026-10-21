import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
const project=resolve(import.meta.dirname,'..');
mkdirSync(join(project,'.tmp-tests'),{recursive:true});
const temporary=mkdtempSync(join(project,'.tmp-tests','network-'));
process.env.DVOICE_DATA_DIR=temporary;
const core=createRequire(import.meta.url)('./artifact/plugin.cjs');
after(()=>{assert.ok(temporary.startsWith(project+sep));rmSync(temporary,{recursive:true,force:true});});

function brokenResponse() {
  let pulls=0;
  return new Response(new ReadableStream({pull(controller){
    if(!pulls++)controller.enqueue(new TextEncoder().encode('{"choices":['));
    else controller.error(new Error('other side closed',{cause:Object.assign(new Error('socket closed'),{code:'UND_ERR_SOCKET'})}));
  }}));
}

test('a connection closed during response reading preserves service context and never returns partial data',async()=>{
  await assert.rejects(core.limitedBody(brokenResponse(),2000000,'Модель разговора'),error=>{
    assert.match(error.message,/Модель разговора: Сервер прервал соединение/);
    assert.doesNotMatch(error.message,/other side closed|socket/);
    assert.equal(core.networkErrorCode(error),'NETWORK_CONNECTION_CLOSED');return true;
  });
});

test('UI errors handle nested network failures, retain Russian explanations and redact secrets',()=>{
  assert.match(core.safeError(new Error('other side closed')),/Сервер прервал соединение/);
  const nested=new TypeError('fetch failed',{cause:Object.assign(new Error('connect'),{code:'ECONNREFUSED'})});
  assert.equal(core.networkErrorCode(nested),'NETWORK_UNAVAILABLE');assert.match(core.safeError(nested),/Не удалось связаться/);
  assert.equal(core.networkErrorCode(Object.assign(new Error('request expired'),{name:'TimeoutError'})),'NETWORK_TIMEOUT');
  const cancellation=Object.assign(new Error('Request cancelled'),{name:'AbortError'});assert.equal(core.networkErrorCode(cancellation),undefined);
  const message='Модель разговора: сервер недоступен. Проверьте настройки.';
  assert.equal(core.safeError(new Error(message)),message);
  assert.equal(core.safeError(new Error('secret-token Bearer hidden-value'),{...core.defaults,botToken:'secret-token'}),'[скрыто] Bearer [скрыто]');
  const cycle=new Error('ordinary error');cycle.cause=cycle;assert.equal(core.networkErrorCode(cycle),undefined);
});

test('a dropped Astra UI bridge connection is localized without automatically repeating the action',async()=>{
  const source=readFileSync(join(project,'ui/web/app.js'),'utf8');
  const body=source.slice(source.indexOf('async function backend('),source.indexOf('function notice(')).trim();
  let calls=0;
  const window={astra:{callBackend:async()=>{calls++;throw new Error('other side closed');}}};
  const backend=runInNewContext('('+body+')',{window,Date,setTimeout,clearTimeout});
  await assert.rejects(backend('music_next'),error=>{assert.match(error.message,/Связь вкладки с Astra прервалась/);assert.doesNotMatch(error.message,/other side/);return true;});
  assert.equal(calls,1);
  window.astra.callBackend=async()=>({ok:false,error:'Владелец отключил музыкальные заказы.'});
  await assert.rejects(backend('music_play'),error=>error.message==='Владелец отключил музыкальные заказы.');
  window.astra.callBackend=async()=>({ok:true});assert.equal((await backend('music_next')).ok,true);
});

test('a broken text model response yields one localized error, and a successful response clears its stale UI banner',async t=>{
  const bridge=new core.VoiceBridge();bridge.diagnostics.stop();
  const guild='111111111111111111',channel='222222222222222222';
  bridge.settings=core.normalizeSettings({guildId:guild,textChannelId:channel,textEnabled:true,textChatEnabled:true,llmUseAstra:false,llmModel:'test-model',llmBaseUrl:'http://127.0.0.1:1234/v1'});
  let requests=0;const original=globalThis.fetch,logged=[],replies=[];
  bridge.ctx={log:async(_level,message)=>logged.push(message)};
  globalThis.fetch=async()=>++requests===1?brokenResponse():new Response(JSON.stringify({choices:[{message:{content:'Привет!'}}]}));
  t.after(()=>{globalThis.fetch=original;bridge.textRoom.reset();});
  const message=(id,userId)=>({id,userId,guildId:guild,channelId:channel,content:'Астра ты тут?',mentioned:false,replyToBot:false,reply:async text=>{replies.push(text);return 'reply-'+id;}});
  await bridge.textRoom.receive(message('first','333333333333333333'));
  assert.equal(requests,1,'Do not repeat a request automatically after a partially received response');
  assert.equal(replies.length,1);assert.match(replies[0],/Модель разговора: Сервер прервал соединение/);
  assert.doesNotMatch(bridge.state().error,/other side closed/);assert.match(bridge.state().error,/Сервер прервал соединение/);
  assert.equal(bridge.diagnosticReport().lastFailure.code,'NETWORK_CONNECTION_CLOSED');
  assert.ok(logged.some(message=>message.includes('NETWORK_CONNECTION_CLOSED; action=text_discord')));
  await bridge.textRoom.receive(message('second','444444444444444444'));
  assert.equal(requests,2);assert.equal(replies.at(-1),'Привет!');assert.equal(bridge.state().error,'');
  bridge.recordError(new Error('Проверьте разрешения канала.'),'text_discord');
  await bridge.textRoom.receive(message('third','555555555555555555'));
  assert.equal(bridge.state().error,'Проверьте разрешения канала.','A successful chat must not clear unrelated permission failures');
});
