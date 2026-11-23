import asyncio
import json
import random
import pytest

from langchain_core.runnables import RunnableLambda
from langchain_core.messages import AIMessage

from app.agents import MonitorAgent, ResidentAgent, ResidentContext, ResidentGenerationError
from app.models import FirePolicy, Point
from app.simulation import SimulationEngine


def test_profiles_and_community_membership_match_buildings():
    engine = SimulationEngine()
    assert [(c.id, len(c.resident_ids), len(c.building_ids)) for c in engine.communities[:4]] == [("A-WEST", 20, 5), ("A-EAST", 16, 4), ("A-SOUTH-W", 8, 2), ("A-SOUTH-E", 4, 1)]
    assert len({r.background for r in engine.residents}) == 300
    assert len(engine.communities) == 10
    for resident in engine.residents:
        assert resident.community_id == engine._entity_by_id[resident.building_id].area_id
        assert resident.household and resident.interests and resident.speaking_style and resident.daily_routine
        assert resident.occupation in resident.background
        if "退休" in resident.occupation:
            assert resident.age >= 60


def test_every_community_generates_new_topics_and_real_replies_without_selection():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    for _ in range(8):
        asyncio.run(engine.tick())
    assert engine.chat_totals == {c.id: 16 for c in engine.communities}
    assert not engine.reports
    by_id = {m.id: m for m in engine.chats}
    for c in engine.communities:
        messages = [m for m in engine.chats if m.community_id == c.id]
        assert len({m.topic_key for m in messages if m.intent == "daily_new"}) >= 6
        for m in messages:
            assert m.resident_id in c.resident_ids and m.building_id in c.building_ids
            assert m.fire_id is None and m.evidence_level == "none"
            if m.reply_to_id:
                target = by_id[m.reply_to_id]
                assert target.community_id == m.community_id
                assert target.resident_id != m.resident_id
                assert target.thread_id == m.thread_id
                assert target.sequence < m.sequence
                assert m.reply_to_name == target.resident_name
                assert m.reply_quote == target.content[:100]


def test_fire_preserves_daily_topics_replies_and_observation_in_both_rooms():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    engine.fire_policy = FirePolicy(base_probability=0)
    for _ in range(12):
        asyncio.run(engine.tick())
    for minute in range(5, 70, 5):
        for c in engine.communities:
            messages = [m for m in engine.chats if m.community_id == c.id and m.simulation_minute == minute]
            assert {"daily_new", "reply"} <= {m.intent for m in messages}
            assert sum(m.intent == "observation" for m in messages) <= 1
            daily = next(m for m in messages if m.intent == "daily_new")
            assert daily.topic == "daily" and daily.fire_id is None
            reply = next(m for m in messages if m.intent == "reply")
            assert reply.evidence_source == ("none" if reply.topic == "daily" else "hearsay")
            assert not reply.evidence_signals
    signals = {s for m in engine.chats if m.intent == "observation" for s in m.evidence_signals}
    assert {"odor", "smoke", "flame"} <= signals
    assert any(len(m.evidence_signals) > 1 for m in engine.chats)
    assert {m.topic for m in engine.chats if m.intent == "reply"} == {"daily", "safety"}


def test_prompt_has_personal_and_room_memory_but_no_other_community(monkeypatch):
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    captured = []
    for agent in engine.agents.values():
        original = agent.prompt_values

        def record(context, original=original):
            values = original(context)
            captured.append((context, values))
            return values

        monkeypatch.setattr(agent, "prompt_values", record)
    for _ in range(10):
        asyncio.run(engine.tick())
    assert any(context.own_messages for context, _ in captured)
    for context, values in captured:
        assert all(m.community_id == context.resident.community_id for m in context.recent_messages)
        assert all(m.resident_id == context.resident.id for m in context.own_messages)
        assert json.loads(values["profile"])["household"] == context.resident.household
        assert values["community"] == engine._entity_by_id[context.resident.community_id].name
        assert "没有新的现场观察" in values["observation_context"]
        other_names = {r.name for r in engine.residents if r.community_id != context.resident.community_id}
        assert all(name not in values["history"] for name in other_names)


