import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { apiUrl, fishModels, type Settings } from "./config";
import { fromWav, resample, wav } from "./audio";
import { runWindows } from "./process";
import { SupertonicWorker } from "./supertonic";
import { visionBase } from "./screen";
import { WhisperWorker } from "./whisper";
import { chatSettings, astraRecognition } from "./astra-settings";
import { googleTranscribe } from "./google-stt";
import { pythonPath } from "./runtime";

export type ChatContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "auto" } })[];
export interface ChatMessage { role: "system" | "user" | "assistant"; content: ChatContent }
export async function limitedBody(response: Response, max = 2_000_000, label = "Сервис"): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new Error(`${label}: сервер отклонил ключ доступа (HTTP 401). Проверьте ключ выбранного подключения.`);
    throw new Error(`${label}: сервер вернул HTTP ${response.status}. Проверьте адрес, ключ и модель.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Сервис вернул пустой ответ.");
  const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > max) throw new Error("Ответ сервиса слишком большой."); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function headers(key: string, json = false): Record<string, string> {
  return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}
const requestSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
async function providerFetch(label: string, url: string, options: RequestInit): Promise<Response> {
  try { return await fetch(url, options); }
  catch (error) {
    const target = new URL(url).host;
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
      if (options.signal?.aborted && options.signal.reason?.name === "AbortError") throw error;
      throw new Error(`${label}: сервер ${target} не ответил вовремя. Проверьте его состояние и повторите реплику.`);
    }
    if (code === "ECONNREFUSED") throw new Error(`${label}: нет соединения с ${target}. Проверьте адрес и порт API в настройках плагина и запустите сервер.`);
    if (["ECONNRESET", "UND_ERR_SOCKET"].includes(code || "")) throw new Error(`${label}: сервер ${target} прервал соединение. Проверьте его состояние и повторите реплику.`);
    throw new Error(`${label}: не удалось связаться с ${target}. Проверьте адрес API и доступность сервера.`);
  }
}
export async function modelNames(s: Settings, signal?: AbortSignal): Promise<string[]> {
  s = await chatSettings(s);
  const response = await providerFetch("Список моделей", apiUrl(s.llmBaseUrl, "/models"), { headers: headers(s.llmApiKey), signal: requestSignal(signal), redirect: "error" });
  const body = JSON.parse((await limitedBody(response, 2_000_000, "Список моделей")).toString("utf8"));
  return (Array.isArray(body.data) ? body.data : []).map((v: any) => v.id).filter((v: unknown) => typeof v === "string").slice(0, 100);
}
export async function publicChat(s: Settings, messages: ChatMessage[], signal?: AbortSignal, retryAllowed?: () => boolean): Promise<string> {
  s = await chatSettings(s);
  const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
  const base = hasImages ? visionBase(s) : s.llmBaseUrl;
  const model = s.llmModel || (await modelNames(s, signal))[0];
  if (!model) throw new Error("В сервере модели нет загруженной модели. Загрузите её и укажите имя в настройках.");
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(new URL(base).hostname);
  // Reasoning consumes the same token limit as the final answer. Local vision
  // models need room to finish thinking; never speak their reasoning field.
  const budgets = local ? [2048, 4096] : [hasImages ? 1024 : 300];
  for (let attempt = 0; attempt < budgets.length; attempt++) {
    signal?.throwIfAborted();
    if (attempt > 0 && retryAllowed && !retryAllowed()) throw new Error("Повторный запрос отменён: участник или показ экрана больше недоступны.");
    // No tools and no link to Astra's privileged chat. A retry reuses this
    // request's existing image, never captures a new screen or changes server.
    const response = await providerFetch("Модель разговора", apiUrl(base, "/chat/completions"), {
      method: "POST", headers: headers(s.llmApiKey, true), signal: requestSignal(signal), redirect: "error",
      body: JSON.stringify({ model, messages, stream: false, max_tokens: budgets[attempt] }),
    });
    if (hasImages && [400, 415, 422].includes(response.status)) {
      await response.body?.cancel();
      throw new Error("Модель не приняла снимок. Проверьте, что выбранная модель и её сервер поддерживают изображения в Chat Completions.");
    }
    const body = JSON.parse((await limitedBody(response, 2_000_000, "Модель разговора")).toString("utf8"));
    const choice = body.choices?.[0], message = choice?.message;
    if (message?.tool_calls?.length || message?.function_call) throw new Error("Разговорная модель попыталась вызвать инструмент. Такой ответ отклонён.");
    const text = typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.filter((v: any) => v.type === "text").map((v: any) => v.text).join(" ") : "";
    if (text.trim()) return text.trim().slice(0, 1200);
    if (choice?.finish_reason === "length") {
      if (attempt + 1 < budgets.length) continue;
      throw new Error("Модель исчерпала лимит генерации до итогового ответа. Сократите вопрос или уменьшите режим рассуждений в сервере модели.");
    }
    if ((typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) || (typeof message?.reasoning === "string" && message.reasoning.trim())) throw new Error("Модель вернула только рассуждения без итогового ответа. Проверьте настройки режима рассуждений в сервере модели.");
    throw new Error("Разговорная модель вернула пустой итоговый ответ. Повторите реплику.");
  }
  throw new Error("Модель не вернула итоговый ответ.");
}

export class VoskWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private signature = "";
  private sequence = 0;
  private pending = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();
  async start(s: Settings): Promise<void> {
    const signature = `${s.sttPython}\0${s.voskModelPath}`;
    if (this.child && this.signature === signature && this.ready) return this.ready;
    this.stop();
    if (!s.voskModelPath) throw new Error("Выберите папку распакованной модели Vosk в настройках речи.");
    this.signature = signature;
    this.child = spawn(pythonPath(s.sttPython), ["-u", join(__dirname, "assets", "vosk_worker.py"), "--model", s.voskModelPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    const child = this.child;
    child.stderr.resume();
    child.stdin.on("error", () => {});
    let settled = false;
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error("Vosk не загрузился за 45 секунд.")); this.stop(); }, 45_000);
      const fail = (message = "Не удалось загрузить Vosk. Проверьте Python, пакет vosk и папку модели.") => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(new Error(message)); }
        if (this.child === child) {
          for (const p of this.pending.values()) p.reject(new Error("Локальное распознавание остановлено."));
          this.pending.clear(); this.child = undefined; this.ready = undefined;
        }
      };
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let value: any; try { value = JSON.parse(line); } catch { return; }
        if (value.ready) { settled = true; clearTimeout(timeout); resolve(); }
        if (value.error && !settled) {
          const errors: Record<string, string> = {
            package_missing: "В выбранном Python нет Vosk или его зависимостей. Нажмите «Подготовить Vosk автоматически».",
            model_missing: "Папка модели Vosk не найдена. Выберите распакованную модель или нажмите «Подготовить Vosk автоматически».",
            model_load_failed: "Vosk не смог открыть модель. Проверьте, что она распакована полностью, или повторите автоматическую подготовку.",
          };
          fail(errors[String(value.error)]); child.kill();
        }
        const request = this.pending.get(value.id);
        if (request) { this.pending.delete(value.id); value.error ? request.reject(new Error("Vosk не распознал эту реплику.")) : request.resolve(String(value.text || "")); }
      });
      child.on("error", () => fail("Не удалось запустить Python для Vosk. Проверьте путь к Python в настройках речи.")); child.on("close", () => fail());
    });
    return this.ready;
  }
  async transcribe(s: Settings, pcm: Buffer, signal: AbortSignal): Promise<string> {
    await this.start(s);
    signal.throwIfAborted();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (text?: string, error?: Error) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(id);
        error ? reject(error) : resolve(text || "");
      };
      const abort = () => finish(undefined, new Error("Запрос отменён."));
      const timer = setTimeout(() => finish(undefined, new Error("Время распознавания истекло.")), 30_000);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: text => finish(text), reject: e => finish(undefined, e) });
      this.child!.stdin.write(JSON.stringify({ id, audio: pcm.toString("base64") }) + "\n");
    });
  }
  stop(): void { this.child?.kill(); this.child = undefined; this.ready = undefined; for (const p of this.pending.values()) p.reject(new Error("Распознавание остановлено.")); this.pending.clear(); }
}
export class Providers {
  readonly vosk = new VoskWorker();
  readonly whisper = new WhisperWorker();
  readonly supertonic = new SupertonicWorker();
  async transcribe(s: Settings, stereoPcm: Buffer, signal: AbortSignal): Promise<string> {
    if (s.sttUseAstra && ["whisper", "google"].includes(s.sttEngine)) {
      const selected = await astraRecognition(s.googleSpeechConfirmed);
      s = { ...s, ...selected, sttUseAstra: false };
    }
    const pcm = resample(stereoPcm, 48000, 2, 16000);
    if (s.sttEngine === "vosk") return this.vosk.transcribe(s, pcm, signal);
    if (s.sttEngine === "whisper") return this.whisper.transcribe(s, pcm, signal);
    if (s.sttEngine === "google") return googleTranscribe(s, pcm, signal);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(wav(pcm))], { type: "audio/wav" }), "speech.wav");
    form.set("model", s.sttModel); form.set("response_format", "json");
    if (s.language) form.set("language", s.language);
    const response = await providerFetch("Распознавание речи", apiUrl(s.sttBaseUrl, "/audio/transcriptions"), { method: "POST", headers: headers(s.sttApiKey), body: form, signal: requestSignal(signal), redirect: "error" });
    const result = JSON.parse((await limitedBody(response, 2_000_000, "Распознавание речи")).toString("utf8"));
    return typeof result.text === "string" ? result.text.trim().slice(0, 4000) : "";
  }
  async speak(s: Settings, text: string, signal: AbortSignal): Promise<Buffer> {
    const spoken = text.replace(/\[[^\]]+\]\(([^)]+)\)/g, match => match.slice(1, match.indexOf("]"))).replace(/https?:\/\/\S+/g, "").replace(/[*_`#]/g, "").slice(0, 1000);
    if (s.ttsEngine === "supertonic") return this.supertonic.speak(s, spoken, signal);
    if (s.ttsEngine === "windows") {
      const audio = fromWav(await runWindows({ action: "speak", text: spoken, voice: s.windowsVoice, rate: s.windowsRate }, signal));
      return resample(audio.pcm, audio.rate, audio.channels, 48000, 2);
    }
    if (s.ttsEngine === "fish") {
      if (!s.fishApiKey) throw new Error("Fish Audio: введите отдельный API-ключ во вкладке «Голос и модель».");
      if (!s.fishVoice) throw new Error("Fish Audio: укажите reference_id выбранного голоса из Fish Audio.");
      if (!(fishModels as readonly string[]).includes(s.fishModel)) throw new Error("Fish Audio: выберите модель из списка; неизвестное имя не отправляется сервису.");
      const response = await providerFetch("Fish Audio", "https://api.fish.audio/v1/tts", {
        method: "POST", headers: { ...headers(s.fishApiKey, true), model: s.fishModel }, signal: requestSignal(signal), redirect: "error",
        body: JSON.stringify({ text: spoken, reference_id: s.fishVoice, format: "pcm", sample_rate: 24000 }),
      });
      if ([400, 404, 422].includes(response.status)) {
        await response.body?.cancel();
        throw new Error(`Fish Audio: HTTP ${response.status}. Проверьте доступность модели и reference_id голоса в своём аккаунте Fish Audio.`);
      }
      const pcm = await limitedBody(response, 12_000_000, "Fish Audio");
      if (!pcm.length || pcm.length % 2) throw new Error("Fish Audio вернул пустой или повреждённый звук PCM.");
      return resample(pcm, 24000, 1, 48000, 2);
    }
    const response = await providerFetch("Озвучка", apiUrl(s.ttsBaseUrl, "/audio/speech"), {
      method: "POST", headers: headers(s.ttsApiKey, true), signal: requestSignal(signal), redirect: "error",
      body: JSON.stringify({ model: s.ttsModel, input: spoken, voice: s.ttsVoice, response_format: "pcm" }),
    });
    return resample(await limitedBody(response, 12_000_000, "Озвучка"), 24000, 1, 48000, 2);
  }
  async voices(): Promise<unknown[]> { return JSON.parse((await runWindows({ action: "voices" })).toString("utf8")); }
  stop(): void { this.vosk.stop(); this.whisper.stop(); this.supertonic.stop(); }
}
