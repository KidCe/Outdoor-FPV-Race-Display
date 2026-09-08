import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DisplayScene, projectRaceSchedule } from "../web/display-scene.js";
import { MatrixCycleController } from "../web/matrix-cycle.js";
import { projectCycleScene } from "../web/race-day-app.js";
import { MemoryProfileStorage, RaceDayProfile } from "../web/race-day-profile.js";

const fixture = async name => JSON.parse(await readFile(new URL(`../contracts/race-event/v1/fixtures/${name}`, import.meta.url)));

function completedMainSnapshot(base) {
  const snapshot = structuredClone(base);
  snapshot.snapshotId = "matrix-cycle-red-repro";
  snapshot.capturedAt = "2026-09-08T10:00:00.000Z";
  const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
  current.round = "Main Event";
  current.phase = "Main Event";
  current.heat = { number: 1, count: 32 };
  current.label = "Main Event (Heat 1/32)";
  current.status = "complete";
  current.timing = { state: "complete", capturedAt: snapshot.capturedAt, stoppedAt: snapshot.capturedAt };
  const next = snapshot.races.find(race => race.id === snapshot.schedule.nextRaceIds[0]);
  next.round = "Main Event";
  next.phase = "Main Event";
  next.heat = { number: 2, count: 32 };
  next.label = "Main Event (Heat 2/32)";
  next.status = "staging";
  next.pilots = [{ id: "pilot-next", callsign: "NextPilot", video: { channel: "R2", frequencyMHz: 5695 } }];
  return snapshot;
}

test("completed Main heat uses compact matrix text and checkerboard completion pattern", async () => {
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const scene = display.project(completedMainSnapshot(await fixture("snapshot-fresh.json")), "current");
  const state = display.getState(scene);

  assert.equal(scene.matrixHeader, "M1/32");
  assert.equal(scene.completionPattern, "checkerboard");
  assert.equal(state.some(value => /DONE/i.test(value.text || "")), false);
  assert.equal(state.find(value => value.key === "complete-marker")?.visible, true);
});

test("complete and Next Up rotate on independent five-second phases", () => {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const controller = new MatrixCycleController({
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutImpl: id => timers.delete(id)
  });
  const current = { id: "heat-1", status: "complete" };
  const next = { id: "heat-2", status: "scheduled" };

  controller.update({ enabled: true, current, next });
  assert.deepEqual(controller.getState(), { active: true, view: "current", phase: "complete", delay: 5000 });

  now = 5000;
  timers.get(1).callback();
  assert.deepEqual(controller.getState(), { active: true, view: "next", phase: "next-up", delay: 5000 });

  now = 10000;
  timers.get(2).callback();
  assert.deepEqual(controller.getState(), { active: true, view: "current", phase: "complete", delay: 5000 });
});

test("cycle tick advances after a throttled timer deadline", () => {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const controller = new MatrixCycleController({
    now: () => now,
    setTimeoutImpl: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeoutImpl: id => timers.delete(id)
  });

  controller.update({ enabled: true, current: { id: "heat-1", status: "complete" }, next: { id: "heat-2", status: "scheduled" } });
  now = 5001;
  assert.equal(controller.tick(), true);
  assert.deepEqual(controller.getState(), { active: true, view: "next", phase: "next-up", delay: 5000 });
  assert.equal(timers.size, 1);
});

test("cycle changes only the rendered view and disabled cycle keeps Current and Next One semantic cards", async () => {
  const snapshot = completedMainSnapshot(await fixture("snapshot-fresh.json"));
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const semanticQueue = projectRaceSchedule(snapshot, profile, { limit: 2 }).map(race => ({ id: race.id, status: race.status }));
  let timer;
  const controller = new MatrixCycleController({
    setTimeoutImpl: (callback, delay) => { timer = { callback, delay }; return 1; },
    clearTimeoutImpl: () => {}
  });
  const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
  const next = snapshot.races.find(race => race.id === snapshot.schedule.nextRaceIds[0]);

  controller.update({ enabled: true, current, next });
  assert.deepEqual(controller.getState(), { active: true, view: "current", phase: "complete", delay: 5000 });
  timer.callback();
  assert.deepEqual(controller.getState(), { active: true, view: "next", phase: "next-up", delay: 5000 });
  assert.deepEqual(projectRaceSchedule(snapshot, profile, { limit: 2 }).map(race => ({ id: race.id, status: race.status })), semanticQueue);

  assert.deepEqual(controller.update({ enabled: false, current, next }), { active: false, view: "current", phase: "idle", delay: 0 });
  assert.deepEqual(projectRaceSchedule(snapshot, profile, { limit: 2 }).map(race => ({ id: race.id, status: race.status })), semanticQueue);
});

