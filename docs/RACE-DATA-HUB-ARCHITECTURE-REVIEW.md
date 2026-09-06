# Race Data Hub Architecture Review

Status: architecture review  
Review date: 2026-09-06  
Reviewed document: [`RACE-DATA-HUB-ARCHITECTURE-WORK-INSTRUCTIONS.md`](./RACE-DATA-HUB-ARCHITECTURE-WORK-INSTRUCTIONS.md)

## Executive assessment

The proposed direction is sound: source-specific timing-system work belongs in a reusable local Race Data Hub, while LiveTimeQue and Outdoor FPV Race Display remain consumers of one versioned race-event contract.

The plan is not yet implementation-ready without clarification. The most important gaps are:

1. how a consumer discovers or selects the active event;
2. how LiveFPV and RaceVision data are combined when neither source is complete alone;
3. which internal module assembles source observations into a complete candidate;
4. exact sequence, reconnect, reset, and freshness semantics;
5. which native process owns the bundled hub lifecycle.

Overall assessment: **strong direction, approximately 8/10, with a short architecture-definition phase required before Phase L1.**

## Strengths of the plan

- It separates source collection from both user interfaces.
- It treats `org.fpv.race-event.snapshot` as a versioned, transport-independent data contract.
- It keeps LiveTime, LiveFPV, RaceVision, WLED, notifications, and UI preferences in distinct responsibility areas.
- It requires atomic snapshot promotion instead of exposing partially merged heats.
- It preserves the last trusted state during failures.
- It explicitly prohibits invented race completion, channel assignments, and next-heat ordering.
- It keeps the remote relay optional and prioritizes reliable local operation.
- It defines replay as a first-class adapter for deterministic tests and demos.

## Critical findings

### 1. Active-event discovery and source configuration are undefined

The proposed consumer endpoints require an `eventId`:

```text
GET /api/v1/events/{eventId}/snapshot
GET /api/v1/events/{eventId}/stream
```

A new consumer does not yet know that ID. The plan also does not define how a LiveFPV organization URL, RaceVision connection, or replay is selected and associated with an event.

The first local implementation should explicitly support **exactly one active event session**. It should provide either:

```text
GET /api/v1/events
GET /api/v1/events/active
```

or, for the smallest first version:

```text
GET /api/v1/snapshot
GET /api/v1/stream
```

The plan must also define:

- where source configuration is stored;
- who is allowed to change it;
- how an event change is detected;
- whether an upstream event ID or a hub-owned event key is used;
- how consumers learn that one event has replaced another.

Multi-event support should be deferred until the single active-event lifecycle is reliable.

### 2. LiveFPV and RaceVision require source composition, not only adapter selection

The current wording says that the hub starts and stops the selected source adapter. That describes mutually exclusive sources, but the available data indicates a likely hybrid:

| Data domain | Preferred source | Fallback |
| --- | --- | --- |
| Schedule and Next Up | LiveFPV heat sheets | last trusted schedule |
| Channel and frequency | LiveFPV heat sheets | last proven assignment |
| Current race status and clock | RaceVision or LiveFPV socket | the other live source |
| Pilot identity | heat-sheet identity combined with live IDs | last validated match |
| Timing and position | RaceVision or LiveFPV socket | omit when unproven |

The architecture therefore needs to support multiple observations for one logical event. A single adapter may still own several private transports, but the hub needs a defined composition policy when multiple adapters are active.

The plan should distinguish:

- **alternative adapters**, such as replay versus live operation;
- **complementary adapters**, such as RaceVision timing plus LiveFPV schedule data;
- authority and fallback rules per data domain;
- conflict handling and degradation warnings.

### 3. A RaceStateAssembler module is missing

The plan currently moves from source adapters to the hub, normalizer, and atomic store. No module clearly owns the accumulation and fusion of partial source observations.

Add a deep internal module such as:

```text
RaceStateAssembler
  accept(observation)
  buildCandidate()
```

Its implementation should own:

- current-race matching;
- joining live driver data to heat-sheet pilots;
- field-authority rules;
- preservation of proven channel assignments;
- empty transition-packet handling;
- multi-source conflict detection;
- construction of one complete internal candidate.

The resulting flow becomes:

```text
Source adapters
  -> source observations
RaceStateAssembler
  -> complete internal candidate
Normalizer and validator
  -> public v1 snapshot
Atomic race state store
  -> accepted snapshot and subscriber notification
```

This prevents source-fusion rules from leaking into adapters, the normalizer, the store, or consumer applications.

### 4. Adapter output and normalizer ownership are ambiguous

The LiveFPV adapter is described as producing normalized state, while the normalizer is described as the only module allowed to create a public v1 snapshot. Internal source DTOs are also allowed to differ by adapter.

Use explicit terminology:

- adapters emit typed, source-specific `SourceObservation` values;
- the assembler creates a complete `RaceCandidate`;
- only the normalizer creates `org.fpv.race-event.snapshot` v1;
- only the validator and atomic store may accept that snapshot for publication.

Adapters should never create the public contract directly.

## High-priority findings

