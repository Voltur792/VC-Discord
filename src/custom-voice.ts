import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./config";

const maxBytes = 1500000;
export async function readVoiceJson(path: string): Promise<string> {
  if ((await stat(path)).size > maxBytes) throw new Error("Файл голоса слишком большой: максимум 1,5 МБ.");
  return readFile(path, "utf8");
}
export async function importVoiceJson(text: string): Promise<string> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Файл голоса должен быть JSON размером до 1,5 МБ.");
  let value: any; try { value = JSON.parse(text); } catch { throw new Error("Не удалось прочитать JSON голоса."); }
  const clean: Record<string, unknown> = {};
  for (const key of ["style_ttl", "style_dp"]) {
    const tensor = value?.[key], dims = tensor?.dims;
    if (!Array.isArray(dims) || dims.length < 1 || dims.length > 4 || dims.some((n: unknown) => !Number.isInteger(n) || Number(n) < 1 || Number(n) > 4096) || dims.reduce((a: number, b: number) => a * b, 1) > 150000) throw new Error("Неподдерживаемый профиль Supertonic: проверьте style_ttl и style_dp.");
    const check = (data: unknown, depth: number): boolean => depth === dims.length ? typeof data === "number" && Number.isFinite(data) : Array.isArray(data) && data.length === dims[depth] && data.every(item => check(item, depth + 1));
    if (!check(tensor.data, 0)) throw new Error("Данные JSON голоса не соответствуют размерам профиля Supertonic.");
    clean[key] = { data: tensor.data, dims, type: "float32" };
  }
  // Only synthesis tensors are copied. Personal metadata from Voice Builder
  // (recording paths, file names, etc.) does not enter the plugin's stored profile.
  const content = JSON.stringify(clean), id = createHash("sha256").update(content).digest("hex");
  const folder = join(dataDir, "voices"); await mkdir(folder, { recursive: true });
  const path = join(folder, `custom-${id}.json`), temp = join(folder, `.voice-${randomUUID()}.tmp`);
  try { await writeFile(temp, content, { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
  return path;
}
