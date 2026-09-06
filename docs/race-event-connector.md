# Race event connector

The browser display consumes `org.fpv.race-event.snapshot` version 1 from LiveTimeQue. The standard separates timing-system collection from display rendering: LiveTimeQue owns LiveFPV HTML/LiveTime compatibility, retries, cache, and freshness; this project owns the small projection from a current race to header, callsigns, video channels, and channel colors.

Channel colors now belong to the versioned race-day profile and are applied to every projected heat. Partial live packets may omit video metadata; `DisplayScene` resolves a missing assignment from the same pilot elsewhere in the event snapshot instead of clearing a previously known channel.

`web/race-status.js` is the shared consumer seam for race lifecycle presentation. It maps canonical Hub values and legacy LiveTime values such as `ready`, `racing`, and `completed` to the exact display labels `STAGING`, `RUNNING`, and `COMPLETE`; unsupported or missing values render as `UNKNOWN`. Connection state, source quality, and errors remain separate from the race status. A completed current heat uses the compact 5×7 `DONE Hx/y` header plus the optional completion bracket marker.

## Local use

1. Start LiveTimeQue with `npm run server` in its repository.
2. Run `npm run web` in this repository and open `http://localhost:4185/`. This dedicated origin avoids the old LiveTimeQue service worker on port `4175` and sends JavaScript modules with the MIME type required by browsers.
3. Keep **Connector URL** at `http://localhost:4174`.
4. Enter an HTTPS `*.livefpv.com` organization URL and enable **LiveTime source**.
5. `RaceSourceRuntime` keeps the event stream connected and performs periodic HTTP reconciliation. Failed updates never clear the last trusted state; the UI shows its age and can explicitly clear it from source settings.

The frontpage status bar records the arrival time of each accepted snapshot independently from the WLED transport. It shows whether the display is connected through USB serial or the network WebSocket, whether live output is actively controlling it, and the elapsed time since connector data arrived. It changes to a warning after two minutes without a new snapshot and to a critical stale-data state after ten minutes. **Stop & clear display** is a manual safety action: it disables live output, sends `activate(false)` when the display link is available, and returns control to the normal WLED fallback effect. It does not automatically stop the display.

Legacy HTTP reconciliation is lower priority than a newer trusted live observation for the same heat. A result-page snapshot can update the schedule, but it cannot roll a newer live `RUNNING` or `STAGING` status back to an older result status. If the source fails, the last trusted snapshot and its race status remain visible while the source quality is marked degraded.

The connector endpoint and standard are documented in LiveTimeQue under `docs/FPV-RACE-EVENT-DATA-V1.md`. Recorded fixtures remain a code-level adapter for repeatable tests and are intentionally absent from the production race-day UI.

## Completed-heat frontier protection

LiveTime can briefly report an older heat after the race manager navigates back in the local race view. If that packet is not an explicit `staging` or `running` transition, the central Hub selects the latest completed frontier instead of treating an unstarted source pointer as current. This prevents a stale `complete` packet for (for example) H9 from replacing a completed H12 on either consumer, while known later-round races such as Q10 H1 and H2 remain available as Next Up. An explicit active status remains the signal for a deliberate rerun.

## Hub runtime boundary

The display and LiveTimeQue can consume the same central Hub through `http://127.0.0.1:4175`. The [Start Race Day.cmd](../Start%20Race%20Day.cmd) launcher starts the Hub, the display server, and the neighboring LiveTimeQue connector, then opens both consumers in Hub mode. The Hub polls the connector for schedule data, consumes its LiveTime status stream, persists the last trusted snapshot under `data/race-data-hub.json`, and exposes the password-protected announcement admin at `/admin`. Direct LiveTimeQue mode on port `4174` remains available for migration and diagnostics, but it is not the central announcement path.

The GitHub Pages copy of the display is HTTPS. Browsers can block requests from it to a plain HTTP connector on the local PC, so local HTTP is the reliable race-day setup until the collector is hosted behind HTTPS.
