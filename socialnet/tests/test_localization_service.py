import asyncio
import json
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda

from app.localization import LocalizationService, EPOCH
from app.localization_provider import create_localizer, LocalizationConfigurationError
from app.models import FirePolicy
from app.simulation import SimulationEngine
from app.spatial import ROOT
from fire_locator.config import Settings
from fire_locator.engine import FireLocalizer


def factory(path):
    # Explicit test double only. Production never selects this factory.
    return FireLocalizer(settings=Settings(root=ROOT), offline=True, state_path=path)


def event(key="one", minute=5, report=None, text="锦安社区2号楼东边有灰烟。"):
    return {"report_ids": [report or "report-" + key], "simulation_minute": minute,
            "posts": [{"id": key, "simulation_minute": minute, "text": text,
                       "location_poi_id": "B-W-02", "urgency": "中"}]}


async def run_job(service, value):
    service.submit(value)
    service.advance_time(value["simulation_minute"])
    service.wake()
    await service.wait_idle()


def test_tail_batch_uses_public_original_post_and_produces_candidates(tmp_path):
    service = LocalizationService(factory, tmp_path)
    value = event()
    value["posts"][0].update(fire_id="SECRET-FIRE", intensity=5, position={"x":10,"y":15})
    asyncio.run(run_job(service, value))
    state = service.snapshot()
    assert state.status == "completed" and state.prediction["processed_count"] == 1
    assert state.prediction["pending_count"] == 0 and state.prediction["candidates"]
    assert state.prediction["candidates"][0]["poi_id"] == "T-NW-01"
    assert service._engine.extractor.calls == 1
    post = next(iter(service._journal.values()))
    assert set(post) == {"id", "timestamp", "text", "location_poi_id", "urgency"}
    assert "SECRET-FIRE" not in json.dumps(post)
    assert post["timestamp"].startswith("2000-01-01T08:05")


def test_duplicate_reports_and_source_posts_do_not_vote_twice(tmp_path):
    service = LocalizationService(factory, tmp_path)
    async def run():
        await run_job(service, event())
        await run_job(service, event(report="report-two"))
        await run_job(service, event())
    asyncio.run(run())
    assert len(service.state.jobs) == 1
    assert set(service.state.jobs[0].report_ids) == {"report-one", "report-two"}
    assert service.state.prediction["processed_count"] == 1
    assert service.state.prediction["candidates"][0]["votes"] == 1


def test_failure_is_isolated_and_retry_resumes_pending_without_duplicate_votes(tmp_path):
    made = []
    def failing_factory(path):
        engine = factory(path)
        original = engine.extractor.extract
        def extract(posts):
            if not made:
                made.append(1)
                raise TimeoutError("PRIVATE-PROVIDER-KEY")
            return original(posts)
        engine.extractor.extract = extract
        return engine
    service = LocalizationService(failing_factory, tmp_path)
    async def run():
        await run_job(service, event())
        assert service.state.status == "failed"
        assert "PRIVATE" not in service.state.model_dump_json()
        assert service._engine.memory.processed_count == 0
        assert len(service._engine.memory.pending) == 1
        await run_job(service, event("two", 10))
        assert service.state.jobs[1].status == "queued"
        assert service.state.jobs[0].attempts == 1  # New reports never auto-retry the failed job.
        service.retry(service.state.jobs[0].id)
        service.wake()
        await service.wait_idle()
    asyncio.run(run())
    assert [j.status for j in service.state.jobs] == ["completed", "completed"]
    assert service.state.jobs[0].attempts == 2
    assert service.state.prediction["processed_count"] == 2
    assert service.state.prediction["candidates"][0]["votes"] == 2


def test_late_original_posts_rebuild_in_original_time_order(tmp_path):
    service = LocalizationService(factory, tmp_path)
    async def run():
        await run_job(service, event("later", 20))
        incoming = event("earlier", 5)
        incoming["simulation_minute"] = 30
        await run_job(service, incoming)
    asyncio.run(run())
    assert service.state.jobs[-1].replayed
    assert service.state.prediction["processed_count"] == 2
    assert service.state.prediction["candidates"][0]["votes"] == 2
    assert service._journal["earlier"]["timestamp"].endswith("08:05:00+08:00")


def test_simulation_clock_expires_predictions_without_new_reports(tmp_path):
    service = LocalizationService(factory, tmp_path)
    async def run():
        await run_job(service, event())
        service.advance_time(66)
        service.wake()
        await service.wait_idle()
    asyncio.run(run())
    assert not service.state.prediction["candidates"]
    assert service.state.prediction["active_cluster_count"] == 0


def test_reset_discards_inflight_result_and_old_sources(tmp_path):
    entered, release = threading.Event(), threading.Event()
    created = []
    def delayed_factory(path):
        engine = factory(path)
        created.append(engine)
        original = engine.ingest
        if len(created) == 1:
            def ingest(*args, **kwargs):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError()
                return original(*args, **kwargs)
            engine.ingest = ingest
        return engine
    service = LocalizationService(delayed_factory, tmp_path)
    async def run():
        service.submit(event("old")); service.wake()
        assert await asyncio.to_thread(entered.wait, 3)
        old_id = service.state.session_id
        try:
            service.reset()
            assert service.state.session_id != old_id and not service.state.jobs
            service.submit(event("new")); service.wake()
        finally:
            release.set()
        await service.wait_idle()
    asyncio.run(run())
    assert len(service.state.jobs) == 1 and service.state.jobs[0].message_ids == ["new"]
    assert service.state.prediction["processed_count"] == 1
    assert set(service._journal) == {"new"}


