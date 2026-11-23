import asyncio
import json
import time
from concurrent.futures import CancelledError
from datetime import datetime, timezone
from threading import Event

import pytest
from fastapi.testclient import TestClient

from fire_locator.config import Settings
from fire_locator.engine import FireLocalizer
from fire_locator.models import Post
from frontend.bridge import server
from socialnet.app import post_source
from socialnet.app.models import ChatMessage
from socialnet.app.post_archive import PostArchives
from socialnet.app.simulation import SimulationEngine


def test_cancelled_localization_batch_does_not_begin_embedding(tmp_path, monkeypatch):
    cancelled = Event()
    engine = FireLocalizer(Settings(batch_size=3), offline=True, state_path=tmp_path / "memory.json", cancel_event=cancelled)
    origin = next(poi.id for poi in engine.repository.pois.values() if poi.can_post)
    timestamp = datetime.now(timezone.utc).replace(second=0, microsecond=0)

    def cancelled_after_extraction(_posts):
        cancelled.set()
        return []

    monkeypatch.setattr(engine.extractor, "extract", cancelled_after_extraction)
    monkeypatch.setattr(engine.embeddings, "embed_documents", lambda _posts: pytest.fail("Embedding started after cancellation"))
    with pytest.raises(CancelledError):
        engine.ingest([Post(id=str(i), timestamp=timestamp, text="看见罐区冒烟", location_poi_id=origin, urgency="中")
                       for i in range(3)])
    assert engine.memory.batch_count == 0


