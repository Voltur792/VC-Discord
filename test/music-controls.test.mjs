import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
const project=resolve(import.meta.dirname,'..');
mkdirSync(join(project,'.tmp-tests'),{recursive:true});
const folder=mkdtempSync(join(project,'.tmp-tests','controls-'));
process.env.SPT_INTEGRATION_DIR=folder;
process.env.DVOICE_DATA_DIR=folder;
writeFileSync(join(folder,'music.json'),JSON.stringify({port:12345,token:'a'.repeat(40)}));
const core=createRequire(import.meta.url)('./artifact/plugin.cjs');
after(()=>{assert.ok(folder.startsWith(project+sep));rmSync(folder,{recursive:true,force:true});});

function player(t, response) {
  const calls=[], original=globalThis.fetch;
  let stopped;
  const stopRequested=new Promise(resolve=>stopped=resolve);
  const music=new core.DiscordMusic({connected:true,musicStats:()=>({}),stopMusic:()=>{},pauseMusic:()=>{},musicPresence:()=>{}},()=>core.normalizeSettings({}),()=>{});
  music.following=true;music.spotifyStream=true;music.session='c'.repeat(32);music.revision=8;music.controller=new AbortController();music.decoderAttached=true;
  music.child={kill:()=>{},stdout:{destroy:()=>{}},stdin:{destroy:()=>{}}};
  globalThis.fetch=async(_url,request)=>{
    const input=JSON.parse(request.body);calls.push(input);
    if(input.method==='discord_stop')stopped();
    const data=await response(input);
    return new Response(JSON.stringify(data));
  };
  t.after(()=>{music.session='';music.stop();globalThis.fetch=original;});
  return {music,calls,stopRequested};
}
const track=title=>({service:'spotify',codec:'pcm_s16le',spotify_status:'playing',revision:8,status:'ready',title,artist:'Artist',stream_url:'http://127.0.0.1:12345/'+'b'.repeat(40)+'/discord-stream/8/0'});

test('next and previous send the correct direction and confirm the track returned by the music bridge',async t=>{
  let title;
  const p=player(t,input=>{if(input.method==='discord_next'){title=input.params.direction===1?'Next song':'Previous song';return {status:'ready'};}return track(title);});
  const signal=new AbortController().signal;
  assert.match(await p.music.control('next',()=>true,signal),/Next song/);
  assert.match(await p.music.control('previous',()=>true,signal),/Previous song/);
  assert.deepEqual(p.calls.filter(c=>c.method==='discord_next').map(c=>c.params.direction),[1,-1]);
  assert.equal(p.music.state().title,'Previous song');
});

test('queue exhaustion stops playback and never reports a successful track switch',async t=>{
  const p=player(t,()=>({status:'stopped'}));
  const answer=await p.music.control('next',()=>true,new AbortController().signal);
  await p.stopRequested;
  assert.match(answer,/Очередь закончилась/);assert.doesNotMatch(answer,/Переключ/);assert.equal(p.music.state().following,false);
});

test('revoking permission while waiting for an existing sync prevents a remote skip',async t=>{
  const p=player(t,()=>assert.fail('No request may be sent after revocation'));
  let release,allowed=true;
  p.music.syncFinished=new Promise(resolve=>release=resolve);
  const pending=p.music.control('next',()=>allowed,new AbortController().signal);
  allowed=false;release();
  await assert.rejects(pending,/отменена/);assert.equal(p.calls.length,0);assert.equal(p.music.state().following,true);
});

test('revocation during a skip stops the old session before syncing or reporting success',async t=>{
  let release,requested,allowed=true;
  const started=new Promise(resolve=>requested=resolve);
  const p=player(t,async input=>{if(input.method==='discord_next'){requested();return new Promise(resolve=>release=()=>resolve({status:'ready'}));}return {};});
  const pending=p.music.control('next',()=>allowed,new AbortController().signal);
  await started;allowed=false;release();
  await assert.rejects(pending,/отменена/);await p.stopRequested;
  assert.equal(p.music.state().following,false);assert.ok(!p.calls.some(c=>c.method==='discord_state'));
});

test('cancelling an old text command cannot stop a newer music session',async t=>{
  const p=player(t,()=>assert.fail('Cancelled old command must not call the bridge'));
  let release;const controller=new AbortController();
  p.music.syncFinished=new Promise(resolve=>release=resolve);
  const pending=p.music.control('next',()=>true,controller.signal);
  p.music.epoch++;p.music.session='d'.repeat(32);controller.abort();release();
  await assert.rejects(pending,/отменена/);assert.equal(p.music.state().following,true);assert.equal(p.music.session,'d'.repeat(32));assert.equal(p.calls.length,0);
});

test('a failed music bridge never yields a success acknowledgement',async t=>{
  const p=player(t,input=>{if(input.method==='discord_next')throw new Error('socket closed');return {};});
  await assert.rejects(p.music.control('previous',()=>true,new AbortController().signal),/Нет ответа/);await p.stopRequested;
  assert.equal(p.music.state().following,false);
});
