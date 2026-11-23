"""Archive lifecycle, explicit activation and deletion. Isolated DBs and models only."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableLambda
import pytest

from app.localization import LocalizationService
from app.simulation import SimulationEngine
from app.storage import SimulationStore, StorageError
from test_persistence import factory, install, wait_localization


@pytest.fixture(autouse=True)
def slow_automatic_loop(monkeypatch):
    monkeypatch.setenv("SIMULATION_INTERVAL_SECONDS", "3600")


def current(client):
    return client.get("/api/state").json()


def reset(client):
    response=client.post("/api/simulation",json={"action":"reset"})
    assert response.status_code==200,response.text
    return response.json()


def load(client, target, source, activation=None):
    return client.post("/api/runs/"+target+"/activate",json={"expected_run_id":source},
                       headers={"X-Simulation-Activation":activation} if activation else {})


def delete(client,target,source,activation=None):
    return client.delete("/api/runs/"+target,params={"expected_run_id":source},
                         headers={"X-Simulation-Activation":activation} if activation else {})


def test_v1_migration_preserves_both_runs_and_history(tmp_path):
    path=tmp_path/"legacy.sqlite3"
    store=SimulationStore(path)
    engine=SimulationEngine(); service=LocalizationService(factory,tmp_path/"cache")
    asyncio.run(engine.tick())
    first=service.state.session_id
    store.create(first,engine.checkpoint(),service.checkpoint())
    engine.reset();service.reset();second=service.state.session_id
    store.create(second,engine.checkpoint(),service.checkpoint(),expected_current=first,reason="reset")
    rows=[tuple(row) for row in store.connection.execute("SELECT * FROM runs ORDER BY id")]
    messages=store.connection.execute("SELECT count(*) FROM messages").fetchone()[0]
    store.connection.executescript("DROP TABLE run_events; DROP TABLE cleanup_queue; PRAGMA user_version=1;")
    store.close()
    migrated=SimulationStore(path)
    try:
        assert migrated.connection.execute("PRAGMA user_version").fetchone()[0]==4
        assert [tuple(row) for row in migrated.connection.execute("SELECT * FROM runs ORDER BY id")]==rows
        assert migrated.connection.execute("SELECT count(*) FROM messages").fetchone()[0]==messages
        assert migrated.load()["run_id"]==second and migrated.list_runs()["total"]==2
    finally:migrated.close()


def test_ordinary_save_cannot_create_or_implicitly_archive_another_run(tmp_path):
    store=SimulationStore(tmp_path/"test.sqlite3")
    engine,service=SimulationEngine(),LocalizationService(factory,tmp_path)
    try:
        first=service.state.session_id
        with pytest.raises(StorageError):store.save(first,engine.checkpoint(),service.checkpoint())
        store.create(first,engine.checkpoint(),service.checkpoint())
        service.reset()
        with pytest.raises(StorageError):store.save(service.state.session_id,engine.checkpoint(),service.checkpoint())
        assert store.load()["run_id"]==first and store.list_runs()["total"]==1
        assert store.connection.execute("SELECT archived_at FROM runs WHERE id=?",(first,)).fetchone()[0] is None
    finally:store.close()


def test_load_restores_full_checkpoint_without_calls_continues_original_and_restarts(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    calls=[]
    for agent in main.engine.agents.values():
        original=agent.chain
        async def track(values, original=original):
            calls.append(1);return await original.ainvoke(values)
        agent.chain=RunnableLambda(track)
    with TestClient(main.app) as client:
        for _ in range(2):client.post("/api/simulation",json={"action":"step"})
        wait_localization(client)
        saved=current(client); private=main.engine.checkpoint();old=saved["persistence"]["run_id"]
        blank=reset(client); new=blank["persistence"]["run_id"]
        count=len(calls)
        original_factory=main.localization.factory
        main.localization.factory=lambda _:pytest.fail("Loading initialized a model")
        result=load(client,old,new).json()
        assert len(calls)==count
        assert result["persistence"]["run_id"]==old and not result["running"]
        assert result["persistence"]["activation_id"]!=saved["persistence"]["activation_id"]
        for key in ("fires","chats","reports","simulation_minute","report_total","residents"):
            assert result[key]==saved[key]
        for key in ("observations","random","fire_random","agent_random","message_sequence"):
            assert main.engine.checkpoint()[key]==private[key]
        main.localization.factory=original_factory
        continued=client.post("/api/simulation",json={"action":"step"}).json()
        assert continued["simulation_minute"]==15 and continued["chat_totals"]["A-WEST"]==9
        wait_localization(client)
        assert client.get("/api/runs").json()["total"]==2
        actions=[r[0] for r in main.store.connection.execute("SELECT action FROM run_events ORDER BY id")]
        assert actions==["create","reset","activate"]
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        restored=current(client)
        assert restored["persistence"]["run_id"]==old and restored["simulation_minute"]==15
        assert not restored["running"]


def test_list_paginates_and_marks_current_and_incompatible_runs(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        first=current(client)["persistence"]["run_id"]
        for _ in range(21):reset(client)
        listing=client.get("/api/runs").json()
        assert listing["total"]==22 and len(listing["items"])==20
        assert len(client.get("/api/runs?page=2").json()["items"])==2
        assert sum(row["active"] for row in listing["items"])==1
        main.store.connection.execute("UPDATE runs SET fingerprint='incompatible' WHERE id=?",(first,))
        main.store.connection.commit()
        row=next(r for r in client.get("/api/runs?page_size=100").json()["items"] if r["run_id"]==first)
        assert not row["compatible"] and row["incompatible_reason"]
        active=current(client)["persistence"]["run_id"]
        assert load(client,first,active).status_code==409
        assert delete(client,first,active).status_code==200
        assert client.get("/api/runs?page=0").status_code==422


def test_delete_archived_run_removes_history_cache_and_preserves_current(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        first=client.post("/api/simulation",json={"action":"step"}).json()["persistence"]["run_id"]
        wait_localization(client)
        folder=main.localization.runtime_root/first;folder.mkdir(parents=True,exist_ok=True)
        (folder/"marker.json").write_text("{}")
        active=reset(client)["persistence"]["run_id"]
        client.post("/api/simulation",json={"action":"start"})
        response=delete(client,first,active)
        assert response.status_code==200 and response.json()["state"] is None
        assert not response.json()["cleanup_pending"] and not folder.exists()
        state=current(client)
        assert state["running"] and state["persistence"]["run_id"]==active
        assert main.store.connection.execute("SELECT count(*) FROM messages WHERE run_id=?",(first,)).fetchone()[0]==0
        assert main.store.connection.execute("SELECT count(*) FROM reports WHERE run_id=?",(first,)).fetchone()[0]==0
        assert delete(client,first,active).status_code==404
        assert load(client,first,active).status_code==404


def test_delete_current_atomically_creates_blank_paused_run_and_restores_it(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        first=client.post("/api/simulation",json={"action":"step"}).json()["persistence"]["run_id"]
        wait_localization(client)
        response=delete(client,first,first)
        assert response.status_code==200,response.text
        state=response.json()["state"]
        second=state["persistence"]["run_id"]
        assert second!=first and state["simulation_minute"]==0 and not state["running"]
        assert not state["chats"] and not state["fires"] and not state["localization"]["jobs"]
        assert main.store.list_runs()["total"]==1
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        assert current(client)["persistence"]["run_id"]==second


def test_stale_requests_are_rejected_even_after_returning_to_same_run(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        a=current(client); aid=a["persistence"]["run_id"]; activation=a["persistence"]["activation_id"]
        bid=reset(client)["persistence"]["run_id"]
        assert load(client,aid,bid).status_code==200
        assert load(client,bid,aid,activation).status_code==409
        assert delete(client,aid,aid,activation).status_code==409
        assert client.post("/api/simulation",json={"action":"step"},headers={"X-Simulation-Activation":activation}).status_code==409
        assert current(client)["persistence"]["run_id"]==aid
        assert load(client,bid,bid).status_code==409
        assert delete(client,bid,bid).status_code==409


def test_switch_waits_for_current_step_and_blocks_additional_mutations(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    entered,release=threading.Event(),threading.Event()
    with TestClient(main.app) as client:
        aid=current(client)["persistence"]["run_id"]
        bid=reset(client)["persistence"]["run_id"]
        original=main.engine._community_tick
        async def delayed(*args):
            entered.set();await asyncio.to_thread(release.wait,5);return await original(*args)
        monkeypatch.setattr(main.engine,"_community_tick",delayed)
        with ThreadPoolExecutor(max_workers=2) as pool:
            step=pool.submit(client.post,"/api/simulation",json={"action":"step"})
            assert entered.wait(3)
            switched=pool.submit(load,client,aid,bid)
            try:
                for _ in range(100):
                    if main._transition:break
                    time.sleep(.01)
                assert main._transition and not switched.done()
                assert client.post("/api/simulation",json={"action":"step"}).status_code==409
                assert client.post("/api/simulation",json={"action":"reset"}).status_code==409
                assert delete(client,bid,bid).status_code==409
                assert client.get("/api/runs").status_code==200
            finally:release.set()
            assert step.result(timeout=5).status_code==200
            assert switched.result(timeout=5).status_code==200
        assert current(client)["persistence"]["run_id"]==aid
        saved=main.store.load(bid)["engine"]["state"]
        assert saved["simulation_minute"]==5
        # Compare durable history to the completed step, independent of per-room post policy.
        assert main.store.connection.execute("SELECT count(*) FROM messages WHERE run_id=?",(bid,)).fetchone()[0]==sum(saved["chat_totals"].values())


@pytest.mark.parametrize("operation",["activate","delete"])
def test_failed_management_transaction_preserves_original_active_run(monkeypatch,tmp_path,operation):
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        aid=current(client)["persistence"]["run_id"]
        bid=reset(client)["persistence"]["run_id"]
        if operation=="activate":
            main.store.connection.execute("CREATE TRIGGER deny_switch BEFORE UPDATE OF active ON runs WHEN NEW.active=1 BEGIN SELECT RAISE(ABORT,'test'); END")
            response=load(client,aid,bid)
        else:
            main.store.connection.execute("CREATE TRIGGER deny_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'test'); END")
            response=delete(client,bid,bid)
        assert response.status_code==503
        assert current(client)["persistence"]["run_id"]==bid
        assert main.store.load()["run_id"]==bid and main.store.list_runs()["total"]==2
        assert not main.store.pending_cleanup()


def test_deleted_current_cache_waits_for_old_writer_and_is_not_recreated(monkeypatch,tmp_path):
    entered,release=threading.Event(),threading.Event()
    def delayed(path):
        engine=factory(path);original=engine.ingest
        def ingest(*args,**kwargs):
            entered.set();release.wait(5);return original(*args,**kwargs)
        engine.ingest=ingest;return engine
    main=install(monkeypatch,tmp_path,delayed)
    with TestClient(main.app) as client:
        aid=client.post("/api/simulation",json={"action":"step"}).json()["persistence"]["run_id"]
        assert entered.wait(3)
        try:
            response=delete(client,aid,aid)
            assert response.status_code==200 and response.json()["cleanup_pending"]
            assert main.store.pending_cleanup()[0]["run_id"]==aid
            assert main.store.load()["run_id"]!=aid
        finally:release.set()
        async def finish():
            if main.localization._workers:
                await asyncio.gather(*list(main.localization._workers),return_exceptions=True)
            await main.cleanup_pending()
        client.portal.call(finish)
        assert not main.store.pending_cleanup()
        assert not (main.localization.runtime_root/aid).exists()
        assert not current(client)["localization"]["jobs"]


def test_failed_cleanup_survives_restart_and_retries_without_models(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    with monkeypatch.context() as patch:
        with TestClient(main.app) as client:
            aid=current(client)["persistence"]["run_id"]
            folder=main.localization.runtime_root/aid;folder.mkdir(parents=True)
            (folder/"marker").write_text("test")
            bid=reset(client)["persistence"]["run_id"]
            def fail(_):raise PermissionError("test")
            patch.setattr("app.main.shutil.rmtree",fail)
            result=delete(client,aid,bid).json()
            assert result["cleanup_pending"] and result["cleanup"][0]["error"]
    main=install(monkeypatch,tmp_path,lambda _:pytest.fail("Cleanup initialized model"))
    with TestClient(main.app) as client:
        for _ in range(200):
            if not client.get("/api/runs").json()["cleanup"]:break
            time.sleep(.01)
        assert not main.store.pending_cleanup() and not folder.exists()
        assert current(client)["persistence"]["run_id"]==bid


def test_cleanup_refuses_symlink_and_traversal(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    outside=tmp_path/"protected";outside.mkdir();(outside/"keep").write_text("keep")
    with TestClient(main.app) as client:
        aid=current(client)["persistence"]["run_id"]
        main.localization.runtime_root.mkdir(parents=True,exist_ok=True)
        (main.localization.runtime_root/aid).symlink_to(outside,target_is_directory=True)
        bid=reset(client)["persistence"]["run_id"]
        assert delete(client,aid,bid).json()["cleanup_pending"]
        main.store.connection.execute("INSERT INTO cleanup_queue VALUES('../protected','test',NULL)")
        main.store.connection.commit()
        client.portal.call(main.cleanup_pending)
        assert (outside/"keep").read_text()=="keep"
        assert all(j["error"] for j in main.store.pending_cleanup())


def test_reactivated_same_run_waits_for_retired_cache_writer_before_processing(tmp_path):
    from test_persistence import event
    entered,release=threading.Event(),threading.Event()
    made=[]
    def delayed(path):
        engine=factory(path);made.append(engine)
        if len(made)==1:
            original=engine.ingest
            def ingest(*args,**kwargs):
                entered.set();release.wait(5);return original(*args,**kwargs)
            engine.ingest=ingest
        return engine
    service=LocalizationService(delayed,tmp_path)
    async def run():
        service.submit(event());service.wake()
        assert await asyncio.to_thread(entered.wait,3)
        saved=service.checkpoint()
        service.reset()
        service.restore(saved);service.resume();service.wake()
        try:
            await asyncio.sleep(.05)
            assert len(made)==1 and service.state.jobs[0].status=="queued"
        finally:release.set()
        await service.wait_idle()
        assert len(made)==2 and service.state.prediction["processed_count"]==1
        assert service.state.jobs[0].status=="completed"
        await service.close()
    asyncio.run(run())
