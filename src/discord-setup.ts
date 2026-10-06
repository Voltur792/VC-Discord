import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, OAuth2Scopes } from "discord.js";
import type { Settings } from "./config";

export async function discoverDiscord(s: Settings): Promise<Record<string, any>> {
  if (!s.botToken) throw new Error("Сначала вставьте токен созданного бота в настройки плагина.");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.login(s.botToken), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Discord не ответил за 30 секунд.")), 30000); })]);
    if (!client.application) throw new Error("Discord не предоставил сведения о приложении бота. Повторите поиск.");
    const application = await client.application.fetch();
    if (application.botRequireCodeGrant) throw new Error("У бота включён Requires OAuth2 Code Grant. Откройте Discord Developer Portal → ваше приложение → Bot → Authorization Flow, выключите этот переключатель и нажмите Save Changes. Затем повторите поиск.");
    const inviteUrl = client.generateInvite({ scopes: [OAuth2Scopes.Bot], permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
    const guilds = [...client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name }));
    const selected = guilds.find(g => g.id === s.guildId) || (guilds.length === 1 ? guilds[0] : undefined);
    const channels: { id: string; name: string }[] = [];
    if (selected) {
      const guild = await client.guilds.fetch(selected.id), me = await guild.members.fetchMe();
      const collection = await guild.channels.fetch();
      for (const channel of collection.values()) if (channel?.type === ChannelType.GuildVoice && channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) channels.push({ id: channel.id, name: channel.name });
    }
    return { inviteUrl, guilds, channels, guildId: selected?.id || "", channelId: channels.some(c => c.id === s.channelId) ? s.channelId : channels.length === 1 ? channels[0].id : "" };
  } finally { clearTimeout(timer); client.destroy(); }
}
