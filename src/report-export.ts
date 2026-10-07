import { spawn } from "node:child_process";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./config";

export class ReportExport {
  private lastPath = "";
  async save(report: Record<string, unknown>): Promise<{ ok: true; path: string }> {
    // Only the diagnostic schema is accepted by the caller, never UI-supplied
    // data, settings or raw logs. Browser downloads are blocked in Astra's iframe.
    const content = JSON.stringify(report, null, 2) + "\n";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `VC-Discord-diagnostics-${stamp}-${randomUUID().slice(0, 8)}.json`;
    const folders = [join(homedir(), "Downloads"), join(dataDir, "diagnostics")];
    for (const folder of folders) {
      const path = join(folder, filename);
      let created = false;
      try {
        await mkdir(folder, { recursive: true });
        // Open exclusively: a report never replaces an existing user file.
        const file = await open(path, "wx", 0o600); created = true;
        try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
        this.lastPath = path; return { ok: true, path };
      } catch { if (created) await unlink(path).catch(() => {}); }
    }
    throw new Error("Не удалось сохранить отчёт в Загрузки и папку данных плагина. Проверьте свободное место и права записи Windows.");
  }
  async openFolder(): Promise<{ ok: true }> {
    if (!this.lastPath) throw new Error("Сначала нажмите «Скачать отчёт».");
    try { await stat(this.lastPath); } catch { throw new Error("Сохранённый отчёт перемещён или удалён. Скачайте его ещё раз."); }
    const folder = dirname(this.lastPath);
    return new Promise((resolve, reject) => {
      const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [folder], { windowsHide: true, stdio: "ignore" });
      child.once("error", () => reject(new Error("Не удалось открыть Проводник. Путь к сохранённому отчёту показан во вкладке.")));
      child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
    });
  }
}
