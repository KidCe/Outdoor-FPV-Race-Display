export const SIMULATOR_RACE_STATUSES = Object.freeze(['scheduled', 'staging', 'running', 'complete', 'not_run', 'unknown', 'cancelled']);

let snapshotSequence = 0;

const clone = value => structuredClone(value);
const statusText = status => String(status ?? 'unknown').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
const raceTitle = race => race?.label || (race?.heat ? `Heat ${race.heat.number}/${race.heat.count}` : race?.id || 'No heat');
const racePilots = race => (race?.pilots ?? []).map(pilot => pilot.callsign).join(' · ') || 'No pilots';
const currentIndex = snapshot => {
  const index = snapshot?.schedule?.currentIndex;
  if (Number.isInteger(index) && snapshot.races?.[index]) return index;
  return Math.max(0, snapshot.races.findIndex(race => race.id === snapshot.schedule?.currentRaceId));
};

function timingStateFor(status) {
  return ['staging', 'running', 'complete'].includes(status) ? status : 'unknown';
}

function setRaceStatus(race, status, capturedAt) {
  if (!race || !SIMULATOR_RACE_STATUSES.includes(status)) throw new Error(`Unsupported simulator status '${status}'.`);
  const previousTiming = race.timing ?? {};
  race.status = status;
  race.timing = {
    state: timingStateFor(status),
    elapsedMs: previousTiming.elapsedMs ?? null,
    startedAt: status === 'running' || status === 'complete' ? previousTiming.startedAt ?? capturedAt : null,
    stoppedAt: status === 'complete' ? previousTiming.stoppedAt ?? capturedAt : null,
    capturedAt
  };
}

function rebuildSchedule(snapshot, index) {
  const races = snapshot.races;
  const safeIndex = Math.max(0, Math.min(index, races.length - 1));
  snapshot.schedule.currentIndex = safeIndex;
  snapshot.schedule.currentRaceId = races[safeIndex].id;
  snapshot.schedule.nextRaceIds = races.slice(safeIndex + 1, safeIndex + 2).map(race => race.id);
  snapshot.schedule.afterNextRaceIds = races.slice(safeIndex + 2, safeIndex + 4).map(race => race.id);
  return safeIndex;
}

function touchSnapshot(snapshot, capturedAt) {
  snapshot.snapshotId = `simulator-${Date.now()}-${++snapshotSequence}`;
  snapshot.capturedAt = capturedAt;
  for (const source of snapshot.sources ?? []) {
    source.revision = snapshot.snapshotId;
    source.capturedAt = capturedAt;
  }
  if (snapshot.quality) {
    snapshot.quality.state = 'fresh';
    snapshot.quality.completeRaceCount = snapshot.races.filter(race => race.status === 'complete').length;
    snapshot.quality.warnings = [];
    for (const domain of Object.values(snapshot.quality.domains ?? {})) {
      domain.state = 'fresh';
      domain.capturedAt = capturedAt;
      domain.reason = undefined;
    }
  }
  return snapshot;
}

/**
 * Apply one user-facing simulator operation to a snapshot.
 * The function is deliberately pure so the browser controls and unit tests use
 * exactly the same state transition rules.
 */
export function applySimulatorAction(inputSnapshot, action, now = new Date()) {
  if (!inputSnapshot || !Array.isArray(inputSnapshot.races) || inputSnapshot.races.length === 0) throw new Error('A snapshot with at least one race is required.');
  if (!action || typeof action !== 'object') throw new Error('Simulator action must be an object.');
  const snapshot = clone(inputSnapshot);
  const capturedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  let index = currentIndex(snapshot);

  switch (action.type) {
    case 'select-current':
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= snapshot.races.length) throw new Error('Selected heat is out of range.');
      index = rebuildSchedule(snapshot, action.index);
      break;
    case 'set-current-status':
      setRaceStatus(snapshot.races[index], action.status, capturedAt);
      break;
    case 'set-next-status': {
      if (action.status !== 'none' && !snapshot.schedule.nextRaceIds?.[0]) rebuildSchedule(snapshot, index);
      const nextId = snapshot.schedule.nextRaceIds?.[0];
      const nextRace = snapshot.races.find(race => race.id === nextId);
      if (action.status === 'none') {
        snapshot.schedule.nextRaceIds = [];
        snapshot.schedule.afterNextRaceIds = [];
      } else {
        if (!nextRace) throw new Error('There is no next heat in this scenario.');
        setRaceStatus(nextRace, action.status, capturedAt);
      }
      break;
    }
    case 'advance':
      if (index >= snapshot.races.length - 1) throw new Error('Already at the last heat.');
      setRaceStatus(snapshot.races[index], 'complete', capturedAt);
      index = rebuildSchedule(snapshot, index + 1);
      setRaceStatus(snapshot.races[index], 'staging', capturedAt);
      break;
    case 'reset':
      index = rebuildSchedule(snapshot, 0);
      snapshot.races.forEach((race, raceIndex) => setRaceStatus(race, raceIndex === 0 ? 'staging' : raceIndex === 1 ? 'staging' : 'scheduled', capturedAt));
      break;
    case 'set-event-name':
      if (typeof action.name !== 'string' || action.name.trim() === '' || action.name.length > 200) throw new Error('Event name must contain 1 to 200 characters.');
      snapshot.event.name = action.name.trim();
      break;
    default:
      throw new Error(`Unknown simulator action '${action.type}'.`);
  }

  return touchSnapshot(snapshot, capturedAt);
}

