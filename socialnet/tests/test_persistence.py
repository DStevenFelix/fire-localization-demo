"""Durable state, interruption recovery and full history; test models only."""

import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time

from fastapi.testclient import TestClient
import pytest

from app.localization import LocalizationService
from app.models import FirePolicy
from app.simulation import SimulationEngine
from app.storage import SimulationStore, StorageError
from app.spatial import ROOT
from fire_locator.config import Settings
from fire_locator.engine import FireLocalizer


def factory(path):
    return FireLocalizer(Settings(root=ROOT), offline=True, state_path=path)


def event(key="one", minute=5):
    return {"report_ids": ["report-" + key], "simulation_minute": minute,
            "posts": [{"id": key, "simulation_minute": minute,
                       "text": "从锦安社区2号楼望过去，东边有一缕灰烟往上冒。",
                       "location_poi_id": "B-W-02", "urgency": "中"}]}


async def process(service, incoming):
    service.submit(incoming)
    service.advance_time(incoming["simulation_minute"])
    service.wake()
    await service.wait_idle()


def install(monkeypatch, tmp_path, localizer_factory=factory):
    from app import main
    monkeypatch.setattr(main, "engine", SimulationEngine(fire_policy=FirePolicy(base_probability=1)))
    monkeypatch.setattr(main, "localization", LocalizationService(localizer_factory, tmp_path / "locator"))
    monkeypatch.setattr(main, "connections", main.ConnectionManager())
    return main


def wait_localization(client, status="completed"):
    for _ in range(300):
        value = client.get("/api/localization").json()
        if value["status"] == status:
            return value
        time.sleep(.01)
    pytest.fail(f"Localization did not reach {status}: {value['status']}")


