import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits, type ClientOptions } from "discord.js";
import { textSetupIssue, type Settings } from "./config";
import { TextRoom, type RoomMessage } from "./text-room";

/** A separate gateway session keeps text available while voice is disconnected. */
export class TextDiscord {
  private client?: Client;
  private generation = 0;
  private status = "Текстовый канал выключен";
  constructor(private settings: () => Settings, readonly room: TextRoom, private error: (error: unknown) => void, private createClient: (options: ClientOptions) => Client = options => new Client(options)) {}
  state(): Record<string, unknown> { return { online: !!this.client?.isReady(), status: this.status, ...this.room.state() }; }
  stop(): void { this.generation++; this.room.reset(); this.client?.destroy(); this.client = undefined; this.status = "Текстовый канал выключен"; }
  async start(): Promise<void> {
    this.stop();
    const s = this.settings();
    if (!s.textEnabled) return;
    const issue = textSetupIssue(s);
    if (issue) { this.status = issue; return; }
    const generation = this.generation;
    this.status = "Подключение к текстовому каналу…";
    const client = this.createClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });
    this.client = client;
    client.on(Events.Error, () => { if (this.client === client) this.error(new Error("Ошибка текстового соединения Discord.")); });
    client.on(Events.ShardDisconnect, () => { if (this.client === client) { this.room.reset(); this.status = "Текстовое соединение восстанавливается…"; } });
    client.on(Events.ShardResume, () => { if (this.client === client) this.status = "Текстовый канал подключён"; });
    client.on(Events.MessageCreate, message => {
      const selected = this.settings();
      if (this.client !== client || !selected.textEnabled || message.author.bot || message.webhookId || message.system || message.guildId !== selected.guildId || message.channelId !== selected.textChannelId) return;
      void (async () => {
        let replyToBot = false, replyToOther = false;
        if (message.reference?.messageId && message.reference.channelId === message.channelId) {
          try { const parent = await message.fetchReference(); replyToBot = parent.author.id === client.user?.id; replyToOther = !replyToBot; } catch { replyToOther = true; }
        }
        if (this.client !== client) return;
        const botId = client.user!.id;
        await this.room.receive({
          id: message.id, userId: message.author.id, guildId: message.guildId!, channelId: message.channelId,
          content: message.content.replace(new RegExp(`^\\s*<@!?${botId}>[\\s,.:;!—–-]*`, "u"), ""),
          mentioned: message.mentions.users.has(botId), replyToBot, replyToOther,
          mentionsOther: message.mentions.users.some(user => user.id !== botId),
          typing: async () => { if ("sendTyping" in message.channel) await message.channel.sendTyping(); },
          reply: async content => {
            if (this.client !== client || !this.settings().textEnabled) throw new Error("Текстовый канал отключён.");
            const sent = await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
            return sent.id;
          },
        });
      })().catch(error => { if (this.client === client) this.error(error); });
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const ready = new Promise<void>((resolve, reject) => {
        client.once(Events.ClientReady, () => resolve());
        timer = setTimeout(() => reject(new Error("Discord не подключил текстовый канал за 30 секунд. Проверьте токен и включите Message Content Intent в Developer Portal → Bot.")), 30000);
      });
      await Promise.all([client.login(s.botToken), ready]);
      if (generation !== this.generation || this.client !== client) return;
      const channel = await client.channels.fetch(s.textChannelId);
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || !("guild" in channel) || channel.guild.id !== s.guildId) throw new Error("Выберите текстовый канал выбранного сервера Discord.");
      const me = await channel.guild.members.fetchMe();
      if (!("permissionsFor" in channel) || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) throw new Error("В текстовом канале боту нужны View Channel, Send Messages и Read Message History.");
      if (generation === this.generation && this.client === client) this.status = "Текстовый канал подключён";
    } catch (error) {
      if (this.client === client) { this.stop(); this.status = "Не удалось подключить текстовый канал. Проверьте права и Message Content Intent."; }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async voiceChannelFor(message: RoomMessage): Promise<{ id: string; name: string }> {
    const s = this.settings(), client = this.client;
    if (!client?.isReady() || !s.textEnabled || !s.textSummonEnabled || message.guildId !== s.guildId || message.channelId !== s.textChannelId) throw new Error("Призыв в голосовой канал выключен.");
    const guild = await client.guilds.fetch(s.guildId);
    const member = await guild.members.fetch({ user: message.userId, force: true });
    const channel = member.voice.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error("Сначала войдите в обычный голосовой канал этого сервера, затем напишите «Астра, зайди ко мне».");
    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new Error("В вашем голосовом канале боту нужны View Channel, Connect и Speak.");
    if (this.client !== client || !this.settings().textSummonEnabled) throw new Error("Призыв отменён.");
    return { id: channel.id, name: channel.name };
  }
  async announce(content: string, allowed: () => boolean): Promise<boolean> {
    const client = this.client, settings = this.settings();
    const valid = () => allowed() && this.client === client && this.settings().textEnabled && this.settings().guildId === settings.guildId && this.settings().textChannelId === settings.textChannelId;
    if (!client || !valid()) return false;
    if (!client.isReady()) await new Promise<void>(resolve => {
      const ready = () => { clearTimeout(timer); client.off(Events.ClientReady, ready); resolve(); };
      const timer = setTimeout(ready, 30000); timer.unref();
      client.once(Events.ClientReady, ready);
    });
    if (!valid()) return false;
    if (!client.isReady()) throw new Error("Не удалось отправить сообщение о смене: текстовый канал Discord ещё не подключён. Эфир продолжается.");
    const channel = await client.channels.fetch(settings.textChannelId);
    if (!valid()) return false;
    if (!channel || channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement || channel.guild.id !== settings.guildId) throw new Error("Не удалось отправить сообщение о смене: проверьте выбранный текстовый канал. Эфир продолжается.");
    await channel.send({ content: content.slice(0, 1900), allowedMentions: { parse: [], repliedUser: false } });
    return true;
  }
}
