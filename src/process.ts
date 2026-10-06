import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { powershellPath } from "./runtime";

const messages: Record<string, string> = {
  WIN_MISSING: "PowerShell не найден. Восстановите компонент Windows PowerShell и перезапустите Astra.",
  WIN_SCRIPT_MISSING: "Не найден служебный файл windows.ps1. Переустановите плагин из Releases; для исходников сначала выполните сборку.",
  WIN_POLICY: "Политика PowerShell запрещает служебный скрипт. Откройте «Диагностика»: там показана действующая политика и способ исправления.",
  WIN_SECURITY: "Защита Windows заблокировала скрипт. Проверьте журнал защиты Windows и происхождение файла.",
  WIN_LANGUAGE: "Ограниченный режим PowerShell не разрешает операции Windows. На управляемом ПК обратитесь к администратору.",
  WIN_ACCESS: "Windows отказала в запуске PowerShell. Проверьте права доступа к программе и правила организации.",
  WIN_TIMEOUT: "PowerShell не ответил за 60 секунд. Откройте «Диагностика», затем перезапустите Astra и повторите действие.",
  WIN_OUTPUT: "Служебный процесс вернул слишком большой ответ. Сократите текст озвучки и повторите действие.",
  WIN_UNPROTECT: "Windows не смогла открыть сохранённые ключи. Используйте тот же Windows-аккаунт или введите ключи заново. Прежний файл настроек сохранён.",
  WIN_PROTECT: "Windows не смогла зашифровать ключи. Новые изменения не сохранены. Откройте «Диагностика» и проверьте профиль Windows.",
  WIN_SECURITY_ASSEMBLY: "Не удалось загрузить System.Security для шифрования. Восстановите компоненты Windows/.NET Framework и перезапустите Astra.",
  WIN_SPEECH_ASSEMBLY: "Нет доступного System.Speech. Восстановите компоненты Windows/.NET Framework или выберите голос Astra/API.",
  WIN_SPEECH_INIT: "Windows не смогла открыть синтезатор речи. Установите голос в параметрах речи Windows или выберите голос Astra/API.",
  WIN_VOICE: "Выбранный голос Windows недоступен. Нажмите «Найти установленные голоса» и выберите голос этого ПК либо очистите его имя.",
  WIN_SPEAK: "Windows не смогла озвучить текст. Проверьте установленный голос и повторите проверку голоса.",
  WIN_REQUEST: "Служебный запрос Windows завершился ошибкой. Откройте «Диагностика» и скачайте отчёт. Прежние настройки сохранены.",
};
export class WindowsServiceError extends Error {
  constructor(readonly code: string, readonly action: string, readonly exitCode?: number | null) {
    super(`[${code}] ${messages[code] || messages.WIN_REQUEST}`); this.name = "WindowsServiceError";
  }
}
export function windowsFailure(stderr: string): string {
  if (/ScriptContainedMaliciousContent/.test(stderr)) return "WIN_SECURITY";
  if (/PSSecurityException|running scripts is disabled|not digitally signed/.test(stderr)) return "WIN_POLICY";
  if (/ConstrainedLanguage|CannotDefineNewType/.test(stderr)) return "WIN_LANGUAGE";
  for (const [marker, code] of Object.entries({ UNPROTECT_FAILED: "WIN_UNPROTECT", PROTECT_FAILED: "WIN_PROTECT", SECURITY_ASSEMBLY: "WIN_SECURITY_ASSEMBLY", SPEECH_ASSEMBLY: "WIN_SPEECH_ASSEMBLY", SPEECH_INIT: "WIN_SPEECH_INIT", VOICE_FAILED: "WIN_VOICE", SPEAK_FAILED: "WIN_SPEAK" })) {
    if (stderr.includes(`DVOICE_${marker}`)) return code;
  }
  return "WIN_REQUEST";
}

export async function runWindows(input: Record<string, unknown>, signal?: AbortSignal): Promise<Buffer> {
  const action = ["protect", "unprotect", "voices", "speak", "diagnostics"].includes(String(input.action)) ? String(input.action) : "unknown";
  const script = join(__dirname, "assets", "windows.ps1");
  try { await access(script); } catch { throw new WindowsServiceError("WIN_SCRIPT_MISSING", action); }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let size = 0;
    let timedOut = false, failure = "";
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 12_000_000) child.kill(); else output.push(chunk);
    });
    // Inspect bounded diagnostics only for fixed error codes. Never forward stderr:
    // a system provider may quote input or a secret.
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8192);
      const code = windowsFailure(diagnostics); if (code !== "WIN_REQUEST") failure = code;
    });
    child.stdin.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => { failure = error.code === "ENOENT" ? "WIN_MISSING" : error.code === "EACCES" || error.code === "EPERM" ? "WIN_ACCESS" : "WIN_REQUEST"; });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Запрос отменён."));
      else if (timedOut) reject(new WindowsServiceError("WIN_TIMEOUT", action, code));
      else if (size > 12_000_000) reject(new WindowsServiceError("WIN_OUTPUT", action, code));
      else if (failure || code !== 0) reject(new WindowsServiceError(failure || "WIN_REQUEST", action, code));
      else resolve(Buffer.concat(output));
    });
    if (signal?.aborted) child.kill();
    child.stdin.end(JSON.stringify(input), "utf8");
  });
}
