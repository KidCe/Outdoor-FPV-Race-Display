import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLiveFPVSnapshot, LiveFPVSourceRuntime, parseLiveNowPage, parseMainEventsHeatSheet } from '../hub/livefpv-source.mjs';

const event = { id: 'forest-finale', name: 'Forest Race Finale', organizer: 'Rotormaniacs', sourceUrl: 'https://rotormaniacs.livefpv.com/results/?p=view_event&id=517186' };
const heat = ({ id, phase, round, number, count, status = 'not_run', pilots = [] }) => ({
  id,
  phase,
  round,
  heat: { number, count },
  label: `${phase} (${round} Heat ${number}/${count})`,
  status,
  pilots,
  links: {}
});

test('authoritative LiveNow Mains heat immediately replaces a historical Qualifier pointer', () => {
  const qualifier = heat({ id: 'qualifier-q3-h3', phase: 'Qualifier', round: 'Qualifier Round 3', number: 3, count: 3, status: 'complete' });
  const main = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 4, status: 'not_run' });
  const snapshot = buildLiveFPVSnapshot({
    event,
    eventSessionId: 'forest-finale-session',
    qualifierHeats: [qualifier],
    mainEvents: [main],
    historicalResults: [{ currentRaceId: qualifier.id, status: 'complete' }],
    liveNow: {
      available: true,
      phase: 'Main Events',
      round: 'Main Events',
      className: 'Open 1/4',
      heat: { number: 1, count: 4 },
      status: 'staging',
      capturedAt: '2026-09-08T10:00:00.000Z',
      sourceRevision: 'live-main-1'
    }
  });

  assert.equal(snapshot.schedule.currentRaceId, main.id);
  assert.equal(snapshot.races[snapshot.schedule.currentIndex].phase, 'Main Events');
  assert.equal(snapshot.races[snapshot.schedule.currentIndex].round, 'Main Events');
  assert.deepEqual(snapshot.races[snapshot.schedule.currentIndex].heat, { number: 1, count: 4 });
  assert.equal(snapshot.races[snapshot.schedule.currentIndex].status, 'staging');
  assert.deepEqual(snapshot.schedule.nextRaceIds, []);
});

test('Main Events heat-sheet order exposes the known next-up heats with source lineups', async () => {
  const html = await readFile(new URL('./fixtures/livefpv-main-events-10-pilot.html', import.meta.url), 'utf8');

  const heats = parseMainEventsHeatSheet(html, {
    eventId: event.id,
    heatSheetUrl: 'https://rotormaniacs.livefpv.com/results/?p=view_heat_sheet&id=9001',
    capturedAt: '2026-09-08T10:00:00.000Z'
  });
  const snapshot = buildLiveFPVSnapshot({
    event,
    eventSessionId: 'forest-finale-session',
    mainEvents: heats,
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', className: 'Open', heat: { number: 1, count: 4 }, status: 'staging', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-main-1' }
  });

  assert.equal(heats.length, 4);
  assert.deepEqual(heats.map(heat => heat.sourceRaceNumber), [1, 2, 3, 4]);
  assert.equal(heats.reduce((total, heat) => total + heat.pilots.length, 0), 10);
  assert.equal(heats[1].status, 'complete');
  assert.equal(heats[1].links.results, 'https://rotormaniacs.livefpv.com/results/?p=view_race_result&id=2002');
  assert.equal(snapshot.schedule.currentRaceId, heats[0].id);
  assert.deepEqual(snapshot.schedule.nextRaceIds, [heats[1].id, heats[2].id]);
  assert.deepEqual(snapshot.schedule.afterNextRaceIds, [heats[3].id]);
  assert.equal(snapshot.races.find(race => race.id === heats[1].id).pilots[0].video.channel, 'R2');
});

test('LiveNow scoring page parser produces the active cross-round anchor and ignores waiting pages', () => {
  const capturedAt = '2026-09-08T10:00:00.000Z';
  const active = parseLiveNowPage(`
    <span id="round">Main Events</span>
    <span id="race">Race 1/4</span>
    <span id="class">Open</span>
    <span id="race_status">Staging</span>
    <span id="event_name">Forest Race Finale</span>
    <table><tr data-pilot-id="pilot-1"><td class="position">1</td><td class="driver">Pilot 1</td><td class="frequency">F1 5740</td></tr></table>`,
    { sourceUrl: 'https://rotormaniacs.livefpv.com/live/scoring/', capturedAt }
  );
  const waiting = parseLiveNowPage('<p>Waiting for event to start...</p><span id="race_status"></span>', { sourceUrl: 'https://rotormaniacs.livefpv.com/live/scoring/', capturedAt });

  assert.equal(active.available, true);
  assert.equal(active.phase, 'Main Events');
  assert.deepEqual(active.heat, { number: 1, count: 4 });
  assert.equal(active.status, 'staging');
  assert.equal(active.pilots[0].video.channel, 'F1');
  assert.equal(waiting.available, false);
  assert.equal(waiting.status, 'unknown');
});

