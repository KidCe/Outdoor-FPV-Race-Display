import { DisplayScene, projectRaceSchedule } from "./display-scene.js";
import { OutputSession } from "./output-session.js";
import { RaceDayProfile } from "./race-day-profile.js";
import { RaceSourceRuntime } from "./race-source-runtime.js";
import { isValidNextUpRace, MatrixCycleController } from "./matrix-cycle.js";
import { ANNOUNCEMENT_DISPLAY_MS } from "./race-data-hub-client.js";
import { mapRaceStatus, raceStatusLabel } from "./race-status.js";

const byId = id => document.getElementById(id);
const VIEW_LABELS = { current: "Current Heat", staging: "Next Up", next: "After Next" };

export function projectCycleScene(sceneModule, snapshot, selectedView, cycleState) {
  if (!cycleState?.active) return sceneModule.project(snapshot, selectedView);
  return cycleState.view === "next"
    ? sceneModule.projectMatrix(snapshot, "next-up")
    : sceneModule.project(snapshot, "current");
}
const PRESET_LABELS = { current: "Current Heat", staging: "Staging Heat", next: "Next Up" };
const CHANNEL_ORDER = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "F2", "F4", "L6", "L7"];

function elapsed(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "No data";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s ago`;
}

function download(name, type, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setDot(element, kind) { element.className = `dot ${kind || ""}`; }

function isHttpUrl(value) {
  try { return ["http:", "https:"].includes(new URL(String(value || "").trim()).protocol); } catch { return false; }
}

function isLiveFPVUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return isHttpUrl(url.href) && !url.username && !url.password && !url.hash && /(?:^|\.)livefpv\.com$/i.test(url.hostname);
  } catch { return false; }
}

function textElement(tagName, className, value) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

export class RaceDayAppHost {
  constructor() {
    this.profileStore = new RaceDayProfile();
    this.profile = this.profileStore.get();
    if (["http://localhost:4174", "http://127.0.0.1:4174"].includes(this.profile.source.connectorUrl.replace(/\/$/, ""))) {
      this.profile = this.profileStore.update({ source: { connectorUrl: "" } });
    }
    const requestedHub = new URLSearchParams(globalThis.location?.search || "").get("hub");
    if (requestedHub) {
      try {
        const hubUrl = new URL(requestedHub);
        if (["http:", "https:"].includes(hubUrl.protocol)) this.profile = this.profileStore.update({ source: { mode: "hub", hubUrl: hubUrl.href.replace(/\/$/, ""), enabled: true } });
      } catch {}
    }
    this.sceneModule = new DisplayScene(this.profile);
    this.sourceRuntime = new RaceSourceRuntime({ onState: state => this.onSourceState(state) });
    this.outputSession = new OutputSession({ onState: state => this.onOutputState(state) });
    this.sourceState = this.sourceRuntime.getState();
    this.outputState = this.outputSession.getState();
    this.selectedView = "current";
    this.selectedPreset = "current";
    this.currentScene = null;
    this.lastReadback = null;
    this.started = false;
    this.cycleController = new MatrixCycleController({
      onViewChange: () => {
        if (this.started) queueMicrotask(() => this.renderAll());
      }
    });
    this.announcementTimers = new Map();
    this.hiddenAnnouncements = new Set();
  }

  async start() {
    this.started = true;
    this.renderChannelMap();
    this.fillControls();
    this.bindEvents();
    this.configureModules();
    this.renderAll();
    setInterval(() => this.renderStatus(), 1000);
    if (this.profile.source.enabled) await this.sourceRuntime.setEnabled(true);
    // Set the desired live mode before the display handshake completes. The
    // first trusted scene can then be installed and published automatically
    // as soon as the display is ready after a page reload.
    this.outputSession.setLive(this.profile.output.live);
    if (this.profile.output.enabled) await this.outputSession.setEnabled(true);
  }

  configureModules() {
    this.sourceRuntime.configure({ ...this.profile.source, connectorUrl: this.profile.source.connectorUrl || globalThis.location.origin, sourceUrl: this.profile.source.eventUrl });
    this.outputSession.configure(this.profile.output);
  }

  updateProfile(patch) {
    this.profile = this.profileStore.update(patch);
    this.sceneModule.setProfile(this.profile);
    this.configureModules();
    this.fillControls();
    this.renderAll();
    this.publishScene();
  }

  onSourceState(state) {
    this.sourceState = state;
    this.renderAnnouncements(state.announcements || []);
    this.renderAll();
  }

  renderAnnouncements(announcements) {
    const container = byId("hubAnnouncements");
    if (!container) return;
    const activeIds = new Set(announcements.map(announcement => announcement.announcementId));
    for (const id of this.hiddenAnnouncements) if (!activeIds.has(id)) this.hiddenAnnouncements.delete(id);
    for (const [id, timer] of this.announcementTimers) if (!activeIds.has(id)) { clearTimeout(timer); this.announcementTimers.delete(id); }
    container.replaceChildren();
    const visible = announcements.filter(announcement => announcement.importance === 3 || !this.hiddenAnnouncements.has(announcement.announcementId));
    if (!visible.length) { container.innerHTML = '<p class="notice">No active announcements.</p>'; return; }
    for (const announcement of visible) {
      const item = document.createElement("article");
      item.className = `hub-announcement importance-${announcement.importance}${announcement.importance === 3 ? " persistent" : ""}`;
      item.innerHTML = "<strong></strong><p></p><small></small>";
      item.querySelector("strong").textContent = announcement.title;
      item.querySelector("p").textContent = announcement.body;
      item.querySelector("small").textContent = announcement.importance === 3 ? "Persistent until cleared" : announcement.importance === 2 ? "Time-limited notification" : "Short notification";
      container.append(item);
      if (announcement.importance !== 3 && !this.announcementTimers.has(announcement.announcementId)) {
        const timer = setTimeout(() => { this.hiddenAnnouncements.add(announcement.announcementId); this.announcementTimers.delete(announcement.announcementId); this.renderAnnouncements(this.sourceState.announcements || []); }, ANNOUNCEMENT_DISPLAY_MS[announcement.importance]);
        this.announcementTimers.set(announcement.announcementId, timer);
      }
    }
  }

  onOutputState(state) {
    this.outputState = state;
    this.renderStatus();
  }

  renderAll() {
    this.configureCycle();
    const snapshot = this.sourceState.snapshot;
    if (!snapshot) {
      this.currentScene = null;
      this.renderWaitingPreview();
      const sourceName = this.profile.source.mode === "hub" ? "Race Data Hub" : "LiveTime";
      byId("heatQueue").replaceChildren(textElement("p", "notice", `Enable the ${sourceName} source to load the current and upcoming heats.`));
      byId("pilotList").replaceChildren(textElement("p", "notice", "No pilot data loaded."));
      byId("eventName").textContent = `Waiting for a ${sourceName} event`;
      byId("viewLabel").textContent = "No active heat";
      byId("raceTitle").textContent = "—";
      byId("raceState").textContent = this.sourceState.error || "Waiting for trusted data";
      this.renderStatus();
      return;
    }
    if (snapshot.schedule?.currentRaceId === null) {
      this.currentScene = null;
      this.renderWaitingPreview();
      byId("heatQueue").replaceChildren(textElement("p", "notice", "No active heat is selected by the Race Data Hub."));
      byId("pilotList").replaceChildren(textElement("p", "notice", "No pilot data loaded."));
      byId("eventName").textContent = snapshot.event?.name || "No active event";
      byId("viewLabel").textContent = "No active heat";
      byId("raceTitle").textContent = "—";
      byId("raceState").textContent = snapshot.quality?.state === "stale" ? "No active heat · stale Hub data" : "No active heat";
      this.renderStatus();
      return;
    }
    try {
      const cycleState = this.cycleController.getState();
      this.currentScene = projectCycleScene(this.sceneModule, snapshot, this.selectedView, cycleState);
      if (!this.currentScene.race) {
        this.renderWaitingPreview();
        byId("viewLabel").textContent = VIEW_LABELS[this.selectedView];
        byId("raceTitle").textContent = "—";
        byId("raceState").textContent = `${VIEW_LABELS[this.selectedView]} is not available from the trusted schedule`;
        this.renderPilots([]);
        this.renderHeatQueue(this.currentScene.schedule);
        this.publishScene();
        this.renderStatus();
        return;
      }
      this.sceneModule.render(byId("matrixPreview"), this.currentScene);
      const schema = this.sceneModule.getSchema();
      byId("eventName").textContent = this.currentScene.race.eventName;
      byId("viewLabel").textContent = cycleState.active ? (cycleState.view === "next" ? "Next Up" : "Current Heat") : VIEW_LABELS[this.selectedView];
      byId("raceTitle").textContent = `${this.currentScene.race.round} · ${this.currentScene.race.heat}`;
      byId("raceState").textContent = `${this.currentScene.race.statusLabel} · ${this.currentScene.race.pilots.length} pilots`;
      byId("previewFit").textContent = `${schema.canvas.width}×${schema.canvas.height} · ${schema.nodes.length}/40 nodes`;
      byId("schemaHash").textContent = `Schema ${schema.schemaHash}`;
      this.renderPilots(this.currentScene.race.pilots);
      this.renderHeatQueue(projectRaceSchedule(snapshot, this.profile, { limit: 3 }));
      this.publishScene();
    } catch (error) {
      byId("sessionMessage").textContent = `Scene rejected: ${error.message}`;
      byId("sessionMessage").className = "session-message notice error";
    }
    this.renderStatus();
  }

  renderWaitingPreview() {
    const canvas = byId("matrixPreview");
    canvas.width = 480;
    canvas.height = 480;
    const context = canvas.getContext("2d");
    context.fillStyle = "#000";
    context.fillRect(0, 0, 480, 480);
    context.fillStyle = "#5e686e";
    context.font = "bold 19px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("WAITING FOR RACE DATA", 240, 232);
    context.font = "14px ui-monospace, monospace";
    context.fillText("LAST TRUSTED DATA WILL STAY VISIBLE", 240, 262);
    byId("previewFit").textContent = "No trusted scene";
    byId("schemaHash").textContent = `Schema ${this.sceneModule.getSchema().schemaHash}`;
  }

  renderPilots(pilots) {
    const container = byId("pilotList");
    container.replaceChildren();
    if (!pilots.length) { container.append(textElement("p", "notice", "No pilots assigned to this heat.")); return; }
    for (const pilot of pilots) {
      const row = textElement("div", "pilot-row");
      const channel = textElement("span", "pilot-channel", pilot.channel || "—");
      channel.style.color = pilot.color || "";
      row.append(channel, textElement("span", "pilot-name", pilot.callsign), textElement("span", "pilot-frequency", pilot.frequencyMHz ?? "—"));
      container.append(row);
    }
  }

  renderHeatQueue(schedule) {
    const labels = ["Current", "Next one", "After that"];
    const container = byId("heatQueue");
    container.replaceChildren();
    for (const [index, race] of schedule.entries()) {
      const view = index === 0 ? "current" : index === 1 ? "staging" : "next";
      const button = textElement("button", `heat-block${this.selectedView === view ? " active" : ""}`);
      button.type = "button";
      button.dataset.queueView = view;
      const kicker = textElement("span", "heat-block-kicker");
      kicker.append(textElement("span", "", labels[index] || "Upcoming"), textElement("span", "", raceStatusLabel(race)));
      const title = textElement("h3", "", race ? `${race.round} · ${race.heat}` : "—");
      const pilotList = textElement("span", "mini-pilots");
      if (!race) {
        pilotList.append(textElement("span", "mini-pilot", "No trusted schedule entry"));
      } else if (race.pilots.length) {
        for (const pilot of race.pilots) {
          const miniPilot = textElement("span", "mini-pilot");
          const channel = textElement("b", "", pilot.channel || "—");
          channel.style.color = pilot.color || "";
          miniPilot.append(channel, textElement("span", "", pilot.callsign));
          pilotList.append(miniPilot);
        }
      } else {
        pilotList.append(textElement("span", "mini-pilot", "No pilots assigned"));
      }
      button.append(kicker, title, pilotList);
      container.append(button);
    }
  }

  publishScene() {
    if (!this.currentScene) return;
    const schema = this.sceneModule.getSchema();
    const values = this.sceneModule.getState(this.currentScene);
    void this.outputSession.publish(schema, values);
  }

  renderStatus() {
    if (this.cycleController.tick() && this.started) queueMicrotask(() => this.renderAll());
    const source = this.sourceState;
    const output = this.outputState;
    const sourceName = this.profile.source.mode === "hub" ? "Race Data Hub" : "LiveTime";
    byId("sourceLabel").textContent = sourceName;
    const sourceKind = source.connection === "connected" ? "ok" : source.connection === "reconnecting" || source.connection === "degraded" || source.snapshot ? "warn" : source.connection === "error" ? "error" : "";
    setDot(byId("sourceDot"), sourceKind);
    byId("sourceChip").textContent = `${source.connection}${source.quality && source.quality !== "unknown" ? ` · ${source.quality}` : ""}`;
    const outputKind = output.connection === "connected" ? "ok" : output.connection === "reconnecting" || output.connection === "connecting" ? "warn" : output.connection === "error" ? "error" : "";
    setDot(byId("outputDot"), outputKind);
    byId("outputChip").textContent = output.connection;
    setDot(byId("liveDot"), output.controlling ? "ok" : this.profile.output.live ? "warn" : "");
    byId("liveChip").textContent = output.controlling ? "active" : this.profile.output.live ? "waiting" : "off";
    const ageReference = source.sourceCapturedAt ? Date.parse(source.sourceCapturedAt) : source.lastDataAt;
    const ageMs = ageReference ? Date.now() - ageReference : NaN;
    byId("sourceAge").textContent = elapsed(ageMs);
    byId("transportLabel").textContent = this.profile.output.transport === "usb" ? "USB serial" : "Wireless WLED";
    byId("schemaState").textContent = output.schema || (["connecting", "reconnecting"].includes(output.connection) ? "Checking…" : "Not installed");
    byId("lastDisplayUpdate").textContent = output.lastUpdateAt ? elapsed(Date.now() - output.lastUpdateAt) : "Never";
    byId("sessionMessage").textContent = source.error ? `${sourceName}: ${source.error} Last trusted data remains visible. ${output.message}` : output.message;
    byId("sessionMessage").className = `session-message${source.error || output.connection === "error" ? " notice error" : ""}`;
    byId("stopClear").disabled = output.connection !== "connected";
    byId("readFrame").disabled = output.connection !== "connected";
    const sourceReady = source.connection === "connected" || source.connection === "reconnecting" || source.connection === "degraded";
    byId("sourceControlStatus").textContent = !this.profile.source.enabled
      ? "Source disabled. Enter a URL and click Accept URL & connect."
      : `${sourceName} ${sourceReady ? "selected" : "connection"}: ${source.connection}.`;
    byId("sourceControlStatus").className = `notice${source.connection === "error" ? " error" : source.connection === "connected" ? "" : " warn"}`;
    const stale = Number.isFinite(ageMs) && ageMs >= 120000;
    byId("app").classList.toggle("stale", stale);
    if (stale) byId("sourceAge").textContent += ageMs >= 600000 ? " · stale" : " · delayed";
  }

  selectView(view) {
    this.selectedView = view;
    document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
    this.renderAll();
  }

  configureCycle() {
    const snapshot = this.sourceState.snapshot;
    const current = snapshot?.races?.find(race => race?.id === snapshot.schedule?.currentRaceId) || null;
    const next = snapshot?.races?.find(race => race?.id === snapshot.schedule?.nextRaceIds?.[0]) || null;
    const fresh = this.sourceState.quality === "fresh";
    const wasActive = this.cycleController.getState().active;
    const nextIsValid = isValidNextUpRace(current, next);
    const cycleState = this.cycleController.update({
      enabled: this.profile.cycle.enabled && fresh,
      current,
      next,
      completeSeconds: this.profile.cycle.completeSeconds,
      nextUpSeconds: this.profile.cycle.nextUpSeconds
    });
    const currentStatus = mapRaceStatus(current?.status);
    if (wasActive && fresh && ["staging", "running"].includes(currentStatus)) {
      this.selectedView = "current";
      document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === "current"));
    }
    if (!byId("cycleStatus")) return;
    if (!this.profile.cycle.enabled) byId("cycleStatus").textContent = "Cycle off";
    else if (!fresh) byId("cycleStatus").textContent = "Waiting for fresh race data";
    else if (currentStatus !== "complete") byId("cycleStatus").textContent = "Waiting for a completed current heat";
    else if (!nextIsValid) byId("cycleStatus").textContent = "Waiting for a valid Next Up heat";
    else byId("cycleStatus").textContent = `${cycleState.phase === "next-up" ? "Next Up" : "Complete"} for ${cycleState.delay / 1000}s`;
  }

  fillControls() {
    const { source, output, cycle, display } = this.profile;
    byId("sourceEnabled").checked = source.enabled;
    byId("sourceMode").value = source.mode;
    byId("eventUrl").value = source.eventUrl;
    byId("connectorUrl").value = source.connectorUrl || globalThis.location.origin;
    byId("hubUrl").value = source.hubUrl || "";
    byId("reconcileSeconds").value = source.reconcileSeconds;
    byId("outputEnabled").checked = output.enabled;
    byId("liveOutput").checked = output.live;
    byId("transport").value = output.transport;
    byId("wledUrl").value = output.wledUrl;
    byId("serialBaud").value = String(output.serialBaud);
    byId("schemaId").value = output.schemaId;
    byId("brightness").value = output.brightness;
    byId("brightnessValue").textContent = `${output.brightness}%`;
    byId("cycleEnabled").checked = cycle.enabled;
    byId("completeSeconds").value = cycle.completeSeconds;
    byId("nextUpSeconds").value = cycle.nextUpSeconds;
    byId("headerGap").value = display.headerGap;
    byId("headerGapValue").textContent = `${display.headerGap}px`;
    byId("rowGap").value = display.rowGap;
    byId("rowGapValue").textContent = `${display.rowGap}px`;
    this.fillPresetControls();
  }

  fillPresetControls() {
    const preset = this.profile.display.presets[this.selectedPreset];
    byId("headerStyle").value = preset.headerStyle;
    byId("headerFrame").value = preset.headerFrame;
    byId("headerTextColor").value = preset.headerTextColor;
    byId("headerFrameColor").value = preset.headerFrameColor;
    byId("lineThickness").value = preset.lineThickness;
    byId("lineThicknessValue").textContent = `${preset.lineThickness}px`;
    byId("headerFont").value = preset.font;
    byId("presetNote").textContent = `Editing ${PRESET_LABELS[this.selectedPreset]}`;
    document.querySelectorAll("[data-preset]").forEach(button => button.classList.toggle("active", button.dataset.preset === this.selectedPreset));
  }

  renderChannelMap() {
    byId("channelColorMap").innerHTML = CHANNEL_ORDER.map(channel => `<label class="field">${channel}<input type="color" data-channel="${channel}"></label>`).join("");
    document.querySelectorAll("[data-channel]").forEach(input => { input.value = this.profile.display.channelColors[input.dataset.channel] || "#ffffff"; });
  }

  bindEvents() {
    document.addEventListener("click", event => {
      const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-queue-view]")?.dataset.queueView;
      if (view) this.selectView(view);
      const preset = event.target.closest("[data-preset]")?.dataset.preset;
      if (preset) { this.selectedPreset = preset; this.fillPresetControls(); }
    });
    byId("sourceEnabled").addEventListener("change", async event => { await this.sourceRuntime.setEnabled(event.target.checked); this.updateProfile({ source: { enabled: event.target.checked } }); });
    byId("sourceMode").addEventListener("change", async event => { await this.sourceRuntime.setEnabled(false); this.updateProfile({ source: { mode: event.target.value, enabled: false } }); });
    byId("sourceConnect").addEventListener("click", async () => {
      const mode = byId("sourceMode").value;
      const eventUrl = byId("eventUrl").value.trim();
      const hubUrl = byId("hubUrl").value.trim();
      if (mode === "hub" && !isHttpUrl(hubUrl)) { byId("sourceControlStatus").textContent = "Enter a complete HTTP(S) Race Data Hub URL first."; byId("sourceControlStatus").className = "notice error"; return; }
      if (mode === "live" && !isLiveFPVUrl(eventUrl)) { byId("sourceControlStatus").textContent = "Enter a complete LiveFPV organization URL first."; byId("sourceControlStatus").className = "notice error"; return; }
      await this.sourceRuntime.setEnabled(false);
      this.updateProfile({ source: { mode, eventUrl, hubUrl, enabled: true } });
      await this.sourceRuntime.setEnabled(true);
      this.renderStatus();
    });
    byId("sourceDisconnect").addEventListener("click", async () => { await this.sourceRuntime.setEnabled(false); this.updateProfile({ source: { enabled: false } }); });
    byId("clearTrustedData").addEventListener("click", () => this.sourceRuntime.clearTrustedSnapshot());
    byId("outputEnabled").addEventListener("change", async event => {
      const enabled = event.target.checked;
      if (!enabled) {
        await this.outputSession.setEnabled(false);
        this.updateProfile({ output: { enabled: false } });
        return;
      }
      this.updateProfile({ output: { enabled: true } });
      await this.outputSession.setEnabled(true, { interactive: true });
    });
    byId("outputConnect").addEventListener("click", async () => { try { this.updateProfile({ output: { enabled: true } }); if (this.outputSession.enabled) await this.outputSession.reconnect(); else await this.outputSession.setEnabled(true, { interactive: true }); } catch (error) { byId("sessionMessage").textContent = `Display connection failed: ${error.message}`; } });
    byId("outputDisconnect").addEventListener("click", async () => { await this.outputSession.setEnabled(false); this.updateProfile({ output: { enabled: false } }); });
    byId("liveOutput").addEventListener("change", event => { this.updateProfile({ output: { live: event.target.checked } }); this.outputSession.setLive(event.target.checked); });
    for (const [id, key, number] of [["eventUrl", "eventUrl"], ["connectorUrl", "connectorUrl"], ["hubUrl", "hubUrl"], ["reconcileSeconds", "reconcileSeconds", true]]) byId(id).addEventListener("change", event => this.updateProfile({ source: { [key]: number ? Number(event.target.value) : event.target.value } }));
    for (const [id, key, number] of [["transport", "transport"], ["wledUrl", "wledUrl"], ["serialBaud", "serialBaud", true], ["schemaId", "schemaId"], ["brightness", "brightness", true]]) byId(id).addEventListener("input", event => this.updateProfile({ output: { [key]: number ? Number(event.target.value) : event.target.value } }));
    byId("cycleEnabled").addEventListener("change", event => { this.updateProfile({ cycle: { enabled: event.target.checked } }); this.configureCycle(); });
    for (const id of ["completeSeconds", "nextUpSeconds"]) byId(id).addEventListener("change", event => { this.updateProfile({ cycle: { [id]: Number(event.target.value) } }); this.configureCycle(); });
    for (const [id, key, number] of [["headerStyle", "headerStyle"], ["headerFrame", "headerFrame"], ["headerTextColor", "headerTextColor"], ["headerFrameColor", "headerFrameColor"], ["lineThickness", "lineThickness", true], ["headerFont", "font"]]) byId(id).addEventListener("input", event => this.updateProfile({ display: { presets: { [this.selectedPreset]: { [key]: number ? Number(event.target.value) : event.target.value } } } }));
    for (const [id, key] of [["headerGap", "headerGap"], ["rowGap", "rowGap"]]) byId(id).addEventListener("input", event => this.updateProfile({ display: { [key]: Number(event.target.value) } }));
    byId("channelColorMap").addEventListener("input", event => { const channel = event.target.dataset.channel; if (channel) this.updateProfile({ display: { channelColors: { [channel]: event.target.value } } }); });
    byId("installSchema").addEventListener("click", async () => { try { const schema = this.sceneModule.getSchema(); await this.outputSession.installSchema(schema); if (this.currentScene) await this.outputSession.publish(schema, this.sceneModule.getState(this.currentScene)); } catch (error) { byId("sessionMessage").textContent = error.message; } });
    byId("exportSchema").addEventListener("click", () => { const schema = this.sceneModule.getSchema(); download(`${schema.schemaId}-${schema.schemaHash}.json`, "application/json", `${JSON.stringify(schema, null, 2)}\n`); });
    byId("exportProfile").addEventListener("click", () => download("fpv-race-day-profile.json", "application/json", this.profileStore.exportJson()));
    byId("importProfile").addEventListener("change", async event => { const file = event.target.files?.[0]; if (!file) return; try { this.profile = this.profileStore.importJson(await file.text()); await this.applyWholeProfile(); } catch (error) { byId("sessionMessage").textContent = `Profile import failed: ${error.message}`; } finally { event.target.value = ""; } });
    byId("resetProfile").addEventListener("click", async () => { this.profile = this.profileStore.reset(); await this.applyWholeProfile(); });
    byId("stopClear").addEventListener("click", async () => { this.updateProfile({ output: { live: false } }); this.outputSession.setLive(false); await this.outputSession.deactivate().catch(() => {}); });
    byId("readFrame").addEventListener("click", () => void this.captureFrame());
    byId("downloadFrame").addEventListener("click", () => { if (!this.lastReadback) return; const link = document.createElement("a"); link.download = `fpv-display-frame-${Date.now()}.png`; link.href = byId("readbackCanvas").toDataURL("image/png"); link.click(); });
  }

  async applyWholeProfile() {
    this.sceneModule.setProfile(this.profile);
    this.configureModules();
    this.outputSession.setLive(this.profile.output.live);
    await Promise.all([this.sourceRuntime.setEnabled(this.profile.source.enabled), this.outputSession.setEnabled(this.profile.output.enabled)]);
    this.renderChannelMap();
    this.fillControls();
    this.renderAll();
  }

  async captureFrame() {
    const button = byId("readFrame");
    button.disabled = true;
    byId("frameStatus").textContent = "Reading the displayed frame…";
    try {
      const frame = await this.outputSession.readFrame(byId("frameSource").value);
      this.lastReadback = frame;
      const canvas = byId("readbackCanvas");
      canvas.hidden = false;
      canvas.width = frame.width;
      canvas.height = frame.height;
      const context = canvas.getContext("2d");
      const image = context.createImageData(frame.width, frame.height);
      for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
        image.data[pixel * 4] = frame.pixels[pixel * 3]; image.data[pixel * 4 + 1] = frame.pixels[pixel * 3 + 1]; image.data[pixel * 4 + 2] = frame.pixels[pixel * 3 + 2]; image.data[pixel * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      byId("frameStatus").textContent = `Captured ${frame.width}×${frame.height} from ${byId("frameSource").value}; ${frame.lit} lit pixels.`;
      byId("downloadFrame").disabled = false;
    } catch (error) { byId("frameStatus").textContent = `Pixel readback failed: ${error.message}`; }
    finally { button.disabled = this.outputState.connection !== "connected"; }
  }
}

export function createRaceDayApp() {
  return new RaceDayAppHost();
}

if (typeof document !== "undefined") {
  const app = createRaceDayApp();
  void app.start();
}
