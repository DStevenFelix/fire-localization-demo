import json
import math
from collections import Counter
import re
import shutil
from datetime import datetime, timedelta

import numpy as np
import pytest
from fire_locator.math_utils import cosine_similarity

from fire_locator.config import ROOT, Settings
from localizer_posts_fixture import generate
from fire_locator.engine import FireLocalizer
from fire_locator.memory import LocalizationMemory
from fire_locator.models import Extraction, Post, SHANGHAI
from fire_locator.poi import Poi, PoiRepository

T0 = datetime(2026, 10, 23, 14, 0, tzinfo=SHANGHAI)


def post(index=0, **kwargs):
    return Post(id=f"test-{index}", timestamp=T0+timedelta(minutes=index),
                text=kwargs.pop("text", "华安能源园1号附属楼南边有浓烟"), location_poi_id=kwargs.pop("location_poi_id", "B-D-01"), urgency="高", **kwargs)


def test_current_map_json_and_output_types():
    repository = PoiRepository(ROOT)
    assert len(repository.tanks) == 8
    assert len(repository.pois) == 415
    assert len(repository.relations) == 306
    assert all(p.type == "tank" for p in repository.tanks.values())
    with pytest.raises(ValueError):
        repository.validate_location("T-SW-01")
    repository.validate_location("F-PIPE-SW")


def test_circle_sector_boundaries_and_angle_wrap():
    repository = PoiRepository(ROOT)
    origin = Poi("test", "test", "test", 0, 0)
    def polar(angle, radius):
        return radius*np.cos(np.deg2rad(angle)), radius*np.sin(np.deg2rad(angle))
    repository.tanks = {key: Poi(key, key, "tank", *polar(angle, radius))
                        for key, angle, radius in [("edge", 22.5, 15), ("wrap", -22.5, 15), ("outside_angle", 22.6, 5),
                                                  ("outside_radius", 0, 15.1), ("inside", 0, 2)]}
    assert repository.candidates(origin, "东") == ["edge", "inside", "wrap"]
    assert repository.candidates(origin, "附近") == ["edge", "inside", "outside_angle", "wrap"]


def test_new_map_provenance_and_cardinal_directions():
    repository = PoiRepository(ROOT)
    spatial = json.loads((ROOT / "fire_poi/fire_sandbox_spatial_model.json").read_text(encoding="utf-8"))
    for item in spatial["pois"]:
        poi = repository.pois[item["id"]]
        assert [poi.x_m, poi.y_m] == [v + offset for v, offset in zip(item["center"], (30, 25))]
    extended = json.loads((ROOT / "city_scene/poi_catalog.json").read_text(encoding="utf-8"))
    for item in extended:
        poi = repository.pois[item["id"]]
        assert [poi.x_m, poi.y_m] == item["center"]
        assert poi.can_post == item["can_post"]
    assert repository.pois["T-NW-01"].y_m > repository.pois["T-SW-01"].y_m
    assert repository.pois["T-NE-01"].x_m > repository.pois["T-NW-01"].x_m
    assert "T-NW-01" in repository.candidates(repository.pois["B-W-02"], "东")
    assert "T-NW-01" not in repository.candidates(repository.pois["B-W-02"], "西")
    assert repository.pois["R-08"].type == "road"
    assert PoiRepository._line_midpoint([[0, 0], [2, 0], [2, 6]]) == [2, 2]


def test_rejects_wrong_image_and_orientation(tmp_path):
    destination = tmp_path / "fire_poi"
    destination.mkdir()
    for name in ("fire_sandbox_spatial_model.json", "map_config.json", "map_original.png"):
        shutil.copy2(ROOT / "fire_poi" / name, destination / name)
    config_path = destination / "map_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["coordinate_system"]["y_axis"] = "south"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(ValueError, match="坐标约定"):
        PoiRepository(tmp_path)
    shutil.copy2(ROOT / "fire_poi/map_config.json", config_path)
    (destination / "map_original.png").write_bytes(b"wrong image")
    with pytest.raises(ValueError, match="SHA-256"):
        PoiRepository(tmp_path)


@pytest.mark.parametrize("target_id", ["T-NW-01", "T-NW-02", "T-NE-01", "T-NE-02",
                                      "T-SW-01", "T-SW-02", "T-SE-01", "T-SE-02"])