### 5. Sequence, epoch, SSE replay, and reset semantics need definition

The transport envelope repeats `capturedAt` and `deliveredAt`, which already exist in the snapshot. It is also unclear when `sequence` changes.

Define these rules before implementation:

- `sequence` increases only when a validated candidate is atomically promoted;
- a heartbeat does not increment the snapshot sequence;
- `capturedAt` describes when source data was accepted;
- `deliveredAt` is generated when a snapshot is delivered and is not canonical stored state;
- every hub process/session has a `hubEpoch` or `sessionId`;
- SSE uses `id: <hubEpoch>:<sequence>`;
- clients reconnect with `Last-Event-ID`;
- the hub either replays a bounded history or emits `reset` followed by the current snapshot;
- a hub restart changes the epoch so sequence reuse cannot be mistaken for a duplicate;
- status, warning, heartbeat, and reset envelopes have defined schemas.

These semantics are required for multiple clients to observe the same ordered snapshot history.

### 6. Snapshot freshness is too coarse for hybrid data

A new clock packet can be fresh while schedule or channel data is old. Updating one global `capturedAt` risks making the whole snapshot appear fresh.

Before freezing v1, add optional per-domain quality metadata, for example:

```json
{
  "quality": {
    "state": "degraded",
    "domains": {
      "schedule": { "state": "stale", "capturedAt": "..." },
      "lineup": { "state": "fresh", "capturedAt": "..." },
      "timing": { "state": "fresh", "capturedAt": "..." }
    }
  }
}
```

An alternative is a `sources[]` section that records contribution, revision, and capture time. In either design, fresh timing must not hide an outdated schedule or channel mapping.

### 7. Atomic-store persistence and restart recovery are unspecified

The last trusted snapshot currently has no defined lifetime beyond the process. For race-day use, recovery after a hub restart should be explicit.

Recommended behavior:

- persist the last accepted snapshot locally;
- write to a temporary file and promote it with an atomic rename;
- validate the persisted file before loading;
- recover it as `stale`, never `fresh`;
- replace it only after a source has produced a new valid candidate;
- document retention and cleanup when the active event changes.

If the first implementation intentionally uses only an in-memory store, that limitation must be visible in Phase L3 and the acceptance criteria.

### 8. The bundled process lifecycle has no clear owner

The plan assigns bundled-mode hub lifecycle controls to LiveTimeQue UI while also describing LiveTimeQue as a browser consumer. A browser cannot directly start or supervise a local sidecar process. If only LiveTimeQue starts the hub, Race Display also acquires a hidden dependency on another product.

Prefer an independent Race Data Hub process:

```text
Race Data Hub process
  <- LiveTimeQue launcher
  <- Race Display launcher
  <- manual or operating-system startup
```

The native launcher owns:

- single-instance locking;
- port selection and discovery;
- PID and lifecycle management;
- graceful shutdown;
- log paths and diagnostics;
- configuration-file ownership;
- detection and reuse of an already running hub.

The browser UI may expose controls, but it should communicate with a native launcher or a protected local administration interface rather than owning process management itself.

### 9. Reconnect behavior needs one deterministic state machine

The plan currently allows either internal source reconnect or closure of the consumer stream. Select one primary behavior.

Recommended source lifecycle:

```text
disabled
  -> connecting
  -> handshaking
  -> joining
  -> reconciling
  -> live
  -> degraded
  -> reconnecting
```

The hub should normally reconnect the source internally while keeping SSE clients connected. The client SSE stream should close only when the hub or transport itself can no longer serve it.

Required details:

- exponential backoff with jitter;
- room rejoin after socket reconnection;
- HTTP reconciliation on startup, rejoin, heat-identity change, and periodically;
- `live` only after a successful room join and a source-grounded race match;
- independent heartbeat while no race values change;
- an explicit timeout from `reconciling` to `degraded` or `stale`.

Add an acceptance test in which the upstream socket dies while SSE remains open, reconnects, and then publishes a newer heat without restarting the consumer.

### 10. Pilot and race identity need provenance and confidence

Matching RaceVision, LiveFPV heat sheets, and live socket data by callsign or array position is unsafe.

Internal identities should retain:

- source type and source-owned ID;
- normalized name;
- match method;
- confidence;
- optional manually confirmed aliases;
- lineup or source revision.

When the match is uncertain, timing and channel values must remain unjoined and create a quality warning. The public snapshot should not expose misleading combined data.

## Additional findings

### Notification ownership is incomplete

The plan assigns notification decisions and local delivery to the notification engine, while LiveTimeQue owns browser permissions and subscription UI. Clarify the delivery environment:

- a pure Notification Decision Engine compares snapshots and emits deduplicated reminder events;
- LiveTimeQue delivers local browser or service-worker notifications;
- the relay worker delivers remote push notifications;
- each delivery adapter owns its retry and delivery receipt state.

This keeps notification policy testable with replay snapshots without forcing the local hub to impersonate a browser notification context.

### LAN security needs an explicit profile

Loopback should remain the default. Enabling Event LAN mode should be an explicit action.

