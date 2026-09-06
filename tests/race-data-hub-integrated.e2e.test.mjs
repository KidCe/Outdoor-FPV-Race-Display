import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHubServer, RaceDataHub, SourceObservation, TrustedStore } from "../hub/index.mjs";
import { DisplayScene } from "../web/display-scene.js";
import { RaceDataHubClient, projectHubSnapshot, renderHubAnnouncement } from "../web/race-data-hub-client.js";
import { OutputSession } from "../web/output-session.js";
import { MemoryProfileStorage, RaceDayProfile } from "../web/race-day-profile.js";

const loadFixture = name => readFile(`contracts/race-event/v1/fixtures/${name}`, "utf8").then(JSON.parse);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
}

async function readSseUntil(response, predicate, timeoutMs = 2000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SSE read timed out")), Math.max(1, deadline - Date.now())); });
        const result = await Promise.race([reader.read(), timeout]);
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const lines = block.split(/\r?\n/);
          const event = {
            type: lines.find(line => line.startsWith("event: "))?.slice(7) || "message",
            data: lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n")
          };
          if (!event.data) continue;
          event.data = JSON.parse(event.data);
          events.push(event.data);
          if (predicate(event.data)) return events;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("SSE predicate was not observed.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

class FetchEventSource {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    this.controller = new AbortController();
    this.closed = false;
    this.reader = null;
    this.buffer = "";
    void this.run();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
    this.controller.abort();
    void this.reader?.cancel().catch(() => {});
  }

  dispatch(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ type, data });
  }

  consume(block) {
    const lines = block.split(/\r?\n/);
    const type = lines.find(line => line.startsWith("event: "))?.slice(7) || "message";
    const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
    if (data) this.dispatch(type, data);
  }

  async run() {
    try {
      const response = await fetch(this.url, { signal: this.controller.signal });
      if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
      this.readyState = 1;
      this.onopen?.();
      this.reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!this.closed) {
        const result = await this.reader.read();
        if (result.done) break;
        this.buffer += decoder.decode(result.value, { stream: true });
        const blocks = this.buffer.split(/\r?\n\r?\n/);
        this.buffer = blocks.pop() || "";
        for (const block of blocks) if (!this.closed) this.consume(block);
      }
    } catch (error) {
      if (!this.closed) {
        this.readyState = 2;
        this.onerror?.(error);
      }
    }
  }
}

function makeRace(base, { id, order, heat, phase, round, status, capturedAt, runId = null, attempt } = {}) {
  const race = structuredClone(base.races[0]);
  race.id = id;
  race.order = order;
  race.label = `${phase} (${round} · Heat ${heat}/4)`;
  race.phase = phase;
  race.round = round;
  race.heat = { number: heat, count: 4 };
  race.status = status;
  race.runId = runId;
  if (attempt === undefined) delete race.attempt;
  else race.attempt = attempt;
  race.timing = {
    ...race.timing,
    state: status === "running" ? "running" : status === "staging" ? "staging" : status === "complete" ? "complete" : "unknown",
    capturedAt,
    startedAt: ["running", "complete"].includes(status) ? capturedAt : null,
    stoppedAt: status === "complete" ? capturedAt : null
  };
  return race;
}

function makeSnapshot(base, { snapshotId, capturedAt, sourceId, provider, revision, races, schedule, eventSessionId }) {
  const snapshot = structuredClone(base);
  snapshot.snapshotId = snapshotId;
  snapshot.eventSessionId = eventSessionId;
  snapshot.capturedAt = capturedAt;
  snapshot.event = { id: "aircrasher-forest-2026", name: "Forest Format Integration Replay", organizer: provider, sourceUrl: "https://aircrasher.livefpv.com/" };
  snapshot.sources = [{ id: sourceId, provider, kind: "replayed-race-source", revision, capturedAt, confidence: "high" }];
  snapshot.races = races;
  snapshot.schedule = schedule;
  snapshot.quality = {
    state: "fresh",
    completeRaceCount: races.filter(race => race.status === "complete").length,
    warnings: [],
    domains: Object.fromEntries(Object.keys(base.quality.domains).map(domain => [domain, { state: "fresh", capturedAt, sourceIds: [sourceId] }]))
  };
  snapshot.activeAnnouncements = [];
  return snapshot;
}

