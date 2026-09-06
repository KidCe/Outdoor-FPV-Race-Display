import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveFPVAdapter, RaceDataHub, ReplaySource, RaceStateAssembler, SourceObservation, TrustedStore, createHubServer, validateLiveFPVScoringUrl, validateSnapshot } from '../hub/index.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`../contracts/race-event/v1/fixtures/${name}`, import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
async function readSseUntil(response, predicate, timeoutMs = 2000, controller = null) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE read timed out')), Math.max(1, deadline - Date.now())); });
        const result = await Promise.race([reader.read(), timeout]);
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        for (const block of blocks) {
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          events.push(event);
          if (predicate(event)) return events;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('SSE predicate was not observed');
  } finally {
    await reader.cancel();
    controller?.abort();
  }
}

test('replay and assembler accept frozen snapshots and legal reruns', async () => {
  const source = new ReplaySource([await fixture('snapshot-fresh.json'), await fixture('snapshot-rerun.json')]);
  const firstObservation = await source.next();
  assert.ok(firstObservation instanceof SourceObservation);
  const assembler = new RaceStateAssembler({ eventSessionId: firstObservation.eventSessionId });
  assert.equal(validateSnapshot(assembler.assemble(firstObservation)).valid, true);
  const rerun = assembler.assemble(await source.next());
  assert.equal(rerun.races[0].id, 'heat-18');
  assert.equal(rerun.races[0].attempt, 2);
  assert.equal(rerun.races[0].status, 'staging');
});

test('partial observations preserve proven channels, accept reorder/rename, and ignore empty packets', async () => {
  const fresh = await fixture('snapshot-fresh.json');
  const assembler = new RaceStateAssembler({ eventSessionId: fresh.eventSessionId });
  assembler.assemble(fresh);
  const partial = new SourceObservation({
    eventSessionId: fresh.eventSessionId,
    source: fresh.sources[0],
    capturedAt: fresh.capturedAt,
    races: [{ ...fresh.races[0], pilots: [{ ...fresh.races[0].pilots[1], callsign: 'Renamed' }, { ...fresh.races[0].pilots[0] }] }]
  });
  const reordered = assembler.assemble(partial);
  assert.deepEqual(reordered.races[0].pilots.map(pilot => pilot.callsign), ['Renamed', 'PilotOne']);
  assert.equal(reordered.races[0].pilots[0].video.channel, 'R8');
  const empty = assembler.assemble(new SourceObservation({ eventSessionId: fresh.eventSessionId, source: fresh.sources[0], races: [] }));
  assert.equal(empty.races[0].pilots[0].video.channel, 'R8');
});

test('validator enforces the frozen public shape and identity invariant', async () => {
  const fresh = await fixture('snapshot-fresh.json');
  assert.equal(validateSnapshot(fresh).valid, true);
  assert.equal(validateSnapshot({ ...fresh, unexpected: true }).valid, false);
  assert.equal(validateSnapshot({ ...fresh, schedule: { ...fresh.schedule, currentRaceId: 'missing' } }).valid, false);
  assert.equal(validateSnapshot({ ...fresh, races: [{ ...fresh.races[0], status: 'racing' }] }).valid, false);
  assert.equal(validateSnapshot({ ...fresh, races: [fresh.races[0], { ...fresh.races[1], id: fresh.races[0].id }] }).valid, false);
  assert.equal(validateSnapshot({ ...fresh, event: { ...fresh.event, sourceUrl: 'https://user:pass@host/live/scoring/' } }).valid, false);
});

test('trusted store requires explicit selection, sequences snapshots, and makes stale idempotent', async () => {
  const store = new TrustedStore({ epoch: 'test-epoch' });
  const fresh = await fixture('snapshot-fresh.json');
  assert.throws(() => store.publish(fresh), /no active event/);
  store.selectEvent({ eventSessionId: fresh.eventSessionId, event: fresh.event });
  const events = [];
  store.subscribe(event => events.push(event));
  store.publish(fresh);
  const stale = store.markStale();
  assert.equal(stale.data.quality.state, 'stale');
  assert.equal(store.markStale(), null);
  assert.equal(events.filter(event => event.type === 'snapshot').length, 2);
  assert.equal(events.at(-1).streamSequence > events.at(-2).streamSequence, true);
  store.deactivateEvent();
  assert.equal(store.snapshot, null);
  assert.equal(store.active, false);
});

