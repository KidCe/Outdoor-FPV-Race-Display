# Upstreaming plan

Keep the work split into independent changes so maintainers can review each concern on its own:

1. Publish the FPV renderer and schema protocol as a WLED usermod first. It has no required changes to WLED core APIs and can mature without coupling race-specific UI changes to WLED releases.
2. Propose the 80x40 SM5166P panel mapping separately to `ESP32-HUB75-MatrixPanel-DMA`, backed by the working mapper test and photographs. The panel mapping belongs in the display driver rather than the FPV renderer.
3. Update WLED's HUB75 integration only after the mapper is available upstream, exposing the driver/mapping choice without race-display-specific code.
4. Add the Waveshare Matrix board as a separate build target or documented preset after its physical pinout and panel output have been validated.

Before opening a pull request, reduce the usermod to a focused example schema, document memory and flash usage for classic ESP32 and ESP32-S3, run formatting/static checks, and test schema upload, serial control, WebSocket control, reboot persistence, missing-schema errors, and malformed input on hardware.

The browser editor can remain a separate companion project. Its exported JSON format is the stable seam; WLED does not need a firmware update when the editor adds a layout that can be represented by existing primitives.
