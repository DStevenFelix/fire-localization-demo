import asyncio
from collections import Counter
from dataclasses import replace
import json
import random

from langchain_core.runnables import RunnableLambda
import pytest

from app.agents import ResidentContext, ResidentGenerationError
from app.expression import (EvidenceClaim, ExpressionPlan, FireObservation, ObservationRecord,
                            ObservationUtterance, annotate_public_text, choose_expression, validate_observation)
from dialogue_fixtures import observation_fixture
from app.models import FirePolicy
from app.simulation import SimulationEngine


def setup_scene():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    fire = engine._maybe_spawn_fire()
    resident = engine.residents[0]
    observation = FireObservation(
        signals=["odor", "smoke", "flame"], direction="东北", location_hint="华安能源东北作业区",
        cues={"odor": ["一股焦味"], "smoke": ["有连续的浓烟往上冒"], "flame": ["能看见闪动的火光"]},
        severity_hint="火光可见", vantage="锦安社区1号楼的窗边", proximity_hint="隔着道路能望见",
        landmarks=["华安能源东北作业区", "锦安路"], smoke_amount="dense")
    return engine, fire, resident, observation


def utterance(text, **claims):
    return ObservationUtterance(content=text, claims=[EvidenceClaim(kind=key, quote=value) for key, value in claims.items()])


def test_only_selected_evidence_is_sent_to_model_and_public_tags_follow_actual_words():
    engine, fire, resident, observation = setup_scene()
    plan = ExpressionPlan(kind="phenomenon", signals=["odor"], cues={"odor": ["一股焦味"]})
    context = ResidentContext(resident, engine._entity_by_id[resident.building_id], fire, 8, True, 5,
                              community_name="锦安社区", intent="observation", topic_key="fire",
                              observation=observation, expression_plan=plan)
    agent = engine.agents[resident.id]
    values = agent.prompt_values(context)
    public = json.loads(values["observation_context"])
    assert public["signals"] == ["odor"] and set(public["cues"]) == {"odor"}
    assert "火光" not in values["observation_context"] and "东北" not in values["observation_context"]
    assert not public["self_location"] and values["building"] == "本轮不公开住址"
    agent.uses_llm = True
    agent.chain = RunnableLambda(lambda _: "闻到一股焦味。")
    assert asyncio.run(agent.speak(context)) == "闻到一股焦味。"
    assert agent.last_evidence_quotes == {"odor": "一股焦味"}
    assert agent.last_source == "llm"


def test_all_allowed_signals_need_not_be_published():
    plan = ExpressionPlan(kind="phenomenon", signals=["odor", "smoke", "flame"], cues={})
    quotes = validate_observation(utterance("怎么有股焦味？", odor="焦味"), plan)
    assert set(quotes) == {"odor"}


@pytest.mark.parametrize("text,claims", [
    ("闻到焦味，东北边有烟。", {"odor": "焦味"}),
    ("我在1号楼闻到焦味。", {"odor": "焦味"}),
    ("幸福路有股焦味。", {"odor": "焦味"}),
    ("闻到焦味，烟越来越浓了。", {"odor": "焦味"}),
    ("闻到焦味，但没有烟。", {"odor": "焦味"}),
    ("闻到焦味，消防已经到了。", {"odor": "焦味"}),
    ("闻到焦味，有没有邻居能核实？", {"odor": "焦味"}),
    ("闻到焦味，我先把窗关上。", {"odor": "焦味"}),
    ("群里说起火了，我闻到焦味。", {"odor": "焦味"}),
])
def test_unsupported_evidence_actions_or_citations_are_rejected(text, claims):
    plan = ExpressionPlan(kind="phenomenon", signals=["odor"], cues={"odor": ["焦味"]})
    with pytest.raises(ValueError):
        validate_observation(utterance(text, **claims), plan)


def test_position_of_reporter_is_not_position_of_anomaly():
    self_plan = ExpressionPlan(kind="self_location", signals=["odor"], cues={}, self_location="锦安社区1号楼")
    assert validate_observation(utterance("我在1号楼闻到焦味。", odor="焦味", self_location="我在1号楼"), self_plan)
    for text in ("锦安社区1号楼附近着火，有焦味。", "起火点在1号楼，有焦味。"):
        with pytest.raises(ValueError):
            validate_observation(utterance(text, odor="焦味", self_location="1号楼"), self_plan)
    with pytest.raises(ValueError):
        validate_observation(utterance("锦安社区1号楼附近着火，东北边有焦味。", odor="焦味", self_location="锦安社区1号楼"), self_plan)
    direction = ExpressionPlan(kind="direction", signals=["smoke"], cues={}, direction="东北", landmark="华安能源东北作业区")
    good = utterance("往东北看，华安能源东北作业区那边有烟。", smoke="有烟", direction="往东北看", landmark="华安能源东北作业区")
    assert validate_observation(good, direction)
    with pytest.raises(ValueError):
        validate_observation(utterance("往西看，有烟。", smoke="有烟", direction="往西看"), direction)
    with pytest.raises(ValueError):
        validate_observation(utterance("华安能源东北作业区有烟。", smoke="有烟", direction="东北", landmark="华安能源东北作业区"), direction)


