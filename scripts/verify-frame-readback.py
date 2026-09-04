#!/usr/bin/env python3
"""Exercise the FPV renderer and verify the final WLED/HUB75 RGB frame."""

import argparse
import base64
import json
import time


TEST_VALUES = [
    {"key": "header", "text": "READBACK", "color": 0xFFFFFF, "effect": "none"},
    {"key": "headerDecor", "text": "", "color": 0xFFFFFF, "effect": "none"},
    {"key": "divider", "text": "", "color": 0xFFFFFF, "effect": "none"},
]
for index, (channel, pilot) in enumerate(
    (("R1", "ALPHA"), ("R2", "BRAVO"), ("F2", "CHARLIE"), ("F4", "DELTA"),
     ("R7", "ECHO"), ("R8", "FOXTROT"), ("L6", "GOLF"), ("L7", "HOTEL"))
):
    TEST_VALUES.extend((
        {"key": f"ch{index}", "text": channel, "color": 0xFFFFFF, "effect": "none"},
        {"key": f"pn{index}", "text": pilot, "color": 0xFFFFFF, "effect": "none"},
    ))


class ProtocolClient:
    def __init__(self, send_receive):
        self._send_receive = send_receive
        self._sequence = 0

    def command(self, operation, **fields):
        self._sequence += 1
        envelope = {"fpv": {"p": 1, "sid": "verifyrb", "seq": self._sequence,
                            "op": operation, **fields}}
        reply = self._send_receive(envelope)["fpv"]
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
                    return json.loads(line[marker:])
        raise TimeoutError("ESP32 did not answer over USB")

    return ProtocolClient(send_receive), port.close


def checksum_rgb(pixels):
    checksum = 0x811C9DC5
    for value in pixels:
        checksum = ((checksum ^ value) * 0x01000193) & 0xFFFFFFFF
    return checksum


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", choices=("websocket", "usb"), default="websocket")
    parser.add_argument("--url", default="ws://192.168.0.201/fpv/ws")
    parser.add_argument("--port", default="COM7")
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()

    client, close = (websocket_client(args.url) if args.transport == "websocket"
                     else serial_client(args.port, args.baud))
    try:
        hello = client.command("hello")
        client.command("use", schema=hello["schema"], hash=hello["hash"])
        client.command("state", schema=hello["schema"], hash=hello["hash"], replace=True,
                       brightness=50, backgroundEffect=0, values=TEST_VALUES)
        time.sleep(0.25)
        metadata, pixels = capture(client, "output")
    finally:
        close()

    colors = {tuple(pixels[index:index + 3]) for index in range(0, len(pixels), 3)}
    lit = sum(any(pixels[index:index + 3]) for index in range(0, len(pixels), 3))
    result = {
        "transport": args.transport,
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
    print("PASS: sparse text frame reached the final HUB75 output buffer")


if __name__ == "__main__":
    main()
