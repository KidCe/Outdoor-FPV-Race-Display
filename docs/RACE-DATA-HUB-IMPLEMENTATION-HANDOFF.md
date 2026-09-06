# Race Data Hub Implementation Handoff

Status: implementation handoff; Package A contract frozen
Audience: LiveTimeQue agent, Outdoor FPV Race Display agent, Race Data Hub agent, and future relay work
Source decisions: [`RACE-DATA-HUB-ARCHITECTURE-REVIEW.md`](./RACE-DATA-HUB-ARCHITECTURE-REVIEW.md), [`RACE-DATA-HUB-ARCHITECTURE-WORK-INSTRUCTIONS.md`](./RACE-DATA-HUB-ARCHITECTURE-WORK-INSTRUCTIONS.md)
Frozen contract: [`../contracts/race-event/v1/README.md`](../contracts/race-event/v1/README.md)

## 1. Purpose

This document freezes the architecture decisions needed to implement a reusable local Race Data Hub and to split source collection from LiveTimeQue and Outdoor FPV Race Display.

The hub is the source and distribution layer. Consumers must not parse LiveFPV, LiveTime, RaceVision, or source-specific packets directly.

The implementation should keep one deep consumer-facing seam:

```text
Race Data Hub client interface
  -> bootstrap snapshot
  -> ordered stream
  -> status and freshness
  -> announcement history
```

The complexity of source matching, stale recovery, reruns, reconciliation, and atomic promotion belongs behind that seam.

## 2. Frozen decisions

### Event scope and identity

- A hub supports one active event at a time.
- The same hub can be configured for events from different organizers, including Rotormaniacs and Aircrasher.
- Event selection is explicit through a LiveFPV event URL or event identifier. Automatic discovery may assist the user but must not silently choose an event.
- The hub owns an `eventSessionId` and also retains upstream event references.
- The active event remains selected during transient source failures.
- `no_active_event` occurs only after explicit hub/event deactivation.
- On explicit event deactivation, the public active state is removed. Persisted data may remain archived but must not be served as the active event.

### Source authority

LiveFPV is the first implementation target and remains the primary source for:

- event identity and schedule;
- heat identity and ordering;
- pilots and lineup;
- channels and frequencies;
- current-race timing values when RaceVision is not implemented or unavailable.

RaceVision is an architectural extension point only in the first implementation. It will later be a complementary adapter for more precise and timely `start`, `running`, `stop`, and timing values. It does not own heat numbers, pilot identity, or lineup.

The source authority model is:

```text
LiveFPV  -> event, heat, schedule, pilots, lineup, channels, fallback timing
RaceVision -> future precise lifecycle and timing observations
```

LiveFPV values are valid even when they are less precise or slightly delayed than future RaceVision values. Missing or uncertain fields remain unknown or degraded; the hub must not invent them.

### Reruns and source corrections

- A rerun keeps the same `heatId`.
- Each run has a distinct `runId` or `attempt`.
- If LiveFPV does not provide a stable run identifier, the hub creates one after detecting a confirmed new execution of the same heat.
- A completed heat may legally return to `staging` or `running` because the race manager ordered a rerun.
- Status transitions are source-authoritative and are not rejected merely because they move backward from `complete`.
- A confirmed source correction creates a new source revision and a new published sequence.

### Hub runtime modes

#### Bundled local mode

- LiveTimeQue automatically starts or reuses a local hub for the end user.
- The bundled hub is loopback-only by default and is not automatically the event-LAN hub.
- The local hub provides local LiveFPV event data for that LiveTimeQue instance.
- The local bundled hub does not create event-wide announcements.
- LiveTimeQue also connects to the configured central or remote hub for announcements.
- If the remote hub is unavailable, local race data continues and LiveTimeQue shows a separate remote-announcement warning.
- LiveTimeQue repeatedly reconnects to the configured or discovered correct remote hub.

#### Event LAN mode

- A race host or manager manually starts one central LAN hub for the event.
- The hub binds to the LAN only when explicitly started in LAN mode.
- LAN consumers receive snapshots, status, streams, and announcements.
- LAN devices may create announcements after entering the shared event write password.
- The event LAN is treated as a trusted operational network.

