import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { apiUrl, llmKeyScope, modelKey, type Settings } from "./config";

const root = () => join(process.env.APPDATA || "", "astra", "astra");
async function astraSettings(): Promise<any> {
  try { return JSON.parse(await readFile(join(root(), "config", "settings.json"), "utf8")); }
  catch { throw new Error("Не удалось прочитать настройки Astra. Откройте Astra под этим Windows-аккаунтом."); }
}
export async function astraPersonality(s: Settings): Promise<string> {
  if (!s.llmUseAstraPersonality) return "";
  const target = new URL(s.llmBaseUrl);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  if (!local && s.llmPersonalityOrigin !== target.origin) throw new Error("Изменился сервер модели. Во вкладке «Голос и модель» проверьте адрес, подтвердите передачу личности Astra и сохраните настройки. Описание на новый адрес не отправлено.");
  // Only the active user-configured description; never conversations, memory,
  // unused templates, credentials or the daemon's generated tool prompt.
  const value = (await astraSettings()).ai?.system_prompt;
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 64000) throw new Error("Описание личности Astra имеет неподдерживаемый формат или слишком большой размер. Проверьте его в настройках Astra.");
  return value.trim();
}
export async function astraRecognition(allowGoogle = false): Promise<Partial<Settings>> {
  const voice = (await astraSettings()).voice;
  // Astra normalizes a plugin id's hyphens to underscores in provider keys.
  if (["plugin__web_stt", "plugin__web-stt"].includes(voice?.stt_provider)) {
    if (!allowGoogle) throw new Error("В Astra выбран Google Web STT. Для Discord выберите Google Web STT в плагине и подтвердите отправку речи; либо выберите локальный Whisper в Astra.");
    return { sttEngine: "google", sttUseAstra: true, language: typeof voice.stt_language === "string" ? voice.stt_language : "ru" };
  }
  if (!["plugin__astra_stt", "whisper", "whisper_cpp"].includes(voice?.stt_provider)) {
    throw new Error("В Astra выберите локальное распознавание Whisper. Другие движки пока подключаются вручную.");
  }
  const name = String(voice.stt_model || "");
  if (!/^(tiny|base|small|medium|large(?:-v[123])?|large-v3-turbo)(?:\.en)?$/.test(name)) {
    throw new Error("Выбранная модель распознавания Astra пока не поддерживается. Выберите модель Whisper.");
  }
  const folder = join(root(), "data", "models", "whisper");
  // Prefer the smaller quantized copy of the same selected model. Never download
  // a model implicitly or substitute a different model when files are missing.
  for (const suffix of ["-q5_0", "-q8_0", ""]) {
    const model = join(folder, `ggml-${name}${suffix}.bin`);
    try { await access(model); return { sttEngine: "whisper", sttUseAstra: true, sttModel: name, whisperModelPath: model, language: /^[a-z]{2,3}$/.test(voice.stt_language) ? voice.stt_language : "ru" }; }
    catch {}
  }
  throw new Error("Модель Whisper ещё не скачана в Astra. Скачайте выбранную модель в настройках её голоса.");
}
function connection(ai: any, provider: string): Pick<Settings, "llmBaseUrl" | "llmModel" | "llmProviderId"> {
  if (["anthropic", "claude", "gemini", "google", "codex", "chatgpt"].includes(provider)) {
    throw new Error("Этот провайдер Astra не использует совместимый Chat Completions API. Укажите совместимый сервер вручную.");
  }
  const custom = Array.isArray(ai?.custom_providers) ? ai.custom_providers.find((item: any) => item.id === provider) : undefined;
  const credentials = Array.isArray(ai?.provider_credentials) ? ai.provider_credentials.find((item: any) => item.provider === provider) : undefined;
  const current = ai?.provider === provider;
  const endpoint = custom?.api_base_url || credentials?.api_base_url || (current ? ai?.api_base_url : "");
  if (typeof endpoint !== "string" || !endpoint.trim()) throw new Error("В Astra не задан адрес API модели. Настройте модель чата в Astra.");
  let base = apiUrl(endpoint.trim(), "");
  const url = new URL(base);
  // LM Studio and Ollama store a host-only address in Astra.
  if ((provider === "lmstudio" || provider === "ollama") && url.pathname === "/") base += "/v1";
  const model = current ? ai?.model || custom?.model : custom?.model || credentials?.model || "";
  if (typeof model !== "string" || current && !model.trim()) throw new Error("Сначала выберите модель чата в настройках Astra.");
  return { llmBaseUrl: base, llmModel: model.trim(), llmProviderId: provider };
}
export async function astraChat(): Promise<Pick<Settings, "llmBaseUrl" | "llmModel" | "llmProviderId">> {
  const ai = (await astraSettings()).ai;
  return connection(ai, String(ai?.provider || ""));
}
export async function astraConnections(): Promise<{ id: string; name: string; llmBaseUrl: string; llmModel: string }[]> {
  const ai = (await astraSettings()).ai;
  const providers = new Set<string>([ai?.provider, ...(ai?.custom_providers || []).map((p: any) => p.id), ...(ai?.provider_credentials || []).map((p: any) => p.provider)].filter(Boolean));
  const result: { id: string; name: string; llmBaseUrl: string; llmModel: string }[] = [];
  for (const id of providers) {
    try {
      const selected = connection(ai, id);
      const custom = ai?.custom_providers?.find((p: any) => p.id === id);
      result.push({ id, name: String(custom?.name || id), llmBaseUrl: selected.llmBaseUrl, llmModel: selected.llmModel });
    } catch { /* Unsupported/native providers must not be called as OpenAI APIs. */ }
  }
  return result;
}
export async function chatSettings(s: Settings): Promise<Settings> {
  const selected = s.llmUseAstra ? await astraChat() : s;
  const key = modelKey(s, selected);
  return { ...s, ...selected, llmApiKey: key, llmProviderKeys: { ...s.llmProviderKeys, ...(key ? { [llmKeyScope(selected)]: key } : {}) } };
}
