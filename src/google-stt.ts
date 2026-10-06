import type { Settings } from "./config";
import { limitedBody } from "./providers";
import { GOOGLE_WEB_STT_PUBLIC_KEY } from "./google-stt-key";

export async function googleTranscribe(s: Settings, pcm: Buffer, signal: AbortSignal): Promise<string> {
  if (!s.googleSpeechConfirmed) throw new Error("Отправка речи в Google не разрешена. Подтвердите её во вкладке «Голос и модель».");
  signal.throwIfAborted();
  const language = s.language === "ru" ? "ru-RU" : s.language === "en" ? "en-US" : s.language;
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw new Error("Укажите язык распознавания, например ru или ru-RU.");
  const url = new URL("https://www.google.com/speech-api/v2/recognize");
  url.search = new URLSearchParams({ client: "chromium", lang: language, key: s.googleApiKey || GOOGLE_WEB_STT_PUBLIC_KEY, pFilter: "0" }).toString();
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/l16; rate=16000; endian=little" }, body: new Uint8Array(pcm), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), redirect: "error" });
  } catch {
    signal.throwIfAborted();
    // Do not include fetch's cause: its URL contains the service key.
    throw new Error("Google Web STT не ответил. Проверьте интернет или переключитесь на локальный Whisper.");
  }
  if ([401, 403, 429].includes(response.status)) {
    await response.body?.cancel();
    throw new Error("Google Web STT ограничил доступ. Попробуйте позже, укажите свой ключ или используйте Whisper.");
  }
  const text = (await limitedBody(response, 200_000, "Google Web STT")).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: any; try { value = JSON.parse(line); } catch { throw new Error("Google Web STT вернул некорректный ответ."); }
    const result = Array.isArray(value.result) ? value.result : [];
    const final = result.filter((item: any) => item.final !== false).map((item: any) => item.alternative?.[0]?.transcript).filter((item: unknown) => typeof item === "string").join(" ").trim();
    if (final) return final.slice(0, 8192);
  }
  return "";
}
