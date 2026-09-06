import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DisplayScene } from "../web/display-scene.js";
import { MemoryProfileStorage, RaceDayProfile } from "../web/race-day-profile.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
const firmware = readProjectFile("wled/usermods/fpv_race_display/fpv_race_display.cpp");
const rendererHeader = readProjectFile("wled/usermods/fpv_race_display/fpv_renderer.h");
const rendererSource = readProjectFile("wled/usermods/fpv_race_display/fpv_renderer.cpp");
const sceneHeader = readProjectFile("wled/usermods/fpv_race_display/fpv_scene.h");
const webUi = readProjectFile("web/fpv-race-wled-80x80.html");
const webApp = readProjectFile("web/race-day-app.js");
const fixture = JSON.parse(readProjectFile("contracts/race-event/v1/fixtures/snapshot-fresh.json"));

const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
const display = new DisplayScene(profile);
const schema = display.getSchema();
const scene = display.project(fixture, "current");
const values = display.getState(scene);
const viewStates = ["current", "staging", "next"].map(view => ({ view, values: display.getState(display.project(fixture, view)) }));
const changed = structuredClone(fixture);
changed.snapshotId = "display-controls-check:changed";
changed.races[0].label = "Qualifier (Heat 18/24) — corrected";
changed.races[0].pilots[0].callsign = "PilotOneCorrected";
const changedDisplay = new DisplayScene(structuredClone(profile));
changedDisplay.project(changed, "current");
const changedSchema = changedDisplay.getSchema();
const bindings = new Set(schema.nodes.map(node => node.bind).filter(Boolean));

if (process.env.FPV_SCHEMA_OUTPUT) {
  fs.writeFileSync(process.env.FPV_SCHEMA_OUTPUT, `${JSON.stringify(schema, null, 2)}\n`);
}

const checks = [
  [schema.canvas.width === 80 && schema.canvas.height === 80, "display schema must target the 80x80 matrix"],
  [schema.nodes.length <= 40, "display schema must stay within the 40-node device limit"],
  [schema.nodes.every(node => !Object.prototype.hasOwnProperty.call(node, "text")), "race text must remain state-bound instead of changing schema geometry"],
  [["header-current", "group-current", "header-staging", "group-staging", "header-next", "group-next", ...Array.from({ length: 8 }, (_, index) => `ch${index}`), ...Array.from({ length: 8 }, (_, index) => `pn${index}`)].every(binding => bindings.has(binding)), "schema must expose all semantic header and pilot bindings"],
  [values.length === 23 && values.filter(value => value.visible).length === 2, "display state must select one semantic preset header and frame"],
  [changedSchema.schemaHash === schema.schemaHash, "race text and pilot changes must not reinstall the layout schema"],
  [viewStates.every(({ view, values: viewValues }) => { const visible = viewValues.filter(value => value.visible).map(value => value.key).sort(); return (view === "next" && visible.length === 0) || JSON.stringify(visible) === JSON.stringify([`group-${view}`, `header-${view}`].sort()); }), "all semantic views must select only their own header and frame"],
  [firmware.includes("strip.fill(_scene.background)"), "exclusive mode must clear the final WLED framebuffer"],
  [firmware.includes("strip.setPixelColor(index, color_fade(strip.getPixelColorNoMap(index), retained, true))"), "overlay mode must dim the final WLED framebuffer"],
  [firmware.includes("frame.begin") && firmware.includes("frame.chunk") && firmware.includes("BusManager::getPixelColor(strip.getMappedPixelIndex(index))"), "firmware must expose mapped HUB75 frame readback"],
  [firmware.includes('command.containsKey("brightness")') && firmware.includes('command.containsKey("backgroundEffect")'), "state protocol must accept display controls"],
  [rendererHeader.includes("bool drawBackground") && rendererSource.includes("motionOffset"), "renderer must own background composition and motion"],
  [sceneHeader.includes("enum class Motion") && sceneHeader.includes("parseMotion"), "schema parser must support generic node motion"],
  [webUi.includes('id="brightness"') && webUi.includes('id="backgroundEffect"') && webUi.includes('id="readFrame"'), "WebUI must expose output controls and displayed-pixel readback"],
  [webUi.includes('type="module" src="./web/race-day-app.js"'), "WebUI must load the current modular control desk"],
  [webApp.includes("Stop & clear display") || webUi.includes("Stop &amp; clear display"), "control desk must expose the safe stop-and-clear action"],
  [profile.output.brightness === 50 && profile.output.backgroundEffect === 0, "first-run output defaults must be safe"],
  [profile.display.backgroundColor === "#000000", "first-run display background must be black"],
  [scene.race?.id === fixture.schedule.currentRaceId && values.some(value => value.key === "ch0"), "fixture projection must produce a current race state"],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(failures.map(message => `FAIL: ${message}`).join("\n"));
  process.exit(1);
}

console.log(`FPV display controls verified (${checks.length} checks).`);
