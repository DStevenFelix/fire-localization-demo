"""Receive Waymark signal states directly from the six physical controllers."""
from __future__ import annotations

import asyncio
import json
import logging
import re

LOGIN_REQUEST = b"@BFCDBBA7B6CBC0E0D0CD|%"
HEARTBEAT = b"noop"
DEVICE_IPS = {f"192.168.1.{suffix}" for suffix in range(111, 117)}
LIGHT_FRAME = re.compile(rb"CAB5CAB1D7B4CCAC\|([0-9a-fA-F]{64})")
COLORS = {
    0: "off", 1: "red", 2: "green", 3: "yellow", 4: "green_flash",
    5: "red_flash", 6: "yellow_flash", 0x11: "red_flash",
    0x12: "yellow_flash", 0x13: "green_flash",
}
log = logging.getLogger(__name__)


def decode_lights(frame: bytes) -> list[dict] | None:
    match = LIGHT_FRAME.fullmatch(frame)
    if not match:
        return None
    data = bytes.fromhex(match[1].decode("ascii"))
    if any(code not in COLORS for code in data[::2]):
        return None
    return [{"color": COLORS[code], "countdown": seconds}
            for code, seconds in zip(data[::2], data[1::2])]


class TrafficSignals:
    def __init__(self, host: str, port: int):
        self.host, self.port = host, port
        self.server: asyncio.Server | None = None
        self.connections: dict[str, asyncio.StreamWriter] = {}
        self.tasks: set[asyncio.Task] = set()
        self.devices: dict[str, dict] = {}
        self.changed = asyncio.Event()

    async def start(self):
        if self.host in {"", "off"}:
            return
        try:
            self.server = await asyncio.start_server(self.receive, self.host, self.port)
        except OSError as exc:
            log.warning("Signal receiver unavailable on %s:%s: %s", self.host, self.port, exc)

    async def stop(self):
        server, self.server = self.server, None
        if server:
            server.close()
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if server:
            await server.wait_closed()

    def notify(self):
        self.changed.set()
        self.changed = asyncio.Event()

    async def events(self):
        # Every subscriber starts with a complete snapshot, including retained states.
        yield "retry: 1000\n\n"
        while True:
            changed = self.changed
            snapshot = json.dumps({"listening": self.server is not None, "devices": self.devices},
                                  separators=(",", ":"))
            yield f"data: {snapshot}\n\n"
            while not changed.is_set():
                try:
                    await asyncio.wait_for(changed.wait(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"

    async def heartbeat(self, writer: asyncio.StreamWriter):
        try:
            while True:
                await asyncio.sleep(1)
                writer.write(HEARTBEAT)
                await asyncio.wait_for(writer.drain(), timeout=2)
        except (OSError, TimeoutError):
            writer.close()

    async def receive(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        ip = writer.get_extra_info("peername")[0]
        if ip not in DEVICE_IPS or self.server is None:
            writer.close()
            return

        task = asyncio.current_task()
        self.tasks.add(task)
        previous = self.connections.get(ip)
        self.connections[ip] = writer
        if previous:
            previous.close()
        heartbeat = None
        if ip in self.devices:
            self.devices[ip]["connected"] = False
            self.notify()
        try:
            writer.write(LOGIN_REQUEST)
            await asyncio.wait_for(writer.drain(), timeout=2)
            heartbeat = asyncio.create_task(self.heartbeat(writer))
            # TCP reads may split frames or contain several frames.
            buffer = b""
            while self.connections.get(ip) is writer:
                chunk = await asyncio.wait_for(reader.read(4096), timeout=8)
                if not chunk or self.connections.get(ip) is not writer:
                    break
                *frames, tail = (buffer + chunk).split(b"%")
                buffer = tail[tail.rfind(b"@"):] if b"@" in tail else b""
                if len(buffer) > 512:
                    buffer = b""
                for frame in frames:
                    groups = decode_lights(frame[frame.rfind(b"@") + 1:]) if b"@" in frame else None
                    if groups is not None:
                        state = {"connected": True, "groups": groups}
                        if self.devices.get(ip) != state:
                            self.devices[ip] = state
                            self.notify()
        except (OSError, TimeoutError):
            pass
        finally:
            if heartbeat:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
            if self.connections.get(ip) is writer:
                del self.connections[ip]
                if ip in self.devices:
                    self.devices[ip]["connected"] = False
                    self.notify()
            writer.close()
            self.tasks.discard(task)
