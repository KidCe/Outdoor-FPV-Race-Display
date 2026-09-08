import test from "node:test";
import assert from "node:assert/strict";
import { OutputSession } from "../web/output-session.js";

const schema = { schemaId: "race", schemaHash: "schema-v1" };

function stateMap(values) {
  return Object.fromEntries(values.map(value => [value.key, value.text]));
}

test("OutputSession keeps the visible state unchanged until the final state chunk commits", async () => {
  const commands = [];
  const visibleStates = [];
  const baseline = Array.from({ length: 17 }, (_, index) => ({ key: `v${index}`, text: `old-${index}` }));
  const next = Array.from({ length: 17 }, (_, index) => ({ key: `v${index}`, text: `new-${index}` }));
  let connected = false;
  let visible = stateMap(baseline);
  let staged = null;
  const adapterFactory = (_transport, callbacks) => ({
    async connect() { connected = true; },
    ready() { return connected; },
    async close() { connected = false; },
    async send(text) {
      const command = JSON.parse(text).fpv;
      commands.push(command);
      if (command.op === "state") {
        if (command.replace) staged = {};
        Object.assign(staged, stateMap(command.values));
        if (command.commit) {
          visible = staged;
          staged = null;
        }
        visibleStates.push({ ...visible });
      }
      queueMicrotask(() => callbacks.onMessage(JSON.stringify({ fpv: { p: 1, seq: command.seq, ok: true } })));
    }
  });
  const session = new OutputSession({ adapterFactory });
  session.configure({ transport: "test", brightness: 50, backgroundEffect: 0 });
  session.setLive(true);
  await session.setEnabled(true);
  session.activeSchema = schema;

  await session.publish(schema, next);

  const stateCommands = commands.filter(command => command.op === "state");
  assert.equal(stateCommands.length, 3);
  assert.deepEqual(visibleStates.slice(0, 2), [stateMap(baseline), stateMap(baseline)]);
  assert.deepEqual(visibleStates[2], stateMap(next));
  assert.deepEqual(stateCommands.map(command => command.replace), [true, false, false]);
  assert.deepEqual(stateCommands.map(command => command.commit), [false, false, true]);
  assert.ok(stateCommands.every(command => Number.isInteger(command.tx) && command.tx > 0));
  assert.equal(new Set(stateCommands.map(command => command.tx)).size, 1);

  await session.setEnabled(false);
});
