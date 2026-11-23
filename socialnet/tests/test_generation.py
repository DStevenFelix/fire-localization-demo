import asyncio
from copy import deepcopy
import json

from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableLambda
from langchain_core.messages import AIMessage
import pytest

from app.agents import ResidentContext, ResidentGenerationError
from app.expression import ExpressionPlan
from app.models import FirePolicy
from app.simulation import SimulationEngine


def context_for(engine, resident=None):
    resident = resident or engine.residents[0]
    return ResidentContext(resident, engine._entity_by_id[resident.building_id], None, None, False, 5,
                           community_name="锦安社区", topic_key="books")


def test_observation_is_plain_text_with_generation_constraints_and_one_request():
    engine = SimulationEngine()
    context = context_for(engine)
    context.intent = "observation"
    context.expression_plan = ExpressionPlan(kind="phenomenon", signals=["odor"], cues={"odor": ["焦味"]})
    agent = engine.agents[context.resident.id]
    calls = []
    def generate(values):
        calls.append(deepcopy(values))
        return "闻到一股焦味。"
    agent.chain = RunnableLambda(generate)
    assert asyncio.run(agent.speak(context)) == "闻到一股焦味。"
    assert len(calls) == 1 and agent.last_attempts == 1
    assert json.loads(calls[0]["observation_context"])["signals"] == ["odor"]
    assert "只允许公开这些新感官线索：气味" in calls[0]["evidence_instructions"]
    assert "本轮不知道异常方位" in calls[0]["evidence_instructions"]
    assert "不输出 JSON、claims、quote" in calls[0]["output_contract"]
    assert not {"repair_feedback", "previous_output"}.intersection(calls[0])
    assert agent.last_evidence_quotes == {"odor": "焦味"}
    assert agent.last_source == "llm"


@pytest.mark.parametrize("invalid", ["", "   ", None, '{"content":"想借本书"}', '```text\n想借本书\n```'])
def test_empty_or_non_chat_output_pauses_once_without_rewrite_or_template(invalid):
    engine = SimulationEngine()
    context = context_for(engine)
    agent = engine.agents[context.resident.id]
    calls = []
    def generate(values):
        calls.append(dict(values))
        return invalid
    agent.chain = RunnableLambda(generate)
    with pytest.raises(ResidentGenerationError) as error:
        asyncio.run(agent.speak(context))
    assert len(calls) == 1 and error.value.issue.code == "validation_failed"
    assert error.value.issue.attempts == 1 and "未自动重写" in error.value.issue.reason


def test_request_failure_stops_immediately_without_local_message():
    engine = SimulationEngine()
    context = context_for(engine)
    agent = engine.agents[context.resident.id]
    calls = []
    def generate(_):
        calls.append(1)
        raise RuntimeError("secret-do-not-show-in-errors")
    agent.chain = RunnableLambda(generate)
    with pytest.raises(ResidentGenerationError) as error:
        asyncio.run(agent.speak(context))
    assert len(calls) == 1 and error.value.issue.code == "request_failed"
    assert "secret-do-not-show" not in error.value.issue.model_dump_json()
    assert not agent.last_evidence_quotes


@pytest.mark.real_chain
def test_qwen_prompt_chain_receives_evidence_constraints_and_returns_body_once(monkeypatch):
    import langchain_openai
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key-never-used")
    prompts, options = [], []
    def fake_model(**kwargs):
        options.append(kwargs)
        def generate(prompt):
            prompts.append(prompt.to_messages())
            return AIMessage(content="闻到焦味。")
        return RunnableLambda(generate)
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", fake_model)
    engine = SimulationEngine()
    context = context_for(engine)
    context.intent = "observation"
    context.expression_plan = ExpressionPlan(kind="phenomenon", signals=["odor"], cues={"odor": ["焦味"]})
    assert asyncio.run(engine.agents[context.resident.id].speak(context)) == "闻到焦味。"
    assert len(prompts) == 1 and options[0]["max_retries"] == 0
    assert '"signals": ["odor"]' in prompts[0][1].content
    assert "本轮证据边界" in prompts[0][1].content and "只允许公开这些新感官线索：气味" in prompts[0][1].content
    assert "修正反馈" not in prompts[0][1].content and "上一次输出" not in prompts[0][1].content
    assert "直接输出" in prompts[0][0].content


def test_repetition_is_prompt_controlled_not_regenerated_after_output():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    asyncio.run(engine.tick())
    previous = engine.chats[0]
    context = context_for(engine, next(r for r in engine.residents if r.id == previous.resident_id))
    context.own_messages = [previous]
    calls = []
    def generate(values):
        calls.append(dict(values))
        return previous.content
    agent = engine.agents[context.resident.id]
    agent.chain = RunnableLambda(generate)
    assert asyncio.run(agent.speak(context)) == previous.content
    assert len(calls) == 1 and "repair_feedback" not in calls[0]


