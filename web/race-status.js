export const RACE_STATUS = Object.freeze({
  STAGING: "staging",
  RUNNING: "running",
  COMPLETE: "complete",
  UNKNOWN: "unknown"
});

const RACE_STATUS_LABELS = Object.freeze({
  [RACE_STATUS.STAGING]: "STAGING",
  [RACE_STATUS.RUNNING]: "RUNNING",
  [RACE_STATUS.COMPLETE]: "COMPLETE",
  [RACE_STATUS.UNKNOWN]: "UNKNOWN"
});

const STATUS_ALIASES = new Map([
  ["staging", RACE_STATUS.STAGING],
  ["ready", RACE_STATUS.STAGING],
  ["running", RACE_STATUS.RUNNING],
  ["racing", RACE_STATUS.RUNNING],
  ["complete", RACE_STATUS.COMPLETE],
  ["completed", RACE_STATUS.COMPLETE]
]);

function statusKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function mapRaceStatus(value) {
  return STATUS_ALIASES.get(statusKey(value)) || RACE_STATUS.UNKNOWN;
}

export function presentRaceStatus(value) {
  return RACE_STATUS_LABELS[mapRaceStatus(value)];
}

export function raceStatus(race) {
  return mapRaceStatus(race?.status);
}

export function raceStatusLabel(race) {
  return presentRaceStatus(race?.status);
}

export function isRaceRunning(race) {
  return raceStatus(race) === RACE_STATUS.RUNNING;
}
