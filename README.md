# FPV Race WLED Display

An 80×80 FPV race status display for WLED HUB75 builds. The compact **Race Display Control Desk** keeps LiveTime, the matrix preview, upcoming heats, WLED output, and pixel readback in one race-day WebUI.

**[Open the live 80×80 browser demo](https://kidce.github.io/Outdoor-FPV-Race-Display/)** — no WLED controller or LED matrix is required to experiment with layouts and the preview.

## Why this version is different

- Live updates send compact text, color, and effect values instead of a 19.2 KB RGB frame.
- USB serial and a dedicated WebSocket endpoint use the same versioned protocol.
- Active output defaults to a fully black background and 50% display brightness. The browser remembers both controls; an optional 1-25% background-effect level retains a deliberately dim WLED animation.
- Layouts are portable JSON schema files. Live output automatically installs a changed or missing schema before sending the next state.
- The renderer uses the WLED matrix buffer and does not allocate an additional 80×80 RGB framebuffer.
- The final mapped HUB75 output can be read back pixel by pixel over USB or WebSocket. The WebUI reconstructs the captured frame, verifies its checksum, and compares it with the browser preview.
- The same usermod can be compiled for the classic ESP32 HUB75 wiring and the Waveshare Matrix board target.
- Rainbow and subtle sparkle effects are available behind the WebUI's discreet, persistent **Special mode** switch, keeping the default race-day interface focused.
- Animated header arrows communicate race state at a glance: inward arrows for the current heat, upward arrows for a staged heat, right arrows for next up, and double right arrows for the following heat. Completed current heats use a compact `DONE Hx/y` header with an optional bracket marker.
- A versioned LiveTimeQue connector loads the current heat, pilot callsigns, video channels, and frequencies from the reusable FPV Race Event Data v1 snapshot format. The browser keeps the last valid state if a refresh fails.
- An optional Race Data Hub URL switches the source seam to `/api/v1/snapshot` plus the versioned SSE stream. The legacy connector remains available during migration, and Hub announcements retain their event identity and importance.
- A compact queue verification strip shows Current, Next One, and After That with their pilots and channels. An optional interval cycles the matrix between Current Heat and Next Up while a race is running.
- Current Heat, Staging Heat, and Next Up have independent semantic appearance presets. Their geometry is compiled into one stable schema, so normal heat, round, pilot, and channel changes do not trigger a schema reinstall.
- A portable versioned race-day profile stores presets, channel colors, source settings, and output settings, with import/export and migration from the former prototype settings.
- The frontpage keeps a compact FPV Race WLED Display status bar visible. It reports USB serial versus network WebSocket, whether live output is controlling the display, and the age of the last accepted connector snapshot. After two minutes without new connector data it warns; after ten minutes it marks the display as potentially stale. **Stop & clear display** sends `activate(false)` so the normal WLED fallback effect can resume.

## Project layout

- `wled/` contains the complete buildable WLED source snapshot, the verified HUB75 panel mapping, the FPV usermod, and both PlatformIO targets.
- `web/` contains the current browser UI.
- `schemas/` contains portable layout schemas.
- `firmware/` contains the last verified binaries.

The local WLED source is based on upstream commit `f49e541c5e4a90a78068ebbe7b2672555cb3227f`. Build caches, dependency folders, upstream tests, and the former Git checkout history are intentionally not included.

## Build

Run the builds from the bundled `wled` directory:

```powershell
cd wled
pio run -e esp32dev_hub75_p4_80x40_fpv
pio run -e waveshare_p4_80x40_fpv
```

For a complete local race-day setup, double-click [Start Race Day.cmd](Start%20Race%20Day.cmd) and follow the [starter guide](STARTER-GUIDE.md). It starts the central Race Data Hub on `4175`, the Race Display Control Desk on `4185`, and the neighboring LiveTimeQue connector/board on `4174`; it opens the Hub admin plus both consumers with Hub mode selected. The local announcement password is `local-race-day` unless you override `FPV_HUB_WRITE_PASSWORD`. The display-only [Start Race Display.cmd](Start%20Race%20Display.cmd) remains available for preview or direct-connector work. The [overnight work report](docs/WORK-REPORT-2026-09-06.md) records the orchestrated implementation and final review. The manual path is `npm run web`, then `npm run hub` in a second console, followed by the three URLs in the starter guide. Set `LIVETIME_QUE_ROOT` for a different checkout or `FPV_CONNECTOR_URL` for an existing connector. Enable **Enable output** to keep WLED or USB connected with automatic recovery, and **Live output** to send the selected scene. Missing or changed schemas are installed automatically; rare controls stay inside collapsed sections.

Use **Read displayed pixels** to freeze and inspect the frame currently held by the HUB75 output. For an unattended hardware check, run `python scripts/verify-frame-readback.py --transport websocket` or replace `websocket` with `usb --port COM7`.

The public demo is deployed automatically from the same WebUI file and its browser modules through GitHub Pages. Its preview, layout editor, schema export, and advanced effects work without hardware. USB access requires a compatible Chromium browser; connecting to a local WLED WebSocket from the HTTPS-hosted demo can be restricted by browser mixed-content rules, so the local HTTP version remains the reliable wireless-control option.

Prebuilt images are in `firmware/`:

- `WLED_ESP32_HUB75_FPV_factory.bin` is a merged first-install image for offset `0x0` and ordinary ESP flashing tools.
- `WLED_ESP32_HUB75_FPV_ota.bin` is the application image for WLED's firmware-update page, or offset `0x10000` with esptool.
- `WLED_Waveshare_HUB75_FPV_ota.bin` is the application image for the Waveshare ESP32-S3 Matrix board target.

Firmware flashing is fixed at 57600 baud because the tested CP210x link dropped out partway through larger images at 115200 baud. The live USB protocol remains at 115200 baud.

Protocol details are in [docs/protocol-v1.md](docs/protocol-v1.md). The canonical usermod source is [wled/usermods/fpv_race_display](wled/usermods/fpv_race_display).

LiveTime/LiveFPV connector setup is documented in [docs/race-event-connector.md](docs/race-event-connector.md).

Direct LiveTime packet discovery through the separately cloned RaceVision.Utility is documented in [docs/racevision-capture.md](docs/racevision-capture.md). The launcher asks only for the local LiveTime key, keeps it out of captures and Git, and records complete JSON payloads for connector mapping.

The deep-module layout and stable-schema invariant are documented in [docs/architecture.md](docs/architecture.md).

## Upstream and license

The bundled WLED snapshot remains copyright its original authors and is licensed under the EUPL-1.2-or-later; see [wled/LICENSE](wled/LICENSE). Project-specific additions preserve upstream attribution and are intended for eventual contribution to the relevant WLED and HUB75 projects.

## AI assistance disclosure

This project was developed with substantial assistance from OpenAI Codex. Architecture, implementation, tests, and documentation were reviewed and integrated by the project owner; physical display behavior still requires hardware validation.
