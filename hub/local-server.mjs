import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHubServer,
  RaceDataHub,
  SourceObservation,
  TrustedStore
} from "./index.mjs";
import {
  buildConnectorSchedule,
  findExplicitConnectorActiveIndex,
  normalizeConnectorRaceStatus,
  reconcileConnectorSnapshot,
  selectConnectorCurrentIndex
} from "./connector-race-state.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 4175,
  connectorUrl: "http://127.0.0.1:4174",
  sourceUrl: "https://rotormaniacs.livefpv.com/live/",
  refreshMs: 15000,
  statePath: resolve(root, "data/race-data-hub.json"),
  allowedWriteOrigins: ["http://127.0.0.1:4174", "http://localhost:4174"]
});

const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const safeId = (value, fallback) => {
  const normalized = String(value || fallback).trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 128);
};
const parseHeat = label => {
  const match = String(label || "").match(/(?:heat\s*)?(\d+)\s*[\/]\s*(\d+)/i);
  return match ? { number: Number(match[1]), count: Number(match[2]) } : undefined;
};
const parseWarnings = warnings => (Array.isArray(warnings) ? warnings : []).filter(Boolean).map((message, index) => ({
  code: `connector.warning.${index + 1}`,
  message: String(message).slice(0, 500),
  severity: "warning"
}));

function finiteSourceNumber(value, { integer = false, minimum = -Infinity, maximum = Infinity } = {}) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < minimum || number > maximum) return undefined;
  return number;
}

const UNKNOWN_STATUS_WARNING = Object.freeze({
  code: "race.status_unknown",
  message: "The source did not provide an authoritative status for one or more heats.",
  severity: "warning"
});

export function validateLiveFPVSourceUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("LiveFPV URL must be a valid absolute URL."); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || !/(?:^|\.)livefpv\.com$/i.test(url.hostname)) {
    throw new Error("LiveFPV URL must use HTTP(S) and point to a LiveFPV organization.");
  }
  if ([...url.searchParams.keys()].some(key => /pass(word)?|secret|token|api[-_]?key|auth(entication)?|credential/i.test(key))) {
    throw new Error("LiveFPV URL must not contain credentials.");
  }
  return url.href;
}

function adaptPilot(driver, index) {
  const channel = String(driver.channel || driver.video?.channel || "").toUpperCase();
  const channelMatch = channel.match(/^([A-Z]+)(\d+)$/);
  const frequency = finiteSourceNumber(driver.frequency || driver.video?.frequencyMHz, { minimum: Number.EPSILON });
  const sourceTiming = driver.timing || driver.live;
  const timing = sourceTiming ? compact({
    position: finiteSourceNumber(sourceTiming.position, { integer: true, minimum: 1 }),
    laps: finiteSourceNumber(sourceTiming.laps, { integer: true, minimum: 0 }),
    lapTime: sourceTiming.lapTime == null || sourceTiming.lapTime === "" ? undefined : String(sourceTiming.lapTime).slice(0, 40),
    elapsedTime: sourceTiming.elapsedTime == null || sourceTiming.elapsedTime === "" ? undefined : String(sourceTiming.elapsedTime).slice(0, 40),
    fastestLap: sourceTiming.fastestLap == null || sourceTiming.fastestLap === "" ? undefined : String(sourceTiming.fastestLap).slice(0, 40),
    averageLap: sourceTiming.averageLap == null || sourceTiming.averageLap === "" ? undefined : String(sourceTiming.averageLap).slice(0, 40),
    behind: sourceTiming.behind == null || sourceTiming.behind === "" ? undefined : String(sourceTiming.behind).slice(0, 40),
    consistencyPercent: finiteSourceNumber(sourceTiming.consistencyPercent ?? sourceTiming.consistency, { minimum: 0, maximum: 100 })
  }) : undefined;
  return compact({
    id: safeId(driver.id || driver.sourceId || driver.name, `pilot-${index + 1}`),
    sourceId: driver.sourceId ? safeId(driver.sourceId, `source-pilot-${index + 1}`) : undefined,
    callsign: String(driver.name || driver.callsign || "Unknown pilot").slice(0, 80),
    slot: Number.isInteger(driver.slot) && driver.slot > 0 ? driver.slot : index + 1,
    open: Boolean(driver.open),
    bumpUp: Boolean(driver.bumpUp),
    timing: timing && Object.keys(timing).length ? timing : undefined,
    video: channel || frequency !== undefined ? compact({
      channel: channel || undefined,
      band: channelMatch?.[1],
      number: channelMatch ? Number(channelMatch[2]) : undefined,
      frequencyMHz: frequency
    }) : undefined
  });
}