def test_missing_embedding_configuration_does_not_guess_a_provider_or_call_chat(tmp_path, monkeypatch):
    monkeypatch.setattr("app.localization_provider.create_chat_model", lambda **_: pytest.fail("Should not initialize Chat"))
    with pytest.raises(LocalizationConfigurationError, match="LOCALIZATION_EMBEDDING_API_KEY"):
        create_localizer(tmp_path / "state.json")


def test_live_embedding_http_error_is_not_automatically_retried_or_exposed(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_API_KEY", "test-private-key")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_BASE_URL", "https://embedding.invalid/v1")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_MODEL", "test-embedding")
    model = RunnableLambda(lambda _: pytest.fail("Chat must not run after embedding initialization failed"))
    model.model_name, model.openai_api_base = "test-chat", "https://chat.invalid/v1"
    monkeypatch.setattr("app.localization_provider.create_chat_model", lambda **_: model)
    requests = []
    def fail(request):
        requests.append(request)
        return httpx.Response(500, text="test-private-key")
    client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(fail), **kwargs))
    service = LocalizationService(create_localizer, tmp_path)
    asyncio.run(run_job(service, event()))
    assert len(requests) == 1 and service.state.status == "failed"
    assert "test-private-key" not in service.state.model_dump_json()


def test_invalid_localization_text_fails_in_worker_not_in_simulation_dispatch(tmp_path):
    service = LocalizationService(factory, tmp_path)
    incoming = event(text="字" * 4001)
    service.submit(incoming)
    assert service.state.jobs[0].status == "queued"
    async def run():
        service.wake()
        await service.wait_idle()
    asyncio.run(run())
    assert service.state.status == "failed" and not service.state.prediction


def test_queuing_another_job_keeps_running_status_and_never_starts_two_workers(tmp_path):
    entered, release = threading.Event(), threading.Event()
    def delayed(path):
        engine = factory(path)
        original = engine.ingest
        def ingest(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError()
            return original(*args, **kwargs)
        engine.ingest = ingest
        return engine
    service = LocalizationService(delayed, tmp_path)
    async def run():
        service.submit(event()); service.wake()
        assert await asyncio.to_thread(entered.wait, 3)
        task = service._task
        try:
            service.submit(event("next", 10)); service.wake()
            assert service.state.status == "running" and service._task is task
        finally:
            release.set()
        await service.wait_idle()
    asyncio.run(run())
    assert service.state.prediction["processed_count"] == 2


def test_live_adapters_reuse_successful_extractions_when_replaying_late_posts(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_API_KEY", "test-key-not-real")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_BASE_URL", "https://embedding.invalid/v1")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_MODEL", "test-embedding")
    extracted = []
    def generate(prompt):
        posts = json.loads(prompt.to_messages()[-1].content.split("\n", 1)[1])
        extracted.extend(p["id"] for p in posts)
        return AIMessage(content=json.dumps({"items": [{"post_id":p["id"], "reference":"锦安社区2号楼", "direction":"东"} for p in posts]}))
    model = RunnableLambda(generate)
    model.model_name, model.openai_api_base = "test-chat", "https://chat.invalid/v1"
    monkeypatch.setattr("app.localization_provider.create_chat_model", lambda **_: model)
    from fire_locator.providers import OfflineEmbeddings
    vectors = OfflineEmbeddings()
    def respond(request):
        texts = json.loads(request.content)["input"]
        return httpx.Response(200, json={"data":[{"index":i,"embedding":v} for i,v in enumerate(vectors.embed_documents(texts))]})
    client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs))
    service = LocalizationService(create_localizer, tmp_path)
    async def run():
        await run_job(service, event("later", 20))
        assert service._engine.settings.radius_m == 15
        await run_job(service, {**event("earlier", 5), "simulation_minute":30})
        assert service._engine.settings.radius_m == 15
        await service.close()
    asyncio.run(run())
    assert service.state.status == "completed" and service.state.jobs[-1].replayed
    assert extracted == ["later", "earlier"]
    assert service.state.prediction["processed_count"] == 2


def test_engine_outbox_contains_only_reported_original_posts_and_resets():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    assert engine.localization_outbox
    payload = engine.localization_outbox[0]
    sources = {m.id:m for m in engine.chats}
    reported = {mid for r in engine.reports for mid in r.related_message_ids}
    assert {p["id"] for p in payload["posts"]} == reported
    assert not {m.id for m in engine.chats if m.topic == "daily"}.intersection(reported)
    for post in payload["posts"]:
        assert post["text"] == sources[post["id"]].content
        assert post["simulation_minute"] == sources[post["id"]].simulation_minute
        assert not {"fire_id", "position", "intensity", "evidence_signals"}.intersection(post)
    engine.reset()
    assert not engine.localization_outbox


def test_api_localization_failure_does_not_pause_simulation_and_reset_isolated(tmp_path, monkeypatch):
    from app import main
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    def fail(_):
        raise TimeoutError("PRIVATE-KEY")
    service = LocalizationService(fail, tmp_path)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "localization", service)
    with TestClient(main.app) as client:
        first = client.post("/api/simulation", json={"action":"step"}).json()
        for _ in range(100):
            state = client.get("/api/localization").json()
            if state["status"] == "failed":
                break
            time.sleep(.01)
        assert state["status"] == "failed" and "PRIVATE" not in json.dumps(state)
        second = client.post("/api/simulation", json={"action":"step"}).json()
        assert second["simulation_minute"] == 10 and second["generation_error"] is None
        assert client.post("/api/localization/missing/retry").status_code == 404
        job = state["jobs"][0]
        assert client.post("/api/localization/"+job["id"]+"/retry").status_code == 200
        reset = client.post("/api/simulation", json={"action":"reset"}).json()
        assert reset["localization"]["session_id"] != first["localization"]["session_id"]
        assert not reset["localization"]["jobs"]
