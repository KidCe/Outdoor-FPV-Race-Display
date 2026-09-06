import test from "node:test";
import assert from "node:assert/strict";
import { RaceDataHubClient, projectHubSnapshot, validateHubEnvelope, validateHubSnapshot, renderHubAnnouncement } from "../web/race-data-hub-client.js";
import { RaceSourceRuntime } from "../web/race-source-runtime.js";
import fs from "node:fs/promises";

const fixture = name => fs.readFile(`contracts/race-event/v1/fixtures/${name}`, "utf8").then(JSON.parse);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  fail() {
    this.readyState = 2;
    this.onerror?.(new Error("stream interrupted"));
  }

  close() {
    this.readyState = 2;
  }
}

test("Hub validates fixtures and projects current, staging, and next", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const projection = projectHubSnapshot(snapshot);
  assert.equal(projection.current.id, "heat-18");
  assert.equal(projection.staging.id, "heat-19");
  assert.equal(projection.next, null);
  assert.equal(projection.afterNext, null);
  assert.equal(validateHubEnvelope(await fixture("stream-reset.json")).type, "reset");
});

test("Hub consumer rejects inconsistent current identity and inactive active announcements", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  assert.throws(() => validateHubSnapshot({ ...snapshot, schedule: { ...snapshot.schedule, currentIndex: null } }), /current race fields/);
  assert.throws(() => validateHubSnapshot({ ...snapshot, event: { ...snapshot.event, sourceUrl: "https://race.test/live?token=should-not-be-stored" } }), /invalid/);
  assert.throws(() => validateHubSnapshot({ ...snapshot, capturedAt: "September 6, 2026" }), /invalid/);
  const announcement = await fixture("announcement-active.json");
  assert.throws(() => validateHubSnapshot({ ...snapshot, activeAnnouncements: [{ ...announcement, status: "cleared", clearedAt: announcement.createdAt }] }), /not active/);
});

test("Hub preserves an explicit no-active-heat state without inventing a projection", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  snapshot.schedule.currentRaceId = null;
  snapshot.schedule.currentIndex = null;
  const projection = projectHubSnapshot(snapshot);
  assert.equal(projection.current, null);
  assert.equal(projection.staging.id, "heat-19");
  assert.equal(projection.next, null);
  assert.equal(projection.afterNext, null);
});

test("Hub projection keeps optional queue sections ordered without duplicating a race", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const nextRace = structuredClone(snapshot.races[1]);
  nextRace.id = "heat-20";
  nextRace.order = 19;
  snapshot.races.push(nextRace);
  snapshot.schedule.nextRaceIds = ["heat-19"];
  snapshot.schedule.afterNextRaceIds = ["heat-19", "heat-20"];
  const projection = projectHubSnapshot(snapshot);
  assert.equal(projection.staging.id, "heat-19");
  assert.equal(projection.next.id, "heat-20");
  assert.equal(projection.afterNext, null);
});

test("Hub client keeps stale snapshots, rejects gaps, and orders announcements", async () => {
  const snapshot = await fixture("snapshot-stale.json");
  const announcement = await fixture("stream-announcement.json");
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test" });
  client.acceptSnapshot(snapshot);
  assert.equal(client.getState().quality, "stale");
  client.apply({ ...announcement, streamSequence: 1 });
  assert.equal(client.getState().announcements[0].importance, 3);
  assert.equal(client.apply({ ...announcement, streamSequence: 3 }), false);
  assert.equal(client.getState().needsReset, true);
  assert.match(client.getState().error, /gap/);
});

test("Hub bootstrap imports active announcements and local recovery is stale", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  snapshot.activeAnnouncements = [await fixture("announcement-active.json")];
  const storage = new Map();
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }) });
  await client.bootstrap();
  assert.equal(client.getState().announcements[0].announcementId, "ann-h18-channels-1");
  const recovered = new RaceDataHubClient({ hubUrl: "http://hub.test", storage: { getItem: key => storage.get(key) || null } });
  assert.equal(recovered.getState().quality, "stale");
  assert.equal(recovered.getState().snapshot.quality.state, "stale");
  assert.equal(recovered.getState().snapshot.capturedAt, snapshot.capturedAt);
});

test("Hub trusted-data clearing removes the in-memory snapshot and cache", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage });
  client.acceptSnapshot(snapshot);
  assert.ok(values.has("fpv-race-hub-trusted-v1"));
  client.clearTrustedSnapshot();
  assert.equal(client.getState().snapshot, null);
  assert.equal(client.getState().announcements.length, 0);
  assert.equal(values.has("fpv-race-hub-trusted-v1"), false);
});

test("Hub announcement changes update the recoverable trusted snapshot", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const announcement = await fixture("stream-announcement.json");
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", storage });
  client.acceptSnapshot(snapshot);
  client.apply({ ...announcement, streamSequence: 1 });
  assert.equal(JSON.parse(values.get("fpv-race-hub-trusted-v1")).snapshot.activeAnnouncements[0].announcementId, announcement.data.announcementId);
  client.apply({ type: "announcement-clear", hubEpoch: announcement.hubEpoch, eventSessionId: snapshot.eventSessionId, streamSequence: 2, deliveredAt: announcement.deliveredAt, data: { announcementId: announcement.data.announcementId, clearedAt: announcement.deliveredAt } });
  assert.deepEqual(JSON.parse(values.get("fpv-race-hub-trusted-v1")).snapshot.activeAnnouncements, []);
});

