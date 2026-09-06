import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DisplayScene, normalize5x7Text } from "../web/display-scene.js";
import { OutputSession } from "../web/output-session.js";
import { MemoryProfileStorage, RaceDayProfile } from "../web/race-day-profile.js";

async function loadSnapshot() {
  return JSON.parse(await fs.readFile(new URL("../contracts/race-event/v1/fixtures/snapshot-fresh.json", import.meta.url), "utf8"));
}

function captureCanvas() {
  const textCalls = [];
  const context = {
    imageSmoothingEnabled: false,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    fillRect() {},
    save() {},
    scale() {},
    fillText(text) { textCalls.push(String(text)); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    restore() {}
  };
  return { width: 0, height: 0, getContext: () => context, textCalls };
}

test("5x7 display projection renders the supplied Turkish names as ASCII in preview and output", async () => {
  const snapshot = await loadSnapshot();
  snapshot.races[0].pilots[0].callsign = "EDIZ KüLLüOğLU";
  snapshot.races[0].pilots[1].callsign = "SADıK HüSEYIN YıLDıZ";
  const sourceBeforeProjection = structuredClone(snapshot);
  const display = new DisplayScene(new RaceDayProfile({ storage: new MemoryProfileStorage() }).get());
  const scene = display.project(snapshot, "current");

  const values = display.getState(scene);
  assert.equal(values.find(value => value.key === "pn0").text, "EDIZ KULLUOGLU");
  assert.equal(values.find(value => value.key === "pn1").text, "SADIK HUSEYIN YILDIZ");

  const canvas = captureCanvas();
  display.render(canvas, scene);
  assert.ok(canvas.textCalls.includes("EDIZ KULLUOGLU"));
  assert.ok(canvas.textCalls.includes("SADIK HUSEYIN YILDIZ"));

  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true, code: "ok" } })));
    }
  });
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const output = new OutputSession({ adapterFactory });
  output.configure(profile.output);
  output.setLive(true);
  await output.setEnabled(true);
  await output.publish(display.getSchema(), values);
  const emittedValues = operations.filter(command => command.op === "state").flatMap(command => command.values);
  assert.equal(emittedValues.find(value => value.key === "pn0").text, "EDIZ KULLUOGLU");
  assert.equal(emittedValues.find(value => value.key === "pn1").text, "SADIK HUSEYIN YILDIZ");
  await output.setEnabled(false);

  assert.deepEqual(snapshot, sourceBeforeProjection);
});

test("5x7 normalization keeps uppercase and lowercase case while mapping Turkish glyphs", () => {
  assert.equal(normalize5x7Text("ıİğĞşŞçÇ"), "iIgGsScC");
  assert.equal(normalize5x7Text("küllüoğlu"), "kulluoglu");
  assert.equal(normalize5x7Text("KÜLLÜOĞLU"), "KULLUOGLU");
});

test("5x7 normalization maps common Latin diacritics and sharp s", () => {
  assert.equal(normalize5x7Text("äöüÄÖÜ"), "aouAOU");
  assert.equal(normalize5x7Text("ßẞ"), "ssSS");
  assert.equal(normalize5x7Text("Æ æ Œ œ Ø ø Ł ł"), "AE ae OE oe O o L l");
});

test("5x7 normalization passes supported glyphs through and preserves future font capability", () => {
  assert.equal(normalize5x7Text("ABC xyz 012 /-:.|_+=><!?"), "ABC xyz 012 /-:.|_+=><!?");
  assert.equal(normalize5x7Text("München", { supportsGlyph: character => character === "ü" || /[A-Za-z]/.test(character) }), "München");
});

test("5x7 normalization uses a visible fallback for unsupported glyphs", () => {
  assert.equal(normalize5x7Text("A@B € 🙂"), "A?B ? ?");
});

test("5x7 output stays within the WLED text buffer after expansion", async () => {
  const snapshot = await loadSnapshot();
  snapshot.races[0].pilots[0].callsign = "ß".repeat(30);
  const sourceBeforeProjection = structuredClone(snapshot);
  const display = new DisplayScene(new RaceDayProfile({ storage: new MemoryProfileStorage() }).get());
  const scene = display.project(snapshot, "current");
  const pilotName = display.getState(scene).find(value => value.key === "pn0").text;

  assert.equal(pilotName, "S".repeat(40));
  assert.ok(pilotName.length <= 40);
  assert.match(pilotName, /^[ -~]*$/);
  assert.deepEqual(snapshot, sourceBeforeProjection);
});
