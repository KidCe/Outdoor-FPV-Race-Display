import { DisplayScene, projectRaceSchedule } from "./display-scene.js";
import { OutputSession } from "./output-session.js";
import { RaceDayProfile } from "./race-day-profile.js";
import { RaceSourceRuntime } from "./race-source-runtime.js";

const byId = id => document.getElementById(id);
const VIEW_LABELS = { current: "Current Heat", staging: "Next Up", next: "After Next" };
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

export class RaceDayAppHost {
  constructor() {
    this.profileStore = new RaceDayProfile();
    this.profile = this.profileStore.get();
    if (["http://localhost:4174", "http://127.0.0.1:4174"].includes(this.profile.source.connectorUrl.replace(/\/$/, ""))) {
      this.profile = this.profileStore.update({ source: { connectorUrl: "" } });
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
    this.cycleTimer = 0;
    this.cycleTicker = 0;
    this.nextCycleAt = 0;
  }

  async start() {
    this.renderChannelMap();
    this.fillControls();
    this.bindEvents();
    this.configureModules();
    this.renderAll();
    this.configureCycle();
    setInterval(() => this.renderStatus(), 1000);
    if (this.profile.source.enabled) await this.sourceRuntime.setEnabled(true);
    if (this.profile.output.enabled) await this.outputSession.setEnabled(true);
    this.outputSession.setLive(this.profile.output.live);
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
    this.renderAll();
  }

  onOutputState(state) {
    this.outputState = state;
    this.renderStatus();
  }

  renderAll() {
    const snapshot = this.sourceState.snapshot;
    if (!snapshot) {
      this.currentScene = null;
      this.renderWaitingPreview();
      byId("heatQueue").innerHTML = '<p class="notice">Enable the LiveTime source to load the current and upcoming heats.</p>';
      byId("pilotList").innerHTML = '<p class="notice">No pilot data loaded.</p>';
      byId("eventName").textContent = "Waiting for a LiveTime event";
      byId("viewLabel").textContent = "No active heat";
      byId("raceTitle").textContent = "—";
      byId("raceState").textContent = this.sourceState.error || "Waiting for trusted data";
      this.renderStatus();
      return;
    }
    try {
      this.currentScene = this.sceneModule.project(snapshot, this.selectedView);
      this.sceneModule.render(byId("matrixPreview"), this.currentScene);
      const schema = this.sceneModule.getSchema();
      byId("eventName").textContent = this.currentScene.race.eventName;
      byId("viewLabel").textContent = VIEW_LABELS[this.selectedView];
      byId("raceTitle").textContent = `${this.currentScene.race.round} · ${this.currentScene.race.heat}`;
      byId("raceState").textContent = `${this.currentScene.race.status} · ${this.currentScene.race.pilots.length} pilots`;
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
    this.configureCycle();
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
    context.fillText("WAITING FOR LIVETIME", 240, 232);
    context.font = "14px ui-monospace, monospace";
    context.fillText("LAST TRUSTED DATA WILL STAY VISIBLE", 240, 262);
    byId("previewFit").textContent = "No trusted scene";
    byId("schemaHash").textContent = `Schema ${this.sceneModule.getSchema().schemaHash}`;
  }

  renderPilots(pilots) {
    byId("pilotList").innerHTML = pilots.length ? pilots.map(pilot => `<div class="pilot-row"><span class="pilot-channel" style="color:${pilot.color}">${pilot.channel || "—"}</span><span class="pilot-name">${pilot.callsign}</span><span class="pilot-frequency">${pilot.frequencyMHz || "—"}</span></div>`).join("") : '<p class="notice">No pilots assigned to this heat.</p>';
  }

  renderHeatQueue(schedule) {
    const labels = ["Current", "Next one", "After that"];
    byId("heatQueue").innerHTML = schedule.map((race, index) => `<button class="heat-block ${this.selectedView === (index === 0 ? "current" : index === 1 ? "staging" : "next") ? "active" : ""}" type="button" data-queue-view="${index === 0 ? "current" : index === 1 ? "staging" : "next"}"><span class="heat-block-kicker"><span>${labels[index]}</span><span>${race.status}</span></span><h3>${race.round} · ${race.heat}</h3><span class="mini-pilots">${race.pilots.map(pilot => `<span class="mini-pilot"><b style="color:${pilot.color}">${pilot.channel || "—"}</b>${pilot.callsign}</span>`).join("") || '<span class="mini-pilot">No pilots assigned</span>'}</span></button>`).join("");
  }

  publishScene() {
    if (!this.currentScene) return;
    const schema = this.sceneModule.getSchema();
    const values = this.sceneModule.getState(this.currentScene);
    void this.outputSession.publish(schema, values);
  }

  renderStatus() {
    const source = this.sourceState;
    const output = this.outputState;
    const sourceKind = source.connection === "connected" ? "ok" : source.connection === "reconnecting" || source.connection === "degraded" || source.snapshot ? "warn" : source.connection === "error" ? "error" : "";
    setDot(byId("sourceDot"), sourceKind);
    byId("sourceChip").textContent = source.connection;
    const outputKind = output.connection === "connected" ? "ok" : output.connection === "reconnecting" || output.connection === "connecting" ? "warn" : output.connection === "error" ? "error" : "";
    setDot(byId("outputDot"), outputKind);
    byId("outputChip").textContent = output.connection;
    setDot(byId("liveDot"), output.controlling ? "ok" : this.profile.output.live ? "warn" : "");
    byId("liveChip").textContent = output.controlling ? "active" : this.profile.output.live ? "waiting" : "off";
    const ageMs = source.lastDataAt ? Date.now() - source.lastDataAt : NaN;
    byId("sourceAge").textContent = elapsed(ageMs);
    byId("transportLabel").textContent = this.profile.output.transport === "usb" ? "USB serial" : "Wireless WLED";
    byId("schemaState").textContent = output.schema || "Not installed";
    byId("lastDisplayUpdate").textContent = output.lastUpdateAt ? elapsed(Date.now() - output.lastUpdateAt) : "Never";
    byId("sessionMessage").textContent = source.error ? `LiveTime: ${source.error} Last trusted data remains visible. ${output.message}` : output.message;
    byId("sessionMessage").className = `session-message${source.error || output.connection === "error" ? " notice error" : ""}`;
    byId("stopClear").disabled = output.connection !== "connected";
    byId("readFrame").disabled = output.connection !== "connected";
    const stale = Number.isFinite(ageMs) && ageMs >= 120000;
    byId("app").classList.toggle("stale", stale);
    if (stale) byId("sourceAge").textContent += ageMs >= 600000 ? " · stale" : " · delayed";
  }

  selectView(view, { fromCycle = false } = {}) {
    this.selectedView = view;
    document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
    if (!fromCycle) this.nextCycleAt = Date.now() + this.profile.cycle.seconds * 1000;
    this.renderAll();
  }

  configureCycle() {
    clearTimeout(this.cycleTimer);
    clearInterval(this.cycleTicker);
    const firstRace = this.currentScene?.schedule?.[0];
    const hasNext = this.currentScene?.schedule?.length > 1;
    if (!this.profile.cycle.enabled) { byId("cycleStatus").textContent = "Cycle off"; return; }
    if (firstRace?.status !== "racing") { byId("cycleStatus").textContent = "Waiting for current heat to run"; return; }
    if (!hasNext) { byId("cycleStatus").textContent = "Waiting for next heat"; return; }
    const milliseconds = this.profile.cycle.seconds * 1000;
    this.nextCycleAt = Date.now() + milliseconds;
    const updateCountdown = () => { byId("cycleStatus").textContent = `Switch in ${Math.max(1, Math.ceil((this.nextCycleAt - Date.now()) / 1000))}s`; };
    updateCountdown();
    this.cycleTicker = setInterval(updateCountdown, 250);
    this.cycleTimer = setTimeout(() => this.selectView(this.selectedView === "current" ? "staging" : "current", { fromCycle: true }), milliseconds);
  }

  fillControls() {
    const { source, output, cycle, display } = this.profile;
    byId("sourceEnabled").checked = source.enabled;
    byId("eventUrl").value = source.eventUrl;
    byId("connectorUrl").value = source.connectorUrl || globalThis.location.origin;
    byId("reconcileSeconds").value = source.reconcileSeconds;
    byId("outputEnabled").checked = output.enabled;
    byId("liveOutput").checked = output.live;
    byId("transport").value = output.transport;
    byId("wledUrl").value = output.wledUrl;
    byId("serialBaud").value = String(output.serialBaud);
    byId("schemaId").value = output.schemaId;
    byId("brightness").value = output.brightness;
    byId("brightnessValue").textContent = `${output.brightness}%`;
    byId("backgroundEffect").value = output.backgroundEffect;
    byId("backgroundEffectValue").textContent = `${output.backgroundEffect}%`;
    byId("cycleEnabled").checked = cycle.enabled;
    byId("cycleSeconds").value = cycle.seconds;
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
    byId("sourceEnabled").addEventListener("change", async event => { this.updateProfile({ source: { enabled: event.target.checked } }); await this.sourceRuntime.setEnabled(event.target.checked); });
    byId("clearTrustedData").addEventListener("click", () => this.sourceRuntime.clearTrustedSnapshot());
    byId("outputEnabled").addEventListener("change", async event => { this.updateProfile({ output: { enabled: event.target.checked } }); await this.outputSession.setEnabled(event.target.checked, { interactive: true }); });
    byId("liveOutput").addEventListener("change", event => { this.updateProfile({ output: { live: event.target.checked } }); this.outputSession.setLive(event.target.checked); });
    for (const [id, key, number] of [["eventUrl", "eventUrl"], ["connectorUrl", "connectorUrl"], ["reconcileSeconds", "reconcileSeconds", true]]) byId(id).addEventListener("change", event => this.updateProfile({ source: { [key]: number ? Number(event.target.value) : event.target.value } }));
    for (const [id, key, number] of [["transport", "transport"], ["wledUrl", "wledUrl"], ["serialBaud", "serialBaud", true], ["schemaId", "schemaId"], ["brightness", "brightness", true], ["backgroundEffect", "backgroundEffect", true]]) byId(id).addEventListener("input", event => this.updateProfile({ output: { [key]: number ? Number(event.target.value) : event.target.value } }));
    byId("cycleEnabled").addEventListener("change", event => { this.updateProfile({ cycle: { enabled: event.target.checked } }); this.configureCycle(); });
    byId("cycleSeconds").addEventListener("change", event => { this.updateProfile({ cycle: { seconds: Number(event.target.value) } }); this.configureCycle(); });
    for (const [id, key, number] of [["headerStyle", "headerStyle"], ["headerFrame", "headerFrame"], ["headerTextColor", "headerTextColor"], ["headerFrameColor", "headerFrameColor"], ["lineThickness", "lineThickness", true], ["headerFont", "font"]]) byId(id).addEventListener("input", event => this.updateProfile({ display: { presets: { [this.selectedPreset]: { [key]: number ? Number(event.target.value) : event.target.value } } } }));
    for (const [id, key] of [["headerGap", "headerGap"], ["rowGap", "rowGap"]]) byId(id).addEventListener("input", event => this.updateProfile({ display: { [key]: Number(event.target.value) } }));
    byId("channelColorMap").addEventListener("input", event => { const channel = event.target.dataset.channel; if (channel) this.updateProfile({ display: { channelColors: { [channel]: event.target.value } } }); });
    byId("installSchema").addEventListener("click", async () => { try { await this.outputSession.installSchema(this.sceneModule.getSchema()); } catch (error) { byId("sessionMessage").textContent = error.message; } });
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

const app = new RaceDayAppHost();
void app.start();
