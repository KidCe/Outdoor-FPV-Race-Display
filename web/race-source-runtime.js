import { createRaceEventStreamUrl, fetchRaceEventSnapshot, validateRaceEventSnapshot } from "./race-event-connector.js";
import { RaceDataHubClient } from "./race-data-hub-client.js";

const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

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
  constructor({ adapter = new HttpRaceSourceAdapter(), hubClientFactory = options => new RaceDataHubClient(options), onState = () => {}, now = () => Date.now(), storage = globalThis.localStorage, storageKey = "fpv-race-source-trusted-v1" } = {}) {
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
    this.unsubscribeStream = null;
    this.abortController = null;
    this.storage = storage;
    this.storageKey = storageKey;
    this.state = { connection: "disabled", snapshot: null, lastDataAt: null, error: "", announcements: [], quality: "unknown" };
    this.hubClient = null;
    try {
      const cached = JSON.parse(this.storage?.getItem(this.storageKey) || "null");
      if (cached?.snapshot) {
        this.state.snapshot = validateRaceEventSnapshot(cached.snapshot);
        this.state.lastDataAt = Number(cached.lastDataAt) || null;
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
    try { this.storage?.removeItem(this.storageKey); } catch {}
    try { this.storage?.removeItem("fpv-race-hub-trusted-v1"); } catch {}
    this.hubClient?.clearTrustedSnapshot?.();
    this.setState({ snapshot: null, lastDataAt: null, sourceCapturedAt: null, announcements: [], quality: "unknown", error: this.enabled ? this.state.error : "" });
  }

  configure(config) {
    const next = {
      connectorUrl: String(config.connectorUrl || "").trim(),
      hubUrl: String(config.hubUrl || "").trim(),
      sourceUrl: String(config.sourceUrl || config.eventUrl || "").trim(),
      reconcileSeconds: Math.max(10, Number(config.reconcileSeconds) || 30)
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.config);
    this.config = next;
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
        const hub = this.hubClientFactory({ hubUrl: this.config.hubUrl, storage: this.storage, now: this.now, onState: state => { if (generation !== this.generation || !this.enabled) return; this.setState({ connection: state.connection === "live" ? "connected" : state.connection, snapshot: state.snapshot, lastDataAt: state.lastDataAt, sourceCapturedAt: state.sourceCapturedAt, error: state.error, announcements: state.announcements, quality: state.quality }); } });
        this.hubClient = hub;
        const hubState = hub.getState();
        this.setState({ connection: hubState.connection === "live" ? "connected" : hubState.connection, snapshot: hubState.snapshot, lastDataAt: hubState.lastDataAt, sourceCapturedAt: hubState.sourceCapturedAt, error: hubState.error, announcements: hubState.announcements, quality: hubState.quality });
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
    this.reconcileTimer = 0;
    this.retryTimer = 0;
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.abortController?.abort();
    this.hubClient = null;
    this.abortController = null;
    if (markDisabled) {
      this.enabled = false;
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
      this.accept(snapshot);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.setState({ connection: this.state.snapshot ? "degraded" : "error", error: error.message });
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
          try { this.accept(snapshot); } catch (error) { this.setState({ connection: "degraded", error: error.message }); }
        },
        error: error => {
          if (generation !== this.generation || !this.enabled) return;
          this.setState({ connection: this.state.snapshot ? "reconnecting" : "error", error: error.message });
          this.scheduleReconnect(generation);
        }
      });
    } catch (error) {
      this.setState({ connection: this.state.snapshot ? "reconnecting" : "error", error: error.message });
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

  accept(snapshot) {
    const trusted = validateRaceEventSnapshot(snapshot);
    this.retryAttempt = 0;
    const lastDataAt = this.now();
    try { this.storage?.setItem(this.storageKey, JSON.stringify({ snapshot: trusted, lastDataAt })); } catch {}
    this.setState({ connection: "connected", snapshot: trusted, lastDataAt, error: "" });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.getState());
  }
}
