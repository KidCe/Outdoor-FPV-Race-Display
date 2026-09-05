import test from "node:test";
import assert from "node:assert/strict";
import { createRaceEventStreamUrl, fetchRaceEventSnapshot, validateRaceEventSnapshot } from "../web/race-event-connector.js";

const snapshot = {
  format: "org.fpv.race-event.snapshot",
  version: 1,
  snapshotId: "event:revision:race",
  capturedAt: "2026-09-05T10:00:00.000Z",
  deliveredAt: "2026-09-05T10:00:01.000Z",
  event: { id: "event", name: "Test Cup", sourceUrl: "https://test.livefpv.com" },
  source: { provider: "LiveFPV / LiveTime", kind: "livefpv-results", revision: "revision" },
  schedule: { currentRaceId: "race", currentIndex: 0, nextRaceIds: [] },
  races: [{ id: "race", order: 0, label: "Qualifier (Heat 2/4)", phase: "Qualifier", round: "Qualifier Round 1", heat: { number: 2, count: 4 }, status: "racing", links: {}, pilots: [{ id: "kidce", callsign: "KidCe", slot: 1, open: false, bumpUp: false, video: { channel: "F4", band: "F", number: 4, frequencyMHz: 5800 } }] }],
  quality: { state: "fresh", completeRaceCount: 1, warnings: [] }
};

test("rejects a snapshot whose current race fields disagree", () => {
  const invalid = structuredClone(snapshot);
  invalid.schedule.currentRaceId = "other";
  assert.throws(() => validateRaceEventSnapshot(invalid), /inconsistent current race/);
});

test("builds the versioned LiveTimeQue connector request", async () => {
  let requested;
  const result = await fetchRaceEventSnapshot({
    connectorUrl: "http://localhost:4174/ignored/path",
    sourceUrl: "https://test.livefpv.com/",
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, status: 200, json: async () => snapshot };
    }
  });
  assert.equal(result.snapshotId, snapshot.snapshotId);
  assert.equal(requested.pathname, "/api/connectors/race-event/v1/snapshot");
  assert.equal(requested.searchParams.get("sourceUrl"), "https://test.livefpv.com/");
});

test("builds the standardized live stream request", () => {
  const url = new URL(createRaceEventStreamUrl({ connectorUrl: "http://localhost:4174", sourceUrl: "https://test.livefpv.com/" }));
  assert.equal(url.pathname, "/api/connectors/race-event/v1/stream");
  assert.equal(url.searchParams.get("sourceUrl"), "https://test.livefpv.com/");
});
