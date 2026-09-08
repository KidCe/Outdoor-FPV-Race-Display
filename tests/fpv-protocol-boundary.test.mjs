import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DisplayScene } from "../web/display-scene.js";
import { MemoryProfileStorage, RaceDayProfile } from "../web/race-day-profile.js";

const projectFile = relativePath => fs.readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

function coversInterval(intervals, end) {
  const ordered = intervals
    .filter(([start, finish]) => finish > start)
    .sort(([left], [right]) => left - right);
  let cursor = 0;
  for (const [start, finish] of ordered) {
    if (start > cursor) return false;
    cursor = Math.max(cursor, finish);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

function hasCompleteCanvasBorder(nodes, width, height) {
  const rects = nodes.filter(node => node.type === "rect" && node.w > 0 && node.h > 0);
  const top = rects.filter(node => node.y <= 0 && node.y + node.h > 0).map(node => [node.x, node.x + node.w]);
  const bottom = rects.filter(node => node.y < height && node.y + node.h >= height).map(node => [node.x, node.x + node.w]);
  const left = rects.filter(node => node.x <= 0 && node.x + node.w > 0).map(node => [node.y, node.y + node.h]);
  const right = rects.filter(node => node.x < width && node.x + node.w >= width).map(node => [node.y, node.y + node.h]);
  return coversInterval(top, width) && coversInterval(bottom, width) && coversInterval(left, height) && coversInterval(right, height);
}

test("FPV v1 capacity is a fixed firmware scene budget, not an 80x80 LED limit", async () => {
  const sceneHeader = await projectFile("wled/usermods/fpv_race_display/fpv_scene.h");
  const displaySource = await projectFile("wled/usermods/fpv_race_display/fpv_race_display.cpp");
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const schema = new DisplayScene(profile).getSchema();

  assert.equal(schema.canvas.width, 80);
  assert.equal(schema.canvas.height, 80);
  assert.equal(schema.nodes.length, 40);
  assert.ok(schema.nodes.length <= 40);
  assert.match(sceneHeader, /static constexpr uint8_t MAX_NODES = 40;/);
  assert.match(sceneHeader, /Node nodes\[MAX_NODES\]/);
  assert.match(displaySource, /_scene\.nodeCount >= MAX_NODES\).*too_many_nodes/);
  assert.match(sceneHeader, /scene\.nodeCount >= MAX_NODES/);
});

test("current completion marker is a complete checkerboard header motif", async () => {
  const profile = new RaceDayProfile({ storage: new MemoryProfileStorage() }).get();
  const schema = new DisplayScene(profile).getSchema();
  const completionNodes = schema.nodes.filter(node => node.bind === "complete-marker");

  assert.equal(completionNodes.length, 8);
  assert.ok(completionNodes.every(node => node.type === "rect" && node.filled === true));
  // The marker covers the two header bands, not the entire 80x80 canvas. The
  // alternating 8x2 tiles make the completed state unambiguous without
  // consuming the pilot area or exceeding the 40-node scene budget.
  assert.equal(hasCompleteCanvasBorder(completionNodes, schema.canvas.width, schema.canvas.height), false);
});

