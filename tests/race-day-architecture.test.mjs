import test from "node:test";
import assert from "node:assert/strict";
import { DisplayScene, projectRaceSchedule } from "../web/display-scene.js";
import { LocalProfileStorage, MemoryProfileStorage, RaceDayProfile } from "../web/race-day-profile.js";
import { RaceSourceRuntime, RecordedRaceSourceAdapter } from "../web/race-source-runtime.js";
import { OutputSession } from "../web/output-session.js";

function race(id, order, heat, status, pilots) {
  return { id, order, label: `Qualifier (Heat ${heat}/3)`, phase: "Qualifier", round: "Qualifier Round 2", heat: { number: heat, count: 3 }, status, links: {}, pilots };
}

const pilots = [
  { id: "2bad", callsign: "2Bad", video: { channel: "R1", frequencyMHz: 5658 } },
  { id: "supergeek", callsign: "supergeek", video: { channel: "R3", frequencyMHz: 5732 } },
  { id: "coded", callsign: "Coded", video: { channel: "R6", frequencyMHz: 5843 } },
  { id: "bionic", callsign: "BionicButterfly", video: { channel: "R8", frequencyMHz: 5917 } }
];

const snapshot = {
  format: "org.fpv.race-event.snapshot", version: 1, snapshotId: "event:1:race-1",
  capturedAt: "2026-09-05T10:00:00.000Z", deliveredAt: "2026-09-05T10:00:01.000Z",
  event: { id: "event", name: "Forest Race Finale", sourceUrl: "https://rotormaniacs.livefpv.com/" },
  source: { provider: "LiveFPV / LiveTime", kind: "livefpv-results", revision: "1" },
  schedule: { currentRaceId: "race-1", currentIndex: 0, nextRaceIds: ["race-2", "race-3"] },
  races: [race("race-1", 0, 1, "racing", pilots), race("race-2", 1, 2, "ready", pilots.slice(0, 3)), race("race-3", 2, 3, "not-run", pilots.slice(1))],
  quality: { state: "fresh", completeRaceCount: 3, warnings: [] }
};

test("heat text and pilot changes do not change the compiled layout schema", () => {
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const before = display.getSchema().schemaHash;
  const changed = structuredClone(snapshot);
  changed.races[0].round = "Qualifier Round 12";
  changed.races[0].heat = { number: 22, count: 23 };
  changed.races[0].pilots[0].callsign = "A-Very-Different-Pilot";
  display.project(changed, "current");
  assert.equal(display.getSchema().schemaHash, before);
});

test("all three preset geometries fit the device limits", () => {
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const schema = display.getSchema();
  assert.ok(schema.nodes.length <= 40);
  assert.equal(new Set(schema.nodes.filter(node => node.bind).map(node => node.bind)).size <= 24, true);
  assert.equal(display.getState(display.project(snapshot, "current")).length <= 24, true);
  for (const node of schema.nodes) {
    if (node.points) {
      for (const [x, y] of node.points) assert.ok(x >= 0 && x < schema.canvas.width && y >= 0 && y < schema.canvas.height, `${node.id} points fit the canvas`);
    } else {
      assert.ok(node.y >= 0 && node.y < schema.canvas.height, `${node.id} y is inside the canvas`);
      if (node.h) assert.ok(node.y + node.h <= schema.canvas.height, `${node.id} height fits the canvas`);
    }
  }
});

test("the queue projection keeps current, next and after-next pilots with channels", () => {
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const schedule = projectRaceSchedule(snapshot, profile, { limit: 3 });
  assert.deepEqual(schedule.map(item => item.heat), ["H1/3", "H2/3", "H3/3"]);
  assert.deepEqual(schedule[0].pilots.map(pilot => pilot.channel), ["R1", "R3", "R6", "R8"]);
});

test("the display follows explicit schedule IDs instead of race array position", () => {
  const shuffled = structuredClone(snapshot);
  shuffled.races = [shuffled.races[2], shuffled.races[0], shuffled.races[1]];
  shuffled.schedule.currentIndex = 1;
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const schedule = projectRaceSchedule(shuffled, profile, { limit: 3 });
  assert.deepEqual(schedule.map(item => item.id), ["race-1", "race-2", "race-3"]);
});

