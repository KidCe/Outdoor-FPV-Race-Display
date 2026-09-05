export const RACE_DAY_PROFILE_FORMAT = "org.fpv.race-display.profile";
export const RACE_DAY_PROFILE_VERSION = 1;

const DEFAULT_CHANNEL_COLORS = {
  R1: "#ffffff", R2: "#ff3030", R3: "#ff7a00", R4: "#ffe600",
  R5: "#18d95b", R6: "#2554ff", R7: "#9c4dff", R8: "#ff28d7",
  F2: "#ffe600", F4: "#18d95b", L6: "#ff7a00", L7: "#00e8ff"
};

const DEFAULT_PRESETS = {
  current: {
    label: "Current Heat", headerStyle: "over-under", headerFrame: "inward",
    headerTextColor: "#ffffff", headerFrameColor: "#48e6b5", lineThickness: 1,
    font: "5x7", fontScale: 1
  },
  staging: {
    label: "Staging Heat", headerStyle: "double", headerFrame: "upward",
    headerTextColor: "#fff1a6", headerFrameColor: "#ffd15c", lineThickness: 2,
    font: "5x7", fontScale: 1
  },
  next: {
    label: "Next Up", headerStyle: "overline", headerFrame: "right-single",
    headerTextColor: "#c5ebff", headerFrameColor: "#4fc8ff", lineThickness: 1,
    font: "5x7", fontScale: 1
  }
};

