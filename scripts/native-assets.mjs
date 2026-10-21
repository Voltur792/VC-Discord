// One noarch bundle contains separate pinned N-API modules. A Linux/macOS
// runtime never attempts to load a Windows DLL. Downloads are build-time only.
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Astra's Linux host targets x64; this release supports glibc distributions.
// musl and Linux ARM are outside the declared platform support of this bundle.
export const targets = ['win32-x64-msvc','win32-arm64-msvc','linux-x64-gnu','darwin-x64','darwin-arm64'];

export function extractNative(archive) {
  const tar = gunzipSync(archive, {maxOutputLength: 64 * 1024 * 1024});
  for (let offset=0; offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512),name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
    if (!name) break;
    const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
    if (!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length) throw new Error('Invalid native archive');
    if (/^package\/davey\.[a-z0-9-]+\.node$/.test(name) && [0,48].includes(header[156])) return tar.subarray(offset+512,offset+512+size);
    offset+=512+Math.ceil(size/512)*512;
  }
  throw new Error('Pinned package contains no DAVE module');
}

export async function prepareNative() {
  const lock=JSON.parse(await readFile('package-lock.json','utf8'));
  const cache='node_modules/.cache/astra-davey';
  await mkdir(cache,{recursive:true});
  await mkdir('dist/native/davey',{recursive:true});
  for (const retired of ['linux-x64-musl','linux-arm64-gnu','linux-arm64-musl']) {
    await rm(join('dist/native/davey',retired+'.node'),{force:true});
  }
  for(const target of targets) {
    const name='@snazzah/davey-'+target,info=lock.packages['node_modules/'+name];
    if(!info || info.version!=='0.1.12'||!info.integrity?.startsWith('sha512-')||!info.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error('Missing pinned DAVE package '+name);
    let binary;
    // Installed packages are verified by npm against this same lock integrity.
    try { binary=await readFile(require.resolve(name)); } catch {}
    if(!binary) {
      const cached=join(cache,target+'-'+info.version+'.tgz');
      let archive;try{archive=await readFile(cached);}catch{}
      if(!archive) {
        const response=await fetch(info.resolved,{signal:AbortSignal.timeout(60_000),redirect:'error'});
        if(!response.ok) throw new Error('Cannot fetch pinned DAVE module '+target);
        archive=Buffer.from(await response.arrayBuffer());
      }
      if('sha512-'+createHash('sha512').update(archive).digest('base64')!==info.integrity) throw new Error('DAVE archive integrity mismatch '+target);
      await writeFile(cached,archive);
      binary=extractNative(archive);
    }
    const output=join('dist/native/davey',target+'.node');
    // Windows locks loaded modules; unchanged bytes must not be replaced.
    let same=false;try{same=binary.equals(await readFile(output));}catch{}
    if(!same) await writeFile(output,binary);
  }
  // Keep the old path for existing regression tools and loaded Windows sessions.
  if(process.platform==='win32' && process.arch==='x64') {
    const binary=await readFile('dist/native/davey/win32-x64-msvc.node');
    let same=false;try{same=binary.equals(await readFile('dist/native/davey.node'));}catch{}
    if(!same) await copyFile('dist/native/davey/win32-x64-msvc.node','dist/native/davey.node');
  }
  await writeFile('dist/native/davey.cjs',`const {join}=require('node:path');
const libc=process.platform==='linux' ? (process.report.getReport().header.glibcVersionRuntime?'gnu':'musl') : process.platform==='win32'?'msvc':'';
const target=[process.platform,process.arch,libc].filter(Boolean).join('-');
if(!${JSON.stringify(targets)}.includes(target)) throw new Error('DAVE runtime unsupported: '+target);
module.exports=require(join(__dirname,'davey',target+'.node'));
`);
}
