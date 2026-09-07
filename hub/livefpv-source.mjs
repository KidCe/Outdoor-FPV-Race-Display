import { validateSnapshot } from './index.mjs';

const FORMAT = 'org.fpv.race-event.snapshot';
const SOURCE_ID = 'livefpv-source';
const ACTIVE_STATUSES = new Set(['staging', 'running']);
const KNOWN_STATUSES = new Set(['scheduled', 'staging', 'running', 'complete', 'cancelled', 'not_run', 'unknown']);

const clone = value => structuredClone(value);

function safeId(value, fallback) {
  const normalized = String(value || fallback).trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || fallback).slice(0, 128);
}

function normalizedText(value) { return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' '); }

function status(value) {
  const normalized = normalizedText(value).replace(/^race\s+status\s*:\s*/, '').replace(/^status\s*:\s*/, '');
  if (/^(?:ready|staging)\b/.test(normalized)) return 'staging';
  if (/^(?:racing|running)\b/.test(normalized)) return 'running';
  if (/^(?:completed|complete)\b/.test(normalized)) return 'complete';
  if (/^(?:not yet run|not run|not_run)\b/.test(normalized)) return 'not_run';
  if (/^(?:canceled|cancelled)\b/.test(normalized)) return 'cancelled';
  const canonical = normalized.replaceAll(' ', '_');
  return KNOWN_STATUSES.has(canonical) ? canonical : 'unknown';
}

function scopeValue(value) {
  const normalized = normalizedText(value);
  const qualifier = normalized.match(/^(?:q|qualifier\s+round)\s*(\d+)$/);
  if (qualifier) return `qualifier round ${qualifier[1]}`;
  if (/^mains?$|^main events?$/.test(normalized)) return 'main events';
  return normalized;
}

function sameHeatIdentity(left, right) {
  if (!left || !right) return false;
  for (const field of ['phase', 'round', 'className']) {
    const leftValue = scopeValue(left[field]);
    const rightValue = scopeValue(right[field]);
    if (leftValue || rightValue) return leftValue !== '' && leftValue === rightValue;
  }
  const leftHeat = left.heat;
  const rightHeat = right.heat;
  return Boolean(leftHeat && rightHeat && leftHeat.number === rightHeat.number && leftHeat.count === rightHeat.count);
}

function heatId(eventId, heat, fallback = 'current') {
  const parts = [eventId, heat.phase, heat.round, heat.className, heat.heat?.number, heat.heat?.count, heat.sourceRaceNumber || fallback]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
    .map(value => safeId(value, 'unknown'));
  return safeId(`livefpv-${parts.join('-')}`, `livefpv-${eventId}-${fallback}`);
}

function raceFromHeat(heat, index) {
  const sourceStatus = status(heat.status);
  return {
    id: safeId(heat.id, `heat-${index + 1}`),
    ...(heat.runId === undefined ? {} : { runId: heat.runId }),
    ...(heat.attempt === undefined ? {} : { attempt: heat.attempt }),
    order: Number.isInteger(heat.order) ? heat.order : index,
    label: String(heat.label || `${heat.phase || 'Race'}${heat.heat ? ` (Heat ${heat.heat.number}/${heat.heat.count})` : ''}`).slice(0, 200),
    ...(heat.phase ? { phase: String(heat.phase).slice(0, 120) } : {}),
    ...(heat.round ? { round: String(heat.round).slice(0, 120) } : {}),
    ...(heat.heat ? { heat: clone(heat.heat) } : {}),
    status: sourceStatus,
    ...(heat.timing ? { timing: clone(heat.timing) } : {}),
    links: clone(heat.links || {}),
    pilots: clone(Array.isArray(heat.pilots) ? heat.pilots : [])
  };
}