test('persisted recovery cross-checks event identity and restores only as stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'race-hub-'));
  const path = join(directory, 'trusted.json');
  try {
    const fresh = await fixture('snapshot-fresh.json');
    const first = new TrustedStore({ persistencePath: path, eventSessionId: fresh.eventSessionId, epoch: 'old-epoch' });
    first.publish(fresh);
    await first.save();
    const restored = new TrustedStore({ persistencePath: path, epoch: 'new-epoch' });
    const snapshot = await restored.restore();
    assert.equal(snapshot.quality.state, 'stale');
    assert.equal(snapshot.capturedAt, fresh.capturedAt);
    assert.equal(restored.hubEpoch, 'new-epoch');
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    persisted.activeEvent.eventSessionId = 'wrong-session';
    await writeFile(path, JSON.stringify(persisted));
    const rejected = new TrustedStore({ persistencePath: path });
    assert.equal(await rejected.restore(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stream bootstrap distinguishes epoch changes and bounded history gaps', async () => {
  const fresh = await fixture('snapshot-fresh.json');
  const store = new TrustedStore({ eventSessionId: fresh.eventSessionId, historyLimit: 2 });
  store.publish(fresh);
  store.publish({ ...fresh, snapshotId: 'forest-finale-session-1:43' });
  const epochReset = store.bootstrap({ lastEventId: 1, hubEpoch: 'other-epoch' });
  assert.equal(epochReset[0].type, 'reset');
  assert.equal(epochReset[0].data.reason, 'epoch_changed');
  const firstBootstrap = store.bootstrap({ hubEpoch: store.hubEpoch });
  const secondBootstrap = store.bootstrap({ hubEpoch: store.hubEpoch });
  assert.deepEqual(secondBootstrap.map(event => event.streamSequence), firstBootstrap.map(event => event.streamSequence));
  const gap = store.bootstrap({ lastEventId: 1, hubEpoch: store.hubEpoch });
  assert.equal(gap[0].data.reason, 'history_gap');
  assert.ok(gap.some(event => event.type === 'snapshot'));
});

test('source observation runtime keeps failures stale and promotes only assembled candidates', async () => {
  const fresh = await fixture('snapshot-fresh.json');
  const source = new ReplaySource([fresh]);
  const store = new TrustedStore();
  const hub = new RaceDataHub({ source, store });
  await hub.refresh().catch(error => assert.match(error.message, /no active event/));
  await hub.start({ eventSessionId: fresh.eventSessionId, event: fresh.event });
  assert.equal(store.snapshot.snapshotId, fresh.snapshotId);
  source.next = async () => { throw new Error('temporary source failure'); };
  await assert.rejects(() => hub.refresh(), /temporary source failure/);
  assert.equal(store.snapshot.quality.state, 'stale');
  hub.deactivateEvent();
  assert.equal(store.active, false);
});

test('local HTTP/SSE transport serves bootstrap, Last-Event-ID replay, and health', async () => {
  const fresh = await fixture('snapshot-fresh.json');
  const store = new TrustedStore({ eventSessionId: fresh.eventSessionId, epoch: 'http-epoch' });
  store.publish(fresh);
  const server = createHubServer({ store, heartbeatMs: 0 });
  const port = await listen(server);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal((await health.json()).hubEpoch, 'http-epoch');
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { 'x-hub-epoch': 'http-epoch' } });
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(first, /event: reset/);
    assert.match(first, /event: snapshot/);
    const last = store.streamSequence;
    assert.deepEqual(store.bootstrap({ lastEventId: last, hubEpoch: 'http-epoch' }), []);
  } finally {
    await close(server);
  }
});

