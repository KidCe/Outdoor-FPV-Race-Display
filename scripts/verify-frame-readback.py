#!/usr/bin/env python3
"""Exercise the FPV renderer and verify the final WLED/HUB75 RGB frame."""

import argparse
import base64
import copy
import json
import time


TEST_VALUES = [
    {"key": "header", "text": "READBACK", "color": 0xFFFFFF},
    {"key": "headerDecor", "color": 0xFFFFFF},
    {"key": "divider", "color": 0xFFFFFF},
]
SEMANTIC_BINDINGS = ("headerCurrent", "headerStaged", "headerNext", "headerNext2")
for index, (channel, pilot) in enumerate(
    (("R1", "ALPHA"), ("R2", "BRAVO"), ("F2", "CHARLIE"), ("F4", "DELTA"),
     ("R7", "ECHO"), ("R8", "FOXTROT"), ("L6", "GOLF"), ("L7", "HOTEL"))
):
    TEST_VALUES.extend((
        {"key": f"ch{index}", "text": channel, "color": 0xFFFFFF},
        {"key": f"pn{index}", "text": pilot, "color": 0xFFFFFF},
    ))


class ProtocolClient:
    def __init__(self, send_receive, attempts=1):
        self._send_receive = send_receive
        self._attempts = attempts
        self._sequence = 0

    def command(self, operation, **fields):
        self._sequence += 1
        envelope = {"fpv": {"p": 1, "sid": "verifyrb", "seq": self._sequence,
                            "op": operation, **fields}}
        last_error = None
        for _ in range(self._attempts):
            try:
                reply = self._send_receive(envelope)["fpv"]
                break
            except TimeoutError as error:
                last_error = error
        else:
            raise last_error
        if reply.get("seq") != self._sequence:
            raise RuntimeError(f"Unexpected sequence in reply: {reply}")
        if not reply.get("ok"):
            raise RuntimeError(f"{operation} failed: {reply.get('code')}")
        return reply


def websocket_client(url):
    import websocket
    socket = websocket.create_connection(url, timeout=6)

    def send_receive(envelope):
        socket.send(json.dumps(envelope, separators=(",", ":")))
        return json.loads(socket.recv())

    return ProtocolClient(send_receive), socket.close


def serial_client(port_name, baud):
    import serial
    port = serial.Serial(port=None, baudrate=baud, timeout=0.1, dsrdtr=False, rtscts=False)
    port.port = port_name
    port.dtr = False
    port.rts = False
    port.open()
    time.sleep(2.5)
    port.reset_input_buffer()

    def send_receive(envelope):
        port.write((json.dumps(envelope, separators=(",", ":")) + "\n").encode())
        deadline = time.monotonic() + 6
        pending = b""
        while time.monotonic() < deadline:
            pending += port.read(512)
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                marker = line.find(b'{"fpv"')
                if marker >= 0:
                    try:
                        return json.loads(line[marker:])
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
        raise TimeoutError("ESP32 did not answer over USB")

    return ProtocolClient(send_receive, attempts=3), port.close


def checksum_rgb(pixels):
    checksum = 0x811C9DC5
    for value in pixels:
        checksum = ((checksum ^ value) * 0x01000193) & 0xFFFFFFFF
    return checksum


def transaction_id():
    """Return a positive parser-safe transaction id for firmware state staging."""
    return max(1, int(time.time() * 1000) & 0x7FFFFFFF)


def capture(client, source):
    begin = client.command("frame.begin", source=source)
    capture_id = begin["capture"]
    try:
        metadata = begin
        for _ in range(60):
            if metadata.get("ready"):
                break
            time.sleep(0.05)
            metadata = client.command("frame.status", capture=capture_id)
        if not metadata.get("ready"):
            raise TimeoutError("Frame did not become ready")

        pixels = bytearray(metadata["total"] * 3)
        for offset in range(0, metadata["total"], 48):
            count = min(48, metadata["total"] - offset)
            chunk = client.command("frame.chunk", capture=capture_id, offset=offset, count=count)
            decoded = base64.b64decode(chunk["data"])
            if len(decoded) != chunk["count"] * 3:
                raise RuntimeError(f"Invalid chunk at pixel {offset}")
            pixels[offset * 3:offset * 3 + len(decoded)] = decoded
        if checksum_rgb(pixels) != metadata["checksum"]:
            raise RuntimeError("Frame checksum mismatch")
        return metadata, pixels
    finally:
        client.command("frame.end", capture=capture_id)


