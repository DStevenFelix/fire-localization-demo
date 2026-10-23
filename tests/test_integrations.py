import json
from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableLambda

from fire_locator.api import app, get_engine
from fire_locator.config import Settings
from fire_locator.engine import FireLocalizer
from fire_locator.models import BatchExtraction, Extraction, SHANGHAI
from fire_locator.providers import SiliconFlowEmbeddings


def test_embedding_format_order_and_persistent_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("SILICONFLOW_API_KEY", "test-secret")
    requests = []
    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        assert body["input"] == [{"text": "甲"}, {"text": "乙"}]
        assert request.headers["Authorization"] == "Bearer test-secret"
        return httpx.Response(200, json={"data": [{"index": 1, "embedding": [0, 1]}, {"index": 0, "embedding": [1, 0]}]})
    cache = tmp_path/"cache.json"
    embeddings = SiliconFlowEmbeddings(Settings(), cache)
    embeddings.client.close()
    embeddings.client = httpx.Client(transport=httpx.MockTransport(handler))
    assert embeddings.embed_documents(["甲", "乙", "甲"]) == [[1, 0], [0, 1], [1, 0]]
    assert embeddings.embed_query("乙") == [0, 1]
    assert len(requests) == 1
    assert "test-secret" not in cache.read_text()
    restored = SiliconFlowEmbeddings(Settings(), cache)
    assert restored.embed_query("甲") == [1, 0]
    assert restored.request_count == 0
    embeddings.client.close()
    restored.client.close()


def test_embedding_auth_error_is_not_retried_or_echoed(tmp_path, monkeypatch):
    monkeypatch.setenv("SILICONFLOW_API_KEY", "test-secret")
    embeddings = SiliconFlowEmbeddings(Settings(), tmp_path/"cache.json")
    embeddings.client.close()
    embeddings.client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401, text="test-secret")))
    with pytest.raises(RuntimeError, match="HTTP 401") as error:
        embeddings.embed_query("test")
    assert "test-secret" not in str(error.value)
    assert embeddings.request_count == 1
    embeddings.client.close()


def test_embedding_splits_into_eight_to_avoid_vl_index_reset(tmp_path, monkeypatch):
    monkeypatch.setenv("SILICONFLOW_API_KEY", "test-secret")
    sizes = []
    def handler(request):
        batch = json.loads(request.content)["input"]
        sizes.append(len(batch))
        assert len(batch) <= 8
        return httpx.Response(200, json={"data": [{"index": i, "embedding": [int(item["text"])+1, 1]}
                                                  for i, item in enumerate(batch)]})
    embeddings = SiliconFlowEmbeddings(Settings(), tmp_path/"cache.json")
    embeddings.client.close()
    embeddings.client = httpx.Client(transport=httpx.MockTransport(handler))
    assert embeddings.embed_documents([str(i) for i in range(10)]) == [[i+1, 1] for i in range(10)]
    assert sizes == [8, 2]
    embeddings.client.close()


def test_missing_model_id_rejects_entire_batch():
    engine = FireLocalizer(offline=True)
    now = datetime.now(SHANGHAI).replace(second=0, microsecond=0)
    posts = [{"id": str(i), "timestamp": now.isoformat(), "text": "附近有浓烟", "location_poi_id": "B-D-01", "urgency": "高"} for i in range(10)]
    engine.extractor.chain = RunnableLambda(lambda _: BatchExtraction(items=[Extraction(post_id="0")]))
    with pytest.raises(ValueError, match="漏条"):
        engine.ingest(posts)
    assert not engine.memory.clusters
    assert engine.memory.processed_count == 0 and len(engine.memory.pending) == 10


def test_http_accumulation_flush_and_prediction():
    engine = FireLocalizer(offline=True)
    app.dependency_overrides.clear()
    # 路由使用可缓存工厂而非 Depends，临时替换模块工厂，测试后恢复。
    import fire_locator.api as api
    original = api.get_engine
    api.get_engine = lambda: engine
    try:
        client = TestClient(app)
        now = datetime.now(SHANGHAI).replace(second=0, microsecond=0)
        posts = [{"id": str(i), "timestamp": now.isoformat(), "text": "华安能源园1号附属楼南边有浓烟", "location_poi_id": "B-D-01", "urgency": "高"} for i in range(11)]
        response = client.post("/posts", json={"posts": posts[:1]})
        assert response.status_code == 200 and response.json()["pending_count"] == 1
        response = client.post("/posts", json={"posts": posts[1:10]})
        assert response.status_code == 200 and len(response.json()["updates"]) == 1
        assert len(response.json()["updates"][0]["posts"]) == 10
        assert client.get("/prediction").json()["candidates"]
        assert any(p["type"] == "tank" and not p["can_post"] for p in client.get("/pois").json())
        assert client.post("/posts", json={"posts": posts[10:]}).json()["pending_count"] == 1
        assert client.post("/posts", json={"flush": True}).json()["processed_count"] == 11
        response = client.post("/posts", json={"posts": [dict(posts[0], id="bad", location_poi_id="T-SW-01")]})
        assert response.status_code == 422
    finally:
        api.get_engine = original
