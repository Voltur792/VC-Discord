import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), core = require('./artifact/plugin.cjs');
const Opus = core.OpusScript;
const codec = () => new Opus(48000, 2, Opus.Application.AUDIO);
const heapSize = () => { const c = codec(); try { return c.inPCM.buffer.byteLength; } finally { c.delete(); } };
const pcm = Buffer.alloc(3840);
for (let i = 0; i < 960; i++) { const n = Math.round(Math.sin(i / 10) * 12000); pcm.writeInt16LE(n, i * 4); pcm.writeInt16LE(n, i * 4 + 2); }

test('early interrupted replies do not allocate native codecs or grow the shared heap', async () => {
  const before = heapSize();
  for (let i = 0; i < 1000; i++) {
    const stream = core.opusStream(pcm);
    stream.destroy();
    await new Promise(resolve => stream.once('close', resolve));
  }
  assert.equal(heapSize(), before);
  for (let i = 0; i < 100; i++) {
    const stream = core.opusStream(Buffer.concat([pcm, pcm]));
    stream.read(1);
    stream.destroy();
    await new Promise(resolve => stream.once('close', resolve));
  }
  assert.equal(heapSize(), before);
});

test('active encoders and decoders survive another codec growing the WebAssembly heap', () => {
  const encoder = codec(), decoder = codec(), held = [];
  const before = heapSize();
  try {
    for (let i = 0; i < 300 && heapSize() === before; i++) held.push(codec());
    assert.ok(heapSize() > before, 'The test must actually trigger a heap buffer replacement');
    for (const c of [encoder, ...held]) {
      const decoded = decoder.decode(c.encode(pcm, 960));
      assert.equal(decoded.length, pcm.length);
      assert.ok(core.rms(decoded) > .05);
    }
    encoder.delete(); encoder.delete();
    assert.throws(() => encoder.encode(pcm, 960), /deleted/);
    assert.equal(decoder.decode(held[0].encode(pcm, 960)).length, pcm.length);
  } finally { for (const c of [encoder, decoder, ...held]) c.delete(); }
});
