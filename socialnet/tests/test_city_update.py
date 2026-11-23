"""整城、定位升级和旧存档迁移回归；全部模型为测试替身。"""

import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from app.city_migration import legacy_fingerprint
from app.localization import LocalizationService, EPOCH
from app.models import FirePolicy
from app.simulation import SimulationEngine
from app.spatial import ROOT, ORIGINAL_COMMUNITIES, load_city_catalog, load_city_scene
from app.storage import SimulationStore, StorageError, encode
from fire_locator.engine import FireLocalizer
from fire_locator.config import Settings


LEGACY_FINGERPRINT = "ced79adb30ebd68a36da943828fb6d36090445e61f72a0058a79db9130850441"


def make_legacy_run():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    data = engine.checkpoint()
    state = data["state"]
    # A genuine pre-city/schema2 checkpoint predates local discovery entirely.
    data.pop("discovery")
    data.pop("discovery_pending")
    state.pop("discovery")
    state["residents"] = [r for r in state["residents"] if r["community_id"] in ORIGINAL_COMMUNITIES]
    state["communities"] = [c for c in state["communities"] if c["id"] in ORIGINAL_COMMUNITIES]
    state["entities"] = [e for e in state["entities"] if e["source"] == "spatial_model"]
    state["chats"] = [m for m in state["chats"] if m["community_id"] in ORIGINAL_COMMUNITIES]
    state["chat_totals"] = {key: value for key, value in state["chat_totals"].items() if key in ORIGINAL_COMMUNITIES}
    data["community_random"] = {key: value for key, value in data["community_random"].items() if key in ORIGINAL_COMMUNITIES}
    original_ids = {r["id"] for r in state["residents"]}
    data["agent_random"] = {key: value for key, value in data["agent_random"].items() if key in original_ids}
    # 用一条带来源坐标的历史报告验证独立历史表与快照一同迁移。
    state["reports"] = state["reports"][:1]
    for report in state["reports"]:
        report["buildings"] = report["buildings"][:1]
        report["residents"] = report["residents"][:1]
    for row in [*state["residents"], *state["chats"], *state["fires"]]:
        row["position"]["x"] -= 30
        row["position"]["y"] -= 25
    for report in state["reports"]:
        for row in [*report["buildings"], *report["residents"]]:
            row["x"] -= 30
            row["y"] -= 25
    state["map"].update(width=30, height=25, source="fire_poi/fire_sandbox_spatial_model.json")
    for field in ("coordinate_system", "scene_width", "scene_height", "original_offset"):
        state["map"].pop(field, None)
    state["running"] = True
    service = LocalizationService()
    loc = service.checkpoint()
    loc["configuration"] = "legacy-merged-clusters-v1"
    loc["state"].pop("cold_minutes")
    loc["state"]["prediction"] = {"coordinate_system": "local_cartesian_meters", "candidates": [
        {"rank": 1, "poi_id": "T-NW-01", "coordinates": {"x_m": 9.626524, "y_m": 15.419447}}]}
    loc["memory"] = {"schema_version": 1, "signature": "legacy", "clusters": []}
    return data, loc


def legacy_database(path, count=1):
    originals = []
    with_store = SimulationStore(path)
    try:
        previous = None
        for _ in range(count):
            engine, loc = make_legacy_run()
            run_id = loc["state"]["session_id"]
            with_store.create(run_id, engine, loc, expected_current=previous)
            with with_store.connection:
                with_store.connection.execute("UPDATE runs SET fingerprint=? WHERE id=?", (LEGACY_FINGERPRINT, run_id))
            originals.append((run_id, engine, loc))
            previous = run_id
        with_store.connection.execute("PRAGMA user_version=2")
    finally:
        with_store.close()
    return originals


def test_city_catalog_allocation_preserves_ids_and_excludes_non_postable_homes():
    assert legacy_fingerprint(encode) == LEGACY_FINGERPRINT
    engine = SimulationEngine()
    assert len(engine.entities) == 415 and len(engine.residents) == 300 and len(engine.communities) == 10
    assert len({r.name for r in engine.residents}) == 300
    assert len([r for r in engine.residents if r.community_id in ORIGINAL_COMMUNITIES]) == 48
    assert {r.building_id for r in engine.residents if r.building_id.startswith("EXT-")} == {
        p["id"] for p in load_city_catalog() if p["type"] == "building" and p["category"] == "residential" and p["can_post"]}
    assert "EXT-C-007" in engine._entity_by_id
    assert "EXT-C-007" not in {c.id for c in engine.communities}
    assert engine.snapshot().map.coordinate_system == "CITY90x75"


def test_updated_predictions_and_expiry_use_city_coordinates_after_restart(tmp_path):
    def factory(path):
        return FireLocalizer(Settings(root=ROOT), offline=True, state_path=path)
    service = LocalizationService(factory, tmp_path)
    service.submit({"report_ids": ["r"], "simulation_minute": 5, "posts": [{"id": "p", "simulation_minute": 5,
        "text": "锦安社区2号楼东边有灰烟。", "location_poi_id": "B-W-02", "urgency": "中"}]})
    service.advance_time(5)
    async def run():
        service.wake()
        await service.wait_idle()
    asyncio.run(run())
    assert service.state.status == "completed" and service.state.cold_minutes == 30
    prediction = service.state.prediction
    assert prediction["coordinate_system"] == "CITY90x75"
    for row in prediction["candidates"]:
        entity = SimulationEngine()._entity_by_id[row["poi_id"]]
        assert row["coordinates"]["x_m"] == entity.position.x
        assert row["coordinates"]["y_m"] == entity.position.y
    restored = LocalizationService(lambda _: pytest.fail("Expiry initialized model clients"), tmp_path)
    restored.restore(service.checkpoint())
    async def expire():
        restored.resume()
        restored.advance_time(34)
        restored.wake()
        await restored.wait_idle()
        assert restored.state.prediction["candidates"] == prediction["candidates"]
        restored.advance_time(35)
        restored.wake()
        await restored.wait_idle()
        assert not restored.state.prediction["candidates"]
    asyncio.run(expire())