def test_observation_permissions_vary_and_never_expose_internal_fire_facts():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    fire = engine._maybe_spawn_fire()
    resident = min(engine.residents, key=lambda r: engine._distance(r.position, fire.position))
    fire.intensity = 5
    observations = [o for seed in range(100) if (o := engine._observation(resident, fire, random.Random(seed)))]
    assert {s for o in observations for s in o.signals} == {"odor", "smoke", "flame"}
    assert any(len(o.signals) == 3 for o in observations)
    for observation in observations:
        context = ResidentContext(resident=resident, building=engine._entity_by_id[resident.building_id],
                                  fire=fire, distance_to_fire=engine._distance(resident.position, fire.position),
                                  is_nearest_building=True, simulation_minute=5, intent="observation",
                                  topic_key="fire", observation=observation)
        values = engine.agents[resident.id].prompt_values(context)
        assert fire.id not in values["observation_context"]
        assert "intensity" not in values["observation_context"]
        assert "沙盘坐标" not in values["observation_context"]
        assert set(observation.cues) == set(observation.signals)
        if observation.signals == ["odor"]:
            assert observation.location_hint == observation.direction == ""
            assert not observation.landmarks
            assert "未确认现场状态" in observation.severity_hint
    assert engine._direction(Point(x=0, y=0), Point(x=1, y=1)) == "东北"
    assert engine._direction(Point(x=1, y=1), Point(x=0, y=0)) == "西南"


def test_llm_path_receives_context_and_failure_is_visible_not_a_crashed_tick():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    resident = engine.residents[0]
    agent = engine.agents[resident.id]
    context = ResidentContext(resident=resident, building=engine._entity_by_id[resident.building_id],
                              fire=None, distance_to_fire=None, is_nearest_building=False,
                              simulation_minute=5, topic_key="books")
    agent.uses_llm = True
    agent.chain = RunnableLambda(lambda values: "最近在翻一本短篇集，有邻居也喜欢这类书吗？")
    assert "短篇集" in asyncio.run(agent.speak(context))
    assert agent.last_source == "llm"

    def fail(_):
        raise RuntimeError("test provider unavailable")

    agent.chain = RunnableLambda(fail)
    with pytest.raises(ResidentGenerationError) as error:
        asyncio.run(agent.speak(context))
    assert error.value.issue.code == "request_failed"


@pytest.mark.real_chain
def test_qwen_chain_formats_full_prompt_without_making_external_requests(monkeypatch):
    import langchain_openai

    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-not-a-real-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen-plus")
    captured = []

    def fake_model(**kwargs):
        def generate(prompt):
            captured.append((kwargs, prompt.to_messages()))
            return AIMessage(content="想借本短篇小说看看，邻居有推荐的吗？")

        return RunnableLambda(generate)

    monkeypatch.setattr(langchain_openai, "ChatOpenAI", fake_model)
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    resident = engine.residents[0]
    agent = ResidentAgent(resident)
    context = ResidentContext(resident=resident, building=engine._entity_by_id[resident.building_id],
                              community_name="锦安社区", fire=None, distance_to_fire=None,
                              is_nearest_building=False, simulation_minute=5, topic_key="books")
    assert "短篇小说" in asyncio.run(agent.speak(context))
    options, messages = captured[-1]
    assert options["model"] == "qwen-plus"
    assert options["base_url"].endswith("/compatible-mode/v1")
    assert len(messages) == 2
    assert resident.household in messages[1].content
    assert "本社区近期聊天" in messages[1].content
    assert "本轮意图" in messages[1].content and "锦安社区" in messages[1].content
    assert agent.last_source == "llm"


def test_retention_is_per_room_and_totals_survive_history_trimming():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))

    async def run():
        for _ in range(65):
            await engine.tick()

    asyncio.run(run())
    assert engine.chat_totals == {c.id: 130 for c in engine.communities}
    assert len(engine.chats) == 120 * len(engine.communities)
    assert all(len([m for m in engine.chats if m.community_id == c.id]) == 120 for c in engine.communities)
    sequences = [m.sequence for m in engine.chats]
    assert sequences == sorted(sequences)
    engine.reset()
    assert engine.chat_totals == {c.id: 0 for c in engine.communities}
    assert engine.snapshot().communities == engine.communities
    assert not engine.chats


def test_daily_cooking_is_not_reported_and_hearsay_is_not_another_witness():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    asyncio.run(engine.tick())
    daily = engine.chats[0].model_copy(update={"content": "做饭的油烟机该擦了，今晚还想吃火锅。"})
    monitor = MonitorAgent()
    assert not asyncio.run(monitor.analyze([daily])).events
    observation = daily.model_copy(update={"intent": "observation", "topic": "fire", "evidence_signals": ["smoke"], "evidence_source": "direct", "content": "看到一股灰烟。"})
    echoes = [observation.model_copy(update={"id": f"echo-{index}", "intent": "reply", "evidence_signals": [], "evidence_source": "hearsay", "building_id": str(index)}) for index in range(4)]
    assert asyncio.run(monitor.analyze([observation, *echoes])).events[0].severity == "警告"
