import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Settings } from "./config";
import { astraRecognition } from "./astra-settings";

export class WhisperWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private signature = "";
  private sequence = 0;
  private pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  async start(s: Settings): Promise<void> {
    if (s.sttUseAstra) s = { ...s, ...await astraRecognition() };
    const signature = `${s.whisperPython}\0${s.whisperModelPath}`;
    if (this.child && this.signature === signature && this.ready) return this.ready;
    this.stop();
    if (!s.whisperModelPath) throw new Error("Нажмите «Взять распознавание Astra» или укажите файл модели Whisper.");
    this.signature = signature;
    const child = spawn(s.whisperPython || "python", ["-u", join(__dirname, "assets", "whisper_worker.py"), s.whisperModelPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    this.child = child; child.stderr.resume(); child.stdin.on("error", () => {});
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error(message)); }
        if (this.child === child) this.stop();
      };
      const timer = setTimeout(() => fail("Whisper не загрузился за 90 секунд. Проверьте свободную память и файл модели."), 90_000);
      child.on("error", () => fail("Не удалось запустить Python для Whisper. Проверьте путь к Python."));
      child.on("close", () => fail("Whisper остановился. Проверьте Python и файл модели."));
      createInterface({ input: child.stdout }).on("line", line => {
        if (line.length > 40000) { fail("Whisper вернул слишком большой ответ."); return; }
        let value: any; try { value = JSON.parse(line); } catch { return; }
        if (value.ready && !settled) { settled = true; clearTimeout(timer); resolve(); }
        if (value.error && !settled) {
          const errors: Record<string, string> = {
            package_missing: "В выбранном Python нет pywhispercpp. Нажмите «Подготовить Whisper автоматически».",
            model_missing: "Файл модели Whisper не найден. Скачайте модель в Astra и повторите импорт.",
            model_load_failed: "Whisper не смог открыть модель. Проверьте файл GGML и свободную память.",
          };
          fail(errors[String(value.error)] || "Не удалось загрузить Whisper."); return;
        }
        const pending = this.pending.get(value.id);
        if (pending) value.error ? pending.reject(new Error("Whisper не распознал реплику.")) : pending.resolve(String(value.text || ""));
      });
    });
    return this.ready;
  }
  async transcribe(s: Settings, pcm: Buffer, signal: AbortSignal): Promise<string> {
    if (s.sttUseAstra) s = { ...s, ...await astraRecognition() };
    signal.throwIfAborted();
    // Loading cancellation also kills this plugin's worker, never Astra's STT.
    const loadingAbort = () => this.stop();
    signal.addEventListener("abort", loadingAbort, { once: true });
    try { await this.start({ ...s, sttUseAstra: false }); }
    finally { signal.removeEventListener("abort", loadingAbort); }
    signal.throwIfAborted();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (text?: string, error?: Error) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(id);
        error ? reject(error) : resolve(text || "");
      };
      const abort = () => { finish(undefined, new Error("Распознавание отменено.")); this.stop(); };
      const timer = setTimeout(() => { finish(undefined, new Error("Whisper не распознал реплику за 120 секунд. Выберите меньшую модель в Astra, если ПК не успевает.")); this.stop(); }, 120_000);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: text => finish(text), reject: error => finish(undefined, error) });
      this.child!.stdin.write(JSON.stringify({ id, audio: pcm.toString("base64"), language: s.language || "ru" }) + "\n", error => { if (error) { finish(undefined, new Error("Не удалось передать реплику Whisper.")); this.stop(); } });
    });
  }
  stop(): void {
    const child = this.child; this.child = undefined; this.ready = undefined;
    // Windows venv python.exe is a launcher with a separate interpreter child.
    if (process.platform === "win32" && child?.pid) execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else child?.kill();
    for (const pending of this.pending.values()) pending.reject(new Error("Распознавание Whisper остановлено."));
    this.pending.clear();
  }
}