def test_change_requires_same_person_same_fire_previous_visual_observation():
    engine, fire, resident, current = setup_scene()
    history = []
    previous = [ObservationRecord(5, replace(current, smoke_amount="thin", signals=["smoke"]))]
    kinds = Counter()
    for seed in range(300):
        plan = choose_expression(resident, current, "锦安社区1号楼", fire.id, 20, history, previous, random.Random(seed))
        kinds[plan.kind] += 1
        if plan.change:
            assert "smoke" in plan.signals
            assert validate_observation(observation_fixture(plan, random.Random(seed)), plan)
    assert kinds["change"] > 0
    for records in ([], [ObservationRecord(25, current)], [ObservationRecord(5, replace(current, signals=["odor"], smoke_amount=None))], [ObservationRecord(5, current)]):
        for seed in range(40):
            plan = choose_expression(resident, current, "锦安社区1号楼", fire.id, 20, history, records, random.Random(seed))
            assert not plan.change


def test_generated_combinations_vary_and_model_fixtures_stay_within_plan():
    engine, fire, resident, current = setup_scene()
    old = ObservationRecord(5, replace(current, signals=["smoke"], smoke_amount="thin"))
    asyncio.run(engine.tick())
    peer = engine.chats[0].model_copy(update={"resident_id": engine.residents[1].id, "intent": "observation", "fire_id": fire.id,
                                            "evidence_source": "direct", "evidence_signals": ["odor", "smoke", "flame"]})
    kinds, subsets = set(), set()
    for seed in range(400):
        plan = choose_expression(resident, current, "锦安社区1号楼", fire.id, 20, [peer], [old], random.Random(seed))
        result = observation_fixture(plan, random.Random(seed))
        quotes = validate_observation(result, plan)
        kinds.add(plan.kind)
        subsets.add(tuple(plan.signals))
        assert all(span in result.content for span in quotes.values())
    assert kinds == {"phenomenon", "self_location", "direction", "boundary", "reaction", "complete", "change", "corroboration"}
    assert len(subsets) == 7


def test_corroboration_never_uses_own_other_room_or_other_fire_messages():
    engine, fire, resident, observation = setup_scene()
    asyncio.run(engine.tick())
    base = engine.chats[0].model_copy(update={"fire_id": fire.id, "intent": "observation", "evidence_source": "direct", "evidence_signals": ["smoke"]})
    invalid = [base.model_copy(update={"resident_id": resident.id}),
               base.model_copy(update={"community_id": "A-EAST", "resident_id": "other"}),
               base.model_copy(update={"fire_id": "other-fire", "resident_id": "other"}),
               base.model_copy(update={"evidence_source": "hearsay", "resident_id": "other"}),
               base.model_copy(update={"simulation_minute": 30, "resident_id": "other"})]
    for seed in range(100):
        plan = choose_expression(resident, observation, "锦安社区1号楼", fire.id, 20, invalid, [], random.Random(seed))
        assert not plan.corroboration


def test_directed_questions_bias_disclosure_but_do_not_grant_new_evidence():
    engine, fire, resident, observation = setup_scene()
    asyncio.run(engine.tick())
    own = engine.chats[0].model_copy(update={"resident_id": resident.id, "fire_id": fire.id})
    question = own.model_copy(update={"id": "question", "resident_id": "another", "reply_to_id": own.id,
                                     "content": "你是在哪里闻到的？火光是哪个方向，和刚才比有变化吗？"})
    odor = replace(observation, signals=["odor"], cues={"odor": ["焦味"]}, direction="", landmarks=[])
    counts = []
    for history in ([own], [own, question]):
        plans = [choose_expression(resident, odor, "锦安社区1号楼", fire.id, 10, history, [], random.Random(seed))
                 for seed in range(500)]
        counts.append(sum(plan.kind == "self_location" for plan in plans))
        assert all(plan.signals == ["odor"] and not plan.direction and not plan.change for plan in plans)
    assert counts[1] > counts[0] * 1.4


