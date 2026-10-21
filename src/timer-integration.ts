import { integrationDir } from "./platform";
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export class TimerIntegration {
  private server?: Server;
  private readonly token = randomBytes(32).toString("hex");
  private path = "";
  constructor(private methods: Record<string, (params: any) => unknown>, private error: (error: unknown) => string) {}
  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization || ""), expected = Buffer.from("Bearer " + this.token);
      if (req.method !== "POST" || req.url !== "/api" || req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      req.setTimeout(10000, () => req.destroy());
      try {
        for await (const chunk of req) { size += chunk.length; if (size > 32768) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        req.setTimeout(0); res.setTimeout(95000, () => res.destroy());
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!input || typeof input.method !== "string" || !Object.hasOwn(this.methods, input.method)) { res.writeHead(404).end(); return; }
        const params = input.params ?? {};
        if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Некорректные параметры эфира.");
        const result = await this.methods[input.method](params);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: this.error(error) })); }
      }
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0,"127.0.0.1",resolve); });
      server.unref();
      const folder = integrationDir();
      this.path = join(folder,"discord.json"); await mkdir(folder,{recursive:true});
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Не удалось открыть связь с таймером.");
      await writeFile(this.path + ".tmp", JSON.stringify({port:address.port,token:this.token}), {mode:0o600}); await rename(this.path + ".tmp",this.path);
    } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    try { if (JSON.parse(await readFile(this.path,"utf8")).token === this.token) await unlink(this.path); } catch {}
  }
}
