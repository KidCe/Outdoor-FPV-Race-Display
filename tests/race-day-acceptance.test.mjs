import test from "node:test";
import assert from "node:assert/strict";

import { runAcceptance } from "../scripts/race-day-acceptance.mjs";

test("public race-day acceptance replay", { timeout: 45_000 }, async () => {
  const result = await runAcceptance({ quiet: true });
  assert.equal(result.ok, true);
});
