import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Settings } from "./config";
import { limitedBody } from "./providers";
import type { VoiceTransport } from "./voice";

async function musicCall(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
  let location: { port: number; token: string };
  try {
    const folder = process.env.SPT_INTEGRATION_DIR || join(process.env.APPDATA || "", "sleep-pause-timer", "integrations");
    location = JSON.parse(await readFile(join(folder, "music.json"), "utf8"));
    if (!Number.isInteger(location.port) || location.port < 1 || location.port > 65535 || !/^[A-Za-z0-9_-]{32,100}$/.test(location.token)) throw new Error();
  } catch { throw new Error("Нет связи с Astra Music. Включите обновлённый музыкальный плагин в Astra."); }
  try {
    const response = await fetch(`http://127.0.0.1:${location.port}/api`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000),
      headers: { Authorization: "Bearer " + location.token, "Content-Type": "application/json" }, body: JSON.stringify({ method, params }),
    });
    if (response.status === 404) { await response.body?.cancel(); throw new Error("Перезапустите обновлённый Astra Music: музыкальный мост ещё не поддерживает Discord."); }
    const data = JSON.parse((await limitedBody(response, 500000, "Astra Music")).toString("utf8"));
    if (data.error) throw new Error("Astra Music не смогла подготовить трек. Проверьте подключение музыкального сервиса в её вкладке.");
    return data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Astra Music") || error instanceof Error && error.message.startsWith("Перезапустите")) throw error;
    throw new Error("Нет ответа от музыкального моста. Перезапустите Astra Music и повторите действие.");
  }
}

