# Race Display Control Desk architecture

The race-day UI is composed by `RaceDayAppHost`. It is deliberately small: it wires four deep modules to the DOM and owns the automatic Current Heat / Next Up cycle.

## Modules and interfaces

- `RaceSourceRuntime` owns the complete source lifecycle behind `configure`, `setEnabled`, `subscribe`, and `getState`. It validates every incoming `org.fpv.race-event.snapshot`, keeps the last trusted snapshot, reconciles over HTTP, and reconnects the event stream. `HttpRaceSourceAdapter` and `RecordedRaceSourceAdapter` are the two adapters at this seam.
- `DisplayScene` owns schedule projection, missing-channel recovery, preset selection, stable WLED schema compilation, state bindings, and preview rendering. Preview and output consume the same scene. Live race text and pilots never participate in the schema hash.
- `OutputSession` owns USB/WebSocket connection state, protocol correlation, bounded reconnects, schema reconciliation, chunked state updates, deactivation, and pixel readback. USB serial and WLED WebSocket are internal adapters behind the same interface.
- `RaceDayProfile` owns the versioned portable configuration, defaults, validation, migration from the former DOM-shaped local storage, import/export, three semantic display presets, and channel colors. Browser device authorization is not stored.
- `RaceDayRuntime` is the small local composition root. It serves one canonical WebUI origin, proxies the connector through the same origin, and starts a configured or neighboring LiveTimeQue connector when one is not already running. `FPV_CONNECTOR_URL` and `LIVETIME_QUE_ROOT` keep deployment replaceable.

The modules are tested through their interfaces. Deleting any one would spread its lifecycle or invariants back into the page, so each passes the deletion test and provides locality and leverage.

## Stable schema rule

The schema contains the geometry for Current Heat, Staging Heat, and Next Up at the same time. Each preset has one header binding and one decoration-group binding. A state update selects the appropriate pair and updates the 16 pilot/channel bindings. This remains within WLED protocol v1 limits:

- no more than 40 scene nodes;
- no more than 24 bound values;
- no race text, callsign, channel, status, or schedule position in the schema hash.

Changing a structural preset option creates a new schema hash. `OutputSession` first tries the installed schema and automatically installs the current schema when it is missing or changed, then resumes the pending live state.

## Race-day state flow

1. `RaceSourceRuntime` accepts a validated snapshot and retains it as trusted state.
2. `DisplayScene` projects the Current, Next One, and After That races for the verification strip.
3. The selected view becomes one immutable scene for both browser preview and output values.
4. If cycling is enabled and the current race is `racing`, `RaceDayAppHost` alternates Current Heat and Next Up at the configured interval.
5. `OutputSession` sends the selected scene whenever Live output is enabled. Connection recovery and schema repair require no operator button sequence.