#### Relay mode

- The central hub publishes the same event contract to a relay.
- Remote consumers connect to the relay, not directly to the source hub.
- Remote consumers are read-only in the first implementation.
- Remote access uses a simple event invite link containing a read token.
- The token is valid until the event session is explicitly ended or 14 days have elapsed, whichever comes first.
- A future remote admin login may add announcement write access through the relay, but it is not part of the first implementation.

There should normally be one authoritative central hub per event. If discovery unexpectedly finds more than one candidate, the client must warn and require a deliberate choice; it must not merge hubs or silently select an arbitrary one.

## 3. Core internal seam

The implementation must use this internal flow:

```text
Source adapters
  -> SourceObservation
  -> RaceStateAssembler
  -> RaceCandidate
  -> normalizer and validator
  -> Atomic Trusted Store
  -> hub HTTP/SSE interface
```

### SourceObservation

Source adapters emit typed, source-specific observations. They must not create the public v1 snapshot.

The LiveFPV adapter owns:

- explicit scoring URL validation;
- `/live/scoring/` retrieval;
- source parsing and source-specific diagnostics;
- source reconnect and refresh;
- current-heat identification from source-grounded scoring data;
- source revisions and capture timestamps.

### RaceStateAssembler

`RaceStateAssembler` is the deep internal module that owns:

- accumulating partial observations;
- matching current heat, pilots, channels, and timing;
- applying source authority rules;
- preserving proven values during stale periods;
- accepting legal source corrections and reruns;
- detecting uncertain identity matches;
- producing one complete `RaceCandidate`.

Consumers and source adapters must not duplicate this logic.

### Atomic Trusted Store

The store owns:

- the last accepted snapshot;
- the staged candidate;
- atomic promotion;
- event/session identity;
- source revisions;
- stream and snapshot sequences;
- persisted stale recovery;
- subscriber notification after promotion.

Persisted state must be written atomically, validated before loading, and recovered as `stale`. A source reconnect must replace it only after a new valid candidate is accepted.

## 4. Public data and transport contract

The payload contract remains:

```text
org.fpv.race-event.snapshot v1
```

The first local hub exposes:

```text
GET  /api/v1/health
GET  /api/v1/status
GET  /api/v1/snapshot
GET  /api/v1/stream
GET  /api/v1/announcements/history

POST /api/v1/announcements
POST /api/v1/announcements/{announcementId}/clear
```

The write endpoints are available to trusted event-LAN clients after the shared event write password is supplied. Relay consumers receive read access only in v1.

### Health and status

- `/health` means that the hub process can serve requests.
- `/status` reports source connection, event selection, freshness, reconnect state, remote-hub state, and readiness.
- A healthy process must not be interpreted as fresh race data.

### Stream semantics

SSE is the first read-only stream transport. A future WebSocket must carry the same contract, not a second incompatible data model.

Stream event types include:

```text
snapshot
status
warning
heartbeat
reset
announcement
announcement-clear
```

Use:

- `hubEpoch` for the lifetime of a hub process;
- `eventSessionId` for the selected event session;
- a shared `streamSequence` for ordering all stream envelopes;
- an optional `snapshotSequence` for accepted snapshot promotions.

Heartbeats do not represent new race data. A status or announcement change must still be ordered for all consumers.

SSE reconnect behavior:

- clients send `Last-Event-ID` when available;
- the hub replays bounded history when possible;
- otherwise it emits `reset` followed by the current snapshot and active announcements;
- a hub restart changes `hubEpoch`;
- an event change changes `eventSessionId`;
- an unknown or mismatched event must never silently appear as the selected local event.

### Freshness and provenance

The public snapshot must preserve per-domain quality. At minimum, quality must distinguish domains such as:

```text
schedule
lineup
timing
channels
```

Fresh timing must not make an old schedule or channel map appear fresh. Capture times remain source times; delivery time is transport metadata.

When LiveFPV disconnects:

- the last trusted snapshot remains visible;
- its original capture times remain unchanged;
- quality becomes stale or degraded;
- the hub sends a visible status transition;
- the hub reconnects internally while keeping consumer streams open.

