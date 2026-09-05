import test from "node:test";
import assert from "node:assert/strict";
import { nextReconnectDelay, outputSyncPlan } from "../web/output-session.js";

test("a live schema mismatch is repaired before sending the next state", () => {
  assert.deepEqual(outputSyncPlan({ enabled: true, live: true, ready: true, schemaMatches: false }), ["install-schema", "send-state"]);
});

test("reconnect backoff remains bounded", () => {
  assert.deepEqual([0, 1, 2, 3, 8].map(nextReconnectDelay), [1000, 2000, 4000, 8000, 10000]);
});
