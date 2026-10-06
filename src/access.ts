import type { Settings } from "./config";
export interface Speaker { userId: string; guildId: string; channelId: string; generation: number; membershipVersion?: number }
export type Route = { kind: "public" | "command"; text: string } | { kind: "deny" | "ignore"; text?: string };
function removePrefix(text: string, phrase: string): string | undefined {
  const words = phrase.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ё/gi, "[её]")).join("[\\s,.:;!—–-]+");
  const match = text.match(new RegExp(`^\\s*${words}(?=$|[\\s,.:;!—–-])[\\s,.:;!—–-]*`, "iu"));
  return match ? text.slice(match[0].length).trim() : undefined;
}
export function isDisconnectUtterance(s: Settings, text: string): boolean {
  // Always require a direct address, even when ordinary chat uses all utterances.
  const message = removePrefix(text, s.wakeWord);
  if (message === undefined) return false;
  const phrase = message.toLocaleLowerCase("ru").replace(/ё/g, "е")
    .replace(/[.,!?;:]+$/u, "").trim().replace(/\s+/g, " ");
  return /^(?:выйди из (?:голосового )?канала|отключись от (?:голосового )?канала|покинь (?:голосовой )?канал|отключись от дискорда)$/u.test(phrase);
}
export function authorized(s: Settings, speaker: Speaker): boolean {
  return s.commandsEnabled && /^\d{17,20}$/.test(speaker.userId) && s.allowedUserIds.includes(speaker.userId) && speaker.guildId === s.guildId && speaker.channelId === s.channelId;
}
export function routeUtterance(s: Settings, speaker: Speaker, text: string): Route {
  if (!/^\d{17,20}$/.test(speaker.userId) || speaker.guildId !== s.guildId || speaker.channelId !== s.channelId || !text.trim()) return { kind: "ignore" };
  const command = removePrefix(text, s.commandPhrase);
  if (command !== undefined) {
    if (!authorized(s, speaker)) return { kind: "deny", text: "У этого аккаунта нет доступа к управлению компьютером." };
    if (!command) return { kind: "deny", text: "Произнесите команду после слов «" + s.commandPhrase + "»." };
    return { kind: "command", text: command.slice(0, 4000) };
  }
  if (s.addressMode === "name") {
    const message = removePrefix(text, s.wakeWord);
    return message === undefined || !message ? { kind: "ignore" } : { kind: "public", text: message.slice(0, 4000) };
  }
  return { kind: "public", text: text.slice(0, 4000) };
}
export class CommandGate {
  constructor(private settings: () => Settings, private present: (speaker: Speaker) => boolean, private send: (text: string) => Promise<string>) {}
  async execute(speaker: Speaker, command: string): Promise<string> {
    if (!this.present(speaker) || !authorized(this.settings(), speaker)) throw new Error("Доступ к управлению ПК отозван или участник вышел из канала.");
    if (!command.trim()) throw new Error("Пустая команда.");
    return this.send(`[Discord: authorized account ${speaker.userId}]\nЗапрос владельца на управление ПК: ${command}`);
  }
}
