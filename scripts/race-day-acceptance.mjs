import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import { projectHubSnapshot, RaceDataHubClient, validateHubSnapshot } from "../web/race-data-hub-client.js";
import { createRaceDayApp } from "../web/race-day-app.js";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURE_SERVER = join(ROOT, "scripts", "race-day-fixture-server.mjs");
const EVENT_SESSION_ID = "acceptance-session-1";
const PASSWORD = "acceptance-write-password";
const EVENT = {
  id: "acceptance-event",
  name: "Deterministic Forest Race Replay",
  organizer: "Rotormaniacs",
  sourceUrl: "https://rotormaniacs.livefpv.com/live/scoring/"
};

const ANSI = Object.freeze({
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  reset: "\u001b[0m"
});

class AcceptanceFailure extends Error {
  constructor(category, scenario, message, details = {}) {
    super(`${category} [${scenario}] ${message}`);
    this.name = "AcceptanceFailure";
    this.category = category;
    this.scenario = scenario;
    this.details = details;
  }
}

function json(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function fail(category, scenario, message, expected, observed) {
  throw new AcceptanceFailure(category, scenario, message, { expected, observed });
}

function expectEqual(actual, expected, label, scenario, category = "SEMANTIC_MISMATCH") {
  if (json(actual) !== json(expected)) fail(category, scenario, `${label} differs.`, expected, actual);
}

function expectTrue(condition, label, scenario, category = "SEMANTIC_MISMATCH") {
  if (!condition) fail(category, scenario, `${label} was not satisfied.`, true, condition);
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
}

async function waitFor(predicate, label, scenario, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(10);
  }
  fail("TRANSPORT_FAILURE", scenario, `Timed out waiting for ${label}.`, "eventually true", false);
}

function logLine(text, color = "cyan") {
  if (globalThis.__raceDayAcceptanceQuiet) return;
  const useColor = !process.env.NO_COLOR && !process.argv.includes("--no-color");
  console.log(useColor ? `${ANSI[color] || ""}${text}${ANSI.reset}` : text);
}

async function runScenario(name, action) {
  try {
    await action();
    logLine(`PASS  ${name}`, "green");
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure("SEMANTIC_MISMATCH", name, error?.message || String(error), "no exception", error?.stack || error);
  }
}

function pilot(id, callsign, channel, frequencyMHz) {
  return {
    id,
    sourceId: `source-${id}`,
    callsign,
    slot: 1,
    open: false,
    bumpUp: false,
    match: { method: "source_id", confidence: "high" },
    video: { channel, band: channel.slice(0, 1), number: Number(channel.slice(1)), frequencyMHz }
  };
}

function createRace({ id, order, label, phase, round, heat, status, capturedAt, pilots = [] }) {
  const race = {
    id,
    runId: ["staging", "running", "complete"].includes(status) ? `${id}-run-1` : null,
    order,
    label,
    phase,
    round,
    heat: { number: heat, count: phase === "Mains" ? 8 : 24 },
    status,
    links: {},
    pilots: structuredClone(pilots)
  };
  if (["staging", "running", "complete", "unknown"].includes(status)) {
    race.timing = {
      state: status === "unknown" ? "stale" : status,
      elapsedMs: status === "running" ? 21000 : 0,
      startedAt: ["running", "complete"].includes(status) ? capturedAt : null,
      stoppedAt: status === "complete" ? capturedAt : null,
      capturedAt
    };
  }
  return race;
}

