# Code Review and Remote Handoff — 2026-09-12

This document records the code review performed against fixed point
`d79539e71fd5f57661aa91d94644af6eeb89c5b9` and the follow-up fixes prepared on
`main`. It is intended to make continued remote work possible without relying on
the original Codex conversation.

## Implemented improvements

- Added `hub/connector-race-state.mjs` as the deep module responsible for
  connector status normalization, current-race selection, schedule assembly,
  and reconciliation.
- Changed reconciliation so it preserves the trusted status/frontier without
  replacing newer pilot, timing, or result data with an older race object.
- Preserved explicit `runId` and `attempt` values so connector-provided rerun
  identity is not discarded.
- Stopped converting blank timing and frequency fields to numeric zero.
- Normalized unsupported connector status values to `unknown` and degraded
  source quality instead of emitting a snapshot that fails public validation.
- Bound injected native `fetch` implementations to `globalThis`, avoiding the
  browser `Illegal invocation` failure.
- Allowed `RaceHubRuntime` to start with persistence disabled instead of calling
  `dirname(null)`.
- Restricted browser write requests to same-origin or origins explicitly listed
  in `FPV_HUB_ALLOWED_WRITE_ORIGINS`. Read endpoints retain open CORS access.
- Removed a duplicate schema installation and flattened transient retry handling
  so capture commands make at most three total attempts.
- Removed the obsolete `backgroundEffect` field from the Python frame-readback
  verifier.
- Changed WLED hot-path loop counters to the fast integer type documented by the
  bundled firmware conventions.
- Added regression coverage for the above behavior and documented the new module
  and write-origin boundary.

## Remaining standards findings

### P1 — Version the timing extension to the frozen v1 contract

`contracts/race-event/v1/snapshot.schema.json` contains `pilots[].timing`, even
though the v1 contract is documented as frozen and uses
`additionalProperties: false`. Older strict consumers can reject the extended
payload. Do not remove or rename this locally without coordinating every
consumer. The preferred resolution is a v2 contract or an explicitly negotiated
extension mechanism with compatibility tests.

### P2 — Separate the simulator state machine from browser effects

`hub/simulator.js` still combines pure race-state transitions with DOM and
network behavior and duplicates some status vocabulary. A follow-up refactor
should extract a pure simulator state machine, keep browser rendering and fetch
effects in an adapter, and reuse the canonical status definitions.

## Remaining specification findings

### P1 — Resolve automatic versus explicit event selection

The current launcher automatically connects to its configured/default event,
while `docs/RACE-DATA-HUB-IMPLEMENTATION-HANDOFF.md` describes explicit event
selection. The Starter Guide reflects the current automatic workflow. Decide
which behavior is authoritative, then update both implementation and
documentation together.

### P1 — Define identity when a rerun has no source-provided identifier

Explicit `runId` and `attempt` values are now preserved, but the Hub does not
synthesize identity when a source omits both. Define a stable, deterministic
identity rule before implementing this; otherwise two attempts of the same heat
can collapse into one event.

### P1 — Complete the runtime trust-mode design

Browser writes now have an origin allowlist, but the architecture still does not
fully distinguish a bundled local runtime from a centrally hosted Hub. Define
the deployment modes and their authentication/trust boundary before exposing a
Hub beyond the local race network. `FPV_HUB_ALLOWED_WRITE_ORIGINS` is an origin
check, not authentication.

## Recommended continuation order

1. Decide and document the canonical event-selection workflow.
2. Design contract v2 or a negotiated extension for pilot timing.
3. Define missing rerun identity semantics and add fixtures before code changes.
4. Specify local and hosted Hub trust modes, then add authorization appropriate
   to the hosted mode.
5. Extract the pure simulator state machine and remove duplicated status terms.
6. Repeat physical race-day and HUB75 validation after the contract and runtime
   decisions are implemented.

## Verification completed

- `npm test`: 173/173 tests passed.
- `npm run test:e2e`: deterministic race-day acceptance passed.
- Python compilation and Node syntax checks passed.
- `git diff --check` passed.
- PlatformIO builds passed for both
  `esp32dev_hub75_p4_80x40_fpv` and `waveshare_p4_80x40_fpv`.

No firmware was flashed during this review. Physical HUB75 output and complete
race-day behavior remain unverified on hardware.

## Review summary

- Standards: six findings; four resolved, two remain open. The highest-risk open
  issue is the extension of a frozen v1 contract without version negotiation.
- Specification: five findings; two resolved and three partially resolved or
  open. The highest-risk open issue is the unresolved event-selection contract.