def test_all_current_tanks_generate_and_replay(tmp_path, target_id):
    repository = PoiRepository(ROOT)
    output = tmp_path / "posts.jsonl"
    generate(repository, output, count=100, target_id=target_id)
    posts = [Post.model_validate_json(line) for line in output.read_text(encoding="utf-8").splitlines()]
    kinds = []
    target = repository.tanks[target_id]
    for post_item in posts:
        repository.validate_location(post_item.location_poi_id)
        origin = repository.pois[post_item.location_poi_id]
        distance = math.hypot(origin.x_m-target.x_m, origin.y_m-target.y_m)
        assert distance <= 30
        reference = max((name for name in (origin.name, *origin.aliases) if name in post_item.text), key=len, default=None)
        if reference:
            assert distance <= 20
            direction = re.search(r"(东北|西北|东南|西南|东|西|南|北)(?:边|侧|方向)", post_item.text.replace(reference, "")).group(1)
            assert target_id in repository.candidates(origin, direction, 20)
            kind = "directional"
        elif post_item.urgency == "低":
            kind = "low"
        elif post_item.text.startswith("路过时闻到烟味"):
            kind = "noise"
        else:
            kind = "vague"
        if distance <= 20:
            kinds.append(kind)
        else:
            assert kind == "vague"
    assert len(kinds) >= 11
    for start in range(0, len(kinds)-10, 11):
        assert Counter(kinds[start:start+11]) == {"directional": 4, "vague": 3, "low": 2, "noise": 2}
    engine = FireLocalizer(offline=True)
    result = engine.ingest(posts)
    assert result["processed_count"] == 100 and not engine.memory.pending
    assert all(candidate["poi_id"] in repository.tanks for candidate in engine.prediction()["candidates"])


def test_post_distance_boundaries(tmp_path):
    repository = PoiRepository(ROOT)
    target = repository.tanks["T-SW-01"]
    points = [Poi(str(d), f"观测点{d}", "building", target.x_m+d, target.y_m)
              for d in (20, 20.01, 30, 30.01)]
    repository.pois = {p.id: p for p in points}
    output = tmp_path / "posts.jsonl"
    generate(repository, output, count=100)
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert {r["location_poi_id"] for r in rows} == {"20", "20.01", "30"}
    assert any("观测点20" in r["text"] for r in rows if r["location_poi_id"] == "20")
    assert all("观测点" not in r["text"] and r["urgency"] != "低"
               for r in rows if r["location_poi_id"] != "20")


def test_incremental_confidence_matches_pairwise_for_each_poi():
    vectors = np.random.default_rng(42).normal(size=(30, 12))
    memory = LocalizationMemory(None, "test")
    for n, vector in enumerate(vectors, 1):
        clusters = memory.add_evidence(["A", "A", "B"], vector.tolist(), T0, 30)
        assert len(clusters) == 2 and all(c.count == n for c in clusters)
        if n > 1:
            matrix = cosine_similarity(vectors[:n], vectors[:n])
            expected = matrix[np.triu_indices(n, 1)].mean()
            assert all(c.confidence == pytest.approx(expected, abs=1e-12) for c in clusters)
    assert all(set(c) == {"id", "poi_id", "last_timestamp", "count", "vector_sum", "cold", "vote_units"}
               for c in memory.to_dict()["clusters"])


def test_shared_post_does_not_merge_or_keep_other_poi_alive():
    memory = LocalizationMemory(None, "test")
    a, b = memory.add_evidence(["A", "B"], [1, 0], T0, 30)
    memory.add_evidence(["A"], [1, 1], T0+timedelta(minutes=29), 30)
    assert a.votes == {"A": 2} and b.votes == {"B": 1}
    memory.expire(T0+timedelta(minutes=30), 30)
    assert b.cold and not a.cold
    replacement, = memory.add_evidence(["B"], [1, 0], T0+timedelta(minutes=30), 30)
    assert replacement.id != b.id and replacement.votes == {"B": 1}


def test_extended_alias_resolves_to_city_poi():
    engine = FireLocalizer(offline=True)
    origin, _, reason = engine.matcher.resolve(Extraction(post_id="a", reference="云栖苑"), "B-D-01")
    assert origin.id == "EXT-C-001" and reason == "exact_name_or_alias"
    assert origin.can_post
    disallowed = next(p for p in engine.repository.pois.values() if p.id.startswith("EXT-") and not p.can_post)
    with pytest.raises(ValueError, match="不允许"):
        engine.repository.validate_location(disallowed.id)


