import { Readable } from "node:stream";
import OpusScript from "opusscript";

export function resample(pcm: Buffer, rate: number, channels: number, targetRate: number, targetChannels = 1): Buffer {
  if (![1, 2].includes(channels) || ![1, 2].includes(targetChannels) || rate < 8000 || rate > 192000) throw new Error("Неподдерживаемый формат звука.");
  const frames = Math.floor(pcm.length / (channels * 2));
  const count = Math.floor(frames * targetRate / rate);
  const out = Buffer.alloc(count * targetChannels * 2);
  const sample = (frame: number) => {
    const index = Math.max(0, Math.min(frames - 1, frame));
    return channels === 1 ? pcm.readInt16LE(index * 2) : (pcm.readInt16LE(index * 4) + pcm.readInt16LE(index * 4 + 2)) / 2;
  };
  for (let i = 0; i < count; i++) {
    const pos = i * rate / targetRate, left = Math.floor(pos), fraction = pos - left;
    const value = Math.round(sample(left) * (1 - fraction) + sample(left + 1) * fraction);
    for (let c = 0; c < targetChannels; c++) out.writeInt16LE(value, (i * targetChannels + c) * 2);
  }
  return out;
}
export function wav(pcm: Buffer, rate = 16000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function fromWav(data: Buffer): { pcm: Buffer; rate: number; channels: number } {
  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") throw new Error("Голосовой провайдер вернул неподдерживаемый WAV.");
  let rate = 0, channels = 0, format = 0, bits = 0, pcm: Buffer | undefined;
  for (let i = 12; i + 8 <= data.length;) {
    const tag = data.toString("ascii", i, i + 4), length = data.readUInt32LE(i + 4), start = i + 8;
    if (start + length > data.length) throw new Error("Обрезанный звуковой файл.");
    if (tag === "fmt " && length >= 16) { format = data.readUInt16LE(start); channels = data.readUInt16LE(start + 2); rate = data.readUInt32LE(start + 4); bits = data.readUInt16LE(start + 14); }
    if (tag === "data") pcm = data.subarray(start, start + length);
    i = start + length + (length % 2);
  }
  if (!pcm || format !== 1 || bits !== 16 || ![1, 2].includes(channels)) throw new Error("Нужен PCM WAV, 16 бит, один или два канала.");
  return { pcm, rate, channels };
}
export function rms(pcm: Buffer): number {
  let energy = 0, count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 16) { const x = pcm.readInt16LE(i) / 32768; energy += x * x; count++; }
  return count ? Math.sqrt(energy / count) : 0;
}
export function opusStream(pcm: Buffer): Readable {
  const codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  function* frames() {
    try {
      for (let i = 0; i < pcm.length; i += 3840) {
        const frame = Buffer.alloc(3840); pcm.copy(frame, 0, i, Math.min(i + 3840, pcm.length));
        yield codec.encode(frame, 960);
      }
    } finally { codec.delete(); }
  }
  return Readable.from(frames(), { objectMode: true });
}
export { OpusScript };
