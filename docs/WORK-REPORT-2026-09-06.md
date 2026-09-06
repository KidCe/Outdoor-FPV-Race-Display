# Work Report — Orchestrated Outdoor FPV Race Display Session

**Session:** Night of 2026-09-05/06, Europe/Berlin  
**Project:** Outdoor FPV Race Display / Race Data Hub  
**Purpose:** Record what the parallel agents, the integration coordinator, and the final Sol-High architecture/test reviewer achieved.

## Executive summary

The project moved from a display prototype with a direct source connector to a contract-first, testable race-data architecture. The main repository now contains:

- a frozen Race Data Hub v1 contract with schemas and fixtures;
- a dependency-free Hub core with trusted state, persistence, stale recovery, HTTP/SSE transport, announcements, and validation;
- an optional Hub consumer in the display application while the legacy connector remains available;
- deterministic queue projection for Current, Next One, and After That;
- replay-driven integration and end-to-end coverage;
- LiveFPV research documenting why “next heat” cannot safely be derived from an arbitrary result-array position;
- RaceVision capture tooling and verified firmware build targets;
- a final review branch with additional architecture, reliability, and checker fixes.

The overnight integration result is `main` at `4f24a7a` (`Harden Hub identity and URL validation`). The later Sol-High review produced three additional local commits in a separate worktree. They were intentionally not pushed or merged into `main` during the session.

## Agent topology and orchestration

The work was completed in successive loops:

```text
Main orchestrator
├─ Hub core worker
├─ LiveTimeQue / consumer-scope worker
├─ Outdoor display integration worker
├─ LiveFPV and Next Up research worker
└─ Luna-Max integration coordinator
   └─ Sol-High final reviewer
      ├─ Luna-Max architecture-boundaries worker
      ├─ Luna-Max bug/security/state worker
      └─ Luna-Max test/integration/reliability worker
```

The relevant Codex task IDs were:

| Role | Task ID | Result |
| --- | --- | --- |
| Main overnight orchestrator | `01a073a2-fdff-71b1-a6b5-663b0ab33d25` | Coordinated the initial workstreams |
| Hub core | `01a07415-e5cb-7632-bee9-848e56ef8f4a` | Hub platform slice, initially 23/23, then continued and hardened |
| LiveTimeQue / consumer scope | `01a07415-e87e-76d2-90c0-727474c2b13f` | Consumer-side seam was inspected; no separate LiveTimeQue repository commit was required in the final target result |
| Outdoor display integration | `01a07415-f7e9-74e0-9dbc-9f57469defa2` | Hub client/display integration and replay coverage |
| LiveFPV research | `01a07426-7f01-7d33-9a2b-63c4ebf77298` | Source-grounded research report; the first run hit a usage limit and was resumed |
| Integration coordinator | `01a07464-4d0b-7170-ae96-ea7245e2ebcd` | Waited for workers, integrated commits, added E2E coverage, and performed the first full audit |
| Final Sol-High reviewer | `01a07492-cbb3-73b1-a999-59f2bc683234` | Orchestrated the final architecture/test review and fixed findings |
| Architecture boundaries subtask | `01a07493-c030-7152-8c65-f9571038125e` | Atomic output and architecture-boundary fixes |
| Bug/security/state subtask | `01a07494-0b0c-7281-9c01-f5dbc95adfd6` | Hub identity, stale/recovery, and state validation fixes |
| Test/integration/reliability subtask | `01a07494-2d36-7da2-90f6-5663db0e2540` | SSE, checker, integration, and regression-test fixes |

The first worker starts did not all carry an explicit reasoning level. Follow-up runs were therefore sent explicitly with `gpt-5.6-luna` and `max`. The final reviewer was started explicitly with `gpt-5.6-sol` and `high`, and each of his three subtasks was explicitly started with Luna-Max.

## What the initial workstreams achieved

### 1. Frozen contract and base seams

The foundation loop froze the public `org.fpv.race-event` v1 shape before production integration began. It added:

