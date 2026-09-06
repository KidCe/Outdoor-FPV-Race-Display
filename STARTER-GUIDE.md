# FPV Race WLED Display — Starter Guide

This guide is the shortest safe path from “nothing running” to a verified race display. Start with the browser and preview; connect WLED hardware only after the preview and race data look correct.

## 1. Start the WebUI

On Windows, double-click **Start Race Day.cmd** in this repository.

It opens:

- the Race Data Hub admin at `http://127.0.0.1:4175/admin`;
- the Race Display Control Desk at `http://127.0.0.1:4185/` with Hub mode enabled;
- the LiveTimeQue board at `http://127.0.0.1:4174/?backend=hub&hub=http%3A%2F%2F127.0.0.1%3A4175&variant=A` with Hub mode enabled.
- the neighboring `LiveTimeQue` connector on port `4174` when it is available and not already running.

Leave the **FPV Race Display Server** and **Race Data Hub Server** console windows open while using the WebUI. Stop each process with `Ctrl+C` in its console. Closing the browser alone does not stop the servers.

If the starter is unavailable, use PowerShell in the repository folder:

```powershell
npm run web
```

Then open `http://127.0.0.1:4185/` manually. Node.js 20 or newer is recommended. This repository has no npm package installation step; the local server uses Node's built-in modules.

The existing **Start Race Display.cmd** is the display-only fallback. **Start RaceVision Capture.cmd** is for later packet capture from LiveTime and is not needed for the normal race-day setup.

The local Hub uses `https://techdroneleague.livefpv.com/` as its default upstream event and stores trusted state in `data/race-data-hub.json`. To use another event, set `FPV_HUB_SOURCE_URL` before starting the Hub. The default local write password is `local-race-day`.

## 2. Use the central Hub

1. Open **Race Data Hub Admin**.
2. Confirm the status shows a selected event and a recent snapshot. The Hub polls the LiveTimeQue connector and also listens to its live status stream.
3. Enter `local-race-day` in **Shared event write password**.
4. Use **Create announcement** to publish a title, body, and importance. The announcement is event-scoped and is delivered to every Hub consumer, including the Control Desk.
5. Use **Clear globally** when the announcement is no longer needed.
6. In either consumer, confirm the source label says **Race Data Hub** and the updated time advances.

## 3. First test: browser and preview, no hardware

1. Confirm that the page title is **Race Display Control Desk** and the preview canvas is visible.
2. Leave **Enable output** and **Live output** off.
3. Open **LiveTime source settings**.
4. Confirm **Race Data Hub URL** is `http://127.0.0.1:4175` and **LiveTime source** is enabled.
5. Confirm the event name, current heat, queue, and pilot names appear.

Expected result: the top source status becomes **Race Data Hub connected**, the event name and pilots appear, the queue shows **Current**, **Next One**, and **After That**, and the preview renders the selected heat. If the source is unavailable, the UI should show an error while retaining any last trusted data.

Now click **Current Heat**, **Next Up**, and **After Next**. Change one of the preset controls and confirm that the preview changes. Export a profile from **Portable race-day profile** so the working settings can be restored later.

## 4. Connect WLED hardware

Do this only after the preview is correct.

### Wireless WLED

1. Put the WLED controller and this PC on the same network.
2. Open **Display output settings** and select **Wireless WLED**.
3. Enter the controller URL, for example `http://192.168.0.201/`.
4. Keep **WLED background effect** at `0%` for the first test and use a low brightness if the panel is close to you.
5. Enable **Enable output** and wait for `connected`.
6. Only then enable **Live output**.

Expected result: **Live output** becomes active, the schema is installed automatically, and **Last display update** changes from `Never` to a recent time. Compare the physical 80×80 panel with the browser preview.

### USB serial

1. Select **USB serial**.
2. Leave the live protocol baud rate at `115200`.
3. Enable **Enable output** and select the correct COM port in the browser permission dialog.
4. Enable **Live output** only after the connection status is `connected`.

Use **Stop & clear display** before disconnecting or changing the controller. This disables live control and returns the normal WLED fallback effect.

## 5. Tests worth doing in order

1. **Static preview:** current heat, next heat, pilot names, channel colors.
2. **Heat switching:** use the three view tabs and confirm that the displayed state follows the selected tab.
3. **Live update:** change the source state or wait for a new heat; confirm that the queue, preview, and panel update together.
4. **Reconnect:** briefly restart WLED or disconnect Wi-Fi/USB. Confirm that the UI reports reconnecting and recovers without refreshing the page.
5. **Schema repair:** change a structural preset option, then enable live output again. Confirm that the new schema is installed and output resumes.
6. **Pixel readback:** click **Read displayed pixels**, first with **Panel output buffer**, then with **Logical WLED framebuffer**. Compare the result with the preview and optionally use **Download PNG**.
7. **Safe stop:** click **Stop & clear display** and confirm that live control is off and the fallback WLED effect resumes.

For software-only regression tests, run this from the repository root:

```powershell
npm test
```

## 6. If something does not work

- **Browser does not open:** open `http://127.0.0.1:4185/` manually and check the server console.
- **Hub source error:** confirm the Hub console is running, port `4174` is available, the URL is an HTTPS `*.livefpv.com` organization URL, and the PC has internet access.
- **Consumer shows direct LiveTime:** reload with the Hub URL above or open Source settings and select **Central Race Data Hub**.
- **No pilots or preview:** check that **LiveTime source** is enabled and read the message below the output summary.
- **WLED does not connect:** verify the controller IP, network, firmware target, and that the chosen transport matches the connection.
- **USB permission/port problem:** use Chrome or Edge, close other serial tools, and reconnect the controller.
- **Old settings cause confusion:** use **Reset profile**, then configure the source and output again. Export the profile once it works.

Do not flash firmware or test a live panel at full brightness while the output session is still controlling it. Physical panel wiring, brightness, Wi-Fi range, USB stability, and real race timing still need hardware validation.
