import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createHubServer, TrustedStore } from "../hub/index.mjs";

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const host = option("--host", process.env.FPV_E2E_HOST || "127.0.0.1");
const port = Number(option("--port", process.env.FPV_E2E_PORT || 0));
const epoch = option("--epoch", process.env.FPV_E2E_EPOCH || "race-day-e2e-epoch");
const statePath = option("--state", process.env.FPV_E2E_STATE_PATH || fileURLToPath(new URL("../data/e2e-fixture-state.json", import.meta.url)));
const seedEnabled = option("--seed", process.env.FPV_E2E_SEED || "0") === "1";
await mkdir(dirname(statePath), { recursive: true });

const store = new TrustedStore({ epoch, persistencePath: statePath, historyLimit: 128 });
const restoredSnapshot = await store.restore();
if (!restoredSnapshot && seedEnabled) {
  const seed = JSON.parse(await readFile(new URL("../contracts/race-event/v1/fixtures/snapshot-fresh.json", import.meta.url)));
  const capturedAt = new Date().toISOString();
  seed.snapshotId = "simulator-initial";
  seed.eventSessionId = "simulator-session";
  seed.capturedAt = capturedAt;
  seed.event = { ...seed.event, id: "simulator-event", name: "Local Race-Day Simulator", organizer: "Local Test", sourceUrl: `http://${host}:${port || 4175}` };
  seed.sources = [{ id: "local-simulator", provider: "Local Fixture", kind: "simulated-race-data-hub", revision: seed.snapshotId, capturedAt, confidence: "high" }];
  seed.races = seed.races.slice(0, 2).map((race, index) => ({
    ...race,
    id: `simulator-heat-${index + 1}`,
    runId: index === 0 ? `simulator-heat-${index + 1}-run-1` : null,
    order: index,
    label: `Qualifier (Heat ${index + 1}/2)`,
    status: "staging",
    heat: { number: index + 1, count: 2 },
    timing: { state: "staging", elapsedMs: null, startedAt: null, stoppedAt: null, capturedAt }
  }));
  seed.schedule = { currentRaceId: seed.races[0].id, currentIndex: 0, nextRaceIds: [seed.races[1].id], afterNextRaceIds: [] };
  seed.quality = { ...seed.quality, state: "fresh", completeRaceCount: 0, warnings: [], domains: Object.fromEntries(Object.entries(seed.quality.domains).map(([name, domain]) => [name, { ...domain, state: "fresh", capturedAt }])) };
  seed.activeAnnouncements = [];
  store.selectEvent({ eventSessionId: seed.eventSessionId, event: seed.event });
  store.publish(seed);
  await store.save();
  console.log(`SEEDED ${seed.event.name}`);
}
const server = createHubServer({
  store,
  heartbeatMs: 0,
  enableTestSnapshotInjection: true
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});

const address = server.address();
console.log(`READY http://${host}:${address.port} ${epoch}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
  process.exit(0);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
