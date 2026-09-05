import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = Number(process.env.FPV_DISPLAY_PORT || 4185);
const host = process.env.FPV_DISPLAY_HOST || "127.0.0.1";
const connectorOrigin = process.env.FPV_CONNECTOR_URL || "http://127.0.0.1:4174";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml"
};

export class RaceDayServer {
  constructor({ documentRoot = root, listenPort = port, listenHost = host, sourceOrigin = connectorOrigin } = {}) {
    this.documentRoot = documentRoot;
    this.listenPort = listenPort;
    this.listenHost = listenHost;
    this.sourceOrigin = sourceOrigin;
    this.server = createServer((request, response) => this.respond(request, response));
  }
  async respond(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/connectors/")) return this.proxySource(url, request, response);
    const pathname = url.pathname === "/" ? "/web/fpv-race-wled-80x80.html" : url.pathname;
    const file = resolve(join(this.documentRoot, normalize(pathname).replace(/^[/\\]+/, "")));
    if (file !== this.documentRoot && !file.startsWith(`${this.documentRoot}\\`) && !file.startsWith(`${this.documentRoot}/`)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden path");
      return;
    }
    try {
      const contents = await readFile(file);
      response.writeHead(200, { "cache-control": "no-store", "content-type": contentTypes[extname(file)] || "application/octet-stream" });
      response.end(contents);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  }
  async proxySource(url, request, response) {
    const controller = new AbortController();
    request.on("close", () => controller.abort());
    try {
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, this.sourceOrigin);
      const upstream = await fetch(upstreamUrl, { headers: { accept: request.headers.accept || "application/json" }, cache: "no-store", signal: controller.signal });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": upstream.headers.get("cache-control") || "no-store",
        connection: upstream.headers.get("content-type")?.startsWith("text/event-stream") ? "keep-alive" : "close"
      });
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: `LiveTime connector unavailable at ${this.sourceOrigin}: ${error.message}` }));
    }
  }
  start() {
    return new Promise(resolve => this.server.listen(this.listenPort, this.listenHost, () => {
      console.log(`FPV Race Display listening on http://${this.listenHost}:${this.listenPort}/`);
      resolve(this);
    }));
  }
  stop() { return new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve())); }
}

export class RaceDayRuntime {
  constructor({ server = new RaceDayServer(), liveTimeQueRoot = process.env.LIVETIME_QUE_ROOT || resolve(root, "../LiveTimeQue") } = {}) {
    this.server = server;
    this.liveTimeQueRoot = liveTimeQueRoot;
    this.connectorProcess = null;
  }
  async start() {
    await this.server.start();
    if (!await this.connectorAvailable()) await this.startBundledConnector();
    return this;
  }
  async connectorAvailable() {
    try {
      const response = await fetch(this.server.sourceOrigin, { signal: AbortSignal.timeout(700) });
      return response.ok;
    } catch { return false; }
  }
  async startBundledConnector() {
    const entry = resolve(this.liveTimeQueRoot, "server/local-server.mjs");
    try { await access(entry); }
    catch {
      console.warn(`LiveTime connector was not started. Set LIVETIME_QUE_ROOT or run a connector at ${this.server.sourceOrigin}.`);
      return;
    }
    const origin = new URL(this.server.sourceOrigin);
    this.connectorProcess = spawn(process.execPath, [entry, "--host", origin.hostname, "--port", origin.port || "4174"], { cwd: this.liveTimeQueRoot, stdio: "inherit", windowsHide: true });
    this.connectorProcess.once("exit", code => {
      if (code && code !== 0) console.warn(`LiveTime connector exited with code ${code}. RaceSourceRuntime will keep retrying.`);
      this.connectorProcess = null;
    });
  }
  async stop() {
    this.connectorProcess?.kill();
    this.connectorProcess = null;
    await this.server.stop();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runtime = await new RaceDayRuntime().start();
  const shutdown = async () => { await runtime.stop(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
