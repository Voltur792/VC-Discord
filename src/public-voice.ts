import type { Settings } from "./config";

/** Applies only to a connection created by a public summon, never a radio shift. */
export class PublicVoiceExit {
  private channelId = "";
  private emptySince?: number;
  private delay = 0;
  constructor(private now = Date.now) {}
  start(channelId: string): void { this.channelId = channelId; this.emptySince = undefined; this.delay = 0; }
  stop(): void { this.start(""); }
  tick(settings: Settings, voice: { channelId: string; connected: boolean; radio: boolean; listeners: number }): boolean {
    const delay = settings.publicVoiceEmptySeconds * 1000;
    if (delay !== this.delay) { this.delay = delay; this.emptySince = undefined; }
    if (!this.channelId || this.channelId !== voice.channelId || !voice.connected || voice.radio || !settings.publicVoiceAutoLeaveEnabled || voice.listeners > 0) { this.emptySince = undefined; return false; }
    this.emptySince ??= this.now();
    return this.now() - this.emptySince >= delay;
  }
}
