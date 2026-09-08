import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createHubServer, TrustedStore } from "../hub/index.mjs";

const host = process.env.FPV_E2E_HOST || "127.0.0.1";
const port = Number(process.env.FPV_E2E_PORT || 0);
const epoch = process.env.FPV_E2E_EPOCH || "race-day-e2e-epoch";
const password = process.env.FPV_E2E_PASSWORD || "race-day-e2e-password";
const statePath = process.env.FPV_E2E_STATE_PATH;

if (!statePath) throw new Error("FPV_E2E_STATE_PATH is required.");
await mkdir(dirname(statePath), { recursive: true });

const store = new TrustedStore({ epoch, persistencePath: statePath, historyLimit: 128 });
await store.restore();
const server = createHubServer({
  store,
  writePassword: password,
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
