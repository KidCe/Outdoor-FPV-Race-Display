# Architecture Deepening Review — 2026-09-12

This review applies the deep-module vocabulary to the current `main` branch at
`dba033badcbe7ada5a48f7bd2d11250860a1e067`. It is weighted toward the Hub,
connector, simulator, and output paths that recur in recent commits.

The repository currently has no `CONTEXT.md` and no `docs/adr/` records. The
review therefore uses the established repository terms and does not reopen a
recorded decision. It proposes seams and responsibilities, not detailed
interfaces; those should be designed only after a candidate is selected.

## Vocabulary and evaluation

- A **deep module** puts substantial behavior behind a small **interface**.
- A **seam** is where an interface lives; an **adapter** satisfies it.
- **Leverage** is the capability callers gain from learning less interface.
- **Locality** keeps related knowledge, bugs, changes, and verification together.
- The **deletion test** passes when removing a module would spread its complexity
  back across callers instead of making the complexity disappear.

## Candidate 1 — Deepen connector race-state interpretation

**Recommendation:** Strong

**Dependency category:** In-process
**Files:** `hub/connector-race-state.mjs:1-136`,
`hub/local-server.mjs:70-178`, `hub/local-server.mjs:308-347`,
`tests/local-hub-runtime.test.mjs:22-354`

### Evidence

The connector race-state module exposes separate operations for status
normalization, current selection, schedule construction, and reconciliation.
`adaptConnectorSnapshot` still owns their ordering plus quality assembly.
Polling and streaming separately invoke reconciliation before publication.

### Problem

The module is useful but still shallow: its interface leaks the ordering and
precedence rules of its implementation. Callers must understand source aliases,
explicit-current precedence, completed frontiers, queue rebuilding, degraded
quality, and when reconciliation happens. That reduces locality at the exact
seam where recent regressions occurred.

### Solution

Deepen the module so it owns interpretation of raw connector data through a
trusted candidate. Keep source transport outside at an adapter seam. The caller
should not coordinate status, selection, schedule, quality, and reconciliation.

### Benefits

- Locality for source-authority rules
- One test surface for scenarios
- Leverage across every delivery mode
- Less ordering knowledge in callers

### Deletion test

Passes. Deleting the deepened module would recreate source-authority rules in
polling, streaming, and their tests.

### Testing direction

Replace helper-level choreography tests with scenario tests that cross one
interface and assert the final candidate for lagging polls, reruns, unknown
statuses, and corrected timing.

```text
Before
raw connector -> adapt -> normalize -> select -> schedule -> quality
              -> reconcile -> TrustedStore

After
raw connector -> [deep connector race-state module] -> trusted candidate
              -> TrustedStore
```

## Candidate 2 — Unify polling and streaming ingestion

**Recommendation:** Strong

**Dependency category:** Ports and adapters
**Files:** `hub/local-server.mjs:187-399`, `hub/index.mjs:385-391`,
`tests/local-hub-runtime.test.mjs:68-159`

### Evidence

`RaceHubRuntime.sync` performs event selection, event switching, reconciliation,
publication, and connection-state updates. `RaceHubRuntime.startStream` repeats
event selection, switching, reconciliation, and publication. `RaceDataHub.refresh`
contains a third observation-to-publication path, while streaming bypasses it.

### Problem

The orchestration modules expose `TrustedStore` implementation details such as
active event identity, trusted snapshots, publication, and stale transitions.
The seam is unclear, and each delivery path must know trust rules. Poll and
stream behavior can therefore diverge.

### Solution

Place event switching, observation acceptance, trust promotion, stale behavior,
and delivery-mode status inside one deep ingestion module. Polling and SSE remain
two adapters at one real seam.

### Benefits

- Identical poll and stream behavior
- Locality for reconnect and failover
- One interface for event switching
- Leverage for future source adapters

### Deletion test

Passes. Without the module, the same lifecycle choreography reappears in both
delivery callbacks.

### Testing direction

Drive identical poll and stream scenarios through an in-memory adapter and the
same external interface. Cover reconnects, event changes, stale promotion, and
source corrections without asserting store internals.

```text
Before                            After
poll -> sync rules -> store       poll adapter ----\
stream -> callback rules -> store                   > deep ingestion -> store
RaceDataHub -> partial path       SSE adapter -----/
```

## Candidate 3 — Concentrate FPV protocol transactions

**Recommendation:** Worth exploring

**Dependency category:** Local-substitutable
**Files:** `web/output-session.js:91-515`,
`tests/output-session-atomicity.test.mjs:21-373`,
`tests/output-policy.test.mjs:5-151`

### Evidence

`OutputSession` owns transport lifecycle, reconnect timers, command correlation,
waiter cleanup, retry rules, publication coalescing, schema transactions, state
chunking, and frame capture. Recent commits repeatedly changed this file for
serial shutdown, atomic publication, retries, and schema repair.

### Problem

`OutputSession` is externally deep, but its implementation has low internal
locality. Connection lifecycle and FPV transaction correctness share mutable
sequence, waiter, transaction, schema, and publication state.

