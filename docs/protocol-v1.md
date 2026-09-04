# FPV display protocol v1

Every command and response uses a single JSON envelope:

```json
{"fpv":{"p":1,"sid":"a1b2c3d4","seq":42,"op":"hello"}}
```

USB serial uses one JSON object per line. Wireless clients connect to `ws://WLED-IP/fpv/ws`. Responses repeat `p` and `seq` and include `ok` plus a stable machine-readable `code`. `sid` identifies the controller session; retrying the same `sid` + `seq` is idempotent, so a lost acknowledgement cannot duplicate a schema node.

## Schema identity

A layout is identified by three fields:

- `schemaId`: stable human-readable identity, up to 24 characters on the device.
- `schemaHash`: content identity, up to 16 characters.
- `revision`: schema authoring revision.

`use` succeeds only when both ID and hash match an installed layout. Expected failures are `schema_missing` and `schema_hash_mismatch`. This prevents a controller from filling bindings into an incompatible layout.

## Operations

| Operation | Purpose |
| --- | --- |
| `hello`, `ping` | Detect protocol support. |
| `use` | Load an installed schema by ID and hash. |
| `state` | Replace or patch bound values. |
| `activate` | Enable or disable the overlay. |
| `schema.begin` | Start a chunked schema installation. |
| `schema.node` | Append one validated scene node. |
| `schema.commit` | Persist and optionally activate the schema. |
| `schema.abort` | Discard the in-progress layout. |

The chunked installation path keeps every serial/WebSocket message small. The module settings page additionally accepts a complete exported JSON schema file and compiles it into a fixed-size binary scene in WLED's filesystem.

## Layout model

Protocol v1 supports `text`, `rect`, `line`, and `polyline` nodes. A node may have a `bind` key. State values update the text, RGB color, and `none`, `rainbow`, or `glitter` effect for that binding without changing the installed geometry.

Any node can optionally animate without controller traffic by declaring `motion` as `left`, `right`, `up`, or `down`. `motionDistance` is constrained to 0–4 pixels and defaults to 1; `motionPeriod` is constrained to 200–5000 ms and defaults to 900. The ESP32 applies a subtle triangular movement and renders it at the schema's configured frame rate. Omitting `motion` keeps the node static.

## Displayed-frame readback

Protocol v1 also supports a frozen, chunked RGB readback over USB serial and `/fpv/ws`. This reads the final WLED framebuffer or the mapped HUB75 output without allocating a second 80×80 buffer on the ESP32.

1. Send `frame.begin` with `source` set to `output` (mapped HUB75 output in screen coordinates) or `logical` (WLED framebuffer).
2. Poll `frame.status` with the returned `capture` ID until `ready` is true.
3. Request `frame.chunk` with `capture`, `offset`, and a `count` of at most 48 pixels. `data` is base64 RGB888; every pixel contributes exactly four base64 characters.
4. Continue until `total` pixels have been read, verify the FNV-1a `checksum`, then send `frame.end`.

The capture automatically releases after 30 seconds if a client disconnects. `exact: false` means an unbuffered HUB75 driver can report only black versus non-black occupancy.

`state` also accepts two display controls:

- `brightness`: global display brightness from 0 to 100 percent.
- `backgroundEffect`: retained WLED effect brightness from 0 to 25 percent. Zero is the default and replaces the complete segment with the schema background, normally black.

Example state update:

```json
{
  "fpv": {
    "p": 1,
    "sid": "a1b2c3d4",
    "seq": 43,
    "op": "state",
    "schema": "fpv-race-80x80-v1",
    "hash": "c52ed049",
    "replace": true,
    "brightness": 50,
    "backgroundEffect": 0,
    "values": [
      {"key":"header","text":"CURRENT HEAT Q12 H22/23","color":16777215},
      {"key":"ch0","text":"R1","color":16777215},
      {"key":"pn0","text":"KILLIANFPV","color":16777215,"effect":"glitter"}
    ]
  }
}
```

## Limits in v1

- 40 scene nodes
- 24 bound values
- 12 points per polyline
- 40 characters per text value
- Canvas dimensions up to 255×255

These fixed limits make memory use deterministic on classic ESP32 boards.
