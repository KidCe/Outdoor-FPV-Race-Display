import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FORMAT = 'org.fpv.race-event.snapshot';
const HISTORY_FORMAT = 'org.fpv.race-event.announcement-history';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const RACE_STATUSES = Object.freeze(['scheduled', 'staging', 'running', 'complete', 'cancelled', 'not_run', 'unknown']);
const STATUSES = new Set(RACE_STATUSES);
const TIMING_STATES = new Set(['unknown', 'staging', 'running', 'complete', 'degraded', 'stale']);
const QUALITY_STATES = new Set(['fresh', 'degraded', 'stale', 'unknown']);
const CONFIDENCES = new Set(['high', 'medium', 'low', 'unknown']);
const ANNOUNCEMENT_STATUSES = new Set(['active', 'cleared', 'expired']);
const STREAM_TYPES = new Set(['snapshot', 'status', 'warning', 'heartbeat', 'reset', 'announcement', 'announcement-clear']);
const STATUS_CONNECTIONS = new Set(['disabled', 'connecting', 'handshaking', 'joining', 'reconciling', 'live', 'degraded', 'reconnecting', 'error']);
const ADMIN_ASSETS = new Map([
  ['/admin', [new URL('./admin.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/admin.html', [new URL('./admin.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/admin.js', [new URL('./admin.js', import.meta.url), 'application/javascript; charset=utf-8']],
  ['/admin.css', [new URL('./admin.css', import.meta.url), 'text/css; charset=utf-8']]
]);
const clone = value => structuredClone(value);
const defaultClock = () => new Date();
const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();
function validIdentifier(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 128 && ID_PATTERN.test(value); }
function hasCredentialQuery(url) { return [...url.searchParams.keys()].some(key => /pass(word)?|secret|token|api[-_]?key|auth(entication)?|credential/i.test(key)); }

const SOURCE_RACE_STATUS_ALIASES = new Map([
  ['scheduled', 'scheduled'], ['staging', 'staging'], ['running', 'running'], ['complete', 'complete'],
  ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['not_run', 'not_run'], ['unknown', 'unknown'],
  ['ready', 'staging'], ['racing', 'running'], ['not_yet_run', 'not_run']
]);
const SOURCE_TIMING_STATE_ALIASES = new Map([
  ['unknown', 'unknown'], ['staging', 'staging'], ['running', 'running'], ['complete', 'complete'],
  ['degraded', 'degraded'], ['stale', 'stale'], ['scheduled', 'unknown'], ['ready', 'staging'],
  ['racing', 'running'], ['not_run', 'unknown'], ['not_yet_run', 'unknown']
]);
function statusToken(value, kind) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${kind} must be a non-empty string`);
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
export function normalizeRaceStatus(value) {
  const sourceValue = String(value ?? '');
  const normalized = SOURCE_RACE_STATUS_ALIASES.get(statusToken(value, 'race status'));
  if (!normalized) throw new Error(`unsupported race status '${sourceValue}'`);
  return normalized;
}
function normalizeTimingState(value) {
  const sourceValue = String(value ?? '');
  const normalized = SOURCE_TIMING_STATE_ALIASES.get(statusToken(value, 'timing state'));
  if (!normalized) throw new Error(`unsupported timing state '${sourceValue}'`);
  return normalized;
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkKeys(value, allowed, path, errors) { if (!isObject(value)) { errors.push(`${path} must be an object`); return false; } for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`); return true; }
function requiredString(value, path, errors, { id = false, max = Infinity } = {}) { if (typeof value !== 'string' || value.length < 1 || value.length > max || (id && !ID_PATTERN.test(value))) errors.push(`${path} must be a valid string`); }
function optionalString(value, path, errors, { id = false, max = Infinity } = {}) { if (value !== undefined && value !== null) requiredString(value, path, errors, { id, max }); }
function dateTime(value, path, errors, nullable = false) { if (nullable && value === null) return; if (typeof value !== 'string' || !DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) errors.push(`${path} must be an ISO date-time`); }
function optionalDateTime(value, path, errors, nullable = false) { if (value !== undefined) dateTime(value, path, errors, nullable); }
function arrayOfIds(value, path, errors) { if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return; } value.forEach((item, index) => requiredString(item, `${path}[${index}]`, errors, { id: true, max: 128 })); }
function enumValue(value, allowed, path, errors) { if (!allowed.has(value)) errors.push(`${path} has an unsupported value`); }

function validateWarning(value, path, errors) {
  if (!checkKeys(value, new Set(['code', 'message', 'severity']), path, errors)) return;
  requiredString(value.code, `${path}.code`, errors, { max: 80 });
  if (!/^[a-z0-9_.-]+$/.test(value.code ?? '')) errors.push(`${path}.code has an invalid format`);
  requiredString(value.message, `${path}.message`, errors, { max: 500 });
  enumValue(value.severity, new Set(['info', 'warning', 'error']), `${path}.severity`, errors);
}

function validateDomainQuality(value, path, errors) {
  if (!checkKeys(value, new Set(['state', 'capturedAt', 'sourceIds', 'reason']), path, errors)) return;
  enumValue(value.state, QUALITY_STATES, `${path}.state`, errors);
  optionalDateTime(value.capturedAt, `${path}.capturedAt`, errors, true);
  if (value.sourceIds !== undefined) arrayOfIds(value.sourceIds, `${path}.sourceIds`, errors);
  optionalString(value.reason, `${path}.reason`, errors, { max: 240 });
}

function validateAnnouncementShape(value, path, errors) {
  if (!checkKeys(value, new Set(['announcementId', 'eventSessionId', 'title', 'body', 'importance', 'createdAt', 'createdByDeviceId', 'expiresAt', 'status', 'clearedAt', 'expiredAt']), path, errors)) return;
  requiredString(value.announcementId, `${path}.announcementId`, errors, { id: true, max: 128 });
  requiredString(value.eventSessionId, `${path}.eventSessionId`, errors, { id: true, max: 128 });
  requiredString(value.title, `${path}.title`, errors, { max: 80 });
  requiredString(value.body, `${path}.body`, errors, { max: 500 });
  if (!plainText(value.title)) errors.push(`${path}.title must be plain text`);
  if (!plainText(value.body)) errors.push(`${path}.body must be plain text`);
  if (!Number.isInteger(value.importance) || ![1, 2, 3].includes(value.importance)) errors.push(`${path}.importance must be 1, 2, or 3`);
  dateTime(value.createdAt, `${path}.createdAt`, errors);
  requiredString(value.createdByDeviceId, `${path}.createdByDeviceId`, errors, { id: true, max: 128 });
  dateTime(value.expiresAt, `${path}.expiresAt`, errors, true);
  enumValue(value.status, ANNOUNCEMENT_STATUSES, `${path}.status`, errors);
  optionalDateTime(value.clearedAt, `${path}.clearedAt`, errors, true);
  optionalDateTime(value.expiredAt, `${path}.expiredAt`, errors, true);
}

export function validateAnnouncement(announcement) {
  const errors = [];
  validateAnnouncementShape(announcement, 'announcement', errors);
  return { valid: errors.length === 0, errors };
}

function validatePilot(value, path, errors) {
  if (!checkKeys(value, new Set(['id', 'sourceId', 'callsign', 'slot', 'open', 'bumpUp', 'match', 'video']), path, errors)) return;
  requiredString(value.id, `${path}.id`, errors, { id: true, max: 128 });
  optionalString(value.sourceId, `${path}.sourceId`, errors, { id: true, max: 128 });
  requiredString(value.callsign, `${path}.callsign`, errors, { max: 80 });
  if (value.slot !== undefined && (!Number.isInteger(value.slot) || value.slot < 1)) errors.push(`${path}.slot must be a positive integer`);
  if (value.open !== undefined && typeof value.open !== 'boolean') errors.push(`${path}.open must be boolean`);
  if (value.bumpUp !== undefined && typeof value.bumpUp !== 'boolean') errors.push(`${path}.bumpUp must be boolean`);
  if (value.match !== undefined) {
    if (checkKeys(value.match, new Set(['method', 'confidence']), `${path}.match`, errors)) {
      enumValue(value.match.method, new Set(['source_id', 'callsign', 'alias', 'manual', 'unmatched']), `${path}.match.method`, errors);
      enumValue(value.match.confidence, CONFIDENCES, `${path}.match.confidence`, errors);
    }
  }
  if (value.video !== undefined && value.video !== null) {
    if (checkKeys(value.video, new Set(['channel', 'band', 'number', 'frequencyMHz']), `${path}.video`, errors)) {
      requiredString(value.video.channel, `${path}.video.channel`, errors, { max: 16 });
      optionalString(value.video.band, `${path}.video.band`, errors, { max: 16 });
      if (value.video.number !== undefined && (!Number.isInteger(value.video.number) || value.video.number < 1)) errors.push(`${path}.video.number must be a positive integer`);
      if (value.video.frequencyMHz !== undefined && (typeof value.video.frequencyMHz !== 'number' || !Number.isFinite(value.video.frequencyMHz) || value.video.frequencyMHz <= 0)) errors.push(`${path}.video.frequencyMHz must be positive`);
    }
  }
}

function validateTiming(value, path, errors) {
  if (!checkKeys(value, new Set(['state', 'elapsedMs', 'startedAt', 'stoppedAt', 'capturedAt']), path, errors)) return;
  enumValue(value.state, TIMING_STATES, `${path}.state`, errors);
  if (value.elapsedMs !== undefined && value.elapsedMs !== null && (!Number.isInteger(value.elapsedMs) || value.elapsedMs < 0)) errors.push(`${path}.elapsedMs must be a non-negative integer or null`);
  optionalDateTime(value.startedAt, `${path}.startedAt`, errors, true);
  optionalDateTime(value.stoppedAt, `${path}.stoppedAt`, errors, true);
  dateTime(value.capturedAt, `${path}.capturedAt`, errors);
}

function publicUri(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !hasCredentialQuery(url); } catch { return false; } }

