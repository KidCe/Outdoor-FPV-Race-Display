import { validateRaceEventSnapshot } from "./race-event-connector.js";

const VIEW_ORDER = ["current", "staging", "next"];

function colorNumber(value) {
  return parseInt(String(value || "#ffffff").replace("#", ""), 16) & 0xffffff;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compactRound(value) {
  const text = String(value || "").trim();
  const qualifier = text.match(/qual(?:ifier|ifying)?(?:\s+round)?\s*(\d+)?/i);
  if (qualifier) return `Q${qualifier[1] || ""}`;
  const practice = text.match(/practice(?:\s+round)?\s*(\d+)?/i);
  if (practice) return `P${practice[1] || ""}`;
  const main = text.match(/main(?:\s+event)?\s*(\d+)?/i);
  if (main) return `M${main[1] || ""}`;
  if (/final/i.test(text)) return "F";
  return text.slice(0, 8).toUpperCase();
}

function compactHeat(race) {
  if (race?.heat) return `H${race.heat.number}/${race.heat.count}`;
  const match = String(race?.label || "").match(/(?:heat\s*)?(\d+)\s*\/\s*(\d+)/i);
  return match ? `H${match[1]}/${match[2]}` : String(race?.label || "").slice(0, 10).toUpperCase();
}

function pilotKey(pilot) {
  return String(pilot?.id || pilot?.callsign || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveVideo(races, pilot) {
  if (pilot?.video?.channel) return pilot.video;
  const key = pilotKey(pilot);
  for (const race of races) {
    const match = race.pilots?.find(candidate => pilotKey(candidate) === key && candidate.video?.channel);
    if (match) return match.video;
  }
  return pilot?.video || {};
}

function raceIdsInOrder(snapshot) {
  const ids = [
    snapshot.schedule.currentRaceId,
    ...(snapshot.schedule.nextRaceIds || []),
    ...(snapshot.schedule.afterNextRaceIds || [])
  ];
  return [...new Set(ids.filter(Boolean))];
}

export function projectRaceSchedule(snapshot, profile, { limit = 4 } = {}) {
  validateRaceEventSnapshot(snapshot);
  const ids = raceIdsInOrder(snapshot).slice(0, limit);
  return ids.map((id, index) => {
    const race = snapshot.races.find(candidate => candidate.id === id);
    if (!race) return null;
    return projectRace(snapshot, profile, race, index === 0 ? "current" : index === 1 ? "staging" : "next");
  });
}

function projectRace(snapshot, profile, race, presetKey) {
  return {
    id: race.id,
    order: race.order,
    presetKey,
    eventName: snapshot.event.name,
    round: compactRound(race.round || race.phase),
    heat: compactHeat(race),
    status: race.status || "unknown",
    label: race.label || "",
    pilots: (race.pilots || []).slice(0, 8).map(pilot => {
      const video = resolveVideo(snapshot.races, pilot);
      const channel = String(video.channel || "").toUpperCase();
      return {
        id: pilot.id || pilot.callsign,
        callsign: pilot.callsign || "OPEN",
        channel,
        frequencyMHz: video.frequencyMHz,
        color: profile.display.channelColors[channel] || "#ffffff"
      };
    })
  };
}

function addHeaderLines(nodes, key, preset, width, headerY, headerHeight) {
  const bind = `group-${key}`;
  const thickness = preset.lineThickness;
  const line = (suffix, y) => nodes.push({ id: `${key}-${suffix}`, type: "line", bind, x: 11, y, x2: width - 12, y2: y, color: 0xffffff, thickness });
  if (["overline", "over-under", "double"].includes(preset.headerStyle)) line("over", Math.max(0, headerY - 2));
  if (["underline", "over-under", "double"].includes(preset.headerStyle)) line("under", headerY + headerHeight);
  if (preset.headerStyle === "double") {
    line("over2", Math.max(0, headerY - 4));
    line("under2", headerY + headerHeight + 2);
  }
}

function arrowPoints(side, frame, width, middle, radius) {
  const left = side === "left";
  const edge = left ? 3 : width - 4;
  if (frame === "upward") return [[edge - radius, middle + radius], [edge, middle - radius], [edge + radius, middle + radius]];
  const pointsRight = frame === "right-single" || frame === "right-double" || (frame === "inward" && left);
  const first = pointsRight
    ? [[edge - radius, middle - radius], [edge, middle], [edge - radius, middle + radius]]
    : [[edge + radius, middle - radius], [edge, middle], [edge + radius, middle + radius]];
  if (frame !== "right-double") return first;
  const shift = left ? radius + 2 : -(radius + 2);
  const second = first.map(([x, y]) => [x + shift, y]);
  return [...first, ...second];
}

function addHeaderFrame(nodes, key, preset, width, headerY, headerHeight) {
  if (preset.headerFrame === "none") return;
  const bind = `group-${key}`;
  const middle = headerY + Math.floor(headerHeight / 2);
  const radius = Math.max(2, Math.floor(headerHeight / 2));
  const motion = preset.headerFrame === "upward" ? "up" : preset.headerFrame === "inward" ? "right" : "right";
  for (const side of ["left", "right"]) {
    nodes.push({
      id: `${key}-arrow-${side}`,
      type: "polyline",
      bind,
      points: arrowPoints(side, preset.headerFrame, width, middle, radius),
      color: 0xffffff,
      thickness: preset.lineThickness,
      motion: side === "right" && preset.headerFrame === "inward" ? "left" : motion,
      motionDistance: 1,
      motionPeriod: 900
    });
  }
}

export class DisplayScene {
  constructor(profile) { this.setProfile(profile); }

  setProfile(profile) {
    this.profile = profile;
    this.schema = this.compileSchema(profile);
  }

  getSchema() { return structuredClone(this.schema); }

  project(snapshot, view = "current") {
    const schedule = projectRaceSchedule(snapshot, this.profile, { limit: 4 });
    const index = view === "current" ? 0 : view === "staging" ? 1 : 2;
    const race = schedule[index] || null;
    const presetKey = VIEW_ORDER[Math.min(index, 2)];
    return {
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      quality: snapshot.quality,
      schedule,
      view,
      race: race ? { ...race, presetKey } : null,
      preset: this.profile.display.presets[presetKey],
      header: race ? `${race.round} ${race.heat}`.trim().toUpperCase() : ""
    };
  }

  getState(scene) {
    const values = [];
    const activePresetKey = scene.race?.presetKey || null;
    for (const key of VIEW_ORDER) {
      const preset = this.profile.display.presets[key];
      values.push({ key: `header-${key}`, text: scene.header, color: colorNumber(preset.headerTextColor), visible: Boolean(activePresetKey) && key === activePresetKey });
      values.push({ key: `group-${key}`, color: colorNumber(preset.headerFrameColor), visible: Boolean(activePresetKey) && key === activePresetKey });
    }
    const pilots = scene.race?.pilots || [];
    for (let index = 0; index < 8; index += 1) {
      const pilot = pilots[index];
      values.push({ key: `ch${index}`, text: pilot?.channel || "", color: colorNumber(pilot?.color || "#ffffff") });
      values.push({ key: `pn${index}`, text: String(pilot?.callsign || "").toUpperCase(), color: colorNumber(this.profile.display.pilotTextColor) });
    }
    return values;
  }

  compileSchema(profile) {
    const display = profile.display;
    const width = display.width;
    const height = display.height;
    const presets = display.presets;
    const fontMetrics = preset => preset.font === "3x5" ? { width: 3, height: 5 } : { width: 5, height: 7 };
    const maximumHeaderHeight = Math.max(...VIEW_ORDER.map(key => fontMetrics(presets[key]).height));
    const headerY = 4;
    const bottomExtra = VIEW_ORDER.some(key => presets[key].headerStyle === "double") ? 3 : VIEW_ORDER.some(key => ["underline", "over-under"].includes(presets[key].headerStyle)) ? 1 : 0;
    const bodyY = headerY + maximumHeaderHeight + bottomExtra + display.headerGap;
    this.layout = { headerY, bodyY, maximumHeaderHeight };
    const nodes = [];
    for (const key of VIEW_ORDER) {
      const preset = presets[key];
      const metrics = fontMetrics(preset);
      nodes.push({
        id: `header-${key}`, type: "text", bind: `header-${key}`,
        x: 0, y: headerY, w: width, h: metrics.height,
        fw: metrics.width, fh: metrics.height, scale: 1, align: "center", color: 0xffffff
      });
      addHeaderLines(nodes, key, preset, width, headerY, metrics.height);
      addHeaderFrame(nodes, key, preset, width, headerY, metrics.height);
    }
    const advance = 6 * display.bodyScale;
    const rowHeight = 7 * display.bodyScale;
    for (let index = 0; index < 8; index += 1) {
      const y = bodyY + index * (rowHeight + display.rowGap);
      nodes.push({ id: `ch${index}`, type: "text", bind: `ch${index}`, x: 1, y, w: display.channelWidth * advance, h: rowHeight, fw: 5, fh: 7, scale: display.bodyScale, align: "left", color: 0xffffff });
      nodes.push({ id: `pn${index}`, type: "text", bind: `pn${index}`, x: 1 + (display.channelWidth + display.channelGap) * advance, y, w: Math.max(1, width - (display.channelWidth + display.channelGap) * advance - 1), h: rowHeight, fw: 5, fh: 7, scale: display.bodyScale, align: "left", color: 0xffffff });
    }
    if (nodes.length > 40) throw new Error(`Display scene exceeds the 40-node device limit (${nodes.length}).`);
    const base = {
      format: "wled-fpv-layout",
      protocol: 1,
      schemaId: profile.output.schemaId,
      revision: 2,
      canvas: { width, height, background: colorNumber(display.backgroundColor), fps: 30 },
      nodes
    };
    return { ...base, schemaHash: fnv1a(JSON.stringify(base)) };
  }

  render(canvas, scene, { zoom = 6 } = {}) {
    const width = this.profile.display.width;
    const height = this.profile.display.height;
    canvas.width = width * zoom;
    canvas.height = height * zoom;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.fillStyle = this.profile.display.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!scene?.race) return { width, height, schemaHash: this.schema.schemaHash, nodes: this.schema.nodes.length };
    context.save();
    context.scale(zoom, zoom);
    context.textBaseline = "top";
    const previewHeaderSize = scene.preset.font === "3x5" ? 5 : 7;
    context.font = `bold ${previewHeaderSize}px "Courier New", monospace`;
    context.fillStyle = scene.preset.headerTextColor;
    context.textAlign = "center";
    context.fillText(scene.header, width / 2, this.layout.headerY, width - 18);
    context.strokeStyle = scene.preset.headerFrameColor;
    context.fillStyle = scene.preset.headerFrameColor;
    context.lineWidth = scene.preset.lineThickness;
    const top = Math.max(0, this.layout.headerY - 2);
    const bottom = this.layout.headerY + previewHeaderSize;
    if (["overline", "over-under", "double"].includes(scene.preset.headerStyle)) { context.beginPath(); context.moveTo(11, top); context.lineTo(width - 11, top); context.stroke(); }
    if (["underline", "over-under", "double"].includes(scene.preset.headerStyle)) { context.beginPath(); context.moveTo(11, bottom); context.lineTo(width - 11, bottom); context.stroke(); }
    if (scene.preset.headerStyle === "double") {
      context.beginPath(); context.moveTo(11, Math.max(0, top - 2)); context.lineTo(width - 11, Math.max(0, top - 2)); context.moveTo(11, bottom + 2); context.lineTo(width - 11, bottom + 2); context.stroke();
    }
    const arrow = scene.preset.headerFrame === "upward" ? "↑" : scene.preset.headerFrame === "right-double" ? ">>" : scene.preset.headerFrame === "right-single" ? ">" : scene.preset.headerFrame === "inward" ? ">" : "";
    if (arrow) {
      context.font = "bold 7px monospace";
      context.textAlign = "left"; context.fillText(arrow, 1, this.layout.headerY);
      context.textAlign = "right"; context.fillText(scene.preset.headerFrame === "inward" ? "<" : arrow, width - 1, this.layout.headerY);
    }
    context.font = `bold ${7 * this.profile.display.bodyScale}px "Courier New", monospace`;
    context.textAlign = "left";
    scene.race.pilots.forEach((pilot, index) => {
      const y = this.layout.bodyY + index * (7 + this.profile.display.rowGap);
      context.fillStyle = pilot.color;
      context.fillText(pilot.channel, 1, y);
      context.fillStyle = this.profile.display.pilotTextColor;
      context.fillText(pilot.callsign.toUpperCase(), 19, y, width - 20);
    });
    context.restore();
    return { width, height, schemaHash: this.schema.schemaHash, nodes: this.schema.nodes.length };
  }
}