def capture_rows(client, source, rows):
    """Capture sparse rows so repeated hardware-coherency probes stay fast."""
    begin = client.command("frame.begin", source=source)
    capture_id = begin["capture"]
    try:
        metadata = begin
        for _ in range(60):
            if metadata.get("ready"):
                break
            time.sleep(0.05)
            metadata = client.command("frame.status", capture=capture_id)
        if not metadata.get("ready"):
            raise TimeoutError("Frame did not become ready")

        sampled = bytearray()
        width = metadata["width"]
        for row in rows:
            if row < 0 or row >= metadata["height"]:
                raise ValueError(f"Sample row {row} is outside the frame")
            row_start = row * width
            for offset in range(0, width, 48):
                count = min(48, width - offset)
                chunk = client.command(
                    "frame.chunk",
                    capture=capture_id,
                    offset=row_start + offset,
                    count=count,
                )
                decoded = base64.b64decode(chunk["data"])
                if len(decoded) != chunk["count"] * 3:
                    raise RuntimeError(f"Invalid chunk on row {row}")
                sampled.extend(decoded)
        return metadata, sampled
    finally:
        client.command("frame.end", capture=capture_id)


def install_schema(client, schema):
    canvas = schema["canvas"]
    client.command("schema.begin", schema=schema["schemaId"], hash=schema["schemaHash"],
                   revision=schema["revision"], width=canvas["width"], height=canvas["height"],
                   background=canvas["background"], fps=canvas["fps"])
    try:
        for node in schema["nodes"]:
            client.command("schema.node", node=node)
        client.command("schema.commit", activate=True)
    except Exception:
        client.command("schema.abort")
        raise


def semantic_values(active_binding):
    frame_values = [
        {"key": "headerFrame", "color": 0xFFFFFF, "visible": False}
    ]
    frame_values.extend(
        {"key": binding, "color": 0xFFFFFF, "visible": binding == active_binding}
        for binding in SEMANTIC_BINDINGS
    )
    return TEST_VALUES + frame_values


def apply_state(client, schema_id, schema_hash, values):
    transaction = transaction_id()
    chunks = [values[offset:offset + 8] for offset in range(0, len(values), 8)]
    for index, chunk in enumerate(chunks):
        fields = {
            "schema": schema_id,
            "hash": schema_hash,
            "tx": transaction,
            "replace": index == 0,
            "commit": index == len(chunks) - 1,
            "values": chunk,
        }
        if index == 0:
            fields.update(brightness=50)
        client.command("state", **fields)


def verify_static_body(client, samples, interval, stable_from_row):
    """Allow header animation while rejecting alternating pilot/body frames."""
    captures = []
    sample_rows = tuple(range(stable_from_row, 72, 6))
    for _ in range(samples):
        metadata, body_sample = capture_rows(client, "output", sample_rows)
        captures.append((metadata["checksum"], checksum_rgb(body_sample)))
        time.sleep(interval)

    full_checksums = sorted({full for full, _ in captures})
    body_checksums = sorted({body for _, body in captures})
    print(json.dumps({
        "samples": samples,
        "intervalSeconds": interval,
        "sampleRows": sample_rows,
        "fullFrames": [f"{value:08x}" for value in full_checksums],
        "bodyFrames": [f"{value:08x}" for value in body_checksums],
    }, separators=(",", ":")))
    if len(body_checksums) != 1:
        raise SystemExit(
            "FAIL: static pilot/body pixels alternate while only header animation is allowed"
        )
    print("PASS: static pilot/body pixels remained coherent across animated header frames")