test("missing or invalid Next Up keeps the completed current heat and active LiveNow interrupts", () => {
  let now = 0;
  const timers = [];
  const controller = new MatrixCycleController({
    now: () => now,
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {}
  });
  const current = { id: "heat-1", status: "complete" };

  assert.deepEqual(controller.update({ enabled: false, current, next: { id: "heat-2", status: "scheduled" } }), { active: false, view: "current", phase: "idle", delay: 0 });
  assert.deepEqual(controller.update({ enabled: true, current, next: null }), { active: false, view: "current", phase: "idle", delay: 0 });
  assert.deepEqual(controller.update({ enabled: true, current, next: { id: "heat-2", status: "complete" } }), { active: false, view: "current", phase: "idle", delay: 0 });

  for (const status of ["staging", "running"]) {
    controller.update({ enabled: true, current, next: { id: "heat-2", status: "scheduled" } });
    assert.equal(controller.getState().active, true);
    controller.update({ enabled: true, current: { id: "heat-1", status }, next: { id: "heat-2", status: "scheduled" } });
    assert.deepEqual(controller.getState(), { active: false, view: "current", phase: "idle", delay: 0 });
  }
});

test("DisplayScene falls back to the completed current scene when Next Up is not known", async () => {
  const snapshot = completedMainSnapshot(await fixture("snapshot-fresh.json"));
  snapshot.schedule.nextRaceIds = [];
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const scene = display.projectMatrix(snapshot, "next-up");

  assert.equal(scene.race.id, snapshot.schedule.currentRaceId);
  assert.equal(scene.matrixPresetKey, "current");
  assert.equal(scene.matrixHeader, "M1/32");
  assert.equal(scene.completionPattern, "checkerboard");
  assert.equal(scene.race.pilots.length, 2);
});

test("cycle phases accept independently configured durations", () => {
  let timer;
  const controller = new MatrixCycleController({
    setTimeoutImpl: (callback, delay) => { timer = { callback, delay }; return 1; },
    clearTimeoutImpl: () => {}
  });
  const current = { id: "heat-1", status: "complete" };
  const next = { id: "heat-2", status: "scheduled" };

  controller.update({ enabled: true, current, next, completeSeconds: 3, nextUpSeconds: 7 });
  assert.equal(controller.getState().delay, 3000);
  timer.callback();
  assert.equal(controller.getState().phase, "next-up");
  assert.equal(controller.getState().delay, 7000);
});

test("control-desk cycle durations validate and persist through the profile store", () => {
  const storage = new MemoryProfileStorage();
  const profile = new RaceDayProfile({ storage });
  profile.update({ cycle: { enabled: true, completeSeconds: 7, nextUpSeconds: 11 } });
  const restored = new RaceDayProfile({ storage }).get();

  assert.equal(restored.cycle.completeSeconds, 7);
  assert.equal(restored.cycle.nextUpSeconds, 11);
  assert.equal(restored.cycle.seconds, 5);

  profile.update({ cycle: { completeSeconds: 0, nextUpSeconds: 999 } });
  assert.equal(profile.get().cycle.completeSeconds, 2);
  assert.equal(profile.get().cycle.nextUpSeconds, 60);
});

test("matrix roles map Running, Staging, and Next Up to their established arrow treatments", async () => {
  const snapshot = await fixture("snapshot-fresh.json");
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);

  const running = display.project(snapshot, "current");
  assert.equal(running.matrixPresetKey, "current");
  assert.equal(running.matrixPreset.headerFrame, "inward");

  const stagingSnapshot = structuredClone(snapshot);
  stagingSnapshot.races[0].status = "staging";
  const staging = display.project(stagingSnapshot, "current");
  assert.equal(staging.matrixPresetKey, "staging");
  assert.equal(staging.matrixPreset.headerFrame, "upward");

  const nextUp = display.projectMatrix(snapshot, "next-up");
  assert.equal(nextUp.race.id, snapshot.schedule.nextRaceIds[0]);
  assert.equal(nextUp.matrixPresetKey, "next");
  assert.equal(nextUp.matrixPreset.headerFrame, "right-single");
});

test("checkerboard preview draws the same completion tiles exposed by the WLED payload", async () => {
  const snapshot = completedMainSnapshot(await fixture("snapshot-fresh.json"));
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const scene = display.project(snapshot, "current");
  const calls = [];
  const context = {
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    scale: () => {}
  };
  display.render({ getContext: () => context }, scene, { zoom: 1 });

  const completionNodes = display.getSchema().nodes.filter(node => node.bind === "complete-marker");
  const previewTiles = calls.filter(call => call[0] === "fillRect" && call[4] === 2 && call[3] === 8);
  assert.equal(completionNodes.length, 8);
  assert.equal(previewTiles.length, completionNodes.length);
  assert.deepEqual(previewTiles.map(([, x, y, w, h]) => ({ x, y, w, h })), completionNodes.map(({ x, y, w, h }) => ({ x, y, w, h })));
  assert.equal(display.getState(scene).find(value => value.key === "complete-marker")?.visible, true);
  assert.equal(display.getState(scene).some(value => /DONE/i.test(value.text || "")), false);
});