function createSnapshot(key, {
  capturedAt,
  currentId,
  statuses,
  nextRaceIds,
  afterNextRaceIds = [],
  quality = "fresh"
}) {
  const pilots = {
    q1: [pilot("pilot-q1", "PilotOne", "R1", 5658), pilot("pilot-q2", "PilotTwo", "R8", 5917)],
    q2: [pilot("pilot-q3", "PilotThree", "F2", 5740)],
    q3: [pilot("pilot-q4", "PilotFour", "R3", 5769)],
    m1: [pilot("pilot-m1", "MainPilot", "L6", 5843)],
    m2: [pilot("pilot-m2", "MainNext", "L7", 5880)]
  };
  const defaults = { q1: "scheduled", q2: "scheduled", q3: "scheduled", q4: "scheduled", m1: "scheduled", m2: "scheduled" };
  const selectedStatuses = { ...defaults, ...statuses };
  const definitions = [
    ["q1", 0, "Qualifier (Heat 18/24)", "Qualifier", "Qualifier Round 3", 18],
    ["q2", 1, "Qualifier (Heat 19/24)", "Qualifier", "Qualifier Round 3", 19],
    ["q3", 2, "Qualifier (Heat 20/24)", "Qualifier", "Qualifier Round 3", 20],
    ["q4", 3, "Qualifier (Heat 21/24)", "Qualifier", "Qualifier Round 3", 21],
    ["m1", 4, "Mains (Heat 1/8)", "Mains", "Mains Round 1", 1],
    ["m2", 5, "Mains (Heat 2/8)", "Mains", "Mains Round 1", 2]
  ];
  const races = definitions.map(([id, order, label, phase, round, heat]) => createRace({
    id,
    order,
    label,
    phase,
    round,
    heat,
    status: selectedStatuses[id],
    capturedAt,
    pilots: pilots[id] || []
  }));
  const currentIndex = races.findIndex(race => race.id === currentId);
  if (currentIndex < 0) throw new Error(`Fixture current race '${currentId}' is missing.`);
  const sourceId = "deterministic-replay";
  return {
    format: "org.fpv.race-event.snapshot",
    version: 1,
    snapshotId: `acceptance:${key}`,
    eventSessionId: EVENT_SESSION_ID,
    capturedAt,
    event: structuredClone(EVENT),
    sources: [{ id: sourceId, provider: "Deterministic Replay", kind: "simulated-race-data-hub", revision: `acceptance-${key}`, capturedAt, confidence: "high" }],
    schedule: { currentRaceId: currentId, currentIndex, nextRaceIds, afterNextRaceIds },
    races,
    quality: {
      state: quality,
      completeRaceCount: races.filter(race => race.status === "complete").length,
      warnings: quality === "stale" ? [{ code: "source.reconnecting", message: "Replay source is late; last trusted data is being retained.", severity: "warning" }] : [],
      domains: Object.fromEntries(["schedule", "lineup", "timing", "channels"].map(domain => [domain, { state: quality, capturedAt, sourceIds: [sourceId], ...(quality === "stale" ? { reason: "source_reconnecting" } : {}) }]))
    },
    activeAnnouncements: []
  };
}