test("a missing requested queue slot stays blank instead of duplicating another heat", () => {
  const onlyCurrent = structuredClone(snapshot);
  onlyCurrent.schedule.nextRaceIds = [];
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const scene = display.project(onlyCurrent, "staging");
  assert.equal(scene.race, null);
  assert.equal(display.getState(scene).filter(value => value.text).length, 0);
});

test("an unknown explicit queue ID does not shift a later heat into the wrong view", () => {
  const sparse = structuredClone(snapshot);
  sparse.schedule.nextRaceIds = ["missing-race", "race-3"];
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  assert.equal(display.project(sparse, "staging").race, null);
  assert.equal(display.project(sparse, "next").race.id, "race-3");
});

test("DisplayScene recovers an omitted R8 assignment from the trusted event schedule", () => {
  const partial = structuredClone(snapshot);
  delete partial.races[0].pilots[3].video;
  partial.races[2].pilots.at(-1).video = { channel: "R8", frequencyMHz: 5917 };
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const scene = new DisplayScene(profile).project(partial, "current");
  assert.equal(scene.race.pilots[3].channel, "R8");
  assert.equal(scene.race.pilots[3].color, profile.display.channelColors.R8);
});

test("a race-day profile round-trips through its storage interface", () => {
  const storage = new MemoryProfileStorage();
  const profile = new RaceDayProfile({ storage });
  profile.update({ cycle: { enabled: true, seconds: 7 }, display: { channelColors: { R8: "#123456" } } });
  const restored = new RaceDayProfile({ storage }).get();
  assert.equal(restored.cycle.seconds, 7);
  assert.equal(restored.display.channelColors.R8, "#123456");
});

test("legacy DOM-shaped settings migrate once into the versioned profile", () => {
  const values = new Map([["fpv-race-wled-display-v2", JSON.stringify({ transport: "wireless", wledUrl: "http://display.test", headerColor: "#123456", outputEnabled: true, liveSend: true, ch3: "R8", cc3: "#abcdef" })]]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const profile = new RaceDayProfile({ storage: new LocalProfileStorage({ storage }) }).get();
  assert.equal(profile.output.wledUrl, "http://display.test");
  assert.equal(profile.output.enabled, true);
  assert.equal(profile.display.presets.current.headerTextColor, "#123456");
  assert.equal(profile.display.channelColors.R8, "#abcdef");
});

test("RaceSourceRuntime keeps its last trusted snapshot after a later source failure", async () => {
  const adapter = new RecordedRaceSourceAdapter([snapshot]);
  adapter.subscribe = () => () => {};
  const states = [];
  const runtime = new RaceSourceRuntime({ adapter, storage: null, onState: state => states.push(state) });
  runtime.configure({ connectorUrl: "http://localhost", sourceUrl: "https://example.test", reconcileSeconds: 300 });
  await runtime.setEnabled(true);
  adapter.snapshot = async () => { throw new Error("temporary failure"); };
  await runtime.refresh(runtime.generation, true);
  assert.equal(runtime.getState().snapshot.snapshotId, snapshot.snapshotId);
  assert.equal(runtime.getState().connection, "degraded");
  runtime.stop();
});

test("OutputSession repairs a missing schema before publishing through its interface", async () => {
  const operations = [];
  const adapterFactory = (_transport, callbacks) => ({
    connected: false,
    async connect() { this.connected = true; },
    ready() { return this.connected; },
    async close() { this.connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      operations.push(command.op);
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: command.op !== "use", code: command.op === "use" ? "schema_missing" : "ok" } })));
    }
  });
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const scene = display.project(snapshot, "current");
  const session = new OutputSession({ adapterFactory });
  session.configure(profile.output);
  session.setLive(true);
  await session.setEnabled(true);
  await session.publish(display.getSchema(), display.getState(scene));
  assert.ok(operations.indexOf("schema.commit") < operations.indexOf("state"));
  assert.equal(session.getState().controlling, true);
  await session.setEnabled(false);
});