class GeneratedSource {
  constructor(items) { this.items = [...items]; }

  async observe(signal) {
    if (signal?.aborted) throw new Error("replay observation was aborted");
    const item = this.items.shift();
    if (item instanceof Error) throw item;
    if (!item) throw new Error("generated replay is exhausted");
    return item instanceof SourceObservation ? item : new SourceObservation({ snapshot: item });
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

test("LiveFPV and LiveTime replay flows through Hub, local and remote consumers, display, and mock WLED", async () => {
  const base = await loadFixture("snapshot-fresh.json");
  const eventSessionId = "integrated-session-1";
  const qualifierCapturedAt = "2026-09-06T10:00:00.000Z";
  const qualifierRaces = [
    makeRace(base, { id: "q1", order: 0, heat: 1, phase: "Qualifier", round: "Qualifier Round 1", status: "staging", capturedAt: qualifierCapturedAt, runId: "q1-run-1", attempt: 1 }),
    makeRace(base, { id: "q2", order: 1, heat: 2, phase: "Qualifier", round: "Qualifier Round 1", status: "scheduled", capturedAt: qualifierCapturedAt }),
    makeRace(base, { id: "q3", order: 2, heat: 3, phase: "Qualifier", round: "Qualifier Round 1", status: "scheduled", capturedAt: qualifierCapturedAt }),
    makeRace(base, { id: "q4", order: 3, heat: 4, phase: "Qualifier", round: "Qualifier Round 1", status: "scheduled", capturedAt: qualifierCapturedAt })
  ];
  const qualifier = makeSnapshot(base, {
    snapshotId: "integrated:qualifier",
    capturedAt: qualifierCapturedAt,
    sourceId: "livefpv-source",
    provider: "LiveFPV",
    revision: "livefpv-qualifier-1",
    races: qualifierRaces,
    schedule: { currentRaceId: "q1", currentIndex: 0, nextRaceIds: ["q2", "q3"], afterNextRaceIds: ["q4"] },
    eventSessionId
  });

  const liveTimeCapturedAt = "2026-09-06T10:00:05.000Z";
  const liveTimeRace = structuredClone(qualifierRaces[0]);
  liveTimeRace.status = "running";
  liveTimeRace.timing = { ...liveTimeRace.timing, state: "running", capturedAt: liveTimeCapturedAt, startedAt: liveTimeCapturedAt, stoppedAt: null };
  const liveTime = new SourceObservation({
    eventSessionId,
    source: { id: "livetime-source", provider: "LiveTime", kind: "scoring-replay", revision: "livetime-1", capturedAt: liveTimeCapturedAt, confidence: "high" },
    capturedAt: liveTimeCapturedAt,
    races: [liveTimeRace],
    quality: { state: "fresh", warnings: [], domains: { timing: { state: "fresh", capturedAt: liveTimeCapturedAt, sourceIds: ["livetime-source"] } } }
  });

  const bracketCapturedAt = "2026-09-06T10:01:00.000Z";
  const bracketRaces = [
    makeRace(base, { id: "b2", order: 2, heat: 2, phase: "Elimination", round: "Upper Bracket", status: "staging", capturedAt: bracketCapturedAt, runId: "b2-run-1", attempt: 1 }),
    makeRace(base, { id: "f1", order: 3, heat: 1, phase: "Final", round: "A Final", status: "scheduled", capturedAt: bracketCapturedAt }),
    makeRace(base, { id: "q1", order: 0, heat: 1, phase: "Qualifier", round: "Qualifier Round 1", status: "complete", capturedAt: bracketCapturedAt, runId: "q1-run-1", attempt: 1 }),
    makeRace(base, { id: "b1", order: 1, heat: 1, phase: "Elimination", round: "Upper Bracket", status: "running", capturedAt: bracketCapturedAt, runId: "b1-run-1", attempt: 1 })
  ];
  const bracket = makeSnapshot(base, {
    snapshotId: "integrated:bracket",
    capturedAt: bracketCapturedAt,
    sourceId: "livefpv-source",
    provider: "LiveFPV",
    revision: "livefpv-bracket-2",
    races: bracketRaces,
    schedule: { currentRaceId: "b1", currentIndex: 3, nextRaceIds: ["b2"], afterNextRaceIds: ["f1"] },
    eventSessionId
  });

  const rerun = structuredClone(bracket);
  rerun.snapshotId = "integrated:rerun";
  rerun.capturedAt = "2026-09-06T10:01:30.000Z";
  rerun.sources[0].revision = "livefpv-rerun-3";
  rerun.sources[0].capturedAt = rerun.capturedAt;
  const rerunRace = rerun.races.find(race => race.id === "b1");
  rerunRace.status = "staging";
  rerunRace.runId = "b1-run-2";
  rerunRace.attempt = 2;
  rerunRace.label += " — Rerun";
  rerunRace.timing = { ...rerunRace.timing, state: "staging", capturedAt: rerun.capturedAt, startedAt: null, stoppedAt: null };
  rerun.quality.warnings = [{ code: "race.rerun", message: "Upper bracket heat 1 was reopened for run 2.", severity: "info" }];

  const final = structuredClone(rerun);
  final.snapshotId = "integrated:final";
  final.capturedAt = "2026-09-06T10:02:00.000Z";
  final.sources[0].revision = "livefpv-final-4";
  final.sources[0].capturedAt = final.capturedAt;
  const finalRace = final.races.find(race => race.id === "f1");
  finalRace.status = "running";
  finalRace.runId = "f1-run-1";
  finalRace.attempt = 1;
  finalRace.timing = { ...finalRace.timing, state: "running", capturedAt: final.capturedAt, startedAt: final.capturedAt, stoppedAt: null };
  const unknownPilot = { ...finalRace.pilots[0], id: "open-final-slot", callsign: "OpenSlot" };
  delete unknownPilot.video;
  finalRace.pilots[0] = unknownPilot;
  final.schedule = { currentRaceId: "f1", currentIndex: 1, nextRaceIds: [], afterNextRaceIds: [] };
  final.quality.warnings = [{ code: "lineup.unknown", message: "One final slot has no source-confirmed channel.", severity: "warning" }];
  const mismatched = structuredClone(final);
  mismatched.eventSessionId = "different-session";

  const source = new GeneratedSource([qualifier, liveTime, bracket, rerun, new Error("LiveFPV disconnected"), final, mismatched]);
  const directory = await mkdtemp(join(tmpdir(), "race-hub-integrated-"));
  const persistencePath = join(directory, "trusted.json");
  const store = new TrustedStore({ epoch: "hub-integrated-1", persistencePath, historyLimit: 64 });
  const hub = new RaceDataHub({ source, store });
  const localServer = createHubServer({ store, writePassword: "event-lan-secret", heartbeatMs: 0 });
  const localPort = await listen(localServer);
  const remoteServer = createHubServer({ store, writePassword: "event-lan-secret", heartbeatMs: 0 });
  const remotePort = await listen(remoteServer);
  const localStorage = memoryStorage();
  let displayClient;
  let queueClient;
  let output;
  try {
    await hub.start({ eventSessionId, event: qualifier.event });
    await waitFor(async () => {
      try { return JSON.parse(await readFile(persistencePath)).trustedSnapshot?.snapshotId === qualifier.snapshotId; }
      catch { return false; }
    }, "automatic trusted snapshot persistence");

    displayClient = new RaceDataHubClient({ hubUrl: `http://127.0.0.1:${localPort}`, EventSourceImpl: FetchEventSource, storage: localStorage });
    queueClient = new RaceDataHubClient({ hubUrl: `http://127.0.0.1:${remotePort}`, EventSourceImpl: FetchEventSource, storage: null });
    assert.equal(await displayClient.connect(), true);
    assert.equal(await queueClient.connect(), true);
    await waitFor(() => displayClient.getState().snapshot?.snapshotId === qualifier.snapshotId, "display bootstrap snapshot");
    await waitFor(() => queueClient.getState().snapshot?.snapshotId === qualifier.snapshotId, "LiveTimeQue bootstrap snapshot");
    await waitFor(() => displayClient.getState().streamSequence > 0 && queueClient.getState().streamSequence > 0 && displayClient.getState().streamSequence === queueClient.getState().streamSequence, "identical consumer stream ordering");
    assert.equal(displayClient.getState().streamSequence, queueClient.getState().streamSequence);
    assert.deepEqual(Object.fromEntries(Object.entries(projectHubSnapshot(displayClient.getState().snapshot)).map(([key, race]) => [key, race?.id || null])), { current: "q1", staging: "q2", next: "q3", afterNext: "q4" });

    const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
    const display = new DisplayScene(profile);
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
    output = new OutputSession({ adapterFactory });
    output.configure(profile.output);
    output.setLive(true);
    await output.setEnabled(true);
    const initialScene = display.project(displayClient.getState().snapshot, "current");
    await output.publish(display.getSchema(), display.getState(initialScene));
    assert.equal(initialScene.race.id, "q1");
    assert.ok(operations.findIndex(command => command.op === "schema.commit") < operations.findIndex(command => command.op === "state"));
    assert.equal(output.getState().controlling, true);

    await hub.refresh();
    await waitFor(() => displayClient.getState().snapshot?.snapshotId.startsWith("hub-integrated-session-1-livetime-1"), "LiveTime timing observation");
    assert.equal(displayClient.getState().snapshot.races.find(race => race.id === "q1").status, "running");
    assert.equal(displayClient.getState().snapshot.sources.length, 2);

    await hub.refresh();
    await waitFor(() => displayClient.getState().snapshot?.snapshotId === bracket.snapshotId, "bracket snapshot");
    const bracketScene = display.project(displayClient.getState().snapshot, "current");
    assert.equal(bracketScene.race.id, "b1");
    assert.deepEqual(bracketScene.schedule.slice(0, 3).map(race => race.id), ["b1", "b2", "f1"]);
    assert.equal(display.project(displayClient.getState().snapshot, "staging").race.id, "b2");
    assert.equal(display.project(displayClient.getState().snapshot, "next").race.id, "f1");

    const replayFrom = store.streamSequence;
    await hub.refresh();
    await waitFor(() => displayClient.getState().snapshot?.snapshotId === rerun.snapshotId, "rerun snapshot");
    assert.equal(displayClient.getState().snapshot.races.find(race => race.id === "b1").runId, "b1-run-2");
    const replayResponse = await fetch(`http://127.0.0.1:${localPort}/api/v1/stream`, { headers: { "last-event-id": String(replayFrom), "x-hub-epoch": store.hubEpoch, "x-event-session-id": eventSessionId } });
    const replayed = await readSseUntil(replayResponse, event => event.type === "snapshot" && event.data.snapshotId === rerun.snapshotId);
    assert.equal(replayed.some(event => event.type === "reset"), false);
    assert.ok(replayed.some(event => event.type === "snapshot" && event.data.snapshotId === rerun.snapshotId));

    const unauthorised = await fetch(`http://127.0.0.1:${localPort}/api/v1/announcements`, { method: "POST", headers: { "content-type": "application/json", "x-event-write-password": "wrong" }, body: JSON.stringify({ title: "Race", body: "Do not show", importance: 3, createdByDeviceId: "manager" }) });
    assert.equal(unauthorised.status, 401);
    const malformed = await fetch(`http://127.0.0.1:${localPort}/api/v1/announcements`, { method: "POST", headers: { "content-type": "application/json", "x-event-write-password": "event-lan-secret" }, body: "{" });
    assert.equal(malformed.status, 400);
    const createdResponse = await fetch(`http://127.0.0.1:${localPort}/api/v1/announcements`, { method: "POST", headers: { "content-type": "application/json", "x-event-write-password": "event-lan-secret" }, body: JSON.stringify({ title: "Channels changed", body: "PilotOne R1 -> R8", importance: 3, createdByDeviceId: "race-manager" }) });
    assert.equal(createdResponse.status, 201);
    const createdAnnouncement = await createdResponse.json();
    await waitFor(() => displayClient.getState().announcements.some(item => item.announcementId === createdAnnouncement.announcementId), "display announcement");
    await waitFor(() => queueClient.getState().announcements.some(item => item.announcementId === createdAnnouncement.announcementId), "LiveTimeQue announcement");
    const history = await (await fetch(`http://127.0.0.1:${localPort}/api/v1/announcements/history`)).json();
    assert.equal(history.items[0].status, "active");
    const clearResponse = await fetch(`http://127.0.0.1:${localPort}/api/v1/announcements/${encodeURIComponent(createdAnnouncement.announcementId)}/clear`, { method: "POST", headers: { "x-event-write-password": "event-lan-secret" } });
    assert.equal(clearResponse.status, 200);
    await waitFor(() => displayClient.getState().announcements.length === 0, "global announcement clear on display");
    await waitFor(() => queueClient.getState().announcements.length === 0, "global announcement clear on LiveTimeQue");
    const clearedHistory = await (await fetch(`http://127.0.0.1:${localPort}/api/v1/announcements/history`)).json();
    assert.equal(clearedHistory.items[0].status, "cleared");

    await assert.rejects(() => hub.refresh(), /LiveFPV disconnected/);
    await waitFor(() => displayClient.getState().quality === "stale", "stale Hub snapshot");
    assert.equal(displayClient.getState().connection, "reconnecting");
    assert.equal(displayClient.getState().snapshot.snapshotId, rerun.snapshotId);
    assert.equal(displayClient.getState().snapshot.capturedAt, rerun.capturedAt);
    assert.equal(queueClient.getState().snapshot.snapshotId, rerun.snapshotId);

    await hub.refresh();
    await waitFor(() => displayClient.getState().snapshot?.snapshotId === final.snapshotId, "final snapshot");
    const finalScene = display.project(displayClient.getState().snapshot, "current");
    assert.equal(finalScene.race.id, "f1");
    assert.equal(finalScene.race.pilots[0].channel, "");
    const missingNextScene = display.project(displayClient.getState().snapshot, "staging");
    assert.equal(missingNextScene.race, null);
    assert.equal(display.getState(missingNextScene).filter(value => value.text).length, 0);
    await output.publish(display.getSchema(), display.getState(missingNextScene));
    assert.equal(output.getState().controlling, true);

    assert.throws(() => displayClient.apply({ type: "heartbeat", hubEpoch: store.hubEpoch, eventSessionId, streamSequence: displayClient.getState().streamSequence + 1, deliveredAt: final.capturedAt, data: {}, unexpected: true }), /unsupported field/);
    const trustedBeforeMismatch = displayClient.getState().snapshot.snapshotId;
    await assert.rejects(() => hub.refresh(), /event session mismatch/);
    await waitFor(() => displayClient.getState().quality === "stale", "mismatched source degradation");
    assert.equal(displayClient.getState().snapshot.snapshotId, trustedBeforeMismatch);

    const maliciousAnnouncement = { ...createdAnnouncement, title: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script>" };
    const oldDocument = globalThis.document;
    const textNodes = { strong: {}, p: {}, small: {} };
    const rendered = { className: "", dataset: {}, innerHTML: "", querySelector: selector => textNodes[selector] };
    globalThis.document = { createElement: () => rendered };
    try {
      renderHubAnnouncement(maliciousAnnouncement, { container: { prepend: () => {} } });
      assert.equal(textNodes.strong.textContent, maliciousAnnouncement.title);
      assert.equal(textNodes.p.textContent, maliciousAnnouncement.body);
    } finally {
      globalThis.document = oldDocument;
    }

    const restored = new TrustedStore({ persistencePath, epoch: "hub-integrated-restarted" });
    const recovered = await restored.restore();
    assert.equal(recovered.snapshotId, final.snapshotId);
    assert.equal(recovered.quality.state, "stale");
    assert.equal(recovered.capturedAt, final.capturedAt);

    const deactivate = await fetch(`http://127.0.0.1:${localPort}/api/v1/admin/event/deactivate`, { method: "POST", headers: { "content-type": "application/json", "x-event-write-password": "event-lan-secret" }, body: "{}" });
    assert.equal(deactivate.status, 200);
    await waitFor(() => displayClient.getState().snapshot === null && displayClient.getState().connection === "disabled", "event deactivation on display");
    await waitFor(() => queueClient.getState().snapshot === null && queueClient.getState().connection === "disabled", "event deactivation on LiveTimeQue");
    assert.equal((await fetch(`http://127.0.0.1:${localPort}/api/v1/snapshot`)).status, 404);
    await waitFor(async () => (JSON.parse(await readFile(persistencePath)).activeEvent === null), "persisted event deactivation");

    output.setLive(false);
    await sleep(20);
    assert.ok(operations.some(command => command.op === "activate" && command.active === false));
  } finally {
    displayClient?.close();
    queueClient?.close();
    await output?.setEnabled(false).catch(() => {});
    await closeServer(remoteServer);
    await closeServer(localServer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP SSE emits deterministic reset envelopes for history gaps and hub epoch changes", async () => {
  const snapshot = await loadFixture("snapshot-fresh.json");
  const gapStore = new TrustedStore({ eventSessionId: snapshot.eventSessionId, epoch: "hub-gap", historyLimit: 2 });
  gapStore.publish(snapshot);
  gapStore.publish({ ...snapshot, snapshotId: "forest-finale-session-1:gap-2" });
  const gapServer = createHubServer({ store: gapStore, heartbeatMs: 0 });
  const gapPort = await listen(gapServer);
  const epochStore = new TrustedStore({ eventSessionId: snapshot.eventSessionId, epoch: "hub-new-epoch" });
  epochStore.publish(snapshot);
  const epochServer = createHubServer({ store: epochStore, heartbeatMs: 0 });
  const epochPort = await listen(epochServer);
  try {
    const gapResponse = await fetch(`http://127.0.0.1:${gapPort}/api/v1/stream`, { headers: { "last-event-id": "0", "x-hub-epoch": "hub-gap", "x-event-session-id": snapshot.eventSessionId } });
    const gapEvents = await readSseUntil(gapResponse, event => event.type === "snapshot");
    assert.equal(gapEvents[0].type, "reset");
    assert.equal(gapEvents[0].data.reason, "history_gap");
    assert.ok(gapEvents.some(event => event.type === "snapshot"));
    assert.equal(gapEvents.every((event, index) => index === 0 || event.streamSequence > gapEvents[index - 1].streamSequence), true);

    const epochResponse = await fetch(`http://127.0.0.1:${epochPort}/api/v1/stream`, { headers: { "last-event-id": "99", "x-hub-epoch": "hub-old-epoch", "x-event-session-id": snapshot.eventSessionId } });
    const epochEvents = await readSseUntil(epochResponse, event => event.type === "snapshot");
    assert.equal(epochEvents[0].type, "reset");
    assert.equal(epochEvents[0].data.reason, "epoch_changed");
    assert.ok(epochEvents.some(event => event.hubEpoch === "hub-new-epoch" && event.type === "snapshot"));
    assert.equal(epochEvents.every((event, index) => index === 0 || event.streamSequence > epochEvents[index - 1].streamSequence), true);
  } finally {
    await closeServer(epochServer);
    await closeServer(gapServer);
  }
});