export const DEFAULT_RACE_DAY_PROFILE = Object.freeze({
  format: RACE_DAY_PROFILE_FORMAT,
  version: RACE_DAY_PROFILE_VERSION,
  source: {
    connectorUrl: "",
    eventUrl: "https://rotormaniacs.livefpv.com/",
    enabled: false,
    reconcileSeconds: 30
  },
  output: {
    enabled: false,
    live: false,
    transport: "wireless",
    wledUrl: "http://192.168.0.201/",
    serialBaud: 115200,
    schemaId: "fpv-race-80x80-v2",
    brightness: 50,
    backgroundEffect: 0
  },
  display: {
    width: 80,
    height: 80,
    bodyFont: "5x7",
    bodyScale: 1,
    rowGap: 1,
    headerGap: 2,
    channelWidth: 2,
    channelGap: 1,
    pilotWidth: 15,
    backgroundColor: "#000000",
    pilotTextColor: "#ffffff",
    presets: DEFAULT_PRESETS,
    channelColors: DEFAULT_CHANNEL_COLORS
  },
  cycle: {
    enabled: false,
    seconds: 5
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return clone(base);
  const result = clone(base);
  for (const [key, value] of Object.entries(candidate)) {
    if (!(key in result)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = merge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;
}

export function migrateLegacyProfile(storage) {
  try {
    const display = JSON.parse(storage?.getItem("fpv-race-wled-display-v2") || "null");
    const connector = JSON.parse(storage?.getItem("fpv-race-event-connector-v1") || "null");
    if (!display && !connector) return null;
    const migrated = clone(DEFAULT_RACE_DAY_PROFILE);
    if (connector) {
      migrated.source.connectorUrl = connector.connectorUrl || migrated.source.connectorUrl;
      migrated.source.eventUrl = connector.sourceUrl || migrated.source.eventUrl;
      migrated.source.enabled = Boolean(connector.autoRefresh);
    }
    if (display) {
      migrated.output.transport = display.transport === "usb" ? "usb" : "wireless";
      migrated.output.wledUrl = display.wledUrl || migrated.output.wledUrl;
      migrated.output.serialBaud = Number(display.serialBaud) || migrated.output.serialBaud;
      migrated.output.schemaId = display.schemaId || migrated.output.schemaId;
      migrated.output.brightness = Number(display.displayBrightness ?? migrated.output.brightness);
      migrated.output.backgroundEffect = Number(display.backgroundEffect ?? migrated.output.backgroundEffect);
      migrated.output.enabled = Boolean(display.outputEnabled);
      migrated.output.live = Boolean(display.liveSend);
      const current = migrated.display.presets.current;
      current.headerStyle = display.headerStyle || current.headerStyle;
      current.headerFrame = ["inward", "upward", "right-single", "right-double", "none"].includes(display.headerFrame) ? display.headerFrame : current.headerFrame;
      current.headerTextColor = display.headerColor || current.headerTextColor;
      current.headerFrameColor = display.headerColor || current.headerFrameColor;
      current.lineThickness = Number(display.headerFrameThickness) || current.lineThickness;
      migrated.display.backgroundColor = display.backgroundColor || migrated.display.backgroundColor;
      migrated.display.rowGap = Number(display.gap ?? migrated.display.rowGap);
      migrated.display.headerGap = Number(display.headerGap ?? migrated.display.headerGap);
      for (let index = 0; index < 8; index += 1) {
        const channel = String(display[`ch${index}`] || "").toUpperCase();
        if (channel && display[`cc${index}`]) migrated.display.channelColors[channel] = display[`cc${index}`];
      }
    }
    return validateRaceDayProfile(migrated);
  } catch { return null; }
}

export function validateRaceDayProfile(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("Profile must be a JSON object.");
  if (candidate.format !== RACE_DAY_PROFILE_FORMAT) throw new Error("Unsupported race-day profile format.");
  if (candidate.version !== RACE_DAY_PROFILE_VERSION) throw new Error("Unsupported race-day profile version.");
  const profile = merge(DEFAULT_RACE_DAY_PROFILE, candidate);
  profile.source.connectorUrl = String(profile.source.connectorUrl || "").trim();
  profile.source.eventUrl = String(profile.source.eventUrl || "").trim();
  profile.source.enabled = Boolean(profile.source.enabled);
  profile.source.reconcileSeconds = boundedNumber(profile.source.reconcileSeconds, 30, 10, 300);
  profile.output.enabled = Boolean(profile.output.enabled);
  profile.output.live = Boolean(profile.output.live);
  profile.output.transport = profile.output.transport === "usb" ? "usb" : "wireless";
  profile.output.wledUrl = String(profile.output.wledUrl || "").trim();
  profile.output.serialBaud = boundedNumber(profile.output.serialBaud, 115200, 9600, 921600);
  profile.output.schemaId = String(profile.output.schemaId || "fpv-race-80x80-v2").slice(0, 24);
  profile.output.brightness = boundedNumber(profile.output.brightness, 50, 0, 100);
  profile.output.backgroundEffect = boundedNumber(profile.output.backgroundEffect, 0, 0, 25);
  profile.cycle.enabled = Boolean(profile.cycle.enabled);
  profile.cycle.seconds = boundedNumber(profile.cycle.seconds, 5, 2, 60);
  profile.display.width = boundedNumber(profile.display.width, 80, 16, 255);
  profile.display.height = boundedNumber(profile.display.height, 80, 16, 255);
  profile.display.bodyScale = boundedNumber(profile.display.bodyScale, 1, 1, 3);
  profile.display.rowGap = boundedNumber(profile.display.rowGap, 1, 0, 1);
  profile.display.headerGap = boundedNumber(profile.display.headerGap, 2, 0, 2);
  profile.display.channelWidth = boundedNumber(profile.display.channelWidth, 2, 1, 5);
  profile.display.channelGap = boundedNumber(profile.display.channelGap, 1, 0, 4);
  profile.display.pilotWidth = boundedNumber(profile.display.pilotWidth, 15, 4, 30);
  profile.display.backgroundColor = validColor(profile.display.backgroundColor, "#000000");
  profile.display.pilotTextColor = validColor(profile.display.pilotTextColor, "#ffffff");
  for (const key of ["current", "staging", "next"]) {
    const preset = profile.display.presets[key];
    preset.headerStyle = ["none", "overline", "underline", "over-under", "double"].includes(preset.headerStyle) ? preset.headerStyle : DEFAULT_PRESETS[key].headerStyle;
    preset.headerFrame = ["none", "inward", "upward", "right-single", "right-double"].includes(preset.headerFrame) ? preset.headerFrame : DEFAULT_PRESETS[key].headerFrame;
    preset.headerTextColor = validColor(preset.headerTextColor, DEFAULT_PRESETS[key].headerTextColor);
    preset.headerFrameColor = validColor(preset.headerFrameColor, DEFAULT_PRESETS[key].headerFrameColor);
    preset.lineThickness = boundedNumber(preset.lineThickness, DEFAULT_PRESETS[key].lineThickness, 1, 3);
    preset.font = ["3x5", "5x7"].includes(preset.font) ? preset.font : "5x7";
    preset.fontScale = 1;
  }
  for (const [channel, color] of Object.entries(profile.display.channelColors)) {
    profile.display.channelColors[channel.toUpperCase()] = validColor(color, "#ffffff");
  }
  return profile;
}

export class LocalProfileStorage {
  constructor({ key = "fpv-race-day-profile-v1", storage = globalThis.localStorage } = {}) {
    this.key = key;
    this.storage = storage;
  }
  load() {
    try {
      const raw = this.storage?.getItem(this.key);
      return raw ? JSON.parse(raw) : migrateLegacyProfile(this.storage);
    } catch { return null; }
  }
  save(profile) {
    try { this.storage?.setItem(this.key, JSON.stringify(profile)); } catch {}
  }
}

export class MemoryProfileStorage {
  constructor(value = null) { this.value = value ? clone(value) : null; }
  load() { return this.value ? clone(this.value) : null; }
  save(profile) { this.value = clone(profile); }
}

export class RaceDayProfile {
  constructor({ storage = new LocalProfileStorage() } = {}) {
    this.storage = storage;
    this.profile = validateRaceDayProfile(storage.load() || DEFAULT_RACE_DAY_PROFILE);
  }
  get() { return clone(this.profile); }
  update(patch) {
    this.profile = validateRaceDayProfile(merge(this.profile, patch));
    this.storage.save(this.profile);
    return this.get();
  }
  importJson(text) {
    const imported = validateRaceDayProfile(JSON.parse(text));
    this.profile = imported;
    this.storage.save(imported);
    return this.get();
  }
  exportJson() { return `${JSON.stringify(this.profile, null, 2)}\n`; }
  reset() {
    this.profile = validateRaceDayProfile(DEFAULT_RACE_DAY_PROFILE);
    this.storage.save(this.profile);
    return this.get();
  }
}