function validateEvent(value, path, errors) {
  if (!checkKeys(value, new Set(['id', 'name', 'organizer', 'sourceUrl', 'startsAt', 'endsAt']), path, errors)) return;
  requiredString(value.id, `${path}.id`, errors, { id: true, max: 128 });
  requiredString(value.name, `${path}.name`, errors, { max: 200 });
  optionalString(value.organizer, `${path}.organizer`, errors, { max: 160 });
  if (value.sourceUrl !== undefined && (typeof value.sourceUrl !== 'string' || value.sourceUrl.length > 2048 || !publicUri(value.sourceUrl))) errors.push(`${path}.sourceUrl must be a URI without credentials`);
  optionalDateTime(value.startsAt, `${path}.startsAt`, errors, true);
  optionalDateTime(value.endsAt, `${path}.endsAt`, errors, true);
}

function sameEventIdentity(left, right) { return isObject(left) && isObject(right) && left.id === right.id && left.name === right.name; }

function validateRace(value, path, errors) {
  if (!checkKeys(value, new Set(['id', 'runId', 'attempt', 'order', 'label', 'phase', 'round', 'heat', 'status', 'timing', 'links', 'pilots']), path, errors)) return;
  requiredString(value.id, `${path}.id`, errors, { id: true, max: 128 });
  if (value.runId !== undefined && value.runId !== null) requiredString(value.runId, `${path}.runId`, errors, { id: true, max: 128 });
  if (value.attempt !== undefined && (!Number.isInteger(value.attempt) || value.attempt < 1)) errors.push(`${path}.attempt must be a positive integer`);
  if (!Number.isInteger(value.order) || value.order < 0) errors.push(`${path}.order must be a non-negative integer`);
  requiredString(value.label, `${path}.label`, errors, { max: 200 });
  optionalString(value.phase, `${path}.phase`, errors, { max: 120 });
  optionalString(value.round, `${path}.round`, errors, { max: 120 });
  if (value.heat !== undefined && value.heat !== null) {
    if (checkKeys(value.heat, new Set(['number', 'count']), `${path}.heat`, errors)) {
      if (!Number.isInteger(value.heat.number) || value.heat.number < 1) errors.push(`${path}.heat.number must be positive`);
      if (!Number.isInteger(value.heat.count) || value.heat.count < 1) errors.push(`${path}.heat.count must be positive`);
    }
  }
  enumValue(value.status, STATUSES, `${path}.status`, errors);
  if (value.timing !== undefined && value.timing !== null) validateTiming(value.timing, `${path}.timing`, errors);
  if (value.links !== undefined) {
    if (!isObject(value.links)) errors.push(`${path}.links must be an object`); else for (const [key, link] of Object.entries(value.links)) if (typeof link !== 'string' || !publicUri(link)) errors.push(`${path}.links.${key} must be a URI without credentials`);
  }
  if (!Array.isArray(value.pilots)) errors.push(`${path}.pilots must be an array`); else value.pilots.forEach((pilot, index) => validatePilot(pilot, `${path}.pilots[${index}]`, errors));
}