function liveNowMatches(liveNow, heat) {
  if (!liveNow || !heat || !liveNow.heat || !heat.heat) return false;
  if (liveNow.heat.number !== heat.heat.number || liveNow.heat.count !== heat.heat.count) return false;
  for (const [left, right] of [[liveNow.phase, heat.phase], [liveNow.round, heat.round], [liveNow.className, heat.className]]) {
    const leftValue = scopeValue(left);
    const rightValue = scopeValue(right);
    if (leftValue && rightValue && leftValue !== rightValue) return false;
  }
  return true;
}

function withLiveNow(race, liveNow) {
  const next = clone(race);
  next.status = status(liveNow.status);
  if (liveNow.runId !== undefined) next.runId = liveNow.runId;
  if (liveNow.attempt !== undefined) next.attempt = liveNow.attempt;
  if (liveNow.timing) next.timing = clone(liveNow.timing);
  if (Array.isArray(liveNow.pilots) && liveNow.pilots.length) next.pilots = clone(liveNow.pilots);
  return next;
}

function mergeSameHeatDetails(current, previous) {
  if (!previous || !sameHeatIdentity(current, previous)) return current;
  const next = clone(current);
  if ((!Array.isArray(next.pilots) || next.pilots.length === 0) && Array.isArray(previous.pilots) && previous.pilots.length) next.pilots = clone(previous.pilots);
  if (!next.timing && previous.timing) next.timing = clone(previous.timing);
  return next;
}

function scheduleFor(races, currentIndex) {
  const currentRaceId = currentIndex >= 0 ? races[currentIndex]?.id ?? null : null;
  const following = currentIndex >= 0 ? races.slice(currentIndex + 1).map(race => race.id) : [];
  return {
    currentRaceId,
    currentIndex: currentIndex >= 0 ? currentIndex : null,
    nextRaceIds: following.slice(0, 2),
    afterNextRaceIds: following.slice(2, 5)
  };
}

function qualityFor({ liveNow, races, capturedAt, sourceId, ambiguous = false, eventMismatch = false }) {
  const fresh = Boolean(!ambiguous && !eventMismatch && liveNow?.available && (ACTIVE_STATUSES.has(status(liveNow.status)) || status(liveNow.status) === 'complete'));
  const state = fresh ? 'fresh' : (ambiguous || eventMismatch) ? 'degraded' : 'stale';
  const domain = (domainState = state, reason) => ({ state: domainState, capturedAt, sourceIds: [sourceId], ...(reason ? { reason } : {}) });
  const warning = ambiguous
    ? { code: 'livefpv.live_now_ambiguous', message: 'LiveNow does not identify one unambiguous scheduled heat.', severity: 'warning' }
    : eventMismatch
      ? { code: 'livefpv.event_mismatch', message: 'LiveNow belongs to a different event and was not selected.', severity: 'warning' }
      : { code: 'livefpv.live_now_unavailable', message: 'LiveNow has no authoritative active heat.', severity: 'warning' };
  return {
    state,
    completeRaceCount: races.filter(race => race.status === 'complete').length,
    warnings: fresh ? [] : [warning],
    domains: {
      schedule: domain(races.length && !ambiguous ? 'fresh' : state),
      lineup: domain(liveNow?.pilots?.length || races.some(race => race.pilots.length) ? 'fresh' : 'degraded'),
      timing: domain(liveNow?.timing && !ambiguous ? state : 'degraded'),
      channels: domain(races.some(race => race.pilots.some(pilot => pilot.video?.channel)) ? 'fresh' : 'degraded')
    }
  };
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)));
}