def test_batch_has_ten_independent_extractions_and_one_call():
    engine = FireLocalizer(offline=True)
    posts = [post(index, text="华安能源园1号附属楼南边有浓烟" if index % 2 == 0 else "华安能源园2号附属楼东南侧有火光") for index in range(10)]
    response = engine.ingest(posts[:9])
    assert response["pending_count"] == 9
    assert response["updates"] == [] and engine.extractor.calls == 0
    update = engine.ingest(posts[9:])["updates"][0]
    assert engine.extractor.calls == 1
    assert [item["post_id"] for item in update["posts"]] == [p.id for p in posts]
    assert {item["direction"] for item in update["posts"]} == {"南", "东南"}
    assert {item["origin_poi_id"] for item in update["posts"]} == {"B-D-01", "B-D-02"}


def test_reference_fallback_and_strict_threshold():
    engine = FireLocalizer(offline=True)
    default = engine.repository.pois["B-W-01"]
    assert engine.matcher.resolve(Extraction(post_id="1"), default.id)[0] == default
    exact = Extraction(post_id="1", reference="华安能源园2号附属楼")
    engine.matcher.threshold = 1.0
    assert engine.matcher.resolve(exact, default.id)[2] == "posting_location_below_threshold"
    engine.matcher.threshold = 0.7
    assert engine.matcher.resolve(exact, default.id)[0].id == "B-D-02"
    assert engine.matcher.resolve(Extraction(post_id="1", reference="zzzzzz"), default.id)[0] == default


def test_no_candidates_is_ignored_and_single_post_flush():
    engine = FireLocalizer(offline=True)
    response = engine.ingest([post(location_poi_id="EXT-C-001", text="附近有烟味")], flush=True)
    assert response["ignored_count"] == 1
    assert response["updates"][0]["prediction"]["candidates"] == []


def test_vague_posts_have_fractional_votes_without_changing_sample_count(tmp_path, monkeypatch):
    path = tmp_path / "weighted-memory.json"
    engine = FireLocalizer(offline=True, state_path=path)
    candidates = ["T-SW-01", "T-SW-02"]
    radii = []

    def fixed_candidates(origin, direction, radius, sector):
        radii.append(radius)
        return candidates

    monkeypatch.setattr(engine.repository, "candidates", fixed_candidates)
    posts = [post(i, text="附近有烟味") for i in range(4)]
    extracted = [Extraction(post_id=posts[0].id),
                 Extraction(post_id=posts[1].id, reference="zzzzzz"),
                 Extraction(post_id=posts[2].id, direction="南"),
                 Extraction(post_id=posts[3].id, reference="华安能源园2号附属楼")]
    monkeypatch.setattr(engine.extractor, "extract", lambda _: extracted)
    update, = engine.ingest(posts, flush=True)["updates"]
    assert radii == [15] * 4
    assert [p["vote_weight"] for p in update["posts"]] == [0.34, 0.34, 1, 1]
    assert [p["votes"] for p in update["prediction"]["candidates"]] == [2.68, 2.68]
    assert [p["score"] for p in update["prediction"]["candidates"]] == [2.68, 2.68]
    assert all(c.count == 4 for c in engine.memory.clusters)
    assert FireLocalizer(offline=True, state_path=path, resume=True).prediction() == engine.prediction()


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
    generate(repository, path)
    posts = [Post.model_validate(json.loads(line)) for line in path.read_text(encoding="utf-8").splitlines()]
    assert len(posts) == 100
    assert all(repository.pois[p.location_poi_id].type not in {"tank", "tank_group"} for p in posts)
    assert all("ground_truth" not in p.model_dump() for p in posts)
    engine = FireLocalizer(offline=True)
    result = engine.ingest(posts)
    assert engine.extractor.calls == 10
    assert len(result["updates"]) == 10
    assert result["processed_count"] == 100
    assert result["ignored_count"] > 0
    prediction = engine.prediction()
    assert len(prediction["candidates"]) == 3
    assert all(item["poi_id"] in repository.tanks for item in prediction["candidates"])
    assert prediction["coordinate_system"] == "CITY90x75"
    for item in prediction["candidates"]:
        poi = repository.tanks[item["poi_id"]]
        assert item["coordinates"] == {"x_m": poi.x_m, "y_m": poi.y_m}
    assert not engine.prediction(T0+timedelta(hours=3))["candidates"]