function validateSnapshotInternal(snapshot, path, errors) {
  if (!checkKeys(snapshot, new Set(['format', 'version', 'snapshotId', 'eventSessionId', 'capturedAt', 'event', 'sources', 'schedule', 'races', 'quality', 'activeAnnouncements']), path, errors)) return;
  if (snapshot.format !== FORMAT) errors.push(`${path}.format is unsupported`);
  if (snapshot.version !== 1) errors.push(`${path}.version is unsupported`);
  requiredString(snapshot.snapshotId, `${path}.snapshotId`, errors, { id: true, max: 128 });
  requiredString(snapshot.eventSessionId, `${path}.eventSessionId`, errors, { id: true, max: 128 });
  dateTime(snapshot.capturedAt, `${path}.capturedAt`, errors);
  validateEvent(snapshot.event, `${path}.event`, errors);
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length < 1) errors.push(`${path}.sources must contain at least one source`); else snapshot.sources.forEach((source, index) => { if (checkKeys(source, new Set(['id', 'provider', 'kind', 'revision', 'capturedAt', 'confidence']), `${path}.sources[${index}]`, errors)) { requiredString(source.id, `${path}.sources[${index}].id`, errors, { id: true, max: 128 }); requiredString(source.provider, `${path}.sources[${index}].provider`, errors, { max: 120 }); requiredString(source.kind, `${path}.sources[${index}].kind`, errors, { max: 120 }); requiredString(source.revision, `${path}.sources[${index}].revision`, errors, { max: 160 }); dateTime(source.capturedAt, `${path}.sources[${index}].capturedAt`, errors); if (source.confidence !== undefined) enumValue(source.confidence, CONFIDENCES, `${path}.sources[${index}].confidence`, errors); } });
  if (checkKeys(snapshot.schedule, new Set(['currentRaceId', 'currentIndex', 'nextRaceIds', 'afterNextRaceIds']), `${path}.schedule`, errors)) {
    if (snapshot.schedule.currentRaceId !== null) requiredString(snapshot.schedule.currentRaceId, `${path}.schedule.currentRaceId`, errors, { id: true, max: 128 });
    if (snapshot.schedule.currentIndex !== null && (!Number.isInteger(snapshot.schedule.currentIndex) || snapshot.schedule.currentIndex < 0)) errors.push(`${path}.schedule.currentIndex must be a non-negative integer or null`);
    arrayOfIds(snapshot.schedule.nextRaceIds, `${path}.schedule.nextRaceIds`, errors);
    if (snapshot.schedule.afterNextRaceIds !== undefined) arrayOfIds(snapshot.schedule.afterNextRaceIds, `${path}.schedule.afterNextRaceIds`, errors);
  }
  if (!Array.isArray(snapshot.races) || snapshot.races.length < 1) errors.push(`${path}.races must contain at least one race`); else { const raceIds = new Set(); snapshot.races.forEach((race, index) => { validateRace(race, `${path}.races[${index}]`, errors); if (isObject(race) && validIdentifier(race.id)) { if (raceIds.has(race.id)) errors.push(`${path}.races contains duplicate race ID ${race.id}`); raceIds.add(race.id); } }); }
  if (isObject(snapshot.schedule) && snapshot.schedule.currentRaceId !== null && Number.isInteger(snapshot.schedule.currentIndex) && snapshot.races?.[snapshot.schedule.currentIndex]?.id !== snapshot.schedule.currentRaceId) errors.push(`${path}.schedule current race does not match current index`);
  if (checkKeys(snapshot.quality, new Set(['state', 'completeRaceCount', 'warnings', 'domains']), `${path}.quality`, errors)) {
    enumValue(snapshot.quality.state, QUALITY_STATES, `${path}.quality.state`, errors);
    if (snapshot.quality.completeRaceCount !== undefined && (!Number.isInteger(snapshot.quality.completeRaceCount) || snapshot.quality.completeRaceCount < 0)) errors.push(`${path}.quality.completeRaceCount must be a non-negative integer`);
    if (!Array.isArray(snapshot.quality.warnings)) errors.push(`${path}.quality.warnings must be an array`); else snapshot.quality.warnings.forEach((warning, index) => validateWarning(warning, `${path}.quality.warnings[${index}]`, errors));
    if (!isObject(snapshot.quality.domains)) errors.push(`${path}.quality.domains must be an object`); else for (const [domain, value] of Object.entries(snapshot.quality.domains)) validateDomainQuality(value, `${path}.quality.domains.${domain}`, errors);
  }
  if (!Array.isArray(snapshot.activeAnnouncements)) errors.push(`${path}.activeAnnouncements must be an array`); else snapshot.activeAnnouncements.forEach((announcement, index) => { validateAnnouncementShape(announcement, `${path}.activeAnnouncements[${index}]`, errors); if (isObject(announcement) && announcement.eventSessionId !== snapshot.eventSessionId) errors.push(`${path}.activeAnnouncements[${index}] has a different event session`); if (isObject(announcement) && announcement.status !== 'active') errors.push(`${path}.activeAnnouncements[${index}] must be active`); });
}

export function validateSnapshot(snapshot) {
  const errors = [];
  if (!isObject(snapshot)) errors.push('snapshot must be an object'); else validateSnapshotInternal(snapshot, 'snapshot', errors);
  return { valid: errors.length === 0, errors };
}

function normalizeSourceRace(race) {
  if (!isObject(race)) return clone(race);
  const normalized = clone(race);
  if (Object.prototype.hasOwnProperty.call(normalized, 'status')) normalized.status = normalizeRaceStatus(normalized.status);
  if (isObject(normalized.timing) && Object.prototype.hasOwnProperty.call(normalized.timing, 'state')) normalized.timing.state = normalizeTimingState(normalized.timing.state);
  return normalized;
}
function normalizeSourceRaces(races) { return Array.isArray(races) ? races.map(normalizeSourceRace) : clone(races); }
function currentRaceStatus(snapshot) {
  const currentRaceId = snapshot?.schedule?.currentRaceId;
  if (!currentRaceId || !Array.isArray(snapshot?.races)) return null;
  return snapshot.races.find(race => race?.id === currentRaceId)?.status ?? null;
}
export function getActiveRaceStatus(snapshot) { return currentRaceStatus(snapshot); }
function applySourceRaceStatus(races, raceStatus, targetRaceId) {
  if (raceStatus === undefined) return races;
  const matching = Array.isArray(races) ? races.filter(race => !targetRaceId || race?.id === targetRaceId) : [];
  if (!targetRaceId && matching.length !== 1) throw new Error('source race status requires an unambiguous race ID');
  if (targetRaceId && matching.length !== 1) throw new Error(`source race status does not match race '${targetRaceId}'`);
  return races.map(race => race?.id === targetRaceId || (!targetRaceId && race === matching[0]) ? { ...race, status: raceStatus } : race);
}
function sourceFromSnapshot(snapshot) { return snapshot?.sources?.[0] ? clone(snapshot.sources[0]) : null; }