function adaptRace(race, index) {
  const links = compact({ heatSheet: race.heatSheetUrl || race.links?.heatSheet, results: race.resultUrl || race.links?.results });
  const pilots = Array.isArray(race.drivers) ? race.drivers : Array.isArray(race.pilots) ? race.pilots : [];
  return compact({
    id: safeId(race.id, `race-${index + 1}`),
    runId: race.runId === null ? null : race.runId ? safeId(race.runId, `race-${index + 1}-run`) : undefined,
    attempt: finiteSourceNumber(race.attempt, { integer: true, minimum: 1 }),
    order: index,
    label: String(race.label || `Race ${index + 1}`).slice(0, 200),
    phase: race.phase ? String(race.phase).slice(0, 120) : "Event",
    round: race.round ? String(race.round).slice(0, 120) : undefined,
    heat: parseHeat(race.label),
    status: normalizeConnectorRaceStatus(race.status),
    links: Object.keys(links).length ? links : undefined,
    pilots: pilots.map(adaptPilot)
  });
}

export function adaptConnectorSnapshot(input, { sourceUrl = DEFAULTS.sourceUrl, deliveredAt = new Date().toISOString() } = {}) {
  if (!input?.event?.id || !input?.event?.name) throw new Error("Connector snapshot is missing event metadata.");
  if (!Array.isArray(input.races) || input.races.length === 0) throw new Error("Connector snapshot contains no races.");
  const races = input.races.map(adaptRace);
  const sourceCurrentId = input.schedule?.currentRaceId || input.currentRaceId;
  const sourceCurrentIndex = sourceCurrentId
    ? races.findIndex(race => race.id === safeId(sourceCurrentId, "missing-current"))
    : -1;
  const hasExplicitCurrentId = sourceCurrentIndex >= 0;
  const requestedIndex = sourceCurrentIndex >= 0
    ? sourceCurrentIndex
    : Number.isInteger(input.schedule?.currentIndex)
    ? input.schedule.currentIndex
    : Number.isInteger(input.currentIndex)
      ? input.currentIndex
      : Math.max(0, findExplicitConnectorActiveIndex(input.races));
  const boundedRequestedIndex = Math.min(Math.max(requestedIndex, 0), races.length - 1);
  const currentIndex = selectConnectorCurrentIndex(races, boundedRequestedIndex, { sourceRaces: input.races, hasExplicitCurrentId });
  const currentRaceId = races[currentIndex]?.id ?? null;
  const eventId = safeId(input.event.id, "livefpv-event");
  const eventSessionId = safeId(input.eventSessionId || `livefpv-${eventId}`, `livefpv-${eventId}`);
  const capturedAt = input.capturedAt || input.source?.capturedAt || deliveredAt;
  const baseQualityState = ["fresh", "degraded", "stale"].includes(input.quality?.state)
    ? input.quality.state
    : Array.isArray(input.source?.warnings) && input.source.warnings.length ? "degraded" : "fresh";
  const hasUnknownStatus = races.some(race => race.status === "unknown");
  const qualityState = hasUnknownStatus && baseQualityState === "fresh" ? "degraded" : baseQualityState;
  const revision = String(input.snapshotId || input.source?.revision || `${races.length}-${currentRaceId || "none"}`).slice(0, 160);
  const warnings = parseWarnings(input.source?.warnings || input.quality?.warnings);
  if (hasUnknownStatus && !warnings.some(warning => warning.code === UNKNOWN_STATUS_WARNING.code)) warnings.push(UNKNOWN_STATUS_WARNING);
  return {
    format: "org.fpv.race-event.snapshot",
    version: 1,
    snapshotId: safeId(`hub-${eventSessionId}-${revision}-${currentRaceId || "none"}`, `hub-${eventSessionId}`),
    eventSessionId,
    capturedAt,
    event: {
      id: eventId,
      name: String(input.event.name).slice(0, 200),
      sourceUrl: String(input.event.source || input.source?.reference || sourceUrl)
    },
    sources: [{
      id: "livetime-connector",
      provider: "LiveTimeQue Connector",
      kind: "livefpv-connector",
      revision,
      capturedAt,
      confidence: qualityState === "fresh" ? "high" : "medium"
    }],
    schedule: buildConnectorSchedule(races, currentIndex),
    races,
    quality: {
      state: qualityState,
      completeRaceCount: races.filter(race => race.status === "complete").length,
      warnings,
      domains: { schedule: { state: qualityState, capturedAt, sourceIds: ["livetime-connector"] } }
    },
    activeAnnouncements: []
  };
}

async function readJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, cache: "no-store", signal });
  if (!response.ok) throw new Error(`LiveTime connector request failed with HTTP ${response.status}.`);
  return response.json();
}