def test_length_is_prompt_controlled_and_model_body_is_not_truncated_or_rewritten():
    engine = SimulationEngine()
    context = context_for(engine)
    agent = engine.agents[context.resident.id]
    agent.chain = RunnableLambda(lambda _: "字" * 261)
    assert asyncio.run(agent.speak(context)) == "字" * 261
    assert agent.last_attempts == 1


@pytest.mark.real_chain
def test_no_key_blocks_start_and_step_instead_of_generating_offline_dialogue():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    engine.start()
    assert not engine.running and engine.generation_error.code == "missing_key"
    asyncio.run(engine.tick())
    assert engine.simulation_minute == 0 and not engine.fires and not engine.chats
    assert all(agent.chain is None for agent in engine.agents.values())
    engine.reset()
    assert not engine.generation_error


def test_failed_step_cancels_and_rolls_back_both_rooms_and_retries_successfully(monkeypatch):
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    async def run():
        await engine.tick()
        before = engine.snapshot().model_dump(mode="json")
        observations = deepcopy(engine._observations)
        fire_rng = engine.fire_random.getstate()
        room_rngs = {key: rng.getstate() for key, rng in engine.community_random.items()}
        agent_rngs = {key: agent.random.getstate() for key, agent in engine.agents.items()}
        originals = {key: agent.chain for key, agent in engine.agents.items()}
        finished = asyncio.Event()
        original_tick = engine._community_tick
        async def community_tick(community, fire):
            batch = await original_tick(community, fire)
            if community.id == "A-WEST":
                finished.set()
            return batch
        monkeypatch.setattr(engine, "_community_tick", community_tick)
        async def timeout(_):
            await finished.wait()
            raise TimeoutError("a provider exception must not be published")
        for resident in engine.residents:
            if resident.community_id == "A-EAST":
                engine.agents[resident.id].chain = RunnableLambda(timeout)
        engine.start()
        await engine.tick()
        assert finished.is_set() and not engine.running
        assert engine.generation_error.code == "timeout"
        after = engine.snapshot().model_dump(mode="json")
        after["generation_error"] = None
        assert after == before
        assert engine._observations == observations
        assert engine.fire_random.getstate() == fire_rng
        assert all(rng.getstate() == room_rngs[key] for key, rng in engine.community_random.items())
        assert all(agent.random.getstate() == agent_rngs[key] for key, agent in engine.agents.items())
        for key, chain in originals.items():
            engine.agents[key].chain = chain
        engine.start()
        await engine.tick()
        assert engine.simulation_minute == 10 and engine.running
        assert not engine.generation_error
        assert all(message.generation_source == "llm" for message in engine.chats)
    asyncio.run(run())


def test_outstanding_other_community_call_is_cancelled_and_awaited():
    engine = SimulationEngine()
    async def run():
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def hanging(_):
            entered.set()
            try:
                await asyncio.sleep(3600)
            finally:
                cancelled.set()
        async def failed(_):
            await entered.wait()
            raise RuntimeError("unavailable")
        for resident in engine.residents:
            engine.agents[resident.id].chain = RunnableLambda(failed if resident.community_id == "A-WEST" else hanging)
        await engine.tick()
        assert cancelled.is_set()
        assert engine.generation_error.code == "request_failed"
        assert engine.simulation_minute == 0 and not engine.chats
    asyncio.run(run())


def test_empty_resident_output_never_advances_and_has_no_automatic_retry():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    for agent in engine.agents.values():
        agent.chain = RunnableLambda(lambda _: "")
    engine.start()
    asyncio.run(engine.tick())
    assert not engine.running
    assert engine.generation_error.code == "validation_failed"
    assert engine.generation_error.attempts == 1 and engine.generation_error.reason
    assert engine.simulation_minute == 0 and not engine.fires and not engine.chats and not engine.reports


def test_background_failure_is_broadcast_and_loop_can_be_resumed(monkeypatch):
    from app import main
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    originals = {key: agent.chain for key, agent in engine.agents.items()}
    def fail(_):
        raise RuntimeError("private-provider-body")
    for agent in engine.agents.values():
        agent.chain = RunnableLambda(fail)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setenv("SIMULATION_INTERVAL_SECONDS", "0.02")
    with TestClient(main.app) as client, client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "snapshot"
        client.post("/api/simulation", json={"action": "start"})
        while True:
            event = socket.receive_json()
            if not event.get("state"):
                continue
            state = event["state"]
            if state["generation_error"]:
                break
        assert state["generation_error"]["code"] == "request_failed"
        assert not state["running"] and not state["chats"] and state["simulation_minute"] == 0
        assert "private-provider-body" not in json.dumps(state)
        for key, chain in originals.items():
            engine.agents[key].chain = chain
        client.post("/api/simulation", json={"action": "start"})
        while True:
            event = socket.receive_json()
            if not event.get("state"):
                continue
            state = event["state"]
            if state["simulation_minute"] > 0:
                break
        assert not state["generation_error"] and state["chats"]
        client.post("/api/simulation", json={"action": "pause"})
