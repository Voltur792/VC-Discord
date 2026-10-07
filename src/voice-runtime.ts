import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dataDir } from "./config";
import { pythonPath } from "./runtime";

let cached: { preferred: string; path: string; until: number } | undefined;
const searches = new Map<string, Promise<string>>();
const exists = async (path: string) => { try { return isAbsolute(path) && (await stat(path)).isFile(); } catch { return false; } };
function suitable(path: string): Promise<boolean> {
  return new Promise(resolve => execFile(path, ["-c", "from supertonic import TTS; import numpy, onnxruntime; assert hasattr(TTS, 'get_voice_style_from_path'); print('VOICE_RUNTIME_OK')"], { windowsHide: true, timeout: 6000, maxBuffer: 16000, env: { ...process.env, PYTHONUTF8: "1" } }, (error, stdout) => resolve(!error && stdout.includes("VOICE_RUNTIME_OK"))));
}
export async function findVoicePython(preferred = "python"): Promise<string> {
  const pending = searches.get(preferred); if (pending) return pending;
  const search = discover(preferred); searches.set(preferred, search);
  try { return await search; } finally { if (searches.get(preferred) === search) searches.delete(preferred); }
}
async function discover(preferred: string): Promise<string> {
  if (cached?.preferred === preferred && cached.until > Date.now() && await exists(cached.path)) return cached.path;
  const root = resolve(__dirname, ".."), home = homedir();
  const candidates = [preferred, process.env.SUPERTONIC_PYTHON || "", ...[process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX].filter(Boolean).map(p => join(p!, "Scripts", "python.exe")), join(dataDir, "supertonic-env", "Scripts", "python.exe"), join(root, ".runtime", "supertonic", "Scripts", "python.exe"), join(root, ".venv", "Scripts", "python.exe"), pythonPath()];
  for (const env of [process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX]) if (env) candidates.push(join(env, "python.exe"));
  for (const p of (process.env.PATH || "").split(";").map(p => p.replace(/^"|"$/g, ""))) if (isAbsolute(p) && !/WindowsApps/i.test(p)) candidates.push(join(p, "python.exe"));
  // Bounded discovery of common environment locations, including neighbouring
  // plugins. Never crawl the whole drive or change the user's PATH.
  for (const folder of [dirname(root), dirname(dataDir), join(process.env.APPDATA || home, "astra", "astra"), join(home, ".virtualenvs"), join(home, "miniconda3", "envs"), join(home, "anaconda3", "envs"), join(process.env.LOCALAPPDATA || home, "Programs", "Python")]) {
    let dirs: string[] = [];
    try { dirs = (await readdir(folder, { withFileTypes: true })).filter(p => p.isDirectory() && !p.isSymbolicLink()).slice(0, 100).map(p => join(folder, p.name)); } catch {}
    for (const dir of dirs) for (const suffix of ["python.exe", "Scripts/python.exe", ".venv/Scripts/python.exe", "venv/Scripts/python.exe", ".runtime/supertonic/Scripts/python.exe", "supertonic-env/Scripts/python.exe"]) candidates.push(join(dir, suffix));
  }
  const unique: string[] = [], seen = new Set<string>();
  for (const path of candidates) if (path && !seen.has(path.toLowerCase()) && await exists(path)) { seen.add(path.toLowerCase()); unique.push(path); }
  for (let start = 0; start < Math.min(unique.length, 24); start += 3) {
    const paths = unique.slice(start, start + 3), found = await Promise.all(paths.map(suitable));
    const index = found.indexOf(true);
    if (index >= 0) { const path = paths[index]; cached = { preferred, path, until: Date.now() + 60000 }; return path; }
  }
  throw new Error("Python с Supertonic не найден. Нажмите «Подготовить Supertonic» или укажите Python окружения с пакетами supertonic, numpy и onnxruntime. PATH менять не требуется.");
}