test('LiveNow Q1 matches the scoped Qualifier Round 1 heat-sheet identity', () => {
  const qualifier = heat({ id: 'qualifier-q1-h1', phase: 'Qualifier', round: 'Qualifier Round 1', number: 1, count: 1, status: 'not_run' });
  const liveNow = parseLiveNowPage('<span id="round">Q1</span><span id="race">1/1</span><span id="class">Open</span><span id="race_status">Running</span><span id="event_name">Forest Race Finale</span>', { capturedAt: '2026-09-08T10:00:00.000Z' });
  const snapshot = buildLiveFPVSnapshot({ event, eventSessionId: 'forest-finale-session', qualifierHeats: [qualifier], liveNow });

  assert.equal(snapshot.schedule.currentRaceId, qualifier.id);
  assert.equal(snapshot.races[snapshot.schedule.currentIndex].status, 'running');
});

test('an older LiveNow packet cannot regress the accepted current heat', () => {
  const qualifier = heat({ id: 'qualifier-q3-h3', phase: 'Qualifier', round: 'Qualifier Round 3', number: 3, count: 3, status: 'complete' });
  const main = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 2, status: 'not_run' });
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  const accepted = runtime.accept({
    qualifierHeats: [qualifier],
    mainEvents: [main],
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'running', capturedAt: '2026-09-08T10:01:00.000Z', sourceRevision: 'live-main-2' }
  });
  const stale = runtime.accept({
    qualifierHeats: [qualifier],
    mainEvents: [main],
    liveNow: { available: true, phase: 'Qualifier', round: 'Qualifier Round 3', heat: qualifier.heat, status: 'complete', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-qualifier-1' }
  });

  assert.equal(accepted.accepted, true);
  assert.equal(stale.accepted, false);
  assert.equal(stale.snapshot.schedule.currentRaceId, main.id);
  assert.equal(stale.snapshot.races[stale.snapshot.schedule.currentIndex].status, 'running');
});

test('a fresh LiveNow rerun outranks an old Complete Main Events result', () => {
  const completed = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 2, status: 'complete' });
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  runtime.accept({
    mainEvents: [completed],
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: completed.heat, status: 'complete', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'result-1' }
  });
  const rerun = runtime.accept({
    mainEvents: [{ ...completed, status: 'complete' }],
    historicalResults: [{ currentRaceId: completed.id, status: 'complete', capturedAt: '2026-09-08T09:59:00.000Z' }],
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: completed.heat, status: 'staging', runId: 'main-m1-run-2', attempt: 2, capturedAt: '2026-09-08T10:01:00.000Z', sourceRevision: 'live-rerun-2' }
  });

  const current = rerun.snapshot.races[rerun.snapshot.schedule.currentIndex];
  assert.equal(current.id, completed.id);
  assert.equal(current.status, 'staging');
  assert.equal(current.runId, 'main-m1-run-2');
  assert.equal(current.attempt, 2);
});

test('historical Results selections cannot replace the trusted LiveNow current heat', () => {
  const qualifier = heat({ id: 'qualifier-q3-h3', phase: 'Qualifier', round: 'Qualifier Round 3', number: 3, count: 3, status: 'complete' });
  const main = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 2, status: 'not_run' });
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  runtime.accept({
    qualifierHeats: [qualifier],
    mainEvents: [main],
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'running', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-main-1' }
  });
  const historical = runtime.accept({
    qualifierHeats: [qualifier],
    mainEvents: [{ ...main, status: 'complete' }],
    historicalResults: [{ currentRaceId: qualifier.id, status: 'complete' }]
  });

  assert.equal(historical.accepted, true);
  assert.equal(historical.snapshot.schedule.currentRaceId, main.id);
  assert.equal(historical.snapshot.races[historical.snapshot.schedule.currentIndex].status, 'running');
  assert.equal(historical.snapshot.quality.state, 'stale');
});

