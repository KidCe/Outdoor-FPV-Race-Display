const STATUS_ALIASES = new Map([
  ["ready", "staging"],
  ["racing", "running"],
  ["completed", "complete"],
  ["not_yet_run", "not_run"],
  ["canceled", "cancelled"],
  ["uncertain", "unknown"]
]);

const CANONICAL_STATUSES = new Set([
  "scheduled",
  "staging",
  "running",
  "complete",
  "cancelled",
  "not_run",
  "unknown"
]);

const EXPLICIT_ACTIVE_STATUSES = new Set(["staging", "running"]);
const TERMINAL_STATUSES = new Set(["complete", "cancelled"]);
const NON_AUTHORITATIVE_STATUSES = new Set(["scheduled", "not_run", "unknown"]);

function statusToken(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeConnectorRaceStatus(value) {
  const normalized = statusToken(value);
  return STATUS_ALIASES.get(normalized) || (CANONICAL_STATUSES.has(normalized) ? normalized : "unknown");
}

function sourceStatusIsExplicitlyActive(value) {
  return ["staging", "running", "racing"].includes(statusToken(value));
}

function sourceStatusIsNonCurrent(value) {
  return ["scheduled", "not_run", "not_yet_run"].includes(statusToken(value));
}

export function findExplicitConnectorActiveIndex(sourceRaces) {
  return sourceRaces.findIndex(race => sourceStatusIsExplicitlyActive(race?.status));
}

export function selectConnectorCurrentIndex(races, requestedIndex, { sourceRaces = [], hasExplicitCurrentId = false } = {}) {
  const requestedRace = races[requestedIndex];
  const requestedSourceRace = sourceRaces[requestedIndex];
  if (sourceStatusIsExplicitlyActive(requestedSourceRace?.status)) return requestedIndex;

  const runningIndex = races.findIndex((race, index) => race.status === "running" && sourceStatusIsExplicitlyActive(sourceRaces[index]?.status));
  if (runningIndex >= 0) return runningIndex;
  const stagingIndex = races.findIndex((race, index) => race.status === "staging" && sourceStatusIsExplicitlyActive(sourceRaces[index]?.status));
  if (stagingIndex >= 0) return stagingIndex;

  // Keep an explicitly supplied unknown pointer during a transient partial
  // packet instead of moving the display to an older completed heat.
  if (!hasExplicitCurrentId && requestedRace?.status === "unknown") return requestedIndex;

  if (hasExplicitCurrentId && requestedRace && !sourceStatusIsNonCurrent(requestedSourceRace?.status)) return requestedIndex;

  const completedIndex = races.reduce((latest, race, index) => race.status === "complete" ? index : latest, -1);
  return completedIndex >= 0 ? completedIndex : requestedIndex;
}

export function buildConnectorSchedule(races, currentIndex) {
  return {
    currentRaceId: races[currentIndex]?.id ?? null,
    currentIndex,
    nextRaceIds: races.slice(currentIndex + 1, currentIndex + 3).map(race => race.id),
    afterNextRaceIds: races.slice(currentIndex + 3, currentIndex + 6).map(race => race.id)
  };
}

function mergeRetainedRace(candidateRace, previousRace) {
  return { ...structuredClone(candidateRace), status: previousRace.status };
}

export function reconcileConnectorSnapshot(previous, candidate) {
  if (!previous || !candidate || previous.eventSessionId !== candidate.eventSessionId || previous.event?.id !== candidate.event?.id) return candidate;
  const previousIndex = previous.schedule?.currentIndex;
  const candidateIndex = candidate.schedule?.currentIndex;
  const previousRace = previous.races?.[previousIndex];
  const candidateRace = candidate.races?.[candidateIndex];

  const shouldPreserveUnknown = previousRace && candidateRace?.status === "unknown" && previousRace.status !== "unknown";
  const shouldPreserveActiveHeat = previousRace && candidateRace?.id === previousRace.id
    && EXPLICIT_ACTIVE_STATUSES.has(previousRace.status)
    && NON_AUTHORITATIVE_STATUSES.has(candidateRace.status);
  if (shouldPreserveUnknown || shouldPreserveActiveHeat) {
    const retainedIndex = candidate.races.findIndex(race => race.id === previous.schedule?.currentRaceId);
    if (retainedIndex >= 0) {
      const races = candidate.races.map((race, index) => index === retainedIndex
        ? mergeRetainedRace(race, previousRace)
        : race);
      const warnings = [...(candidate.quality?.warnings || [])];
      const warning = shouldPreserveUnknown
        ? { code: "race.status_unknown_preserved", message: "The source omitted the current heat status; the last trusted status is being retained.", severity: "warning" }
        : { code: "race.status_non_authoritative_preserved", message: "A static source snapshot downgraded the active heat without an authoritative transition; the last trusted status is being retained.", severity: "warning" };
      if (!warnings.some(item => item.code === warning.code)) warnings.push(warning);
      const domains = Object.fromEntries(Object.entries(candidate.quality?.domains || {}).map(([key, domain]) => [
        key,
        key === "schedule" ? { ...domain, state: "degraded", reason: "unknown_status_preserved" } : domain
      ]));
      return {
        ...candidate,
        races,
        schedule: buildConnectorSchedule(races, retainedIndex),
        quality: { ...candidate.quality, state: candidate.quality?.state === "stale" ? "stale" : "degraded", warnings, domains }
      };
    }
  }

  if (!Number.isInteger(previousIndex) || !Number.isInteger(candidateIndex) || candidateIndex >= previousIndex) return candidate;

  const previousStatus = previousRace?.status;
  const candidateStatus = candidateRace?.status;
  if (EXPLICIT_ACTIVE_STATUSES.has(previousStatus) && !EXPLICIT_ACTIVE_STATUSES.has(candidateStatus)) {
    const retainedIndex = candidate.races.findIndex(race => race.id === previous.schedule?.currentRaceId);
    if (retainedIndex >= 0) {
      const races = candidate.races.map((race, index) => index === retainedIndex ? mergeRetainedRace(race, previousRace) : race);
      return { ...candidate, races, schedule: buildConnectorSchedule(races, retainedIndex) };
    }
  }
  if (!TERMINAL_STATUSES.has(previousStatus) || !sameRaceGroup(previousRace, candidateRace) || EXPLICIT_ACTIVE_STATUSES.has(candidateStatus)) return candidate;

  const retainedIndex = candidate.races.findIndex(race => race.id === previous.schedule?.currentRaceId);
  if (retainedIndex < 0) return candidate;
  const races = candidate.races.map((race, index) => index === retainedIndex ? mergeRetainedRace(race, previousRace) : race);
  return { ...candidate, races, schedule: buildConnectorSchedule(races, retainedIndex) };
}

function sameRaceGroup(left, right) {
  const leftRound = String(left?.round || "").trim().toLowerCase();
  const rightRound = String(right?.round || "").trim().toLowerCase();
  return !leftRound || !rightRound || leftRound === rightRound;
}
