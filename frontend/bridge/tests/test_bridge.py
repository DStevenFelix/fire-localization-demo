import hashlib
import json
import threading
import time
from pathlib import Path

import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient

from frontend.bridge import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("FIRE_OFFLINE_BATCH_INTERVAL", "0")
    def no_settings_load(*_args, **_kwargs):
        raise AssertionError("Offline must never load .env")
    monkeypatch.setattr(server.Settings, "load", no_settings_load)
    original_send = httpx.Client.send
    def guarded_send(self, request, *args, **kwargs):
        assert request.url.host == "testserver", "External HTTP is forbidden in offline tests"
        return original_send(self, request, *args, **kwargs)
    monkeypatch.setattr(httpx.Client, "send", guarded_send)
    original_send2 = httpx2.Client.send
    def guarded_send2(self, request, *args, **kwargs):
        assert request.url.host == "testserver", "Paid Chat is forbidden in offline tests"
        return original_send2(self, request, *args, **kwargs)
    monkeypatch.setattr(httpx2.Client, "send", guarded_send2)
    app = server.create_app(tmp_path / "sessions")
    with TestClient(app) as test_client:
        yield test_client


def prepare(client, **kwargs):
    response = client.post("/api/scenarios/prepare", json=kwargs)
    assert response.status_code == 201
    return response.json()


def wait(client, session_id):
    for _ in range(150):
        result = client.get(f"/api/localization/{session_id}")
        assert result.status_code == 200
        session = result.json()
        if session["status"] != "running":
            return session
        time.sleep(.1)
    raise AssertionError("Offline worker did not finish within 15 seconds")


def test_discovery_and_invalid_inputs(client):
    assert client.get("/api/health").json()["default_mode"] == "offline"
    pois = client.get("/api/pois").json()
    assert len(pois) == 90 and all("coordinates" in p for p in pois)
    assert len(client.get("/api/scenarios").json()["scenarios"]) == 8
    assert client.post("/api/scenarios/prepare", json={"target_poi_id": "B-W-01"}).status_code == 422
    assert client.post("/api/scenarios/prepare", json={"mode": "unknown"}).status_code == 422
    assert client.get("/api/localization/bad-id").status_code == 404
    assert client.get("/api/localization/" + "0"*32).status_code == 404