export function simulatorView(snapshot) {
  const index = currentIndex(snapshot);
  const current = snapshot?.races?.[index] ?? null;
  const nextId = snapshot?.schedule?.nextRaceIds?.[0];
  const next = snapshot?.races?.find(race => race.id === nextId) ?? null;
  return { index, current, next, races: snapshot?.races ?? [] };
}

const $ = selector => document.querySelector(selector);
let snapshot = null;
let busy = false;

function setMessage(text, success = false) {
  const element = $('#message');
  element.textContent = text;
  element.className = `message${success ? ' success' : ''}`;
}

function setConnection(text, success = false) {
  const element = $('#connection-status');
  element.textContent = text;
  element.className = `status${success ? ' success' : ''}`;
}

function request(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {})
    }
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
    return data;
  });
}

function setControlsEnabled(enabled) {
  for (const control of document.querySelectorAll('#scenario-heading ~ *, #current-heat, #select-current, #current-status-buttons button, #next-status-buttons button, #advance, #reset, #event-form input, #event-form button')) {
    if (control.id === 'message') continue;
    control.disabled = !enabled;
  }
  $('#reload').disabled = false;
}

function render() {
  const view = simulatorView(snapshot);
  const current = view.current;
  const next = view.next;
  $('#current-title').textContent = current ? raceTitle(current) : 'No current heat';
  $('#current-status').textContent = current ? statusText(current.status) : 'Unknown';
  $('#current-pilots').textContent = current ? racePilots(current) : '—';
  $('#next-title').textContent = next ? raceTitle(next) : 'No next heat';
  $('#next-status').textContent = next ? statusText(next.status) : 'None';
  $('#next-pilots').textContent = next ? racePilots(next) : '—';
  $('#event-name').value = snapshot?.event?.name ?? '';

  const select = $('#current-heat');
  select.replaceChildren();
  for (const [raceIndex, race] of view.races.entries()) {
    const option = document.createElement('option');
    option.value = String(raceIndex);
    option.textContent = raceTitle(race);
    select.append(option);
  }
  select.value = String(view.index);
  for (const button of document.querySelectorAll('#current-status-buttons button')) button.dataset.active = button.dataset.status === current?.status ? 'true' : 'false';
  for (const button of document.querySelectorAll('#next-status-buttons button')) button.dataset.active = button.dataset.status === next?.status ? 'true' : 'false';
  $('#advance').disabled = busy || !next;
  setControlsEnabled(!busy);
  $('#advance').disabled = busy || !next;
  $('#select-current').disabled = busy;
}

async function loadSnapshot() {
  busy = true;
  setControlsEnabled(false);
  setConnection('Loading fixture snapshot…');
  try {
    const data = await request('/api/v1/snapshot');
    snapshot = data;
    render();
    setConnection(`Connected to local Fixture Hub · ${snapshot.event.name}`, true);
    setMessage('Ready. Choose a heat or status to publish a new simulated snapshot.', true);
  } catch (error) {
    setConnection(`Fixture snapshot unavailable: ${error.message}`);
    setMessage('Start the local Fixture Hub and reload this page.');
  } finally {
    busy = false;
    if (snapshot) render();
  }
}

async function apply(action, successMessage) {
  if (!snapshot || busy) return;
  busy = true;
  render();
  try {
    const nextSnapshot = applySimulatorAction(snapshot, action);
    const result = await request('/api/v1/test/snapshot', { method: 'POST', body: JSON.stringify(nextSnapshot) });
    snapshot = result.snapshot;
    setMessage(successMessage, true);
    setConnection(`Connected to local Fixture Hub · ${snapshot.event.name}`, true);
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy = false;
    render();
  }
}

function start() {
  $('#reload').addEventListener('click', loadSnapshot);
  $('#select-current').addEventListener('click', () => apply({ type: 'select-current', index: Number($('#current-heat').value) }, 'Current heat selected.'));
  $('#current-status-buttons').addEventListener('click', event => {
    const button = event.target.closest('button[data-status]');
    if (button) void apply({ type: 'set-current-status', status: button.dataset.status }, `Current heat set to ${statusText(button.dataset.status)}.`);
  });
  $('#next-status-buttons').addEventListener('click', event => {
    const button = event.target.closest('button[data-status]');
    if (button) void apply({ type: 'set-next-status', status: button.dataset.status }, `Next-up status set to ${statusText(button.dataset.status)}.`);
  });
  $('#advance').addEventListener('click', () => void apply({ type: 'advance' }, 'Current heat completed; advanced to the next heat in staging.'));
  $('#reset').addEventListener('click', () => void apply({ type: 'reset' }, 'Scenario reset to the first heat in staging.'));
  $('#event-form').addEventListener('submit', event => { event.preventDefault(); void apply({ type: 'set-event-name', name: $('#event-name').value }, 'Event name updated.'); });
  void loadSnapshot();
}

if (typeof document !== 'undefined') start();
