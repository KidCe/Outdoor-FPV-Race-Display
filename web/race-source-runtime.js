import { createRaceEventStreamUrl, fetchRaceEventSnapshot, validateRaceEventSnapshot } from "./race-event-connector.js";
import { RaceDataHubClient, getActiveRaceStatus } from "./race-data-hub-client.js";
import { RACE_STATUS, mapRaceStatus } from "./race-status.js";

const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
const DONE_DISPLAY_GRACE_MS = 15_000;
const ACTIVE_STATUSES = new Set([RACE_STATUS.STAGING, RACE_STATUS.RUNNING]);

function raceTrustKey(snapshot, race) {
  return JSON.stringify([snapshot.eventSessionId || "event-session", snapshot.event?.id || "event", race.id]);
}

function sourceTimestamp(snapshot, race, fallback) {
  for (const value of [race?.timing?.capturedAt, snapshot?.capturedAt]) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return fallback;
}

function preserveNewerStatuses(snapshot, trustedStatuses, acceptedAt) {
  const preserved = structuredClone(snapshot);
  for (const race of preserved.races || []) {
    const trusted = trustedStatuses.get(raceTrustKey(preserved, race));
    if (!trusted || trusted.status === RACE_STATUS.UNKNOWN) continue;
    const incomingAt = sourceTimestamp(preserved, race, acceptedAt);
    if (preserved.quality?.state !== "fresh" || trusted.observedAt >= incomingAt) race.status = trusted.rawStatus;
  }
  return preserved;
}

function isTerminalRace(race) {
  const status = mapRaceStatus(race?.status);
  return status === RACE_STATUS.COMPLETE || ["cancelled", "canceled"].includes(String(race?.status || "").trim().toLowerCase());
}

function sameContinuationGroup(current, successor) {
  const currentRound = String(current?.round || "").trim().toLowerCase();
  const successorRound = String(successor?.round || "").trim().toLowerCase();
  return Boolean(currentRound && successorRound && currentRound === successorRound);
}

function safeScheduledSuccessorIndex(snapshot, currentRace) {
  const successorId = snapshot.schedule?.nextRaceIds?.[0];
  if (!successorId) return -1;
  const successorIndex = snapshot.races.findIndex(race => race?.id === successorId);
  const successor = successorIndex >= 0 ? snapshot.races[successorIndex] : null;
  const successorStatus = String(successor?.status || "").trim().toLowerCase();
  if (!successor || isTerminalRace(successor) || !["scheduled", "not_run", RACE_STATUS.STAGING, RACE_STATUS.RUNNING].includes(successorStatus) || !sameContinuationGroup(currentRace, successor)) return -1;
  return successorIndex;
}

function activeScheduledSuccessorIndex(snapshot) {
  let stagingIndex = -1;
  for (const raceId of snapshot.schedule?.nextRaceIds || []) {
    const raceIndex = snapshot.races.findIndex(race => race?.id === raceId);
    const status = mapRaceStatus(snapshot.races[raceIndex]?.status);
    if (status === RACE_STATUS.RUNNING) return raceIndex;
    if (status === RACE_STATUS.STAGING && stagingIndex < 0) stagingIndex = raceIndex;
  }
  return stagingIndex;
}

function scheduleWithCurrent(snapshot, currentIndex) {
  const schedule = snapshot.schedule;
  const currentRaceId = snapshot.races[currentIndex]?.id;
  const orderedIds = [schedule.currentRaceId, ...(schedule.nextRaceIds || []), ...(schedule.afterNextRaceIds || [])].filter(Boolean);
  const selectedPosition = orderedIds.indexOf(currentRaceId);
  const next = { ...schedule, currentRaceId, currentIndex };
  if (selectedPosition >= 0) {
    const following = [...new Set(orderedIds.slice(selectedPosition + 1))];
    const nextCount = Array.isArray(schedule.nextRaceIds) ? schedule.nextRaceIds.length : 0;
    const afterNextCount = Array.isArray(schedule.afterNextRaceIds) ? schedule.afterNextRaceIds.length : 0;
    next.nextRaceIds = following.slice(0, nextCount);
    if (Array.isArray(schedule.afterNextRaceIds)) next.afterNextRaceIds = following.slice(nextCount, nextCount + afterNextCount);
  }
  return { ...snapshot, schedule: next };
}