export class SourceObservation {
  constructor({ snapshot = null, snapshotId = null, source = null, eventSessionId = null, capturedAt = null, event, schedule, races, quality, replaceRaces = false, activeAnnouncements, raceStatus = undefined, status = undefined, raceId = null, currentRaceId = null } = {}) {
    const requestedStatus = raceStatus !== undefined ? raceStatus : status;
    const normalizedStatus = requestedStatus === undefined ? undefined : normalizeRaceStatus(requestedStatus);
    const fullSnapshot = snapshot && isObject(snapshot) && snapshot.format === FORMAT ? clone(snapshot) : null;
    const targetRaceId = currentRaceId ?? raceId ?? fullSnapshot?.schedule?.currentRaceId ?? schedule?.currentRaceId ?? (normalizedStatus !== undefined && Array.isArray(races) && races.length === 1 ? races[0]?.id : null);
    if (fullSnapshot) {
      fullSnapshot.races = normalizeSourceRaces(fullSnapshot.races);
      if (normalizedStatus !== undefined) fullSnapshot.races = applySourceRaceStatus(fullSnapshot.races, normalizedStatus, targetRaceId);
    }
    const normalizedRaces = races === undefined ? undefined : normalizeSourceRaces(races);
    const appliedRaces = normalizedStatus === undefined || normalizedRaces === undefined ? normalizedRaces : applySourceRaceStatus(normalizedRaces, normalizedStatus, targetRaceId ?? (normalizedRaces.length === 1 ? normalizedRaces[0]?.id : null));
    const derivedStatus = normalizedStatus ?? currentRaceStatus(fullSnapshot) ?? (targetRaceId ? appliedRaces?.find(race => race?.id === targetRaceId)?.status : undefined);
    this.kind = 'source-observation'; this.snapshot = fullSnapshot; this.snapshotId = snapshotId ?? fullSnapshot?.snapshotId ?? null; this.source = clone(source ?? sourceFromSnapshot(fullSnapshot)); this.eventSessionId = eventSessionId ?? fullSnapshot?.eventSessionId ?? null; this.capturedAt = capturedAt ?? fullSnapshot?.capturedAt ?? null; this.event = event === undefined ? undefined : clone(event); this.schedule = schedule === undefined ? undefined : clone(schedule); this.races = appliedRaces; this.quality = quality === undefined ? undefined : clone(quality); this.replaceRaces = Boolean(fullSnapshot || replaceRaces); this.activeAnnouncements = activeAnnouncements === undefined ? undefined : clone(activeAnnouncements); this.raceId = targetRaceId; this.currentRaceId = targetRaceId; this.raceStatus = derivedStatus ?? (fullSnapshot ? null : undefined); this.status = this.raceStatus;
  }
}

function asObservation(value) { return value instanceof SourceObservation ? value : (isObject(value) && value.format === FORMAT ? new SourceObservation({ snapshot: value }) : new SourceObservation(value ?? {})); }

function matchPilot(pilot, prior, used) { const index = prior.findIndex((candidate, position) => !used.has(position) && ((pilot.id && candidate.id === pilot.id) || (pilot.sourceId && candidate.sourceId === pilot.sourceId) || (pilot.slot !== undefined && candidate.slot === pilot.slot) || (pilot.callsign && candidate.callsign === pilot.callsign))); if (index < 0) return null; used.add(index); return prior[index]; }
function mergePilots(pilots, prior = []) { if (!Array.isArray(pilots) || pilots.length === 0) return clone(prior); const used = new Set(); return pilots.map(pilot => { const previous = matchPilot(pilot, prior, used); if (!previous) return clone(pilot); const merged = { ...previous, ...pilot }; if (!Object.prototype.hasOwnProperty.call(pilot, 'video')) merged.video = previous.video; if (!Object.prototype.hasOwnProperty.call(pilot, 'match')) merged.match = previous.match; return merged; }); }
function mergeRace(race, prior) { if (!prior) return clone(race); const merged = { ...prior, ...race }; if (Object.prototype.hasOwnProperty.call(race, 'timing') && race.timing && prior.timing) merged.timing = { ...prior.timing, ...race.timing }; if (Object.prototype.hasOwnProperty.call(race, 'pilots')) merged.pilots = mergePilots(race.pilots, prior.pilots); return merged; }
function mergePartialSnapshot(previous, observation, snapshotIdFactory) {
  const patch = {};
  if (observation.event !== undefined) patch.event = { ...previous.event, ...observation.event };
  if (observation.schedule !== undefined) patch.schedule = { ...previous.schedule, ...observation.schedule };
  if (observation.races !== undefined) {
    const priorById = new Map(previous.races.map(race => [race.id, race]));
    if (observation.replaceRaces || !observation.races.length) {
      patch.races = observation.replaceRaces ? clone(observation.races) : clone(previous.races);
    } else {
      const updates = new Map(observation.races.map(race => [race.id, race]));
      patch.races = previous.races.map(prior => updates.has(prior.id) ? mergeRace(updates.get(prior.id), prior) : clone(prior));
      for (const race of observation.races) if (!priorById.has(race.id)) patch.races.push(clone(race));
    }
  }
  if (observation.raceStatus !== undefined) {
    const targetRaceId = observation.currentRaceId ?? observation.raceId ?? patch.schedule?.currentRaceId ?? previous.schedule.currentRaceId;
    const races = patch.races ?? clone(previous.races);
    patch.races = applySourceRaceStatus(races, observation.raceStatus, targetRaceId);
  }
  if (observation.quality !== undefined) patch.quality = { ...previous.quality, ...observation.quality, domains: { ...previous.quality.domains, ...(observation.quality.domains ?? {}) }, warnings: observation.quality.warnings ?? previous.quality.warnings };
  if (observation.source) {
    const sources = previous.sources.filter(source => source.id !== observation.source.id);
    sources.push(clone(observation.source));
    patch.sources = sources;
  }
  const candidate = { ...previous, ...patch };
  if (observation.activeAnnouncements !== undefined) candidate.activeAnnouncements = clone(observation.activeAnnouncements);
  if (observation.capturedAt) candidate.capturedAt = observation.capturedAt;
  candidate.snapshotId = observation.snapshotId ?? snapshotIdFactory(observation);
  return candidate;
}

