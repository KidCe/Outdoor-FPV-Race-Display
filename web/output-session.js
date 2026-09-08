const PROTOCOL_VERSION = 1;
const COMMAND_TIMEOUT_MS = 3000;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function nextReconnectDelay(attempt) {
  return Math.min(10000, 1000 * (2 ** Math.max(0, Number(attempt) || 0)));
}

export function outputSyncPlan({ enabled, live, ready, schemaMatches }) {
  if (!enabled || !live || !ready) return [];
  return schemaMatches ? ["send-state"] : ["install-schema", "send-state"];
}

class WebSocketOutputAdapter {
  constructor({ WebSocketImpl = globalThis.WebSocket, onMessage, onClose } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.socket = null;
  }
  async connect(config) {
    if (!this.WebSocketImpl) throw new Error("WebSocket is unavailable in this browser.");
    const url = new URL(config.wledUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/fpv/ws";
    url.search = "";
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WLED connection timed out.")), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("WLED WebSocket connection failed.")); };
    });
    socket.onmessage = event => this.onMessage(event.data);
    socket.onclose = () => { if (this.socket === socket) { this.socket = null; this.onClose(undefined, this); } };
  }
  ready() { return this.socket?.readyState === this.WebSocketImpl?.OPEN; }
  async send(text) {
    if (!this.ready()) throw new Error("WLED WebSocket is not connected.");
    this.socket.send(text);
  }
  async close() {
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.onclose = null; socket.close(); }
  }
}

export class SerialOutputAdapter {
  constructor({ navigatorRef = globalThis.navigator, onMessage, onClose } = {}) {
    this.navigatorRef = navigatorRef;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.port = null;
    this.reader = null;
    this.readTask = null;
    this.writeTask = Promise.resolve();
    this.tail = "";
    this.closing = false;
  }
  async connect(config, interactive = false) {
    if (!this.navigatorRef?.serial) throw new Error("Web Serial requires Chrome or Edge on localhost/HTTPS.");
    let port;
    // Reuse an already-authorized port even for an explicit Connect action.
    // requestPort() is only needed when this browser has not seen the device
    // before; this makes reconnect deterministic after a deliberate disconnect.
    [port] = await this.navigatorRef.serial.getPorts();
    if (!port && interactive) port = await this.navigatorRef.serial.requestPort();
    if (!port) throw new Error("Select Enable output once to authorize the USB display.");
    if (!port.readable || !port.writable) await port.open({ baudRate: config.serialBaud });
    this.closing = false;
    this.tail = "";
    this.port = port;
    this.readTask = this.readLoop(port);
  }
  ready() { return Boolean(this.port?.readable && this.port?.writable && this.readTask); }
  async readLoop(port) {
    const decoder = new TextDecoder();
    try {
      while (port === this.port && port.readable) {
        let streamEnded = false;
        this.reader = port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) {
              streamEnded = true;
              break;
            }
            this.tail += decoder.decode(value, { stream: true });
            const lines = this.tail.split(/\r?\n/);
            this.tail = lines.pop() || "";
            for (const line of lines) if (line.trim().startsWith("{")) this.onMessage(line.trim());
          }
        } finally { this.reader.releaseLock(); this.reader = null; }
        if (streamEnded) {
          if (port === this.port && !this.closing) {
            try { await port.close(); } catch {}
            this.onClose(new Error("USB display serial stream ended."), this);
          }
          return;
        }
      }
    } catch (error) {
      if (port === this.port && !this.closing) this.onClose(error, this);
    }
  }
  async send(text) {
    if (!this.ready()) throw new Error("USB display is not connected.");
    const port = this.port;
    const writeTask = this.writeTask.then(async () => {
      if (port !== this.port || !this.ready()) throw new Error("USB display is not connected.");
      const writer = port.writable.getWriter();
      try { await writer.write(new TextEncoder().encode(`${text}\n`)); }
      finally { writer.releaseLock(); }
    });
    this.writeTask = writeTask.catch(() => {});
    return writeTask;
  }
  async close() {
    this.closing = true;
    const port = this.port;
    this.port = null;
    await this.writeTask.catch(() => {});
    try { await this.reader?.cancel(); } catch {}
    try { await this.readTask; } catch {}
    this.readTask = null;
    this.tail = "";
    try { if (port) await port.close(); } catch {}
  }
}