def test_restart_restores_all_business_data_and_private_continuation_without_requests(monkeypatch, tmp_path):
    main = install(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        client.post("/api/simulation", json={"action": "step"})
        wait_localization(client)
        client.post("/api/simulation", json={"action": "step"})
        loc = wait_localization(client)
        state = client.get("/api/state").json()
        checkpoint = main.engine.checkpoint()
        loc_checkpoint = main.localization.checkpoint()
        run_id = state["persistence"]["run_id"]
        assert state["persistence"]["enabled"] and state["persistence"]["saved_at"]
        assert checkpoint["observations"] and loc_checkpoint["memory"]
    main = install(monkeypatch, tmp_path, lambda _: pytest.fail("Restore must not construct inference providers"))
    with TestClient(main.app) as client:
        restored = client.get("/api/state").json()
        assert restored["persistence"]["restored"] and not restored["running"]
        assert restored["persistence"]["run_id"] == run_id
        for key in ("simulation_minute", "fires", "chats", "reports", "report_total", "chat_totals", "residents", "communities", "fire_policy"):
            assert restored[key] == state[key]
        for key in ("prediction", "clusters", "jobs"):
            assert restored["localization"][key] == loc[key]
        after = main.engine.checkpoint()
        for key in ("message_sequence", "report_sequence", "random", "fire_random", "agent_random", "community_random", "observations", "reported_ids"):
            assert after[key] == checkpoint[key]
        assert main.localization._engine is None
        # Read-only reopen and configuration changes must not accidentally resume pending work.
        client.put("/api/fire-policy", json={"base_probability": .4})
        assert client.get("/api/state").json()["simulation_minute"] == 10


def test_restored_rng_and_context_produce_same_next_intentions_and_text():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    saved = json.loads(json.dumps(engine.checkpoint()))
    restored = SimulationEngine()
    restored.restore(saved)
    asyncio.run(engine.tick()); asyncio.run(restored.tick())
    fields = ("resident_id", "content", "intent", "topic_key", "evidence_signals", "expression_kind")
    assert [[getattr(m,k) for k in fields] for m in engine.chats[-3 * len(engine.communities):]] == [
        [getattr(m,k) for k in fields] for m in restored.chats[-3 * len(restored.communities):]]
    assert restored._message_sequence == engine._message_sequence == 6 * len(engine.communities)


def test_full_history_survives_window_trimming_pagination_and_old_reference_lookup(monkeypatch, tmp_path):
    main = install(monkeypatch, tmp_path)
    # Avoid localization network/worker cost; source outbox is still durably captured.
    monkeypatch.setattr(main.localization, "wake", lambda: None)
    with TestClient(main.app) as client:
        for _ in range(43):
            assert client.post("/api/simulation", json={"action":"step"}).status_code == 200
        state = client.get("/api/state").json()
        run_id = state["persistence"]["run_id"]
        assert len(state["reports"]) == 30 and state["report_total"] == 43
        assert sum(m["community_id"] == "A-WEST" for m in state["chats"]) == 120
        messages, cursor = [], None
        while True:
            params = {"run_id":run_id,"limit":17}
            if cursor: params["before"] = cursor
            page = client.get("/api/communities/A-WEST/messages", params=params).json()
            messages.extend(page["items"])
            if not page["has_more"]: break
            cursor = page["next_before"]
        assert len(messages) == len({m["id"] for m in messages}) == state["chat_totals"]["A-WEST"] == 129
        earliest = min(messages, key=lambda m:m["sequence"])
        assert client.get("/api/messages/"+earliest["id"], params={"run_id":run_id}).json()["item"] == earliest
        reports, cursor = [], None
        while True:
            params = {"run_id":run_id,"limit":11}
            if cursor: params["before"] = cursor
            page = client.get("/api/reports", params=params).json()
            reports.extend(page["items"])
            if not page["has_more"]: break
            cursor = page["next_before"]
        assert len(reports) == len({r["id"] for r in reports}) == 43
        earliest_report = min(reports, key=lambda r:r["sequence"])
        assert client.get("/api/reports/"+earliest_report["id"], params={"run_id":run_id}).json()["item"] == earliest_report
        assert client.get("/api/reports?limit=0").status_code == 422
        assert client.get("/api/communities/missing/messages").status_code == 404
    main = install(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        assert client.get("/api/state").json()["report_total"] == 43
        assert client.get("/api/reports", params={"limit":200}).json()["items"] == sorted(reports,key=lambda r:r["sequence"])


def test_reset_archives_old_run_and_rejects_stale_history_requests(monkeypatch, tmp_path):
    main = install(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        state = client.post("/api/simulation", json={"action":"step"}).json()
        old = state["persistence"]["run_id"]
        reset = client.post("/api/simulation", json={"action":"reset"}).json()
        assert reset["persistence"]["run_id"] != old
        assert reset["simulation_minute"] == 0 and not reset["chats"] and not reset["fires"]
        assert not reset["localization"]["jobs"]
        assert client.get("/api/reports", params={"run_id":old}).status_code == 409
        assert main.store.connection.execute("SELECT active FROM runs WHERE id=?",(old,)).fetchone()[0] == 0
        assert main.store.connection.execute("SELECT count(*) FROM messages WHERE run_id=?",(old,)).fetchone()[0] == 3 * len(main.engine.communities)
    main = install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        assert client.get("/api/state").json()["simulation_minute"] == 0


def test_save_failure_rolls_back_new_messages_fire_and_rng_and_retains_old_database(monkeypatch,tmp_path):
    main = install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        saved = main.engine.checkpoint()
        main.store.connection.execute("PRAGMA query_only=ON")
        response = client.post("/api/simulation",json={"action":"step"})
        assert response.status_code == 503
        state = client.get("/api/state").json()
        assert state["persistence"]["error"] and not state["running"]
        assert state["simulation_minute"] == 0 and not state["chats"] and not state["fires"]
        assert main.engine.checkpoint()["agent_random"] == saved["agent_random"]
        assert main.store.load()["engine"]["state"]["simulation_minute"] == 0


def test_sql_transaction_is_atomic_if_history_insert_fails(tmp_path):
    storage = SimulationStore(tmp_path / "test.sqlite3")
    try:
        engine, service = SimulationEngine(), LocalizationService(factory,tmp_path)
        storage.create(service.state.session_id,engine.checkpoint(),service.checkpoint())
        asyncio.run(engine.tick())
        storage.connection.execute("CREATE TRIGGER disk_error BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test'); END")
        with pytest.raises(StorageError):
            storage.save(service.state.session_id,engine.checkpoint(),service.checkpoint())
        assert storage.load()["engine"]["state"]["simulation_minute"] == 0
        assert storage.connection.execute("SELECT count(*) FROM messages").fetchone()[0] == 0
    finally: storage.close()


def test_second_process_cannot_open_the_same_database_even_with_different_port(tmp_path):
    path = tmp_path / "owner.sqlite3"
    storage = SimulationStore(path)
    try:
        script = "from pathlib import Path; from app.storage import SimulationStore,StorageError\ntry: SimulationStore(Path(__import__('sys').argv[1]))\nexcept StorageError: print('locked')\nelse: raise RuntimeError('second writer allowed')"
        result = subprocess.run([sys.executable,"-B","-c",script,str(path)],capture_output=True,text=True,cwd=ROOT)
        assert result.returncode == 0 and result.stdout.strip() == "locked"
    finally: storage.close()
    again = SimulationStore(path); again.close()


def test_incompatible_or_corrupt_database_is_not_silently_replaced(tmp_path):
    path = tmp_path / "schema.sqlite3"
    store = SimulationStore(path)
    engine, service = SimulationEngine(), LocalizationService(factory,tmp_path)
    store.create(service.state.session_id,engine.checkpoint(),service.checkpoint())
    store.connection.execute("UPDATE runs SET fingerprint='different-map'"); store.connection.commit()
    with pytest.raises(StorageError,match="不兼容"): store.load()
    store.close()
    path.write_bytes(b"not a database")
    with pytest.raises(StorageError): SimulationStore(path)
    assert path.read_bytes() == b"not a database"


def test_restored_pending_and_running_jobs_wait_for_resume_then_do_not_double_vote(tmp_path):
    service = LocalizationService(factory,tmp_path)
    asyncio.run(process(service,event()))
    service.submit(event("two",10))
    saved = service.checkpoint()
    saved["state"]["jobs"][-1]["status"] = "running"
    saved["state"]["status"] = "running"
    resumed = LocalizationService(lambda _:pytest.fail("Paused recovery called model"),tmp_path)
    resumed.restore(saved)
    async def run():
        resumed.wake(); await resumed.wait_idle()
        assert resumed.state.resume_pending and resumed.state.prediction["processed_count"] == 1
        resumed.factory = factory
        resumed.resume(); resumed.wake(); await resumed.wait_idle()
        assert resumed.state.status == "completed" and resumed.state.prediction["processed_count"] == 2
        await process(resumed,event("two",10))
        assert resumed.state.prediction["processed_count"] == 2
    asyncio.run(run())


def test_working_memory_ahead_of_database_is_ignored_on_recovery(tmp_path):
    service = LocalizationService(factory,tmp_path)
    asyncio.run(process(service,event()))
    saved = service.checkpoint()
    # Simulate successful remote inference and file writes before the database completion commit.
    asyncio.run(process(service,event("uncommitted",10)))
    assert service.state.prediction["processed_count"] == 2
    resumed = LocalizationService(factory,tmp_path); resumed.restore(saved)
    async def run():
        resumed.resume()
        await process(resumed,event("committed-after-restart",15))
    asyncio.run(run())
    assert resumed.state.prediction["processed_count"] == 2
    assert "uncommitted" not in resumed._engine.memory.seen
    assert set(resumed._engine.memory.seen) == {"one","committed-after-restart"}


def test_failed_jobs_stay_failed_and_expiry_after_completed_restore_needs_no_model(tmp_path):
    service = LocalizationService(factory,tmp_path)
    asyncio.run(process(service,event()))
    resumed = LocalizationService(lambda _:pytest.fail("Expiry must not initialize providers"),tmp_path)
    resumed.restore(service.checkpoint())
    async def run():
        resumed.resume(); resumed.advance_time(70); resumed.wake(); await resumed.wait_idle()
    asyncio.run(run())
    assert not resumed.state.prediction["candidates"] and resumed.state.prediction["processed_count"] == 1
    service.state.status, service.state.error = "failed", "test-error"
    service.state.jobs[0].status = "failed"
    again = LocalizationService(factory,tmp_path); again.restore(service.checkpoint())
    assert again.state.status == "failed" and again.state.error == "test-error"
    assert again.state.jobs[0].status == "failed" and not again.state.resume_pending


def test_localization_configuration_change_is_shown_without_remote_requests(monkeypatch,tmp_path):
    service = LocalizationService(factory,tmp_path)
    asyncio.run(process(service,event()))
    saved = service.checkpoint()
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_MODEL","different-model")
    resumed = LocalizationService(lambda _:pytest.fail("Incompatible restore called model"),tmp_path)
    resumed.restore(saved)
    assert resumed.state.status == "failed" and "不兼容" in resumed.state.error
    assert resumed.state.prediction == saved["state"]["prediction"]


def test_first_embedding_configuration_can_be_fixed_before_any_memory_exists(monkeypatch,tmp_path):
    service=LocalizationService(factory,tmp_path)
    service.submit(event())
    saved=service.checkpoint()
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_MODEL","newly-configured-model")
    resumed=LocalizationService(factory,tmp_path);resumed.restore(saved)
    assert resumed.state.status=="queued" and resumed.state.resume_pending
    assert resumed._config_fingerprint==resumed.configuration_fingerprint()


def test_fire_setting_and_clear_are_saved_without_advancing_time(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        client.post("/api/simulation",json={"action":"step"})
        client.delete("/api/fire")
        client.put("/api/fire-policy",json={"base_probability":.72,"suppression_factor":.25})
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        state=client.get("/api/state").json()
        assert not state["fires"] and state["simulation_minute"]==5
        assert state["fire_policy"]["base_probability"]==.72


def test_checkpoint_never_contains_api_keys(monkeypatch,tmp_path):
    monkeypatch.setenv("DASHSCOPE_API_KEY","SECRET-CHAT-KEY")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_API_KEY","SECRET-EMBEDDING-KEY")
    engine, service = SimulationEngine(), LocalizationService(factory,tmp_path)
    text = json.dumps([engine.checkpoint(),service.checkpoint()])
    assert "SECRET-CHAT-KEY" not in text and "SECRET-EMBEDDING-KEY" not in text


def test_localization_completion_save_failure_does_not_publish_uncommitted_result(monkeypatch,tmp_path):
    main = install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        save = main.store.save_localization
        def fail_completion(run_id,data):
            if data["state"]["status"] == "completed":
                raise StorageError("test-disk-failure")
            return save(run_id,data)
        monkeypatch.setattr(main.store,"save_localization",fail_completion)
        client.post("/api/simulation",json={"action":"step"})
        for _ in range(300):
            state=client.get("/api/state").json()
            if state["persistence"]["error"]: break
            time.sleep(.01)
        assert state["persistence"]["error"] == "test-disk-failure"
        assert state["localization"]["prediction"] is None
        assert state["simulation_minute"] == 5 and not state["running"]
        stored=main.store.load()
        assert stored["localization"]["state"]["prediction"] is None
        assert stored["localization"]["state"]["jobs"][0]["status"] == "running"


def test_interrupted_uncommitted_tick_is_not_restored(monkeypatch,tmp_path):
    storage=SimulationStore(tmp_path/"interrupted.sqlite3")
    engine,service=SimulationEngine(fire_policy=FirePolicy(base_probability=1)),LocalizationService(factory,tmp_path)
    try:
        storage.create(service.state.session_id,engine.checkpoint(),service.checkpoint())
        entered=asyncio.Event()
        original=engine._community_tick
        async def interrupted(*args):
            entered.set()
            await asyncio.sleep(60)
            return await original(*args)
        monkeypatch.setattr(engine,"_community_tick",interrupted)
        async def run():
            task=asyncio.create_task(engine.tick())
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):await task
        asyncio.run(run())
        restored=SimulationEngine();restored.restore(storage.load()["engine"])
        assert restored.simulation_minute == 0 and not restored.chats and not restored.fires
    finally:storage.close()
