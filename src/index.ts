/**
 * Discord Voice Bridge — an Astra plugin.
 *
 * The plugin is a VALUE, exported from this module, and it starts only when
 * this file is the process entrypoint. That is what lets `test/plugin.test.mjs`
 * drive it in-process, with no daemon and no socket.
 */

import { plugin, UiContrib, type PluginContext } from "astra-plugin-sdk";
import { VoiceBridge } from "./bridge";
import { tabIcon } from "./tab-icon";

const bridge = new VoiceBridge();
const call = (operation: (value: unknown) => unknown, name = "ui") => async (value: unknown, ctx: PluginContext) => {
  void ctx.log("info", `Discord voice UI action started: ${name}`).catch(() => {});
  try { const result = await operation(value); void ctx.log("info", `Discord voice UI action completed: ${name}`).catch(() => {}); return result; }
  catch (error) { bridge.recordError(error, name); return { ok: false, error: bridge.errorMessage(error) }; }
};

export const app = plugin({
  onStart: ctx => bridge.init(ctx),
  onShutdown: () => bridge.shutdown(),
  ui: {
    contributions: [{ ...UiContrib.page("vc-discord", "VC-Discord", "web/index.html", { iconSvg: tabIcon }), transparent: true }],
    onCall: {
      // The SDK reserves a top-level `error` on object results for transport errors.
      // Explicit JSON keeps our status/error fields together with the settings.
      state: async () => JSON.stringify(await bridge.stateForUi()),
      model_connections: call(() => bridge.modelConnections()),
      diagnose: call(() => bridge.diagnose(), "diagnose"),
      diagnostic_report: call(() => bridge.diagnosticReport(), "diagnostic_report"),
      music_current: call(() => bridge.musicCurrent(), "music_current"),
      music_search: call(value => bridge.musicSearch(value), "music_search"),
      music_playlists: call(value => bridge.musicPlaylists(value), "music_playlists"),
      music_next: call(value => bridge.musicNext(value), "music_next"),
      music_play: call(value => bridge.musicPlay(value), "music_play"),
      music_pause: call(() => bridge.musicPause(), "music_pause"),
      music_stop: call(() => bridge.musicStop(), "music_stop"),
      music_volume: call(value => bridge.musicVolume(value), "music_volume"),
      setup_music: call(() => bridge.setupMusic(), "setup_music"),
      save: call(value => bridge.save(value), "save"),
      connect: call(() => bridge.connect(), "connect"),
      disconnect: call(() => bridge.disconnect()),
      stop: call(() => bridge.stopSpeech()),
      clear_history: call(() => bridge.clearHistory()),
      approve: call(value => bridge.approve(value)),
      reject: call(value => bridge.reject(value)),
      models: call(value => bridge.models(value), "models"),
      voices: call(() => bridge.voices(), "voices"),
      use_astra_voice: call(() => bridge.useAstraVoice()),
      find_voice_runtime: call(() => bridge.findVoiceRuntime(), "find_voice_runtime"),
      setup_voice: call(() => bridge.setupVoice(), "setup_voice"),
      import_custom_voice: call(value => bridge.importCustomVoice(value), "import_custom_voice"),
      use_astra_recognition: call(() => bridge.useAstraRecognition()),
      use_astra_chat_model: call(() => bridge.useAstraChatModel()),
      setup_whisper: call(() => bridge.setupWhisper(), "setup_whisper"),
      discover_discord: call(() => bridge.discoverDiscord()),
      test_voice: call(() => bridge.testVoice(), "test_voice"),
      setup_local: call(() => bridge.setupLocal(), "setup_local"),
      prepare_screen: call(() => bridge.prepareScreen()),
      preview_screen: call(() => bridge.previewScreen()),
      start_screen: call(() => bridge.startScreen()),
      stop_screen: call(() => bridge.stopScreen()),
    },
  },
});

// `astra-plugin build` bundles this to CommonJS, so `require.main` is the
// honest "am I the entrypoint" test. Importing this module — as the test does —
// does not start a server.
export { CommandGate, authorized, routeUtterance } from "./access";
export { defaults, normalizeSettings, publicSettings, validateSettings, SettingsStore } from "./config";
export { wav, fromWav, resample, rms, opusStream, OpusScript } from "./audio";
export { publicChat, Providers } from "./providers";
if (require.main === module) app.run();
