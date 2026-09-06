# RaceVision LiveTime capture

The local capture launcher prepares RaceVision.Utility and records the raw packets needed to validate a future direct LiveTime connector. It does not copy RaceVision source into this repository and does not expose the LiveTime key to the browser.

## Run a capture

1. Start LiveTime on this computer and enable its RaceVision interface.
2. Double-click `Start RaceVision Capture.cmd` in the repository root.
3. Enter the LiveTime key in the hidden prompt.
4. Exercise one complete sequence: staging, race start, a few laps, race finish, advance to the next heat, and staging again.
5. Type `quit` and press Enter in the capture window.

The launcher finds the cloned `RaceVision.Utility` repository automatically, builds the inspected commit on first use, and connects to `127.0.0.1:54235`. Captures are stored locally under `%LOCALAPPDATA%\RaceVision.Utility\captures\<timestamp>` and contain:

- `racevision-console.log`: every packet accepted by RaceVision after its internal per-type coalescing;
- `data\<PacketType>.json`: the latest full payload for every packet type;
- `data\RaceEntryByRaceResponse<RaceLID>.json`: per-race entry payloads when requested;
- `capture-manifest.json`: timestamps, source commit, exit code, and a file inventory without the key.

The temporary RaceVision `config.json` is written below `%LOCALAPPDATA%\RaceVision.Utility\capture-runtime` and removed in a guarded `finally` block. The key is not written to the capture directory, repository, browser storage, command line, or manifest.

Captures can contain pilot names and other event data. Keep the raw folder private. Before committing a fixture or sending it to another person, create a redacted copy and verify it manually.

## Alternate LiveTime computer

The default expects LiveTime on the same Windows computer. For a trusted race-LAN host, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-racevision-capture.ps1 -LiveTimeAddress 192.168.1.50
```

The RaceVision protocol uses unencrypted HTTP transport. Do not expose port `54235` to the internet or an untrusted network.

## Setup validation

This checks repository discovery, the pinned-source build, and launcher paths without asking for a key or opening a LiveTime connection:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-racevision-capture.ps1 -ValidateOnly
```