function prioritizeCurrentRace(snapshot, now) {
  if (!snapshot?.schedule || !Array.isArray(snapshot.races)) return snapshot;
  const currentIndex = snapshot.races.findIndex(race => race?.id === snapshot.schedule.currentRaceId);
  if (currentIndex < 0) return snapshot;

  const currentRace = snapshot.races[currentIndex];
  const currentStatus = mapRaceStatus(currentRace.status);
  let selectedIndex = currentIndex;
  if (!ACTIVE_STATUSES.has(currentStatus)) {
    selectedIndex = activeScheduledSuccessorIndex(snapshot);
    if (selectedIndex < 0) selectedIndex = currentIndex;
  }

  if (selectedIndex === currentIndex && currentStatus === RACE_STATUS.COMPLETE && snapshot.quality?.state === "fresh") {
    const completedAt = Date.parse(currentRace.timing?.stoppedAt || currentRace.timing?.capturedAt || snapshot.capturedAt || "");
    const age = Number(now) - completedAt;
    if (Number.isFinite(completedAt) && age >= DONE_DISPLAY_GRACE_MS) {
      const successorIndex = safeScheduledSuccessorIndex(snapshot, currentRace);
      if (successorIndex >= 0) selectedIndex = successorIndex;
    }
  }

  return selectedIndex === currentIndex ? snapshot : scheduleWithCurrent(snapshot, selectedIndex);
}

function doneTransitionDelay(snapshot, now) {
  if (!snapshot?.schedule || !Array.isArray(snapshot.races)) return null;
  const currentRace = snapshot.races.find(race => race?.id === snapshot.schedule.currentRaceId);
  if (mapRaceStatus(currentRace?.status) !== RACE_STATUS.COMPLETE || safeScheduledSuccessorIndex(snapshot, currentRace) < 0) return null;
  const completedAt = Date.parse(currentRace.timing?.stoppedAt || currentRace.timing?.capturedAt || snapshot.capturedAt || "");
  if (!Number.isFinite(completedAt)) return null;
  return Math.max(0, completedAt + DONE_DISPLAY_GRACE_MS - Number(now));
}

export class HttpRaceSourceAdapter {
  constructor({ fetchImpl = globalThis.fetch, EventSourceImpl = globalThis.EventSource } = {}) {
    this.fetchImpl = fetchImpl;
    this.EventSourceImpl = EventSourceImpl;
  }
  snapshot(config, signal) {
    return fetchRaceEventSnapshot({ ...config, fetchImpl: this.fetchImpl, signal });
  }
  subscribe(config, handlers) {
    if (!this.EventSourceImpl) throw new Error("Server-sent events are unavailable in this browser.");
    const stream = new this.EventSourceImpl(createRaceEventStreamUrl(config));
    stream.addEventListener("snapshot", event => handlers.snapshot(JSON.parse(event.data)));
    stream.onopen = () => handlers.open?.();
    stream.onerror = () => handlers.error?.(new Error("Live event stream interrupted."));
    return () => stream.close();
  }
}

export class RecordedRaceSourceAdapter {
  constructor(snapshots = []) { this.snapshots = snapshots; this.index = 0; }
  async snapshot() {
    if (!this.snapshots.length) throw new Error("No recorded snapshots are available.");
    return structuredClone(this.snapshots[Math.min(this.index++, this.snapshots.length - 1)]);
  }
  subscribe(_config, handlers) {
    const timer = setInterval(async () => {
      try { handlers.snapshot(await this.snapshot()); } catch (error) { handlers.error?.(error); }
    }, 1000);
    return () => clearInterval(timer);
  }
}

