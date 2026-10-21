import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,mkdirSync,rmSync,statSync,renameSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const project=resolve(import.meta.dirname,'..');
mkdirSync(join(project,'.tmp-tests'),{recursive:true});
const temporary=mkdtempSync(join(project,'.tmp-tests','platform-'));
process.env.DVOICE_DATA_DIR=temporary;
process.env.SPT_INTEGRATION_DIR=join(temporary,'integrations');
const require=createRequire(import.meta.url), core=require('./artifact/plugin.cjs');
after(()=>rmSync(temporary,{recursive:true,force:true}));

test('user data uses the OS profile and ignores relative XDG paths',()=>{
  assert.equal(core.userData('linux',{XDG_DATA_HOME:'relative',APPDATA:'ignored'},temporary),join(temporary,'.local','share'));
  assert.equal(core.userData('linux',{XDG_DATA_HOME:join(temporary,'xdg')},temporary),join(temporary,'xdg'));
  assert.equal(core.userData('darwin',{APPDATA:'ignored'},temporary),join(temporary,'Library','Application Support'));
  assert.equal(core.userData('win32',{APPDATA:temporary},'unused'),temporary);
});

test('each native platform has a real executable of the correct format',()=>{
  const targets=['win32-x64-msvc','win32-arm64-msvc','linux-x64-gnu','darwin-x64','darwin-arm64'];
  for(const target of targets){
    const file=readFileSync(join(project,'dist','native','davey',target+'.node'));
    assert.ok(file.length>100_000,target);
    if(target.startsWith('win32')) assert.equal(file.subarray(0,2).toString(),'MZ',target);
    else if(target.startsWith('linux')) assert.equal(file.subarray(0,4).toString('hex'),'7f454c46',target);
    else assert.equal(file.subarray(0,4).toString('hex'),'cffaedfe',target);
  }
  const native=require('./artifact/native/davey.cjs');
  assert.equal(typeof native.DAVESession,'function','the current platform module must really load');
});

test('portable secret store survives reload and detects corruption',{skip:process.platform==='win32'},async()=>{
  const sealed=await core.runPosix({action:'protect',value:'private-test-value'});
  assert.match(sealed.toString(),/^local-v1:/);
  assert.equal((statSync(join(temporary,'secrets.key')).mode&0o777),0o600);
  assert.equal((await core.runPosix({action:'unprotect',value:sealed.toString()})).toString(),'private-test-value');
  const bytes=Buffer.from(sealed.toString().slice(9),'base64');bytes[bytes.length-1]^=1;
  await assert.rejects(core.runPosix({action:'unprotect',value:'local-v1:'+bytes.toString('base64')}));
  await assert.rejects(core.runPosix({action:'unprotect',value:'windows-protected-content'}),/Windows/);
  renameSync(join(temporary,'secrets.key'),join(temporary,'secrets.backup'));
  await assert.rejects(core.runPosix({action:'unprotect',value:sealed.toString()}),/secrets.key/);
  assert.equal(existsSync(join(temporary,'secrets.key')),false,'a missing decryption key must never be replaced with a new one');
  renameSync(join(temporary,'secrets.backup'),join(temporary,'secrets.key'));
});

test('portable system speech returns strict PCM WAV without playing on this PC',{skip:process.platform==='win32'||process.env.TEST_SYSTEM_SPEECH!=='1'},async()=>{
  const audio=await core.runPosix({action:'speak',text:'Проверка голоса',rate:0},AbortSignal.timeout(60000));
  const wav=core.fromWav(audio);assert.ok(wav.pcm.length>100);assert.equal(wav.channels,1);
});