- snapshot, stream-envelope, announcement, clear, and history schemas;
- fresh, stale, rerun, announcement, and reset fixtures;
- implementation handoff and work instructions;
- explicit event/session identity and quality semantics;
- a clear seam between source observations, assembly, validation, trusted state, and consumers;
- RaceVision capture documentation and a guarded Windows launcher.

The contract files were treated as read-only by later workers. The final review confirmed that the frozen contract had zero changes in the review diff.

### 2. Race Data Hub core

The Hub worker implemented a small dependency-free core in `hub/index.mjs`:

- `SourceObservation` and `RaceStateAssembler` for source-specific observations;
- explicit event selection and event-session identity;
- `TrustedStore` with atomic stage/promote behavior;
- persistence and stale recovery;
- source corrections, reruns, and run attempts;
- stream sequence and Hub epoch handling;
- HTTP health, status, snapshot, and SSE endpoints;
- announcement creation, history, clearing, and write-password protection;
- Hub Admin assets and diagnostics;
- strict snapshot, identity, URL, quality, and envelope validation.

The first Hub slice passed 23/23 tests. After the continuation review and added persistence, announcement, SSE, and replay coverage, the integrated Hub slice passed 33/33.

### 3. Display-side Hub integration

The display application now has one source seam feeding the existing scene and output pipeline. Hub mode is opt-in; the legacy connector remains available. The integration added:

- Hub snapshot bootstrap and typed SSE consumption;
- sequence, epoch, event-session, quality, and stale-state checks;
- local trusted-state recovery;
- Current, Next One, and After That projection;
- Hub announcement display with importance 1/2/3 behavior;
- explicit queue-slot handling without inventing a replacement heat;
- replay-driven display, source, and mocked-output coverage.

The display integration was integrated as `28c07ea` from upstream worker commit `88bbaa4`. The separate LiveTimeQue repository was not modified as part of the final target-repository integration; its role was represented through the versioned consumer contract and multi-consumer end-to-end tests.

### 4. Architecture and LiveFPV research

The research and documentation loop added:

- the full Race Data Hub architecture review;
- implementation handoff and work instructions;
- a LiveFPV investigation covering scoring pages, results pages, heat sheets, qualifiers, brackets, finals, statuses, source IDs, and reruns;
- a conservative proposal for deriving Next Up from source-grounded schedule identity.

The important source lesson was that result-page order, timestamps, heat numbers, and bracket order are not interchangeable. The display must use proven schedule IDs and must show degraded/unknown state instead of guessing.

## Integration and review loops

### Loop 1 — Freeze the contract first

The first decision was to make the v1 contract the shared boundary. Workers were instructed not to invent parallel snapshot or announcement formats. This allowed the Hub, consumer, research, and display work to proceed in separate worktrees without silently drifting apart.

### Loop 2 — Parallel work, then isolated critical continuations

The four workstreams ran in parallel. The coordinator waited for terminal results, required commits where code was changed, and preserved uncommitted parent work. The LiveFPV research worker reached a usage-limit interruption and was resumed with an explicit Luna-Max continuation. An early coordinator fork became idle without performing the full integration, so a fresh coordinator task was created with the complete repository path and worker list.

### Loop 3 — Dependency-ordered integration

The integration coordinator committed the frozen foundation first, then integrated the Hub core, then the display consumer. A README-only conflict occurred because two branches added AI-assistance disclosures; it was resolved by keeping one complete disclosure and retaining the project documentation. Code and tests were kept intact.

### Loop 4 — Replay-driven architecture hardening

The first combined audit found two real display correctness gaps:

1. the display could fall back to `races[]` array position instead of explicit schedule IDs;
2. a missing requested Next/After-Next slot could duplicate a lower queue item.

Both paths were corrected and covered by focused tests. A later audit found that a Hub snapshot marked `stale` was being accepted by the consumer as `live`; the connection mapping and regression test were corrected. The integrated result finished at 55/55 tests.

### Loop 5 — Sol-High final review with Luna-Max subtasks

