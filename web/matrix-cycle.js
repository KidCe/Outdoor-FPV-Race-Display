import { mapRaceStatus } from "./race-status.js";

const VALID_NEXT_STATUSES = new Set(["scheduled", "staging", "running", "not_run"]);

export const MATRIX_CYCLE_DEFAULTS = Object.freeze({
  completeSeconds: 5,
  nextUpSeconds: 5
});

export function isValidNextUpRace(current, next) {
  return Boolean(
    current?.id &&
    next?.id &&
    current.id !== next.id &&
    VALID_NEXT_STATUSES.has(String(next.status || "").trim().toLowerCase())
  );
}

function secondsToMilliseconds(value, fallback) {
  const seconds = Number(value);
  return (Number.isFinite(seconds) ? Math.max(2, seconds) : fallback) * 1000;
}

export class MatrixCycleController {
  constructor({ now = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onViewChange = () => {} } = {}) {
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.onViewChange = onViewChange;
    this.timer = 0;
    this.generation = 0;
    this.deadline = 0;
    this.signature = "";
    this.completeDelay = secondsToMilliseconds(MATRIX_CYCLE_DEFAULTS.completeSeconds, MATRIX_CYCLE_DEFAULTS.completeSeconds);
    this.nextUpDelay = secondsToMilliseconds(MATRIX_CYCLE_DEFAULTS.nextUpSeconds, MATRIX_CYCLE_DEFAULTS.nextUpSeconds);
    this.state = { active: false, view: "current", phase: "idle", delay: 0 };
  }

  getState() {
    return { ...this.state };
  }

  update({ enabled, current, next, completeSeconds = MATRIX_CYCLE_DEFAULTS.completeSeconds, nextUpSeconds = MATRIX_CYCLE_DEFAULTS.nextUpSeconds } = {}) {
    const nextIsValid = isValidNextUpRace(current, next);
    const shouldCycle = Boolean(enabled) && mapRaceStatus(current?.status) === "complete" && nextIsValid;
    const completeDelay = secondsToMilliseconds(completeSeconds, MATRIX_CYCLE_DEFAULTS.completeSeconds);
    const nextUpDelay = secondsToMilliseconds(nextUpSeconds, MATRIX_CYCLE_DEFAULTS.nextUpSeconds);
    const signature = shouldCycle ? `${current.id}|${next.id}|${completeDelay}|${nextUpDelay}` : "";

    if (!shouldCycle) {
      this.stop();
      return this.getState();
    }
    if (signature === this.signature && this.state.active) return this.getState();

    this.completeDelay = completeDelay;
    this.nextUpDelay = nextUpDelay;
    this.signature = signature;
    this.startPhase("complete");
    return this.getState();
  }

  // A backgrounded browser may throttle or suspend setTimeout callbacks. The
  // wall-clock deadline keeps the cycle deterministic when the host resumes.
  tick() {
    if (!this.state.active || this.now() < this.deadline) return false;
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = 0;
    this.startPhase(this.state.phase === "complete" ? "next-up" : "complete");
    return true;
  }

  interrupt() {
    this.stop();
    return this.getState();
  }

  stop() {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = 0;
    this.deadline = 0;
    this.generation += 1;
    this.signature = "";
    this.setState({ active: false, view: "current", phase: "idle", delay: 0 });
  }

  startPhase(phase) {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    const generation = ++this.generation;
    const view = phase === "next-up" ? "next" : "current";
    const delay = phase === "next-up" ? this.nextUpDelay : this.completeDelay;
    this.setState({ active: true, view, phase, delay });
    this.deadline = this.now() + delay;
    this.timer = this.setTimeoutImpl(() => {
      if (generation !== this.generation) return;
      this.timer = 0;
      this.startPhase(phase === "complete" ? "next-up" : "complete");
    }, delay);
  }

  setState(nextState) {
    const changed = this.state.active !== nextState.active || this.state.view !== nextState.view || this.state.phase !== nextState.phase;
    this.state = nextState;
    if (changed) this.onViewChange(nextState.view, this.getState());
  }
}
