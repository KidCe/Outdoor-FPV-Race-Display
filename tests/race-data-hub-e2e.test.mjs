import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DisplayScene } from "../web/display-scene.js";
import { OutputSession } from "../web/output-session.js";
import { RaceDayProfile, MemoryProfileStorage } from "../web/race-day-profile.js";
import { RaceDataHubClient, projectHubSnapshot } from "../web/race-data-hub-client.js";

const loadFixture = name => fs.readFile(`contracts/race-event/v1/fixtures/${name}`, "utf8").then(JSON.parse);

function streamSnapshot(snapshot, sequence, hubEpoch = "hub-e2e-1") {
  return { type: "snapshot", hubEpoch, eventSessionId: snapshot.eventSessionId, streamSequence: sequence, snapshotSequence: sequence, deliveredAt: snapshot.capturedAt, data: snapshot };
}

function streamStatus(snapshot, sequence, connection, quality, message = "") {
  return { type: "status", hubEpoch: "hub-e2e-1", eventSessionId: snapshot.eventSessionId, streamSequence: sequence, deliveredAt: snapshot.capturedAt, data: { connection, source: "LiveFPV", event: snapshot.event.name, quality, message } };
}

function addScheduledRace(snapshot, id, number, order) {
  const race = structuredClone(snapshot.races[1]);
  race.id = id; race.runId = null; race.attempt = undefined; race.order = order; race.label = `Qualifier (Heat ${number}/24)`; race.heat = { number, count: 24 }; race.status = "scheduled"; race.pilots = structuredClone(snapshot.races[0].pilots); return race;
}

test("replayed Hub data drives display projection through heat changes, reruns, corrections, and stale recovery", async () => {
  const initial = await loadFixture("snapshot-fresh.json");
  initial.races[1].pilots = structuredClone(initial.races[0].pilots);
  initial.races.push(addScheduledRace(initial, "heat-20", 20, 19), addScheduledRace(initial, "heat-21", 21, 20));
  initial.schedule.nextRaceIds = ["heat-19", "heat-20"];
  initial.schedule.afterNextRaceIds = ["heat-21"];
  const advanced = structuredClone(initial);
  advanced.snapshotId = "forest-finale-session-1:43"; advanced.capturedAt = "2026-09-06T10:01:00.000Z"; advanced.schedule.currentRaceId = "heat-19"; advanced.schedule.currentIndex = 1;
  advanced.schedule.nextRaceIds = ["heat-20", "heat-21"]; advanced.schedule.afterNextRaceIds = [];
  advanced.races[0].status = "complete"; advanced.races[1].status = "running"; advanced.races[2].status = "staging";
  const rerun = structuredClone(advanced);
  rerun.snapshotId = "forest-finale-session-1:44"; rerun.capturedAt = "2026-09-06T10:02:00.000Z"; rerun.races[1].runId = "heat-19-run-2"; rerun.races[1].attempt = 2; rerun.races[1].status = "staging"; rerun.races[1].label += " — Rerun";
  rerun.quality.warnings = [{ code: "race.rerun", message: "Heat 19 was reopened by the source as run 2.", severity: "info" }];
  const corrected = structuredClone(rerun);
  corrected.snapshotId = "forest-finale-session-1:45"; corrected.capturedAt = "2026-09-06T10:03:00.000Z"; corrected.races[1].pilots[0].callsign = "PilotOneCorrected";

  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: null });
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  client.apply(streamSnapshot(initial, 1));
  assert.equal(projectHubSnapshot(client.getState().snapshot).current.id, "heat-18");
  assert.equal(projectHubSnapshot(client.getState().snapshot).next.id, "heat-20");
  assert.equal(projectHubSnapshot(client.getState().snapshot).afterNext.id, "heat-21");
  assert.equal(display.project(client.getState().snapshot, "current").race.id, "heat-18");

  client.apply(streamSnapshot(advanced, 2));
  assert.equal(display.project(client.getState().snapshot, "current").race.id, "heat-19");
  assert.equal(display.project(client.getState().snapshot, "current").schedule[1].id, "heat-20");
  assert.equal(display.project(client.getState().snapshot, "current").schedule[2].id, "heat-21");
  client.apply(streamSnapshot(rerun, 3));
  assert.equal(client.getState().snapshot.races[1].id, "heat-19");
  assert.equal(client.getState().snapshot.races[1].runId, "heat-19-run-2");
  client.apply(streamSnapshot(corrected, 4));
  assert.equal(display.project(client.getState().snapshot, "current").race.pilots[0].callsign, "PilotOneCorrected");

  client.apply(streamStatus(corrected, 5, "reconnecting", "stale", "Hub source is reconnecting."));
  assert.equal(client.getState().snapshot.snapshotId, corrected.snapshotId);
  assert.equal(client.getState().quality, "stale");
  client.apply(streamStatus(corrected, 6, "live", "fresh"));
  assert.equal(client.getState().snapshot.snapshotId, corrected.snapshotId);
  assert.equal(client.getState().connection, "live");
});

test("replayed Hub announcements reach the display consumer and global clear removes them", async () => {
  const snapshot = await loadFixture("snapshot-fresh.json");
  const announcement = await loadFixture("stream-announcement.json");
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: null });
  client.apply(streamSnapshot(snapshot, 1));
  client.apply({ ...announcement, streamSequence: 2, hubEpoch: "hub-e2e-1" });
  assert.equal(client.getState().announcements[0].announcementId, announcement.data.announcementId);
  client.apply({ type: "announcement-clear", hubEpoch: "hub-e2e-1", eventSessionId: snapshot.eventSessionId, streamSequence: 3, deliveredAt: announcement.deliveredAt, data: { announcementId: announcement.data.announcementId, clearedAt: announcement.deliveredAt } });
  assert.deepEqual(client.getState().announcements, []);
});

test("display output remains safe when the Hub consumer publishes a replayed scene", async () => {
  const snapshot = await loadFixture("snapshot-rerun.json");
  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) { const command = JSON.parse(text).fpv; operations.push(command.op); queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true, code: "ok" } }))); }
  });
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: null });
  client.apply(streamSnapshot(snapshot, 1));
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile); const session = new OutputSession({ adapterFactory }); session.configure(profile.output); session.setLive(true); await session.setEnabled(true);
  await session.publish(display.getSchema(), display.getState(display.project(client.getState().snapshot, "current")));
  assert.equal(session.getState().controlling, true);
  assert.ok(operations.includes("state"));
  await session.setEnabled(false);
});
