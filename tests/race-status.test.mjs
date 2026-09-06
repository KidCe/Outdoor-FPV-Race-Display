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
  const expected = [
    ["staging", "STAGING", "staging"],
    ["running", "RUNNING", "current"],
    ["complete", "COMPLETE", "next"]
  ];

  for (const [raw, label, matrixPresetKey] of expected) {
    const candidate = structuredClone(snapshot);
    candidate.races[0].status = raw;
    const scene = display.project(candidate, "current");
    assert.equal(scene.race.status, raw);
    assert.equal(scene.race.statusLabel, label);
    assert.match(scene.header, new RegExp(`^${label}\\b`));
    assert.equal(scene.matrixHeader, "H18/24");
    assert.equal(scene.matrixPresetKey, matrixPresetKey);
    const values = display.getState(scene);
    const visibleHeader = values.find(value => value.key === `header-${matrixPresetKey}`);
    assert.equal(visibleHeader.visible, true);
    assert.equal(visibleHeader.text, "H18/24");
    assert.doesNotMatch(visibleHeader.text, new RegExp(label));
    assert.equal(values.filter(value => value.key.startsWith("header-") && value.visible).length, 1);
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

test("next-up projection keeps the right-arrow group and compact ASCII header", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const afterNext = structuredClone(snapshot.races[1]);
  afterNext.id = "heat-20";
  afterNext.heat = { number: 20, count: 24 };
  snapshot.schedule.afterNextRaceIds = [afterNext.id];
  snapshot.races.push(afterNext);
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const scene = display.project(snapshot, "next");
  const values = display.getState(scene);

  assert.equal(scene.race.id, "heat-20");
  assert.equal(scene.race.status, RACE_STATUS.STAGING);
  assert.equal(scene.matrixPresetKey, "next");
  assert.equal(scene.matrixHeader, "H20/24");
  assert.equal(values.find(value => value.key === "header-next").visible, true);
  assert.equal(values.find(value => value.key === "header-next").text, "H20/24");
  assert.match(scene.matrixHeader, /^[ -~]+$/);
  assert.ok(scene.matrixHeader.length <= 40);
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

test("Hub client rejects a status envelope that contradicts its trusted snapshot", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: null });
  client.apply({ type: "snapshot", hubEpoch: "hub-status-test", eventSessionId: snapshot.eventSessionId, streamSequence: 1, snapshotSequence: 1, deliveredAt: snapshot.capturedAt, data: snapshot });

  const accepted = client.apply({
    type: "status",
    hubEpoch: "hub-status-test",
    eventSessionId: snapshot.eventSessionId,
    streamSequence: 2,
    deliveredAt: snapshot.capturedAt,
    data: { connection: "live", source: "LiveFPV", event: snapshot.event.name, quality: "fresh", raceStatus: "complete" }
  });

  assert.equal(accepted, false);
  assert.equal(client.getState().raceStatus, "running");
  assert.equal(client.getState().snapshot.races[0].status, "running");
  assert.equal(client.getState().needsReset, true);
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

test("cached live status survives an older HTTP bootstrap during restart", async () => {
  const baseline = await fixture("snapshot-fresh.json");
  const cached = structuredClone(baseline);
  cached.snapshotId = "cached-live";
  cached.capturedAt = "2026-09-06T10:01:00.000Z";
  cached.races[0].status = "running";
  cached.races[0].timing = { ...cached.races[0].timing, state: "running", capturedAt: cached.capturedAt, stoppedAt: null };

  const bootstrap = structuredClone(baseline);
  bootstrap.snapshotId = "older-http-result";
  bootstrap.capturedAt = "2026-09-06T10:00:00.000Z";
  bootstrap.races[0].status = "complete";
  bootstrap.races[0].timing = { ...bootstrap.races[0].timing, state: "complete", capturedAt: bootstrap.capturedAt, stoppedAt: bootstrap.capturedAt };
  const storage = {
    value: JSON.stringify({ snapshot: cached, lastDataAt: Date.parse(cached.capturedAt) }),
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
    removeItem() {}
  };
  const adapter = {
    snapshot: async () => structuredClone(bootstrap),
    subscribe(_config, handlers) { handlers.open(); return () => {}; }
  };
  const runtime = new RaceSourceRuntime({ adapter, storage, now: () => Date.parse("2026-09-06T10:02:00.000Z") });
  runtime.configure({ connectorUrl: "http://legacy.test", sourceUrl: "https://event.livefpv.com/" });

  await runtime.setEnabled(true);

  assert.equal(runtime.getState().snapshot.races[0].status, "running");
  runtime.stop();
});

test("status trust does not cross event sessions when event and heat IDs are reused", async () => {
  const baseline = await fixture("snapshot-fresh.json");
  const cached = structuredClone(baseline);
  cached.eventSessionId = "event-session-old";
  cached.snapshotId = "old-session-live";
  cached.capturedAt = "2026-09-06T10:01:00.000Z";
  cached.races[0].status = "running";
  cached.races[0].timing = { ...cached.races[0].timing, state: "running", capturedAt: cached.capturedAt, stoppedAt: null };
  const storage = {
    value: JSON.stringify({ snapshot: cached, lastDataAt: Date.parse(cached.capturedAt) }),
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
    removeItem() {}
  };
  const runtime = new RaceSourceRuntime({ storage, now: () => Date.parse("2026-09-06T10:03:00.000Z") });
  const nextSession = structuredClone(baseline);
  nextSession.eventSessionId = "event-session-new";
  nextSession.snapshotId = "new-session-result";
  nextSession.capturedAt = "2026-09-06T10:02:00.000Z";
  nextSession.quality.state = "degraded";
  nextSession.races[0].status = "complete";
  nextSession.races[0].timing = { ...nextSession.races[0].timing, state: "complete", capturedAt: nextSession.capturedAt, stoppedAt: nextSession.capturedAt };

  runtime.accept(nextSession, { origin: "reconciliation" });

  assert.equal(runtime.getState().snapshot.eventSessionId, "event-session-new");
  assert.equal(runtime.getState().snapshot.races[0].status, "complete");
});
