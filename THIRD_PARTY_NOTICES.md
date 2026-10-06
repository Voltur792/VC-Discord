# Third-party components

The plugin's own source is MIT, Copyright 2026 Voltur. Bundled libraries retain their licenses.

- Astra Plugin SDK 0.7.1 — MPL-2.0, Copyright 2026 Minice. Source: https://github.com/mihailinl/AstraPlugins/tree/master/astra-plugin-sdk-ts. Published package: https://registry.npmjs.org/astra-plugin-sdk/-/astra-plugin-sdk-0.7.1.tgz.
- discord.js and @discordjs/voice — Apache-2.0. Source: https://github.com/discordjs/discord.js.
- The bundled @discordjs/voice 0.19.2 receiver includes a compatibility backport for RTP CSRC identifiers and header extensions, adapted from commit 4dc1acc60 in packages/voice/src/receive/VoiceReceiver.ts. Original Apache-2.0 license is retained; the backport and source guards are in scripts/voice-compat.mjs.
- @snazzah/davey 0.1.12 — MIT. Source: https://github.com/Snazzah/davey. The Windows x64 runtime in third_party/davey-win32-x64-msvc.node is copied from the pinned npm package @snazzah/davey-win32-x64-msvc 0.1.12; its license is third_party/davey-LICENSE.
- opusscript — MIT, including BSD-licensed libopus. Original package and license are included under dist/native/opusscript.
- Versions are pinned in package-lock.json; original dependency license texts are collected under dist/licenses during build.

Vosk is an optional separately installed runtime: https://alphacephei.com/vosk/. A small Russian model is downloaded only after a request in the local plugin UI.

FFmpeg 9.0.2 is an optional separately downloaded runtime, not bundled with this plugin. The “Подготовить музыку” button reuses an existing installation or downloads the Windows x64 essentials build from https://www.gyan.dev/ffmpeg/builds/ (a binary provider linked by https://ffmpeg.org/download.html). The archive is checked against its pinned published SHA-256 before extraction or execution. Gyan's build is GPL-3.0; its original LICENSE and README.txt are kept beside the downloaded executable. FFmpeg source and build information: https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/download.html.

Supertonic Python SDK 1.3.1 is an optional separately installed runtime, under the MIT license: https://github.com/supertone-oss-archive/supertonic-py. Supertonic 3 model files and voice styles are reused from Astra's existing installation and are not included in this bundle. No model download is performed by the Supertonic worker.

Pywhispercpp 1.5.1 (MIT, https://github.com/absadiki/pywhispercpp) and its whisper.cpp backend (MIT, https://github.com/ggml-org/whisper.cpp) are optional separately installed runtimes. The automatic preparation installs wheels in an isolated Python environment. Whisper GGML model files are reused from Astra and are not included in the bundle; this plugin does not download Whisper model files.

Google Web STT protocol and public shared client configuration are based on Lil KALINOV's Astra-Google-STT (MIT): https://github.com/LilKALINOV/Astra-Google-STT, src/main.rs on master. Attribution is included at dist/licenses/web-stt/LICENSE. The Discord implementation uses HTTPS, an explicit local consent setting, and a separately encrypted optional personal key. The free endpoint is unofficial and availability is not guaranteed.
