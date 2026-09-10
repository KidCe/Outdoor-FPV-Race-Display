import test from "node:test";
import assert from "node:assert/strict";
import { OutputSession, SerialOutputAdapter } from "../web/output-session.js";

const schema = {
  schemaId: "fpv-race-80x80-v1",
  schemaHash: "atomic-test",
  revision: 1,
  canvas: { width: 80, height: 80, background: 0, fps: 30 },
  nodes: [{ id: "node", type: "text", bind: "v0", w: 5 }]
};

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the test condition.");
};

test("OutputSession commits every USB state only after all chunks arrived", async () => {
  const commands = [];
  const visibleStates = [];
  let connected = false;
  let visible = new Map([...[...Array(17)].keys()].map(index => [`v${index}`, `old-${index}`]));
  let staged = null;
  const adapterFactory = (_transport, callbacks) => ({
    async connect() { connected = true; },
    ready() { return connected; },
    async close() { connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      commands.push(command);
      if (command.op === "state") {
        if (command.tx) {
          if (command.replace) staged = new Map();
          for (const value of command.values) staged.set(value.key, value.text);
          if (command.commit) { visible = staged; staged = null; }
        } else {
          if (command.replace) visible = new Map();
          for (const value of command.values) visible.set(value.key, value.text);
        }
        visibleStates.push(new Map(visible));
      }
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const output = new OutputSession({ adapterFactory });
  output.configure({ transport: "usb", brightness: 50 });
  output.setLive(true);
  await output.setEnabled(true);
  output.activeSchema = schema;

  const next = [...Array(17)].map((_, index) => ({ key: `v${index}`, text: `new-${index}` }));
  await output.publish(schema, next);

  const states = commands.filter(command => command.op === "state");
  assert.equal(states.length, 3);
  assert.deepEqual([...visibleStates[0].values()], [...visibleStates[1].values()]);
  assert.deepEqual([...visibleStates[2].values()], next.map(value => value.text));
  assert.deepEqual(states.map(command => command.replace), [true, false, false]);
  assert.deepEqual(states.map(command => command.commit), [false, false, true]);
  assert.ok(states.every(command => Number.isInteger(command.tx) && command.tx > 0));
  assert.equal(new Set(states.map(command => command.tx)).size, 1);

  await output.setEnabled(false);
});

test("OutputSession drops superseded states instead of building a stale queue", async () => {
  const commands = [];
  let connected = false;
  let releaseFirstState;
  const firstStateBlocked = new Promise(resolve => { releaseFirstState = resolve; });
  let blockFirstState = true;
  const adapterFactory = (_transport, callbacks) => ({
    async connect() { connected = true; },
    ready() { return connected; },
    async close() { connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      commands.push(command);
      if (command.op === "state" && blockFirstState) {
        blockFirstState = false;
        await firstStateBlocked;
      }
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const output = new OutputSession({ adapterFactory });
  output.configure({ transport: "usb", brightness: 50 });
  output.setLive(true);
  await output.setEnabled(true);
  output.activeSchema = schema;

  const initial = [...Array(17)].map((_, index) => ({ key: `v${index}`, text: `initial-${index}` }));
  const superseded = [...Array(17)].map((_, index) => ({ key: `v${index}`, text: `superseded-${index}` }));
  const latest = [...Array(17)].map((_, index) => ({ key: `v${index}`, text: `latest-${index}` }));
  const first = output.publish(schema, initial);
  await waitFor(() => commands.some(command => command.op === "state"));
  const middle = output.publish(schema, superseded);
  const last = output.publish(schema, latest);
  releaseFirstState();
  await Promise.all([first, middle, last]);

  const states = commands.filter(command => command.op === "state");
  assert.equal(states.length, 6, "only the initial and latest three-chunk publications should be sent");
  assert.equal(new Set(states.map(command => command.tx)).size, 2);
  assert.ok(states.some(command => command.values.some(value => value.text === "latest-0")));
  assert.ok(!states.some(command => command.values.some(value => value.text === "superseded-0")));

  await output.setEnabled(false);
});

test("OutputSession retains a bootstrap scene until output becomes live and connected", async () => {
  const commands = [];
  let connected = false;
  const adapterFactory = (_transport, callbacks) => ({
    async connect() { connected = true; },
    ready() { return connected; },
    async close() { connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      commands.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const output = new OutputSession({ adapterFactory });
  output.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 50 });
  const values = [{ key: "v0", text: "bootstrap" }];
  await output.publish(schema, values);
  output.setLive(true);
  await output.setEnabled(true);

  assert.ok(commands.some(command => command.op === "use"));
  assert.ok(commands.some(command => command.op === "state" && command.values.some(value => value.text === "bootstrap")));
  assert.equal(output.getState().controlling, true);

  await output.setEnabled(false);
});

test("SerialOutputAdapter treats an ended USB read stream as a disconnect", async () => {
  const disconnects = [];
  let adapter;
  let closeFinished;
  const closed = new Promise(resolve => { closeFinished = resolve; });
  const port = {
    readable: {
      getReader() {
        return {
          async read() { return { value: undefined, done: true }; },
          releaseLock() {}
        };
      }
    },
    writable: { getWriter() { return { async write() {}, releaseLock() {} }; } },
    async close() {}
  };
  adapter = new SerialOutputAdapter({
    navigatorRef: { serial: { async getPorts() { return [port]; } } },
    onClose: error => { disconnects.push(error); void adapter.close().then(closeFinished); }
  });

  await adapter.connect({ serialBaud: 115200 });
  await adapter.readTask;
  await closed;

  assert.equal(disconnects.length, 1);
  assert.match(disconnects[0].message, /serial stream ended/);
});

test("SerialOutputAdapter extracts FPV replies that follow WLED serial diagnostics", async () => {
  const messages = [];
  let finishRead;
  let reads = 0;
  const port = {
    readable: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads === 1) {
              return {
                value: new TextEncoder().encode('WLED debug: {"fpv":{"p":1,"seq":7,"ok":true}} trailing diagnostics\n'),
                done: false
              };
            }
            return new Promise(resolve => { finishRead = () => resolve({ value: undefined, done: true }); });
          },
          releaseLock() {},
          cancel() { finishRead?.(); }
        };
      }
    },
    writable: { getWriter() { return { async write() {}, releaseLock() {} }; } },
    async close() {}
  };
  const adapter = new SerialOutputAdapter({
    navigatorRef: { serial: { async getPorts() { return [port]; } } },
    onMessage: message => messages.push(message)
  });

  await adapter.connect({ serialBaud: 115200 });
  await waitFor(() => messages.length === 1);
  assert.equal(messages[0], '{"fpv":{"p":1,"seq":7,"ok":true}}');
  await adapter.close();
});

test("SerialOutputAdapter serializes concurrent USB writes", async () => {
  let releaseFirstWrite;
  const firstWriteBlocked = new Promise(resolve => { releaseFirstWrite = resolve; });
  let writerCalls = 0;
  const writes = [];
  let stopReading;
  const port = {
    readable: {
      getReader() {
        return {
          read() { return new Promise(resolve => { stopReading = () => resolve({ value: undefined, done: true }); }); },
          releaseLock() {},
          cancel() { stopReading?.(); }
        };
      }
    },
    writable: {
      getWriter() {
        writerCalls += 1;
        return {
          async write(bytes) {
            writes.push(new TextDecoder().decode(bytes));
            if (writerCalls === 1) await firstWriteBlocked;
          },
          releaseLock() {}
        };
      }
    },
    async close() {}
  };
  const adapter = new SerialOutputAdapter({
    navigatorRef: { serial: { async getPorts() { return [port]; } } }
  });

  await adapter.connect({ serialBaud: 115200 });
  const first = adapter.send("first");
  await waitFor(() => writerCalls === 1);
  const second = adapter.send("second");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writerCalls, 1, "the second write must wait for the first writer");
  releaseFirstWrite();
  await Promise.all([first, second]);
  assert.equal(writerCalls, 2);
  assert.deepEqual(writes, ["first\n", "second\n"]);
  await adapter.close();
});

test("OutputSession retries a timed-out USB command with the same protocol sequence", async () => {
  const output = new OutputSession();
  const commands = [];
  output.config = { transport: "usb" };
  output.enabled = true;
  output.adapter = {
    ready() { return true; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      commands.push(command);
      if (commands.length === 2) {
        queueMicrotask(() => output.receive(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
      }
    }
  };

  await output.sendCommand("ping", {}, 10);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].seq, commands[1].seq);
});

test("OutputSession keeps frame capture exclusive from live state synchronization", async () => {
  const commands = [];
  let connected = false;
  let releaseChunk;
  const chunkBlocked = new Promise(resolve => { releaseChunk = resolve; });
  let capture = false;
  const adapterFactory = (_transport, callbacks) => ({
    async connect() { connected = true; },
    ready() { return connected; },
    async close() { connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      commands.push(command);
      if (command.op === "hello") {
        queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
        return;
      }
      if (command.op === "frame.begin") {
        capture = true;
        queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true, capture: 7, ready: true, width: 1, height: 1, total: 1, lit: 1 } })));
        return;
      }
      if (command.op === "frame.chunk") {
        await chunkBlocked;
        queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true, offset: 0, count: 1, data: "////" } })));
        return;
      }
      if (command.op === "frame.end") capture = false;
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const output = new OutputSession({ adapterFactory });
  output.configure({ transport: "usb", brightness: 50 });
  output.setLive(true);
  await output.setEnabled(true);
  output.activeSchema = schema;

  const readback = output.readFrame("logical");
  await waitFor(() => commands.some(command => command.op === "frame.chunk"));
  const publication = output.publish(schema, [{ key: "v0", text: "latest" }]);
  assert.equal(commands.some(command => command.op === "state"), false, "live state must wait for readback");
  releaseChunk();
  await readback;
  await publication;

  assert.equal(capture, false);
  assert.ok(commands.findIndex(command => command.op === "frame.end") < commands.findIndex(command => command.op === "state"));
  await output.setEnabled(false);
});

