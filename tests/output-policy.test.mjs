import test from "node:test";
import assert from "node:assert/strict";
import { nextReconnectDelay, outputSyncPlan, OutputSession } from "../web/output-session.js";

test("a live schema mismatch is repaired before sending the next state", () => {
  assert.deepEqual(outputSyncPlan({ enabled: true, live: true, ready: true, schemaMatches: false }), ["install-schema", "send-state"]);
});

test("reconnect backoff remains bounded", () => {
  assert.deepEqual([0, 1, 2, 3, 8].map(nextReconnectDelay), [1000, 2000, 4000, 8000, 10000]);
});

test("deactivation uses the firmware activate command field", async () => {
  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true, code: "ok" } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "wireless", wledUrl: "http://display.test" });
  await session.setEnabled(true);
  await session.deactivate();

  const deactivate = operations.find(command => command.op === "activate" && command.on === false);
  assert.ok(deactivate);
  assert.equal(Object.hasOwn(deactivate, "active"), false);

  await session.setEnabled(false);
});

test("live output omits legacy WLED background effects and installs a black schema", async () => {
  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: command.op !== "use", code: command.op === "use" ? "schema_missing" : "ok" } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 50, backgroundEffect: 25 });
  session.setLive(true);
  await session.setEnabled(true);
  const schema = { schemaId: "race", schemaHash: "schema-v1", revision: 1, canvas: { width: 80, height: 80, background: 0xffffff, fps: 30 }, nodes: [] };
  await session.publish(schema, [{ key: "header", text: "Q1", color: 0xffffff }]);

  const begin = operations.find(command => command.op === "schema.begin");
  assert.equal(begin.background, 0);
  assert.equal(Object.hasOwn(session.config, "backgroundEffect"), false);
  assert.ok(operations.filter(command => command.op === "state").length > 0);
  assert.ok(operations.filter(command => command.op === "state").every(command => !Object.hasOwn(command, "backgroundEffect")));
  await session.setEnabled(false);
});

test("unchanged published state is sent only once", async () => {
  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 50 });
  session.setLive(true);
  await session.setEnabled(true);
  const schema = { schemaId: "race", schemaHash: "schema-v1" };
  const values = [{ key: "header", text: "Q1", color: 0xffffff }];

  await session.publish(schema, values);
  await session.publish(schema, values.map(value => ({ color: value.color, text: value.text, key: value.key })));

  assert.equal(operations.filter(command => command.op === "state").length, 1);
  await session.setEnabled(false);
});

test("changed published state is transmitted", async () => {
  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 50 });
  session.setLive(true);
  await session.setEnabled(true);
  const schema = { schemaId: "race", schemaHash: "schema-v1" };

  await session.publish(schema, [{ key: "header", text: "Q1", color: 0xffffff }]);
  session.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 51 });
  await session.publish(schema, [{ key: "header", text: "Q1", color: 0xffffff }]);
  await session.publish(schema, [{ key: "header", text: "Q2", color: 0xffffff }]);

  assert.equal(operations.filter(command => command.op === "state").length, 3);
  await session.setEnabled(false);
});

test("reconnect replays unchanged state after the new connection is ready", async () => {
  const operations = [];
  let connectionCount = 0;
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; connectionCount += 1; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 50 });
  session.setLive(true);
  await session.setEnabled(true);
  const schema = { schemaId: "race", schemaHash: "schema-v1" };
  const values = [{ key: "header", text: "Q1", color: 0xffffff }];

  await session.publish(schema, values);
  await session.reconnect();

  assert.equal(connectionCount, 2);
  assert.equal(operations.filter(command => command.op === "state").length, 2);
  await session.setEnabled(false);
});

test("a publication arriving during reconnect is not trapped behind a replay cycle", async () => {
  const operations = [];
  let connectionCount = 0;
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; connectionCount += 1; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "wireless", wledUrl: "http://display.test", brightness: 50 });
  session.setLive(true);
  await session.setEnabled(true);
  const schema = { schemaId: "race", schemaHash: "schema-v1" };
  const values = [{ key: "header", text: "Q1", color: 0xffffff }];

  await session.publish(schema, values);
  await session.closeAdapter();
  await session.publish(schema, values);

  assert.equal(connectionCount, 2);
  assert.equal(operations.filter(command => command.op === "state").length, 2);
  await session.setEnabled(false);
});
