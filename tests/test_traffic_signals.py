import asyncio
import json

from frontend.bridge import traffic_signals


FRAME = b"@CAB5CAB1D7B4CCAC|0107010701070204010001000100010701000100010002040204020402040107%"


def test_direct_signal_reconnect_keeps_last_frame(monkeypatch):
    async def scenario():
        signals = traffic_signals.TrafficSignals("127.0.0.1", 0)
        await signals.start()
        assert signals.server is not None
        port = signals.server.sockets[0].getsockname()[1]
        stream = signals.events()
        await anext(stream)

        async def snapshot():
            event = await asyncio.wait_for(anext(stream), 2)
            return json.loads(event.removeprefix("data: "))["devices"]

        try:
            assert await snapshot() == {}
            reader, blocked = await asyncio.open_connection("127.0.0.1", port)
            assert await asyncio.wait_for(reader.read(1), 2) == b""
            blocked.close()
            await blocked.wait_closed()
            monkeypatch.setattr(traffic_signals, "DEVICE_IPS", {"127.0.0.1"})
            reader, device = await asyncio.open_connection("127.0.0.1", port)
            assert await reader.readexactly(len(traffic_signals.LOGIN_REQUEST)) == traffic_signals.LOGIN_REQUEST
            device.write(FRAME[:27])
            await device.drain()
            await asyncio.sleep(0)
            assert signals.devices == {}
            device.write(FRAME[27:] + b"@CAB5CAB1D7B4CCAC|0101%" + FRAME)
            await device.drain()
            connected = (await snapshot())["127.0.0.1"]
            assert len(connected["groups"]) == 16
            assert connected["groups"][0] == {"color": "red", "countdown": 7}
            assert await asyncio.wait_for(reader.readexactly(4), 2) == b"noop"
            device.close()
            await device.wait_closed()
            offline = (await snapshot())["127.0.0.1"]
            assert offline == {**connected, "connected": False}

            reader, device = await asyncio.open_connection("127.0.0.1", port)
            assert await reader.readexactly(len(traffic_signals.LOGIN_REQUEST)) == traffic_signals.LOGIN_REQUEST
            assert signals.devices["127.0.0.1"] == offline
            device.write(FRAME.replace(b"0107", b"0206"))
            await device.drain()
            while not (updated := (await snapshot())["127.0.0.1"])["connected"]:
                pass
            assert updated["groups"][0] == {"color": "green", "countdown": 6}
            await asyncio.wait_for(signals.stop(), 2)
            assert await reader.read() == b""
            device.close()
            await device.wait_closed()
        finally:
            await stream.aclose()
            await signals.stop()

    asyncio.run(scenario())
