import { statSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function file(path: string): boolean { try { return isAbsolute(path) && statSync(path).isFile(); } catch { return false; } }
function onPath(name: string): string[] {
  return (process.env.PATH || "").split(";").map(p => p.replace(/^"|"$/g, "")).filter(p => isAbsolute(p) && !/WindowsApps/i.test(p)).map(p => join(p, name));
}
// Resolve installed programs directly. No persistent user/system PATH changes.
export function powershellPath(): string {
  const roots = [process.env.SystemRoot, process.env.WINDIR, "C:\\Windows"].filter((p): p is string => !!p);
  return [...roots.map(p => join(p, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")), ...onPath("powershell.exe")].find(file) || "powershell.exe";
}
export function pythonPath(preferred = "python"): string {
  if (preferred && !/^(python(?:3)?(?:\.exe)?)$/i.test(preferred)) return preferred;
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [...onPath("python.exe")];
  if (local && isAbsolute(local)) {
    candidates.push(join(local, "Python", "bin", "python.exe"));
    const root = join(local, "Programs", "Python");
    try { for (const item of readdirSync(root, { withFileTypes: true }).filter(v => v.isDirectory() && /^Python\d+$/.test(v.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) candidates.push(join(root, item.name, "python.exe")); } catch {}
  }
  for (const root of ["C:\\Python314", "C:\\Python313", "C:\\Python312", "C:\\Python311"]) candidates.push(join(root, "python.exe"));
  return candidates.find(file) || preferred || "python";
}
