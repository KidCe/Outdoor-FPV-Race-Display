import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts", "race-event", "v1");

async function loadJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}

test("all v1 schemas are valid JSON Schema documents", async () => {
  const names = [
    "snapshot.schema.json",
    "stream-envelope.schema.json",
    "announcement.schema.json",
    "announcement-create.schema.json",
    "announcement-clear.schema.json",
    "history-response.schema.json"
  ];
  for (const name of names) {
    const schema = await loadJson(name);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(typeof schema.$id, "string");
    assert.equal(schema.type, "object");
  }
});

test("fresh snapshot fixture preserves the frozen identity and quality contract", async () => {
  const snapshot = await loadJson("fixtures/snapshot-fresh.json");
  assert.equal(snapshot.format, "org.fpv.race-event.snapshot");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.eventSessionId, "forest-finale-session-1");
  assert.equal(snapshot.schedule.currentRaceId, "heat-18");
  assert.equal(snapshot.races[snapshot.schedule.currentIndex].id, snapshot.schedule.currentRaceId);
  assert.equal(snapshot.quality.state, "fresh");
  assert.equal(snapshot.quality.domains.channels.state, "fresh");
  assert.deepEqual(snapshot.activeAnnouncements, []);
});

test("stale recovery keeps source capture time and marks domains stale", async () => {
  const stale = await loadJson("fixtures/snapshot-stale.json");
  assert.equal(stale.quality.state, "stale");
  assert.equal(stale.capturedAt, "2026-09-06T10:00:00.000Z");
  assert.equal(stale.quality.domains.schedule.state, "stale");
  assert.equal(stale.quality.domains.timing.reason, "source_reconnecting");
});

test("a rerun keeps heat identity and increments the run identity", async () => {
  const rerun = await loadJson("fixtures/snapshot-rerun.json");
  const race = rerun.races[0];
  assert.equal(race.id, "heat-18");
  assert.equal(race.runId, "heat-18-run-2");
  assert.equal(race.attempt, 2);
  assert.equal(race.status, "staging");
  assert.ok(rerun.quality.warnings.some(warning => warning.code === "race.rerun"));
});

test("announcement history and stream fixtures retain global identity", async () => {
  const announcement = await loadJson("fixtures/announcement-active.json");
  const history = await loadJson("fixtures/announcement-history.json");
  const stream = await loadJson("fixtures/stream-announcement.json");
  assert.equal(announcement.eventSessionId, history.eventSessionId);
  assert.ok(history.items.some(item => item.announcementId === announcement.announcementId));
  assert.equal(stream.type, "announcement");
  assert.equal(stream.data.announcementId, announcement.announcementId);
  assert.equal(stream.eventSessionId, announcement.eventSessionId);
});

test("stream sequence is shared at the envelope and reset identifies a new epoch", async () => {
  const announcement = await loadJson("fixtures/stream-announcement.json");
  const reset = await loadJson("fixtures/stream-reset.json");
  assert.equal(typeof announcement.streamSequence, "number");
  assert.equal(reset.type, "reset");
  assert.notEqual(reset.hubEpoch, announcement.hubEpoch);
  assert.equal(reset.data.reason, "epoch_changed");
});

test("public fixtures contain no credentials or write tokens", async () => {
  const fixtureNames = [
    "fixtures/snapshot-fresh.json",
    "fixtures/snapshot-stale.json",
    "fixtures/snapshot-rerun.json",
    "fixtures/announcement-active.json",
    "fixtures/announcement-history.json",
    "fixtures/stream-announcement.json",
    "fixtures/stream-reset.json"
  ];
  for (const name of fixtureNames) {
    const text = await readFile(join(root, name), "utf8");
    assert.doesNotMatch(text, /password|secret|privateKey|writeToken/i, name);
  }
});
