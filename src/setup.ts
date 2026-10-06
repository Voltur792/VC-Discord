import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { dataDir } from "./config";
import { pythonPath } from "./runtime";
export class LocalSetup {
  running = false;
  status = "";
  private child?: ChildProcessWithoutNullStreams;
  start(python: string, complete: (python: string, model: string) => Promise<void>): void {
    if (this.running) throw new Error("Подготовка Vosk уже выполняется.");
    this.running = true; this.status = "Подготовка локального распознавания…";
    const child = spawn(pythonPath(python), ["-u", join(__dirname, "assets", "setup_vosk.py"), dataDir], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    this.child = child; child.stdin.end(); child.stderr.resume();
    let result: { python: string; model: string } | undefined;
    const timeout = setTimeout(() => { this.status = "Подготовка не завершилась за 10 минут. Повторите попытку."; this.stop(); }, 600_000);
    createInterface({ input: child.stdout }).on("line", line => {
      try { const message = JSON.parse(line); if (message.status) this.status = String(message.status).slice(0, 200); if (message.error) this.status = String(message.error).slice(0, 200); if (message.ready) result = { python: message.python, model: message.model }; } catch {}
    });
    child.on("error", () => { this.status = "Не удалось запустить Python. Установите Python и укажите путь к нему."; });
    child.on("close", code => {
      clearTimeout(timeout);
      if (this.child !== child) return;
      this.child = undefined; this.running = false;
      if (code === 0 && result) {
        complete(result.python, result.model).then(() => this.status = "Vosk готов. Модель и Python добавлены в настройки.").catch(() => this.status = "Vosk установлен, но настройки не сохранены. Укажите пути вручную.");
      } else if (!this.status.includes("Не удалось") && !this.status.includes("не завершилась")) this.status = "Не удалось подготовить Vosk. Проверьте Python и доступ к сети.";
    });
  }
  stop(): void {
    const child = this.child; this.child = undefined; this.running = false;
    if (child?.pid) execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
}

export class WhisperSetup {
  running = false;
  status = "";
  private child?: ChildProcessWithoutNullStreams;
  start(python: string, complete: (python: string) => Promise<void>): void {
    if (this.running) throw new Error("Подготовка Whisper уже выполняется.");
    this.running = true; this.status = "Подготовка Whisper…";
    const child = spawn(pythonPath(python), ["-u", join(__dirname, "assets", "setup_whisper.py"), dataDir], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    this.child = child; child.stdin.end(); child.stderr.resume();
    let prepared = "";
    const timer = setTimeout(() => { this.stop(); this.status = "Подготовка Whisper не завершилась за 10 минут. Повторите попытку."; }, 600_000);
    createInterface({ input: child.stdout }).on("line", line => {
      try { const value = JSON.parse(line); if (value.status || value.error) this.status = String(value.status || value.error).slice(0, 200); if (value.ready) prepared = String(value.python || ""); } catch {}
    });
    child.on("error", () => { this.status = "Не удалось запустить Python. Укажите путь к установленному Python."; });
    child.on("close", code => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = undefined;
      if (code === 0 && prepared) {
        complete(prepared).then(() => this.status = "Whisper готов. Выбрано распознавание Astra.").catch(() => this.status = "Whisper установлен. Нажмите «Взять распознавание Astra», чтобы применить выбор.").finally(() => this.running = false);
      } else { this.running = false; if (!this.status.startsWith("Не удалось")) this.status = "Не удалось подготовить Whisper. Проверьте Python и доступ к PyPI."; }
    });
  }
  stop(): void {
    const child = this.child; this.child = undefined; this.running = false;
    if (child?.pid) execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
}
