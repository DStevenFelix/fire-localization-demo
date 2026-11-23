"""Public spatial evidence and production geometry, without external model requests."""

import asyncio
from collections import Counter
from dataclasses import replace
import json
import math
import random

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
import pytest

from app.agents import ResidentContext
from app.expression import ExpressionPlan, FireObservation, ObservationRecord, choose_expression
from app.models import Point
from app.simulation import SimulationEngine
from app.spatial import ROOT, load_spatial_model, localization_search_radius, residential_pois
from fire_locator.config import Settings
from fire_locator.engine import FireLocalizer
from fire_locator.models import Post
from fire_locator.poi import PoiRepository


def observation():
    return FireObservation(
        signals=["odor", "smoke", "flame"], direction="东北", location_hint="PRIVATE-LOCATION",
        cues={"odor": ["一股焦味"], "smoke": ["有一缕灰烟往上冒", "出现一小股烟柱"],
              "flame": ["能看见闪动的火光"]},
        severity_hint="PRIVATE-SEVERITY", vantage="PRIVATE-VANTAGE", proximity_hint="PRIVATE-DISTANCE",
        landmarks=["华安能源西北罐区", "锦安路", "PRIVATE-TANK"], smoke_amount="dense")


@pytest.mark.parametrize("style", ["casual", "detailed", "cautious", "practical"])
def test_spatial_disclosure_share_is_sixty_percent_of_eligible_public_visual_reports(style):
    resident = SimulationEngine().residents[0].model_copy(update={"observation_style": style})
    current = observation()
    rng = random.Random(20261104)
    eligible = spatial = 0
    kinds = Counter()
    for _ in range(8000):
        plan = choose_expression(resident, current, "锦安社区1号楼", "private-fire", 20, [], [], rng)
        kinds[plan.kind] += 1
        if set(plan.signals) & {"smoke", "flame"}:
            eligible += 1
            if plan.direction:
                spatial += 1
                assert plan.self_location == "锦安社区1号楼" and plan.direction == "东北"
                assert plan.kind in {"direction", "complete"}
                assert plan.landmark is None
        else:
            assert plan.direction is None and plan.landmark is None
    assert .58 <= spatial / eligible <= .62
    assert set(kinds) == {"phenomenon", "self_location", "direction", "complete", "boundary", "reaction"}


def test_repeated_spatial_history_does_not_dilute_group_probability_or_hide_other_evidence():
    engine = SimulationEngine()
    asyncio.run(engine.tick())
    resident = engine.residents[0]
    current = observation()
    peer = engine.chats[0].model_copy(update={
        "resident_id": "another", "community_id": resident.community_id, "simulation_minute": 15,
        "fire_id": "private-fire", "evidence_source": "direct", "evidence_signals": ["odor", "smoke", "flame"],
        "intent": "observation", "expression_kind": "direction"})
    history = [peer.model_copy(update={"id": f"peer-{i}", "expression_kind": "direction" if i % 2 else "complete"})
               for i in range(6)]
    previous = [ObservationRecord(5, replace(current, smoke_amount="thin"))]
    plans = [choose_expression(resident, current, "锦安社区1号楼", "private-fire", 20,
                               history, previous, random.Random(seed)) for seed in range(8000)]
    eligible = [p for p in plans if set(p.signals) & {"smoke", "flame"}]
    assert .58 <= sum(bool(p.direction) for p in eligible) / len(eligible) <= .62
    assert {p.kind for p in plans} == {
        "phenomenon", "self_location", "direction", "complete", "boundary", "reaction", "change", "corroboration"}


@pytest.mark.parametrize("signals", [["odor"], ["smoke"], ["flame"], ["odor", "smoke", "flame"]])
def test_dynamic_examples_only_express_public_signals_and_spatial_facts(signals):
    current = observation()
    resident = SimulationEngine().residents[0]
    current = replace(current, signals=signals, cues={s: current.cues[s] for s in signals})
    for seed in range(100):
        plan = choose_expression(resident, current, "锦安社区1号楼", "private-fire", 20, [], [], random.Random(seed))
        examples = plan.generation_examples()
        assert 1 <= len(examples) <= 2
        text = "".join(examples)
        assert "PRIVATE" not in text and "private-fire" not in text
        assert "锦安路" not in text and "罐区" not in text
        if plan.direction:
            assert all(plan.self_location in example and plan.direction in example for example in examples)
        if not plan.self_location:
            assert "锦安社区1号楼" not in text and "窗边" not in text
        if "smoke" not in plan.signals:
            assert "灰烟" not in text and "烟柱" not in text
        if "flame" not in plan.signals:
            assert "火光" not in text
        if "odor" not in plan.signals:
            assert "焦味" not in text
        if plan.signals == ["odor"]:
            assert "东北" not in text and "火光" not in text and "灰烟" not in text
        assert not any(word in text for word in ("越来越", "一直", "刚才", "上次", "变浓"))


def test_examples_require_actual_cues_and_only_add_authorized_history_and_actions():
    assert ExpressionPlan(kind="phenomenon", signals=["odor"], cues={}).generation_examples() == []
    plan = ExpressionPlan(kind="corroboration", signals=["odor", "smoke"],
                          cues={"odor": ["焦味"], "smoke": ["有一缕灰烟往上冒"]},
                          corroboration={"speaker": "老张", "message_id": "peer", "signal": "smoke"})
    text = "".join(plan.generation_examples())
    assert "@老张" in text and "灰烟" in text and "焦味" not in text
    assert "关窗" not in text and "核实" not in text and "上次" not in text
    plan.change = "上次烟量还比较小，这次看到的烟柱明显了"
    plan.personal_reaction = plan.verification_request = plan.uncertainty = True
    for example in plan.generation_examples():
        assert plan.change in example and "核实" in example and "窗关好" in example and "不确定" in example


