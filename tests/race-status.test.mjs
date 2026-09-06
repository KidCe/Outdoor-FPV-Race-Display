import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DisplayScene, projectRaceSchedule } from "../web/display-scene.js";
import { RaceDataHubClient } from "../web/race-data-hub-client.js";
import { RaceDayProfile, MemoryProfileStorage } from "../web/race-day-profile.js";
import { RaceSourceRuntime } from "../web/race-source-runtime.js";
import { RACE_STATUS, mapRaceStatus, presentRaceStatus } from "../web/race-status.js";

const fixture = name => fs.readFile(`contracts/race-event/v1/fixtures/${name}`, "utf8").then(JSON.parse);

test("status mapping presents canonical and legacy source values consistently", () => {
  const values = [
    ["staging", RACE_STATUS.STAGING, "STAGING"],
    ["ready", RACE_STATUS.STAGING, "STAGING"],
    ["running", RACE_STATUS.RUNNING, "RUNNING"],
    ["racing", RACE_STATUS.RUNNING, "RUNNING"],
    ["complete", RACE_STATUS.COMPLETE, "COMPLETE"],
    ["completed", RACE_STATUS.COMPLETE, "COMPLETE"]
  ];
  for (const [raw, status, label] of values) {
    assert.equal(mapRaceStatus(raw), status);
    assert.equal(presentRaceStatus(raw), label);
  }
  assert.equal(presentRaceStatus("not-run"), "UNKNOWN");
  assert.equal(presentRaceStatus("active"), "UNKNOWN");
  assert.equal(presentRaceStatus("in_progress"), "UNKNOWN");
  assert.equal(presentRaceStatus("finished"), "UNKNOWN");
  assert.equal(presentRaceStatus(null), "UNKNOWN");
  assert.equal(presentRaceStatus("network disconnected"), "UNKNOWN");
});

test("canonical status transitions drive current, queue, preview, and physical state values", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const expected = [["staging", "STAGING"], ["running", "RUNNING"], ["complete", "COMPLETE"]];

  for (const [raw, label] of expected) {
    const candidate = structuredClone(snapshot);
    candidate.races[0].status = raw;
    const scene = display.project(candidate, "current");
    assert.equal(scene.race.status, raw);
    assert.equal(scene.race.statusLabel, label);
    assert.match(scene.header, new RegExp(`^${label}\\b`));
    const currentHeader = display.getState(scene).find(value => value.key === "header-current");
    assert.equal(currentHeader.text, scene.header);
    assert.match(currentHeader.text, new RegExp(`^${label}\\b`));
  }

  const legacy = structuredClone(snapshot);
  legacy.races[0].status = "racing";
  legacy.races[1].status = "ready";
  const queue = projectRaceSchedule(legacy, profile, { limit: 2 });
  assert.deepEqual(queue.map(race => race.statusLabel), ["RUNNING", "STAGING"]);
  assert.deepEqual(queue.map(race => race.status), [RACE_STATUS.RUNNING, RACE_STATUS.STAGING]);

  const schema = display.getSchema();
  assert.ok(schema.nodes.length <= 40);
  assert.ok(new Set(schema.nodes.filter(node => node.bind).map(node => node.bind)).size <= 24);
});

test("Hub connection quality changes do not replace the last trusted race status", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: null });
  client.apply({ type: "snapshot", hubEpoch: "hub-status-test", eventSessionId: snapshot.eventSessionId, streamSequence: 1, snapshotSequence: 1, deliveredAt: snapshot.capturedAt, data: snapshot });
  client.apply({
    type: "status",
    hubEpoch: "hub-status-test",
    eventSessionId: snapshot.eventSessionId,
    streamSequence: 2,
    deliveredAt: snapshot.capturedAt,
    data: { connection: "reconnecting", source: "LiveFPV", event: snapshot.event.name, quality: "degraded", message: "LiveFPV is reconnecting." }
  });
  assert.equal(client.getState().quality, "degraded");
  assert.equal(client.getState().snapshot.races[0].status, "running");
});

test("legacy reconciliation preserves a newer live status and accepts a newer result", async () => {
  const baseline = await fixture("snapshot-fresh.json");
  const live = structuredClone(baseline);
  live.snapshotId = "legacy-live:2";
  live.capturedAt = "2026-09-06T10:01:00.000Z";
  live.races[0].status = "racing";
  live.races[0].timing.capturedAt = live.capturedAt;

  const oldResult = structuredClone(baseline);
  oldResult.snapshotId = "legacy-results:1";
  oldResult.capturedAt = "2026-09-06T10:00:00.000Z";
  oldResult.races[0].status = "complete";
  oldResult.races[0].timing.capturedAt = oldResult.capturedAt;

  let nextSnapshot = structuredClone(oldResult);
  let streamHandlers;
  const adapter = {
    snapshot: async () => structuredClone(nextSnapshot),
    subscribe: (_config, handlers) => { streamHandlers = handlers; handlers.open(); return () => {}; }
  };
  const runtime = new RaceSourceRuntime({ adapter, storage: null, now: () => Date.parse("2026-09-06T10:03:00.000Z") });
  runtime.configure({ connectorUrl: "http://legacy.test", sourceUrl: "https://event.livefpv.com/", reconcileSeconds: 300 });
  await runtime.setEnabled(true);
  streamHandlers.snapshot(live);

  await runtime.refresh(runtime.generation, true);
  assert.equal(runtime.getState().snapshot.races[0].status, "racing");
  assert.equal(runtime.getState().quality, "fresh");

  nextSnapshot = structuredClone(oldResult);
  nextSnapshot.snapshotId = "legacy-results:2";
  nextSnapshot.capturedAt = "2026-09-06T10:04:00.000Z";
  nextSnapshot.races[0].status = "complete";
  nextSnapshot.races[0].timing.capturedAt = nextSnapshot.capturedAt;
  nextSnapshot.quality.state = "degraded";
  await runtime.refresh(runtime.generation, true);
  assert.equal(runtime.getState().snapshot.races[0].status, "racing");
  assert.equal(runtime.getState().quality, "degraded");

  nextSnapshot = structuredClone(oldResult);
  nextSnapshot.snapshotId = "legacy-results:4";
  nextSnapshot.capturedAt = "2026-09-06T10:05:00.000Z";
  nextSnapshot.races[0].status = "complete";
  nextSnapshot.races[0].timing.capturedAt = nextSnapshot.capturedAt;
  await runtime.refresh(runtime.generation, true);
  assert.equal(runtime.getState().snapshot.races[0].status, "complete");

  adapter.snapshot = async () => { throw new Error("legacy source offline"); };
  await runtime.refresh(runtime.generation, true);
  assert.equal(runtime.getState().snapshot.races[0].status, "complete");
  assert.equal(runtime.getState().connection, "degraded");
  assert.equal(runtime.getState().quality, "degraded");
  runtime.stop();
});
