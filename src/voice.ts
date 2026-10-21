import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits, ActivityType, type VoiceState } from "discord.js";
import { AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, EndBehaviorType, StreamType, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type VoiceConnection, type AudioReceiveStream } from "@discordjs/voice";
import type { Readable } from "node:stream";
import { safeError, type Settings } from "./config";
import { networkErrorCode } from "./network-error";
import type { Speaker } from "./access";
import { OpusScript, opusStream, rms } from "./audio";
import { VoiceMixer } from "./mixer";
import type { ModerationAction, VoicePerson, VoiceRoom } from "./moderation";

export class VoiceTransport {
  private client?: Client;
  private connection?: VoiceConnection;
  private player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  private audio?: Readable;
  private mixer?: VoiceMixer;
  private generation = 0;
  private guildId = "";
  private channelId = "";
  private captures = new Map<string, { cancel: () => void }>();
  private membershipVersions = new Map<string, number>();
  private personNumbers = new Map<string, number>();
  private roomNumbers = new Map<string, number>();
  private connecting = false;
  private receiveFailed = false;
  private activity = "";
  private activityAt = 0;
  private activityTimer?: NodeJS.Timeout;
  private pendingActivity?: { name: string; type: ActivityType.Listening | ActivityType.Watching };
  botName = "";
  channelName = "";
  constructor(private getSettings: () => Settings, private onAudio: (speaker: Speaker, pcm: Buffer) => void, private onState: (message: string, error?: boolean, source?: "voice_receive" | "voice_connection") => void, private onInterruption: () => void, private onInvalidate: () => void, private trace: (code: string, error?: boolean) => void = () => {}) {
    this.player.on("error", () => this.onState("Ошибка воспроизведения ответа.", true));
  }
  get connected(): boolean { return this.connection?.state.status === VoiceConnectionStatus.Ready && !!this.client?.isReady(); }
  get recovering(): boolean { return !!this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed && !this.connected; }
  participants(): { id: string; name: string; number: number; allowed: boolean; moderator: boolean }[] {
    const channel = this.client?.channels.cache.get(this.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return [];
    return this.moderationPeople().map(m => ({ id: m.id, name: m.name, number: m.number, allowed: this.getSettings().allowedUserIds.includes(m.id), moderator: this.getSettings().moderatorUserIds.includes(m.id) }));
  }
  moderationPeople(): VoicePerson[] {
    const channel = this.client?.channels.cache.get(this.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return [];
    return [...channel.members.values()].filter(m => !m.user.bot).map(m => {
      if (!this.personNumbers.has(m.id)) this.personNumbers.set(m.id, this.personNumbers.size + 1);
      return { id: m.id, name: m.displayName, username: m.user.username, number: this.personNumbers.get(m.id)!, membershipVersion: this.membershipVersions.get(m.id) ?? 0 };
    }).sort((a, b) => a.number - b.number);
  }
  moderationRooms(): VoiceRoom[] {
    const guild = this.client?.guilds.cache.get(this.guildId), me = guild?.members.me;
    if (!guild || !me) return [];
    return [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildVoice && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])).sort((a, b) => a.id.localeCompare(b.id)).map(c => {
      if (!this.roomNumbers.has(c.id)) this.roomNumbers.set(c.id, this.roomNumbers.size + 1);
      return { id: c.id, name: c.name, number: this.roomNumbers.get(c.id)! };
    }).sort((a, b) => a.number - b.number);
  }
  moderationPermissions(): Record<string, boolean> {
    const guild = this.client?.guilds.cache.get(this.guildId), me = guild?.members.me;
    const channel = guild?.channels.cache.get(this.channelId), permissions = me && channel?.permissionsFor(me);
    return { move: !!permissions?.has(PermissionFlagsBits.MoveMembers), mute: !!permissions?.has(PermissionFlagsBits.MuteMembers), deaf: !!permissions?.has(PermissionFlagsBits.DeafenMembers), kick: !!me?.permissions.has(PermissionFlagsBits.KickMembers) };
  }
  async moderate(action: ModerationAction, person: VoicePerson, destination: VoiceRoom | undefined, allowed: () => boolean): Promise<void> {
    const client = this.client, guild = client?.guilds.cache.get(this.guildId), generation = this.generation;
    const valid = () => this.client === client && generation === this.generation && this.connected && allowed();
    if (!guild || !valid()) throw new Error("Доступ к управлению участниками отозван или соединение изменилось.");
    try {
      const member = await guild.members.fetch({ user: person.id, force: true });
      const me = await guild.members.fetchMe({ force: true });
      const source = await guild.channels.fetch(this.channelId);
      const room = action === "move" && destination ? await guild.channels.fetch(destination.id) : undefined;
      if (!valid()) throw new Error("Команда отменена: доступ или соединение изменились.");
      if (member.user.bot || member.voice.channelId !== this.channelId || person.membershipVersion !== (this.membershipVersions.get(person.id) ?? 0)) throw new Error("Участник вышел или сменил канал. Повторите команду и выбор человека.");
      if (!source || source.type !== ChannelType.GuildVoice) throw new Error("Исходный голосовой канал недоступен.");
      const permissions = source.permissionsFor(me);
      const reason = "VC-Discord: voice command confirmed by an allowed Discord account";
      if (action === "kick") {
        if (!me.permissions.has(PermissionFlagsBits.KickMembers) || !member.kickable) throw new Error("Для исключения нужны права Kick Members и роль бота выше роли участника. Владельца сервера исключить нельзя.");
        await member.kick(reason);
      } else if (action === "move" || action === "disconnect") {
        if (!permissions?.has(PermissionFlagsBits.MoveMembers)) throw new Error("Выдайте боту право Move Members в исходном канале.");
        if (action === "move") {
          if (!room || room.type !== ChannelType.GuildVoice || !room.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])) throw new Error("Для переноса боту нужны View Channel, Connect и Move Members в выбранном канале.");
          if (room.id === this.channelId) throw new Error("Участник уже находится в этом канале.");
          await member.voice.setChannel(room, reason);
        } else await member.voice.disconnect(reason);
      } else if (action === "mute" || action === "unmute") {
        if (!permissions?.has(PermissionFlagsBits.MuteMembers)) throw new Error("Выдайте боту право Mute Members в голосовом канале.");
        await member.voice.setMute(action === "mute", reason);
      } else {
        if (!permissions?.has(PermissionFlagsBits.DeafenMembers)) throw new Error("Выдайте боту право Deafen Members в голосовом канале.");
        await member.voice.setDeaf(action === "deaf", reason);
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? Number(error.code) : NaN;
      if (code === 50013 || code === 50001) throw new Error("Discord отказал в доступе. Проверьте права роли бота, ограничения обоих каналов и положение роли бота.");
      if (error instanceof Error && !Number.isFinite(code) && !/^(?:DiscordAPIError|HTTPError|RateLimitError)/.test(error.name) && !/fetch|socket|connect|timeout/i.test(error.message)) throw error;
      throw new Error("Discord не подтвердил действие. Проверьте состояние участника и соединение перед повтором команды.");
    }
  }
  present(speaker: Speaker): boolean {
    return this.connected && speaker.generation === this.generation && (speaker.membershipVersion ?? 0) === (this.membershipVersions.get(speaker.userId) ?? 0) && speaker.guildId === this.guildId && speaker.channelId === this.channelId && this.participants().some(m => m.id === speaker.userId);
  }
  invalidate(): void {
    this.generation++;
    this.receiveFailed = false;
    for (const capture of [...this.captures.values()]) capture.cancel();
    this.captures.clear(); this.stopMusic(); this.stopPlayback(); this.onInvalidate();
  }
  async connect(): Promise<void> {
    if (this.connecting) throw new Error("Подключение уже выполняется.");
    this.disconnect();
    const s = this.getSettings();
    if (!s.botToken || !s.guildId || !s.channelId) throw new Error("Укажите токен бота, ID сервера и ID голосового канала.");
    this.connecting = true;
    const generation = this.generation;
    this.onState("Подключаем бота к Discord…");
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client = client;
    client.on(Events.Error, error => { if (this.client === client) this.connectionError(error, "gateway"); });
    client.on(Events.ShardDisconnect, event => { if (this.client === client) { this.trace(`VOICE_GATEWAY_DISCONNECTED code=${Number(event.code) || 0}`); this.invalidate(); this.onState("Связь с Discord потеряна; ожидаем восстановления.", true); } });
    client.on(Events.ShardResume, () => { if (this.client === client && this.connected) this.onState("Связь с Discord восстановлена.", false, "voice_connection"); });
    client.on(Events.VoiceStateUpdate, (before, after) => this.voiceStateChanged(client, before, after));
    try {
      await Promise.race([client.login(s.botToken), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("Discord не ответил за 30 секунд.")), 30_000); t.unref(); })]);
      if (generation !== this.generation || this.client !== client) throw new Error("Подключение отменено.");
      const guild = await client.guilds.fetch(s.guildId);
      const channel = await guild.channels.fetch(s.channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error("Выберите обычный голосовой канал сервера Discord.");
      const me = await guild.members.fetchMe();
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new Error("Боту нужны разрешения «Просматривать канал», «Подключаться» и «Говорить».");
      if (generation !== this.generation || this.client !== client) throw new Error("Подключение отменено.");
      this.guildId = guild.id; this.channelId = channel.id;
      this.channelName = channel.name; this.botName = client.user?.username || "Бот";
      const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false, group: "discord-voice-bridge" });
      this.connection = connection;
      connection.on("stateChange", (before, after) => {
        if (this.connection !== connection) return;
        this.trace(`VOICE_CONNECTION_STATE from=${before.status} to=${after.status}${after.status === VoiceConnectionStatus.Disconnected ? ` reason=${Number(after.reason)} close_code=${"closeCode" in after ? Number(after.closeCode) : 0}` : ""}`);
        if (!this.connecting && after.status === VoiceConnectionStatus.Ready && this.connected) this.onState("Голосовая связь Discord восстановлена.", false, "voice_connection");
      });
      connection.subscribe(this.player);
      connection.on("error", error => { if (this.connection === connection) this.connectionError(error); });
      connection.receiver.speaking.on("start", userId => this.capture(userId));
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (this.connection !== connection) return;
        this.invalidate(); this.onState("Голосовая связь потеряна; восстанавливаем соединение…", true);
        Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)])
          .then(() => entersState(connection, VoiceConnectionStatus.Ready, 20_000))
          .then(() => { if (this.connection === connection) this.onState("Бот снова слушает канал.", false, "voice_connection"); })
          .catch(() => { if (this.connection === connection) { this.trace("VOICE_RECOVERY_TIMEOUT"); this.disconnect(); this.onState("Не удалось восстановить голосовое соединение. Нажмите «Войти в канал».", true); } });
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
      if (this.connection !== connection) throw new Error("Подключение отменено.");
      this.musicPresence();
      this.onState("Бот слушает канал.", false, "voice_connection");
    } catch (error) {
      if (this.client === client) this.disconnect();
      throw error;
    } finally { this.connecting = false; }
  }
  private receiveError(message: string): void {
    this.receiveFailed = true;
    this.onState(message, true, "voice_receive");
  }
  private connectionError(error: unknown, origin: "voice" | "gateway" = "voice"): void {
    const raw = error instanceof Error ? error.message : "";
    const kind = networkErrorCode(error) || (/dave|mls|decrypt|key.?package/iu.test(raw) ? "VOICE_ENCRYPTION_ERROR" : /tls|certificate|cert_/iu.test(raw) ? "VOICE_TLS_ERROR" : /udp/iu.test(raw) ? "VOICE_UDP_ERROR" : "VOICE_NETWORK_ERROR");
    const explanations: Record<string, string> = {
      NETWORK_CONNECTION_CLOSED: "Голосовой сервер Discord прервал соединение.",
      NETWORK_TIMEOUT: "Голосовой сервер Discord не ответил вовремя.",
      NETWORK_UNAVAILABLE: "Не удалось связаться с голосовым сервером Discord. Проверьте сеть и VPN.",
      VOICE_ENCRYPTION_ERROR: "Ошибка защищённого голосового соединения Discord (DAVE).",
      VOICE_TLS_ERROR: "Не удалось установить защищённое соединение с сервером Discord.",
      VOICE_UDP_ERROR: "Ошибка передачи звука Discord по сети (UDP).",
      VOICE_NETWORK_ERROR: "Ошибка голосовой сети Discord. Причина записана в журнал плагина.",
    };
    // Keep the original diagnostic, but never gateway credentials, signed URLs,
    // numeric key arrays, addresses or long session/key identifiers.
    const detail = safeError(error, this.getSettings()).replace(/https?:\/\/[^\s]+/giu, "[адрес скрыт]")
      .replace(/((?:token|session_?id|secret_?key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\[[^\]]*\]|[^\s,;]+)/giu, "$1[скрыто]")
      .replace(/\[(?:\s*\d+\s*,){3,}[^\]]*\]/gu, "[ключ скрыт]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[скрыто]").replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/gu, "[сетевой адрес]")
      .replace(/[\r\n\0]/gu, " ").slice(0, 320);
    this.trace(`VOICE_NETWORK_ERROR origin=${origin} kind=${kind} detail=${detail}`, true);
    this.onState(`${explanations[kind]} Код: ${kind}.`, true, "voice_connection");
  }
  private voiceStateChanged(client: Client, before: VoiceState, after: VoiceState): void {
    if (this.client !== client || after.guild.id !== this.guildId) return;
    if (after.id === client.user?.id && this.connection && after.channelId !== this.channelId) {
      this.trace(after.channelId ? "VOICE_BOT_MOVED" : "VOICE_BOT_REMOVED");
      this.disconnect(); this.onState("Бот отключён или перемещён из выбранного канала. Подключите его снова.", true);
    } else if (before.channelId === this.channelId && after.channelId !== this.channelId) {
      this.membershipVersions.set(after.id, (this.membershipVersions.get(after.id) ?? 0) + 1);
      this.captures.get(after.id)?.cancel();
    }
  }
  private capture(userId: string): void {
    const connection = this.connection, settings = this.getSettings();
    if (!connection || !this.connected || this.captures.has(userId) || this.captures.size >= 8 || !this.participants().some(m => m.id === userId)) return;
    if (settings.bargeIn) { this.stopPlayback(); this.onInterruption(); }
    const speaker: Speaker = { userId, guildId: this.guildId, channelId: this.channelId, generation: this.generation, membershipVersion: this.membershipVersions.get(userId) ?? 0 };
    let decoder: OpusScript;
    try { decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP); }
    catch (error) { this.receiveError(`Не удалось создать декодер звука Discord (${codecFailure(error, "OPUS_INIT_FAILED")}). Перезапустите VC-Discord.`); return; }
    const dispose = () => { try { decoder.delete(); } catch {} };
    let stream: AudioReceiveStream;
    try { stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: settings.silenceMs } }); }
    catch { dispose(); this.receiveError("Не удалось начать приём звука Discord. Переподключите бота."); return; }
    const chunks: Buffer[] = []; let bytes = 0, ended = false, discarded = false, badPackets = 0, packets = 0, consecutiveBad = 0;
    const finish = () => {
      if (ended) return; ended = true; clearTimeout(timer); this.captures.delete(userId); dispose();
      if (!discarded && this.present(speaker) && bytes >= 48000 && badPackets <= packets * 0.05) {
        const pcm = Buffer.concat(chunks);
        if (rms(pcm) > 0.003) {
          if (this.receiveFailed) { this.receiveFailed = false; this.onState("Приём речи Discord восстановлен.", false, "voice_receive"); }
          this.onAudio(speaker, pcm);
        }
      }
    };
    const cancel = () => { discarded = true; stream.destroy(); finish(); };
    const timer = setTimeout(() => { this.onState("Длинная реплика пропущена. Произнесите её короче."); cancel(); }, settings.maxUtteranceSecs * 1000 + settings.silenceMs);
    this.captures.set(userId, { cancel });
    stream.on("data", (packet: Buffer) => {
      if (ended || discarded) return;
      packets++;
      try {
        const pcm = decoder.decode(packet); bytes += pcm.length; consecutiveBad = 0;
        if (bytes > settings.maxUtteranceSecs * 48000 * 4) { cancel(); return; }
        chunks.push(pcm);
      } catch (error) {
        badPackets++; consecutiveBad++;
        const message = error instanceof Error ? error.message : "";
        if (/abort|memory access|out of bounds|unreachable|detached|out of memory/i.test(message)) {
          cancel(); this.receiveError(`Декодер звука Discord остановлен после внутренней ошибки (${codecFailure(error, "OPUS_INTERNAL_FAILED")}). Перезапустите VC-Discord.`); return;
        }
        // A single damaged frame must not cancel an otherwise valid utterance.
        if (consecutiveBad >= 4) {
          cancel();
          const code = message.includes("Invalid packet") ? "OPUS_INVALID_PACKET" : message.includes("Buffer too small") ? "OPUS_FRAME_TOO_LONG" : "OPUS_DECODE_FAILED";
          this.receiveError(`Реплика пропущена из-за повреждённого звука Discord (${code}). Бот продолжает слушать; повторите реплику. Если ошибка повторяется, переподключите бота.`);
        }
      }
    });
    stream.on("end", finish); stream.on("close", finish); stream.on("error", () => { if (ended) return; cancel(); this.receiveError("Поток звука Discord прерван. Бот продолжает слушать; повторите реплику. Если ошибка повторяется, переподключите бота."); });
  }
  async play(pcm: Buffer, signal: AbortSignal): Promise<void> {
    if (!this.connected || signal.aborted) return;
    if (this.mixer && !this.mixer.destroyed && !this.mixer.readableEnded) return this.mixer.say(pcm, signal);
    this.stopPlayback();
    const audio = opusStream(pcm); this.audio = audio;
    const resource = createAudioResource(audio, { inputType: StreamType.Opus });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); this.player.off(AudioPlayerStatus.Idle, idle); this.player.off("error", fail); signal.removeEventListener("abort", abort);
        if (this.audio === audio) this.audio = undefined;
        audio.destroy(); error ? reject(error) : resolve();
      };
      const idle = () => finish(); const fail = () => finish(new Error("Не удалось озвучить ответ в Discord."));
      const abort = () => { this.player.stop(true); finish(); };
      const timer = setTimeout(() => { this.player.stop(true); finish(new Error("Воспроизведение ответа остановлено по тайм-ауту.")); }, pcm.length / 192 + 10_000);
      this.player.once(AudioPlayerStatus.Idle, idle); this.player.once("error", fail); signal.addEventListener("abort", abort, { once: true });
      audio.once("error", fail); this.player.play(resource);
    });
  }
  startMusic(pcm: Readable, volume: number): void {
    if (!this.connected) throw new Error("Сначала подключите бота к голосовому каналу.");
    if (!this.mixer || this.mixer.destroyed || this.mixer.readableEnded) {
      this.stopPlayback();
      const mixer = new VoiceMixer(); this.mixer = mixer;
      mixer.on("error", () => this.onState("Ошибка воспроизведения музыки в Discord.", true));
      const idle = () => { this.player.off(AudioPlayerStatus.Idle, idle); mixer.destroy(); if (this.mixer === mixer) this.mixer = undefined; };
      this.player.once(AudioPlayerStatus.Idle, idle);
      mixer.setMusic(pcm); mixer.volume = volume / 100;
      this.player.play(createAudioResource(mixer, { inputType: StreamType.Opus }));
    } else { this.mixer.setMusic(pcm); this.mixer.volume = volume / 100; }
  }
  pauseMusic(paused: boolean): void { this.mixer?.pauseMusic(paused); }
  musicVolume(volume: number): void { if (this.mixer) this.mixer.volume = volume / 100; }
  musicStats(): unknown { return this.mixer?.stats() || { frames: 0, underruns: 0 }; }
  musicPresence(title = "", artist = "", service = "", paused = false): void {
    if (!this.client?.isReady()) return;
    const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const label = title ? `${paused ? "Пауза • " : ""}${this.getSettings().radioEnabled ? "Радиоведущая — Astra • " : ""}${service === "spotify" ? "Spotify" : service === "vk" ? "VK" : "Яндекс Музыка"} • ${clean(artist) ? clean(artist) + " — " : ""}${clean(title)}` : "Голосовой канал • Astra";
    const name = [...label].slice(0, 128).join("");
    this.pendingActivity = { name, type: title && !paused ? ActivityType.Listening : ActivityType.Watching };
    if (this.activityTimer) return;
    const update = () => {
      this.activityTimer = undefined;
      const pending = this.pendingActivity; this.pendingActivity = undefined;
      if (!pending || !this.client?.isReady() || pending.name === this.activity) return;
      this.activityAt = Date.now();
      try { this.client.user.setActivity(pending.name, { type: pending.type }); this.activity = pending.name; }
      catch { this.onState("Не удалось обновить статус песни в Discord."); }
    };
    // Coalesce stop/start and rapid skips within Discord's presence rate limit.
    const delay = Math.max(0, 5000 - (Date.now() - this.activityAt));
    if (delay) { this.activityTimer = setTimeout(update, delay); this.activityTimer.unref(); }
    else update();
  }
  stopMusic(): void { this.mixer?.setMusic(); this.musicPresence(); }
  stopPlayback(): void {
    if (this.mixer && !this.mixer.destroyed) { this.mixer.stopSpeech(); return; }
    this.player.stop(true); this.audio?.destroy(); this.audio = undefined;
  }
  disconnect(): void {
    if (this.connection) this.trace("VOICE_TRANSPORT_CLOSED");
    this.invalidate();
    this.mixer?.destroy(); this.mixer = undefined; this.player.stop(true); this.audio?.destroy(); this.audio = undefined;
    const connection = this.connection; this.connection = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    const client = this.client; this.client = undefined; client?.destroy();
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = undefined; this.pendingActivity = undefined; this.activityAt = 0;
    this.activity = "";
    this.membershipVersions.clear();
    this.personNumbers.clear(); this.roomNumbers.clear();
    this.guildId = ""; this.channelId = ""; this.channelName = ""; this.botName = "";
  }
}

function codecFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/detached/i.test(message)) return "OPUS_HEAP_CHANGED";
  if (/memory|alloc|abort|out of bounds|unreachable/i.test(message)) return "OPUS_MEMORY_FAILED";
  return fallback;
}