export class RaceSourceRuntime {
  constructor({ adapter = new HttpRaceSourceAdapter(), hubClientFactory = options => new RaceDataHubClient(options), onState = () => {}, now = () => Date.now(), storage = globalThis.localStorage, storageKey = "fpv-race-source-trusted-v1", setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
    this.adapter = adapter;
    this.hubClientFactory = hubClientFactory;
    this.onState = onState;
    this.now = now;
    this.config = {};
    this.enabled = false;
    this.generation = 0;
    this.retryAttempt = 0;
    this.reconcileTimer = 0;
    this.retryTimer = 0;
    this.doneGraceTimer = null;
    this.unsubscribeStream = null;
    this.abortController = null;
    this.storage = storage;
    this.storageKey = storageKey;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.trustedStatuses = new Map();
    this.configured = false;
    this.state = { connection: "disabled", snapshot: null, raceStatus: null, lastDataAt: null, sourceCapturedAt: null, error: "", announcements: [], quality: "unknown" };
    this.hubClient = null;
    try {
      const cached = JSON.parse(this.storage?.getItem(this.storageKey) || "null");
      if (cached?.snapshot) {
        this.state.snapshot = validateRaceEventSnapshot(cached.snapshot);
        this.state.raceStatus = getActiveRaceStatus(this.state.snapshot);
        this.state.lastDataAt = Number(cached.lastDataAt) || null;
        this.state.sourceCapturedAt = this.state.snapshot.capturedAt || null;
        this.state.quality = "stale";
        this.state.connection = "reconnecting";
        this.rememberStatuses(this.state.snapshot, this.state.lastDataAt || this.now());
      }
    } catch {}
  }

  subscribe(listener) {
    const previous = this.onState;
    this.onState = state => { previous(state); listener(state); };
    listener(this.getState());
    return () => { this.onState = previous; };
  }

  getState() { return { ...this.state, snapshot: this.state.snapshot }; }

  clearTrustedSnapshot() {
    this.clearDoneGraceTimer();
    try { this.storage?.removeItem(this.storageKey); } catch {}
    try { this.storage?.removeItem("fpv-race-hub-trusted-v1"); } catch {}
    this.hubClient?.clearTrustedSnapshot?.();
    this.trustedStatuses.clear();
    this.setState({ snapshot: null, raceStatus: null, lastDataAt: null, sourceCapturedAt: null, announcements: [], quality: "unknown", error: this.enabled ? this.state.error : "" });
  }

  configure(config) {
    const next = {
      connectorUrl: String(config.connectorUrl || "").trim(),
      hubUrl: String(config.hubUrl || "").trim(),
      sourceUrl: String(config.sourceUrl || config.eventUrl || "").trim(),
      reconcileSeconds: Math.max(10, Number(config.reconcileSeconds) || 30)
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.config);
    if (this.configured && changed && (next.connectorUrl !== this.config.connectorUrl || next.sourceUrl !== this.config.sourceUrl)) this.trustedStatuses.clear();
    this.config = next;
    this.configured = true;
    if (changed && this.enabled) void this.restart();
  }

  async setEnabled(enabled) {
    if (Boolean(enabled) === this.enabled) return;
    this.enabled = Boolean(enabled);
    if (this.enabled) await this.restart(); else this.stop();
  }

  async restart() {
    this.stop(false);
    this.enabled = true;
    const generation = ++this.generation;
    this.setState({ connection: "connecting", error: "" });
    if (this.config.hubUrl) {
      try {
        const hub = this.hubClientFactory({ hubUrl: this.config.hubUrl, storage: this.storage, now: this.now, onState: state => { if (generation !== this.generation || !this.enabled) return; const snapshot = prioritizeCurrentRace(state.snapshot, this.now()); this.setState({ connection: state.connection === "live" ? "connected" : state.connection, snapshot, raceStatus: getActiveRaceStatus(snapshot) ?? state.raceStatus, lastDataAt: state.lastDataAt, sourceCapturedAt: state.sourceCapturedAt, error: state.error, announcements: state.announcements, quality: state.quality }); this.scheduleDoneGraceTransition(snapshot); } });
        this.hubClient = hub;
        const hubState = hub.getState();
        const snapshot = prioritizeCurrentRace(hubState.snapshot, this.now());
        this.setState({ connection: hubState.connection === "live" ? "connected" : hubState.connection, snapshot, raceStatus: getActiveRaceStatus(snapshot) ?? hubState.raceStatus, lastDataAt: hubState.lastDataAt, sourceCapturedAt: hubState.sourceCapturedAt, error: hubState.error, announcements: hubState.announcements, quality: hubState.quality });
        this.scheduleDoneGraceTransition(snapshot);
        this.unsubscribeStream = () => hub.close();
        await hub.connect();
      } catch (error) {
        if (generation === this.generation && this.enabled) this.setState({ connection: this.state.snapshot ? "reconnecting" : "error", error: error.message });
      }
      return;
    }
    await this.refresh(generation);
    if (this.enabled && generation === this.generation) this.openStream(generation);
    if (this.enabled && generation === this.generation) {
      this.reconcileTimer = setInterval(() => void this.refresh(generation, true), this.config.reconcileSeconds * 1000);
    }
  }

  stop(markDisabled = true) {
    this.generation += 1;
    clearInterval(this.reconcileTimer);
    clearTimeout(this.retryTimer);
    this.clearDoneGraceTimer();
    this.reconcileTimer = 0;
    this.retryTimer = 0;
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.abortController?.abort();
    this.hubClient = null;
    this.abortController = null;
    if (markDisabled) {
      this.enabled = false;
      this.trustedStatuses.clear();
      this.setState({ connection: "disabled", error: "" });
    }
  }

  async refresh(generation = this.generation, quiet = false) {
    if (!this.config.sourceUrl) {
      this.setState({ connection: "error", error: "Enter a LiveFPV event URL." });
      return;
    }
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    if (!quiet) this.setState({ connection: "connecting", error: "" });
    try {
      const snapshot = await this.adapter.snapshot(this.config, controller.signal);
      if (!this.enabled || generation !== this.generation) return;
      this.accept(snapshot, { origin: quiet ? "reconciliation" : "initial" });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.setState({ connection: this.state.snapshot ? "degraded" : "error", quality: this.state.snapshot ? "degraded" : "unknown", error: error.message });
    }
  }

  openStream(generation) {
    this.unsubscribeStream?.();
    try {
      this.unsubscribeStream = this.adapter.subscribe(this.config, {
        open: () => {
          if (generation !== this.generation) return;
          this.retryAttempt = 0;
          this.setState({ connection: "connected", error: "" });
        },
        snapshot: snapshot => {
          if (generation !== this.generation) return;
          try { this.accept(snapshot, { origin: "live" }); } catch (error) { this.setState({ connection: "degraded", quality: "degraded", error: error.message }); }
        },
        error: error => {
          if (generation !== this.generation || !this.enabled) return;
          this.setState({ connection: this.state.snapshot ? "reconnecting" : "error", quality: this.state.snapshot ? "degraded" : "unknown", error: error.message });
          this.scheduleReconnect(generation);
        }
      });
    } catch (error) {
      this.setState({ connection: this.state.snapshot ? "reconnecting" : "error", quality: this.state.snapshot ? "degraded" : "unknown", error: error.message });
      this.scheduleReconnect(generation);
    }
  }

  scheduleReconnect(generation) {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    clearTimeout(this.retryTimer);
    const delay = Math.min(15000, 1000 * (2 ** Math.min(this.retryAttempt++, 4)));
    this.retryTimer = setTimeout(async () => {
      if (!this.enabled || generation !== this.generation) return;
      await this.refresh(generation, true);
      if (this.enabled && generation === this.generation) this.openStream(generation);
    }, delay);
  }

  accept(snapshot, { origin = "initial" } = {}) {
    const trusted = validateRaceEventSnapshot(snapshot);
    if (this.state.snapshot?.eventSessionId && this.state.snapshot.eventSessionId !== trusted.eventSessionId) this.trustedStatuses.clear();
    const acceptedAt = this.now();
    const next = prioritizeCurrentRace(origin === "live" ? trusted : preserveNewerStatuses(trusted, this.trustedStatuses, acceptedAt), acceptedAt);
    if (origin === "live" || trusted.quality?.state === "fresh") this.rememberStatuses(next, acceptedAt);
    this.retryAttempt = 0;
    try { this.storage?.setItem(this.storageKey, JSON.stringify({ snapshot: next, lastDataAt: acceptedAt })); } catch {}
    this.setState({ connection: "connected", snapshot: next, raceStatus: getActiveRaceStatus(next), lastDataAt: acceptedAt, sourceCapturedAt: next.capturedAt || null, quality: next.quality?.state || "unknown", error: "" });
    this.scheduleDoneGraceTransition(next);
  }

  clearDoneGraceTimer() {
    if (this.doneGraceTimer === null) return;
    this.clearTimeoutImpl(this.doneGraceTimer);
    this.doneGraceTimer = null;
  }

  scheduleDoneGraceTransition(snapshot) {
    this.clearDoneGraceTimer();
    if (this.state.quality !== "fresh") return;
    const delay = doneTransitionDelay(snapshot, this.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    this.doneGraceTimer = this.setTimeoutImpl(() => {
      this.doneGraceTimer = null;
      if (this.state.quality !== "fresh") return;
      const current = this.state.snapshot;
      const next = prioritizeCurrentRace(current, this.now());
      if (next === current) return;
      try { this.storage?.setItem(this.storageKey, JSON.stringify({ snapshot: next, lastDataAt: this.state.lastDataAt })); } catch {}
      this.setState({ snapshot: next, raceStatus: getActiveRaceStatus(next) });
    }, delay);
    this.doneGraceTimer?.unref?.();
  }

  rememberStatuses(snapshot, acceptedAt) {
    for (const race of snapshot.races || []) {
      const status = mapRaceStatus(race.status);
      if (status === RACE_STATUS.UNKNOWN) continue;
      const observedAt = sourceTimestamp(snapshot, race, acceptedAt);
      const key = raceTrustKey(snapshot, race);
      const previous = this.trustedStatuses.get(key);
      if (!previous || observedAt >= previous.observedAt) this.trustedStatuses.set(key, { rawStatus: race.status, status, observedAt });
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    if (patch.quality && patch.quality !== "fresh") this.clearDoneGraceTimer();
    this.onState(this.getState());
  }
}