export class DiscordMusic {
  private child?: ChildProcessWithoutNullStreams;
  private pcm?: PassThrough;
  private controller?: AbortController;
  private poll?: NodeJS.Timeout;
  private epoch = 0;
  private revision = -1;
  private following = false;
  private paused = false;
  private polling = false;
  private title = "";
  private artist = "";
  private error = "";
  private selectedVolume?: number;
  private session = "";
  private loading = false;
  private trackStartedAt = 0;
  private pauseStartedAt = 0;
  private pauseMillis = 0;
  private service: "yandex" | "vk" = "yandex";
  private job?: { id: string; status: string; result?: unknown; error?: string };
  private hlsOptions = new Map<string, string[]>();
  private bridgeVersion = 0;
  private transitioning = false;
  private volumeRevision = 0;
  private readonly volumeInstance = randomBytes(16).toString("hex");
  private syncFinished: Promise<void> = Promise.resolve();
  constructor(private transport: VoiceTransport, private settings: () => Settings, private note: (text: string, error?: boolean) => void) {}
  state(): Record<string, unknown> { return { following: this.following, loading: this.loading || this.transitioning, paused: this.paused, title: this.title, artist: this.artist, error: this.error, playing: !!this.child && !this.paused, volume: this.selectedVolume ?? this.settings().musicVolume, volumeRevision: this.volumeRevision, volumeInstance: this.volumeInstance, audio: this.transport.musicStats(), job: this.job }; }
  beginJob(method: "search" | "playlists" | "play" | "next", value: unknown = {}): unknown {
    if (this.job?.status === "loading") throw new Error("Дождитесь завершения музыкального действия.");
    const job = { id: randomBytes(16).toString("hex"), status: "loading" } as NonNullable<typeof this.job>;
    this.job = job;
    void (async () => {
      try { job.result = await (method === "search" ? this.search(value) : method === "playlists" ? this.playlists(value) : method === "next" ? this.next(false, Number((value as any)?.direction) || 1) : this.play(value)); job.status = "done"; }
      catch (error) { job.error = error instanceof Error ? error.message : "Музыкальное действие не выполнено."; job.status = "failed"; this.note(job.error, true); }
    })();
    return { ok: true, jobId: job.id };
  }
  async current(): Promise<unknown> {
    const track = await musicCall("current");
    return { track: { service: track.service, track_id: track.track_id, title: track.title, artist: track.artist } };
  }
  async search(value: unknown): Promise<unknown> {
    const input = value as any;
    const query = String(input?.query || "").trim().slice(0, 200);
    if (!query) throw new Error("Введите название трека или исполнителя.");
    this.service = input?.service === "vk" ? "vk" : "yandex";
    return musicCall("search", { service: this.service, query, limit: 10 });
  }
  playlists(value: unknown): Promise<any> { this.service = (value as any)?.service === "vk" ? "vk" : "yandex"; return musicCall("discord_playlists", { service: this.service }); }
  async play(value?: unknown): Promise<unknown> {
    if (!this.transport.connected) throw new Error("Подключите бота к голосовому каналу.");
    this.stop();
    const epoch = this.epoch;
    this.controller = new AbortController();
    this.session = randomBytes(16).toString("hex"); this.loading = true;
    const input = value as any;
    try {
      this.service = input?.service === "vk" ? "vk" : "yandex";
      await musicCall("discord_play", { session: this.session, service: this.service, mode: ["wave", "library", "playlist"].includes(input?.mode) ? input.mode : "track", playlist_id: String(input?.playlist_id || "").slice(0, 200), track_id: String(input?.track_id || "").slice(0, 100), title: String(input?.title || "").slice(0, 200), artist: String(input?.artist || "").slice(0, 200), extra: input?.extra && typeof input.extra === "object" ? input.extra : {} }, this.controller.signal);
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      this.following = true; this.error = "";
      await this.sync();
      if (epoch === this.epoch) this.loading = false;
    } catch (error) { if (epoch !== this.epoch) return { ok: true, cancelled: true }; this.stop(); throw error; }
    if (epoch !== this.epoch || !this.following) return { ok: true, cancelled: true };
    this.poll = setInterval(() => { void this.sync().catch(() => { if (!this.following || this.epoch !== epoch) return; this.stop(); this.error = "Связь с Astra Music потеряна. Подключите трансляцию заново."; this.note(this.error, true); }); }, 1500);
    return { ok: true };
  }
  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    if (paused) this.pauseStartedAt = Date.now();
    else { this.pauseMillis += Math.max(0, Date.now() - this.pauseStartedAt); this.pauseStartedAt = 0; }
    this.paused = paused; this.transport.pauseMusic(paused);
  }
  pause(): { ok: true } { this.setPaused(!this.paused); return { ok: true }; }
  volume(value: unknown): { ok: true; volumeRevision: number } {
    const input = value as any;
    // Keep old percent calls working; the current UI and voice use level 0–10.
    const volume = input?.level !== undefined ? Number(input.level) * 10 : Number(input?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("Громкость должна быть от 0 до 10.");
    this.selectedVolume = volume; this.volumeRevision++; this.transport.musicVolume(volume); return { ok: true, volumeRevision: this.volumeRevision };
  }
  stop(): { ok: true } {
    const session = this.session; this.session = ""; this.loading = false;
    if (session) void musicCall("discord_stop", { session }).catch(() => {});
    this.following = false; this.epoch++; this.controller?.abort(); this.controller = undefined;
    if (this.poll) clearInterval(this.poll); this.poll = undefined;
    this.stopDecoder(); this.transport.stopMusic(); this.revision = -1; this.title = ""; this.artist = ""; this.paused = false;
    return { ok: true };
  }
  private stopDecoder(): void { const child = this.child; this.child = undefined; this.pcm?.destroy(); this.pcm = undefined; child?.stdout.destroy(); child?.stdin.destroy(); child?.kill(); }
  async next(finished = false, direction = 1): Promise<unknown> {
    if (!this.following || !this.session) return { ok: true };
    if (this.transitioning) return { ok: true, pending: true };
    this.transitioning = true;
    const epoch = this.epoch;
    const playedSeconds = this.trackStartedAt ? Math.max(0, (Date.now() - this.trackStartedAt - this.pauseMillis - (this.paused ? Date.now() - this.pauseStartedAt : 0)) / 1000) : 0;
    try {
      await this.syncFinished;
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      this.stopDecoder(); this.transport.stopMusic();
      const params: Record<string, unknown> = { session: this.session, revision: this.revision, direction, finished };
      // Earlier running Music instances do not accept this optional argument.
      // Negotiate it from state rather than assuming a source file was reloaded.
      if (this.bridgeVersion >= 2) params.played_seconds = playedSeconds;
      const result = await musicCall("discord_next", params, this.controller?.signal);
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      if (result.status === "stopped") { this.stop(); return { ok: true, ended: true }; }
      if (result.cancelled) return { ok: true, cancelled: true };
      this.error = ""; this.revision = -1; await this.sync(true);
      return { ok: true };
    } catch (error) {
      if (epoch === this.epoch) {
        this.stop(); this.error = "Не удалось включить следующий трек.";
        this.note(this.error, true);
      }
      throw error;
    } finally { this.transitioning = false; }
  }
  async voice(text: string, allowed: () => boolean, signal: AbortSignal): Promise<string | undefined> {
    const phrase = text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[.,!?;:]/g, " ").trim()
      .replace(/^(?:астра|астр|остра)\s+/, "").replace(/\s+/g, " ");
    const control = /^(?:пауза(?: музыки)?|останови музыку|выключи музыку|продолжи музыку|возобнови музыку|следующ(?:ий|ая) (?:трек|песня)|предыдущ(?:ий|ая) (?:трек|песня)|(?:сделай |музыку )?(?:громче|тише)(?: музыку)?|(?:громкость|громкость музыки|установи громкость|сделай громкость|сделай громкость музыки) .+|(?:включи|поставь|запусти) (?:музыку|музыку в дискорде|мою волну|моя волна|мои треки (?:вк|vk)|плейлист .+|(?:песню|трек|музыку) .+)|найди (?:песню|трек|музыку) .+)$/u.test(phrase);
    if (!control) return undefined;
    if (!allowed()) return "У этого аккаунта нет доступа к управлению музыкой.";
    signal.throwIfAborted();
    if (this.loading || this.transitioning || this.job?.status === "loading") return "Дождитесь завершения музыкального действия.";
    if (/^пауза/u.test(phrase)) { this.setPaused(true); return "Музыка на паузе."; }
    if (phrase === "выключи музыку" || phrase === "останови музыку") { this.stop(); return "Музыка остановлена."; }
    if (/^(?:продолжи|возобнови) музыку$/u.test(phrase)) { this.setPaused(false); return "Продолжаю музыку."; }
    if (/^(?:следующ|предыдущ)/u.test(phrase)) { await this.next(false, phrase.startsWith("предыдущ") ? -1 : 1); return "Переключаю трек."; }
    if (/громче|тише/u.test(phrase)) { this.volume({ level: Math.max(0, Math.min(10, (this.selectedVolume ?? this.settings().musicVolume) / 10 + (phrase.includes("громче") ? 1 : -1))) }); return "Громкость " + (this.selectedVolume! / 10) + " из десяти."; }
    if (phrase.includes("громкость")) {
      const words: Record<string, number> = { ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100 };
      const amount = phrase.slice(phrase.lastIndexOf("громкость") + 9).replace(/^(?: музыки)?\s*(?:на\s+)?/u, "").replace(/\s*(?:процент(?:ов|а)?|%)$/u, "").trim();
      const parts = amount.split(" ");
      const parsed = /^\d{1,3}$/.test(amount) ? Number(amount) : parts.length <= 2 && parts.every(p => words[p] !== undefined) ? parts.reduce((sum, p) => sum + words[p], 0) : NaN;
      const level = /(?:процент(?:ов|а)?|%)$/u.test(phrase) ? parsed / 10 : parsed;
      if (!Number.isFinite(level) || level < 0 || level > 10) return "Назовите громкость от нуля до десяти.";
      this.volume({ level }); return "Громкость " + level + " из десяти.";
    }
    let input: any;
    if (/^(?:включи|поставь|запусти) музыку(?: в дискорде)?$/u.test(phrase)) input = {};
    else if (/мо[юя] волн[уа]$/u.test(phrase)) input = { mode: "wave", service: "yandex" };
    else if (/мои треки (?:вк|vk)$/u.test(phrase)) input = { mode: "library", service: "vk" };
    else if (phrase.includes("плейлист ")) {
      const wanted = phrase.split("плейлист ")[1];
      const data = await this.playlists({ service: this.service });
      const list = (data.playlists || []).filter((p: any) => String(p.title || "").toLocaleLowerCase("ru").replace(/ё/g, "е").trim() === wanted);
      if (list.length !== 1) return list.length ? "Есть несколько таких плейлистов. Выберите нужный во вкладке плагина." : "Плейлист с таким названием не найден.";
      input = { mode: "playlist", service: this.service, playlist_id: list[0].playlist_id };
    } else {
      const query = phrase.replace(/^(?:включи|поставь|запусти|найди) (?:песню|трек|музыку) /u, "");
      const data = await this.search({ service: this.service, query }) as any;
      input = data.tracks?.[0];
      if (!input) return "Не нашла такой трек. Попробуйте назвать исполнителя и песню.";
    }
    if (signal.aborted || !allowed()) return "Управление музыкой отменено.";
    const abort = () => this.stop(); signal.addEventListener("abort", abort, { once: true });
    let result: any;
    try { result = await this.play(input); }
    finally { signal.removeEventListener("abort", abort); }
    return signal.aborted || result?.cancelled ? undefined : "Включаю " + (this.title || "музыку") + " в Discord.";
  }
  private async decoderHlsOptions(executable: string): Promise<string[]> {
    const cached = this.hlsOptions.get(executable);
    if (cached) return cached;
    const help = await new Promise<string>(resolve => execFile(executable, ["-hide_banner", "-h", "demuxer=hls"], { windowsHide: true, timeout: 5000, maxBuffer: 32000 }, (error, stdout) => resolve(error ? "" : stdout)));
    const options = ["-allowed_extensions", "ALL"];
    if (help.includes("allowed_segment_extensions")) options.push("-allowed_segment_extensions", "ALL");
    if (help.includes("extension_picky")) options.push("-extension_picky", "0");
    this.hlsOptions.set(executable, options); return options;
  }
  private async sync(transition = false): Promise<void> {
    if (!this.following || this.polling || this.transitioning && !transition) return;
    this.polling = true;
    let finished!: () => void;
    this.syncFinished = new Promise<void>(resolve => { finished = resolve; });
    const epoch = this.epoch;
    try {
      const track = await musicCall("discord_state", { session: this.session }, this.controller?.signal);
      if (epoch !== this.epoch || !this.following || this.transitioning && !transition) return;
      this.bridgeVersion = Number(track.bridge_version) || 0;
      if (!this.transport.connected) { this.stop(); return; }
      this.title = String(track.title || ""); this.artist = String(track.artist || "");
      if (!track.stream_url || ["stopped", "failed", "idle"].includes(track.status)) { this.stop(); return; }
      if (track.revision !== this.revision) {
        const url = new URL(track.stream_url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]{32,100}\/discord-stream\/\d+\/0$/.test(url.pathname)) throw new Error("Неверный адрес музыкального потока.");
        let executable = this.settings().musicFFmpeg;
        if (!executable) {
          const candidates = [join(__dirname, "native", "ffmpeg.exe"), "C:\\ffmpeg\\bin\\ffmpeg.exe", ...(process.env.PATH || "").split(";").map(p => join(p, "ffmpeg.exe"))];
          for (const path of candidates) { try { await access(path); executable = path; break; } catch {} }
        }
        if (!executable) throw new Error("FFmpeg не найден на этом ПК. Установите FFmpeg для воспроизведения музыки в Discord.");
        if (epoch !== this.epoch) return;
        this.stopDecoder(); this.revision = track.revision;
        // FFmpeg can read HLS playlists, segments and AES keys only via our
        // loopback proxy. It receives no service cookies or signed CDN URLs.
        const hlsOptions = track.service === "vk" ? await this.decoderHlsOptions(executable) : [];
        if (epoch !== this.epoch) return;
        const child = spawn(executable, ["-hide_banner", "-loglevel", "error", "-nostdin", "-rw_timeout", "25000000", "-protocol_whitelist", "http,tcp,crypto", ...hlsOptions, "-i", url.href, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        this.child = child;
        const pcm = new PassThrough({ highWaterMark: 96000 }); this.pcm = pcm;
        child.stdout.pipe(pcm);
        const fail = () => { if (this.child !== child) return; this.stop(); this.error = "Музыкальный поток прерван. Проверьте трек в Astra Music и запустите трансляцию заново."; this.note(this.error, true); };
        child.on("error", fail); child.stdin.on("error", () => {}); child.stdout.on("error", fail); pcm.on("error", fail); child.stderr.resume();
        child.on("close", code => {
          if (this.child !== child) return;
          if (code !== 0) { fail(); return; }
        });
        // Wait until the buffered tail has actually been consumed by Discord.
        pcm.once("end", () => { if (this.child === child) void this.next(true).catch(() => { if (epoch === this.epoch) fail(); }); });
        await new Promise<void>((resolve, reject) => {
          const ready = () => { if (pcm.readableLength >= 48000 || pcm.writableFinished && pcm.readableLength > 0) finish(); };
          const failed = () => finish(new Error("Не удалось получить звук музыкального потока. Проверьте подключение сервиса в Astra Music."));
          const finish = (error?: Error) => {
            clearTimeout(timer); pcm.off("readable", ready); pcm.off("finish", ready); child.off("close", failed); child.off("error", failed);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(failed, 30000);
          pcm.on("readable", ready); pcm.once("finish", ready); child.once("close", failed); child.once("error", failed); ready();
        });
        if (epoch !== this.epoch || this.child !== child) return;
        this.transport.startMusic(pcm, this.selectedVolume ?? this.settings().musicVolume);
        this.trackStartedAt = Date.now(); this.pauseMillis = 0; this.pauseStartedAt = this.paused ? Date.now() : 0;
      }
      this.transport.pauseMusic(this.paused);
    } finally { this.polling = false; finished(); }
  }
}