test('loading a different LiveNow heat never reuses pilots or channels from the previous heat', () => {
  const qualifierPilot = { id: 'pilot-1', sourceId: 'pilot-1', callsign: 'Pilot 1', slot: 1, video: { channel: 'F1', band: 'F', number: 1, frequencyMHz: 5740 } };
  const qualifier = heat({ id: 'qualifier-q1-h1', phase: 'Qualifier', round: 'Qualifier Round 1', number: 1, count: 1, status: 'running', pilots: [qualifierPilot] });
  const main = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 1, status: 'not_run', pilots: [] });
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  runtime.accept({
    qualifierHeats: [qualifier],
    mainEvents: [main],
    liveNow: { available: true, phase: 'Qualifier', round: 'Qualifier Round 1', heat: qualifier.heat, status: 'running', pilots: [qualifierPilot], capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-qualifier-1' }
  });
  const loading = runtime.accept({
    qualifierHeats: [qualifier],
    mainEvents: [main],
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'staging', pilots: [], capturedAt: '2026-09-08T10:01:00.000Z', sourceRevision: 'live-main-1' }
  });

  const current = loading.snapshot.races[loading.snapshot.schedule.currentIndex];
  assert.equal(current.id, main.id);
  assert.deepEqual(current.pilots, []);
});

test('the same stable heat may retain its pilot details while a partial LiveNow packet loads', () => {
  const pilot = { id: 'pilot-1', sourceId: 'pilot-1', callsign: 'Pilot 1', slot: 1, video: { channel: 'F1', band: 'F', number: 1, frequencyMHz: 5740 } };
  const main = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 1, status: 'running', pilots: [pilot] });
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  runtime.accept({ mainEvents: [main], liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'running', pilots: [pilot], capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-1' } });
  const partial = runtime.accept({ mainEvents: [{ ...main, pilots: [] }], liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'running', pilots: [], capturedAt: '2026-09-08T10:00:01.000Z', sourceRevision: 'live-2' } });

  assert.deepEqual(partial.snapshot.races[partial.snapshot.schedule.currentIndex].pilots, [pilot]);
});

test('an empty LiveNow continuation keeps the trusted current heat and marks freshness stale', () => {
  const main = heat({ id: 'main-m1', phase: 'Main Events', round: 'Main Events', number: 1, count: 1, status: 'running' });
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  const initial = runtime.accept({ mainEvents: [main], liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'running', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-1' } });
  const stale = runtime.accept({ mainEvents: [{ ...main, status: 'complete' }], liveNow: { available: false, status: 'unknown', capturedAt: '2026-09-08T10:00:01.000Z', sourceRevision: 'waiting-1' } });

  assert.equal(initial.snapshot.schedule.currentRaceId, main.id);
  assert.equal(stale.snapshot.schedule.currentRaceId, main.id);
  assert.equal(stale.snapshot.races[stale.snapshot.schedule.currentIndex].status, 'running');
  assert.equal(stale.snapshot.quality.state, 'stale');
});

test('a missing LiveNow class does not guess between duplicate Main Events heats', () => {
  const open = { ...heat({ id: 'main-open-1', phase: 'Main Events', round: 'Main Events', number: 1, count: 2 }), className: 'Open' };
  const expert = { ...heat({ id: 'main-expert-1', phase: 'Main Events', round: 'Main Events', number: 1, count: 2 }), className: 'Expert' };
  const runtime = new LiveFPVSourceRuntime({ event, eventSessionId: 'forest-finale-session' });
  const result = runtime.accept({ mainEvents: [open, expert], liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: { number: 1, count: 2 }, status: 'staging', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'ambiguous-1' } });

  assert.equal(result.snapshot.schedule.currentRaceId, null);
  assert.equal(result.snapshot.schedule.currentIndex, null);
  assert.equal(result.snapshot.quality.state, 'degraded');
  assert.ok(result.snapshot.quality.warnings.some(warning => warning.code === 'livefpv.live_now_ambiguous'));
});

test('duplicate source race numbers are scoped so a cross-round LiveNow match selects Mains', () => {
  const qualifier = heat({ id: 'race-1', phase: 'Qualifier', round: 'Qualifier Round 3', number: 1, count: 1, status: 'complete' });
  const main = heat({ id: 'race-1', phase: 'Main Events', round: 'Main Events', number: 1, count: 2, status: 'not_run' });
  const snapshot = buildLiveFPVSnapshot({
    event,
    eventSessionId: 'forest-finale-session',
    qualifierHeats: [qualifier],
    mainEvents: [main],
    liveNow: { available: true, phase: 'Main Events', round: 'Main Events', heat: main.heat, status: 'staging', capturedAt: '2026-09-08T10:00:00.000Z', sourceRevision: 'live-main-1' }
  });

  const current = snapshot.races[snapshot.schedule.currentIndex];
  assert.equal(current.phase, 'Main Events');
  assert.notEqual(current.id, qualifier.id);
});