@pytest.mark.real_chain
@pytest.mark.parametrize("spatial", [False, True])
def test_actual_resident_prompt_has_scoped_examples_and_no_private_fire_details(monkeypatch, spatial):
    prompts = []
    def generate(prompt):
        prompts.append(prompt.to_messages())
        return AIMessage(content="模型自行生成的正文。")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-not-real")
    monkeypatch.setattr("app.agents.create_chat_model", lambda **_: RunnableLambda(generate))
    engine = SimulationEngine()
    resident = engine.residents[0]
    home = engine._entity_by_id[resident.building_id]
    plan = ExpressionPlan(kind="direction" if spatial else "phenomenon",
                          signals=["smoke"] if spatial else ["odor"],
                          cues={"smoke": ["有一缕灰烟往上冒"]} if spatial else {"odor": ["一股焦味"]},
                          self_location=home.name if spatial else None, direction="东北" if spatial else None)
    context = ResidentContext(resident, home, None, 999.123, True, 20, fire_location="PRIVATE-FIRE-LOCATION",
                              intent="observation", observation=observation(), expression_plan=plan)
    agent = engine.agents[resident.id]
    assert asyncio.run(agent.speak(context)) == "模型自行生成的正文。"
    assert agent.last_attempts == len(prompts) == 1
    human = prompts[0][-1].content
    assert "本轮表达示例" in human
    assert all(example in human for example in plan.generation_examples())
    assert "PRIVATE" not in human and "999.123" not in human and "T-NW-" not in human
    assert "越来越浓" not in json.dumps(plan.generation_examples(), ensure_ascii=False)
    if spatial:
        assert f"完整住宅名“{home.name}”" in human and "住宅是唯一命名参照" in human
        assert "锦安路" not in human and "罐区" not in json.dumps(plan.public_facts(), ensure_ascii=False)
    else:
        public_section = human.split("本轮表达示例", 1)[1]
        assert "东北" not in public_section and home.name not in public_section
        assert "本轮不知道异常方位" in human
        assert "灰烟" not in public_section and "火光" not in public_section


def test_search_radius_is_minimal_integer_covering_all_home_tank_pairs():
    homes = residential_pois()
    tanks = [p for p in load_spatial_model()["pois"] if p["entity_type"] == "Tank"]
    distances = [math.dist(home["center"], [tank["center"][0]+30, tank["center"][1]+25]) for home in homes for tank in tanks]
    radius = localization_search_radius()
    assert len(distances) == 600 and radius == math.ceil(max(distances))
    assert radius - 1 < max(distances) <= radius
    assert Settings().radius_m == 15  # Production now follows the upstream radius, not the coverage helper.
    for tank in tanks:
        if tank["id"] in {"T-NW-02", "T-NE-01"}:
            assert all(math.dist(home["center"], [tank["center"][0]+30, tank["center"][1]+25]) > 10 for home in homes if home["parent_id"].startswith("A-"))


def test_map_radius_recomputes_from_canonical_centers(monkeypatch):
    monkeypatch.setattr("app.spatial.residential_pois", lambda: [{"center": [30, 25]}])
    monkeypatch.setattr("app.spatial.load_spatial_model", lambda: {
        "pois": [{"entity_type": "Tank", "center": [5, 12]}]})
    assert localization_search_radius() == 13


def test_all_home_tank_reports_extract_home_reference_and_retain_target_with_test_models():
    # Explicit extraction/embedding doubles exercise the existing pipeline; no paid API calls.
    engine = FireLocalizer(settings=Settings(root=ROOT, radius_m=localization_search_radius()), offline=True)
    repository = PoiRepository(ROOT)
    posts, expected = [], {}
    for home in residential_pois():
        origin = repository.pois[home["id"]]
        for tank in repository.tanks.values():
            direction = SimulationEngine._direction(Point(x=origin.x_m, y=origin.y_m), Point(x=tank.x_m, y=tank.y_m))
            assert tank.id in repository.candidates(origin, direction, localization_search_radius())
            plan = ExpressionPlan(kind="direction", signals=["smoke"], cues={"smoke": ["有一缕灰烟往上冒"]},
                                  self_location=home["name"], direction=direction)
            text = plan.generation_examples()[len(posts) % 2]
            post_id = f"spatial-{len(posts)}"
            expected[post_id] = (home["id"], home["name"], direction, tank.id)
            posts.append(Post(id=post_id, timestamp="2000-01-01T08:05:00+08:00", text=text,
                              location_poi_id=home["id"], urgency="中"))
    result = engine.ingest(posts, flush=True)
    audits = [item for update in result["updates"] for item in update["posts"]]
    assert len(audits) == result["processed_count"] == 600 and engine.memory.ignored_count == 0
    for item in audits:
        home_id, home_name, direction, target_id = expected[item["post_id"]]
        assert item["origin_poi_id"] == home_id and item["reference"] == home_name
        assert item["direction"] == direction and target_id in item["candidate_poi_ids"]

