# Deterministic race-day acceptance

Run the public acceptance replay with:

```powershell
npm run test:e2e
```

The runner starts a temporary fixture Hub as a separate process, injects fixed `org.fpv.race-event.snapshot` v1 payloads through the gated `POST /api/v1/test/snapshot` fixture route, and consumes the normal read-only Hub API:

- `GET /api/v1/health`
- `GET /api/v1/status`
- `GET /api/v1/snapshot`
- `GET /api/v1/stream`
- the authenticated announcement create/clear routes

The injection route is enabled only by `scripts/race-day-fixture-server.mjs`; the normal `hub/local-server.mjs` does not expose it. It uses the same write-password authorization and snapshot validation as the other Hub admin writes.

The replay covers initial staging, running, complete current, valid and missing Next Up, independently timed Complete/Next-Up cycling, heat changes, a Mains round transition, stale/unknown data, announcements, schema/authorization rejection, transport loss, persisted reload, Hub epoch reset, and fresh recovery. The actual `RaceDayAppHost` is driven against a small DOM surface so user-visible labels, queue slots, status text, announcement state, and cycle phase/view are checked.

When the sibling `LiveTimeQue` checkout is present, the runner loads its exported public `HubBackend` and compares Current, Next, and Current status against the same Hub snapshot at each replay stage. Set `LIVETIME_QUE_ROOT` to override its location. Set `NO_COLOR=1` or pass `--no-color` to disable ANSI output; failures are red by default and include a category, scenario, expected value, and observed value.

This replay deliberately stops at software/public-interface validation. It does not access MCU firmware, WLED hardware, USB, or COM7.