def test_legacy_runs_and_full_history_migrate_once_with_backup(tmp_path):
    path = tmp_path / "simulation.sqlite3"
    originals = legacy_database(path, count=2)
    with_store = SimulationStore(path)
    try:
        assert with_store.connection.execute("PRAGMA user_version").fetchone()[0] == 4
        assert with_store.connection.execute("SELECT count(*) FROM run_events WHERE action='migrate_city'").fetchone()[0] == 2
        for run_id, before, old_loc in originals:
            saved = with_store.load(run_id)
            state = saved["engine"]["state"]
            assert len(state["residents"]) == 300 and len(state["communities"]) == 10
            assert not state["running"] and state["map"]["coordinate_system"] == "CITY90x75"
            assert saved["engine"]["message_sequence"] == before["message_sequence"]
            for key, random_state in before["agent_random"].items():
                assert saved["engine"]["agent_random"][key] == json.loads(json.dumps(random_state))
            for row in before["state"]["chats"]:
                item = with_store.item(run_id, "messages", row["id"])
                assert item["content"] == row["content"] and item["sequence"] == row["sequence"]
                assert item["position"] == {"x": row["position"]["x"]+30, "y": row["position"]["y"]+25}
            for row in before["state"]["reports"]:
                item = with_store.item(run_id, "reports", row["id"])
                assert item["buildings"][0]["x"] == row["buildings"][0]["x"]+30
                assert item["evidence"] == row["evidence"]
            engine = SimulationEngine()
            engine.restore(saved["engine"])
            assert len(engine.residents) == 300
            loc = LocalizationService(lambda _: pytest.fail("Migration called model"))
            loc.restore(saved["localization"])
            assert loc.state.status == "failed" and "不兼容" in loc.state.error
            assert loc.state.cold_minutes == 60 and loc._memory_checkpoint == old_loc["memory"]
            coords = loc.state.prediction["candidates"][0]["coordinates"]
            assert coords == {"x_m": 39.626524, "y_m": 40.419447}
    finally:
        with_store.close()
    backups = list(tmp_path.glob("*.pre-city-*.sqlite3"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("PRAGMA user_version").fetchone()[0] == 2
        assert json.loads(backup.execute("SELECT engine FROM runs LIMIT 1").fetchone()[0])["state"]["map"]["width"] == 30
    again = SimulationStore(path)
    try:
        assert again.load()["engine"]["state"]["chats"][0]["position"] == state["chats"][0]["position"]
        assert len(list(tmp_path.glob("*.pre-city-*.sqlite3"))) == 1
    finally:
        again.close()


def test_legacy_migration_failure_is_atomic(tmp_path, monkeypatch):
    path = tmp_path / "simulation.sqlite3"
    originals = legacy_database(path, count=2)
    from app import city_migration
    migrate = city_migration.migrate_checkpoints
    calls = []
    def fail_second(engine, loc):
        calls.append(1)
        if len(calls) == 2:
            raise ValueError("simulated invalid checkpoint")
        return migrate(engine, loc)
    monkeypatch.setattr(city_migration, "migrate_checkpoints", fail_second)
    with pytest.raises(StorageError):
        SimulationStore(path)
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert {row[0] for row in db.execute("SELECT fingerprint FROM runs")} == {LEGACY_FINGERPRINT}
        assert db.execute("SELECT count(*) FROM run_events WHERE action='migrate_city'").fetchone()[0] == 0
    assert list(tmp_path.glob("*.pre-city-*.sqlite3"))


def test_migrated_legacy_archive_can_be_loaded_without_calling_old_locator(tmp_path, monkeypatch):
    path = tmp_path / "simulation.sqlite3"
    originals = legacy_database(path, count=2)
    monkeypatch.setenv("SIMULATION_STORAGE_PATH", str(path))
    from app import main
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "engine", SimulationEngine())
    monkeypatch.setattr(main, "connections", main.ConnectionManager())
    monkeypatch.setattr(main, "localization", LocalizationService(lambda _: pytest.fail("Loaded legacy archive called model"), tmp_path / "loc"))
    with TestClient(main.app) as client:
        archives = client.get("/api/runs").json()
        assert all(row["compatible"] and row["localization_warning"] for row in archives["items"])
        response = client.post("/api/runs/" + originals[0][0] + "/activate", json={"expected_run_id": originals[1][0]},
                               headers={"X-Simulation-Activation": archives["activation_id"]})
        assert response.status_code == 200
        state = response.json()
        assert len(state["residents"]) == 300 and not state["running"]
        assert state["localization"]["status"] == "failed" and state["chats"]
        assert state["persistence"]["run_id"] == originals[0][0]