export class OutputSession {
  constructor({ WebSocketImpl = globalThis.WebSocket, navigatorRef = globalThis.navigator, adapterFactory = null, onState = () => {} } = {}) {
    this.dependencies = { WebSocketImpl, navigatorRef };
    this.onState = onState;
    this.adapterFactory = adapterFactory;
    this.config = {};
    this.enabled = false;
    this.live = false;
    this.adapter = null;
    this.connecting = false;
    this.reconnectTimer = 0;
    this.reconnectAttempt = 0;
    this.sequence = 0;
    this.transaction = 0;
    this.sessionId = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    this.waiters = new Map();
    this.activeSchema = null;
    this.pendingPublish = Promise.resolve();
    this.publicationTask = null;
    this.publicationVersion = 0;
    this.lastPublication = null;
    this.operationTask = Promise.resolve();
    this.state = { connection: "disabled", controlling: false, message: "Output is disabled.", lastUpdateAt: null, schema: null };
  }

  getState() { return { ...this.state }; }
  configure(config) {
    const next = { ...config };
    const targetChanged = this.config.transport && (this.config.transport !== next.transport || this.config.wledUrl !== next.wledUrl || this.config.serialBaud !== next.serialBaud);
    this.config = next;
    if (targetChanged && this.enabled) void this.reconnect();
  }
  async setEnabled(enabled, { interactive = false } = {}) {
    this.enabled = Boolean(enabled);
    clearTimeout(this.reconnectTimer);
    if (!this.enabled) {
      await this.deactivate().catch(() => {});
      await this.closeAdapter();
      this.activeSchema = null;
      this.setState({ connection: "disabled", controlling: false, message: "Output is disabled." });
      return;
    }
    await this.ensureConnected({ interactive });
  }
  setLive(live) {
    this.live = Boolean(live);
    if (!this.live) {
      this.state.controlling = false;
      void this.deactivate().catch(() => {});
      this.setState({ controlling: false, message: this.enabled ? "Connected; live output is paused." : "Output is disabled." });
    } else if (this.lastPublication) {
      void this.publish(this.lastPublication.schema, this.lastPublication.values);
    }
  }
  async reconnect() {
    await this.closeAdapter();
    this.activeSchema = null;
    if (this.enabled) await this.ensureConnected();
  }
  async ensureConnected({ interactive = false } = {}) {
    if (!this.enabled || this.adapter?.ready() || this.connecting) return;
    this.connecting = true;
    this.setState({ connection: this.reconnectAttempt ? "reconnecting" : "connecting", message: "Connecting to the display…" });
    try {
      const callbacks = { onMessage: text => this.receive(text), onClose: (error, adapter) => this.handleDisconnect(error, adapter) };
      this.adapter = this.adapterFactory
        ? this.adapterFactory(this.config.transport, callbacks)
        : this.config.transport === "usb"
          ? new SerialOutputAdapter({ ...this.dependencies, ...callbacks })
          : new WebSocketOutputAdapter({ ...this.dependencies, ...callbacks });
      await this.adapter.connect(this.config, interactive);
      if (this.config.transport === "usb") await wait(2500);
      let helloError;
      for (let attempt = 0; attempt < (this.config.transport === "usb" ? 5 : 1); attempt += 1) {
        try { await this.sendCommand("hello", {}, 1800); helloError = null; break; }
        catch (error) { helloError = error; if (attempt < 4) await wait(250); }
      }
      if (helloError) throw helloError;
      this.reconnectAttempt = 0;
      this.setState({ connection: "connected", message: `Connected via ${this.config.transport === "usb" ? "USB serial" : "WLED WebSocket"}.` });
      if (this.lastPublication && this.live) await this.publish(this.lastPublication.schema, this.lastPublication.values);
    } catch (error) {
      await this.closeAdapter();
      this.setState({ connection: "error", controlling: false, message: error.message });
      this.scheduleReconnect();
    } finally { this.connecting = false; }
  }
  scheduleReconnect() {
    if (!this.enabled) return;
    clearTimeout(this.reconnectTimer);
    const delay = nextReconnectDelay(this.reconnectAttempt++);
    this.setState({ connection: "reconnecting", controlling: false, message: `Display disconnected. Retrying in ${delay / 1000}s…` });
    this.reconnectTimer = setTimeout(() => void this.ensureConnected(), delay);
  }
  handleDisconnect(error, disconnectedAdapter = this.adapter) {
    if (!this.enabled) return;
    if (disconnectedAdapter && this.adapter && disconnectedAdapter !== this.adapter) return;
    const adapter = this.adapter;
    this.adapter = null;
    this.activeSchema = null;
    this.rejectWaiters(error?.message || "Display connection closed.");
    void adapter?.close().catch(() => {});
    this.scheduleReconnect();
  }
  async closeAdapter() {
    const adapter = this.adapter;
    this.adapter = null;
    this.rejectWaiters("Output session closed.");
    await adapter?.close();
  }
  ready() { return Boolean(this.adapter?.ready()); }
  receive(text) {
    let reply;
    try { reply = JSON.parse(text); } catch { return; }
    const message = reply?.fpv;
    if (!message || message.p !== PROTOCOL_VERSION || !Number.isSafeInteger(message.seq) || message.seq < 1) return;
    const waiter = this.waiters.get(message.seq);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(message.seq);
    if (message.ok === true) waiter.resolve(message);
    else waiter.reject(new Error(message.code || "WLED rejected the command."));
  }
  rejectWaiters(message) {
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
    this.waiters.clear();
  }
  queueOperation(operation) {
    const task = this.operationTask.then(operation, operation);
    this.operationTask = task.catch(() => {});
    return task;
  }
  async sendCommand(op, fields = {}, timeout = COMMAND_TIMEOUT_MS) {
    if (!this.ready()) throw new Error("Display is not connected.");
    const seq = ++this.sequence;
    const envelope = { fpv: { p: PROTOCOL_VERSION, sid: this.sessionId, seq, op, ...fields } };
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(seq); reject(new Error(`${op} timed out.`)); }, timeout);
      this.waiters.set(seq, { resolve, reject, timer });
    });
    try { await this.adapter.send(JSON.stringify(envelope)); }
    catch (error) { const waiter = this.waiters.get(seq); if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(seq); } throw error; }
    return response;
  }
  publish(schema, values) {
    this.lastPublication = { schema, values };
    this.publicationVersion += 1;
    // Keep source bootstrap publications for the first enabled/live output,
    // but do not create a completed no-op task while output is disabled or
    // paused. A later connect must be able to start the retained publication.
    if (!this.enabled || !this.live) return Promise.resolve();
    if (!this.publicationTask) {
      this.publicationTask = this.queueOperation(() => this.drainPublications());
      this.pendingPublish = this.publicationTask;
    }
    return this.publicationTask;
  }
  async drainPublications() {
    let processedVersion = this.publicationVersion;
    try {
      while (this.enabled && this.live && this.lastPublication) {
        const version = this.publicationVersion;
        const publication = this.lastPublication;
        await this.syncPublication(publication.schema, publication.values);
        processedVersion = version;
        if (version === this.publicationVersion) break;
      }
    } catch (error) {
      this.setState({ controlling: false, message: `Live update failed: ${error.message}` });
      if (this.enabled) void this.closeAdapter().finally(() => this.scheduleReconnect());
    } finally {
      this.publicationTask = null;
      this.pendingPublish = Promise.resolve();
    }
    return processedVersion;
  }
  async syncPublication(schema, values) {
    if (!this.enabled || !this.live) return;
    if (!this.ready()) { await this.ensureConnected(); if (!this.ready()) return; }
    if (!this.activeSchema) {
      try {
        await this.sendCommand("use", { schema: schema.schemaId, hash: schema.schemaHash });
        this.activeSchema = schema;
        this.setState({ schema: schema.schemaHash, message: `Layout schema ${schema.schemaHash} ready.` });
      }
      catch {}
    }
    const schemaMatches = this.activeSchema?.schemaId === schema.schemaId && this.activeSchema?.schemaHash === schema.schemaHash;
    const plan = outputSyncPlan({ enabled: this.enabled, live: this.live, ready: this.ready(), schemaMatches });
    if (plan[0] === "install-schema") await this.installSchemaNow(schema);
    await this.sendState(schema, values);
    this.setState({ connection: "connected", controlling: true, lastUpdateAt: Date.now(), schema: schema.schemaHash, message: `Live scene sent via ${this.config.transport === "usb" ? "USB" : "WLED WebSocket"}.` });
  }
  installSchema(schema) {
    return this.queueOperation(() => this.installSchemaNow(schema));
  }
  async installSchemaNow(schema) {
    this.setState({ controlling: false, message: `Installing changed layout schema (0/${schema.nodes.length})…` });
    await this.sendCommand("schema.begin", { schema: schema.schemaId, hash: schema.schemaHash, revision: schema.revision, width: schema.canvas.width, height: schema.canvas.height, background: schema.canvas.background, fps: schema.canvas.fps });
    try {
      for (let index = 0; index < schema.nodes.length; index += 1) {
        await this.sendCommand("schema.node", { node: schema.nodes[index] });
        this.setState({ message: `Installing changed layout schema (${index + 1}/${schema.nodes.length})…` });
      }
      await this.sendCommand("schema.commit", { activate: true }, 6000);
      this.activeSchema = schema;
      this.setState({ schema: schema.schemaHash, message: `Layout schema ${schema.schemaHash} installed.` });
    } catch (error) {
      await this.sendCommand("schema.abort").catch(() => {});
      this.activeSchema = null;
      throw error;
    }
  }
  async sendState(schema, values) {
    // ArduinoJson parses the firmware transaction field through a signed JSON
    // number. Keep IDs in the positive 31-bit range accepted by the parser.
    this.transaction = (this.transaction % 0x7fffffff) + 1;
    if (!this.transaction) this.transaction = 1;
    const transaction = this.transaction;
    const chunks = [];
    for (let offset = 0; offset < values.length; offset += 8) chunks.push(values.slice(offset, offset + 8));
    if (!chunks.length) chunks.push([]);
    for (let index = 0; index < chunks.length; index += 1) {
      const first = index === 0;
      const last = index === chunks.length - 1;
      const fields = { schema: schema.schemaId, hash: schema.schemaHash, tx: transaction, replace: first, commit: last, values: chunks[index] };
      if (first) { fields.brightness = this.config.brightness; fields.backgroundEffect = this.config.backgroundEffect; }
      await this.sendCommand("state", fields, 4500);
    }
  }
  async deactivate() {
    if (this.ready()) await this.sendCommand("activate", { on: false }, 2000);
    this.setState({ controlling: false });
  }
  readFrame(source = "output") {
    return this.queueOperation(() => this.readFrameNow(source));
  }
  async readFrameNow(source = "output") {
    if (!this.ready()) throw new Error("Connect the display before reading pixels.");
    const begin = await this.sendCommand("frame.begin", { source }, 5000);
    const capture = begin.capture;
    try {
      let metadata = begin;
      for (let attempt = 0; attempt < 60 && !metadata.ready; attempt += 1) {
        await wait(100);
        metadata = await this.sendCommand("frame.status", { capture }, 4000);
      }
      if (!metadata.ready) throw new Error("Frame capture did not become ready.");
      const pixels = new Uint8Array(metadata.total * 3);
      for (let offset = 0; offset < metadata.total; offset += 48) {
        const chunk = await this.sendCommand("frame.chunk", { capture, offset, count: Math.min(48, metadata.total - offset) }, 5000);
        const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
        pixels.set(bytes, offset * 3);
      }
      return { ...metadata, pixels };
    } finally { await this.sendCommand("frame.end", { capture }, 2000).catch(() => {}); }
  }
  setState(patch) { this.state = { ...this.state, ...patch }; this.onState(this.getState()); }
}