function createScenarios() {
  const time = minute => `2026-09-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    staging: createSnapshot("staging", { capturedAt: time(0), currentId: "q1", statuses: { q1: "staging" }, nextRaceIds: ["q2", "q3"], afterNextRaceIds: ["q4"] }),
    running: createSnapshot("running", { capturedAt: time(1), currentId: "q1", statuses: { q1: "running" }, nextRaceIds: ["q2", "q3"], afterNextRaceIds: ["q4"] }),
    complete: createSnapshot("complete", { capturedAt: time(2), currentId: "q1", statuses: { q1: "complete", q2: "staging" }, nextRaceIds: ["q2", "q3"], afterNextRaceIds: ["q4"] }),
    validNextUp: createSnapshot("valid-next-up", { capturedAt: time(3), currentId: "q1", statuses: { q1: "complete", q2: "scheduled" }, nextRaceIds: ["q2", "q3"], afterNextRaceIds: ["q4"] }),
    missingNextUp: createSnapshot("missing-next-up", { capturedAt: time(4), currentId: "q1", statuses: { q1: "complete", q2: "scheduled" }, nextRaceIds: ["late-next"], afterNextRaceIds: ["q3"] }),
    cycle: createSnapshot("cycle", { capturedAt: time(5), currentId: "q1", statuses: { q1: "complete", q2: "staging" }, nextRaceIds: ["q2", "q3"], afterNextRaceIds: ["q4"] }),
    heatChange: createSnapshot("heat-change", { capturedAt: time(6), currentId: "q2", statuses: { q1: "complete", q2: "running", q3: "staging" }, nextRaceIds: ["q3", "q4"], afterNextRaceIds: ["m1"] }),
    mains: createSnapshot("mains", { capturedAt: time(7), currentId: "m1", statuses: { q1: "complete", q2: "complete", q3: "complete", q4: "complete", m1: "staging", m2: "scheduled" }, nextRaceIds: ["m2"], afterNextRaceIds: [] }),
    staleUnknown: createSnapshot("stale-unknown", { capturedAt: time(8), currentId: "m1", statuses: { q1: "complete", q2: "complete", q3: "complete", q4: "complete", m1: "unknown", m2: "unknown" }, nextRaceIds: ["m2"], afterNextRaceIds: [], quality: "stale" }),
    recovered: createSnapshot("recovered", { capturedAt: time(9), currentId: "m1", statuses: { q1: "complete", q2: "complete", q3: "complete", q4: "complete", m1: "running", m2: "staging" }, nextRaceIds: ["m2"], afterNextRaceIds: [] })
  };
}

class FetchEventSource {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    this.controller = new AbortController();
    this.closed = false;
    this.reader = null;
    this.buffer = "";
    void this.run();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
    this.controller.abort();
    void this.reader?.cancel().catch(() => {});
  }

  dispatch(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ type, data });
  }

  consume(block) {
    const lines = block.split(/\r?\n/);
    const type = lines.find(line => line.startsWith("event: "))?.slice(7) || "message";
    const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
    if (data) this.dispatch(type, data);
  }

  async run() {
    try {
      const response = await fetch(this.url, { signal: this.controller.signal });
      if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
      this.readyState = 1;
      this.onopen?.();
      this.reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!this.closed) {
        const result = await this.reader.read();
        if (result.done) break;
        this.buffer += decoder.decode(result.value, { stream: true });
        const blocks = this.buffer.split(/\r?\n\r?\n/);
        this.buffer = blocks.pop() || "";
        for (const block of blocks) if (!this.closed) this.consume(block);
      }
    } catch (error) {
      if (!this.closed) {
        this.readyState = 2;
        this.onerror?.(error);
      }
    }
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

function canvasContext() {
  return {
    fillRect() {}, fillText() {}, fillStyle: "", strokeStyle: "", lineWidth: 1,
    imageSmoothingEnabled: false, textBaseline: "", textAlign: "", font: "",
    save() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, restore() {},
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {}
  };
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this._className = "";
    this._classTokens = new Set();
    this._innerHTML = "";
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value); this._classTokens = new Set(this._className.split(/\s+/).filter(Boolean)); }
  get classList() {
    return {
      toggle: (token, force) => { const enabled = force === undefined ? !this._classTokens.has(token) : Boolean(force); if (enabled) this._classTokens.add(token); else this._classTokens.delete(token); this._className = [...this._classTokens].join(" "); return enabled; },
      contains: token => this._classTokens.has(token),
      add: (...tokens) => tokens.forEach(token => this._classTokens.add(token)),
      remove: (...tokens) => tokens.forEach(token => this._classTokens.delete(token)
      )
    };
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    if (this._innerHTML.includes("<strong>")) this.children.push(new FakeElement("strong"), new FakeElement("p"), new FakeElement("small"));
    else if (this._innerHTML.includes("No active announcements")) { const empty = new FakeElement("p"); empty.className = "notice"; empty.textContent = "No active announcements."; this.children.push(empty); }
  }
  get innerHTML() { return this._innerHTML; }
  append(...children) { this.children.push(...children.filter(Boolean)); }
  prepend(...children) { this.children.unshift(...children.filter(Boolean)); }
  replaceChildren(...children) { this.children = children.filter(Boolean); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelector(selector) {
    if (selector.startsWith(".")) return this.children.find(child => child.classList?.contains(selector.slice(1))) || null;
    return this.children.find(child => child.tagName === selector.toLowerCase()) || null;
  }
  querySelectorAll() { return []; }
  remove() { this.removed = true; }
  getContext() { return canvasContext(); }
  toDataURL() { return "data:image/png;base64,"; }
}

class FakeDocument {
  constructor() { this.elements = new Map(); }
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(id === "matrixPreview" || id === "readbackCanvas" ? "canvas" : "div"));
    return this.elements.get(id);
  }
  createElement(tagName) { return new FakeElement(tagName); }
  addEventListener() {}
  querySelectorAll() { return []; }
}

function createControlDesk(hubUrl) {
  const previous = { document: globalThis.document, location: globalThis.location, setInterval: globalThis.setInterval };
  const document = new FakeDocument();
  globalThis.document = document;
  globalThis.location = { origin: hubUrl, search: `?hub=${encodeURIComponent(hubUrl)}` };
  globalThis.setInterval = () => 0;
  const app = createRaceDayApp();
  app.profile = app.profileStore.update({ source: { enabled: false } });
  return {
    app,
    document,
    async start() { await app.start(); },
    restore() { globalThis.document = previous.document; globalThis.location = previous.location; globalThis.setInterval = previous.setInterval; }
  };
}

async function startFixture({ statePath, epoch }) {
  const child = spawn(process.execPath, [FIXTURE_SERVER], {
    cwd: ROOT,
    env: { ...process.env, FPV_E2E_STATE_PATH: statePath, FPV_E2E_EPOCH: epoch, FPV_E2E_PASSWORD: PASSWORD, FPV_E2E_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data.toString(); });
  const ready = await new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    const onData = data => {
      stdout += data.toString();
      const match = stdout.match(/READY (http:\/\/[^ ]+) ([^\r\n]+)/);
      if (match) { child.stdout.off("data", onData); resolveReady({ url: match[1], epoch: match[2] }); }
    };
    child.stdout.on("data", onData);
    child.once("error", rejectReady);
    child.once("exit", code => rejectReady(new Error(`Fixture Hub exited before ready (${code}). ${stderr}`)));
  });
  async function stop() {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolveExit => child.once("exit", resolveExit)),
      wait(2500)
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return { ...ready, child, stop, getStderr: () => stderr };
}

async function requestJson(url, options, scenario, expectedStatus = 200) {
  let response;
  try { response = await fetch(url, options); }
  catch (error) { fail("TRANSPORT_FAILURE", scenario, `HTTP request to ${url} failed.`, "response", error.message); }
  let body;
  try { body = await response.json(); }
  catch (error) { fail("PROTOCOL_SCHEMA_ERROR", scenario, `HTTP response from ${url} was not JSON.`, "JSON body", error.message); }
  if (response.status !== expectedStatus) fail("PROTOCOL_SCHEMA_ERROR", scenario, `HTTP ${response.status} from ${url}.`, expectedStatus, { status: response.status, body });
  return body;
}

async function inject(hubUrl, snapshot, scenario) {
  return requestJson(`${hubUrl}/api/v1/test/snapshot`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-event-write-password": PASSWORD },
    body: JSON.stringify(snapshot)
  }, scenario);
}

async function currentQueue(snapshot, scenario) {
  try { return projectHubSnapshot(snapshot); }
  catch (error) { fail("PROTOCOL_SCHEMA_ERROR", scenario, "Public Hub snapshot could not be validated by the consumer.", "valid v1 snapshot", error.message); }
}

async function assertPublicSnapshot(hubUrl, snapshot, scenario) {
  const body = await requestJson(`${hubUrl}/api/v1/snapshot`, { headers: { accept: "application/json" } }, scenario);
  let publicSnapshot;
  try { publicSnapshot = validateHubSnapshot(body); }
  catch (error) { fail("PROTOCOL_SCHEMA_ERROR", scenario, "GET /api/v1/snapshot violates the v1 contract.", "valid v1 snapshot", error.message); }
  expectEqual(publicSnapshot.snapshotId, snapshot.snapshotId, "public snapshot ID", scenario, "PROTOCOL_SCHEMA_ERROR");
  expectEqual(publicSnapshot.eventSessionId, EVENT_SESSION_ID, "public event session", scenario, "PROTOCOL_SCHEMA_ERROR");
  const status = await requestJson(`${hubUrl}/api/v1/status`, { headers: { accept: "application/json" } }, scenario);
  expectEqual(status.raceStatus, publicSnapshot.races[publicSnapshot.schedule.currentIndex]?.status ?? null, "Hub status race status", scenario, "PROTOCOL_SCHEMA_ERROR");
  expectEqual(status.quality, publicSnapshot.quality.state, "Hub status quality", scenario, "PROTOCOL_SCHEMA_ERROR");
  return publicSnapshot;
}

async function driveControlDesk(controlDesk, snapshot, { connection = "connected" } = {}) {
  const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
  controlDesk.app.onSourceState({
    connection,
    snapshot: structuredClone(snapshot),
    raceStatus: current?.status || null,
    lastDataAt: Date.now(),
    sourceCapturedAt: snapshot.capturedAt,
    error: "",
    announcements: snapshot.activeAnnouncements,
    quality: snapshot.quality.state
  });
  await Promise.resolve();
}

async function assertControlDesk(controlDesk, snapshot, expectedView, scenario) {
  const document = controlDesk.document;
  const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
  expectEqual(document.getElementById("eventName").textContent, EVENT.name, "Control Desk event name", scenario);
  expectEqual(document.getElementById("viewLabel").textContent, expectedView, "Control Desk view label", scenario);
  const displayedTitle = document.getElementById("raceTitle").textContent;
  expectTrue(displayedTitle.includes(String(current.heat.number)) && displayedTitle.includes(String(current.heat.count)), "Control Desk round/heat title", scenario);
  expectTrue(document.getElementById("raceState").textContent.startsWith(current.status === "unknown" ? "UNKNOWN" : current.status.toUpperCase()), "Control Desk race status", scenario);
  const expectedQueueCount = Math.min(3, 1 + snapshot.schedule.nextRaceIds.length + (snapshot.schedule.afterNextRaceIds?.length || 0));
  expectEqual(document.getElementById("heatQueue").children.length, expectedQueueCount, "Control Desk queue slot count", scenario);
  expectTrue(displayedTitle !== "—", "Control Desk selected race title", scenario);
}

async function compareLiveTimeQue(hubUrl, snapshot, scenario, liveTimeQueRoot) {
  if (!liveTimeQueRoot) return;
  const modulePath = join(liveTimeQueRoot, "public", "backend.mjs");
  let module;
  try { module = await import(pathToFileURL(modulePath).href); }
  catch (error) { fail("PROTOCOL_SCHEMA_ERROR", scenario, "LiveTimeQue public HubBackend could not be loaded.", "public backend module", error.message); }
  if (typeof module.HubBackend !== "function") fail("PROTOCOL_SCHEMA_ERROR", scenario, "LiveTimeQue public HubBackend export is missing.", "HubBackend", Object.keys(module));
  let queueState;
  try { queueState = await new module.HubBackend(hubUrl, fetch).getQueueState(snapshot.event.id, "acceptance-pilot"); }
  catch (error) { fail("TRANSPORT_FAILURE", scenario, "LiveTimeQue could not read the public Hub snapshot.", "queue state", error.message); }
  const current = queueState.races[queueState.currentIndex] || null;
  const nextId = queueState.schedule?.nextRaceIds?.[0] || null;
  const next = queueState.races.find(race => race.id === nextId) || null;
  const expected = await currentQueue(snapshot, scenario);
  expectEqual(current?.id || null, expected.current?.id || null, "LiveTimeQue Current", scenario);
  expectEqual(next?.id || null, expected.staging?.id || null, "LiveTimeQue Next", scenario);
  expectEqual(current?.status || null, expected.current?.status || null, "LiveTimeQue Current status", scenario);
}

async function readSseUntil(response, predicate, scenario, timeoutMs = 2500) {
  const reader = response.body?.getReader();
  if (!reader) fail("TRANSPORT_FAILURE", scenario, "Hub stream returned no readable body.", "ReadableStream", null);
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  try {
    while (Date.now() < deadline) {
      const timeout = wait(Math.max(1, deadline - Date.now())).then(() => ({ timeout: true }));
      const result = await Promise.race([reader.read(), timeout]);
      if (result.timeout) fail("TRANSPORT_FAILURE", scenario, "Timed out reading the Hub SSE stream.", "matching SSE event", false);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); }
        catch (error) { fail("PROTOCOL_SCHEMA_ERROR", scenario, "Hub SSE data was not JSON.", "JSON event envelope", error.message); }
        try { validateHubSnapshot(event.type === "snapshot" ? event.data : undefined); }
        catch (error) {
          if (event.type === "snapshot") fail("PROTOCOL_SCHEMA_ERROR", scenario, "Hub SSE snapshot envelope violates the v1 contract.", "valid snapshot envelope", error.message);
        }
        if (predicate(event)) return event;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  fail("TRANSPORT_FAILURE", scenario, "Matching Hub SSE event was not observed.", "matching event", false);
}

export async function runAcceptance({ quiet = false, liveTimeQueRoot = process.env.LIVETIME_QUE_ROOT || join(ROOT, "..", "LiveTimeQue") } = {}) {
  const previousQuiet = globalThis.__raceDayAcceptanceQuiet;
  globalThis.__raceDayAcceptanceQuiet = quiet;
  const scenarios = createScenarios();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "race-day-acceptance-"));
  const statePath = join(temporaryDirectory, "trusted.json");
  const first = await startFixture({ statePath, epoch: "acceptance-epoch-1" });
  let second = null;
  let client = null;
  let reloadedClient = null;
  const controlDesk = createControlDesk(first.url);
  try {
    await controlDesk.start();

    await runScenario("initial staging", async () => {
      await inject(first.url, scenarios.staging, "initial staging");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.staging, "initial staging");
      await driveControlDesk(controlDesk, snapshot);
      await assertControlDesk(controlDesk, snapshot, "Current Heat", "initial staging");
      await compareLiveTimeQue(first.url, snapshot, "initial staging", await directoryIfExists(liveTimeQueRoot));
    });

    const storage = memoryStorage();
    client = new RaceDataHubClient({ hubUrl: first.url, EventSourceImpl: FetchEventSource, storage });
    expectTrue(await client.connect(), "Control Desk Hub client bootstrap", "client bootstrap", "TRANSPORT_FAILURE");
    await waitFor(() => client.getState().snapshot?.snapshotId === scenarios.staging.snapshotId, "Hub client staging snapshot", "client bootstrap");

    await runScenario("running", async () => {
      await inject(first.url, scenarios.running, "running");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.running, "running");
      await waitFor(() => client.getState().snapshot?.snapshotId === snapshot.snapshotId, "running snapshot over SSE", "running");
      await driveControlDesk(controlDesk, snapshot);
      await assertControlDesk(controlDesk, snapshot, "Current Heat", "running");
      await compareLiveTimeQue(first.url, snapshot, "running", await directoryIfExists(liveTimeQueRoot));
    });

    await runScenario("complete current", async () => {
      await inject(first.url, scenarios.complete, "complete current");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.complete, "complete current");
      await waitFor(() => client.getState().snapshot?.snapshotId === snapshot.snapshotId, "complete snapshot over SSE", "complete current");
      await driveControlDesk(controlDesk, snapshot);
      await assertControlDesk(controlDesk, snapshot, "Current Heat", "complete current");
      expectEqual((await currentQueue(snapshot, "complete current")).current.status, "complete", "Current semantic status", "complete current");
      await compareLiveTimeQue(first.url, snapshot, "complete current", await directoryIfExists(liveTimeQueRoot));
    });

    await runScenario("valid Next Up", async () => {
      await inject(first.url, scenarios.validNextUp, "valid Next Up");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.validNextUp, "valid Next Up");
      const queue = await currentQueue(snapshot, "valid Next Up");
      expectEqual(queue.staging?.id, "q2", "valid Next Up identity", "valid Next Up");
      expectTrue(["scheduled", "staging", "running"].includes(queue.staging?.status), "valid Next Up status", "valid Next Up");
      await waitFor(() => client.getState().snapshot?.snapshotId === snapshot.snapshotId, "valid Next Up over SSE", "valid Next Up");
      await compareLiveTimeQue(first.url, snapshot, "valid Next Up", await directoryIfExists(liveTimeQueRoot));
    });

    await runScenario("missing or late Next Up", async () => {
      await inject(first.url, scenarios.missingNextUp, "missing or late Next Up");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.missingNextUp, "missing or late Next Up");
      const queue = await currentQueue(snapshot, "missing or late Next Up");
      expectEqual(queue.staging, null, "missing Next Up does not invent a race", "missing or late Next Up");
      await waitFor(() => client.getState().snapshot?.snapshotId === snapshot.snapshotId, "missing Next Up over SSE", "missing or late Next Up");
      await driveControlDesk(controlDesk, snapshot);
      expectEqual(controlDesk.document.getElementById("cycleStatus").textContent, "Cycle off", "cycle state without Next Up", "missing or late Next Up");
      await compareLiveTimeQue(first.url, snapshot, "missing or late Next Up", await directoryIfExists(liveTimeQueRoot));
    });

    await runScenario("complete-to-Next-Up cycle with independent durations", async () => {
      await inject(first.url, scenarios.cycle, "complete-to-Next-Up cycle");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.cycle, "complete-to-Next-Up cycle");
      await compareLiveTimeQue(first.url, snapshot, "complete-to-Next-Up cycle", await directoryIfExists(liveTimeQueRoot));
      await driveControlDesk(controlDesk, snapshot);
      controlDesk.app.updateProfile({ cycle: { enabled: true, completeSeconds: 2, nextUpSeconds: 3 } });
      expectEqual(controlDesk.app.cycleController.getState().phase, "complete", "cycle initial phase", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      expectEqual(controlDesk.app.cycleController.getState().view, "current", "cycle initial view", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      expectEqual(controlDesk.document.getElementById("cycleStatus").textContent, "Complete for 2s", "cycle duration label", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      await wait(2150);
      expectEqual(controlDesk.app.cycleController.getState().phase, "next-up", "cycle second phase", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      expectEqual(controlDesk.app.cycleController.getState().view, "next", "cycle second view", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      expectEqual(controlDesk.document.getElementById("viewLabel").textContent, "Next Up", "Control Desk cycle view", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      await wait(3150);
      expectEqual(controlDesk.app.cycleController.getState().phase, "complete", "cycle independent return phase", "complete-to-Next-Up cycle", "CYCLE_PHASE_VIEW_MISMATCH");
      controlDesk.app.updateProfile({ cycle: { enabled: false } });
    });

    await runScenario("heat and round changes including Mains", async () => {
      await inject(first.url, scenarios.heatChange, "heat and round changes");
      const heat = await assertPublicSnapshot(first.url, scenarios.heatChange, "heat and round changes");
      await waitFor(() => client.getState().snapshot?.snapshotId === heat.snapshotId, "heat change over SSE", "heat and round changes");
      await driveControlDesk(controlDesk, heat);
      await assertControlDesk(controlDesk, heat, "Current Heat", "heat and round changes");
      await compareLiveTimeQue(first.url, heat, "heat and round changes", await directoryIfExists(liveTimeQueRoot));
      await inject(first.url, scenarios.mains, "Mains round change");
      const mains = await assertPublicSnapshot(first.url, scenarios.mains, "Mains round change");
      await waitFor(() => client.getState().snapshot?.snapshotId === mains.snapshotId, "Mains snapshot over SSE", "Mains round change");
      await driveControlDesk(controlDesk, mains);
      await assertControlDesk(controlDesk, mains, "Current Heat", "Mains round change");
      expectTrue(controlDesk.document.getElementById("raceTitle").textContent.includes("1") && controlDesk.document.getElementById("raceTitle").textContent.includes("8"), "Control Desk exposes Mains round", "Mains round change");
      await compareLiveTimeQue(first.url, mains, "Mains round change", await directoryIfExists(liveTimeQueRoot));
    });

    await runScenario("announcement delivery and clear", async () => {
      const announcement = await requestJson(`${first.url}/api/v1/announcements`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-event-write-password": PASSWORD }, body: JSON.stringify({ title: "Channels changed", body: "MainPilot moved to L6.", importance: 3, createdByDeviceId: "acceptance-runner" }) }, "announcement create", 201);
      await waitFor(() => client.getState().announcements.some(item => item.announcementId === announcement.announcementId), "announcement over SSE", "announcement create");
      const withAnnouncement = { ...client.getState().snapshot, activeAnnouncements: client.getState().announcements };
      await driveControlDesk(controlDesk, withAnnouncement);
      expectEqual(controlDesk.document.getElementById("hubAnnouncements").children.length, 1, "Control Desk announcement count", "announcement create");
      const clear = await requestJson(`${first.url}/api/v1/announcements/${encodeURIComponent(announcement.announcementId)}/clear`, { method: "POST", headers: { accept: "application/json", "x-event-write-password": PASSWORD } }, "announcement clear");
      expectEqual(clear.status, "cleared", "announcement clear response", "announcement clear");
      await waitFor(() => client.getState().announcements.length === 0, "announcement clear over SSE", "announcement clear");
      await driveControlDesk(controlDesk, { ...client.getState().snapshot, activeAnnouncements: [] });
      expectEqual(controlDesk.document.getElementById("hubAnnouncements").children.length, 1, "Control Desk empty announcement notice", "announcement clear");
    });

    await runScenario("stale and unknown source data", async () => {
      await inject(first.url, scenarios.staleUnknown, "stale and unknown source data");
      const snapshot = await assertPublicSnapshot(first.url, scenarios.staleUnknown, "stale and unknown source data");
      expectEqual(snapshot.quality.state, "stale", "stale quality state", "stale and unknown source data");
      expectEqual(snapshot.races.find(race => race.id === "m1").status, "unknown", "unknown source race status", "stale and unknown source data");
      await waitFor(() => client.getState().snapshot?.snapshotId === snapshot.snapshotId, "stale snapshot over SSE", "stale and unknown source data");
      controlDesk.app.updateProfile({ cycle: { enabled: true } });
      await driveControlDesk(controlDesk, snapshot, { connection: "reconnecting" });
      await assertControlDesk(controlDesk, snapshot, "Current Heat", "stale and unknown source data");
      expectEqual(controlDesk.document.getElementById("cycleStatus").textContent, "Waiting for fresh race data", "cycle stale guard", "stale and unknown source data", "CYCLE_PHASE_VIEW_MISMATCH");
      expectTrue(controlDesk.document.getElementById("sourceChip").textContent.includes("reconnecting · stale"), "Control Desk stale source indicator", "stale and unknown source data");
      await compareLiveTimeQue(first.url, snapshot, "stale and unknown source data", await directoryIfExists(liveTimeQueRoot));
      controlDesk.app.updateProfile({ cycle: { enabled: false } });
    });

    await runScenario("schema and authorization diagnostics", async () => {
      await requestJson(`${first.url}/api/v1/test/snapshot`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-event-write-password": "wrong-password" }, body: JSON.stringify(scenarios.recovered) }, "unauthorized injection", 401);
      const invalid = await requestJson(`${first.url}/api/v1/test/snapshot`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-event-write-password": PASSWORD }, body: JSON.stringify({ format: "invalid" }) }, "invalid injection", 400);
      expectTrue(String(invalid.error).includes("test snapshot rejected"), "invalid snapshot rejection diagnostic", "invalid injection", "PROTOCOL_SCHEMA_ERROR");
    });

    await runScenario("transport failure, reload, epoch reset, and recovery", async () => {
      const beforeStop = client.getState();
      client.close();
      await first.stop();
      let failed = false;
      try { await fetch(`${first.url}/api/v1/snapshot`); }
      catch { failed = true; }
      expectTrue(failed, "stopped Hub produces a transport failure", "transport failure", "TRANSPORT_FAILURE");
      second = await startFixture({ statePath, epoch: "acceptance-epoch-2" });
      const restored = await assertPublicSnapshot(second.url, scenarios.staleUnknown, "reload restored snapshot");
      expectEqual(restored.snapshotId, scenarios.staleUnknown.snapshotId, "reloaded snapshot identity", "reload restored snapshot");
      expectEqual(restored.quality.state, "stale", "reloaded quality", "reload restored snapshot");
      const resetResponse = await fetch(`${second.url}/api/v1/stream`, { headers: { accept: "text/event-stream", "last-event-id": String(beforeStop.streamSequence), "x-hub-epoch": beforeStop.hubEpoch || "acceptance-epoch-1", "x-event-session-id": EVENT_SESSION_ID } });
      const reset = await readSseUntil(resetResponse, event => event.type === "reset", "epoch reset");
      expectEqual(reset.data.reason, "epoch_changed", "epoch reset reason", "epoch reset", "PROTOCOL_SCHEMA_ERROR");
      reloadedClient = new RaceDataHubClient({ hubUrl: second.url, EventSourceImpl: FetchEventSource, storage });
      expectTrue(await reloadedClient.connect(), "reloaded client bootstrap", "reload client", "TRANSPORT_FAILURE");
      expectEqual(reloadedClient.getState().snapshot?.snapshotId, scenarios.staleUnknown.snapshotId, "reloaded consumer snapshot", "reload client");
      await inject(second.url, scenarios.recovered, "fresh recovery");
      await waitFor(() => reloadedClient.getState().snapshot?.snapshotId === scenarios.recovered.snapshotId, "fresh snapshot after reload", "fresh recovery");
      await compareLiveTimeQue(second.url, scenarios.recovered, "fresh recovery", await directoryIfExists(liveTimeQueRoot));
    });

    logLine("PASS  deterministic race-day acceptance completed", "green");
    return { ok: true, hubUrl: second?.url || first.url, liveTimeQueCompared: Boolean(await directoryIfExists(liveTimeQueRoot)) };
  } catch (error) {
    const details = error instanceof AcceptanceFailure ? `\nExpected: ${json(error.details.expected)}\nObserved: ${json(error.details.observed)}` : "";
    logLine(`FAIL  ${error.message}${details}`, "red");
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure("SEMANTIC_MISMATCH", "runner", error.message, "successful acceptance", error.stack);
  } finally {
    client?.close();
    reloadedClient?.close();
    controlDesk.restore();
    await second?.stop();
    await first.stop();
    await rm(temporaryDirectory, { recursive: true, force: true });
    globalThis.__raceDayAcceptanceQuiet = previousQuiet;
  }
}

async function directoryIfExists(directory) {
  try { return (await readFile(join(directory, "package.json"), "utf8")) ? directory : null; }
  catch { return null; }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { await runAcceptance(); }
  catch (error) {
    if (!(error instanceof AcceptanceFailure)) logLine(`FAIL  ${error.stack || error}`, "red");
    process.exitCode = 1;
  }
}
