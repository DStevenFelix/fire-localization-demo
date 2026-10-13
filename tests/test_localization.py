import json
from datetime import datetime, timedelta

import numpy as np
import pytest
from fire_locator.math_utils import cosine_similarity

from fire_locator.config import ROOT, Settings
from fire_locator.demo import generate
from fire_locator.engine import FireLocalizer
from fire_locator.memory import Cluster, LocalizationMemory
from fire_locator.models import Extraction, Post, SHANGHAI
from fire_locator.poi import Poi, PoiRepository

T0 = datetime(2026, 10, 7, 14, 0, tzinfo=SHANGHAI)


def post(index=0, **kwargs):
    return Post(id=f"test-{index}", timestamp=T0+timedelta(minutes=index),
                text=kwargs.pop("text", "检修车间南边有浓烟"), location_poi_id=kwargs.pop("location_poi_id", "POI-HA-NW-02"), urgency="高", **kwargs)


def test_excel_json_and_output_types():
    repository = PoiRepository(ROOT)
    assert len(repository.tanks) == 14
    assert len(repository.nearest_neighbors) == 28
    assert len(repository.relations) == 1082
    assert all(p.type == "tank" for p in repository.tanks.values())
    with pytest.raises(ValueError):
        repository.validate_location("POI-HA-SW-02")
    with pytest.raises(ValueError):
        repository.validate_location("POI-HA-SW-06")


def test_circle_sector_boundaries_and_angle_wrap():
    repository = PoiRepository(ROOT)
    origin = Poi("test", "test", "test", 0, 0)
    def polar(angle, radius):
        return radius*np.cos(np.deg2rad(angle)), radius*np.sin(np.deg2rad(angle))
    repository.tanks = {key: Poi(key, key, "tank", *polar(angle, radius))
                        for key, angle, radius in [("edge", 22.5, 10), ("wrap", -22.5, 10), ("outside_angle", 22.6, 5),
                                                  ("outside_radius", 0, 10.1), ("inside", 0, 2)]}
    assert repository.candidates(origin, "东") == ["edge", "inside", "wrap"]
    assert repository.candidates(origin, "附近") == ["edge", "inside", "outside_angle", "wrap"]


def test_incremental_confidence_matches_pairwise_and_merge():
    vectors = np.random.default_rng(42).normal(size=(30, 12))
    cluster = Cluster("a", T0.isoformat())
    for n, vector in enumerate(vectors, 1):
        cluster.append(["tank"], vector.tolist(), T0)
        if n > 1:
            matrix = cosine_similarity(vectors[:n], vectors[:n])
            expected = matrix[np.triu_indices(n, 1)].mean()
            assert cluster.confidence == pytest.approx(expected, abs=1e-12)
    left, right = Cluster("left", T0.isoformat()), Cluster("right", T0.isoformat())
    for vector in vectors[:15]:
        left.append(["tank"], vector.tolist(), T0)
    for vector in vectors[15:]:
        right.append(["tank"], vector.tolist(), T0)
    left.merge(right)
    assert left.confidence == pytest.approx(cluster.confidence)


def test_bridge_merge_and_cold_boundary():
    memory = LocalizationMemory(None, "test")
    memory.add_evidence(["A"], [1, 0], T0, 60)
    memory.add_evidence(["B"], [0, 1], T0, 60)
    assert len(memory.clusters) == 2
    cluster = memory.add_evidence(["A", "B"], [1, 1], T0, 60)
    assert cluster.count == 3
    assert cluster.votes == {"A": 2, "B": 2}
    memory.expire(T0+timedelta(minutes=60), 60)
    assert not cluster.cold
    memory.add_evidence(["A"], [1, 0], T0+timedelta(minutes=61), 60)
    assert cluster.cold and cluster.count == 3
    assert len(memory.clusters) == 2


