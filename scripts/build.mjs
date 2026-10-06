import { build } from "esbuild";
import { mkdir, cp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { voiceCompatibility } from "./voice-compat.mjs";
const require = createRequire(import.meta.url);
// Astra serves contribution URLs relative to ui/, rather than the project root.
await readFile("ui/web/index.html");
await readFile("ui/web/styles.css");
await readFile("ui/web/app.js");
await mkdir("dist/native", { recursive: true });
await cp("assets", "dist/assets", { recursive: true });
// Remove the retired capture helper from older local builds.
await rm("dist/assets/screen.ps1", { force: true });
await cp("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
await mkdir("dist/licenses/davey", { recursive: true });
await cp("third_party/davey-LICENSE", "dist/licenses/davey/LICENSE");
await mkdir("dist/licenses/web-stt", { recursive: true });
await cp("third_party/web-stt-LICENSE", "dist/licenses/web-stt/LICENSE");
await cp(dirname(require.resolve("opusscript")), "dist/native/opusscript", { recursive: true });
// GitHub's noarch job runs on Linux, where npm omits Windows-only packages.
// Keep the pinned Windows runtime available for that cross-platform packaging.
let daveySource;
try { daveySource = require.resolve("@snazzah/davey-win32-x64-msvc"); }
catch { daveySource = "third_party/davey-win32-x64-msvc.node"; }
let daveyUnchanged = false;
try { daveyUnchanged = (await readFile(daveySource)).equals(await readFile("dist/native/davey.node")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
// Windows locks a loaded native module. Preserve it when its bytes are unchanged.
if (!daveyUnchanged) await cp(daveySource, "dist/native/davey.node");
const native = {
  name: "local-native-assets",
  setup(builder) {
    // We encode PCM directly to Opus; the optional FFmpeg converter is unused.
    builder.onResolve({ filter: /^ffmpeg-static$/ }, () => ({ path: "ffmpeg-static", namespace: "optional-ffmpeg" }));
    builder.onLoad({ filter: /.*/, namespace: "optional-ffmpeg" }, () => ({ contents: "module.exports = null;", loader: "js" }));
    builder.onResolve({ filter: /^(opusscript|@snazzah\/davey)$/ }, args => ({ path: args.path, namespace: "voice-assets" }));
    builder.onLoad({ filter: /.*/, namespace: "voice-assets" }, args => ({
      contents: `module.exports = require(require('node:path').join(__dirname, 'native', ${JSON.stringify(args.path === "opusscript" ? "opusscript/index.js" : "davey.node")}));`, loader: "js",
    }));
  },
};
const options = { entryPoints: ["src/index.ts"], bundle: true, platform: "node", target: "node22", format: "cjs", plugins: [voiceCompatibility, native], legalComments: "none", minify: true, logLevel: "warning", define: { "import.meta.url": "__voice_import_meta_url" }, banner: { js: 'const __voice_import_meta_url = require("node:url").pathToFileURL(__filename).href;' } };
await build({ ...options, outfile: "dist/index.js" });
if (!(await readFile("dist/index.js", "utf8")).includes("Invalid RTP extension")) throw new Error("RTP compatibility patch was not included in the bundle.");
await rm("dist/test.cjs", { force: true });
if (process.argv.includes("--test")) {
  await mkdir("test/artifact", { recursive: true });
  await cp("dist/native", "test/artifact/native", { recursive: true });
  await cp("dist/assets", "test/artifact/assets", { recursive: true });
  await build({ ...options, external: ["astra-plugin-sdk"], outfile: "test/artifact/plugin.cjs" });
}
await writeFile("dist/BUILD.txt", "Windows x64; Node.js >= 22.12; all JavaScript dependencies bundled.\n");
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
for (const [folder, info] of Object.entries(lock.packages)) {
  if (!folder.startsWith("node_modules/")) continue;
  let files; try { files = await readdir(folder); } catch { continue; }
  const label = folder.split("node_modules/").at(-1).replace(/[^a-zA-Z0-9.-]/g, "_") + "-" + info.version;
  for (const file of files.filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(name))) {
    await mkdir(join("dist/licenses", label), { recursive: true });
    await cp(join(folder, file), join("dist/licenses", label, file));
  }
}
console.log("Built dist/index.js with local Opus and DAVE assets.");
