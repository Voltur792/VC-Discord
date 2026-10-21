import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";

export function userData(platform: NodeJS.Platform = process.platform, env = process.env, home = homedir()): string {
  if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
}
export const dataDir = process.env.DVOICE_DATA_DIR || join(userData(), "discord-voice-bridge");
export function integrationDir(): string {
  if (process.env.SPT_INTEGRATION_DIR) return process.env.SPT_INTEGRATION_DIR;
  const legacy = join(homedir(), "sleep-pause-timer", "integrations");
  return process.platform !== "win32" && existsSync(legacy) ? legacy : join(userData(), "sleep-pause-timer", "integrations");
}
export function astraConfig(): string {
  if (process.env.ASTRA_CONFIG_DIR) return process.env.ASTRA_CONFIG_DIR;
  if (process.platform === "win32") return join(userData(), "astra", "astra", "config");
  if (process.platform === "darwin") return join(userData(), "com.astra.astra");
  const config = process.env.XDG_CONFIG_HOME;
  return join(config && isAbsolute(config) ? config : join(homedir(), ".config"), "astra");
}
export function astraData(): string {
  if (process.env.ASTRA_DATA_DIR) return process.env.ASTRA_DATA_DIR;
  if (process.platform === "win32") return join(userData(), "astra", "astra", "data");
  if (process.platform === "darwin") return astraConfig();
  return join(userData(), "astra");
}
export function openCommand(target: string): [string, string[]] {
  return process.platform === "win32" ? [join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [target]]
    : process.platform === "darwin" ? ["/usr/bin/open", [target]] : ["xdg-open", [target]];
}
export function pathEntries(): string[] {
  return (process.env.PATH || "").split(delimiter).map(p => p.replace(/^"|"$/g, "")).filter(isAbsolute);
}
