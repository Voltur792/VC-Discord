import { spawn } from "node:child_process";
import { join } from "node:path";

export function runWindows(input: Record<string, unknown>, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(__dirname, "assets", "windows.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => child.kill(), 60_000);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 12_000_000) child.kill(); else output.push(chunk);
    });
    // Inspect bounded diagnostics only for fixed error codes. Never forward stderr:
    // a system provider may quote input or a secret.
    let diagnostics = "", securityBlocked = false, unprotectFailed = false;
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8192);
      securityBlocked ||= diagnostics.includes("ScriptContainedMaliciousContent");
      unprotectFailed ||= diagnostics.includes("DVOICE_UNPROTECT_FAILED");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("Не удалось запустить служебный процесс Windows. Настройки и ключи сохранены.")));
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Запрос отменён."));
      else if (securityBlocked) reject(new Error("Защита Windows заблокировала служебный скрипт плагина. Ключи сохранены; это не ошибка Windows-аккаунта."));
      else if (unprotectFailed) reject(new Error("Windows не смогла расшифровать сохранённые ключи. Проверьте Windows-аккаунт. Файл настроек сохранён."));
      else if (code !== 0 || size > 12_000_000) reject(new Error("Служба Windows не выполнила запрос. Настройки и ключи сохранены."));
      else resolve(Buffer.concat(output));
    });
    if (signal?.aborted) child.kill();
    child.stdin.end(JSON.stringify(input), "utf8");
  });
}