function visibleText(value) { return decodeEntities(String(value ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }

function attribute(attrs, name) {
  const match = String(attrs ?? '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? decodeEntities(match[1]).trim() : '';
}

function elementsWithClass(html, className) {
  const elements = [];
  const matcher = /<([a-z][a-z0-9:-]*)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi;
  for (const match of String(html ?? '').matchAll(matcher)) {
    if ((attribute(match[2], 'class').split(/\s+/).filter(Boolean)).includes(className)) elements.push({ tag: match[1], attrs: match[2], html: match[0] });
  }
  return elements;
}

function firstElementWithAttribute(html, attributeName, expectedValue) {
  const matcher = new RegExp(`<([a-z][a-z0-9:-]*)\\b([^>]*\\b${attributeName}\\s*=\\s*["']${expectedValue}["'][^>]*)>[\\s\\S]*?<\\/\\1\\s*>`, 'i');
  const match = String(html ?? '').match(matcher);
  return match ? { tag: match[1], attrs: match[2], html: match[0] } : null;
}

function textForId(html, id) {
  const element = firstElementWithAttribute(html, 'id', id);
  return element ? visibleText(element.html.replace(new RegExp(`^<${element.tag}\\b[^>]*>|<\\/${element.tag}\\s*>$`, 'i'), '')) : '';
}

function textForClass(html, className) {
  const matcher = new RegExp(`<([a-z][a-z0-9:-]*)\\b([^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*)>[\\s\\S]*?<\\/\\1\\s*>`, 'i');
  const match = String(html ?? '').match(matcher);
  const element = match ? { tag: match[1], attrs: match[2], html: match[0] } : null;
  return element ? visibleText(element.html.replace(new RegExp(`^<${element.tag}\\b[^>]*>|<\\/${element.tag}\\s*>$`, 'i'), '')) : '';
}

function parseHeatToken(value) {
  const match = String(value ?? '').match(/(?:heat|race)?\s*(\d+)\s*\/\s*(\d+)/i);
  return match ? { number: Number(match[1]), count: Number(match[2]) } : null;
}

function parseRaceNumber(value) {
  const match = String(value ?? '').match(/(?:race\s*[#:]?\s*)?(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function parsePilotVideo(value) {
  const source = String(value ?? '').trim().toUpperCase();
  const channelMatch = source.match(/\b([A-Z]+)\s*(\d{1,2})\b/);
  const frequencyMatch = source.match(/\b(\d{4,5})\b/);
  if (!channelMatch && !frequencyMatch) return undefined;
  return {
    ...(channelMatch ? { channel: `${channelMatch[1]}${Number(channelMatch[2])}`, band: channelMatch[1], number: Number(channelMatch[2]) } : {}),
    ...(frequencyMatch ? { frequencyMHz: Number(frequencyMatch[1]) } : {})
  };
}

function parsePilotRows(blockHtml) {
  const pilots = [];
  for (const rowMatch of String(blockHtml ?? '').matchAll(/<tr\b([^>]*)>[\s\S]*?<\/tr\s*>/gi)) {
    const rowHtml = rowMatch[0];
    const sourceId = attribute(rowMatch[1], 'data-pilot-id') || attribute(rowMatch[1], 'data-driver-id') || attribute(rowMatch[1], 'data-source-id');
    const callsign = textForClass(rowHtml, 'driver') || textForClass(rowHtml, 'pilot') || textForClass(rowHtml, 'callsign');
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(match => visibleText(match[1]));
    if (!sourceId && !callsign) continue;
    const slotValue = attribute(rowMatch[1], 'data-slot') || textForClass(rowHtml, 'position') || cells[0];
    const frequency = textForClass(rowHtml, 'frequency') || cells.find(cell => /\b(?:R|F|E|B)\s*\d{1,2}\b|\b\d{4,5}\b/i.test(cell)) || '';
    const video = parsePilotVideo(frequency);
    const pilot = {
      id: safeId(sourceId || callsign, `pilot-${pilots.length + 1}`),
      ...(sourceId ? { sourceId: safeId(sourceId, `source-pilot-${pilots.length + 1}`) } : {}),
      callsign: (callsign || `Unknown pilot ${pilots.length + 1}`).slice(0, 80),
      ...(Number(slotValue) > 0 ? { slot: Number(slotValue) } : {}),
      open: false,
      bumpUp: /bump[\s-]*up/i.test(visibleText(rowHtml)),
      ...(video ? { video } : {})
    };
    pilots.push(pilot);
  }
  return pilots;
}

function resultLink(blockHtml) {
  const match = String(blockHtml ?? '').match(/<a\b([^>]*\bhref\s*=\s*["'][^"']*view_race_result[^"']*["'][^>]*)>/i);
  return match ? attribute(match[1], 'href') : '';
}

function absoluteUrl(value, baseUrl) {
  if (!value) return undefined;
  try { return new URL(value, baseUrl).href; } catch { return undefined; }
}

function slug(value) { return safeId(String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'unknown'); }

function stageForRound(round) {
  const value = normalizedText(round);
  if (/main|final|bracket/.test(value)) return 'Main Events';
  if (/qual|\bq\d+\b/.test(value)) return 'Qualifier';
  if (/practice/.test(value)) return 'Practice';
  if (/seed/.test(value)) return 'Seeding';
  return String(round || 'Event').trim() || 'Event';
}

function isPlaceholder(value) { return !value || /^(?:select\s+class|class|unknown|[-–—])$/i.test(value.trim()); }

export function parseLiveNowPage(html, { sourceUrl = '', capturedAt = new Date().toISOString() } = {}) {
  const round = textForId(html, 'round');
  const raceText = textForId(html, 'race');
  const classText = textForId(html, 'class');
  const eventName = textForId(html, 'event_name');
  const statusText = textForId(html, 'race_status');
  const heat = parseHeatToken(raceText);
  const parsedStatus = status(statusText);
  const waiting = /waiting\s+for\s+(?:the\s+)?event\s+to\s+start/i.test(visibleText(html));
  let sourceEventId;
  try { sourceEventId = new URL(sourceUrl).hostname.split('.')[0] || undefined; } catch {}
  return {
    kind: 'live-now',
    available: Boolean(!waiting && eventName && round && heat && parsedStatus !== 'unknown'),
    sourceEventId,
    sourceUrl,
    eventName,
    phase: stageForRound(round),
    round: round || undefined,
    className: isPlaceholder(classText) ? undefined : classText,
    raceNumber: heat?.number,
    heat,
    status: parsedStatus,
    capturedAt,
    sourceRevision: safeId(`live-now-${round}-${raceText}-${statusText}-${capturedAt}`, 'live-now-revision'),
    pilots: parsePilotRows(html)
  };
}

export function parseMainEventsHeatSheet(html, { eventId = 'event', heatSheetUrl = '', capturedAt = new Date().toISOString() } = {}) {
  const blocks = elementsWithClass(html, 'heat_sheet');
  return blocks.map((block, index) => {
    const raceText = textForClass(block.html, 'race_num');
    const classText = textForClass(block.html, 'class_header') || 'Main Events';
    const statusText = textForClass(block.html, 'race_status');
    const heat = parseHeatToken(`${raceText} ${classText}`);
    const sourceRaceNumber = parseRaceNumber(raceText) || index + 1;
    const resultUrl = absoluteUrl(resultLink(block.html), heatSheetUrl);
    const phase = 'Main Events';
    const round = textForClass(block.html, 'round') || 'Main Events';
    const className = classText.replace(/\b(?:heat|race)\s*\d+\s*\/\s*\d+\b/i, '').trim() || 'Main Events';
    const explicitHeat = /\bheat\s*\d+\s*\/\s*\d+\b/i.test(classText) ? heat : null;
    const parsedHeat = explicitHeat || { number: sourceRaceNumber, count: blocks.length };
    return {
      id: safeId(`livefpv-${slug(eventId)}-main-${slug(className)}-${sourceRaceNumber}`, `livefpv-${slug(eventId)}-main-${index + 1}`),
      sourceEventId: String(eventId),
      sourceHeatSheetId: heatSheetUrl.match(/[?&]id=([^&]+)/i)?.[1] || undefined,
      sourceRaceNumber,
      sourceOrder: index,
      phase,
      round,
      className,
      heat: parsedHeat,
      label: `${classText}`.slice(0, 200),
      status: status(statusText),
      capturedAt,
      links: {
        ...(absoluteUrl(heatSheetUrl, heatSheetUrl) ? { heatSheet: absoluteUrl(heatSheetUrl, heatSheetUrl) } : {}),
        ...(resultUrl ? { results: resultUrl } : {})
      },
      pilots: parsePilotRows(block.html)
    };
  });
}

export function buildLiveFPVSnapshot({
  event,
  eventSessionId,
  qualifierHeats = [],
  mainEvents = [],
  historicalResults = [],
  liveNow = null,
  previous = null,
  capturedAt = new Date().toISOString(),
  sourceRevision = liveNow?.sourceRevision || `revision-${Date.parse(capturedAt) || Date.now()}`
} = {}) {
  if (!event?.id || !event?.name) throw new Error('LiveFPV event metadata is required.');
  const usedHeatIds = new Set();
  const configuredHeats = [...qualifierHeats, ...mainEvents].map((heat, index) => {
    const sourceId = safeId(heat.id, `heat-${index + 1}`);
    const id = usedHeatIds.has(sourceId) ? heatId(event.id, { ...heat, sourceRaceNumber: heat.sourceRaceNumber || index + 1 }, index + 1) : sourceId;
    usedHeatIds.add(id);
    return { ...clone(heat), id };
  });
  const races = [];
  for (const heat of configuredHeats) {
    const race = raceFromHeat(heat, races.length);
    if (!races.some(candidate => candidate.id === race.id)) races.push(race);
  }

  let currentIndex = -1;
  let ambiguous = false;
  const eventMismatch = Boolean(liveNow?.available && liveNow.eventName && normalizedText(liveNow.eventName) !== normalizedText(event.name));
  if (liveNow?.available && !eventMismatch) {
    const matchingHeats = configuredHeats.filter(heat => liveNowMatches(liveNow, heat));
    if (matchingHeats.length === 1) currentIndex = races.findIndex(race => race.id === matchingHeats[0].id);
    if (matchingHeats.length === 0) {
      const liveHeat = {
        id: heatId(event.id, liveNow),
        phase: liveNow.phase || 'Event',
        round: liveNow.round || undefined,
        className: liveNow.className || undefined,
        heat: liveNow.heat,
        label: `${liveNow.phase || 'Event'}${liveNow.heat ? ` (Heat ${liveNow.heat.number}/${liveNow.heat.count})` : ''}`,
        status: liveNow.status,
        timing: liveNow.timing,
        pilots: liveNow.pilots
      };
      currentIndex = races.length;
      races.push(raceFromHeat(liveHeat, currentIndex));
    } else if (matchingHeats.length === 1 && currentIndex >= 0) {
      const priorCurrent = previous?.races?.find(race => race.id === races[currentIndex].id);
      races[currentIndex] = mergeSameHeatDetails(withLiveNow(races[currentIndex], liveNow), priorCurrent);
    } else if (matchingHeats.length === 1) {
      const liveHeat = { ...matchingHeats[0], status: liveNow.status, timing: liveNow.timing, pilots: liveNow.pilots };
      currentIndex = races.length;
      races.push(raceFromHeat(liveHeat, currentIndex));
    } else {
      ambiguous = true;
    }
  }

  if (currentIndex < 0 && previous?.schedule?.currentRaceId) {
    const previousCurrent = previous.races?.find(race => race.id === previous.schedule.currentRaceId);
    if (previousCurrent) {
      currentIndex = races.findIndex(race => race.id === previousCurrent.id && sameHeatIdentity(race, previousCurrent));
      if (currentIndex >= 0) races[currentIndex] = clone(previousCurrent);
    }
  }

  if (!races.length) throw new Error('LiveFPV schedule contains no heats.');
  const schedule = scheduleFor(races, currentIndex);
  const sourceCapturedAt = liveNow?.capturedAt || previous?.capturedAt || capturedAt;
  const snapshot = {
    format: FORMAT,
    version: 1,
    snapshotId: safeId(`livefpv-${eventSessionId || event.id}-${sourceRevision}`, `livefpv-${event.id}`),
    eventSessionId: safeId(eventSessionId || `livefpv-${event.id}`, `livefpv-${event.id}`),
    capturedAt: sourceCapturedAt,
    event: {
      id: safeId(event.id, 'livefpv-event'),
      name: String(event.name).slice(0, 200),
      ...(event.organizer ? { organizer: String(event.organizer).slice(0, 160) } : {}),
      ...(event.sourceUrl ? { sourceUrl: String(event.sourceUrl) } : {})
    },
    sources: [{ id: SOURCE_ID, provider: 'LiveFPV', kind: 'livefpv-source', revision: safeId(sourceRevision, 'livefpv-revision'), capturedAt: sourceCapturedAt, confidence: liveNow?.available ? 'high' : 'medium' }],
    schedule,
    races,
    quality: qualityFor({ liveNow, races, capturedAt: sourceCapturedAt, sourceId: SOURCE_ID, ambiguous, eventMismatch }),
    activeAnnouncements: []
  };

  if (historicalResults.length) snapshot.quality.warnings.push({ code: 'livefpv.historical_results_ignored_for_current', message: 'Historical Results selections do not override the authoritative LiveNow heat.', severity: 'info' });
  const result = validateSnapshot(snapshot);
  if (!result.valid) throw new Error(`LiveFPV snapshot rejected: ${result.errors.join(', ')}`);
  return snapshot;
}

function observedAt(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function revisionRank(value) {
  const match = String(value || '').match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

export class LiveFPVSourceRuntime {
  constructor({ event, eventSessionId, now = () => Date.now() } = {}) {
    if (!event?.id || !event?.name) throw new Error('LiveFPV event metadata is required.');
    this.event = clone(event);
    this.eventSessionId = eventSessionId;
    this.now = now;
    this.snapshot = null;
    this.liveNow = null;
    this.qualifierHeats = [];
    this.mainEvents = [];
    this.lastLiveAt = null;
    this.lastLiveRevision = null;
  }

  getSnapshot() { return this.snapshot ? clone(this.snapshot) : null; }

  accept({ liveNow = null, qualifierHeats = this.qualifierHeats, mainEvents = this.mainEvents, historicalResults = [], capturedAt = new Date(this.now()).toISOString(), sourceRevision } = {}) {
    const incomingAt = observedAt(liveNow?.capturedAt || capturedAt);
    const incomingRevision = liveNow?.sourceRevision || sourceRevision || `revision-${this.now()}`;
    const incomingRank = revisionRank(incomingRevision);
    if (liveNow?.available && this.lastLiveAt !== null && incomingAt !== null && (incomingAt < this.lastLiveAt || (incomingAt === this.lastLiveAt && incomingRank !== null && revisionRank(this.lastLiveRevision) !== null && incomingRank < revisionRank(this.lastLiveRevision)))) {
      return { accepted: false, snapshot: this.getSnapshot() };
    }

    this.qualifierHeats = clone(qualifierHeats);
    this.mainEvents = clone(mainEvents);
    if (liveNow?.available) {
      this.liveNow = clone(liveNow);
      this.lastLiveAt = incomingAt ?? this.lastLiveAt;
      this.lastLiveRevision = incomingRevision;
    } else {
      this.liveNow = null;
    }

    this.snapshot = buildLiveFPVSnapshot({
      event: this.event,
      eventSessionId: this.eventSessionId,
      qualifierHeats: this.qualifierHeats,
      mainEvents: this.mainEvents,
      historicalResults,
      liveNow: this.liveNow,
      previous: this.snapshot,
      capturedAt,
      sourceRevision: incomingRevision
    });
    return { accepted: true, snapshot: this.getSnapshot() };
  }

  markStale() {
    if (!this.snapshot) return null;
    return this.accept({ qualifierHeats: this.qualifierHeats, mainEvents: this.mainEvents, capturedAt: this.snapshot.capturedAt, sourceRevision: this.lastLiveRevision || 'stale' });
  }
}

export { sameHeatIdentity };