The hub returns to live only after reconnect, fresh scoring retrieval, and confirmation that the data belongs to the selected event.

## 5. Announcement contract

Announcements are event-scoped and use a fixed Plain Text structure:

```json
{
  "announcementId": "...",
  "eventSessionId": "...",
  "title": "H18 Channels Changed",
  "body": "Pilot1 R1 -> R8, Pilot2 R8 -> R1",
  "importance": 3,
  "createdAt": "...",
  "createdByDeviceId": "...",
  "expiresAt": null,
  "status": "active"
}
```

Use fixed limits for v1, for example:

- title: 80 characters;
- body: 500 characters;
- plain text only; no HTML or Markdown.

The exact limits must be centralized in the contract validation rather than reimplemented by each UI.

### Importance behavior

- `1/3`: short transient notification;
- `2/3`: time-limited visible notification;
- `3/3`: persistent until cleared by the race manager.

All consumers receive announcements. Each consumer chooses the appropriate rendering, sound, blink, or push behavior. The hub sends semantic importance, not display-specific effect names.

The hub and relay keep multiple active announcements, ordered by importance and time. A consumer may present only one prominently while retaining the rest.

Global clear uses `announcementId` and is delivered to all connected consumers. A consumer may locally dismiss a message after a double confirmation; this only hides it on that consumer and does not globally clear it.

The relay and hub expose active announcements during bootstrap and keep an announcement history for 14 days. History includes active, cleared, and expired messages with their status timestamps. Read/unread state is local to each browser or device.

## 6. Consumer behavior

### LiveTimeQue

LiveTimeQue owns:

- user-facing queue and schedule views;
- local pilot projection;
- local notification presentation;
- Bundled Mode lifecycle controls;
- the hub Admin UI integration;
- local read/unread and local dismiss state.

In Bundled Mode it maintains two deliberately separate connections:

```text
local hub  -> local race data
remote hub -> central announcements
```

If local and remote hubs identify different events, LiveTimeQue continues to show remote announcements but displays a noticeable, non-blocking mismatch warning with the local and remote event context.

### Outdoor FPV Race Display

The display owns:

- current, staging, next, and after-next scene projection;
- channel colors and visual presets;
- WLED/USB/WebSocket output;
- source-age and hub-status presentation;
- announcement rendering, including the `3/3` special persistent effect.

It must not own source collection, source reconciliation, announcement authorisation, or timing inference.

### Hub UI

The hub owns a small independent Admin UI. It is the canonical interface for:

- active event selection;
- source configuration;
- hub mode and connection status;
- announcement creation and global clearing;
- event/session deactivation;
- diagnostics needed by the race manager.

LiveTimeQue may expose this same Hub UI as an Admin Mode subpage. The Hub UI and LiveTimeQue must not implement separate announcement domain logic.

## 7. Parallel work packages

The following packages can be assigned to separate agents after the contract package is frozen.

### Package A — Contract and conformance fixtures

Status: **frozen**. The canonical schemas, fixtures, and conformance tests live in [`../contracts/race-event/v1/README.md`](../contracts/race-event/v1/README.md) and `tests/race-event-contract.test.mjs`.

Owns:

- v1 snapshot schema and TypeScript/domain types where appropriate;
- transport envelope types;
- announcement types and validation;
- sample snapshots and announcement fixtures;
- conformance tests for sequences, quality, stale state, reruns, and history.

Dependencies: none. This package owns the public contract and must be completed first.

### Package B — Hub core

Owns:

- `SourceObservation`;
- `RaceStateAssembler`;
- normalizer and validator;
- Atomic Trusted Store;
- persistence and stale recovery;
- event/session identity;
- reconnect state machine;
- stream and snapshot sequencing.

Dependencies: Package A contract and fixtures.

### Package C — LiveFPV adapter

Owns:

- explicit scoring URL configuration;
- `/live/scoring/` retrieval;
- source parsing;
- source-specific reconnect and refresh;
- heat, pilot, channel, timing, and revision observations.