def test_batch_has_ten_independent_extractions_and_one_call():
    engine = FireLocalizer(offline=True)
    posts = [post(index, text="检修车间南边有浓烟" if index % 2 == 0 else "华安能源综合楼东南侧有火光") for index in range(10)]
    response = engine.ingest(posts[:9])
    assert response["pending_count"] == 9
    assert response["updates"] == [] and engine.extractor.calls == 0
    update = engine.ingest(posts[9:])["updates"][0]
    assert engine.extractor.calls == 1
    assert [item["post_id"] for item in update["posts"]] == [p.id for p in posts]
    assert {item["direction"] for item in update["posts"]} == {"南", "东南"}
    assert {item["origin_poi_id"] for item in update["posts"]} == {"POI-HA-NW-02", "POI-HA-NW-01"}


def test_reference_fallback_and_strict_threshold():
    engine = FireLocalizer(offline=True)
    default = engine.repository.pois["POI-JA-01"]
    assert engine.matcher.resolve(Extraction(post_id="1"), default.id)[0] == default
    exact = Extraction(post_id="1", reference="华安能源综合楼")
    engine.matcher.threshold = 1.0
    assert engine.matcher.resolve(exact, default.id)[2] == "posting_location_below_threshold"
    engine.matcher.threshold = 0.7
    assert engine.matcher.resolve(exact, default.id)[0].id == "POI-HA-NW-01"
    assert engine.matcher.resolve(Extraction(post_id="1", reference="zzzzzz"), default.id)[0] == default


def test_no_candidates_is_ignored_and_single_post_flush():
    engine = FireLocalizer(offline=True)
    response = engine.ingest([post(location_poi_id="POI-FS-01", text="附近有烟味")], flush=True)
    assert response["ignored_count"] == 1
    assert response["updates"][0]["prediction"]["candidates"] == []


def test_failure_queue_retry_restart_and_dedup(tmp_path, monkeypatch):
    path = tmp_path/"state.json"
    engine = FireLocalizer(offline=True, state_path=path)
    original = engine.extractor.extract
    def fail(_):
        raise RuntimeError("fake outage")
    monkeypatch.setattr(engine.extractor, "extract", fail)
    posts = [post(index) for index in range(10)]
    with pytest.raises(RuntimeError):
        engine.ingest(posts)
    assert engine.memory.processed_count == 0
    assert len(engine.memory.pending) == 10
    assert engine.memory.clusters == []
    monkeypatch.setattr(engine.extractor, "extract", original)
    restored = FireLocalizer(offline=True, state_path=path, resume=True)
    result = restored.ingest(posts)
    assert result["duplicates"] == 10 and result["processed_count"] == 10
    assert restored.ingest(posts)["updates"] == []
    again = FireLocalizer(offline=True, state_path=path, resume=True)
    assert again.prediction() == restored.prediction()
    with pytest.raises(ValueError):
        again.ingest([posts[0].model_copy(update={"text": "changed"})])
    with pytest.raises(ValueError):
        FireLocalizer(Settings(radius_m=5), offline=True, state_path=path, resume=True)


def test_invalid_batch_does_not_partially_enqueue():
    engine = FireLocalizer(offline=True)
    with pytest.raises(ValueError):
        engine.ingest([post(), post(1, location_poi_id="unknown")])
    assert not engine.memory.pending and not engine.memory.seen
    engine.ingest([post(2)])
    with pytest.raises(ValueError):
        engine.ingest([post(1)])


def test_100_synthetic_posts(tmp_path):
    repository = PoiRepository(ROOT)
    path = tmp_path/"posts.jsonl"
    metadata = generate(repository, path)
    posts = [Post.model_validate(json.loads(line)) for line in path.read_text(encoding="utf-8").splitlines()]
    assert len(posts) == 100
    assert all(repository.pois[p.location_poi_id].type not in {"tank", "tank_group"} for p in posts)
    assert all("ground_truth" not in p.model_dump() for p in posts)
    engine = FireLocalizer(offline=True)
    result = engine.ingest(posts)
    assert engine.extractor.calls == 10
    assert len(result["updates"]) == 10
    assert result["processed_count"] == 100
    assert result["ignored_count"] >= 10
    prediction = engine.prediction()
    assert len(prediction["candidates"]) == 3
    assert all(item["poi_id"] in repository.tanks for item in prediction["candidates"])
    assert metadata["single_fire_ground_truth"]["poi_id"] in [item["poi_id"] for item in prediction["candidates"]]
    assert not engine.prediction(T0+timedelta(hours=3))["candidates"]