The Sol reviewer worked in `codex/final-architecture-review` and was explicitly instructed to fix findings, not only list them. He started three Luna-Max subtasks in the same isolated worktree and assigned each a separate concern. After the subtasks returned, Sol integrated their changes, reran the full suite, ran the package-specific checker, built WLED and both PlatformIO targets, and verified the final clean tree and frozen-contract boundary.

## Findings fixed by the final reviewer

The final review found and fixed several issues that were not visible in the earlier green suite:

- `OutputSession` could expose 17 state values through three visible intermediate output states. State publication was changed to an atomic transaction-bound sequence with stronger ACK, chunk, size, and checksum checks.
- Hub validation could accept a partially empty Current-Race identity that the consumer later rejected. The authoritative Hub now rejects the incomplete candidate at its own boundary.
- SSE bootstrap events could advance a global sequence without being delivered to existing consumers. The stream now uses canonical shared sequencing and history, composite Hub-epoch/sequence event identity, deterministic gap and epoch reset behavior, late-consumer replay, and history pruning.
- Stale recovery and parallel refresh paths were hardened so trusted data remains visible but is not incorrectly reported as fresh.
- The old CommonJS/VM `verify-display-controls` checker called the removed `buildLayoutSchema` API. It was replaced with a check against the current ESM `DisplayScene`/`RaceDayProfile` seam.
- A delayed-source regression was added so older asynchronous results cannot overwrite newer accepted state.

The final reviewer’s three commits are:

1. `c0e9795d4d25fc28ed3882d7a85f0116a36771ec` — `Make display state updates atomic and defensive`
2. `c166159a2037acee5f879787b0ca345130a0e4a9` — `Make Hub recovery and stream cursors canonical`
3. `fe5ac2aab93b6842ad5281dfbb1bf9ca611ebb88` — `Restore deterministic display and Hub reliability checks`

## Tests and validation

| Stage | Result |
| --- | --- |
| Frozen-contract baseline | 20 baseline tests passed before integration |
| Hub core worker | 23/23, then 33/33 after continuation hardening |
| Display/consumer worker | 23/23; one queue-index expectation was corrected during replay work |
| First combined integration | 47/47 |
| Hardened integration | 53/53, then 55/55 after the stale-status regression fix |
| Final Sol review root suite | 67/67: Hub/client/persistence/E2E 40/40, display/output/architecture 17/17, contract/connector 10/10 |
| Display-control checker | 19/19 |
| HTTP/MIME/404/traversal harness | 10/10 |
| JavaScript/Python syntax | 23 JavaScript modules and 1 Python helper passed |
| WLED package tests | 16/16 |
| WLED web build | Successful |
| PlatformIO classic ESP32 target | `esp32dev_hub75_p4_80x40` successful; RAM 24.6%, Flash 81.8% |
| PlatformIO Waveshare target | `waveshare_p4_80x40` successful; RAM 15.2%, Flash 41.4% |
| Formatting/diff checks | `git diff --check` clean |
| Frozen contract comparison | 0 contract changes in the final review diff |

The final review worktree ended clean. No reviewer changes were pushed to a remote.

## Intermediate failures and how they were resolved

| Moment | What failed or was wrong | Resolution |
| --- | --- | --- |
| Initial Hub patch | The patch targeted a README heading that did not exist; no files were changed | The worker corrected the target and reapplied the patch safely |
| Display replay test | An assertion assumed the wrong position for the second queued heat | The assertion was aligned with the actual `current, staging, next, after-next` schedule model |
| First integrated audit | Array-position fallback and queue duplication could produce the wrong displayed heat | Projection was changed to explicit schedule IDs and missing slots remain blank |
| Stale-state audit | A stale Hub snapshot could appear as a live/green connection | Connection derivation was corrected and a regression test was added |
| Final reviewer suite | 63/64: history-pruned bootstrap expected `3 !== 2` | The expectation was reconciled with canonical reset-plus-bootstrap semantics; the suite reached 67/67 |
| Package checker | `ReferenceError: buildLayoutSchema is not defined` | The outdated VM checker was migrated to the current ESM scene/profile seam; 19/19 passed |
| HTTP harness | One check used an obsolete fixture path | It was changed to the versioned fixture path; 10/10 passed |
| First firmware command | Obsolete `_fpv` PlatformIO environment names were used | The actual current targets were discovered and both builds passed |
| Waveshare build | PlatformIO encountered a locked framework/cache package | The package was reinstalled and the build then completed successfully |
| Orchestration | The research worker hit a usage limit and an early coordinator fork became idle | The research task was resumed with Luna-Max and a fresh integration coordinator was started |

