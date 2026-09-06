import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHubServer,
  RaceDataHub,
  SourceObservation,
  TrustedStore
} from "./index.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 4175,
  connectorUrl: "http://127.0.0.1:4174",
  sourceUrl: "https://techdroneleague.livefpv.com/",
  writePassword: "local-race-day",
  refreshMs: 15000,
  statePath: resolve(root, "data/race-data-hub.json")
});

const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const sourceStatus = value => {
  const normalized = String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ({ ready: "staging", racing: "running", completed: "complete", not_yet_run: "not_run", canceled: "cancelled" })[normalized] || normalized;
};
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

const EXPLICIT_ACTIVE_STATUSES = new Set(["staging", "running"]);
const TERMINAL_STATUSES = new Set(["complete", "cancelled"]);

function selectCurrentIndex(races, requestedIndex) {
  const requestedRace = races[requestedIndex];
  if (EXPLICIT_ACTIVE_STATUSES.has(requestedRace?.status)) return requestedIndex;

  const runningIndex = races.findIndex(race => race.status === "running");
  if (runningIndex >= 0) return runningIndex;
  const stagingIndex = races.findIndex(race => race.status === "staging");
  if (stagingIndex >= 0) return stagingIndex;

  const completedIndex = races.reduce((latest, race, index) => race.status === "complete" ? index : latest, -1);
  return completedIndex >= 0 ? completedIndex : requestedIndex;
}

function adaptPilot(driver, index) {
  const channel = String(driver.channel || driver.video?.channel || "").toUpperCase();
  const channelMatch = channel.match(/^([A-Z]+)(\d+)$/);
  const frequency = Number(driver.frequency || driver.video?.frequencyMHz);
  return compact({
    id: safeId(driver.id || driver.sourceId || driver.name, `pilot-${index + 1}`),
    sourceId: driver.sourceId ? safeId(driver.sourceId, `source-pilot-${index + 1}`) : undefined,
    callsign: String(driver.name || driver.callsign || "Unknown pilot").slice(0, 80),
    slot: Number.isInteger(driver.slot) && driver.slot > 0 ? driver.slot : index + 1,
    open: Boolean(driver.open),
    bumpUp: Boolean(driver.bumpUp),
    video: channel || Number.isFinite(frequency) ? compact({
      channel: channel || undefined,
      band: channelMatch?.[1],
      number: channelMatch ? Number(channelMatch[2]) : undefined,
      frequencyMHz: Number.isInteger(frequency) ? frequency : undefined
    }) : undefined
  });
}

function adaptRace(race, index) {
  const links = compact({ heatSheet: race.heatSheetUrl || race.links?.heatSheet, results: race.resultUrl || race.links?.results });
  const pilots = Array.isArray(race.drivers) ? race.drivers : Array.isArray(race.pilots) ? race.pilots : [];
  return compact({
    id: safeId(race.id, `race-${index + 1}`),
    order: index,
    label: String(race.label || `Race ${index + 1}`).slice(0, 200),
    phase: race.phase ? String(race.phase).slice(0, 120) : "Event",
    round: race.round ? String(race.round).slice(0, 120) : undefined,
    heat: parseHeat(race.label),
    status: sourceStatus(race.status),
    links: Object.keys(links).length ? links : undefined,
    pilots: pilots.map(adaptPilot)
  });
}

function buildSchedule(races, currentIndex) {
  return {
    currentRaceId: races[currentIndex]?.id ?? null,
    currentIndex,
    nextRaceIds: races.slice(currentIndex + 1, currentIndex + 3).map(race => race.id),
    afterNextRaceIds: races.slice(currentIndex + 3, currentIndex + 6).map(race => race.id)
  };
}

