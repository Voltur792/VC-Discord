import { safeError, type Settings } from "./config";
import { removePrefix, type Speaker } from "./access";
import type { VoiceTransport } from "./voice";

export type ModerationAction = "mute" | "unmute" | "deaf" | "undeaf" | "move" | "disconnect" | "kick";
export interface VoicePerson { id: string; name: string; username: string; number: number; membershipVersion: number }
export interface VoiceRoom { id: string; name: string; number: number }
interface Pending {
  speaker: Speaker; action: ModerationAction; people: VoicePerson[];
  destination?: VoiceRoom; expiresAt: number;
}
export const actionNames: Record<ModerationAction, string> = {
  mute: "выключить микрофон на сервере", unmute: "снять серверный мут микрофона",
  deaf: "выключить звук на сервере", undeaf: "снять серверное отключение звука",
  move: "переместить", disconnect: "отключить от голосового канала", kick: "исключить с сервера",
};
export function voiceName(text: string): string {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function aliases(text: string, id: string): string[] {
  return text.split(/\r?\n/).flatMap(line => {
    const [key, names] = line.split("=");
    return key?.trim() === id ? (names || "").split(",").map(voiceName).filter(Boolean) : [];
  });
}
function number(text: string): number | undefined {
  if (/^\d{1,3}$/.test(text)) return Number(text);
  const small: Record<string, number> = { один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19 };
  const tens: Record<string, number> = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90 };
  if (Object.hasOwn(small, text)) return small[text];
  if (Object.hasOwn(tens, text)) return tens[text];
  const [a, b, extra] = text.split(" ");
  return !extra && Object.hasOwn(tens, a) && Object.hasOwn(small, b) && small[b] < 10 ? tens[a] + small[b] : undefined;
}
function matches<T extends { id: string; name: string; number: number }>(items: T[], query: string, kind: "участник" | "канал", names: string): T[] {
  const normalized = kind === "канал" ? voiceName(query).replace(/^голосовой /u, "") : voiceName(query);
  const numbered = normalized.match(kind === "участник" ? /^участник(?:а)? (?:номер )?(.+)$/u : /^канал (?:номер )?(.+)$/u);
  if (numbered && number(numbered[1]) !== undefined) return items.filter(item => item.number === number(numbered[1]));
  const queries = [normalized, ...(numbered ? [numbered[1]] : [])];
  return items.filter(item => item.id === query.trim() || [voiceName(item.name), ...aliases(names, item.id), ...("username" in item ? [voiceName(String(item.username))] : [])].some(name => queries.includes(name)));
}
function personLabel(person: VoicePerson): string {
  return `участник ${person.number}: ${person.name.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 80)}`;
}

