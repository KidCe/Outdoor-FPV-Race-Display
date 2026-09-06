import test from "node:test";
import assert from "node:assert/strict";
import { adaptConnectorSnapshot, LiveTimeQueHubSource, reconcileConnectorSnapshot } from "../hub/local-server.mjs";
import { validateSnapshot } from "../hub/index.mjs";

const sourceSnapshot = {
  format: "org.fpv.race-event.snapshot",
  version: 1,
  snapshotId: "event-1:revision-1",
  capturedAt: "2026-09-06T10:00:00.000Z",
  event: { id: "event-1", name: "Local Hub Test", source: "https://example.livefpv.com/" },
  source: { kind: "livefpv-results", revision: "revision-1", warnings: [] },
  schedule: { currentRaceId: "race-2", currentIndex: 1, nextRaceIds: [] },
  races: [
    { id: "race-1", order: 0, label: "FPV (Heat 1/2)", phase: "Qualifier", round: "Round 1", status: "complete", links: {}, pilots: [{ id: "pilot-1", callsign: "Pilot One", slot: 1, video: { channel: "R1", frequencyMHz: 5658 } }] },
    { id: "race-2", order: 1, label: "FPV (Heat 2/2)", phase: "Qualifier", round: "Round 1", status: "ready", links: {}, pilots: [{ id: "pilot-2", callsign: "Pilot Two", slot: 1, video: { channel: "F2", frequencyMHz: 5740 } }] }
  ],
  quality: { state: "fresh", completeRaceCount: 1, warnings: [], domains: { schedule: { state: "fresh", capturedAt: "2026-09-06T10:00:00.000Z", sourceIds: ["source-1"] } } }
};

test("local Hub adapter converts the connector contract and preserves pilots/status", () => {
  const snapshot = adaptConnectorSnapshot(sourceSnapshot);
  assert.equal(snapshot.eventSessionId, "livefpv-event-1");
  assert.equal(snapshot.schedule.currentIndex, 1);
  assert.equal(snapshot.races[1].status, "staging");
  assert.equal(snapshot.races[1].pilots[0].callsign, "Pilot Two");
  assert.equal(snapshot.races[1].pilots[0].video.frequencyMHz, 5740);
  assert.deepEqual(validateSnapshot(snapshot), { valid: true, errors: [] });
});

test("Hub source builds the connector snapshot and stream endpoints from one configuration", () => {
  const source = new LiveTimeQueHubSource({ connectorUrl: "http://127.0.0.1:4174/", sourceUrl: "https://example.livefpv.com/" });
  assert.equal(source.snapshotUrl().href, "http://127.0.0.1:4174/api/connectors/race-event/v1/snapshot?sourceUrl=https%3A%2F%2Fexample.livefpv.com%2F&force=1");
  assert.equal(source.streamUrl().href, "http://127.0.0.1:4174/api/connectors/race-event/v1/stream?sourceUrl=https%3A%2F%2Fexample.livefpv.com%2F");
});

test("Hub retains the completed frontier when the source points back to an older completed heat", () => {
  const makeInput = (currentIndex, currentStatus = "complete") => {
    const input = structuredClone(sourceSnapshot);
    input.snapshotId = `event-1:revision-${currentIndex}`;
    input.capturedAt = `2026-09-06T10:00:${String(currentIndex).padStart(2, "0")}.000Z`;
    input.races = Array.from({ length: 12 }, (_, index) => ({
      id: `race-${index + 1}`,
      order: index,
      label: `FPV (Heat ${index + 1}/12)`,
      phase: "Qualifier",
      round: "Round 1",
      status: index === currentIndex ? currentStatus : "complete",
      links: {},
      pilots: []
    })).concat({ id: "race-13", order: 12, label: "FPV (Heat 1/12)", phase: "Qualifier", round: "Round 2", status: "not-run", links: {}, pilots: [] });
    input.schedule = { currentRaceId: `race-${currentIndex + 1}`, currentIndex, nextRaceIds: [], afterNextRaceIds: [] };
    return input;
  };

  const previous = adaptConnectorSnapshot(makeInput(11));
  const staleEarlier = adaptConnectorSnapshot(makeInput(8));
  const retained = reconcileConnectorSnapshot(previous, staleEarlier);
  assert.equal(retained.schedule.currentIndex, 11);
  assert.equal(retained.schedule.currentRaceId, "race-12");
  assert.deepEqual(retained.schedule.nextRaceIds, ["race-13"]);

  const explicitRerun = adaptConnectorSnapshot(makeInput(8, "staging"));
  assert.equal(reconcileConnectorSnapshot(previous, explicitRerun).schedule.currentIndex, 8);
});

test("Hub keeps the last completed frontier when the source points at an unstarted next round", () => {
  const input = structuredClone(sourceSnapshot);
  input.races = [
    { id: "q9-h11", order: 0, label: "FPV (Heat 11/12)", phase: "Qualifier", round: "Qualifier Round 9", status: "complete", links: {}, pilots: [] },
    { id: "q9-h12", order: 1, label: "FPV (Heat 12/12)", phase: "Qualifier", round: "Qualifier Round 9", status: "complete", links: {}, pilots: [] },
    { id: "q10-h1", order: 2, label: "FPV (Heat 1/12)", phase: "Qualifier", round: "Qualifier Round 10", status: "not-run", links: {}, pilots: [] },
    { id: "q10-h2", order: 3, label: "FPV (Heat 2/12)", phase: "Qualifier", round: "Qualifier Round 10", status: "not-run", links: {}, pilots: [] },
    { id: "q10-h3", order: 4, label: "FPV (Heat 3/12)", phase: "Qualifier", round: "Qualifier Round 10", status: "not-run", links: {}, pilots: [] }
  ];
  input.schedule = { currentRaceId: "q10-h1", currentIndex: 2, nextRaceIds: ["q10-h2"] };

  const snapshot = adaptConnectorSnapshot(input);

  assert.equal(snapshot.schedule.currentRaceId, "q9-h12");
  assert.equal(snapshot.schedule.currentIndex, 1);
  assert.deepEqual(snapshot.schedule.nextRaceIds, ["q10-h1", "q10-h2"]);
});

test("Hub keeps an explicitly active rerun selected even when an older frontier is complete", () => {
  const input = structuredClone(sourceSnapshot);
  input.races = [
    { id: "q9-h11", order: 0, label: "FPV (Heat 11/12)", phase: "Qualifier", round: "Qualifier Round 9", status: "complete", links: {}, pilots: [] },
    { id: "q9-h12", order: 1, label: "FPV (Heat 12/12)", phase: "Qualifier", round: "Qualifier Round 9", status: "complete", links: {}, pilots: [] },
    { id: "q9-h9-rerun", order: 2, label: "FPV (Heat 9/12)", phase: "Qualifier", round: "Qualifier Round 9", status: "staging", links: {}, pilots: [] }
  ];
  input.schedule = { currentRaceId: "q9-h9-rerun", currentIndex: 2, nextRaceIds: [] };

  const snapshot = adaptConnectorSnapshot(input);

  assert.equal(snapshot.schedule.currentRaceId, "q9-h9-rerun");
  assert.equal(snapshot.races[snapshot.schedule.currentIndex].status, "staging");
});
