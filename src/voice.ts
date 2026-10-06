import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from "discord.js";
import { AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, EndBehaviorType, StreamType, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type VoiceConnection, type AudioReceiveStream } from "@discordjs/voice";
import type { Readable } from "node:stream";
import type { Settings } from "./config";
import type { Speaker } from "./access";
import { OpusScript, opusStream, rms } from "./audio";
import { VoiceMixer } from "./mixer";

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
  private connecting = false;
  botName = "";
  channelName = "";
  constructor(private getSettings: () => Settings, private onAudio: (speaker: Speaker, pcm: Buffer) => void, private onState: (message: string, error?: boolean) => void, private onInterruption: () => void, private onInvalidate: () => void) {
    this.player.on("error", () => this.onState("Ошибка воспроизведения ответа.", true));
  }
  get connected(): boolean { return this.connection?.state.status === VoiceConnectionStatus.Ready && !!this.client?.isReady(); }
  participants(): { id: string; name: string; allowed: boolean }[] {
    const channel = this.client?.channels.cache.get(this.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return [];
    return [...channel.members.values()].filter(m => !m.user.bot).map(m => ({ id: m.id, name: m.displayName, allowed: this.getSettings().allowedUserIds.includes(m.id) }));
  }
  present(speaker: Speaker): boolean {
    return this.connected && speaker.generation === this.generation && (speaker.membershipVersion ?? 0) === (this.membershipVersions.get(speaker.userId) ?? 0) && speaker.guildId === this.guildId && speaker.channelId === this.channelId && this.participants().some(m => m.id === speaker.userId);
  }
  invalidate(): void {
    this.generation++;
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
    client.on(Events.Error, () => this.onState("Discord сообщил об ошибке соединения.", true));
    client.on(Events.ShardDisconnect, () => { if (this.client === client) { this.invalidate(); this.onState("Связь с Discord потеряна; ожидаем восстановления.", true); } });
    client.on(Events.VoiceStateUpdate, (before, after) => {
      if (this.client !== client) return;
      if (after.id === client.user?.id && this.connection && after.channelId !== this.channelId) {
        this.disconnect(); this.onState("Бот отключён или перемещён из выбранного канала. Подключите его снова.", true);
      } else if (before.channelId === this.channelId && after.channelId !== this.channelId) {
        this.membershipVersions.set(after.id, (this.membershipVersions.get(after.id) ?? 0) + 1);
        this.captures.get(after.id)?.cancel();
      }
    });
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
      connection.subscribe(this.player);
      connection.on("error", () => this.onState("Ошибка голосового соединения Discord.", true));
      connection.receiver.speaking.on("start", userId => this.capture(userId));
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (this.connection !== connection) return;
        this.invalidate(); this.onState("Голосовая связь потеряна; восстанавливаем соединение…", true);
        Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)])
          .then(() => entersState(connection, VoiceConnectionStatus.Ready, 20_000))
          .then(() => { if (this.connection === connection) this.onState("Бот снова слушает канал."); })
          .catch(() => { if (this.connection === connection) { this.disconnect(); this.onState("Не удалось восстановить голосовое соединение. Нажмите «Войти в канал».", true); } });
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
      if (this.connection !== connection) throw new Error("Подключение отменено.");
      this.onState("Бот слушает канал.");
    } catch (error) {
      if (this.client === client) this.disconnect();
      throw error;
    } finally { this.connecting = false; }
  }
  private capture(userId: string): void {
    const connection = this.connection, settings = this.getSettings();
    if (!connection || !this.connected || this.captures.has(userId) || this.captures.size >= 8 || !this.participants().some(m => m.id === userId)) return;
    if (settings.bargeIn) { this.stopPlayback(); this.onInterruption(); }
    const speaker: Speaker = { userId, guildId: this.guildId, channelId: this.channelId, generation: this.generation, membershipVersion: this.membershipVersions.get(userId) ?? 0 };
    let decoder: OpusScript;
    try { decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP); }
    catch { this.onState("Не удалось создать декодер звука Discord. Перезапустите VC-Discord.", true); return; }
    const dispose = () => { try { decoder.delete(); } catch {} };
    let stream: AudioReceiveStream;
    try { stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: settings.silenceMs } }); }
    catch { dispose(); this.onState("Не удалось начать приём звука Discord. Переподключите бота.", true); return; }
    const chunks: Buffer[] = []; let bytes = 0, ended = false, discarded = false, badPackets = 0, packets = 0, consecutiveBad = 0;
    const finish = () => {
      if (ended) return; ended = true; clearTimeout(timer); this.captures.delete(userId); dispose();
      if (!discarded && this.present(speaker) && bytes >= 48000 && badPackets <= packets * 0.05) {
        const pcm = Buffer.concat(chunks);
        if (rms(pcm) > 0.003) this.onAudio(speaker, pcm);
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
        if (/abort|memory access|out of bounds|unreachable/i.test(message)) {
          cancel(); this.onState("Декодер звука Discord остановлен после внутренней ошибки. Перезапустите VC-Discord.", true); return;
        }
        // A single damaged frame must not cancel an otherwise valid utterance.
        if (consecutiveBad >= 4) {
          cancel();
          const code = message.includes("Invalid packet") ? "OPUS_INVALID_PACKET" : message.includes("Buffer too small") ? "OPUS_FRAME_TOO_LONG" : "OPUS_DECODE_FAILED";
          this.onState(`Не удалось разобрать звук Discord (${code}). Переподключите бота к каналу.`, true);
        }
      }
    });
    stream.on("end", finish); stream.on("close", finish); stream.on("error", () => { cancel(); this.onState("Поток звука Discord прерван. Переподключите бота к каналу.", true); });
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
  stopMusic(): void { this.mixer?.setMusic(); }
  stopPlayback(): void {
    if (this.mixer && !this.mixer.destroyed) { this.mixer.stopSpeech(); return; }
    this.player.stop(true); this.audio?.destroy(); this.audio = undefined;
  }
  disconnect(): void {
    this.invalidate();
    this.mixer?.destroy(); this.mixer = undefined; this.player.stop(true); this.audio?.destroy(); this.audio = undefined;
    const connection = this.connection; this.connection = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    const client = this.client; this.client = undefined; client?.destroy();
    this.membershipVersions.clear();
    this.guildId = ""; this.channelId = ""; this.channelName = ""; this.botName = "";
  }
}