Dependencies: Package A interfaces. Package C must not edit consumer UI code.

### Package D — Hub transport and Hub UI

Owns:

- HTTP endpoints;
- SSE stream;
- bootstrap and history responses;
- LAN write-password handling;
- status and diagnostics;
- independent Hub Admin UI;
- local versus LAN binding modes.

Dependencies: Packages A and B. Package D must not duplicate assembler or source logic.

### Package E — LiveTimeQue integration

Owns:

- `RaceDataHubClient` integration;
- Bundled Mode startup and reuse;
- local hub connection;
- remote announcement connection;
- event mismatch warning;
- local read/unread and dismiss state;
- Hub UI Admin Mode integration.

Dependencies: Package A contract and Package D client interface. It may use mocks before the real hub is available.

### Package F — Outdoor FPV Race Display integration

Owns:

- hub bootstrap and SSE connector;
- last trusted display state;
- source-age and hub-status presentation;
- announcement rendering;
- reconnect and reset handling.

Dependencies: Package A contract. It must not import LiveTimeQue parser code.

### Package G — Relay

Owns:

- authenticated snapshot ingestion;
- read invite token validation;
- active snapshot and announcement fan-out;
- 14-day announcement history;
- remote consumer bootstrap and stream.

Dependencies: Packages A, B, and D. Do not make Package G a prerequisite for local operation.

## 8. Integration order

1. Package A contract and fixtures — complete and frozen.
2. Implement Package B with in-memory and replay adapters.
3. Put Package C behind the source adapter interface.
4. Add Package D local loopback transport and Hub UI.
5. Integrate Package E Bundled Mode and remote announcement handling.
6. Integrate Package F with replay and local hub fixtures.
7. Verify one local hub with multiple consumers.
8. Add explicit LAN mode and shared write password.
9. Implement Package G relay behavior.
10. Add future RaceVision observations without changing consumer interfaces.

## 9. Required acceptance tests

The implementation is not complete until these scenarios pass:

- explicit selection of a Rotormaniacs or Aircrasher LiveFPV event;
- no active event and explicit event deactivation;
- persisted snapshot restored as stale;
- LiveFPV socket or HTTP failure while SSE remains connected;
- reconnect, fresh `/live/scoring/` retrieval, and event confirmation;
- staging, running, complete, cancelled, and legal complete-to-rerun transitions;
- same `heatId` with a new `runId` or `attempt`;
- pilot reorder, renamed callsign, empty transition packets, and R8 preservation;
- source values missing or degraded without invented data;
- multiple consumers receiving identical stream ordering;
- late join receiving the current snapshot and active announcements;
- `Last-Event-ID` replay and reset after a gap or epoch change;
- announcement create, clear, expiry, history, local dismiss, and unread state;
- multiple active announcements ordered by importance and time;
- Bundled Mode local data with remote announcements;
- local/remote event mismatch warning;
- remote hub outage while local data continues;
- LAN write-password enforcement;
- relay invite token expiry after session end or 14 days;
- relay bootstrap, reconnect, and 14-day announcement history;
- slow-consumer backpressure and bounded queues.

## 10. Agent working rules

- Treat this document and the v1 contract as the current architecture source of truth.
- Do not add source-specific parsing to LiveTimeQue or Outdoor FPV Race Display.
- Do not let adapters create public snapshots directly.
- Do not infer heat order, pilot identity, channel, race completion, or timing when the source has not proven it.
- Keep the last trusted state visible during recoverable failures and mark it stale.
- Keep local race data and remote announcements separate in Bundled Mode.
- Do not create a second hub authority for the same event.
- Do not expose source credentials in snapshots, URLs, browser storage, or logs.
- Keep public interfaces small and deep; place complex behavior behind internal seams.
- Add tests at the same seam that consumers use.
- Do not implement RaceVision or remote relay write access in the first local-hub milestone.

## 11. Deferred work

- RaceVision adapter implementation and precise timing authority;
- remote admin login and relay announcement write access;
- simultaneous multi-event hub operation;
- WebSocket transport;
- full user accounts and per-user read state;
- permanent event archive;
- automatic event selection without explicit user confirmation.
