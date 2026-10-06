import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export function localVisionBase(base: string): string {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Снимки экрана доступны только для локальной модели на этом ПК: адрес 127.0.0.1, localhost или ::1. Облачная отправка снимков отключена.");
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString().replace(/\/+$/, "");
}

export function openScreenPicker(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/") return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn("explorer.exe", [url], { windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

// Capture belongs to the browser's permission picker, never to this service.
export class BrowserScreen {
  private server?: Server;
  private preparing?: Promise<{ url: string }>;
  private token = "";
  private origin = "";
  private frame?: Buffer;
  private receivedAt = 0;
  private captureId = "";
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private onEnded: () => void) {}
  status(): { prepared: boolean; ready: boolean } {
    return { prepared: !!this.server, ready: !!this.frame && Date.now() - this.receivedAt < 8000 };
  }
  prepare(): Promise<{ url: string }> {
    if (this.preparing) return this.preparing;
    if (this.server) return Promise.resolve({ url: this.origin + "/#" + this.token });
    const epoch = ++this.generation;
    const operation = this.create(epoch);
    this.preparing = operation;
    void operation.finally(() => { if (this.preparing === operation) this.preparing = undefined; }).catch(() => {});
    return operation;
  }
  private async create(epoch: number): Promise<{ url: string }> {
    const [html, js, css] = await Promise.all(["html", "js", "css"].map(extension => readFile(join(__dirname, "assets", "screen-share." + extension))));
    if (epoch !== this.generation) throw new Error("Выбор экрана отменён.");
    const token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.handle(server, token, request, response, html, js, css).catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    server.requestTimeout = 8000; server.headersTimeout = 8000;
    server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    }).catch(() => { server.close(); throw new Error("Не удалось открыть местное окно выбора экрана."); });
    if (epoch !== this.generation) { server.close(); throw new Error("Выбор экрана отменён."); }
    server.on("error", () => { if (this.server === server) { this.stop(); this.onEnded(); } });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("Не удалось открыть местное окно выбора экрана."); }
    this.origin = "http://127.0.0.1:" + address.port;
    this.token = token; this.server = server;
    this.timer = setInterval(() => { if (this.frame && Date.now() - this.receivedAt >= 8000) this.clearFrame(); }, 1000);
    this.timer.unref();
    return { url: this.origin + "/#" + token };
  }
  private async handle(server: Server, token: string, request: IncomingMessage, response: ServerResponse, html: Buffer, js: Buffer, css: Buffer): Promise<void> {
    const address = server.address();
    const expectedHost = address && typeof address !== "string" ? "127.0.0.1:" + address.port : "";
    const origin = "http://" + expectedHost;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader("Permissions-Policy", "display-capture=(self), camera=(), microphone=()");
    if (this.server !== server || request.headers.host !== expectedHost || request.headers.origin && request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
    const resource = request.url;
    if (request.method === "GET" && ["/", "/screen-share.js", "/screen-share.css"].includes(resource || "")) {
      response.setHeader("Content-Type", resource === "/" ? "text/html; charset=utf-8" : resource?.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
      response.end(resource === "/" ? html : resource?.endsWith(".js") ? js : css); return;
    }
    const provided = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from("Bearer " + token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { response.writeHead(403); response.end(); return; }
    if (request.method === "GET" && resource === "/status") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(this.status())); return; }
    if (request.method === "POST" && resource === "/begin") {
      this.clearFrame(); this.captureId = randomBytes(16).toString("hex");
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ captureId: this.captureId })); return;
    }
    if (request.method === "POST" && resource === "/stop") {
      if (request.headers["x-capture-id"] === this.captureId) this.clearFrame();
      response.writeHead(204); response.end(); return;
    }
    if (request.method !== "POST" || resource !== "/frame" || request.headers["content-type"] !== "image/jpeg") { response.writeHead(400); response.end(); return; }
    if (!this.captureId || request.headers["x-capture-id"] !== this.captureId) { response.writeHead(410); response.end(); return; }
    const epoch = this.frameEpoch;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2_200_000) { response.writeHead(413); response.end(); request.destroy(); return; }
      chunks.push(chunk);
    }
    const frame = Buffer.concat(chunks);
    if (this.server !== server || epoch !== this.frameEpoch) { frame.fill(0); response.writeHead(410); response.end(); return; }
    if (frame.length < 4 || frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) { response.writeHead(400); response.end(); return; }
    this.frame?.fill(0); this.frame = frame; this.receivedAt = Date.now();
    response.writeHead(204); response.end();
  }
  capture(signal: AbortSignal): string {
    signal.throwIfAborted();
    if (!this.status().ready || !this.frame) throw new Error("Экран не выбран или показ остановлен в браузере. Нажмите «Выбрать экран в браузере», разрешите показ и оставьте эту вкладку открытой.");
    return "data:image/jpeg;base64," + this.frame.toString("base64");
  }
  private frameEpoch = 0;
  private clearFrame(): void {
    this.frameEpoch++;
    this.captureId = "";
    const hadFrame = !!this.frame;
    this.frame?.fill(0); this.frame = undefined; this.receivedAt = 0;
    if (hadFrame) this.onEnded();
  }
  stop(): void {
    this.generation++; this.frameEpoch++;
    this.token = ""; this.origin = ""; this.captureId = "";
    clearInterval(this.timer); this.timer = undefined;
    this.frame?.fill(0); this.frame = undefined; this.receivedAt = 0;
    const server = this.server; this.server = undefined;
    server?.close(); server?.closeAllConnections();
  }
}
