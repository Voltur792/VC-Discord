export interface RadioShift {
  run_id: string; shift_id: string; name: string; ends_at: number;
  guild_id: string; channel_id: string;
  music: { service: "vk" | "yandex" | "spotify"; mode: "playlist" | "wave" | "library"; playlist_id: string };
  every: number; when: "start" | "end"; announce_next: boolean; skip_empty: boolean;
}
export function validateRadioShift(value: unknown, now = Date.now()): RadioShift {
  const r = value as any;
  if (!r || !/^[a-f0-9]{32}$/.test(r.run_id) || !/^[a-f0-9]{32}$/.test(r.shift_id)) throw new Error("Некорректный идентификатор смены.");
  if (!/^\d{17,20}$/.test(r.guild_id) || !/^\d{17,20}$/.test(r.channel_id)) throw new Error("Укажите ID сервера и голосового канала Discord.");
  if (typeof r.ends_at !== "number" || !Number.isFinite(r.ends_at) || r.ends_at * 1000 <= now || r.ends_at * 1000 > now + 86400000) throw new Error("Окончание смены должно быть в ближайшие 24 часа.");
  const m = r.music;
  const modes: Record<string, string[]> = { yandex: ["wave", "playlist"], vk: ["library", "playlist"], spotify: ["wave", "playlist"] };
  if (!m || !modes[m.service]?.includes(m.mode)) throw new Error("Выберите плейлист, волну Яндекса, треки VK или микс Spotify.");
  const playlist = typeof m.playlist_id === "string" ? m.playlist_id.trim() : "";
  if (m.mode === "playlist" && (!playlist || playlist.length > 300 || /[\r\n\0]/.test(playlist))) throw new Error("Выберите плейлист.");
  return { run_id: r.run_id, shift_id: r.shift_id, name: typeof r.name === "string" ? r.name.slice(0,100) : "Радиоэфир", ends_at: r.ends_at,
    guild_id: r.guild_id, channel_id: r.channel_id, music: { service: m.service, mode: m.mode, playlist_id: m.mode === "playlist" ? playlist : "" },
    every: [1,3,5].includes(r.every) ? r.every : 3, when: r.when === "start" ? "start" : "end", announce_next: r.announce_next !== false, skip_empty: r.skip_empty !== false };
}

/** Own only the scheduled connection, so a late stop cannot end another session. */
export class RadioShiftSession {
  active?: RadioShift;
  private starting = false;
  private timer?: NodeJS.Timeout;
  private message = "";
  constructor(private allowed: () => boolean, private connected: () => boolean,
    private begin: (shift: RadioShift, valid: () => boolean) => Promise<void>, private end: () => void,
    private now: () => number = Date.now) {}
  state(): Record<string, unknown> { return { allowed: this.allowed(), active: this.active ? { ...this.active, phase: this.starting ? "starting" : "playing" } : null, message: this.message }; }
  async start(value: unknown): Promise<Record<string, unknown>> {
    const shift = validateRadioShift(value, this.now());
    if (!this.allowed()) throw new Error("Разрешите автоматические эфиры в разделе «Музыка» Discord-плагина.");
    if (this.active?.run_id === shift.run_id) return this.state();
    if (this.active || this.starting || this.connected()) throw new Error("Бот уже занят: автоматический эфир не прерывает текущий канал или другую смену.");
    this.active = shift; this.starting = true; this.message = "Подключение к запланированному эфиру…";
    const valid = () => this.active === shift && this.allowed() && this.now() < shift.ends_at * 1000;
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
    try {
      await this.begin(shift, valid);
      if (!valid()) { this.stop(shift.run_id); return { ...this.state(), cancelled: true }; }
      this.message = "Радиоведущая на смене";
      return this.state();
    } catch (error) {
      if (this.active === shift) { this.stop(shift.run_id); this.message = error instanceof Error ? error.message : "Не удалось начать эфир."; }
      throw error;
    } finally { this.starting = false; }
  }
  stop(runId?: string): { ok: true; stopped: boolean } {
    if (!this.active || runId && runId !== this.active.run_id) return { ok: true, stopped: false };
    this.active = undefined;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.message = "Смена завершена"; this.end();
    return { ok: true, stopped: true };
  }
  tick(): void {
    if (!this.active) return;
    if (!this.allowed() || this.now() >= this.active.ends_at * 1000) { this.stop(); return; }
    if (!this.starting && !this.connected()) { this.stop(); this.message = "Эфир прерван: бот отключён от канала."; }
  }
}