export class LiveTimeQueHubSource {
  constructor({ connectorUrl = DEFAULTS.connectorUrl, sourceUrl = DEFAULTS.sourceUrl, fetchImpl = globalThis.fetch } = {}) {
    this.connectorUrl = connectorUrl.replace(/\/$/, "");
    this.sourceUrl = validateLiveFPVSourceUrl(sourceUrl);
    this.fetch = typeof fetchImpl === "function" ? fetchImpl.bind(globalThis) : fetchImpl;
  }

  configure(sourceUrl) {
    this.sourceUrl = validateLiveFPVSourceUrl(sourceUrl);
    return this.sourceUrl;
  }

  snapshotUrl() {
    const url = new URL("/api/connectors/race-event/v1/snapshot", this.connectorUrl);
    url.searchParams.set("sourceUrl", this.sourceUrl);
    url.searchParams.set("force", "1");
    return url;
  }

  streamUrl() {
    const url = new URL("/api/connectors/race-event/v1/stream", this.connectorUrl);
    url.searchParams.set("sourceUrl", this.sourceUrl);
    return url;
  }

  async observe(signal) {
    const input = await readJson(this.fetch, this.snapshotUrl(), signal);
    return new SourceObservation({ snapshot: adaptConnectorSnapshot(input, { sourceUrl: this.sourceUrl }) });
  }

  async stream(onSnapshot, signal, onStatus) {
    const response = await this.fetch(this.streamUrl(), { headers: { accept: "text/event-stream" }, cache: "no-store", signal });
    if (!response.ok) throw new Error(`LiveTime connector stream failed with HTTP ${response.status}.`);
    if (!response.body) throw new Error("LiveTime connector stream returned no body.");
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let data = [];
    const flush = async () => {
      if (!data.length) return;
      const payload = data.join("\n");
      const currentEvent = eventName;
      eventName = "message";
      data = [];
      if (currentEvent === "snapshot") await onSnapshot(adaptConnectorSnapshot(JSON.parse(payload), { sourceUrl: this.sourceUrl }));
      if (currentEvent === "status") {
        try {
          const statusPayload = JSON.parse(payload);
          const status = typeof statusPayload === "string" ? statusPayload : statusPayload?.status;
          if (status) onStatus?.(status);
        } catch { /* ignore malformed status events; the next event can still recover the stream */ }
      }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line === "") await flush();
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
    }
    await flush();
  }
}

export class RaceHubRuntime {
  constructor({
    host = process.env.FPV_HUB_HOST || DEFAULTS.host,
    port = Number(process.env.FPV_HUB_PORT || DEFAULTS.port),
    connectorUrl = process.env.FPV_HUB_CONNECTOR_URL || DEFAULTS.connectorUrl,
    sourceUrl = process.env.FPV_HUB_SOURCE_URL || DEFAULTS.sourceUrl,
    refreshMs = Number(process.env.FPV_HUB_REFRESH_MS || DEFAULTS.refreshMs),
    statePath = process.env.FPV_HUB_STATE_PATH || DEFAULTS.statePath,
    enableTestSnapshotInjection = process.env.FPV_HUB_ENABLE_TEST_SNAPSHOT_INJECTION === "1",
    allowedWriteOrigins = (process.env.FPV_HUB_ALLOWED_WRITE_ORIGINS || DEFAULTS.allowedWriteOrigins.join(",")).split(",").map(value => value.trim()).filter(Boolean),
    fetchImpl = globalThis.fetch
  } = {}) {
    this.host = host;
    this.port = port;
    this.source = new LiveTimeQueHubSource({ connectorUrl, sourceUrl, fetchImpl });
    this.store = new TrustedStore({ persistencePath: statePath });
    this.hub = new RaceDataHub({ source: this.source, store: this.store });
    this.server = createHubServer({ store: this.store, configureSource: sourceUrl => this.configureSource(sourceUrl), enableTestSnapshotInjection, allowedWriteOrigins });
    this.refreshMs = Math.max(5000, refreshMs);
    this.pollTimer = null;
    this.streamAbort = null;
    this.streamTask = null;
    this.syncInProgress = false;
    this.liveStreamHealthy = false;
    this.liveStreamEverJoined = false;
  }

  async configureSource(sourceUrl) {
    const normalized = validateLiveFPVSourceUrl(sourceUrl);
    if (normalized === this.source.sourceUrl && this.store.snapshot) return { sourceUrl: normalized, snapshot: this.store.snapshot, status: this.store.getStatus() };
    const previous = this.source.sourceUrl;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.source.configure(normalized);
    this.liveStreamHealthy = false;
    this.liveStreamEverJoined = false;
    try {
      await this.sync();
      this.startStream();
      return { sourceUrl: normalized, snapshot: this.store.snapshot, status: this.store.getStatus() };
    } catch (error) {
      this.source.configure(previous);
      this.startStream();
      throw error;
    }
  }

