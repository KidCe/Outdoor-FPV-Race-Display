import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { applySimulatorAction, simulatorView } from '../hub/simulator.js';
import { createHubServer, TrustedStore, validateSnapshot } from '../hub/index.mjs';

const loadFixture = async () => JSON.parse(await readFile(new URL('../contracts/race-event/v1/fixtures/snapshot-fresh.json', import.meta.url)));
const at = new Date('2026-09-08T20:00:00.000Z');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(() => resolve()));

test('simulator status changes are pure and remain valid race snapshots', async () => {
  const initial = await loadFixture();
  const changed = applySimulatorAction(initial, { type: 'set-current-status', status: 'complete' }, at);

  assert.equal(initial.races[0].status, 'running');
  assert.equal(changed.races[0].status, 'complete');
  assert.equal(changed.races[0].timing.state, 'complete');
  assert.equal(changed.quality.completeRaceCount, 1);
  assert.equal(validateSnapshot(changed).valid, true);
});

test('simulator advance completes the old current heat and stages the next heat', async () => {
  const initial = await loadFixture();
  const advanced = applySimulatorAction(initial, { type: 'advance' }, at);
  const view = simulatorView(advanced);

  assert.equal(view.current.id, 'heat-19');
  assert.equal(view.current.status, 'staging');
  assert.equal(initial.schedule.currentRaceId, 'heat-18');
  assert.equal(advanced.races[0].status, 'complete');
  assert.equal(view.next, null);
  assert.equal(validateSnapshot(advanced).valid, true);
});

test('simulator can select a heat, remove next-up, reset, and rename the event', async () => {
  const initial = await loadFixture();
  const selected = applySimulatorAction(initial, { type: 'select-current', index: 1 }, at);
  const noNext = applySimulatorAction(initial, { type: 'set-next-status', status: 'none' }, at);
  const nextAgain = applySimulatorAction(noNext, { type: 'set-next-status', status: 'staging' }, at);
  const renamed = applySimulatorAction(nextAgain, { type: 'set-event-name', name: 'My local test event' }, at);
  const reset = applySimulatorAction(renamed, { type: 'reset' }, at);

  assert.equal(selected.schedule.currentRaceId, 'heat-19');
  assert.deepEqual(noNext.schedule.nextRaceIds, []);
  assert.deepEqual(nextAgain.schedule.nextRaceIds, ['heat-19']);
  assert.equal(renamed.event.name, 'My local test event');
  assert.equal(reset.schedule.currentRaceId, 'heat-18');
  assert.equal(reset.races[0].status, 'staging');
  assert.equal(reset.races[1].status, 'staging');
  assert.equal(validateSnapshot(reset).valid, true);
});

test('simulator page exposes the small click-through control surface', async () => {
  const html = await readFile(new URL('../hub/simulator.html', import.meta.url), 'utf8');
  assert.match(html, /Race-Day Simulator/);
  assert.match(html, /Complete current &amp; advance to next/);
  assert.match(html, /Set current status/);
  assert.match(html, /Set next-up status/);
  assert.match(html, /simulator\.js/);
});

test('simulator assets stay hidden on a normal Hub and are enabled on a Fixture Hub', async () => {
  const store = new TrustedStore({ epoch: 'simulator-asset-test' });
  const productionHub = createHubServer({ store, heartbeatMs: 0 });
  const fixtureHub = createHubServer({ store, heartbeatMs: 0, enableTestSnapshotInjection: true });
  const productionPort = await listen(productionHub);
  const fixturePort = await listen(fixtureHub);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${productionPort}/simulator`)).status, 404);
    const response = await fetch(`http://127.0.0.1:${fixturePort}/simulator`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Race-Day Simulator/);
  } finally {
    await close(productionHub);
    await close(fixtureHub);
  }
});
