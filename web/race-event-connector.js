const FORMAT = "org.fpv.race-event.snapshot";

export function validateRaceEventSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Connector response is not an object.");
  if (snapshot.format !== FORMAT || snapshot.version !== 1) throw new Error("Connector response uses an unsupported race-event format.");
  if (!snapshot.event?.id || !snapshot.event?.name) throw new Error("Connector response is missing event metadata.");
  if (!Array.isArray(snapshot.races) || snapshot.races.length === 0) throw new Error("Connector response does not contain races.");
  const index = snapshot.schedule?.currentIndex;
  if (!Number.isInteger(index) || snapshot.races[index]?.id !== snapshot.schedule.currentRaceId) throw new Error("Connector response has an inconsistent current race.");
  if (!["fresh", "degraded", "stale"].includes(snapshot.quality?.state)) throw new Error("Connector response is missing quality metadata.");
  return snapshot;
}

export async function fetchRaceEventSnapshot({ connectorUrl, sourceUrl, demo = false, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this browser.");
  const base = new URL(connectorUrl || "http://localhost:4174");
  const endpoint = new URL(demo ? "/api/connectors/race-event/v1/demo" : "/api/connectors/race-event/v1/snapshot", base);
  if (!demo) {
    if (!sourceUrl) throw new Error("Enter a LiveFPV event URL.");
    endpoint.searchParams.set("sourceUrl", sourceUrl);
  }
  const response = await fetchImpl(endpoint, { headers: { accept: "application/json" }, cache: "no-store", signal });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`Connector returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(payload.error || `Connector returned HTTP ${response.status}.`);
  return validateRaceEventSnapshot(payload);
}

export function createRaceEventStreamUrl({ connectorUrl, sourceUrl }) {
  const endpoint = new URL("/api/connectors/race-event/v1/stream", new URL(connectorUrl || "http://localhost:4174"));
  if (!sourceUrl) throw new Error("Enter a LiveFPV event URL.");
  endpoint.searchParams.set("sourceUrl", sourceUrl);
  return endpoint.href;
}