@pytest.mark.parametrize("response", ["闻到焦味，看见明火了。", "我在1号楼阳台闻到焦味。", "不知道是什么情况。"])
def test_evidence_is_prompt_controlled_without_semantic_rejection_or_rewrite(response):
    engine, fire, resident, observation = setup_scene()
    agent = engine.agents[resident.id]
    calls = []
    def invalid(_):
        calls.append(1)
        return response
    agent.chain = RunnableLambda(invalid)
    agent.uses_llm = True
    context = ResidentContext(resident, engine._entity_by_id[resident.building_id], fire, 10, True, 5,
                              intent="observation", observation=observation,
                              expression_plan=ExpressionPlan(kind="phenomenon", signals=["odor"], cues={"odor": ["焦味"]}))
    assert asyncio.run(agent.speak(context)) == response
    assert len(calls) == 1 and agent.last_attempts == 1
    assert set(agent.last_evidence_quotes) <= {"odor"}
    assert not hasattr(agent, "observation_parser")


def test_natural_vantage_and_direction_do_not_require_location_quotes():
    engine, fire, resident, observation = setup_scene()
    plan = ExpressionPlan(kind="complete", signals=["smoke"], cues={"smoke": ["灰烟"]},
                          self_location="锦安社区1号楼", direction="东北", uncertainty=True)
    context = ResidentContext(resident, engine._entity_by_id[resident.building_id], fire, 10, True, 5,
                              intent="observation", observation=observation, expression_plan=plan)
    agent = engine.agents[resident.id]
    text = "我在锦安社区1号楼阳台，往东北看有灰烟，不确定来源。"
    agent.chain = RunnableLambda(lambda _: text)
    assert asyncio.run(agent.speak(context)) == text
    assert agent.last_attempts == 1 and agent.last_evidence_quotes["self_location"] == plan.self_location
    rules = agent.prompt_values(context)["evidence_instructions"]
    assert "窗边或阳台" in rules and "本人住址不是异常地点" in rules


def test_text_annotation_never_invents_unpublished_or_unplanned_tags():
    plan = ExpressionPlan(kind="phenomenon", signals=["odor", "smoke"], cues={"odor": ["焦味"], "smoke": ["灰烟"]})
    assert annotate_public_text("闻到焦味。", plan) == {"odor": "焦味"}
    assert annotate_public_text("看到火光。", plan) == {}
    assert annotate_public_text("不知道是什么情况。", plan) == {}


def test_observation_without_recognizable_tag_does_not_crash_the_step(monkeypatch):
    monkeypatch.setattr("app.simulation.perception_probabilities", lambda *args: {"odor": 1, "smoke": 0, "flame": 0})
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    originals = {key: agent.chain for key, agent in engine.agents.items()}
    for key, agent in engine.agents.items():
        original = originals[key]
        async def generate(values, original=original):
            return "不知道是什么情况。" if values["intent"] == "observation" else await original.ainvoke(values)
        agent.chain = RunnableLambda(generate)
    asyncio.run(engine.tick())
    assert not engine.generation_error and engine.simulation_minute == 5
    observations = [m for m in engine.chats if m.intent == "observation"]
    assert len(observations) == len(engine.communities) and all(m.evidence_level == "none" and not m.evidence_signals for m in observations)


def test_corroboration_must_actually_publish_the_shared_sensory_evidence():
    plan = ExpressionPlan(kind="corroboration", signals=["odor", "smoke"], cues={},
                          corroboration={"speaker": "老张", "signal": "smoke", "message_id": "peer"})
    with pytest.raises(ValueError):
        validate_observation(utterance("@老张 闻到焦味。你提到的现象，我也察觉到了。",
                                      odor="焦味", corroboration="你提到的现象，我也察觉到了"), plan)


def test_engine_keeps_private_observations_out_of_public_messages_and_monitor(monkeypatch):
    monkeypatch.setattr("app.simulation.perception_probabilities", lambda distance, intensity: {s: 1 for s in ("odor", "smoke", "flame")})
    monkeypatch.setattr("app.agents.choose_expression", lambda *args: ExpressionPlan(kind="phenomenon", signals=["odor"], cues={"odor": ["焦味"]}))
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    observations = [m for m in engine.chats if m.intent == "observation"]
    assert len(observations) == len(engine.communities)
    assert all(m.evidence_signals == ["odor"] and set(m.evidence_quotes) == {"odor"} for m in observations)
    assert all(set(records[-1].observation.signals) == {"odor", "smoke", "flame"} for records in engine._observations.values())
    assert engine.reports[0].severity == "警告"
    assert "_observations" not in engine.snapshot().model_dump()
    engine.clear_fire()
    assert not engine._observations


def test_private_observation_memory_resets_and_is_bounded():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    async def run():
        await engine.tick()
        engine.fire_policy = FirePolicy(base_probability=0)
        for _ in range(55):
            await engine.tick()
    asyncio.run(run())
    assert engine._observations
    assert all(len(records) <= 8 for records in engine._observations.values())
    assert {m.expression_kind for m in engine.chats if m.intent == "observation"} >= {"phenomenon", "direction", "self_location"}
    engine.reset()
    assert not engine._observations