  async sync() {
    if (this.syncInProgress) return false;
    this.syncInProgress = true;
    try {
      const observation = await this.source.observe();
      const snapshot = observation.snapshot;
      if (!this.store.active) {
        this.hub.selectEvent({ eventSessionId: snapshot.eventSessionId, event: snapshot.event });
      } else if (this.store.eventSessionId !== snapshot.eventSessionId) {
        this.hub.deactivateEvent();
        this.hub.selectEvent({ eventSessionId: snapshot.eventSessionId, event: snapshot.event });
      }
      this.store.publish(reconcileConnectorSnapshot(this.store.trustedSnapshot || this.store.snapshot, snapshot));
      if (!this.liveStreamHealthy) {
        if (this.liveStreamEverJoined) this.store.markStale("source_reconnecting");
        this.store.emitStatus({ connection: this.store.snapshot ? "reconnecting" : "error", quality: this.store.snapshot?.quality?.state ?? "unknown", message: "Waiting for the LiveTime stream." });
      }
      return true;
    } catch (error) {
      this.store.markStale("source_reconnecting");
      this.store.emitStatus({ connection: this.store.snapshot ? "reconnecting" : "error", quality: this.store.snapshot?.quality?.state ?? "unknown", message: error.message });
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  startStream() {
    this.streamAbort?.abort();
    const controller = new AbortController();
    this.streamAbort = controller;
    this.streamTask = this.source.stream(async snapshot => {
      if (controller.signal.aborted) return;
      if (!this.store.active) {
        this.hub.selectEvent({ eventSessionId: snapshot.eventSessionId, event: snapshot.event });
      } else if (this.store.eventSessionId !== snapshot.eventSessionId) {
        this.hub.deactivateEvent();
        this.hub.selectEvent({ eventSessionId: snapshot.eventSessionId, event: snapshot.event });
      }
      this.store.publish(reconcileConnectorSnapshot(this.store.trustedSnapshot || this.store.snapshot, snapshot));
    }, controller.signal, status => {
      if (!controller.signal.aborted) this.handleLiveStreamStatus(status);
    }).catch(error => {
      if (!controller.signal.aborted) {
        this.handleLiveStreamStatus("failed", error.message);
        console.warn(`LiveTime status stream unavailable: ${error.message}`);
      }
    }).finally(() => {
      if (this.streamAbort === controller && !controller.signal.aborted) {
        setTimeout(() => this.startStream(), 5000).unref?.();
      }
    });
  }

  handleLiveStreamStatus(status, detail = "") {
    const normalized = String(status || "unknown").trim().toLowerCase();
    if (normalized === "joined") {
      this.liveStreamHealthy = true;
      this.liveStreamEverJoined = true;
      this.store.emitStatus({ connection: "live", quality: this.store.snapshot?.quality?.state ?? "unknown", message: "" });
      return;
    }
    this.liveStreamHealthy = false;
    if (["failed", "disconnected", "reconnecting"].includes(normalized) && this.liveStreamEverJoined) this.store.markStale("source_reconnecting");
    const message = detail || (["failed", "disconnected", "reconnecting"].includes(normalized) ? "LiveTime stream reconnecting." : "Connecting to the LiveTime stream.");
    this.store.emitStatus({ connection: this.store.snapshot ? (["failed", "disconnected", "reconnecting"].includes(normalized) ? "reconnecting" : "joining") : "error", quality: this.store.snapshot?.quality?.state ?? "unknown", message });
  }

  async start() {
    if (this.store.persistencePath) await mkdir(dirname(this.store.persistencePath), { recursive: true });
    await this.store.restore();
    const restoredSourceUrl = this.store.snapshot?.event?.sourceUrl || this.store.trustedSnapshot?.event?.sourceUrl;
    if (restoredSourceUrl) {
      try { this.source.configure(restoredSourceUrl); } catch { /* keep the configured environment source */ }
    }
    await new Promise(resolveListen => this.server.listen(this.port, this.host, resolveListen));
    console.log(`Race Data Hub listening on http://${this.host}:${this.port}`);
    console.log(`Hub admin: http://${this.host}:${this.port}/admin`);
    try { await this.sync(); } catch (error) { console.warn(`Initial LiveTime synchronization failed: ${error.message}`); }
    this.pollTimer = setInterval(() => this.sync().catch(error => console.warn(`LiveTime synchronization failed: ${error.message}`)), this.refreshMs);
    this.startStream();
    return this;
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.streamAbort?.abort();
    this.streamAbort = null;
    await new Promise((resolveClose, rejectClose) => this.server.close(error => error ? rejectClose(error) : resolveClose()));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runtime = await new RaceHubRuntime().start();
  const shutdown = async () => { await runtime.stop(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
