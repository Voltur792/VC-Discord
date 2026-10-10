import { execFile } from "node:child_process";
import { mkdir, stat, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { release } from "node:os";
import { dataDir, fishModels, type Settings } from "./config";
import { astraRecognition, chatSettings } from "./astra-settings";
import { findMusicFFmpeg } from "./music-setup";
import { runWindows, WindowsServiceError, windowsFailure } from "./process";
import { powershellPath, pythonPath } from "./runtime";
import { findVoicePython } from "./voice-runtime";

type Result = "ok" | "warning" | "error";
interface Check { id: string; title: string; result: Result; code: string; detail: string; fix?: "setup_local" | "setup_whisper" | "setup_music" | "setup_voice" }
interface Probe { ok: boolean; output: string; code: string }
function probe(executable: string, args: string[], timeout = 7000): Promise<Probe> {
  return new Promise(resolve => {
    execFile(executable, args, { windowsHide: true, timeout, maxBuffer: 16000, encoding: "utf8" }, (error, stdout, stderr) => {
      // Never return command lines, paths, environment values or raw stderr.
      const code = error?.code === "ENOENT" ? "PROGRAM_MISSING" : error?.code === "EACCES" || error?.code === "EPERM" ? "PROGRAM_ACCESS" : error?.killed ? "PROGRAM_TIMEOUT" : windowsFailure(stderr);
      resolve({ ok: !error, output: !error ? stdout : "", code });
    });
  });
}
async function present(path: string, kind: "file" | "directory"): Promise<boolean> {
  try { const info = await stat(path); return kind === "file" ? info.isFile() && info.size > 0 : info.isDirectory(); } catch { return false; }
}
const policies = new Set(["Restricted", "AllSigned", "RemoteSigned", "Unrestricted", "Bypass", "Undefined"]);
const pluginVersion: string = require("../package.json").version;

export class Diagnostics {
  running = false;
  checkedAt = 0;
  checks: Check[] = [];
  private lastStart = 0;
  private rerun = false;
  private stopped = false;
  private lastFailure?: { code: string; action: string; exitCode: number | null; at: number; detail: string };
  constructor(private settings: () => Settings) {}
  state(): Record<string, unknown> { return { running: this.running, checkedAt: this.checkedAt, checks: this.checks, lastFailure: this.lastFailure || null }; }
  report(): Record<string, unknown> {
    // A deliberately separate schema: no Settings, chat history or raw logs.
    return { format: "vc-discord-diagnostics-v1", pluginVersion, node: process.versions.node, platform: process.platform, arch: process.arch, windowsVersion: release(), ...this.state() };
  }
  record(error: unknown): void {
    if (error instanceof WindowsServiceError) this.lastFailure = { code: error.code, action: error.action, exitCode: error.exitCode ?? null, at: Date.now(), detail: error.message };
    else {
      const message = error instanceof Error ? error.message : "";
      const music = message.match(/^\[(MUSIC_STREAM_FAILED|MUSIC_EARLY_EOF|MUSIC_STREAM_INTERRUPTED|MUSIC_NEXT_FAILED)\]/);
      const http = message.match(/\bHTTP (401|403|404|429|5\d\d)\b/);
      const known: Record<string, string> = {
        "401": "Сервер отклонил ключ. Проверьте ключ выбранного подключения и нажмите «Найти модели».",
        "403": "Сервер запретил доступ. Проверьте права ключа и доступ к выбранной модели.",
        "404": "Сервер не нашёл адрес API или модель. Проверьте базовый адрес и имя модели.",
        "429": "Превышен лимит провайдера. Проверьте квоту и повторите позже.",
      };
      if (music) this.lastFailure = { code: music[1], action: "music", exitCode: null, at: Date.now(), detail: "Музыкальный поток завершился с ошибкой или до конца песни. Очередь остановлена. Проверьте подключение сервиса в Astra Music и повторно включите трек." };
      else if (http) this.lastFailure = { code: "API_HTTP_" + http[1], action: "api", exitCode: null, at: Date.now(), detail: known[http[1]] || "Сервер модели временно недоступен. Повторите позже." };
      else this.lastFailure = { code: "UI_ACTION_FAILED", action: "ui", exitCode: null, at: Date.now(), detail: "Действие плагина завершилось ошибкой. Проверьте сообщение на странице и результаты автодиагностики." };
    }
    this.start(false);
  }
  start(force = true): { ok: true } {
    if (this.stopped) return { ok: true };
    if (this.running) { if (force) this.rerun = true; return { ok: true }; }
    if (!force && Date.now() - this.lastStart < 30000) return { ok: true };
    this.running = true; this.lastStart = Date.now();
    const settings = { ...this.settings() };
    void this.collect(settings).then(checks => { if (!this.stopped) { this.checks = checks; this.checkedAt = Date.now(); } }).catch(() => {
      if (!this.stopped) { this.checks = [{ id: "diagnostics", title: "Диагностика", result: "error", code: "CHECK_INTERRUPTED", detail: "Проверка прервалась. Повторите диагностику и перезапустите плагин." }]; this.checkedAt = Date.now(); }
    }).finally(() => { this.running = false; if (this.rerun && !this.stopped) { this.rerun = false; this.start(); } });
    return { ok: true };
  }
  stop(): void { this.stopped = true; this.rerun = false; }
  private async collect(s: Settings): Promise<Check[]> {
    const [windows, storage, recognition, voice, music, model] = await Promise.all([
      this.windows(), this.storage(), this.recognition(s), this.voice(s), this.music(s), this.model(s),
    ]);
    const [major, minor] = process.versions.node.split(".").map(Number);
    return [
      { id: "node", title: "Версия Node.js", result: major > 22 || major === 22 && minor >= 12 ? "ok" : "error", code: "NODE_VERSION", detail: `Node.js ${process.versions.node}. Для плагина нужен Node.js 22.12 или новее; после установки перезапустите Astra.` },
      ...windows, storage, ...recognition, ...voice, music, model,
    ];
  }
  private async windows(): Promise<Check[]> {
    if (process.platform !== "win32") return [{ id: "windows", title: "Службы Windows", result: "error", code: "WINDOWS_REQUIRED", detail: "Этот плагин рассчитан на Windows x64." }];
    const script = join(__dirname, "assets", "windows.ps1");
    if (!await present(script, "file")) return [{ id: "windows", title: "Служебные файлы", result: "error", code: "WIN_SCRIPT_MISSING", detail: "Не найден windows.ps1. Переустановите готовый .astraplugin либо соберите исходники перед загрузкой через «Разработка»." }];
    // Inline read-only commands work even when .ps1 files are prohibited. The
    // actual service probe below still runs with -File and the current policy.
    const literal = "'" + script.replace(/'/g, "''") + "'";
    const command = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p = Get-ExecutionPolicy -List; $z = Get-Content -LiteralPath ${literal} -Stream Zone.Identifier -Raw -ErrorAction SilentlyContinue; @{ effective = [string](Get-ExecutionPolicy); machine = [string]($p | Where-Object Scope -eq 'MachinePolicy').ExecutionPolicy; user = [string]($p | Where-Object Scope -eq 'UserPolicy').ExecutionPolicy; language = [string]$ExecutionContext.SessionState.LanguageMode; internetFile = [bool]($z -match 'ZoneId=[34]') } | ConvertTo-Json -Compress`;
    const policy = await probe(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]);
    if (!policy.ok) return [{ id: "windows", title: "PowerShell", result: "error", code: policy.code === "PROGRAM_MISSING" ? "WIN_MISSING" : policy.code, detail: "Не удалось прочитать состояние PowerShell. Восстановите Windows PowerShell; при ограничениях организации обратитесь к администратору." }];
    let info: any;
    try { info = JSON.parse(policy.output); } catch { return [{ id: "windows", title: "PowerShell", result: "error", code: "WIN_PROBE_FORMAT", detail: "PowerShell вернул неподдерживаемый ответ. Перезапустите Astra и повторите диагностику." }]; }
    const effective = policies.has(info.effective) ? info.effective : "не определена";
    const managed = [info.machine, info.user].some(v => policies.has(v) && v !== "Undefined");
    const blocked = effective === "Restricted" || effective === "AllSigned" || effective === "RemoteSigned" && info.internetFile === true;
    const detail = blocked ? managed ? `Политика ${effective} задана организацией. Попросите администратора разрешить служебный скрипт плагина.` : effective === "RemoteSigned" ? "Политика RemoteSigned: windows.ps1 помечен как скачанный из интернета. Проверьте происхождение файла, затем в его свойствах выберите «Разблокировать» и повторите проверку." : `Политика ${effective} запрещает неподписанный скрипт. На личном ПК можно в Windows PowerShell выполнить Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned, затем повторить диагностику. Это изменение политики текущего пользователя.` : `Действующая политика: ${effective}. PowerShell найден напрямую, запись в PATH не обязательна.`;
    const checks: Check[] = [{ id: "policy", title: "Запуск служебных скриптов", result: blocked ? "error" : "ok", code: blocked ? "WIN_POLICY" : "WIN_POLICY_OK", detail }];
    if (info.language !== "FullLanguage") { checks.push({ id: "encryption", title: "Шифрование ключей Windows", result: "error", code: "WIN_LANGUAGE", detail: "PowerShell работает в ограниченном режиме. Для компонентов шифрования обратитесь к администратору Windows." }); return checks; }
    if (blocked) { checks.push({ id: "encryption", title: "Шифрование ключей Windows", result: "warning", code: "CHECK_SKIPPED", detail: "Проверка шифрования отложена до разрешения запуска служебного скрипта." }); return checks; }
    const signal = AbortSignal.timeout(10000);
    try {
      const result = JSON.parse((await runWindows({ action: "diagnostics" }, signal)).toString("utf8"));
      checks.push({ id: "encryption", title: "Шифрование ключей Windows", result: result.encryption === true ? "ok" : "error", code: result.encryption === true ? "WIN_ENCRYPTION_OK" : "WIN_PROTECT", detail: result.encryption === true ? "Пробная строка зашифрована и расшифрована. Сохранённые ключи не используются." : "Windows не смогла восстановить пробную строку. Проверьте профиль Windows и компоненты .NET Framework." });
    } catch (error) {
      checks.push({ id: "encryption", title: "Шифрование ключей Windows", result: "error", code: signal.aborted ? "WIN_TIMEOUT" : error instanceof WindowsServiceError ? error.code : "WIN_REQUEST", detail: signal.aborted ? "Проверка шифрования не завершилась за 10 секунд. Повторите после перезапуска Astra." : error instanceof WindowsServiceError ? error.message : "Служба шифрования недоступна. Проверьте профиль Windows и компоненты .NET Framework." });
    }
    return checks;
  }
  private async storage(): Promise<Check> {
    const path = join(dataDir, `.diagnostics-${randomUUID()}.tmp`);
    let created = false;
    try { await mkdir(dataDir, { recursive: true }); await writeFile(path, "vc-discord", { flag: "wx", mode: 0o600 }); created = true; return { id: "storage", title: "Сохранение файлов настроек", result: "ok", code: "STORAGE_OK", detail: "Папка данных доступна для записи." }; }
    catch (error: any) { return { id: "storage", title: "Сохранение файлов настроек", result: "error", code: error.code === "ENOSPC" ? "STORAGE_FULL" : "STORAGE_ACCESS", detail: error.code === "ENOSPC" ? "На диске нет места. Освободите место и повторите сохранение." : "Не удалось записать файл в папку данных. Проверьте права Windows-аккаунта и журнал защиты Windows." }; }
    finally { if (created) await unlink(path).catch(() => {}); }
  }
  private async python(title: string, preferred: string, module: string, fix?: Check["fix"]): Promise<Check> {
    const program = pythonPath(preferred);
    const code = "import sys,json,importlib.util; print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'found':importlib.util.find_spec(sys.argv[1]) is not None}))";
    const result = await probe(program, ["-c", code, module]);
    if (!result.ok) return { id: module, title, result: "error", code: result.code === "PROGRAM_MISSING" ? "PYTHON_MISSING" : "PYTHON_START_FAILED", detail: "Выбранный Python не запускается. Установите Python 3.11 или новее и укажите его путь в «Голос и модель». Переустановка пакета не исправляет отсутствующий Python." };
    let info: any; try { info = JSON.parse(result.output); } catch { return { id: module, title, result: "error", code: "PYTHON_PROBE_FORMAT", detail: "Python вернул неподдерживаемый ответ. Укажите путь к рабочему python.exe в «Голос и модель»." }; }
    const version = typeof info.version === "string" && /^\d+\.\d+\.\d+$/.test(info.version) ? info.version : "найден";
    return { id: module, title, result: info.found === true ? "ok" : "error", code: info.found === true ? "PYTHON_PACKAGE_FOUND" : "PYTHON_PACKAGE_MISSING", detail: info.found === true ? `Python ${version}, пакет ${module} найден. Загрузка модели проверяется при подключении бота.` : `Python ${version} найден, но пакет ${module} отсутствует. ${fix ? "Нажмите кнопку подготовки ниже." : "Нажмите «Взять голос Astra» либо укажите Python с пакетом supertonic."}`, ...(info.found === true ? {} : { fix }) };
  }
  private async recognition(s: Settings): Promise<Check[]> {
    if (s.sttUseAstra && ["whisper", "google"].includes(s.sttEngine)) {
      try { s = { ...s, ...await astraRecognition(s.googleSpeechConfirmed) }; }
      catch { return [{ id: "stt", title: "Распознавание Astra", result: "error", code: "ASTRA_STT_SETTINGS", detail: "Не удалось получить выбранное распознавание Astra. Скачайте модель в Astra и нажмите «Взять распознавание Astra»; для Google подтвердите отправку речи." }]; }
    }
    if (s.sttEngine === "google") return [{ id: "stt", title: "Google Web STT", result: s.googleSpeechConfirmed ? "ok" : "error", code: s.googleSpeechConfirmed ? "GOOGLE_CONSENT_OK" : "GOOGLE_CONSENT_REQUIRED", detail: s.googleSpeechConfirmed ? "Отправка речи разрешена. Соединение с Google проверяется при распознавании реплики." : "Подтвердите отправку речи в Google во вкладке «Голос и модель»." }];
    if (s.sttEngine === "api") return [{ id: "stt", title: "API распознавания", result: s.sttModel ? "ok" : "warning", code: "STT_CONFIG", detail: "Проверьте адрес, модель и ключ во вкладке «Голос и модель». Доступность API проверяется при распознавании реплики." }];
    const whisper = s.sttEngine === "whisper";
    const model = whisper ? s.whisperModelPath : s.voskModelPath;
    const modelFound = !!model && (whisper ? await present(model, "file") : await present(join(model, "am", "final.mdl"), "file") && await present(join(model, "conf", "model.conf"), "file"));
    return [await this.python(whisper ? "Python и Whisper" : "Python и Vosk", whisper ? s.whisperPython : s.sttPython, whisper ? "pywhispercpp" : "vosk", whisper ? "setup_whisper" : "setup_local"), { id: "stt-model", title: "Файлы модели распознавания", result: modelFound ? "ok" : "error", code: modelFound ? "STT_MODEL_FOUND" : "STT_MODEL_MISSING", detail: modelFound ? "Основные файлы выбранной модели найдены. Возможность загрузки проверяется при подключении." : whisper ? "Файл Whisper не найден. Скачайте модель в Astra и нажмите «Взять распознавание Astra» либо укажите путь вручную." : "Не найдены основные файлы Vosk. Нажмите «Подготовить Vosk автоматически».", ...(!modelFound && !whisper ? { fix: "setup_local" as const } : {}) }];
  }
  private async voice(s: Settings): Promise<Check[]> {
    if (s.ttsEngine === "fish") {
      const ready = !!s.fishApiKey && !!s.fishVoice && (fishModels as readonly string[]).includes(s.fishModel);
      return [{ id: "voice", title: "Fish Audio", result: ready ? "ok" : "warning", code: "FISH_TTS_CONFIG", detail: ready ? "Ключ, модель и ID голоса указаны. Соединение проверяется кнопкой «Проверить голос»; диагностика не отправляет запрос синтеза." : "Укажите API-ключ Fish Audio, модель из списка и reference_id голоса во вкладке «Голос и модель»." }];
    }
    if (s.ttsEngine === "api") return [{ id: "voice", title: "API озвучки", result: s.ttsModel ? "ok" : "warning", code: "TTS_CONFIG", detail: "Проверьте адрес, модель и ключ озвучки. Синтез проверяется кнопкой «Проверить голос» после подключения бота." }];
    if (s.ttsEngine === "supertonic") {
      let runtime: Check;
      try { await findVoicePython(s.ttsPython); runtime = { id: "supertonic", title: "Python и голос Astra", result: "ok", code: "VOICE_RUNTIME_FOUND", detail: "Совместимое окружение найдено автоматически. Изменять PATH не требуется." }; }
      catch { runtime = { id: "supertonic", title: "Python и голос Astra", result: "error", code: "VOICE_RUNTIME_MISSING", detail: "Не найдено окружение с Supertonic, numpy и onnxruntime. Нажмите «Подготовить Supertonic» или укажите готовый Python.", fix: "setup_voice" }; }
      return [runtime, { id: "voice-model", title: "Папка модели голоса Astra", result: !!s.supertonicModelPath && await present(join(s.supertonicModelPath, "onnx", "vocoder.onnx"), "file") ? "ok" : "error", code: "TTS_MODEL_FOLDER", detail: "Для Supertonic нужна скачанная модель Astra. Нажмите «Взять голос Astra»; полноценный синтез проверяется кнопкой «Проверить голос»." }];
    }
    // Never synthesize/play audio during automatic diagnostics.
    try {
      const voices: any = JSON.parse((await runWindows({ action: "voices" }, AbortSignal.timeout(10000))).toString("utf8"));
      const enabled = Array.isArray(voices) && voices.some(v => typeof v.name === "string" && (!s.windowsVoice || v.name === s.windowsVoice));
      return [{ id: "voice", title: "Голоса Windows", result: enabled ? "ok" : "error", code: enabled ? "WINDOWS_VOICE_FOUND" : "WIN_VOICE", detail: enabled ? "Доступный голос найден. Озвучка при диагностике не запускается." : "Нет выбранного голоса. Установите голос в параметрах речи Windows или выберите найденный голос через «Найти установленные голоса»." }];
    } catch (error) { return [{ id: "voice", title: "Голоса Windows", result: "error", code: error instanceof WindowsServiceError ? error.code : "WIN_SPEECH_INIT", detail: error instanceof WindowsServiceError ? error.message : "Проверка голосов не завершилась. Повторите диагностику или выберите голос Astra/API." }]; }
  }
  private async music(s: Settings): Promise<Check> {
    const path = await findMusicFFmpeg(s.musicFFmpeg);
    if (path) { const result = await probe(path, ["-version"]); if (result.ok && result.output.startsWith("ffmpeg version ")) return { id: "music", title: "Музыка: FFmpeg", result: "ok", code: "FFMPEG_READY", detail: "FFmpeg найден и запускается напрямую. Добавлять его в PATH не нужно." }; }
    return { id: "music", title: "Музыка: FFmpeg", result: "warning", code: path ? "FFMPEG_START_FAILED" : "FFMPEG_MISSING", detail: "Для музыки требуется рабочий FFmpeg. Кнопка подготовки найдёт его или загрузит отдельную копию для плагина, около 109 МБ.", fix: "setup_music" };
  }
  private async model(s: Settings): Promise<Check> {
    try { const selected = await chatSettings(s); return { id: "chat", title: "Настройки модели чата", result: selected.llmModel ? "ok" : "warning", code: "CHAT_CONFIG", detail: selected.llmModel ? "Выбор модели получен. Соединение и ключ проверяются кнопкой «Найти модели» во вкладке «Голос и модель»." : "Модель не указана. Нажмите «Найти модели» и выберите модель во вкладке «Голос и модель»." }; }
    catch { return { id: "chat", title: "Настройки модели чата", result: "error", code: "ASTRA_CHAT_SETTINGS", detail: "Не удалось получить выбранное подключение Astra. Выберите совместимую модель и введите ключ для этого подключения в плагине." }; }
  }
}