### Solution

Keep the existing external interface. Concentrate command correlation,
schema/state transactions, and capture transactions inside one internal deep
module. USB serial and WebSocket remain adapters at the existing real seam.

### Benefits

- External interface remains stable
- Locality for protocol correctness
- Transport adapters remain replaceable
- Transaction tests stop leaking lifecycle

### Deletion test

Passes. Removing the internal module would spread sequence, timeout, retry,
chunk, abort, and checksum rules back through the lifecycle implementation.

### Testing direction

Keep behavior tests at the `OutputSession` interface. Add only focused internal
tests for protocol serialization cases that cannot be observed through that
interface; replace existing internal monkey-patching rather than layering more.

```text
Before
[OutputSession: lifecycle + correlation + schema + state + capture]
                              |
                    USB / WebSocket seam

After
[OutputSession interface] -> lifecycle -> [deep protocol transaction module]
                                      -> USB / WebSocket adapter seam
```

## Candidate 4 — Deepen race-day presentation state

**Recommendation:** Worth exploring

**Dependency category:** In-process
**Files:** `web/race-day-app.js:58-477`, `docs/architecture.md:3`,
`tests/race-day-architecture.test.mjs:29-180`

### Evidence

The architecture document calls `RaceDayAppHost` deliberately small, but the
implementation is 488 lines. It constructs dependencies, mutates profile and
runtime state, combines cycle decisions with DOM writes, renders every surface,
and owns all action wiring. No focused test imports `RaceDayAppHost`.

### Problem

Race-day decisions and DOM mechanics share one implementation. Maintainers must
understand source state, output state, profile changes, cycle state, selection,
announcements, freshness, rendering, and publication ordering together. The
actual orchestration is not testable through the host's interface.

### Solution

Move race-day presentation state and action outcomes into a deep in-process
module. Retain the browser DOM as an adapter at the seam. The implementation
should own selection, cycle effects, freshness presentation, and scene
publication decisions.

### Benefits

- Race-day decisions gain locality
- DOM becomes a narrow adapter
- Interface becomes the test surface
- Leverage for future presentation modes

### Deletion test

Passes. Removing the presentation module would spread the same decision tree
back across render methods and event handlers.

### Testing direction

Provide source, output, profile, and cycle transitions through one interface and
assert the resulting render model plus requested effects without DOM setup.

```text
Before
source + output + profile + cycle -> RaceDayAppHost <-> DOM
                                    decisions mixed with rendering

After
source + output + profile + cycle -> [deep presentation module]
                                  -> render model/effects -> DOM adapter
```

## Candidate 5 — Deepen the fixture simulator session

**Recommendation:** Worth exploring

**Dependency category:** Ports and adapters
**Files:** `hub/simulator.js:1-246`, `tests/simulator-ui.test.mjs:13-74`

### Evidence

Pure transition rules live in `applySimulatorAction`, while snapshot ownership,
busy state, HTTP requests, optimistic transitions, accepted-state replacement,
and error recovery live in global browser code. Tests cover pure transitions but
not the ordering between action, publication, accepted snapshot, and failure.

### Problem

The narrow pure function leaves the fragile workflow in its caller. The current
module therefore has weak locality at the Fixture Hub publication seam and a
shallow interface for the actual scenario session.

### Solution

Create a deep scenario-session module that owns snapshot state, action
application, accepted-state replacement, busy/error state, and publication. DOM
and Fixture Hub transport become adapters at their seams.

### Benefits

- Workflow ordering gains locality
- Failure paths become testable
- Browser gains more leverage
- Global mutable state disappears

### Deletion test

Passes. Without the module, the publication workflow and recovery rules return
to the DOM caller.

### Testing direction

Use an in-memory Fixture Hub adapter to verify complete actions and failures
without DOM setup. Replace pure-only tests where behavior belongs at the session
interface.

```text
Before
DOM -> pure action -> HTTP -> global snapshot -> render

After
DOM adapter -> [deep scenario-session module] -> Fixture Hub adapter
```

## Top recommendation

Start with **Candidate 1: deepen connector race-state interpretation**. It is the
hottest correctness seam, recent fixes already demonstrate the value of the
module, and its current multi-step interface still leaks the source-authority
knowledge behind those regressions.

Follow immediately with **Candidate 2: unify polling and streaming ingestion**.
Once connector interpretation is deep, both delivery adapters can feed the same
ingestion module without duplicating trust choreography.

## Suggested implementation order

1. Select Candidate 1 and design its interface twice before changing callers.
2. Replace the current helper-level tests with interface-level scenario tests.
3. Move adaptation, quality, selection, schedule, and reconciliation behind the
   chosen seam without changing the frozen race-event v1 shape.
4. Run the complete software acceptance matrix and both firmware builds.
5. Select Candidate 2 and make poll/SSE acceptance share the deepened module.
6. Revisit Candidates 3–5 only after the two Hub hot spots stabilize.

Physical HUB75 behavior is outside this static architecture review. Software and
firmware builds must not be treated as physical display confirmation.