export class RaceStateAssembler {
  constructor({ eventSessionId = null, previous = null, snapshotIdFactory = observation => `hub-${observation.eventSessionId}-${observation.source?.revision ?? randomUUID()}` } = {}) { this.eventSessionId = eventSessionId; this.previous = previous ? clone(previous) : null; this.snapshotIdFactory = snapshotIdFactory; }
  selectEvent(eventSessionId) { const errors = []; requiredString(eventSessionId, 'eventSessionId', errors, { id: true, max: 128 }); if (errors.length) throw new Error(errors.join(', ')); this.eventSessionId = eventSessionId; this.previous = null; }
  clearEvent() { this.eventSessionId = null; this.previous = null; }
  assemble(input) { const observation = asObservation(input); if (!validIdentifier(observation.eventSessionId)) throw new Error('source observation has no valid event session'); if (this.eventSessionId && observation.eventSessionId !== this.eventSessionId) throw new Error('event session mismatch'); if (!this.eventSessionId) this.eventSessionId = observation.eventSessionId; const candidate = observation.snapshot ? clone(observation.snapshot) : (this.previous ? mergePartialSnapshot(this.previous, observation, this.snapshotIdFactory) : null); if (!candidate) throw new Error('a partial observation cannot establish a complete candidate'); if (!candidate.snapshotId) candidate.snapshotId = observation.snapshotId ?? this.snapshotIdFactory(observation); if (!candidate.capturedAt && observation.capturedAt) candidate.capturedAt = observation.capturedAt; const result = validateSnapshot(candidate); if (!result.valid) throw new Error(`candidate rejected: ${result.errors.join(', ')}`); if (candidate.eventSessionId !== this.eventSessionId) throw new Error('event session changed'); this.previous = clone(candidate); return clone(candidate); }
}

export class ReplaySource {
  constructor(snapshots = []) { this.snapshots = snapshots.map(clone); this.index = 0; }
  async next() { if (this.index >= this.snapshots.length) return null; return new SourceObservation({ snapshot: this.snapshots[this.index++] }); }
  async observe(signal) { if (signal?.aborted) throw new Error('replay observation was aborted'); return this.next(); }
  async nextSnapshot() { const observation = await this.next(); return observation?.snapshot ?? null; }
  reset() { this.index = 0; }
}