test("Hub reset clears the old state before accepting the new epoch", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const reset = await fixture("stream-reset.json");
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test" });
  client.apply({ type: "snapshot", hubEpoch: "hub-2026-09-06-01", eventSessionId: snapshot.eventSessionId, streamSequence: 1, snapshotSequence: 1, deliveredAt: snapshot.capturedAt, data: snapshot });
  assert.equal(client.getState().snapshot.snapshotId, snapshot.snapshotId);
  client.apply(reset);
  assert.equal(client.getState().snapshot, null);
  assert.equal(client.getState().streamSequence, 1);
  client.apply({ ...reset, type: "snapshot", streamSequence: 2, snapshotSequence: 2, data: snapshot });
  assert.equal(client.getState().snapshot.snapshotId, snapshot.snapshotId);
});

test("Hub rejects an event-session change that is not introduced by reset", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const announcement = await fixture("stream-announcement.json");
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test" });
  client.acceptSnapshot(snapshot);
  assert.equal(client.apply({ ...announcement, eventSessionId: "other-session", data: { ...announcement.data, eventSessionId: "other-session" }, streamSequence: 1 }), false);
  assert.equal(client.getState().snapshot.snapshotId, snapshot.snapshotId);
  assert.equal(client.getState().needsReset, true);
});

test("Hub bootstrap failure enters reconnecting state and can be stopped", async () => {
  const client = new RaceDataHubClient({ hubUrl: "http://hub.test", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await client.connect(), false);
  assert.equal(client.getState().connection, "error");
  client.close();
  assert.equal(client.getState().connection, "disabled");
});

test("Hub stream reconnect preserves stale data until a fresh bootstrap succeeds", async () => {
  const first = await fixture("snapshot-fresh.json");
  const second = structuredClone(first);
  second.snapshotId = "forest-finale-session-1:reconnected";
  second.capturedAt = "2026-09-06T10:01:00.000Z";
  let bootstrapCount = 0;
  FakeEventSource.instances = [];
  const client = new RaceDataHubClient({
    hubUrl: "http://hub.test",
    storage: null,
    EventSourceImpl: FakeEventSource,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => structuredClone(bootstrapCount++ === 0 ? first : second) })
  });
  try {
    assert.equal(await client.connect(), true);
    const initialStream = FakeEventSource.instances[0];
    initialStream.open();
    assert.equal(client.getState().snapshot.snapshotId, first.snapshotId);
    initialStream.fail();
    assert.equal(client.getState().connection, "reconnecting");
    assert.equal(client.getState().snapshot.snapshotId, first.snapshotId);
    const deadline = Date.now() + 3000;
    while (FakeEventSource.instances.length < 2 && Date.now() < deadline) await wait(25);
    assert.equal(FakeEventSource.instances.length >= 2, true);
    assert.equal(client.getState().snapshot.snapshotId, second.snapshotId);
    assert.equal(bootstrapCount, 2);
    FakeEventSource.instances[1].open();
    assert.equal(client.getState().connection, "live");
  } finally {
    client.close();
  }
});

test("RaceSourceRuntime routes Hub mode through the Hub client and keeps output-independent state", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  let legacyCalled = false; let closed = false;
  const runtime = new RaceSourceRuntime({ storage: null, adapter: { snapshot: async () => { legacyCalled = true; throw new Error("legacy path used"); } }, hubClientFactory: options => ({
    getState: () => ({ connection: "reconnecting", snapshot, quality: "stale", lastDataAt: 10, sourceCapturedAt: snapshot.capturedAt, announcements: [], error: "" }),
    async connect() { options.onState({ connection: "live", snapshot, quality: "fresh", lastDataAt: 20, sourceCapturedAt: snapshot.capturedAt, announcements: [], error: "" }); },
    close() { closed = true; }
  }) });
  runtime.configure({ hubUrl: "http://hub.test", sourceUrl: "ignored" });
  await runtime.setEnabled(true);
  assert.equal(legacyCalled, false);
  assert.equal(runtime.getState().snapshot.snapshotId, snapshot.snapshotId);
  assert.equal(runtime.getState().connection, "connected");
  runtime.stop();
  assert.equal(closed, true);
});

test("importance 3 announcement rendering is persistent", async () => {
  const announcement = (await fixture("announcement-active.json"));
  const elements = [];
  const container = { prepend: item => elements.push(item) };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ className: "", dataset: {}, innerHTML: "", querySelector: () => ({ textContent: "" }) }) };
  try { renderHubAnnouncement(announcement, { container }); assert.equal(elements.length, 1); assert.match(elements[0].className, /persistent/); } finally { globalThis.document = oldDocument; }
});