def test_socialnet_stream_freezes_at_handoff_and_stops_at_extinction(tmp_path, monkeypatch):
    monkeypatch.setenv("SIMULATION_INTERVAL_SECONDS", "0.20")
    monkeypatch.setattr(server, "POLL_SECONDS", 0.025)
    fires = []
    interrupted_tick = Event()

    async def community_tick(self, community, fire):
        assert self.monitor is None
        if community is not self.communities[0]:
            return []
        if self.simulation_minute == 10 and not interrupted_tick.is_set():
            interrupted_tick.set()
            await asyncio.Event().wait()
        fires.append(fire.nearest_poi_id)
        building = self.nearest_building(fire.position)
        return [ChatMessage(id=f"msg-{self.simulation_minute}-{i}", timestamp=datetime.now(timezone.utc),
                            simulation_minute=self.simulation_minute, resident_id="resident", resident_name="居民",
                            building_id=building.id, building_name=building.name, unit="1",
                            position=building.position, content=content, community_id=community.id)
                for i, content in enumerate(("储罐区附近着火了，看到明火和浓烟！", "罐区火灾，好大的烟！", "今晚一起买菜吧"))]

    monkeypatch.setattr(SimulationEngine, "prepare_generation", lambda self: True)
    monkeypatch.setattr(SimulationEngine, "_community_tick", community_tick)

    def wait_for(get, ready):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = get()
            if ready(result):
                return result
            time.sleep(0.025)
        raise AssertionError(result)

    bridge_root = tmp_path / "bridge"
    source_root = tmp_path / "socialnet"
    bridge = server.create_app(bridge_root)
    source_app = post_source.create_app(archives=PostArchives(source_root))
    with TestClient(source_app) as source, TestClient(bridge) as ui:
        client = bridge.state.service.socialnet

        def call(method, path, **kwargs):
            response = source.request(method, "/api/post-source" + path, **kwargs)
            assert response.is_success, response.text
            return response.json()

        monkeypatch.setattr(client, "_request", call)
        assert source.get("/").status_code == 404
        assert source.get("/api/localization").status_code == 404

        def prepare(tank):
            return ui.post("/api/scenarios/prepare", json={"source": "socialnet", "target_poi_id": tank}).json()

        def start(run, *, paused=False):
            return ui.post("/api/localization/run", json={"session_id": run, "confirm_paid_api": True, "paused": paused})

        ready = prepare("T-NE-01")
        run = ready["session_id"]
        path = f"/api/localization/{run}"
        assert ready["post_count"] == 0
        assert not (bridge_root / run / "demo_posts.jsonl").exists()
        assert ui.post("/api/localization/run", json={"session_id": run}).status_code == 403
        upstream = f"/api/post-source/runs/{run}/posts"
        assert start(run, paused=True).json()["paused"] is True
        time.sleep(0.25)
        assert source.get(upstream).json() == {"posts": [], "running": False, "paused": True, "failed": False}
        assert ui.put(path + "/pause", json={"paused": False}).json()["paused"] is False
        read_session = lambda: ui.get(path).json()
        read_posts = lambda: ui.get(path + "/posts").json()
        first = wait_for(read_session, lambda s: s["post_count"] > 0)
        assert (first["post_count"], first["processed_count"]) == (2, 0)
        assert interrupted_tick.wait(timeout=5)
        source_archive = next(source_root.glob(f"*_{run}"))
        post_file = source_archive / "posts-000001.jsonl"
        assert ui.put(path + "/pause", json={"paused": True}).json()["paused"] is True
        assert ui.put(path + "/pause", json={"paused": True}).status_code == 200
        archived = post_file.read_bytes()
        saved_posts = source.get(upstream).json()
        assert saved_posts["paused"] and not saved_posts["running"]
        time.sleep(0.30)
        assert read_session()["status"] == "running"
        assert read_session()["post_count"] == 2
        assert post_file.read_bytes() == archived
        assert source.get(upstream).json() == saved_posts
        assert ui.get("/api/scenarios/active").json()["paused"] is True
        assert ui.put(path + "/pause", json={"paused": False}).json()["paused"] is False
        predicted = wait_for(read_session, lambda s: bool((s["prediction"] or {}).get("candidates")))
        assert predicted["processed_count"] % 3 == 0
        assert predicted["ground_truth"]["poi_id"] == fires[0] == "T-NE-01"
        assert {path.name for path in (bridge_root / run).iterdir()} == {"session.json"}
        frozen = ui.post(path + "/handoff").json()
        assert frozen["analysis_frozen"]
        later = wait_for(read_posts, lambda p: p["post_count"] > frozen["post_count"])
        assert all("买菜" not in p["text"] for p in later["posts"])
        assert read_session()["prediction"] == frozen["prediction"]
        assert read_session()["processed_count"] == frozen["processed_count"]
        assert not bridge.state.service.streams[run].pending
        assert ui.post(path + "/stop").json()["status"] == "completed"
        assert not source.get(upstream).json()["running"]
        assert ui.put(path + "/pause", json={"paused": False}).status_code == 409
        stopped_count = read_posts()["post_count"]
        time.sleep(0.25)
        assert read_posts()["post_count"] == stopped_count
        old_folder = bridge_root / ("a" * 32)
        old_folder.mkdir()
        (old_folder / "memory.json").write_text("legacy raw post", encoding="utf-8")
        old_cache = bridge_root / "_demo_posts"
        old_cache.mkdir()
        (old_cache / "old.json").write_text("legacy post replay", encoding="utf-8")
        poi_cache = bridge_root / "_poi_embeddings.json"
        poi_cache.write_text("shared POI-only cache", encoding="utf-8")
        original = post_file.read_bytes()
        assert "买菜" in original.decode("utf-8")
        sequences = [json.loads(row)["sequence"] for row in original.splitlines()]
        assert sequences == list(range(1, len(sequences) + 1))
        assert list(source_root.glob(f"*_{run}")) == [source_archive]
        replacement = ui.post(path + "/reset").json()
        assert replacement["status"] == "prepared"
        assert set(bridge_root.iterdir()) == {bridge_root / replacement["session_id"], poi_cache}
        assert poi_cache.read_text(encoding="utf-8") == "shared POI-only cache"
        assert ui.get(path + "/posts").status_code == 404
        assert source.get(upstream).status_code == 404
        assert (source_archive / "posts-000001.jsonl").read_bytes() == original

        other = prepare("T-SW-01")["session_id"]
        assert start(other).status_code == 202
        other_upstream = f"/api/post-source/runs/{other}/posts"
        wait_for(lambda: source.get(other_upstream).json(), lambda p: bool(p["posts"]))
        assert fires[-1] == "T-SW-01"
        assert ui.put(f"/api/localization/{other}/pause", json={"paused": True}).status_code == 200
        assert ui.post(f"/api/localization/{other}/reset").status_code == 201
        assert source.get(other_upstream).status_code == 404