export function validateLiveFPVScoringUrl(value) { let url; try { url = new URL(String(value).trim()); } catch { throw new Error('LiveFPV scoring URL must be an absolute URL.'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || hasCredentialQuery(url)) throw new Error('LiveFPV scoring URL must be an HTTP(S) URL without embedded credentials.'); if (!/^\/live\/scoring\/?$/.test(url.pathname.replace(/\/+/g, '/'))) throw new Error('LiveFPV URL must point to /live/scoring/.'); return url; }

export class LiveFPVAdapter {
  constructor({ scoringUrl, fetchImpl = globalThis.fetch, parseScoring } = {}) { this.scoringUrl = scoringUrl ?? ''; this.fetchImpl = fetchImpl; this.parseScoring = parseScoring; }
  configure(scoringUrl) { this.scoringUrl = scoringUrl; }
  async observe(signal) { const url = validateLiveFPVScoringUrl(this.scoringUrl); if (typeof this.fetchImpl !== 'function') throw new Error('Fetch is unavailable for the LiveFPV adapter.'); if (typeof this.parseScoring !== 'function') throw new Error('LiveFPV scoring parser is not configured.'); const response = await this.fetchImpl(url, { headers: { accept: 'text/html, application/json' }, cache: 'no-store', signal }); if (!response.ok) throw new Error(`LiveFPV scoring request failed with HTTP ${response.status}.`); const raw = await response.text(); const parsed = await this.parseScoring({ raw, response, url }); return asObservation(parsed); }
}

function staleSnapshot(base, reason) { const snapshot = clone(base); const warningCode = reason === 'persisted_recovery' ? 'state.restored_stale' : 'source.reconnecting'; const message = reason === 'persisted_recovery' ? 'Restored persisted state; awaiting fresh source data.' : 'No newer trusted observation is available.'; snapshot.quality = { ...snapshot.quality, state: 'stale', warnings: snapshot.quality.warnings.some(warning => warning.code === warningCode) ? snapshot.quality.warnings : [...snapshot.quality.warnings, { code: warningCode, message, severity: 'warning' }] }; snapshot.quality.domains = Object.fromEntries(Object.entries(snapshot.quality.domains).map(([key, domain]) => [key, { ...domain, state: 'stale', reason }])); snapshot.races = snapshot.races.map(race => race.timing ? { ...race, timing: { ...race.timing, state: 'stale' } } : race); return snapshot; }
function plainText(value) { return typeof value === 'string' && !/<\/?[A-Za-z][^>]*>/.test(value) && !/```|\[[^\]]+\]\([^)]*\)/.test(value) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value); }

export class TrustedStore {
  constructor({ epoch = randomUUID(), eventSessionId = null, persistencePath = null, historyLimit = 256, announcementRetentionMs = 14 * 24 * 60 * 60 * 1000, now = defaultClock } = {}) { if (!validIdentifier(epoch)) throw new Error('hub epoch must be a valid identifier'); if (eventSessionId !== null && !validIdentifier(eventSessionId)) throw new Error('event session id must be a valid identifier'); this.hubEpoch = epoch; this.persistencePath = persistencePath; this.historyLimit = Math.max(1, historyLimit); this.announcementRetentionMs = announcementRetentionMs; this.now = now; this.eventSessionId = eventSessionId; this.eventContext = null; this.snapshot = null; this.trustedSnapshot = null; this.stagedCandidate = null; this.snapshotSequence = 0; this.streamSequence = 0; this.history = []; this.subscribers = new Set(); this.sourceRevisions = new Map(); this.announcements = new Map(); this.announcementHistory = []; this.bootstrapCache = null; this.saveQueue = Promise.resolve(); this.status = { connection: eventSessionId ? 'joining' : 'disabled', source: '', event: '', quality: 'unknown', raceStatus: null }; }
  get active() { return Boolean(this.eventSessionId); }
  getStatus() { return clone(this.status); }
  subscribe(listener) { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }
  #record(event) { this.history.push(event); if (this.history.length > this.historyLimit) this.history.shift(); }
  #knownEventContext() { return this.eventContext ?? this.trustedSnapshot?.event ?? this.snapshot?.event ?? this.stagedCandidate?.event ?? null; }
  emit(type, data, extra = {}, { broadcast = true, record = true } = {}) { if (!STREAM_TYPES.has(type)) throw new Error(`unsupported stream event type: ${type}`); const event = { type, hubEpoch: this.hubEpoch, eventSessionId: this.eventSessionId ?? null, streamSequence: ++this.streamSequence, deliveredAt: iso(this.now()), data: clone(data), ...extra }; if (record) this.#record(event); if (broadcast) { this.bootstrapCache = null; for (const subscriber of this.subscribers) { try { subscriber(clone(event)); } catch {} } } return clone(event); }
  emitStatus(patch = {}, { force = false } = {}) { const raceStatus = patch.raceStatus === undefined ? (this.status.raceStatus ?? null) : patch.raceStatus; if (raceStatus !== null && !STATUSES.has(raceStatus)) throw new Error('Hub status race status is invalid'); const next = { ...this.status, ...patch, event: patch.event ?? this.status.event ?? '', source: patch.source ?? this.status.source ?? '', quality: QUALITY_STATES.has(patch.quality) ? patch.quality : (this.status.quality ?? 'unknown'), connection: STATUS_CONNECTIONS.has(patch.connection) ? patch.connection : (this.status.connection ?? 'disabled'), raceStatus }; const changed = JSON.stringify(next) !== JSON.stringify(this.status); this.status = next; return force || changed ? this.emit('status', this.status) : null; }
  selectEvent(selection) { const nextId = typeof selection === 'string' ? selection : selection?.eventSessionId; const errors = []; requiredString(nextId, 'eventSessionId', errors, { id: true, max: 128 }); const nextContext = typeof selection === 'string' ? null : clone(selection?.event ?? null); if (nextContext) validateEvent(nextContext, 'event', errors); if (errors.length) throw new Error(errors.join(', ')); const changed = this.eventSessionId !== nextId; const currentContext = this.#knownEventContext(); if (!changed && nextContext && currentContext && !sameEventIdentity(currentContext, nextContext)) throw new Error('event context mismatch'); this.eventSessionId = nextId; if (nextContext) this.eventContext = nextContext; if (!changed) return false; if (!nextContext) this.eventContext = null; this.snapshot = null; this.trustedSnapshot = null; this.stagedCandidate = null; this.sourceRevisions.clear(); this.announcements.clear(); this.announcementHistory = []; this.emit('reset', { reason: 'event_changed' }); this.emitStatus({ connection: 'joining', source: '', event: this.eventContext?.name ?? '', quality: 'unknown', raceStatus: null }); this.#persistSoon(); return true; }
  deactivateEvent() { if (!this.eventSessionId) return false; this.eventSessionId = null; this.eventContext = null; this.snapshot = null; this.trustedSnapshot = null; this.stagedCandidate = null; this.sourceRevisions.clear(); this.announcements.clear(); this.announcementHistory = []; this.emit('reset', { reason: 'event_changed' }); this.emitStatus({ connection: 'disabled', source: '', event: '', quality: 'unknown', raceStatus: null }); this.#persistSoon(); return true; }
  stage(candidate) { if (!this.eventSessionId) throw new Error('no active event'); const result = validateSnapshot(candidate); if (!result.valid) throw new Error(`candidate rejected: ${result.errors.join(', ')}`); if (candidate.eventSessionId !== this.eventSessionId) throw new Error('event session mismatch'); const currentContext = this.#knownEventContext(); if (currentContext && !sameEventIdentity(currentContext, candidate.event)) throw new Error('event context mismatch'); if (this.trustedSnapshot && Date.parse(candidate.capturedAt) < Date.parse(this.trustedSnapshot.capturedAt)) throw new Error('candidate is older than the trusted snapshot'); this.stagedCandidate = clone(candidate); return clone(this.stagedCandidate); }
  promote() { if (!this.stagedCandidate) throw new Error('no staged candidate'); const next = clone(this.stagedCandidate); if (next.eventSessionId !== this.eventSessionId) throw new Error('event session mismatch'); const currentContext = this.#knownEventContext(); if (currentContext && !sameEventIdentity(currentContext, next.event)) throw new Error('event context mismatch'); this.stagedCandidate = null; next.activeAnnouncements = this.getActiveAnnouncements(); this.trustedSnapshot = clone(next); this.snapshot = clone(next); this.eventContext ??= clone(next.event); for (const source of next.sources) this.sourceRevisions.set(source.id, source.revision); const event = this.emit('snapshot', next, { snapshotSequence: ++this.snapshotSequence }); this.emitStatus({ connection: 'live', source: next.sources[0]?.provider ?? '', event: next.event.name, quality: next.quality.state, raceStatus: currentRaceStatus(next), message: '' }); this.#persistSoon(); return event; }
  publish(candidate) { this.stage(candidate); return this.promote(); }
  markStale(reason = 'source_reconnecting') { if (!this.trustedSnapshot || this.snapshot?.quality?.state === 'stale') return null; this.snapshot = staleSnapshot(this.trustedSnapshot, reason); this.emitStatus({ connection: 'reconnecting', quality: 'stale', raceStatus: currentRaceStatus(this.snapshot) }); return this.emit('snapshot', this.snapshot); }
  getSince(sequence) { return this.history.filter(event => event.streamSequence > sequence).map(clone); }
  bootstrap({ lastEventId, hubEpoch, eventSessionId } = {}) { const hasLast = lastEventId !== undefined && lastEventId !== null && String(lastEventId) !== ''; let reason = null; if (hubEpoch && hubEpoch !== this.hubEpoch) reason = 'epoch_changed'; else if (eventSessionId !== undefined && eventSessionId !== (this.eventSessionId ?? null)) reason = 'event_changed'; else if (!hasLast) reason = 'bootstrap'; else { const last = Number(lastEventId); const oldest = this.history[0]?.streamSequence; const replay = Number.isSafeInteger(last) && last >= 0 && last <= this.streamSequence && !(oldest !== undefined && last < oldest - 1) ? this.getSince(last) : null; if (!replay) reason = 'history_gap'; else if (replay.some(event => event.eventSessionId !== (this.eventSessionId ?? null))) reason = 'event_changed'; else return replay; } const activeAnnouncements = this.getActiveAnnouncements(); const cacheKey = `${reason}|${this.eventSessionId ?? ''}|${this.snapshot?.snapshotId ?? ''}|${JSON.stringify(activeAnnouncements)}`; if (this.bootstrapCache?.key === cacheKey) return this.bootstrapCache.events.map(clone); const events = [this.emit('reset', { reason }, {}, { broadcast: false })]; if (this.snapshot) events.push(this.emit('snapshot', this.snapshot, { snapshotSequence: this.snapshotSequence }, { broadcast: false })); for (const announcement of activeAnnouncements) events.push(this.emit('announcement', announcement, {}, { broadcast: false })); this.bootstrapCache = { key: cacheKey, events: events.map(clone) }; return events; }
  heartbeat() { return this.emit('heartbeat', {}); }
  #activeAnnouncementArray() { return [...this.announcements.values()].filter(item => item.status === 'active').sort((a, b) => b.importance - a.importance || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.announcementId.localeCompare(b.announcementId)).map(clone); }
  getActiveAnnouncements() { this.expireAnnouncements(); return this.#activeAnnouncementArray(); }
  #syncAnnouncements() { const active = this.#activeAnnouncementArray(); if (this.trustedSnapshot) this.trustedSnapshot.activeAnnouncements = clone(active); if (this.snapshot) this.snapshot.activeAnnouncements = clone(active); }
  #replaceHistoryItem(announcement) { const index = this.announcementHistory.findIndex(item => item.announcementId === announcement.announcementId); if (index >= 0) this.announcementHistory[index] = clone(announcement); else this.announcementHistory.push(clone(announcement)); }
  #pruneAnnouncementHistory(nowValue) { const cutoff = nowValue.getTime() - this.announcementRetentionMs; this.announcementHistory = this.announcementHistory.filter(item => Date.parse(item.createdAt) >= cutoff); }
  expireAnnouncements(at = this.now()) { const current = at instanceof Date ? at : new Date(at); if (Number.isNaN(current.getTime())) throw new Error('invalid expiration time'); let changed = false; for (const announcement of [...this.announcements.values()]) if (announcement.expiresAt && Date.parse(announcement.expiresAt) <= current.getTime()) { const expired = { ...announcement, status: 'expired', expiredAt: iso(current) }; this.announcements.delete(announcement.announcementId); this.#replaceHistoryItem(expired); this.emit('announcement', expired); changed = true; } this.#pruneAnnouncementHistory(current); if (changed) { this.#syncAnnouncements(); this.#persistSoon(); } return changed; }
  createAnnouncement(input) { if (!this.eventSessionId) throw new Error('no active event'); if (!isObject(input)) throw new Error('announcement body must be an object'); const allowed = new Set(['title', 'body', 'importance', 'createdByDeviceId', 'expiresAt']); const errors = Object.keys(input).filter(key => !allowed.has(key)).map(key => `${key} is not allowed`); for (const key of ['title', 'body', 'createdByDeviceId']) if (typeof input[key] !== 'string' || input[key].length < 1) errors.push(`${key} is required`); if (!plainText(input.title) || input.title.length > 80) errors.push('title must be plain text with at most 80 characters'); if (!plainText(input.body) || input.body.length > 500) errors.push('body must be plain text with at most 500 characters'); if (typeof input.createdByDeviceId !== 'string' || !ID_PATTERN.test(input.createdByDeviceId) || input.createdByDeviceId.length > 128) errors.push('createdByDeviceId is invalid'); if (!Number.isInteger(input.importance) || ![1, 2, 3].includes(input.importance)) errors.push('importance must be 1, 2, or 3'); if (input.expiresAt !== undefined && input.expiresAt !== null) dateTime(input.expiresAt, 'expiresAt', errors); if (errors.length) throw new Error(`announcement rejected: ${errors.join(', ')}`); const createdAt = iso(this.now()); const expiresAt = input.expiresAt ?? null; const announcement = { announcementId: `announcement-${randomUUID()}`, eventSessionId: this.eventSessionId, title: input.title, body: input.body, importance: input.importance, createdAt, createdByDeviceId: input.createdByDeviceId, expiresAt, status: expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt) ? 'expired' : 'active' }; if (announcement.status === 'expired') announcement.expiredAt = createdAt; else this.announcements.set(announcement.announcementId, clone(announcement)); this.#replaceHistoryItem(announcement); this.#pruneAnnouncementHistory(new Date(createdAt)); this.#syncAnnouncements(); this.emit('announcement', announcement); this.#persistSoon(); return clone(announcement); }
  clearAnnouncement(announcementId, clearedAt = this.now()) { if (!this.eventSessionId) throw new Error('no active event'); const existing = this.announcements.get(announcementId); if (!existing) { const historical = this.announcementHistory.find(item => item.announcementId === announcementId); if (!historical) throw new Error('announcement not found'); return clone(historical); } const cleared = { ...existing, status: 'cleared', clearedAt: iso(clearedAt) }; this.announcements.delete(announcementId); this.#replaceHistoryItem(cleared); this.#syncAnnouncements(); this.emit('announcement-clear', { announcementId, clearedAt: cleared.clearedAt }); this.#persistSoon(); return clone(cleared); }
  getAnnouncementHistory({ cursor = null, limit = 100 } = {}) { if (!this.eventSessionId) throw new Error('no active event'); this.expireAnnouncements(); const start = cursor === null || cursor === '' ? 0 : Number(cursor); if (!Number.isSafeInteger(start) || start < 0) throw new Error('invalid history cursor'); const size = Math.min(100, Math.max(1, Number(limit) || 100)); const items = this.announcementHistory.slice(start, start + size).map(clone); return { format: HISTORY_FORMAT, version: 1, eventSessionId: this.eventSessionId, items, nextCursor: start + size < this.announcementHistory.length ? String(start + size) : null }; }
  async #writeState() { const state = { version: 1, activeEvent: this.eventSessionId ? { eventSessionId: this.eventSessionId, event: this.eventContext } : null, trustedSnapshot: this.trustedSnapshot, snapshotSequence: this.snapshotSequence, sourceRevisions: Object.fromEntries(this.sourceRevisions), announcementHistory: this.announcementHistory }; await mkdir(dirname(this.persistencePath), { recursive: true }); const temp = `${this.persistencePath}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(state, null, 2), { flag: 'wx' }); try { await rename(temp, this.persistencePath); } catch (error) { try { await rm(temp, { force: true }); } catch {} throw error; } }
  async save() { if (!this.persistencePath) return; const task = this.saveQueue.then(() => this.#writeState()); this.saveQueue = task.catch(() => {}); return task; }
  #persistSoon() { if (this.persistencePath) void this.save().catch(() => {}); }
  async restore() { if (!this.persistencePath) return null; try { const state = JSON.parse(await readFile(this.persistencePath, 'utf8')); const active = state.activeEvent; const base = state.trustedSnapshot; if (state.version !== 1 || !active || !isObject(active) || !validIdentifier(active.eventSessionId)) return null; if (!base) { this.eventSessionId = active.eventSessionId; this.eventContext = clone(active.event ?? null); this.status = { connection: 'joining', source: '', event: this.eventContext?.name ?? '', quality: 'unknown', raceStatus: null }; return null; } if (!isObject(base) || active.eventSessionId !== base.eventSessionId) return null; const result = validateSnapshot(base); if (!result.valid) return null; if (active.event && (active.event.id !== base.event.id || active.event.name !== base.event.name)) return null; this.eventSessionId = active.eventSessionId; this.eventContext = clone(active.event ?? base.event); this.trustedSnapshot = clone(base); this.snapshotSequence = Number.isSafeInteger(state.snapshotSequence) && state.snapshotSequence >= 0 ? state.snapshotSequence : 0; this.sourceRevisions = isObject(state.sourceRevisions) ? new Map(Object.entries(state.sourceRevisions).filter(([key, value]) => validIdentifier(key) && typeof value === 'string')) : new Map(); this.announcementHistory = Array.isArray(state.announcementHistory) ? state.announcementHistory.filter(item => validateAnnouncement(item).valid && item.eventSessionId === this.eventSessionId).map(clone) : []; this.announcements = new Map(this.announcementHistory.filter(item => item.status === 'active').map(item => [item.announcementId, clone(item)])); this.snapshot = staleSnapshot(this.trustedSnapshot, 'persisted_recovery'); this.#syncAnnouncements(); this.status = { connection: 'reconnecting', source: this.snapshot.sources[0]?.provider ?? '', event: this.snapshot.event.name, quality: 'stale', raceStatus: currentRaceStatus(this.snapshot) }; return clone(this.snapshot); } catch { return null; } }
}

export class RaceDataHub {
  constructor({ source, store, assembler = new RaceStateAssembler() } = {}) { if (!source || typeof source.observe !== 'function') throw new Error('RaceDataHub requires a source adapter.'); if (!store) throw new Error('RaceDataHub requires a TrustedStore.'); this.source = source; this.store = store; this.assembler = assembler; this.abortController = null; }
  selectEvent(selection) { this.store.selectEvent(selection); const eventSessionId = typeof selection === 'string' ? selection : selection?.eventSessionId; this.assembler.selectEvent(eventSessionId); }
  async refresh() { if (!this.store.active) throw new Error('no active event'); this.store.emitStatus({ connection: 'reconciling', quality: this.store.snapshot?.quality?.state ?? 'unknown' }); this.abortController?.abort(); const controller = new AbortController(); this.abortController = controller; try { const observation = await this.source.observe(controller.signal); if (!observation) throw new Error('source returned no observation'); const candidate = this.assembler.assemble(observation); if (candidate.eventSessionId !== this.store.eventSessionId) throw new Error('source observation does not belong to the selected event'); return this.store.publish(candidate); } catch (error) { if (controller.signal.aborted) throw error; this.store.markStale('source_reconnecting'); this.store.emitStatus({ connection: this.store.snapshot ? 'reconnecting' : 'error', quality: this.store.snapshot?.quality?.state ?? 'unknown', message: error.message }); throw error; } finally { if (this.abortController === controller) this.abortController = null; } }
  async start(selection) { this.selectEvent(selection); return this.refresh(); }
  stop() { this.abortController?.abort(); this.abortController = null; if (this.store.active) this.store.emitStatus({ connection: 'disabled' }); }
  deactivateEvent() { this.stop(); this.store.deactivateEvent(); this.assembler.clearEvent(); }
}

function json(response, body, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
function sendSse(response, event) { response.write(`id: ${event.streamSequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
function errorBody(error) { return { error: error instanceof Error ? error.message : 'request failed' }; }
function authorized(request, expected) { if (typeof expected !== 'string' || expected.length === 0) return false; const supplied = request.headers['x-event-write-password']; if (typeof supplied !== 'string') return false; const left = Buffer.from(supplied); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }
async function requestJson(request, maxBytes = 64 * 1024) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw new Error('request body is too large'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('request body is not valid JSON'); } }
async function asset(response, file, contentType) { try { response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }); response.end(await readFile(file)); } catch { json(response, { error: 'not_found' }, 404); } }

export function createHubServer({ store, status = () => store.getStatus(), writePassword = null, heartbeatMs = 15000 } = {}) {
  if (!store) throw new Error('createHubServer requires a TrustedStore');
  const server = createServer((request, response) => { void handleRequest(request, response); });
  const timer = heartbeatMs > 0 ? setInterval(() => store.heartbeat(), heartbeatMs) : null; timer?.unref?.(); server.on('close', () => { if (timer) clearInterval(timer); });
  async function handleRequest(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'accept, content-type, last-event-id, x-hub-epoch, x-event-session-id, x-event-write-password'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && ADMIN_ASSETS.has(url.pathname)) { const [file, contentType] = ADMIN_ASSETS.get(url.pathname); return asset(response, file, contentType); }
      if (request.method === 'GET' && url.pathname === '/api/v1/health') return json(response, { ok: true, hubEpoch: store.hubEpoch });
      if (request.method === 'GET' && url.pathname === '/api/v1/status') return json(response, typeof status === 'function' ? status() : store.getStatus());
      if (request.method === 'GET' && url.pathname === '/api/v1/snapshot') return store.snapshot ? json(response, store.snapshot) : json(response, { error: 'no_active_event' }, 404);
      if (request.method === 'GET' && url.pathname === '/api/v1/announcements/history') return store.active ? json(response, store.getAnnouncementHistory({ cursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit') })) : json(response, { error: 'no_active_event' }, 404);
      if (request.method === 'GET' && url.pathname === '/api/v1/stream') return stream(request, response, url);
      if (request.method === 'POST' && url.pathname === '/api/v1/admin/event') { if (!authorized(request, writePassword)) return json(response, { error: 'write authorization required' }, 401); const input = await requestJson(request); if (!isObject(input) || !validIdentifier(input.eventSessionId)) throw new Error('eventSessionId is required'); if (input.event !== undefined && input.event !== null && !isObject(input.event)) throw new Error('event must be an object'); store.selectEvent({ eventSessionId: input.eventSessionId, event: input.event ?? null }); return json(response, { activeEvent: input.eventSessionId, status: store.getStatus() }); }
      if (request.method === 'POST' && url.pathname === '/api/v1/admin/event/deactivate') { if (!authorized(request, writePassword)) return json(response, { error: 'write authorization required' }, 401); await requestJson(request); store.deactivateEvent(); return json(response, { activeEvent: null, status: store.getStatus() }); }
      if (request.method === 'POST' && url.pathname === '/api/v1/announcements') { if (!authorized(request, writePassword)) return json(response, { error: 'write authorization required' }, 401); const announcement = store.createAnnouncement(await requestJson(request)); return json(response, announcement, 201); }
      const clearMatch = request.method === 'POST' ? url.pathname.match(/^\/api\/v1\/announcements\/([^/]+)\/clear$/) : null;
      if (clearMatch) { if (!authorized(request, writePassword)) return json(response, { error: 'write authorization required' }, 401); const cleared = store.clearAnnouncement(decodeURIComponent(clearMatch[1])); return json(response, cleared); }
      return json(response, { error: 'not_found' }, 404);
    } catch (error) { return json(response, errorBody(error), error.message === 'no active event' || error.message === 'announcement not found' ? 404 : 400); }
  }
  function stream(request, response, url) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Hub-Epoch': store.hubEpoch });
    let closed = false; const unsubscribe = store.subscribe(event => { if (!closed) sendSse(response, event); }); const cleanup = () => { if (closed) return; closed = true; unsubscribe(); response.end(); }; request.on('close', cleanup); response.on('error', cleanup); const events = store.bootstrap({ lastEventId: request.headers['last-event-id'], hubEpoch: request.headers['x-hub-epoch'] ?? url.searchParams.get('hubEpoch'), eventSessionId: request.headers['x-event-session-id'] ?? url.searchParams.get('eventSessionId') }); for (const event of events) if (!closed) sendSse(response, event);
  }
  return server;
}
