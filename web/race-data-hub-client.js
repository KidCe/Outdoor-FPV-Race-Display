export const RACE_EVENT_FORMAT = "org.fpv.race-event.snapshot";
export const ANNOUNCEMENT_DISPLAY_MS = Object.freeze({ 1: 5000, 2: 15000 });

const STREAM_TYPES = new Set(["snapshot", "status", "warning", "heartbeat", "reset", "announcement", "announcement-clear"]);
const CONNECTIONS = new Set(["disabled", "connecting", "handshaking", "joining", "reconciling", "live", "degraded", "reconnecting", "error"]);
const QUALITY_STATES = new Set(["fresh", "degraded", "stale", "unknown"]);
const RACE_STATUSES = new Set(["scheduled", "staging", "running", "complete", "cancelled", "not_run", "unknown"]);
const TIMING_STATES = new Set(["unknown", "staging", "running", "complete", "degraded", "stale"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CREDENTIAL_QUERY_PATTERN = /pass(word)?|secret|token|api[-_]?key|auth(entication)?|credential/i;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Hub ${name} must be an object.`);
  return value;
}

function id(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !ID_PATTERN.test(value)) throw new Error(`Hub ${name} is invalid.`);
  return value;
}

function string(value, name, { min = 0, max = Infinity } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`Hub ${name} is invalid.`);
  return value;
}

function dateTime(value, name) {
  if (typeof value !== "string" || !DATE_TIME_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Hub ${name} is invalid.`);
  return value;
}

function uri(value, name, maximum = 2048) {
  string(value, name, { min: 1, max: maximum });
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some(key => CREDENTIAL_QUERY_PATTERN.test(key))) throw new Error("credential-bearing URI");
  } catch { throw new Error(`Hub ${name} is invalid.`); }
  return value;
}

function optionalDateTime(value, name) {
  if (value !== undefined && value !== null) dateTime(value, name);
}

function integer(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`Hub ${name} is invalid.`);
  return value;
}

function noUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Hub ${name} contains unsupported field '${key}'.`);
}

function validateWarning(warning, name = "warning") {
  object(warning, name); noUnknown(warning, new Set(["code", "message", "severity"]), name);
  string(warning.code, `${name} code`, { min: 1, max: 80 });
  if (!/^[a-z0-9_.-]+$/.test(warning.code)) throw new Error(`Hub ${name} code is invalid.`);
  string(warning.message, `${name} message`, { min: 1, max: 500 });
  if (!["info", "warning", "error"].includes(warning.severity)) throw new Error(`Hub ${name} severity is invalid.`);
  return warning;
}

function validateDomainQuality(domain, name) {
  object(domain, name); noUnknown(domain, new Set(["state", "capturedAt", "sourceIds", "reason"]), name);
  if (!QUALITY_STATES.has(domain.state)) throw new Error(`Hub ${name} state is invalid.`);
  optionalDateTime(domain.capturedAt, `${name} capture time`);
  if (domain.sourceIds !== undefined) {
    if (!Array.isArray(domain.sourceIds)) throw new Error(`Hub ${name} source IDs are invalid.`);
    domain.sourceIds.forEach((value, index) => id(value, `${name} source ID ${index}`));
  }
  if (domain.reason !== undefined) string(domain.reason, `${name} reason`, { max: 240 });
  return domain;
}

function validateQuality(quality) {
  object(quality, "quality"); noUnknown(quality, new Set(["state", "completeRaceCount", "warnings", "domains"]), "quality");
  if (!QUALITY_STATES.has(quality.state)) throw new Error("Hub quality state is invalid.");
  if (quality.completeRaceCount !== undefined) integer(quality.completeRaceCount, "complete race count");
  if (!Array.isArray(quality.warnings)) throw new Error("Hub quality warnings are invalid.");
  quality.warnings.forEach((warning, index) => validateWarning(warning, `quality warning ${index}`));
  object(quality.domains, "quality domains");
  for (const [name, domain] of Object.entries(quality.domains)) validateDomainQuality(domain, `quality domain ${name}`);
  return quality;
}

export function validateHubAnnouncement(announcement) {
  object(announcement, "announcement");
  noUnknown(announcement, new Set(["announcementId", "eventSessionId", "title", "body", "importance", "createdAt", "createdByDeviceId", "expiresAt", "status", "clearedAt", "expiredAt"]), "announcement");
  id(announcement.announcementId, "announcement ID"); id(announcement.eventSessionId, "announcement event session");
  string(announcement.title, "announcement title", { min: 1, max: 80 }); string(announcement.body, "announcement body", { min: 1, max: 500 });
  if (![1, 2, 3].includes(announcement.importance)) throw new Error("Hub announcement importance is invalid.");
  dateTime(announcement.createdAt, "announcement creation time"); id(announcement.createdByDeviceId, "announcement device ID");
  if (!(announcement.expiresAt === null || typeof announcement.expiresAt === "string")) throw new Error("Hub announcement expiry is invalid.");
  optionalDateTime(announcement.expiresAt, "announcement expiry");
  if (!["active", "cleared", "expired"].includes(announcement.status)) throw new Error("Hub announcement status is invalid.");
  if (announcement.clearedAt !== undefined && announcement.clearedAt !== null) dateTime(announcement.clearedAt, "announcement clear time");
  if (announcement.expiredAt !== undefined && announcement.expiredAt !== null) dateTime(announcement.expiredAt, "announcement expiry time");
  return announcement;
}

function validateVideo(video, name) {
  if (video === null) return video;
  object(video, name); noUnknown(video, new Set(["channel", "band", "number", "frequencyMHz"]), name); string(video.channel, `${name} channel`, { min: 1, max: 16 });
  if (video.band !== undefined) string(video.band, `${name} band`, { max: 16 }); if (video.number !== undefined) integer(video.number, `${name} number`, 1);
  if (video.frequencyMHz !== undefined && (typeof video.frequencyMHz !== "number" || !Number.isFinite(video.frequencyMHz) || video.frequencyMHz <= 0)) throw new Error(`${name} frequency is invalid.`);
  return video;
}

function validatePilot(pilot, name) {
  object(pilot, name); noUnknown(pilot, new Set(["id", "sourceId", "callsign", "slot", "open", "bumpUp", "match", "video"]), name); id(pilot.id, `${name} ID`); string(pilot.callsign, `${name} callsign`, { min: 1, max: 80 });
  if (pilot.sourceId !== undefined) id(pilot.sourceId, `${name} source ID`); if (pilot.slot !== undefined) integer(pilot.slot, `${name} slot`, 1);
  if (pilot.open !== undefined && typeof pilot.open !== "boolean") throw new Error(`${name} open flag is invalid.`); if (pilot.bumpUp !== undefined && typeof pilot.bumpUp !== "boolean") throw new Error(`${name} bump-up flag is invalid.`);
  if (pilot.match !== undefined) { object(pilot.match, `${name} match`); noUnknown(pilot.match, new Set(["method", "confidence"]), `${name} match`); if (!["source_id", "callsign", "alias", "manual", "unmatched"].includes(pilot.match.method)) throw new Error(`${name} match method is invalid.`); if (!["high", "medium", "low", "unknown"].includes(pilot.match.confidence)) throw new Error(`${name} match confidence is invalid.`); }
  if (pilot.video !== undefined) validateVideo(pilot.video, `${name} video`); return pilot;
}

function validateRace(race, name) {
  object(race, name); noUnknown(race, new Set(["id", "runId", "attempt", "order", "label", "phase", "round", "heat", "status", "timing", "links", "pilots"]), name); id(race.id, `${name} ID`); if (race.runId !== undefined) id(race.runId, `${name} run ID`, { nullable: true });
  if (race.attempt !== undefined) integer(race.attempt, `${name} attempt`, 1); integer(race.order, `${name} order`); string(race.label, `${name} label`, { min: 1, max: 200 });
  if (race.phase !== undefined) string(race.phase, `${name} phase`, { max: 120 }); if (race.round !== undefined) string(race.round, `${name} round`, { max: 120 });
  if (race.heat !== undefined && race.heat !== null) { object(race.heat, `${name} heat`); noUnknown(race.heat, new Set(["number", "count"]), `${name} heat`); integer(race.heat.number, `${name} heat number`, 1); integer(race.heat.count, `${name} heat count`, 1); }
  if (!RACE_STATUSES.has(race.status)) throw new Error(`${name} status is invalid.`);
  if (race.timing !== undefined && race.timing !== null) { object(race.timing, `${name} timing`); noUnknown(race.timing, new Set(["state", "elapsedMs", "startedAt", "stoppedAt", "capturedAt"]), `${name} timing`); if (!TIMING_STATES.has(race.timing.state)) throw new Error(`${name} timing state is invalid.`); if (race.timing.elapsedMs !== undefined && race.timing.elapsedMs !== null) integer(race.timing.elapsedMs, `${name} elapsed time`); optionalDateTime(race.timing.startedAt, `${name} start time`); optionalDateTime(race.timing.stoppedAt, `${name} stop time`); dateTime(race.timing.capturedAt, `${name} timing capture time`); }
  if (race.links !== undefined) { object(race.links, `${name} links`); for (const [key, value] of Object.entries(race.links)) { string(key, `${name} link key`, { min: 1 }); uri(value, `${name} link`); } }
  if (!Array.isArray(race.pilots)) throw new Error(`${name} pilots are invalid.`); race.pilots.forEach((pilot, index) => validatePilot(pilot, `${name} pilot ${index}`)); return race;
}

export function validateHubSnapshot(snapshot) {
  object(snapshot, "snapshot"); noUnknown(snapshot, new Set(["format", "version", "snapshotId", "eventSessionId", "capturedAt", "event", "sources", "schedule", "races", "quality", "activeAnnouncements"]), "snapshot");
  if (snapshot.format !== RACE_EVENT_FORMAT || snapshot.version !== 1) throw new Error("Hub snapshot uses an unsupported race-event format."); id(snapshot.snapshotId, "snapshot ID"); id(snapshot.eventSessionId, "event session"); dateTime(snapshot.capturedAt, "snapshot capture time");
  object(snapshot.event, "event"); noUnknown(snapshot.event, new Set(["id", "name", "organizer", "sourceUrl", "startsAt", "endsAt"]), "event"); id(snapshot.event.id, "event ID"); string(snapshot.event.name, "event name", { min: 1, max: 200 });
  if (snapshot.event.organizer !== undefined) string(snapshot.event.organizer, "event organizer", { max: 160 }); if (snapshot.event.sourceUrl !== undefined) uri(snapshot.event.sourceUrl, "event source URL"); optionalDateTime(snapshot.event.startsAt, "event start time"); optionalDateTime(snapshot.event.endsAt, "event end time");
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length < 1) throw new Error("Hub snapshot sources are invalid."); snapshot.sources.forEach((source, index) => { object(source, `source ${index}`); noUnknown(source, new Set(["id", "provider", "kind", "revision", "capturedAt", "confidence"]), `source ${index}`); id(source.id, `source ${index} ID`); string(source.provider, `source ${index} provider`, { min: 1, max: 120 }); string(source.kind, `source ${index} kind`, { min: 1, max: 120 }); string(source.revision, `source ${index} revision`, { min: 1, max: 160 }); dateTime(source.capturedAt, `source ${index} capture time`); if (source.confidence !== undefined && !["high", "medium", "low", "unknown"].includes(source.confidence)) throw new Error(`Source ${index} confidence is invalid.`); });
  object(snapshot.schedule, "schedule"); noUnknown(snapshot.schedule, new Set(["currentRaceId", "currentIndex", "nextRaceIds", "afterNextRaceIds"]), "schedule"); id(snapshot.schedule.currentRaceId, "current race ID", { nullable: true }); if (snapshot.schedule.currentIndex !== null) integer(snapshot.schedule.currentIndex, "current race index");
  if (!Array.isArray(snapshot.schedule.nextRaceIds)) throw new Error("Hub nextRaceIds is invalid.");
  for (const key of ["afterNextRaceIds"]) if (snapshot.schedule[key] !== undefined) { if (!Array.isArray(snapshot.schedule[key])) throw new Error(`Hub ${key} is invalid.`); snapshot.schedule[key].forEach((value, index) => id(value, `${key} item ${index}`)); }
  snapshot.schedule.nextRaceIds.forEach((value, index) => id(value, `nextRaceIds item ${index}`));
  if (!Array.isArray(snapshot.races) || snapshot.races.length < 1) throw new Error("Hub snapshot races are invalid."); const raceIds = new Set(); snapshot.races.forEach((race, index) => { validateRace(race, `race ${index}`); if (raceIds.has(race.id)) throw new Error("Hub snapshot contains duplicate race IDs."); raceIds.add(race.id); });
  if ((snapshot.schedule.currentIndex === null) !== (snapshot.schedule.currentRaceId === null)) throw new Error("Hub schedule current race fields must be both null or both set."); if (snapshot.schedule.currentIndex !== null && snapshot.races[snapshot.schedule.currentIndex]?.id !== snapshot.schedule.currentRaceId) throw new Error("Hub snapshot has an inconsistent current race.");
  validateQuality(snapshot.quality); if (!Array.isArray(snapshot.activeAnnouncements)) throw new Error("Hub active announcements are invalid."); snapshot.activeAnnouncements.forEach((announcement, index) => { validateHubAnnouncement(announcement); if (announcement.eventSessionId !== snapshot.eventSessionId) throw new Error(`Hub active announcement ${index} belongs to another event.`); if (announcement.status !== "active") throw new Error(`Hub active announcement ${index} is not active.`); }); return snapshot;
}

function validateStatus(data) {
  object(data, "status data"); noUnknown(data, new Set(["connection", "source", "event", "quality", "raceStatus", "message"]), "status data"); if (!CONNECTIONS.has(data.connection)) throw new Error("Hub status connection is invalid."); string(data.source, "status source", { max: 120 }); string(data.event, "status event", { max: 200 }); if (!QUALITY_STATES.has(data.quality)) throw new Error("Hub status quality is invalid."); if (data.raceStatus !== undefined && data.raceStatus !== null && !RACE_STATUSES.has(data.raceStatus)) throw new Error("Hub status race status is invalid."); if (data.message !== undefined) string(data.message, "status message", { max: 500 }); return data;
}

export function validateHubEnvelope(envelope) {
  object(envelope, "stream envelope"); noUnknown(envelope, new Set(["type", "hubEpoch", "eventSessionId", "streamSequence", "snapshotSequence", "deliveredAt", "data"]), "stream envelope"); if (!STREAM_TYPES.has(envelope.type)) throw new Error("Hub stream envelope has an invalid type."); id(envelope.hubEpoch, "hub epoch"); id(envelope.eventSessionId, "event session", { nullable: true }); integer(envelope.streamSequence, "stream sequence", 1); if (envelope.snapshotSequence !== undefined) integer(envelope.snapshotSequence, "snapshot sequence", 1); dateTime(envelope.deliveredAt, "delivery time"); object(envelope.data, "stream data");
  switch (envelope.type) {
    case "snapshot": validateHubSnapshot(envelope.data); if (envelope.eventSessionId !== envelope.data.eventSessionId) throw new Error("Hub snapshot event session does not match its envelope."); break;
    case "status": validateStatus(envelope.data); break;
    case "warning": validateWarning(envelope.data, "stream warning"); break;
    case "heartbeat": if (Object.keys(envelope.data).length) throw new Error("Hub heartbeat data must be empty."); break;
    case "reset": noUnknown(envelope.data, new Set(["reason"]), "reset data"); if (!["epoch_changed", "history_gap", "event_changed", "bootstrap"].includes(envelope.data.reason)) throw new Error("Hub reset reason is invalid."); break;
    case "announcement": validateHubAnnouncement(envelope.data); if (envelope.eventSessionId !== envelope.data.eventSessionId) throw new Error("Hub announcement event session does not match its envelope."); break;
    case "announcement-clear": noUnknown(envelope.data, new Set(["announcementId", "clearedAt"]), "announcement clear data"); id(envelope.data.announcementId, "cleared announcement ID"); dateTime(envelope.data.clearedAt, "announcement clear time"); if (envelope.eventSessionId === null) throw new Error("Hub announcement clear event has no event session."); break;
  }
  return envelope;
}

function sortAnnouncements(announcements) { return [...announcements].sort((left, right) => right.importance - left.importance || Date.parse(right.createdAt) - Date.parse(left.createdAt) || String(left.announcementId).localeCompare(String(right.announcementId))); }

function staleSnapshot(snapshot) {
  const recovered = structuredClone(snapshot); recovered.quality = { ...recovered.quality, state: "stale", warnings: [...recovered.quality.warnings, { code: "consumer.recovered", message: "The last trusted Hub snapshot was recovered from local storage.", severity: "warning" }], domains: Object.fromEntries(Object.entries(recovered.quality.domains).map(([key, value]) => [key, { ...value, state: "stale", reason: value.reason || "consumer_recovered" }])) }; return recovered;
}

function connectionForQuality(quality) {
  return quality === "stale" ? "reconnecting" : quality === "degraded" ? "degraded" : quality === "unknown" ? "reconciling" : "live";
}

export function projectHubSnapshot(snapshot) {
  validateHubSnapshot(snapshot);
  const currentId = snapshot.schedule.currentRaceId;
  const upcomingIds = [...new Set([
    ...snapshot.schedule.nextRaceIds,
    ...(snapshot.schedule.afterNextRaceIds || [])
  ].filter(idValue => idValue && idValue !== currentId))];
  const find = idValue => idValue ? snapshot.races.find(race => race.id === idValue) || null : null;
  return {
    current: find(currentId),
    staging: find(upcomingIds[0]),
    next: find(upcomingIds[1]),
    afterNext: find(upcomingIds[2])
  };
}

export function getActiveRaceStatus(snapshot) {
  const currentRaceId = snapshot?.schedule?.currentRaceId;
  if (!currentRaceId || !Array.isArray(snapshot?.races)) return null;
  return snapshot.races.find(race => race?.id === currentRaceId)?.status ?? null;
}

export function renderHubAnnouncement(announcement, { container } = {}) {
  validateHubAnnouncement(announcement); if (!container) return null; const item = document.createElement("article"); const persistent = announcement.importance === 3; item.className = `hub-announcement importance-${announcement.importance}${persistent ? " persistent" : ""}`; item.dataset.announcementId = announcement.announcementId; item.innerHTML = "<strong></strong><p></p><small></small>"; item.querySelector("strong").textContent = announcement.title; item.querySelector("p").textContent = announcement.body; item.querySelector("small").textContent = persistent ? "Persistent until cleared" : announcement.importance === 2 ? "Time-limited notification" : "Short notification"; container.prepend(item); if (!persistent) setTimeout(() => item.remove(), ANNOUNCEMENT_DISPLAY_MS[announcement.importance]); return item;
}

export class RaceDataHubClient {
  constructor({ hubUrl, fetchImpl = globalThis.fetch, EventSourceImpl = globalThis.EventSource, onState = () => {}, now = () => Date.now(), storage = globalThis.localStorage, storageKey = "fpv-race-hub-trusted-v1" } = {}) {
    this.base = new URL(hubUrl || "http://localhost:4175"); this.fetchImpl = fetchImpl; this.EventSourceImpl = EventSourceImpl; this.onState = onState; this.now = now; this.storage = storage; this.storageKey = storageKey; this.stream = null; this.retryTimer = 0; this.retryAttempt = 0; this.generation = 0;
    this.state = { connection: "disabled", snapshot: null, quality: "unknown", raceStatus: null, lastDataAt: null, sourceCapturedAt: null, hubEpoch: null, eventSessionId: null, streamSequence: 0, snapshotSequence: 0, announcements: [], error: "", needsReset: false };
    try { const cached = JSON.parse(this.storage?.getItem(this.storageKey) || "null"); if (cached?.snapshot) { const recovered = staleSnapshot(validateHubSnapshot(cached.snapshot)); this.state = { ...this.state, snapshot: recovered, quality: "stale", raceStatus: getActiveRaceStatus(recovered), lastDataAt: Number(cached.persistedAt) || null, sourceCapturedAt: recovered.capturedAt, eventSessionId: recovered.eventSessionId, announcements: sortAnnouncements(recovered.activeAnnouncements.filter(item => item.status === "active")), connection: "reconnecting", error: "Recovering the last trusted Hub snapshot." }; } } catch {}
  }
  getState() { return { ...this.state, announcements: [...this.state.announcements] }; }
  setState(patch) { this.state = { ...this.state, ...patch }; this.onState(this.getState()); }
  persist(snapshot) { try { this.storage?.setItem(this.storageKey, JSON.stringify({ snapshot, persistedAt: this.now() })); } catch {} }
  async bootstrap() {
    const response = await this.fetchImpl(new URL("/api/v1/snapshot", this.base), { headers: { accept: "application/json" }, cache: "no-store" }); if (!response.ok) throw new Error(`Hub snapshot request failed (HTTP ${response.status}).`); let payload; try { payload = await response.json(); } catch { throw new Error("Hub snapshot response is not valid JSON."); } const snapshot = validateHubSnapshot(payload); const eventChanged = this.state.eventSessionId && this.state.eventSessionId !== snapshot.eventSessionId; if (this.state.needsReset || eventChanged) this.setState({ streamSequence: 0, snapshotSequence: 0, hubEpoch: eventChanged ? null : this.state.hubEpoch }); this.acceptSnapshot(snapshot, { allowEventChange: true }); return snapshot;
  }
  acceptSnapshot(snapshot, { sequence = 0, snapshotSequence = sequence, allowEventChange = false } = {}) {
    validateHubSnapshot(snapshot); if (!allowEventChange && this.state.eventSessionId && snapshot.eventSessionId !== this.state.eventSessionId) throw new Error("Hub event session changed; awaiting reset."); const arrival = this.now(); const announcements = sortAnnouncements(snapshot.activeAnnouncements.filter(item => item.status === "active")); this.persist(snapshot); this.setState({ snapshot, quality: snapshot.quality.state, raceStatus: getActiveRaceStatus(snapshot), lastDataAt: arrival, sourceCapturedAt: snapshot.capturedAt, eventSessionId: snapshot.eventSessionId, streamSequence: Math.max(this.state.streamSequence, sequence), snapshotSequence: Math.max(this.state.snapshotSequence, snapshotSequence), announcements, connection: connectionForQuality(snapshot.quality.state), error: "", needsReset: false });
  }
  clearTrustedSnapshot() { try { this.storage?.removeItem(this.storageKey); } catch {} this.setState({ snapshot: null, lastDataAt: null, sourceCapturedAt: null, announcements: [], quality: "unknown", raceStatus: null, error: "" }); }
  requireReset(message) { this.setState({ connection: "reconnecting", needsReset: true, error: message }); if (this.stream) this.scheduleReconnect(this.generation); return false; }
  apply(envelope) {
    validateHubEnvelope(envelope); const epochChanged = this.state.hubEpoch !== null && envelope.hubEpoch !== this.state.hubEpoch;
    if (epochChanged) this.setState({ connection: "reconciling", snapshot: null, announcements: [], quality: "unknown", raceStatus: null, lastDataAt: null, sourceCapturedAt: null, streamSequence: 0, snapshotSequence: 0, eventSessionId: envelope.eventSessionId, needsReset: false, error: "Hub restarted; waiting for a fresh snapshot." });
    if (!epochChanged && this.state.hubEpoch === null) this.setState({ hubEpoch: envelope.hubEpoch });
    if (this.state.eventSessionId && envelope.eventSessionId !== this.state.eventSessionId && envelope.type !== "reset") return this.requireReset("Hub event session changed without a reset.");
    if (!epochChanged && envelope.streamSequence <= this.state.streamSequence) return false;
    if (!epochChanged && this.state.streamSequence > 0 && envelope.streamSequence > this.state.streamSequence + 1 && envelope.type !== "reset") return this.requireReset("Hub stream gap detected; requesting reset.");
    this.setState({ hubEpoch: envelope.hubEpoch, eventSessionId: envelope.eventSessionId, streamSequence: envelope.streamSequence });
    if (envelope.type === "reset") { try { this.storage?.removeItem(this.storageKey); } catch {} this.setState({ snapshot: null, announcements: [], quality: "unknown", raceStatus: null, sourceCapturedAt: null, snapshotSequence: 0, needsReset: false, connection: "reconciling", error: `Hub stream reset: ${envelope.data.reason}.` }); return true; }
    if (envelope.type === "snapshot") this.acceptSnapshot(envelope.data, { sequence: envelope.streamSequence, snapshotSequence: envelope.snapshotSequence }); else if (envelope.type === "announcement") { const announcements = envelope.data.status === "active" ? sortAnnouncements([...this.state.announcements.filter(item => item.announcementId !== envelope.data.announcementId), envelope.data]) : this.state.announcements.filter(item => item.announcementId !== envelope.data.announcementId); const snapshot = this.state.snapshot ? { ...this.state.snapshot, activeAnnouncements: announcements } : null; this.setState({ announcements, snapshot }); if (snapshot) this.persist(snapshot); } else if (envelope.type === "announcement-clear") { const announcements = this.state.announcements.filter(item => item.announcementId !== envelope.data.announcementId); const snapshot = this.state.snapshot ? { ...this.state.snapshot, activeAnnouncements: announcements } : null; this.setState({ announcements, snapshot }); if (snapshot) this.persist(snapshot); } else if (envelope.type === "status") this.setState({ connection: envelope.data.connection, quality: envelope.data.quality, raceStatus: envelope.data.raceStatus === undefined ? this.state.raceStatus : envelope.data.raceStatus, error: envelope.data.message || "" }); else if (envelope.type === "warning") this.setState({ connection: "degraded", error: envelope.data.message });
    return true;
  }
  async connect() {
    this.closeStream(); clearTimeout(this.retryTimer); this.retryTimer = 0; this.generation += 1; const generation = this.generation; this.setState({ connection: "connecting", error: "" });
    try { await this.bootstrap(); if (generation === this.generation) this.subscribe(); return true; } catch (error) { if (generation !== this.generation) return false; this.setState({ connection: this.state.snapshot ? "reconnecting" : "error", error: error.message }); this.scheduleReconnect(generation); return false; }
  }
  closeStream() { this.stream?.close(); this.stream = null; }
  subscribe() {
    if (!this.EventSourceImpl) throw new Error("Server-sent events are unavailable in this browser."); const source = new this.EventSourceImpl(new URL("/api/v1/stream", this.base)); this.stream = source; this.setState({ connection: "connecting" });
    for (const type of STREAM_TYPES) source.addEventListener(type, event => { try { this.apply(JSON.parse(event.data)); } catch (error) { this.setState({ connection: "degraded", error: error.message }); this.scheduleReconnect(this.generation); } });
    source.onopen = () => { clearTimeout(this.retryTimer); this.retryTimer = 0; this.retryAttempt = 0; this.setState({ connection: this.state.snapshot ? "live" : "reconciling", error: "" }); };
    // Keep this EventSource instance while it is reconnecting. The browser then
    // carries its SSE id forward as the Last-Event-ID request header.
    source.onerror = () => { this.setState({ connection: "reconnecting", error: "Hub stream interrupted; reconnecting." }); if (source.readyState === 2) this.scheduleReconnect(this.generation); };
    return () => { if (this.stream === source) this.stream = null; source.close(); };
  }
  scheduleReconnect(generation) {
    if (this.retryTimer) return; const delay = Math.min(15000, 1000 * (2 ** Math.min(this.retryAttempt++, 4))); this.retryTimer = setTimeout(async () => { this.retryTimer = 0; if (generation !== this.generation) return; this.closeStream(); try { await this.bootstrap(); if (generation === this.generation) this.subscribe(); } catch (error) { if (generation === this.generation) { this.setState({ connection: "reconnecting", error: error.message }); this.scheduleReconnect(generation); } } }, delay);
  }
  close() { this.generation += 1; clearTimeout(this.retryTimer); this.retryTimer = 0; this.closeStream(); this.setState({ connection: "disabled" }); }
}