def test_original_offline_algorithm_and_labels_isolated(client):
    legacy = server.PROJECT_ROOT / "runtime/embedding_cache.json"
    before = legacy.read_bytes() if legacy.exists() else None
    session = prepare(client)
    assert session["prediction"] is None and session["evaluation"] is None
    folder = client.app.state.service._folder(session["session_id"])
    posts = [json.loads(row) for row in (folder / "demo_posts.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(posts) == 100 and all(set(row) == {"id", "timestamp", "text", "location_poi_id", "urgency"} for row in posts)
    assert client.post("/api/localization/run", json={"session_id": session["session_id"]}).status_code == 202
    done = wait(client, session["session_id"])
    assert done["status"] == "completed" and done["mode"] == "offline"
    assert done["processed_count"] == 100 and done["batch_count"] == 10 and done["ignored_count"] == 10
    assert done["prediction"]["candidates"][0]["poi_id"] == "T-SW-01"
    assert done["evaluation"] == {"top1_hit": True, "top3_hit": True, "target_rank": 1, "distance_m": 0.0}
    assert json.loads((folder / "prediction.json").read_text(encoding="utf-8")) == done["prediction"]
    report = json.loads((folder / "report.json").read_text(encoding="utf-8"))
    assert report["embedding_requests"] == 0
    assert report["extractor_invocations"] == 10
    batches = json.loads((folder / "batch_results.json").read_text(encoding="utf-8"))
    assert len(batches) == 10 and all(batch["batch_size"] == 10 for batch in batches)
    assert (legacy.read_bytes() if legacy.exists() else None) == before
    assert not (folder / "root/runtime/embedding_cache.json").exists()


def test_paid_consent_is_enforced_before_any_model(client):
    session = prepare(client, mode="live")
    response = client.post("/api/localization/run", json={"session_id": session["session_id"]})
    assert response.status_code == 403
    assert client.get(f"/api/localization/{session['session_id']}").json()["status"] == "prepared"
    assert client.post("/api/localization/run", json={"session_id": session["session_id"], "confirm_paid_api": "true"}).status_code == 422


def test_every_original_tank_can_prepare_a_scene(client):
    scenarios = client.get("/api/scenarios").json()["scenarios"]
    for poi in scenarios:
        scene = prepare(client, target_poi_id=poi["poi_id"])
        assert scene["ground_truth"]["poi_id"] == poi["poi_id"]
        assert scene["prediction"] is None and scene["post_count"] == 100


def test_live_failure_never_falls_back_to_offline(client, monkeypatch):
    monkeypatch.setattr(server.Settings, "load", lambda: server.Settings())
    def fail_live(_settings, offline, **_kwargs):
        assert offline is False
        raise RuntimeError("SIMULATED_LIVE_PROVIDER_FAILURE")
    monkeypatch.setattr(server, "FireLocalizer", fail_live)
    session = prepare(client, mode="live")
    response = client.post("/api/localization/run", json={"session_id": session["session_id"], "confirm_paid_api": True})
    assert response.status_code == 202
    done = wait(client, session["session_id"])
    assert done["mode"] == "live" and done["status"] == "failed" and done["prediction"] is None
    assert done["error"]["error_type"] == "RuntimeError"


def test_double_run_and_reset_during_work_are_rejected(client, monkeypatch):
    real_locator = server.FireLocalizer
    release = threading.Event()
    entered = threading.Event()
    def gated_locator(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return real_locator(*args, **kwargs)
    monkeypatch.setattr(server, "FireLocalizer", gated_locator)
    session = prepare(client)
    try:
        assert client.post("/api/localization/run", json={"session_id": session["session_id"]}).status_code == 202
        assert entered.wait(5)
        assert client.post("/api/localization/run", json={"session_id": session["session_id"]}).status_code == 409
        assert client.post(f"/api/localization/{session['session_id']}/reset", json={}).status_code == 409
    finally:
        release.set()
    assert wait(client, session["session_id"])["status"] == "completed"


def test_reset_creates_new_session_preserving_result(client):
    old = prepare(client)
    client.post("/api/localization/run", json={"session_id": old["session_id"]})
    done = wait(client, old["session_id"])
    folder = client.app.state.service._folder(old["session_id"])
    old_report = (folder / "report.json").read_bytes()
    reset = client.post(f"/api/localization/{old['session_id']}/reset", json={})
    assert reset.status_code == 201
    new = reset.json()
    assert new["session_id"] != old["session_id"] and new["status"] == "prepared"
    assert new["prediction"] is None and new["processed_count"] == 0
    assert (folder / "report.json").read_bytes() == old_report
    assert client.get(f"/api/localization/{old['session_id']}").json() == done


def test_empty_evidence_uses_original_algorithm(client):
    session = prepare(client)
    folder = client.app.state.service._folder(session["session_id"])
    path = folder / "demo_posts.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    for row in rows:
        row.update(text="附近有烟味", location_poi_id="N01")
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")
    client.post("/api/localization/run", json={"session_id": session["session_id"]})
    done = wait(client, session["session_id"])
    assert done["status"] == "completed" and done["prediction"]["candidates"] == []
    assert done["processed_count"] == done["ignored_count"] == 100
    assert done["evaluation"]["distance_m"] is None and not done["evaluation"]["top1_hit"]


def test_failure_is_sanitized_and_does_not_change_mode(client, monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("DO_NOT_EXPOSE_PRIVATE_PROVIDER_RESPONSE")
    monkeypatch.setattr(server, "FireLocalizer", fail)
    session = prepare(client)
    client.post("/api/localization/run", json={"session_id": session["session_id"]})
    done = wait(client, session["session_id"])
    assert done["status"] == "failed" and done["mode"] == "offline" and done["prediction"] is None
    assert done["error"]["error_type"] == "RuntimeError"
    assert "DO_NOT_EXPOSE" not in json.dumps(done)
    folder = client.app.state.service._folder(session["session_id"])
    assert "DO_NOT_EXPOSE" not in (folder / "failure.json").read_text(encoding="utf-8")


def test_sessions_restore_and_interrupted_run_never_restarts(client):
    session = prepare(client)
    folder = client.app.state.service._folder(session["session_id"])
    restored = server.SessionService(client.app.state.service.runtime_root)
    try:
        assert restored.get(session["session_id"])["prediction"] is None
        session["status"] = "running"
        server.atomic_json(folder / "session.json", session)
        another = server.SessionService(client.app.state.service.runtime_root)
        try:
            result = another.get(session["session_id"])
            assert result["status"] == "failed" and result["error"]["error_type"] == "InterruptedRun"
        finally:
            another.executor.shutdown()
    finally:
        restored.executor.shutdown()


def test_old_map_session_is_rejected(client):
    session = prepare(client)
    folder = client.app.state.service._folder(session["session_id"])
    session["poi_fingerprint"] = "obsolete-map"
    server.atomic_json(folder / "session.json", session)
    client.app.state.service.sessions.clear()
    response = client.get(f"/api/localization/{session['session_id']}")
    assert response.status_code == 409
    assert "地图版本" in response.json()["detail"]


def test_batch_published_and_persisted_before_next_ingest(client, monkeypatch):
    real_locator = server.FireLocalizer
    entered, release = threading.Event(), threading.Event()

    def locator(*args, **kwargs):
        engine = real_locator(*args, **kwargs)
        ingest = engine.ingest
        calls = 0
        def gated(posts, **options):
            nonlocal calls
            calls += 1
            assert len(posts) == 10
            if calls == 2:
                entered.set()
                assert release.wait(10)
            return ingest(posts, **options)
        engine.ingest = gated
        return engine

    monkeypatch.setattr(server, "FireLocalizer", locator)
    session = prepare(client)
    service = client.app.state.service
    folder = service._folder(session["session_id"])
    try:
        client.post("/api/localization/run", json={"session_id": session["session_id"]})
        assert entered.wait(5)
        current = client.get(f"/api/localization/{session['session_id']}").json()
        disk = json.loads((folder / "session.json").read_text(encoding="utf-8"))
        batches = json.loads((folder / "batch_results.json").read_text(encoding="utf-8"))
        assert disk == current
        assert current["status"] == "running" and current["processed_count"] == 10
        assert current["batch_count"] == len(current["batch_history"]) == len(batches) == 1
        assert current["prediction"] == batches[0]["prediction"] == current["batch_history"][0]["prediction"]
        assert len(current["prediction"]["candidates"]) == 3
    finally:
        release.set()
    done = wait(client, session["session_id"])
    assert [b["processed_count"] for b in done["batch_history"]] == list(range(10,101,10))
    assert [b["batch_number"] for b in done["batch_history"]] == list(range(1,11))
    # 使用同一输入重放原先的单次 ingest，比较全部最终字段及评估所需排名。
    posts = [server.Post.model_validate(json.loads(row)) for row in (folder / "demo_posts.jsonl").read_text(encoding="utf-8").splitlines()]
    baseline = real_locator(server.Settings(root=folder / "root", batch_size=10), offline=True, state_path=folder / "comparison.json", resume=False)
    baseline.ingest(sorted(posts, key=lambda p:p.timestamp), flush=True)
    assert done["prediction"] == baseline.prediction()
    assert done["prediction"] == done["batch_history"][-1]["prediction"]




def test_failed_batch_preserves_published_history_and_restart(client, monkeypatch):
    real_locator = server.FireLocalizer
    def locator(*args, **kwargs):
        engine = real_locator(*args, **kwargs)
        ingest = engine.ingest
        def fail_third(posts, **options):
            if engine.memory.batch_count == 2:
                raise RuntimeError("DO_NOT_EXPOSE_PROVIDER_KEY")
            return ingest(posts, **options)
        engine.ingest = fail_third
        return engine
    monkeypatch.setattr(server, "FireLocalizer", locator)
    session = prepare(client)
    client.post("/api/localization/run", json={"session_id": session["session_id"]})
    done = wait(client, session["session_id"])
    assert done["status"] == "failed" and done["processed_count"] == 20
    assert done["batch_count"] == len(done["batch_history"]) == 2
    assert done["prediction"] == done["batch_history"][-1]["prediction"]
    assert "DO_NOT_EXPOSE" not in json.dumps(done)
    service = client.app.state.service
    restored = server.SessionService(service.runtime_root)
    try:
        assert restored.get(session["session_id"]) == done
        interrupted = dict(done, status="running")
        server.atomic_json(service._folder(session["session_id"])/"session.json", interrupted)
        restored.sessions.clear()
        result = restored.get(session["session_id"])
        assert result["status"] == "failed" and result["error"]["error_type"] == "InterruptedRun"
        assert result["prediction"] == done["prediction"] and result["batch_history"] == done["batch_history"]
    finally:
        restored.executor.shutdown()