test('local Hub Admin surface serves diagnostics and protects event selection/deactivation', async () => {
  const store = new TrustedStore({ epoch: 'admin-epoch' });
  const server = createHubServer({ store, writePassword: 'manager-password', heartbeatMs: 0 });
  const port = await listen(server);
  try {
    const admin = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /Race Data Hub Admin/);
    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/admin/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventSessionId: 'aircrasher-session-1' }) });
    assert.equal(denied.status, 401);
    const selected = await fetch(`http://127.0.0.1:${port}/api/v1/admin/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-write-password': 'manager-password' }, body: JSON.stringify({ eventSessionId: 'aircrasher-session-1', event: { id: 'aircrasher-event', name: 'Aircrasher Open' } }) });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).activeEvent, 'aircrasher-session-1');
    assert.equal(store.active, true);
    const deactivated = await fetch(`http://127.0.0.1:${port}/api/v1/admin/event/deactivate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-write-password': 'manager-password' }, body: '{}' });
    assert.equal(deactivated.status, 200);
    assert.equal(store.active, false);
    const unsafe = await fetch(`http://127.0.0.1:${port}/api/v1/admin/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-write-password': 'manager-password' }, body: JSON.stringify({ eventSessionId: 'unsafe-session', event: { id: 'unsafe-event', name: 'Unsafe', sourceUrl: 'https://user:pass@host/live/scoring/' } }) });
    assert.equal(unsafe.status, 400);
    assert.equal(store.active, false);
  } finally {
    await close(server);
  }
});

test('announcement writes require the shared password and remain event-scoped', async () => {
  const fresh = await fixture('snapshot-fresh.json');
  const store = new TrustedStore({ eventSessionId: fresh.eventSessionId, now: () => new Date('2026-09-06T10:00:00.000Z') });
  store.publish(fresh);
  const server = createHubServer({ store, writePassword: 'correct', heartbeatMs: 0 });
  const port = await listen(server);
  try {
    const body = { title: 'Channels changed', body: 'PilotOne R1 -> R8', importance: 3, createdByDeviceId: 'race-manager' };
    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/announcements`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-write-password': 'wrong' }, body: JSON.stringify(body) });
    assert.equal(denied.status, 401);
    const created = await fetch(`http://127.0.0.1:${port}/api/v1/announcements`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-write-password': 'correct' }, body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const announcement = await created.json();
    assert.equal(store.snapshot.activeAnnouncements[0].announcementId, announcement.announcementId);
    const history = await fetch(`http://127.0.0.1:${port}/api/v1/announcements/history`);
    assert.equal((await history.json()).items.length, 1);
    const cleared = await fetch(`http://127.0.0.1:${port}/api/v1/announcements/${announcement.announcementId}/clear`, { method: 'POST', headers: { 'x-event-write-password': 'correct' } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(store.getActiveAnnouncements(), []);
    const expiring = store.createAnnouncement({ title: 'Temporary notice', body: 'This will expire in the replay.', importance: 2, createdByDeviceId: 'race-manager', expiresAt: '2026-09-06T10:00:30.000Z' });
    assert.equal(store.getActiveAnnouncements()[0].announcementId, expiring.announcementId);
    assert.equal(store.expireAnnouncements(new Date('2026-09-06T10:00:31.000Z')), true);
    assert.equal(store.getAnnouncementHistory().items.at(-1).status, 'expired');
    assert.deepEqual(store.getActiveAnnouncements(), []);
  } finally {
    await close(server);
  }
});

test('LiveFPV adapter seam validates explicit scoring URLs without exposing credentials', () => {
  assert.equal(validateLiveFPVScoringUrl('https://rotormaniacs.livefpv.com/live/scoring/').pathname, '/live/scoring/');
  assert.throws(() => validateLiveFPVScoringUrl('https://user:pass@host/live/scoring/'), /without embedded credentials/);
  assert.throws(() => validateLiveFPVScoringUrl('https://host/live/results/'), /must point/);
});

test('LiveFPV adapter fetches only the explicit scoring URL and returns a source observation', async () => {
  const fresh = await fixture('snapshot-fresh.json'); let request;
  const adapter = new LiveFPVAdapter({ scoringUrl: 'https://rotormaniacs.livefpv.com/live/scoring/', fetchImpl: async (url, options) => { request = { url: String(url), options }; return new Response('<html>source</html>', { status: 200 }); }, parseScoring: ({ raw, url }) => new SourceObservation({ snapshot: fresh, source: { ...fresh.sources[0], revision: 'parser-1' }, eventSessionId: fresh.eventSessionId, capturedAt: fresh.capturedAt, raw, url }) });
  const observation = await adapter.observe();
  assert.ok(observation instanceof SourceObservation);
  assert.equal(request.url, 'https://rotormaniacs.livefpv.com/live/scoring/');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers.accept, 'text/html, application/json');
});

test('end-to-end replay exercises heat transitions, correction/rerun, stale recovery, persistence, SSE reset, and atomic promotion', async () => {
  const base = await fixture('snapshot-fresh.json');
  const makeFrame = (sequence, currentRaceId, currentStatus, { attempt = 1, runId = `heat-18-run-${attempt}`, warning = null } = {}) => {
    const frame = structuredClone(base);
    frame.snapshotId = `generated-session:${sequence}`;
    frame.capturedAt = `2026-09-06T10:${String(sequence).padStart(2, '0')}:00.000Z`;
    const first = { ...frame.races[0], status: currentRaceId === 'heat-18' ? currentStatus : 'complete', runId: currentRaceId === 'heat-18' ? runId : 'heat-18-run-1', attempt: currentRaceId === 'heat-18' ? attempt : 1, timing: { ...frame.races[0].timing, state: currentRaceId === 'heat-18' ? currentStatus : 'complete', capturedAt: frame.capturedAt, stoppedAt: currentRaceId === 'heat-18' && currentStatus !== 'complete' ? null : frame.capturedAt } };
    const second = { ...frame.races[1], status: currentRaceId === 'heat-19' ? currentStatus : 'staging', runId: currentRaceId === 'heat-19' ? 'heat-19-run-1' : null, timing: currentRaceId === 'heat-19' ? { ...frame.races[0].timing, state: currentStatus, capturedAt: frame.capturedAt, stoppedAt: currentStatus === 'complete' ? frame.capturedAt : null } : undefined };
    frame.races = currentRaceId === 'heat-19' ? [first, second, { ...second, id: 'heat-20', label: 'Qualifier (Heat 20/24)', heat: { number: 20, count: 24 }, order: 19, status: 'staging', runId: null, timing: undefined }] : [first, second];
    frame.schedule = currentRaceId === 'heat-19' ? { currentRaceId, currentIndex: 1, nextRaceIds: ['heat-20'], afterNextRaceIds: [] } : { currentRaceId, currentIndex: 0, nextRaceIds: ['heat-19', 'heat-20'], afterNextRaceIds: ['heat-21'] };
    frame.sources[0].revision = `generated-rev-${sequence}`;
    frame.sources[0].capturedAt = frame.capturedAt;
    frame.quality.domains = Object.fromEntries(Object.entries(frame.quality.domains).map(([domain, value]) => [domain, { ...value, capturedAt: frame.capturedAt }]));
    frame.quality.state = 'fresh';
    frame.quality.warnings = warning ? [warning] : [];
    return frame;
  };
  const frames = [makeFrame(1, 'heat-18', 'staging'), makeFrame(2, 'heat-18', 'running'), makeFrame(3, 'heat-18', 'complete'), new Error('LiveFPV disconnected'), makeFrame(5, 'heat-18', 'staging', { attempt: 2, runId: 'heat-18-run-2', warning: { code: 'race.rerun', message: 'Heat 18 was reopened for run 2.', severity: 'info' } }), makeFrame(6, 'heat-19', 'running')];
  const source = { async observe() { const next = frames.shift(); if (next instanceof Error) throw next; return new SourceObservation({ snapshot: next }); } };
  const directory = await mkdtemp(join(tmpdir(), 'race-hub-e2e-'));
  const persistencePath = join(directory, 'trusted.json');
  const store = new TrustedStore({ persistencePath, epoch: 'e2e-epoch' });
  const hub = new RaceDataHub({ source, store });
  const server = createHubServer({ store, heartbeatMs: 0 });
  const port = await listen(server);
  try {
    await hub.start({ eventSessionId: base.eventSessionId, event: base.event });
    assert.equal(store.snapshot.races[0].status, 'staging');
    const initialController = new AbortController();
    const initialStream = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { 'x-hub-epoch': 'e2e-epoch' }, signal: initialController.signal });
    const initialEvents = await readSseUntil(initialStream, event => event.type === 'snapshot', 2000, initialController);
    const initialSnapshotSequence = initialEvents.find(event => event.type === 'snapshot').streamSequence;
    await hub.refresh();
    assert.equal(store.snapshot.races[0].status, 'running');
    const replayController = new AbortController();
    const replayStream = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { 'last-event-id': String(initialSnapshotSequence), 'x-hub-epoch': 'e2e-epoch', 'x-event-session-id': base.eventSessionId }, signal: replayController.signal });
    const replayEvents = await readSseUntil(replayStream, event => event.type === 'snapshot' && event.data.races[0].status === 'running', 2000, replayController);
    assert.ok(replayEvents.some(event => event.type === 'snapshot' && event.data.races[0].status === 'running'));
    await hub.refresh();
    assert.equal(store.snapshot.races[0].status, 'complete');
    const beforeInvalid = store.snapshot.snapshotId;
    assert.throws(() => store.stage({ ...base, eventSessionId: 'wrong-session' }), /event session mismatch/);
    assert.equal(store.snapshot.snapshotId, beforeInvalid);
    await assert.rejects(() => hub.refresh(), /LiveFPV disconnected/);
    assert.equal(store.snapshot.quality.state, 'stale');
    await hub.refresh();
    assert.equal(store.snapshot.races[0].attempt, 2);
    assert.equal(store.snapshot.races[0].status, 'staging');
    await hub.refresh();
    assert.equal(store.snapshot.schedule.currentRaceId, 'heat-19');
    await store.save();
    const restored = new TrustedStore({ persistencePath, epoch: 'e2e-restarted-epoch' });
    const recovered = await restored.restore();
    assert.equal(recovered.quality.state, 'stale');
    assert.equal(recovered.schedule.currentRaceId, 'heat-19');
    hub.selectEvent({ eventSessionId: 'aircrasher-session-1', event: { id: 'aircrasher-open', name: 'Aircrasher Open' } });
    const resetController = new AbortController();
    const resetStream = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { 'last-event-id': String(initialSnapshotSequence), 'x-hub-epoch': 'e2e-epoch', 'x-event-session-id': base.eventSessionId }, signal: resetController.signal });
    const resetEvents = await readSseUntil(resetStream, event => event.type === 'reset', 2000, resetController);
    assert.equal(resetEvents.find(event => event.type === 'reset').data.reason, 'event_changed');
  } finally {
    await close(server);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
