import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataDir } from "./platform";

async function localKey(create: boolean): Promise<Buffer> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "secrets.key");
  if (create) {
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(randomBytes(32)); } finally { await file.close(); }
    } catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error("Не удалось открыть secrets.key этого профиля. Восстановите исходный ключ; настройки не изменены.");
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== 32 || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new Error("Проверьте владельца и права 600 файла secrets.key. Настройки сохранены без изменений.");
    return await file.readFile();
  } finally { await file.close(); }
}

function program(command: string, args: string[], signal?: AbortSignal, input?: string): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 60_000, maxBuffer: 12_000_000, encoding: "buffer", signal }, (error, output) => {
      if (error) reject(new Error("Системная озвучка недоступна. В Linux установите espeak-ng; в macOS проверьте выбранный системный голос. Можно выбрать Supertonic или API."));
      else resolve(output);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input || "", "utf8");
  });
}

export async function runPosix(input: Record<string, unknown>, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (input.action === "protect" || input.action === "unprotect") {
    const value = String(input.value || "");
    if (input.action === "unprotect" && !value.startsWith("local-v1:")) throw new Error("Эти ключи защищены профилем Windows. Введите их заново в профиле этой ОС; исходный файл не изменён.");
    const key = await localKey(input.action === "protect");
    try {
      if (input.action === "protect") {
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from("discord-voice-bridge:local-v1"));
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.from("local-v1:" + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"));
      }
      const payload = Buffer.from(value.slice(9), "base64");
      if (payload.length < 28) throw new Error("Сохранённые ключи повреждены.");
      const cipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
      cipher.setAAD(Buffer.from("discord-voice-bridge:local-v1")); cipher.setAuthTag(payload.subarray(12, 28));
      try { return Buffer.concat([cipher.update(payload.subarray(28)), cipher.final()]); }
      catch { throw new Error("Не удалось открыть сохранённые ключи. Нужен исходный secrets.key этого профиля; файл настроек не изменён."); }
    } finally { key.fill(0); }
  }
  if (input.action === "voices") {
    const output = await program(process.platform === "darwin" ? "/usr/bin/say" : "espeak-ng", process.platform === "darwin" ? ["-v", "?"] : ["--voices"], signal);
    const voices = output.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => {
      if (process.platform === "darwin") { const match = /^(.*?)\s+([a-z]{2,3}_[A-Z]{2})\s/.exec(line); return match ? { name: match[1].trim(), culture: match[2] } : undefined; }
      const fields = line.trim().split(/\s+/); return /^\d+$/.test(fields[0]) ? { name: fields[3], culture: fields[1] } : undefined;
    }).filter(Boolean);
    return Buffer.from(JSON.stringify(voices));
  }
  if (input.action !== "speak") throw new Error("Системное действие не поддерживается.");
  const text = String(input.text || "").slice(0, 1000), voice = String(input.voice || "");
  if (voice.startsWith("-") || /[\r\n\0]/.test(voice) || voice.length > 200) throw new Error("Выберите корректное имя системного голоса.");
  const rate = Math.max(-5, Math.min(5, Number(input.rate) || 0));
  const folder = await mkdtemp(join(tmpdir(), "astra-discord-voice-")), wav = join(folder, "voice.wav");
  try {
    // A file lets espeak finalize its RIFF lengths. Its stdout format uses
    // streaming sentinel lengths, rejected by our strict WAV decoder.
    if (process.platform !== "darwin") await program("espeak-ng", ["-w", wav, "-s", String(175 + rate * 15), "-v", voice || "ru", "--stdin"], signal, text);
    else await program("/usr/bin/say", ["--file-format=WAVE", "--data-format=LEI16@24000", "-o", wav, "-r", String(175 + rate * 15), ...(voice ? ["-v", voice] : []), "-f", "-"], signal, text);
    signal?.throwIfAborted(); return await readFile(wav);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