/** Voice requests are parsed locally; a language model never selects a moderation target. */
export class VoiceModeration {
  private pending = new Map<string, Pending>();
  constructor(private settings: () => Settings, private transport: VoiceTransport, private saving: () => boolean, private note: (text: string, error?: boolean) => void) {}
  clear(): void { this.pending.clear(); }
  state(): { pending: { userId: string; action: string; people: { id: string; name: string; number: number }[]; destination: string; expiresAt: number }[]; rooms: VoiceRoom[]; permissions: Record<string, boolean> } {
    this.prune();
    return { pending: [...this.pending.values()].map(p => ({ userId: p.speaker.userId, action: actionNames[p.action], people: p.people.map(({ id, name, number }) => ({ id, name, number })), destination: p.destination?.name || "", expiresAt: p.expiresAt })), rooms: this.transport.moderationRooms(), permissions: this.transport.moderationPermissions() };
  }
  private allowed(speaker: Speaker): boolean {
    const s = this.settings();
    return !this.saving() && s.moderationEnabled && s.moderatorUserIds.includes(speaker.userId) && this.transport.present(speaker);
  }
  private prune(): void {
    for (const [id, request] of this.pending) if (request.expiresAt <= Date.now() || !this.allowed(request.speaker)) this.pending.delete(id);
  }
  async voice(speaker: Speaker, text: string, signal: AbortSignal): Promise<string | undefined> {
    const addressed = removePrefix(text, this.settings().wakeWord);
    if (addressed === undefined) return;
    const message = voiceName(addressed);
    const confirm = message.match(/^подтверди участника (?:номер )?(.+)$/u);
    const choose = message.match(/^выбери участника (?:номер )?(.+)$/u);
    const cancel = /^(?:отмени|отмени управление|отмени команду|отмена)$/u.test(message);
    const listing = /^(?:назови|покажи|список)(?: список)? (?:участников|каналов)$/u.test(message);
    const commands: [RegExp, ModerationAction][] = [
      [/^(?:сними мут(?: с)?|размуть|размутить|включи микрофон) (.+)$/u, "unmute"],
      [/^(?:замуть|замутить|выключи микрофон|отключи микрофон) (.+)$/u, "mute"],
      [/^(?:верни звук|включи звук|сними отключение звука с) (.+)$/u, "undeaf"],
      [/^(?:заглуши|выключи звук|отключи звук) (.+)$/u, "deaf"],
      [/^(?:перемести|перенеси) (.+)$/u, "move"],
      [/^(?:кикни|исключи|удали) (.+) с сервера$/u, "kick"],
      [/^(?:отключи|кикни|выгони) (.+?) (?:из|от) (?:голосового )?канала$/u, "disconnect"],
      [/^(?:кикни|выгони) (.+)$/u, "disconnect"],
    ];
    let command: { action: ModerationAction; target: string } | undefined;
    for (const [pattern, action] of commands) { const m = message.match(pattern); if (m) { command = { action, target: m[1] }; break; } }
    if (!command && !confirm && !choose && !listing && !(cancel && this.pending.has(speaker.userId))) return;
    this.prune();
    if (!this.allowed(speaker)) return "У этого аккаунта нет доступа к управлению участниками. Проверьте вкладку Участники.";
    signal.throwIfAborted();
    if (cancel) { this.pending.delete(speaker.userId); return "Управление участником отменено."; }
    if (listing) {
      const items = message.endsWith("каналов") ? this.transport.moderationRooms().map(r => `канал ${r.number}: ${r.name}`) : this.transport.moderationPeople().map(personLabel);
      return items.length ? items.slice(0, 12).join(". ") + (items.length > 12 ? ". Полный список во вкладке Участники." : ".") : "Список пуст. Подключите бота к голосовому каналу.";
    }
    if (confirm || choose) {
      const request = this.pending.get(speaker.userId);
      if (!request) return "Нет ожидающей команды. Повторите действие и имя участника.";
      const selected = request.people.find(person => person.number === number((confirm || choose)![1]));
      if (!selected) return "Этот номер не относится к ожидающей команде. Назовите номер из предложенного списка или отмените команду.";
      if (choose) {
        request.people = [selected]; request.expiresAt = Date.now() + 60_000;
        return `Выбран ${personLabel(selected)}. Действие: ${actionNames[request.action]}${request.destination ? ` в канал ${request.destination.number}: ${request.destination.name}` : ""}. Для выполнения скажите: ${this.settings().wakeWord}, подтверди участника ${selected.number}.`;
      }
      if (request.people.length !== 1) return `Сначала выберите человека: ${this.settings().wakeWord}, выбери участника ${selected.number}. Я повторю имя и действие, затем попрошу подтверждение.`;
      // Consume before the API call: repeating a confirmation cannot repeat a mutation.
      this.pending.delete(speaker.userId);
      const destination = request.destination;
      try { await this.transport.moderate(request.action, selected, destination, () => !signal.aborted && this.allowed(request.speaker)); }
      catch (error) { const message = safeError(error, this.settings()); this.note(message, true); return message; }
      const done = `${actionNames[request.action]} — ${personLabel(selected)}${destination ? `, канал ${destination.number}: ${destination.name}` : ""}`;
      this.note(`Управление участником выполнено: ${done}.`);
      return `Готово: ${done}.`;
    }
    if (!command) return;
    this.pending.delete(speaker.userId);
    let destination: VoiceRoom | undefined;
    let target = command.target;
    if (command.action === "move") {
      const parts = target.match(/^(.+?) в (.+)$/u);
      if (!parts) return "Скажите: перемести участника два в канал три. Номера видны во вкладке Участники.";
      target = parts[1];
      const rooms = matches(this.transport.moderationRooms(), parts[2], "канал", this.settings().moderationChannelAliases);
      if (rooms.length !== 1) return "Канал не определён однозначно. Повторите команду с номером канала из вкладки Участники или скажите: назови каналы.";
      destination = rooms[0];
    }
    const available = this.transport.moderationPeople();
    const resolved = target === "меня" ? available.filter(person => person.id === speaker.userId) : matches(available, target, "участник", this.settings().moderationUserAliases);
    const people = resolved.length ? resolved : available;
    if (!people.length) return "В канале нет доступных участников.";
    if (this.pending.size >= 8) return "Слишком много ожидающих команд. Повторите через минуту.";
    this.pending.set(speaker.userId, { speaker: { ...speaker }, action: command.action, people: people.map(p => ({ ...p })), destination: destination ? { ...destination } : undefined, expiresAt: Date.now() + 60_000 });
    const action = actionNames[command.action] + (destination ? ` в канал ${destination.number}: ${destination.name}` : "");
    const choices = people.slice(0, 8).map(personLabel).join(". ");
    const confirmation = people.length === 1 ? `подтверди участника ${people[0].number}` : "выбери участника и нужный номер, например выбери участника " + people[0].number;
    return `${resolved.length === 1 ? "Найден" : resolved.length ? "Имя неоднозначно, выберите участника" : "Имя не совпало, выберите участника"}: ${choices}. Действие: ${action}. ${people.length > 8 ? "Полный список во вкладке Участники. " : ""}Для выполнения в течение минуты скажите: ${this.settings().wakeWord}, ${confirmation}. Или: ${this.settings().wakeWord}, отмени команду.`;
  }
}