test("a stale phase callback cannot replace a newer cycle generation", () => {
  const callbacks = [];
  const controller = new MatrixCycleController({
    setTimeoutImpl: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length; },
    clearTimeoutImpl: () => {}
  });

  controller.update({ enabled: true, current: { id: "heat-1", status: "complete" }, next: { id: "heat-2", status: "scheduled" } });
  const staleCallback = callbacks[0].callback;
  controller.update({ enabled: true, current: { id: "heat-1", status: "complete" }, next: { id: "heat-3", status: "scheduled" } });
  staleCallback();

  assert.deepEqual(controller.getState(), { active: true, view: "current", phase: "complete", delay: 5000 });
});

test("completed-frame checkerboard spans the full header perimeter within the schema budget", async () => {
  const snapshot = completedMainSnapshot(await fixture("snapshot-fresh.json"));
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  const completionNodes = display.getSchema().nodes.filter(node => node.bind === "complete-marker");

  assert.equal(completionNodes.length, 8);
  assert.deepEqual(completionNodes.map(({ x, y, w, h }) => ({ x, y, w, h })), [
    { x: 2, y: 1, w: 8, h: 2 },
    { x: 22, y: 1, w: 8, h: 2 },
    { x: 42, y: 1, w: 8, h: 2 },
    { x: 62, y: 1, w: 8, h: 2 },
    { x: 12, y: 11, w: 8, h: 2 },
    { x: 32, y: 11, w: 8, h: 2 },
    { x: 52, y: 11, w: 8, h: 2 },
    { x: 72, y: 11, w: 8, h: 2 }
  ]);
  assert.ok(display.getSchema().nodes.length <= 40);
  assert.equal(display.project(snapshot, "current").completionPattern, "checkerboard");
});

test("automatic cycle projects Current Complete and Next Up without changing semantic queue cards", async () => {
  const snapshot = completedMainSnapshot(await fixture("snapshot-fresh.json"));
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const display = new DisplayScene(profile);
  let timer;
  const controller = new MatrixCycleController({
    setTimeoutImpl: (callback, delay) => { timer = { callback, delay }; return 1; },
    clearTimeoutImpl: () => {}
  });
  const current = snapshot.races.find(race => race.id === snapshot.schedule.currentRaceId);
  const next = snapshot.races.find(race => race.id === snapshot.schedule.nextRaceIds[0]);
  const semanticQueue = display.project(snapshot, "current").schedule.filter(Boolean).map(race => ({ id: race.id, heat: race.heat, status: race.status }));

  controller.update({ enabled: true, current, next, completeSeconds: 5, nextUpSeconds: 5 });
  const completeScene = projectCycleScene(display, snapshot, "next", controller.getState());
  assert.equal(timer.delay, 5000);
  assert.equal(completeScene.race.id, current.id);
  assert.equal(completeScene.completionPattern, "checkerboard");
  assert.equal(completeScene.matrixPresetKey, "current");
  assert.deepEqual(display.getState(completeScene).filter(value => value.visible).map(value => value.key).sort(), ["complete-marker", "group-current", "header-current"]);
  assert.deepEqual(completeScene.schedule.filter(Boolean).map(race => ({ id: race.id, heat: race.heat, status: race.status })), semanticQueue);

  timer.callback();
  const nextUpScene = projectCycleScene(display, snapshot, "next", controller.getState());
  assert.equal(timer.delay, 5000);
  assert.equal(nextUpScene.race.id, next.id);
  assert.equal(nextUpScene.view, "next-up");
  assert.equal(nextUpScene.completionPattern, "none");
  assert.equal(nextUpScene.matrixPresetKey, "next");
  assert.deepEqual(display.getState(nextUpScene).filter(value => value.visible).map(value => value.key).sort(), ["group-next", "header-next"]);
  assert.deepEqual(nextUpScene.schedule.filter(Boolean).map(race => ({ id: race.id, heat: race.heat, status: race.status })), semanticQueue);

  timer.callback();
  const returnedScene = projectCycleScene(display, snapshot, "next", controller.getState());
  assert.equal(returnedScene.race.id, current.id);
  assert.equal(returnedScene.completionPattern, "checkerboard");
});
