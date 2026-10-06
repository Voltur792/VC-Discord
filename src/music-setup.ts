import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { dataDir } from "./config";
import { powershellPath } from "./runtime";
import { windowsFailure, WindowsServiceError } from "./process";

// A fixed Gyan essentials build linked from ffmpeg.org/download.html.
// Never execute a downloaded file before checking the published archive digest.
const VERSION = "9.0.2";
const ARCHIVE = `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${VERSION}-essentials_build.zip`;
const SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
const runtimeDir = join(dataDir, "music", `ffmpeg-${VERSION}`);
class MusicPreparationError extends Error {}

export async function findMusicFFmpeg(preferred = ""): Promise<string> {
  // Once preparation repairs a stale custom path, playback uses the verified copy.
  const candidates = [join(runtimeDir, "ffmpeg.exe"), preferred, join(__dirname, "native", "ffmpeg.exe"),
    "C:\\ffmpeg\\bin\\ffmpeg.exe", ...(process.env.PATH || "").split(";").filter(Boolean).map(p => join(p.replace(/^"|"$/g, ""), "ffmpeg.exe"))];
  for (const path of candidates.filter(Boolean)) {
    try { if ((await stat(path)).isFile()) { await access(path); return path; } } catch {}
  }
  return "";
}

async function versionCheck(path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    execFile(path, ["-version"], { windowsHide: true, timeout: 5000, maxBuffer: 16000, signal }, (error, stdout) => {
      error || !stdout.startsWith("ffmpeg version ") ? reject(new MusicPreparationError("FFmpeg не удалось запустить.")) : resolve();
    });
  });
}

export class MusicSetup {
  running = false;
  ready = false;
  status = "Нажмите «Подготовить музыку»: найдём FFmpeg или загрузим его для плагина.";
  private controller?: AbortController;
  private child?: ChildProcess;

  start(preferred = ""): { ok: true } {
    if (this.running) throw new Error("Подготовка музыки уже выполняется.");
    this.running = true; this.ready = false; this.status = "Ищем FFmpeg на этом ПК…";
    const controller = new AbortController(); this.controller = controller;
    void this.prepare(preferred, controller).catch(error => {
      if (this.controller === controller) this.status = controller.signal.aborted ? "Подготовка музыки остановлена. Можно повторить попытку." : error instanceof MusicPreparationError ? error.message : "Не удалось сохранить FFmpeg для плагина. Проверьте свободное место и повторите подготовку.";
    }).finally(() => {
      if (this.controller === controller) { this.controller = undefined; this.running = false; }
    });
    return { ok: true };
  }

  private async prepare(preferred: string, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 600000);
    let temporary = "";
    try {
      const existing = await findMusicFFmpeg(preferred);
      if (existing) {
        try {
          await versionCheck(existing, signal);
          signal.throwIfAborted(); this.ready = true; this.status = "Музыка готова. FFmpeg уже найден на этом ПК."; return;
        } catch { signal.throwIfAborted(); }
      }
      if (process.platform !== "win32" || process.arch !== "x64") throw new MusicPreparationError("Автоматическая подготовка музыки поддерживает Windows x64.");
      temporary = join(dataDir, "music", "downloads", randomUUID());
      await mkdir(temporary, { recursive: true });
      const archive = join(temporary, "ffmpeg.zip");
      this.status = "Загружаем FFmpeg для музыки, около 109 МБ…";
      await this.download(archive, signal);
      signal.throwIfAborted(); this.status = "Распаковываем FFmpeg…";
      const unpacked = join(temporary, "unpacked");
      await this.extract(archive, unpacked, signal);
      const executable = join(unpacked, "ffmpeg.exe");
      if ((await stat(executable)).size < 1000000) throw new MusicPreparationError("Архив FFmpeg не содержит нужной программы.");
      await versionCheck(executable, signal);
      signal.throwIfAborted();
      await mkdir(runtimeDir, { recursive: true });
      for (const name of ["LICENSE.txt", "README.txt"]) {
        try { await rename(join(unpacked, name), join(runtimeDir, name)); }
        catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
      await rename(executable, join(runtimeDir, "ffmpeg.exe"));
      await readFile(join(runtimeDir, "LICENSE.txt"));
      signal.throwIfAborted();
      this.ready = true; this.status = "Музыка готова. FFmpeg установлен для плагина.";
    } finally {
      clearTimeout(timeout);
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async download(path: string, signal: AbortSignal): Promise<void> {
    let response: Response;
    try { response = await fetch(ARCHIVE, { signal, redirect: "error" }); }
    catch { throw new MusicPreparationError("Не удалось загрузить FFmpeg. Проверьте интернет и повторите подготовку."); }
    const total = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || total > 180000000) { await response.body?.cancel(); throw new MusicPreparationError("Сервер загрузки FFmpeg недоступен. Повторите позже."); }
    const file = await open(path, "wx");
    const reader = response.body.getReader(), hash = createHash("sha256");
    let size = 0;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { throw new MusicPreparationError("Загрузка FFmpeg прервалась. Проверьте интернет и повторите подготовку."); }
        const { done, value } = chunk;
        if (done) break;
        signal.throwIfAborted(); size += value.byteLength;
        if (size > 180000000) throw new MusicPreparationError("Архив FFmpeg превышает допустимый размер.");
        hash.update(value);
        try { await file.writeFile(value); }
        catch { throw new MusicPreparationError("Не удалось сохранить FFmpeg. Проверьте свободное место и повторите подготовку."); }
        this.status = total > 0 ? `Загружаем FFmpeg: ${Math.min(100, Math.floor(size * 100 / total))}%` : `Загружаем FFmpeg: ${Math.round(size / 1048576)} МБ`;
      }
      if (hash.digest("hex") !== SHA256) throw new MusicPreparationError("Проверка целостности FFmpeg не прошла. Файл не установлен; повторите подготовку.");
    } finally { await reader.cancel().catch(() => {}); await file.close(); }
  }

  private extract(archive: string, destination: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const child = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-File", join(__dirname, "assets", "prepare_music.ps1")],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let diagnostic = "";
      this.child = child; child.stdout.resume(); child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192); }); child.stdin.on("error", () => {});
      const abort = () => child.kill(); signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error: NodeJS.ErrnoException) => reject(new MusicPreparationError(new WindowsServiceError(error.code === "ENOENT" ? "WIN_MISSING" : "WIN_ACCESS", "extract").message)));
      child.once("close", code => {
        signal.removeEventListener("abort", abort); if (this.child === child) this.child = undefined;
        const failure = windowsFailure(diagnostic);
        code === 0 && !signal.aborted ? resolve() : reject(new MusicPreparationError(failure === "WIN_REQUEST" ? "Не удалось распаковать FFmpeg. Файл не установлен; проверьте свободное место и повторите подготовку." : new WindowsServiceError(failure, "extract", code).message));
      });
      child.stdin.end(JSON.stringify({ archive, destination })); if (signal.aborted) abort();
    });
  }

  stop(): void { this.controller?.abort(); this.child?.kill(); }
}
