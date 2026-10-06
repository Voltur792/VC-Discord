import { Readable } from "node:stream";
import { OpusScript } from "./audio";

/** Bounded 48 kHz stereo mixer; Discord's AudioPlayer owns the 20 ms clock. */
export class VoiceMixer extends Readable {
  private codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  private speech?: { pcm: Buffer; offset: number; finish: () => void };
  private music?: Readable;
  private paused = false;
  volume = .5;
  private frames = 0;
  private underruns = 0;
  constructor() { super({ objectMode: true, highWaterMark: 6 }); }
  stats(): { frames: number; underruns: number } { return { frames: this.frames, underruns: this.underruns }; }
  setMusic(source?: Readable): void { this.music = source; this.paused = false; }
  pauseMusic(value: boolean): void { this.paused = value; }
  stopSpeech(): void { const pending = this.speech; this.speech = undefined; pending?.finish(); }
  say(pcm: Buffer, signal: AbortSignal): Promise<void> {
    this.stopSpeech();
    if (signal.aborted || this.destroyed) return Promise.resolve();
    return new Promise(resolve => {
      const abort = () => this.stopSpeech();
      this.speech = { pcm, offset: 0, finish: () => { signal.removeEventListener("abort", abort); resolve(); } };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  _read(): void {
    if (this.destroyed) return;
    // AudioPlayer pulls one Opus packet per 20 ms. Sleeping another 20 ms
    // here adds encoder time to every packet and steadily loses frames.
    do {
      if (!this.music && !this.speech) { this.push(null); return; }
      const speech = this.speech, frame = Buffer.alloc(3840);
      let music: Buffer | null = null;
      if (this.music && !this.paused) {
        // Keep complete stereo samples together across arbitrary pipe chunks.
        // read(n) waits for a full frame, except for the final short EOF frame.
        music = this.music.read(3840);
        if (!music && !this.music.readableEnded) this.underruns++;
      }
      for (let i = 0; i < 3840; i += 2) {
        const voice = speech && speech.offset + i + 1 < speech.pcm.length ? speech.pcm.readInt16LE(speech.offset + i) : 0;
        const song = music && i + 1 < music.length ? music.readInt16LE(i) * this.volume * (speech ? .2 : 1) : 0;
        frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(voice + song))), i);
      }
      if (speech) { speech.offset += 3840; if (speech.offset >= speech.pcm.length) this.stopSpeech(); }
      this.frames++;
      try { if (!this.push(this.codec.encode(frame, 960))) return; }
      catch { this.destroy(new Error("Не удалось смешать голос и музыку.")); return; }
    } while (!this.destroyed);
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopSpeech(); this.music = undefined; this.codec.delete(); callback(error);
  }
}