test("OutputSession retries an idempotent frame start when a USB reply is lost", async () => {
  const output = new OutputSession();
  let beginAttempts = 0;
  output.ready = () => true;
  output.sendCommand = async op => {
    if (op === "frame.begin") {
      beginAttempts += 1;
      if (beginAttempts === 1) throw new Error("frame.begin timed out.");
      return { capture: 9, ready: true, width: 1, height: 1, total: 1, lit: 1, checksum: 1456420779 };
    }
    if (op === "frame.chunk") return { offset: 0, data: "AQID", count: 1 };
    return { ok: true };
  };

  const frame = await output.readFrameNow("output");
  assert.equal(beginAttempts, 2);
  assert.deepEqual([...frame.pixels], [1, 2, 3]);
});

test("OutputSession retries a frame chunk when serial noise corrupts its base64 payload", async () => {
  const output = new OutputSession();
  let chunkAttempts = 0;
  output.ready = () => true;
  output.sendCommand = async op => {
    if (op === "frame.begin") {
      return { capture: 11, ready: true, width: 1, height: 1, total: 1, lit: 1, checksum: 1456420779 };
    }
    if (op === "frame.chunk") {
      chunkAttempts += 1;
      return chunkAttempts === 1
        ? { offset: 0, count: 1, data: "AQI\ufffd" }
        : { offset: 0, count: 1, data: "AQID" };
    }
    return { ok: true };
  };

  const frame = await output.readFrameNow("output");
  assert.equal(chunkAttempts, 2);
  assert.deepEqual([...frame.pixels], [1, 2, 3]);
});
