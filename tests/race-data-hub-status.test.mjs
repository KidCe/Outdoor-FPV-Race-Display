import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LiveFPVAdapter,
  RaceDataHub,
  RaceStateAssembler,
  SourceObservation,
  TrustedStore,
  createHubServer,
  normalizeRaceStatus
} from '../hub/index.mjs';
import { RaceDataHubClient, validateHubEnvelope } from '../web/race-data-hub-client.js';

const fixture = async name => JSON.parse(await readFile(new URL(`../contracts/race-event/v1/fixtures/${name}`, import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

function statusFrame(base, status, sequence) {
  const snapshot = structuredClone(base);
  snapshot.snapshotId = `status-transition:${sequence}`;
  snapshot.capturedAt = `2026-09-06T10:0${sequence}:00.000Z`;
  snapshot.sources[0].revision = `status-revision-${sequence}`;
  snapshot.sources[0].capturedAt = snapshot.capturedAt;
  const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
  current.status = status;
  if (status === 'complete') {
    current.timing = { ...current.timing, state: 'complete', capturedAt: snapshot.capturedAt, stoppedAt: snapshot.capturedAt };
  } else {
    current.timing = { ...current.timing, state: status, capturedAt: snapshot.capturedAt, stoppedAt: null };
  }
  snapshot.quality.domains = Object.fromEntries(Object.entries(snapshot.quality.domains).map(([domain, value]) => [domain, { ...value, capturedAt: snapshot.capturedAt }]));
  snapshot.quality.state = 'fresh';
  snapshot.quality.warnings = [];
  return snapshot;
}

async function collectSseUntil(response, predicate, timeoutMs = 2000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const timer = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) throw new Error('SSE stream ended before the expected event.');
      buffer += decoder.decode(result.value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();
      for (const block of blocks) {
        const line = block.split('\n').find(value => value.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (predicate(event, events)) return events;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}

test('source status normalization preserves canonical values and maps legacy labels explicitly', async () => {
  const base = await fixture('snapshot-fresh.json');
  const mapping = new Map([
    ['staging', 'staging'],
    ['running', 'running'],
    ['complete', 'complete'],
    ['ready', 'staging'],
    ['racing', 'running'],
    ['not-run', 'not_run'],
    ['Not Yet Run', 'not_run']
  ]);
  for (const [sourceValue, canonical] of mapping) {
    const snapshot = statusFrame(base, canonical, 1);
    const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
    current.status = sourceValue;
    if (sourceValue === 'ready' || sourceValue === 'racing') current.timing.state = sourceValue;
    if (sourceValue === 'not-run' || sourceValue === 'Not Yet Run') delete current.timing;
    const observation = new SourceObservation({ snapshot });
    const candidate = new RaceStateAssembler({ eventSessionId: base.eventSessionId }).assemble(observation);
    assert.equal(observation.raceStatus, canonical, sourceValue);
    assert.equal(observation.status, canonical, sourceValue);
    assert.equal(candidate.races.find(race => race.id === candidate.schedule.currentRaceId).status, canonical, sourceValue);
  }
  assert.equal(normalizeRaceStatus(' RUNNING '), 'running');
  assert.throws(() => normalizeRaceStatus('runing'), /unsupported race status/);
  assert.throws(() => validateHubEnvelope({ type: 'status', hubEpoch: 'status-epoch', eventSessionId: base.eventSessionId, streamSequence: 1, deliveredAt: base.capturedAt, data: { connection: 'live', source: 'LiveFPV', event: base.event.name, quality: 'fresh', raceStatus: 'runing' } }), /Hub status race status is invalid/);
  assert.throws(() => new SourceObservation({ snapshot: { ...base, races: [{ ...base.races[0], status: 'runing' }, base.races[1]] } }), /unsupported race status/);

  const reordered = statusFrame(base, 'running', 4);
  const currentRaceId = reordered.schedule.currentRaceId;
  reordered.races = [reordered.races.find(race => race.id !== currentRaceId), reordered.races.find(race => race.id === currentRaceId)];
  reordered.schedule.currentIndex = 1;
  const reorderedCandidate = new RaceStateAssembler({ eventSessionId: base.eventSessionId }).assemble(new SourceObservation({ snapshot: reordered }));
  assert.equal(reorderedCandidate.schedule.currentRaceId, currentRaceId);
  assert.equal(reorderedCandidate.races.find(race => race.id === currentRaceId).status, 'running');

  const partialAssembler = new RaceStateAssembler({ eventSessionId: base.eventSessionId });
  partialAssembler.assemble(new SourceObservation({ snapshot: base }));
  const nonCurrent = base.races.find(race => race.id !== base.schedule.currentRaceId);
  const partial = new SourceObservation({ eventSessionId: base.eventSessionId, source: base.sources[0], capturedAt: base.capturedAt, races: [{ ...nonCurrent, status: 'complete', timing: { ...nonCurrent.timing, state: 'complete', capturedAt: base.capturedAt, stoppedAt: base.capturedAt } }] });
  const partialCandidate = partialAssembler.assemble(partial);
  assert.equal(partialCandidate.races.find(race => race.id === base.schedule.currentRaceId).status, 'running');
  assert.equal(partialCandidate.races.find(race => race.id === nonCurrent.id).status, 'complete');
});

test('LiveFPV adapter normalizes a legacy scoring status before the authoritative assembler', async () => {
  const base = await fixture('snapshot-fresh.json');
  const legacy = statusFrame(base, 'running', 7);
  const current = legacy.races.find(race => race.id === legacy.schedule.currentRaceId);
  current.status = 'racing';
  current.timing.state = 'racing';
  const adapter = new LiveFPVAdapter({
    scoringUrl: 'https://rotormaniacs.livefpv.com/live/scoring/',
    fetchImpl: async () => new Response('<html>scoring</html>', { status: 200 }),
    parseScoring: () => legacy
  });
  const observation = await adapter.observe();
  assert.equal(observation.raceStatus, 'running');
  assert.equal(observation.snapshot.races.find(race => race.id === observation.snapshot.schedule.currentRaceId).status, 'running');
  assert.equal(observation.snapshot.races.find(race => race.id === observation.snapshot.schedule.currentRaceId).timing.state, 'running');
});

test('Hub rejects an older full snapshot instead of regressing the trusted race status', async () => {
  const base = await fixture('snapshot-fresh.json');
  const store = new TrustedStore({ epoch: 'status-recency-epoch' });
  store.selectEvent({ eventSessionId: base.eventSessionId, event: base.event });
  store.publish(statusFrame(base, 'running', 2));

  assert.throws(() => store.publish(statusFrame(base, 'complete', 1)), /older than the trusted snapshot/);
  assert.equal(store.snapshot.races.find(race => race.id === store.snapshot.schedule.currentRaceId).status, 'running');
  assert.equal(store.getStatus().raceStatus, 'running');
});

test('staging, running, and complete survive Hub promotion, direct snapshot, SSE, stale recovery, and persistence', async () => {
  const base = await fixture('snapshot-fresh.json');
  const frames = [statusFrame(base, 'staging', 1), statusFrame(base, 'running', 2), statusFrame(base, 'complete', 3)];
  const source = { observe: async () => new SourceObservation({ snapshot: frames.shift() }) };
  const directory = await mkdtemp(join(tmpdir(), 'race-hub-status-'));
  const persistencePath = join(directory, 'trusted.json');
  const store = new TrustedStore({ epoch: 'status-epoch', persistencePath });
  const hub = new RaceDataHub({ source, store });
  const server = createHubServer({ store, heartbeatMs: 0 });
  const port = await listen(server);
  let streamResponse;
  try {
    await hub.start({ eventSessionId: base.eventSessionId, event: base.event });
    assert.equal(store.snapshot.races.find(race => race.id === store.snapshot.schedule.currentRaceId).status, 'staging');
    assert.equal(store.getStatus().raceStatus, 'staging');

    streamResponse = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { 'x-hub-epoch': store.hubEpoch, 'x-event-session-id': base.eventSessionId } });
    const streamEvents = collectSseUntil(streamResponse, (event, events) => events.filter(item => item.type === 'snapshot').length === 3);
    await hub.refresh();
    assert.equal(store.snapshot.races.find(race => race.id === store.snapshot.schedule.currentRaceId).status, 'running');
    assert.equal(store.getStatus().raceStatus, 'running');
    await hub.refresh();
    assert.equal(store.snapshot.races.find(race => race.id === store.snapshot.schedule.currentRaceId).status, 'complete');
    assert.equal(store.getStatus().raceStatus, 'complete');

    const direct = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`);
    const directSnapshot = await direct.json();
    assert.equal(directSnapshot.races.find(race => race.id === directSnapshot.schedule.currentRaceId).status, 'complete');
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
    const statusPayload = await status.json();
    assert.equal(statusPayload.raceStatus, 'complete');
    assert.equal(statusPayload.connection, 'live');
    assert.equal(statusPayload.quality, 'fresh');

    const events = await streamEvents;
    const snapshotStatuses = events.filter(event => event.type === 'snapshot').map(event => event.data.races.find(race => race.id === event.data.schedule.currentRaceId).status);
    assert.deepEqual(snapshotStatuses, ['staging', 'running', 'complete']);
    for (const event of events) validateHubEnvelope(event);

    const client = new RaceDataHubClient({ hubUrl: `http://127.0.0.1:${port}`, storage: null });
    client.acceptSnapshot(store.snapshot);
    assert.equal(client.getState().raceStatus, 'complete');
    assert.equal(client.getState().connection, 'live');
    client.apply({ type: 'status', hubEpoch: store.hubEpoch, eventSessionId: base.eventSessionId, streamSequence: client.getState().streamSequence + 1, deliveredAt: '2026-09-06T10:03:01.000Z', data: store.getStatus() });
    assert.equal(client.getState().raceStatus, 'complete');
    assert.equal(client.getState().connection, 'live');

    source.observe = async () => { throw new Error('LiveFPV disconnected'); };
    await assert.rejects(() => hub.refresh(), /LiveFPV disconnected/);
    assert.equal(store.snapshot.races.find(race => race.id === store.snapshot.schedule.currentRaceId).status, 'complete');
    assert.equal(store.snapshot.races[0].timing.state, 'stale');
    assert.equal(store.getStatus().raceStatus, 'complete');
    assert.equal(store.getStatus().connection, 'reconnecting');
    assert.equal(store.getStatus().quality, 'stale');
    client.acceptSnapshot(store.snapshot);
    assert.equal(client.getState().raceStatus, 'complete');
    assert.equal(client.getState().connection, 'reconnecting');

    await store.save();
    const restored = new TrustedStore({ epoch: 'restored-status-epoch', persistencePath });
    const recovered = await restored.restore();
    assert.equal(recovered.races[0].status, 'complete');
    assert.equal(restored.getStatus().raceStatus, 'complete');
    assert.equal(restored.getStatus().connection, 'reconnecting');
    assert.equal(restored.getStatus().quality, 'stale');
  } finally {
    await close(server);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Hub Admin exposes active race status separately from connection and quality', async () => {
  const base = await fixture('snapshot-fresh.json');
  const store = new TrustedStore({ epoch: 'admin-status-epoch' });
  const hub = new RaceDataHub({ source: { observe: async () => new SourceObservation({ snapshot: statusFrame(base, 'running', 8) }) }, store });
  const server = createHubServer({ store, writePassword: 'manager-password', heartbeatMs: 0 });
  const port = await listen(server);
  try {
    await hub.start({ eventSessionId: base.eventSessionId, event: base.event });
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
    const payload = await status.json();
    assert.equal(payload.raceStatus, 'running');
    assert.equal(payload.connection, 'live');
    assert.equal(payload.quality, 'fresh');
    const admin = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.match(await admin.text(), /Active race status/);
  } finally {
    await close(server);
  }
});
