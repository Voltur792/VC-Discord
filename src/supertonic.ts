import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Settings } from "./config";
import { resample } from "./audio";
import { pythonPath } from "./runtime";

export class SupertonicWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private signature = "";
  private sequence = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private async start(s: Settings): Promise<void> {
    const signature = `${s.ttsPython}\0${s.supertonicModelPath}`;
    if (this.child && this.signature === signature && this.ready) return this.ready;
    this.stop();
    if (!s.supertonicModelPath) throw new Error("Укажите папку модели Supertonic или нажмите «Взять голос Astra».");
    this.signature = signature;
    const child = spawn(pythonPath(s.ttsPython), ["-u", join(__dirname, "assets", "supertonic_worker.py"), s.supertonicModelPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    this.child = child; child.stderr.resume(); child.stdin.on("error", () => {});
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { reject(new Error("Supertonic не загрузился за 60 секунд.")); this.stop(); }, 60000);
      const fail = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error("Не удалось загрузить Supertonic. Проверьте Python с пакетом supertonic и папку модели.")); }
        if (this.child === child) this.stop();
      };
      child.on("error", fail); child.on("close", fail);
      createInterface({ input: child.stdout }).on("line", line => {
        let value: any; try { value = JSON.parse(line); } catch { return; }
        if (value.ready) { settled = true; clearTimeout(timer); resolve(); }
        if (value.error && !settled) { fail(); return; }
        const pending = this.pending.get(value.id);
        if (pending) { this.pending.delete(value.id); value.error ? pending.reject(new Error("Supertonic не озвучил реплику.")) : pending.resolve(value); }
      });
    });
    return this.ready;
  }
  async speak(s: Settings, text: string, signal: AbortSignal): Promise<Buffer> {
    clearTimeout(this.idle); await this.start(s); signal.throwIfAborted();
    const id = ++this.sequence;
    try {
      const value = await new Promise<any>((resolve, reject) => {
        const finish = (value?: any, error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(id); error ? reject(error) : resolve(value); };
        const abort = () => { finish(undefined, new Error("Озвучка остановлена.")); this.stop(); };
        const timer = setTimeout(() => { finish(undefined, new Error("Supertonic не ответил за 60 секунд.")); this.stop(); }, 60000);
        signal.addEventListener("abort", abort, { once: true });
        this.pending.set(id, { resolve: value => finish(value), reject: error => finish(undefined, error) });
        this.child!.stdin.write(JSON.stringify({ id, text, voice: s.supertonicVoice, speed: s.supertonicSpeed }) + "\n");
      });
      if (typeof value.audio !== "string" || value.audio.length > 11000000 || !Number.isFinite(value.rate)) throw new Error("Некорректный звук Supertonic.");
      return resample(Buffer.from(value.audio, "base64"), value.rate, 1, 48000, 2);
    } finally { this.idle = setTimeout(() => this.stop(), 60000); this.idle.unref(); }
  }
  stop(): void { clearTimeout(this.idle); const child = this.child; this.child = undefined; this.ready = undefined; child?.kill(); for (const item of this.pending.values()) item.reject(new Error("Supertonic остановлен.")); this.pending.clear(); }
}