## Main learnings

1. **A passing unit suite is not enough for integration confidence.** The 47/47 and 55/55 suites were valuable, but the final reviewer still found atomic-output, SSE, stale-state, and checker defects through targeted negative and late-join scenarios.
2. **The public contract must be enforced at the authoritative boundary.** It is not sufficient for only the browser consumer to reject malformed identity; the Hub must refuse to publish it.
3. **Explicit schedule identity beats array position.** A `races[]` array is a payload collection, not automatically the audience-facing queue order.
4. **SSE sequence numbers are shared protocol state.** Private bootstrap events cannot consume a global sequence unless the same canonical history and reset semantics are available to every consumer.
5. **Trusted stale data is a deliberate state, not an error to erase.** Keeping the last valid snapshot visible is useful, but the UI must make its age and degraded/reconnecting state unmistakable.
6. **The output protocol needs transaction semantics.** Sending individually valid chunks can still show an invalid intermediate picture to a human observer. The visible display state must change as one logical update.
7. **Research changed the implementation direction.** The original temptation was to derive Next Up from the next array item or result ordering. Real LiveFPV observations showed that qualifiers, brackets, finals, result ordering, and current scoring views do not share one universal order. The safe rule is source-grounded identity plus conservative degraded output.
8. **Worker scope and workspace boundaries matter.** Separate worktrees protected `main`, and explicit path checks were required after the Sol reviewer initially issued read-only commands against the main path.
9. **Model and reasoning settings must be explicit for orchestration.** The session confirmed that omitted reasoning values can produce model defaults. Later continuations and all final review subtasks explicitly used Luna-Max; the final reviewer explicitly used Sol-High.

## What remains unverified or deliberately deferred

- No physical WLED controller, HUB75 panel, COM port, or real race-day LAN was used. Output atomics and readback were tested with mocks, and both firmware targets compiled successfully.
- A real browser `EventSource` run was not repeated in the final review; HTTP-SSE behavior was tested with a fetch-based client.
- The actual LiveTimeQue repository is separate from this project. The contract seam and simulated/multi-consumer flows are tested, but the two repositories still need a deliberate live integration acceptance test.
- The Hub server still uses `Access-Control-Allow-Origin: *`. Writes are password-protected, but a production event-LAN deployment should bind deliberately and use an Origin allowlist.
- The production RaceVision timing adapter, remote relay behavior, and full live-event parser/fixture corpus remain follow-up work.
- Firmware builds retain existing upstream warnings in experimental HUB75/audio/DMX and older library code; no new warning was treated as a hardware proof.

## Git traceability

The overnight `main` integration sequence was:

```text
86eeae1  Freeze Race Data Hub v1 contract and base seams
38ece6d  Add Race Data Hub core and local transport
28c07ea  Integrate Race Data Hub into display
6a3ce20  Harden Hub display integration and replay coverage
0fa5562  Document Race Data Hub architecture review
ff66d0f  Document LiveFPV next-up research
43f24db  Polish architecture review formatting
71c2ca4  Keep stale Hub status visible
4f24a7a  Harden Hub identity and URL validation
```

The final Sol review is isolated on branch `codex/final-architecture-review`, based on `4f24a7a`, with the three commits listed above. `main` was clean at the end of the overnight integration, and the reviewer worktree was also clean. The later Windows starter and starter-guide files are follow-up usability work from this conversation, not part of the three review commits.

## Provenance

This report was compiled from the repository Git history, local Codex task results, worker completion messages, and final validation output. Architecture, implementation, tests, and documentation were produced with substantial OpenAI Codex assistance under project-owner direction. Physical display behavior remains the owner’s hardware-validation responsibility.
