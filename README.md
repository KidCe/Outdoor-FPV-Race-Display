# FPV Race WLED Display

An 80×80 FPV race status display for WLED HUB75 builds. The browser UI edits the layout and race data, while the WLED usermod renders text, geometry, rainbow, and subtle glitter effects directly on the ESP32.

**[Open the live 80×80 browser demo](https://kidce.github.io/Outdoor-FPV-Race-Display/)** — no WLED controller or LED matrix is required to experiment with layouts and the preview.

## Why this version is different

- Live updates send compact text, color, and effect values instead of a 19.2 KB RGB frame.
- USB serial and a dedicated WebSocket endpoint use the same versioned protocol.
- Active output defaults to a fully black background and 50% display brightness. The browser remembers both controls; an optional 1-25% background-effect level retains a deliberately dim WLED animation.
- Layouts are portable JSON schema files. Install a schema once, then select it by ID and hash.
- The renderer uses the WLED matrix buffer and does not allocate an additional 80×80 RGB framebuffer.
- The same usermod can be compiled for the classic ESP32 HUB75 wiring and the Waveshare Matrix board target.
- Rainbow and subtle sparkle effects are available behind the WebUI's discreet, persistent **Special mode** switch, keeping the default race-day interface focused.
- Animated header markers communicate race state at a glance: inward chevrons for the current heat, upward chevrons for a staged heat, right chevrons for next up, and double right chevrons for the following heat.

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

Open [web/fpv-race-wled-80x80.html](web/fpv-race-wled-80x80.html) through a local HTTP server in Chrome or Edge. Connect WLED, click **Install current schema** once, then enable **Live output**. The exported schema can also be uploaded under WLED Usermods settings → **Manage layout schemas**.

The public demo is deployed automatically from the same WebUI file through GitHub Pages. Its preview, layout editor, schema export, and advanced effects work without hardware. USB access requires a compatible Chromium browser; connecting to a local WLED WebSocket from the HTTPS-hosted demo can be restricted by browser mixed-content rules, so the local HTTP version remains the reliable wireless-control option.

Prebuilt images are in `firmware/`:

- `WLED_ESP32_HUB75_FPV_factory.bin` is a merged first-install image for offset `0x0` and ordinary ESP flashing tools.
- `WLED_ESP32_HUB75_FPV_ota.bin` is the application image for WLED's firmware-update page, or offset `0x10000` with esptool.
- `WLED_Waveshare_HUB75_FPV_ota.bin` is the application image for the Waveshare ESP32-S3 Matrix board target.

The project fixes the wired upload rate at 115200 baud because higher rates produced verified serial corruption on the test setup.

Protocol details are in [docs/protocol-v1.md](docs/protocol-v1.md). The canonical usermod source is [wled/usermods/fpv_race_display](wled/usermods/fpv_race_display).

## Upstream and license

The bundled WLED snapshot remains copyright its original authors and is licensed under the EUPL-1.2-or-later; see [wled/LICENSE](wled/LICENSE). Project-specific additions preserve upstream attribution and are intended for eventual contribution to the relevant WLED and HUB75 projects.

## AI assistance disclosure

This project was developed with substantial assistance from OpenAI Codex. Architecture, implementation, tests, and documentation were reviewed and integrated by the project owner; physical display behavior still requires hardware validation.