Define:

- allowed browser origins instead of unconditional CORS `*`;
- whether event data is intentionally unauthenticated on the LAN;
- a separate protected administration interface for source changes;
- RaceVision-key storage using an operating-system credential store;
- secret and personal-data redaction in logs and diagnostics;
- optional read tokens for LAN clients;
- relay credential rotation and replay protection.

### Update rate and backpressure are not defined

Clock updates can arrive much more frequently than schedule changes. Publishing a full event snapshot for every raw tick is unnecessary.

The hub should:

- publish immediately for heat, status, lineup, channel, or result changes;
- coalesce high-frequency clock/timing updates to a documented maximum rate;
- send heartbeats independently;
- avoid unbounded per-consumer queues;
- disconnect or reset consumers that fall too far behind.

### Health and source readiness should be separate

`GET /api/v1/health` should indicate that the hub process can serve requests. It should not imply that the timing source is connected or fresh.

Expose source readiness through either:

```text
GET /api/v1/status
```

or the active-event response and status stream. This avoids interpreting a healthy process as healthy race data.

### Repository and package ownership need a decision

The plan does not state where the reusable hub implementation lives. For the first migration, keep it in one repository as a clearly isolated package or directory instead of creating another repository immediately. Extract it only after the internal interface and deployment model have proven stable.

The chosen location must not make Outdoor FPV Race Display import LiveTimeQue UI code. Communication between products remains exclusively through the hub client interface and versioned contract.

### Migration needs an explicit removal phase

The plan preserves old routes during migration but does not state when duplicate parser, retry, and freshness logic is removed.

Add a final local-migration step:

1. switch both consumers to the hub client;
2. run compatibility and fault-injection tests;
3. deprecate old routes visibly;
4. remove old source parsing from LiveTimeQue UI and Race Display;
5. verify that only the hub contains source-specific code.

## Recommended Phase L0

Add a short architecture-definition phase before Phase L1:

### Phase L0: Resolve the runtime and data semantics

1. Define a single active-event lifecycle and discovery interface.
2. Define `SourceObservation` and `RaceCandidate`.
3. Add `RaceStateAssembler` and a field-authority matrix.
4. Define complementary versus alternative source adapters.
5. Define epoch, sequence, reset, heartbeat, and SSE replay rules.
6. Define per-domain freshness and provenance.
7. Decide whether the trusted store survives process restarts.
8. Assign the hub process lifecycle to a native launcher.
9. Define loopback, LAN, and relay security profiles.

After Phase L0, the existing L1-L5 and D1-D3 sequence remains appropriate.

## Recommended core interfaces

Keep the consumer-facing interface small:

```text
RaceDataHubClient
  readActiveSnapshot()
  subscribe(listener)
  getStatus()
```

Keep the source interface internal:

```text
RaceSourceAdapter
  open(config, observationSink, abortSignal)
  refresh(reason)
  close()
```

Keep state assembly internal to the hub:

```text
RaceStateAssembler
  accept(observation)
  buildCandidate()
```

The normalizer, validator, atomic store, source transports, and reconnection state machine are private implementation details behind the hub interface. They should not become concepts that every consumer must understand.

## Test additions

Add a shared adapter and connector conformance suite covering:

- startup with no source data;
- startup from a persisted stale snapshot;
- staging, running, complete, cancelled, and repeated heats;
- heat advance while the previous heat remains not-run;
- empty driver transition packets;
- pilot reorder and renamed callsign;
- explicit R8 channel preservation;
- source disagreement and confidence warnings;
- socket disconnect and room rejoin;
- HTTP reconciliation failure with live timing still active;
- schedule becoming stale while timing remains fresh;
- duplicate and out-of-order observations;
- multiple SSE clients receiving identical sequences;
- late join receiving the current snapshot immediately;
- `Last-Event-ID` replay and reset after a sequence gap;
- hub restart with a new epoch;
- slow-consumer backpressure;
- relay unavailable while local mode remains healthy.

Tests should primarily exercise the deep hub and adapter interfaces. Raw parser fixtures remain useful as internal tests, but source-specific packet positions should not become part of the consumer-facing interface.

## Corrected architectural summary

The target architecture should be described as:

```text
Timing sources
  -> source adapters
  -> RaceStateAssembler
  -> normalizer and validator
  -> atomic trusted store
  -> Race Data Hub client interface
  -> LiveTimeQue, Race Display, notifications, and optional relay
```

The snapshot contract itself is not the seam. The Race Data Hub client interface, including bootstrap, subscription, ordering, freshness, and error behavior, is the seam. `org.fpv.race-event.snapshot` is the payload contract carried through that interface.

## Final recommendation

Proceed with the Race Data Hub design after completing Phase L0. Do not begin by moving files alone. First lock down the active-event lifecycle, source-composition rules, observation/candidate interfaces, sequence semantics, and native process ownership.

The most important structural addition is `RaceStateAssembler`. It gives the hub one deep consumer-facing interface while keeping source matching, hybrid fusion, reconnect, reconciliation, freshness, and atomic promotion local to one implementation.
