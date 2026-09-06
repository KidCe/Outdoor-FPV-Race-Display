# Race Event Contract v1

Status: frozen contract for the Race Data Hub seam

This directory is the machine-readable and fixture-backed reference for `org.fpv.race-event.snapshot` version 1.

The contract is transport-independent. HTTP, SSE, relay, replay, and future WebSocket implementations carry this contract but must not create incompatible payload shapes.

## Canonical files

- `snapshot.schema.json` — accepted public race snapshot.
- `stream-envelope.schema.json` — ordered SSE/future-stream envelope.
- `announcement.schema.json` — active, cleared, expired, or historical announcement.
- `announcement-create.schema.json` — write request for a new announcement.
- `announcement-clear.schema.json` — write request for a global clear.
- `history-response.schema.json` — paged announcement history response.
- `fixtures/` — representative source-independent examples used by conformance tests.

## Compatibility rule

The current Outdoor FPV Race Display connector still consumes the earlier direct LiveTimeQue connector shape. That legacy path is not the Hub seam. Hub integrations must conform to the schemas in this directory and may provide a deliberate compatibility adapter while migration is in progress.

Consumers must not depend on source-specific packet positions, HTML selectors, socket events, credentials, or parser-only fields.

## Contract invariants

1. `format` is exactly `org.fpv.race-event.snapshot`.
2. `version` is exactly `1` for this contract.
3. One hub has one active `eventSessionId` at a time.
4. A published snapshot is a complete, atomically accepted candidate.
5. Unknown values are represented as `null` or omitted according to the schema; they are never invented from array position or timing guesses.
6. `capturedAt` is source capture time. `deliveredAt` belongs to the transport envelope.
7. `hubEpoch` identifies one hub process lifetime. `eventSessionId` identifies one selected event session. `streamSequence` orders every stream envelope.
8. A heartbeat does not represent a new snapshot.
9. A rerun keeps `heat.id` and changes `runId` or `attempt`.
10. A local read/unread or dismiss state is not part of the canonical announcement state.

## Validation ownership

The Hub normalizer and validator are the authoritative runtime validators. Consumers validate the envelope and the public snapshot before accepting it, but they must not add source-specific interpretation to that validation.

The JSON Schemas describe the public wire contract. They do not replace domain checks such as current-race identity matching, source revision ordering, or atomic candidate promotion.

