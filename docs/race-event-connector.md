# Race event connector

The browser display consumes `org.fpv.race-event.snapshot` version 1 from LiveTimeQue. The standard separates timing-system collection from display rendering: LiveTimeQue owns LiveFPV HTML/LiveTime compatibility, retries, cache, and freshness; this project owns the small projection from a current race to header, callsigns, video channels, and channel colors.

Channel colors now belong to the versioned race-day profile and are applied to every projected heat. Partial live packets may omit video metadata; `DisplayScene` resolves a missing assignment from the same pilot elsewhere in the event snapshot instead of clearing a previously known channel.

## Local use

1. Start LiveTimeQue with `npm run board` in its repository.
2. Run `npm run web` in this repository and open `http://localhost:4185/`. This dedicated origin avoids the old LiveTimeQue service worker on port `4175` and sends JavaScript modules with the MIME type required by browsers.
3. Keep **Connector URL** at `http://localhost:4174`.
4. Enter an HTTPS `*.livefpv.com` organization URL and enable **LiveTime source**.
5. `RaceSourceRuntime` keeps the event stream connected and performs periodic HTTP reconciliation. Failed updates never clear the last trusted state; the UI shows its age and can explicitly clear it from source settings.

The frontpage status bar records the arrival time of each accepted snapshot independently from the WLED transport. It shows whether the display is connected through USB serial or the network WebSocket, whether live output is actively controlling it, and the elapsed time since connector data arrived. It changes to a warning after two minutes without a new snapshot and to a critical stale-data state after ten minutes. **Stop & clear display** is a manual safety action: it disables live output, sends `activate(false)` when the display link is available, and returns control to the normal WLED fallback effect. It does not automatically stop the display.

The connector endpoint and standard are documented in LiveTimeQue under `docs/FPV-RACE-EVENT-DATA-V1.md`. Recorded fixtures remain a code-level adapter for repeatable tests and are intentionally absent from the production race-day UI.

The GitHub Pages copy of the display is HTTPS. Browsers can block requests from it to a plain HTTP connector on the local PC, so local HTTP is the reliable race-day setup until the collector is hosted behind HTTPS.
