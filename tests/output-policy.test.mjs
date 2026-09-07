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
