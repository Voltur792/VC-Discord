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
const call = (operation: (value: unknown) => unknown) => async (value: unknown, ctx: PluginContext) => {
  void ctx.log("info", "Discord voice UI action started").catch(() => {});
  try { const result = await operation(value); void ctx.log("info", "Discord voice UI action completed").catch(() => {}); return result; }
  catch (error) { return { ok: false, error: bridge.errorMessage(error) }; }
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
      music_current: call(() => bridge.musicCurrent()),
      music_search: call(value => bridge.musicSearch(value)),
      music_playlists: call(value => bridge.musicPlaylists(value)),
      music_next: call(value => bridge.musicNext(value)),
      music_play: call(value => bridge.musicPlay(value)),
      music_pause: call(() => bridge.musicPause()),
      music_stop: call(() => bridge.musicStop()),
      music_volume: call(value => bridge.musicVolume(value)),
      setup_music: call(() => bridge.setupMusic()),
      save: call(value => bridge.save(value)),
      connect: call(() => bridge.connect()),
      disconnect: call(() => bridge.disconnect()),
      stop: call(() => bridge.stopSpeech()),
      clear_history: call(() => bridge.clearHistory()),
      approve: call(value => bridge.approve(value)),
      reject: call(value => bridge.reject(value)),
      models: call(value => bridge.models(value)),
      voices: call(() => bridge.voices()),
      use_astra_voice: call(() => bridge.useAstraVoice()),
      use_astra_recognition: call(() => bridge.useAstraRecognition()),
      use_astra_chat_model: call(() => bridge.useAstraChatModel()),
      setup_whisper: call(() => bridge.setupWhisper()),
      discover_discord: call(() => bridge.discoverDiscord()),
      test_voice: call(() => bridge.testVoice()),
      setup_local: call(() => bridge.setupLocal()),
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