def verify_atomic_update(client, schema_id, schema_hash):
    sample_rows = tuple(range(20, 72, 6))
    baseline_values = semantic_values("none")
    apply_state(client, schema_id, schema_hash, baseline_values)
    time.sleep(0.2)
    baseline, baseline_pixels = capture_rows(client, "output", sample_rows)

    changed_values = copy.deepcopy(baseline_values)
    changed_values[0]["text"] = "ATOMIC UPDATE"
    changed_values[10]["text"] = "UPDATED"
    chunks = [changed_values[offset:offset + 8] for offset in range(0, len(changed_values), 8)]
    transaction = transaction_id()
    client.command("state", schema=schema_id, hash=schema_hash, tx=transaction,
                   replace=True, commit=False, brightness=25, values=chunks[0])
    time.sleep(0.2)
    staged, staged_pixels = capture_rows(client, "output", sample_rows)
    for index, chunk in enumerate(chunks[1:], start=1):
        client.command("state", schema=schema_id, hash=schema_hash, tx=transaction,
                       replace=False, commit=index == len(chunks) - 1, values=chunk)
    time.sleep(0.2)
    committed, committed_pixels = capture_rows(client, "output", sample_rows)
    baseline_body = checksum_rgb(baseline_pixels)
    staged_body = checksum_rgb(staged_pixels)
    committed_body = checksum_rgb(committed_pixels)
    result = {
        "sampleRows": sample_rows,
        "baselineFrame": f"{baseline['checksum']:08x}",
        "beforeCommitFrame": f"{staged['checksum']:08x}",
        "afterCommitFrame": f"{committed['checksum']:08x}",
        "baselineBody": f"{baseline_body:08x}",
        "beforeCommitBody": f"{staged_body:08x}",
        "afterCommitBody": f"{committed_body:08x}",
    }
    print(json.dumps(result, separators=(",", ":")))
    if staged_body != baseline_body:
        raise SystemExit("FAIL: panel output changed before the complete state was committed")
    if committed_body == baseline_body:
        raise SystemExit("FAIL: committed state did not replace the panel output")
    print("PASS: incomplete state stayed invisible and committed atomically")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", choices=("websocket", "usb"), default="websocket")
    parser.add_argument("--url", default="ws://192.168.0.201/fpv/ws")
    parser.add_argument("--port", default="COM7")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--schema-file")
    parser.add_argument("--semantic-states", action="store_true")
    parser.add_argument("--semantic-state", choices=SEMANTIC_BINDINGS)
    parser.add_argument("--atomic-update", action="store_true")
    parser.add_argument("--stability-samples", type=int, default=0)
    parser.add_argument("--stability-interval", type=float, default=0.25)
    parser.add_argument("--stable-from-row", type=int, default=20)
    args = parser.parse_args()

    client, close = (websocket_client(args.url) if args.transport == "websocket"
                     else serial_client(args.port, args.baud))
    try:
        hello = client.command("hello")
        if args.schema_file:
            with open(args.schema_file, encoding="utf-8") as schema_file:
                schema = json.load(schema_file)
            install_schema(client, schema)
            schema_id, schema_hash = schema["schemaId"], schema["schemaHash"]
        else:
            schema_id, schema_hash = hello["schema"], hello["hash"]
        client.command("use", schema=schema_id, hash=schema_hash)
        if args.atomic_update:
            verify_atomic_update(client, schema_id, schema_hash)
            return
        if args.stability_samples:
            first_values = semantic_values("headerCurrent")
            apply_state(
                client,
                schema_id,
                schema_hash,
                first_values,
            )
            time.sleep(1.2)

            binding = args.semantic_state or "headerNext"
            second_values = copy.deepcopy(semantic_values(binding))
            replacements = {
                "header": "SECOND",
                "pn0": "INDIA",
                "pn1": "JULIET",
                "pn2": "KILO",
                "pn3": "LIMA",
            }
            for value in second_values:
                if value.get("key") in replacements:
                    value["text"] = replacements[value["key"]]
            apply_state(
                client,
                schema_id,
                schema_hash,
                second_values,
            )
            time.sleep(0.25)
            verify_static_body(
                client,
                args.stability_samples,
                args.stability_interval,
                args.stable_from_row,
            )
            return
        bindings = (SEMANTIC_BINDINGS if args.semantic_states else
                    (args.semantic_state,) if args.semantic_state else (None,))
        captures = []
        for binding in bindings:
            apply_state(client, schema_id, schema_hash,
                        semantic_values(binding) if binding else TEST_VALUES)
            time.sleep(0.25)
            captures.append((binding, *capture(client, "output")))
    finally:
        close()

    checksums = set()
    for binding, metadata, pixels in captures:
        colors = {tuple(pixels[index:index + 3]) for index in range(0, len(pixels), 3)}
        lit = sum(any(pixels[index:index + 3]) for index in range(0, len(pixels), 3))
        result = {
            "transport": args.transport,
            "state": binding or "default",
            "frame": metadata["frame"],
            "size": f"{metadata['width']}x{metadata['height']}",
            "pixels": metadata["total"],
            "lit": lit,
            "colors": len(colors),
            "checksum": f"{metadata['checksum']:08x}",
            "exact": metadata["exact"],
        }
        print(json.dumps(result, separators=(",", ":")))
        if not metadata["exact"]:
            raise SystemExit("FAIL: HUB75 output exposes occupancy only, not exact RGB")
        if not 0 < lit < metadata["total"] // 2 or len(colors) < 2:
            raise SystemExit("FAIL: output is blank or a mostly solid frame; rendered text did not reach HUB75")
        checksums.add(metadata["checksum"])
    if args.semantic_states and len(checksums) != len(SEMANTIC_BINDINGS):
        raise SystemExit("FAIL: semantic header states did not produce four distinct frames")
    print("PASS: sparse text frame reached the final HUB75 output buffer")


if __name__ == "__main__":
    main()