export function adaptConnectorSnapshot(input, { sourceUrl = DEFAULTS.sourceUrl, deliveredAt = new Date().toISOString() } = {}) {
  if (!input?.event?.id || !input?.event?.name) throw new Error("Connector snapshot is missing event metadata.");
  if (!Array.isArray(input.races) || input.races.length === 0) throw new Error("Connector snapshot contains no races.");
  const races = input.races.map(adaptRace);
  const requestedIndex = Number.isInteger(input.schedule?.currentIndex)
    ? input.schedule.currentIndex
    : Number.isInteger(input.currentIndex)
      ? input.currentIndex
      : Math.max(0, races.findIndex(race => race.status === "running" || race.status === "staging"));
  const boundedRequestedIndex = Math.min(Math.max(requestedIndex, 0), races.length - 1);
  const currentIndex = selectCurrentIndex(races, boundedRequestedIndex);
  const currentRaceId = races[currentIndex]?.id ?? null;
  const eventId = safeId(input.event.id, "livefpv-event");
  const eventSessionId = safeId(input.eventSessionId || `livefpv-${eventId}`, `livefpv-${eventId}`);
  const capturedAt = input.capturedAt || input.source?.capturedAt || deliveredAt;
  const qualityState = ["fresh", "degraded", "stale"].includes(input.quality?.state)
    ? input.quality.state
    : Array.isArray(input.source?.warnings) && input.source.warnings.length ? "degraded" : "fresh";
  const revision = String(input.snapshotId || input.source?.revision || `${races.length}-${currentRaceId || "none"}`).slice(0, 160);
  const warnings = parseWarnings(input.source?.warnings || input.quality?.warnings);
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
    schedule: buildSchedule(races, currentIndex),
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

export function reconcileConnectorSnapshot(previous, candidate) {
  if (!previous || !candidate || previous.eventSessionId !== candidate.eventSessionId || previous.event?.id !== candidate.event?.id) return candidate;
  const previousIndex = previous.schedule?.currentIndex;
  const candidateIndex = candidate.schedule?.currentIndex;
  if (!Number.isInteger(previousIndex) || !Number.isInteger(candidateIndex) || candidateIndex >= previousIndex) return candidate;

  const previousStatus = previous.races?.[previousIndex]?.status;
  const candidateStatus = candidate.races?.[candidateIndex]?.status;
  const previousRace = previous.races?.[previousIndex];
  const candidateRace = candidate.races?.[candidateIndex];
  const laterRaces = (candidate.races?.slice(candidateIndex + 1) || []).filter(race => sameRaceGroup(race, candidateRace));
  const hasUnfinishedLaterRace = laterRaces.some(race => !TERMINAL_STATUSES.has(race?.status));
  if (!TERMINAL_STATUSES.has(previousStatus) || !sameRaceGroup(previousRace, candidateRace) || EXPLICIT_ACTIVE_STATUSES.has(candidateStatus) || hasUnfinishedLaterRace) return candidate;

  const retainedIndex = candidate.races.findIndex(race => race.id === previous.schedule?.currentRaceId);
  if (retainedIndex < 0) return candidate;
  return { ...candidate, schedule: buildSchedule(candidate.races, retainedIndex) };
}

function sameRaceGroup(left, right) {
  const leftRound = String(left?.round || "").trim().toLowerCase();
  const rightRound = String(right?.round || "").trim().toLowerCase();
  return !leftRound || !rightRound || leftRound === rightRound;
}

async function readJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, cache: "no-store", signal });
  if (!response.ok) throw new Error(`LiveTime connector request failed with HTTP ${response.status}.`);
  return response.json();
}

export class LiveTimeQueHubSource {
  constructor({ connectorUrl = DEFAULTS.connectorUrl, sourceUrl = DEFAULTS.sourceUrl, fetchImpl = globalThis.fetch } = {}) {
    this.connectorUrl = connectorUrl.replace(/\/$/, "");
    this.sourceUrl = sourceUrl;
    this.fetch = fetchImpl;
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

  async stream(onSnapshot, signal) {
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
    writePassword = process.env.FPV_HUB_WRITE_PASSWORD || DEFAULTS.writePassword,
    refreshMs = Number(process.env.FPV_HUB_REFRESH_MS || DEFAULTS.refreshMs),
    statePath = process.env.FPV_HUB_STATE_PATH || DEFAULTS.statePath,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.host = host;
    this.port = port;
    this.source = new LiveTimeQueHubSource({ connectorUrl, sourceUrl, fetchImpl });
    this.store = new TrustedStore({ persistencePath: statePath });
    this.hub = new RaceDataHub({ source: this.source, store: this.store });
    this.server = createHubServer({ store: this.store, writePassword });
    this.refreshMs = Math.max(5000, refreshMs);
    this.pollTimer = null;
    this.streamAbort = null;
    this.streamTask = null;
    this.syncInProgress = false;
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
    }, controller.signal).catch(error => {
      if (!controller.signal.aborted) console.warn(`LiveTime status stream unavailable: ${error.message}`);
    }).finally(() => {
      if (this.streamAbort === controller && !controller.signal.aborted) {
        setTimeout(() => this.startStream(), 5000).unref?.();
      }
    });
  }

  async start() {
    await mkdir(dirname(this.store.persistencePath), { recursive: true });
    await this.store.restore();
    await new Promise(resolveListen => this.server.listen(this.port, this.host, resolveListen));
    console.log(`Race Data Hub listening on http://${this.host}:${this.port}`);
    console.log(`Hub admin: http://${this.host}:${this.port}/admin`);
    console.log(`Announcement password: ${process.env.FPV_HUB_WRITE_PASSWORD || DEFAULTS.writePassword}`);
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
