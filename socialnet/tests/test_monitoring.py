import asyncio
from copy import deepcopy
from datetime import UTC, datetime
import json
import logging
import re

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
import pytest

from app.llm import AgentGenerationError
from app.models import ChatMessage, FirePolicy, Point
from app.monitoring import MonitorAgent
from app.simulation import SimulationEngine


def message(key="new", **changes):
    values = dict(id=key, timestamp=datetime.now(UTC), simulation_minute=5, resident_id="resident-ja-01-01",
                  resident_name="测试居民", building_id="POI-JA-01", building_name="锦安社区1号楼", unit="101",
                  position=Point(x=2, y=16), content="窗外有股刺鼻的气味，来源不清楚。", community_id="A10")
    values.update(changes)
    return ChatMessage(**values)


def finding(m, **changes):
    values = dict(title="疑似异常气味", summary="有居民报告异常，尚待核实。", severity="关注",
                  reasoning="只有一条描述，不能确定是否起火。", evidence=[{"message_id": m.id, "quote": m.content}],
                  keywords=["气味"] if "气味" in m.content else [], location_hint="位置尚不明确", uncertainties=["来源待核实"])
    values.update(changes)
    return values


def output(*events):
    return json.dumps({"events": list(events)}, ensure_ascii=False)


def test_model_receives_all_new_messages_public_evidence_and_bounded_history_only():
    monitor = MonitorAgent()
    new = message(fire_id="SECRET-FIRE-ID", topic="daily", evidence_source="direct", evidence_signals=["odor"],
                  evidence_quotes={"odor": "刺鼻的气味"})
    history = [message(f"old-{i}", content="普通聊天") for i in range(60)]
    calls = []
    def generate(values):
        calls.append(deepcopy(values))
        return output(finding(new))
    monitor.chain = RunnableLambda(generate)
    result = asyncio.run(monitor.analyze([new], history))
    assert result.events[0].severity == "关注"
    data = json.loads(calls[0]["new_messages"])[0]
    assert data["content"] == new.content and data["public_signals"] == new.evidence_signals
    assert "public_quotes" not in data  # Already present verbatim in content.
    speakers = json.loads(calls[0]["speakers"])
    assert speakers[new.resident_id] == {"name": new.resident_name, "community": new.community_id,
                                         "reporter_building": new.building_name}
    assert "SECRET-FIRE-ID" not in json.dumps(calls, ensure_ascii=False)
    assert not {"topic", "intent", "position", "fire_id", "intensity", "source_position"}.intersection(data)
    assert len(json.loads(calls[0]["history"])) == 32


def test_compact_input_deduplicates_rows_and_preserves_external_reply_context():
    monitor = MonitorAgent()
    parent = message("parent", content="窗外那条烟是什么情况？")
    reply = message("reply", reply_to_id=parent.id, reply_quote=parent.content,
                    corroborates_message_id=parent.id, evidence_source="hearsay")
    external = message("external", reply_to_id="outside-window", reply_quote="群里刚才有人说闻到焦味")
    calls = []
    monitor.chain = RunnableLambda(lambda values: calls.append(deepcopy(values)) or output())
    asyncio.run(monitor.analyze([reply, external, reply], [parent, parent, reply]))
    rows = json.loads(calls[0]["new_messages"])
    history = json.loads(calls[0]["history"])
    assert [m["id"] for m in rows] == [reply.id, external.id]
    assert [m["id"] for m in history] == [parent.id]
    assert rows[0]["reply_to"] == parent.id and rows[0]["corroborates"] == parent.id
    assert "reply_quote" not in rows[0]
    assert rows[1]["reply_quote"] == external.reply_quote
    assert not {"speaker", "community", "reporter_building", "public_quotes"}.intersection(rows[0])
    assert len(json.loads(calls[0]["speakers"])) == 1


def test_compact_input_keeps_32_unique_history_messages_and_all_new_bodies():
    monitor = MonitorAgent()
    history = [message(f"old-{i}", content="历史正文" + str(i)) for i in range(40)]
    new = [message(f"new-{i}", content="新正文" + str(i)) for i in range(6)]
    calls = []
    monitor.chain = RunnableLambda(lambda values: calls.append(deepcopy(values)) or output())
    asyncio.run(monitor.analyze(new, [*history, *history[-5:], new[0]]))
    assert [m["content"] for m in json.loads(calls[0]["new_messages"])] == [m.content for m in new]
    assert [m["id"] for m in json.loads(calls[0]["history"])] == [m.id for m in history[-32:]]
    schema = json.loads(calls[0]["output_contract"])
    finding_schema = schema["$defs"]["MonitorFinding"]["properties"]
    assert finding_schema["summary"]["maxLength"] == 200
    assert finding_schema["reasoning"]["maxLength"] == 160
    assert finding_schema["uncertainties"]["items"]["maxLength"] == 100


def test_normalized_input_is_smaller_than_repeated_public_message_records():
    monitor = MonitorAgent()
    rows = [message(str(i), content="窗外闻到焦味，暂时还不知道来源。", evidence_source="direct",
                    evidence_signals=["odor"], evidence_quotes={"odor": "闻到焦味"}) for i in range(38)]
    calls = []
    monitor.chain = RunnableLambda(lambda values: calls.append(deepcopy(values)) or output())
    asyncio.run(monitor.analyze(rows[-6:], rows[:-6]))
    previous = [{"id": m.id, "minute": m.simulation_minute, "community": m.community_id,
                 "speaker_id": m.resident_id, "speaker": m.resident_name, "reporter_building": m.building_name,
                 "content": m.content, "reply_to": m.reply_to_id, "corroborates": m.corroborates_message_id,
                 "reply_quote": m.reply_quote, "public_signals": m.evidence_signals,
                 "public_source": m.evidence_source, "public_quotes": m.evidence_quotes} for m in rows]
    old_size = len(json.dumps(previous, ensure_ascii=False))
    new_size = sum(len(calls[0][key]) for key in ("speakers", "new_messages", "history"))
    assert new_size < old_size * .7


def test_severity_and_no_event_decisions_come_from_model_not_old_rules():
    monitor = MonitorAgent()
    flame = message(content="能看到火光。", topic="fire", evidence_signals=["flame"], evidence_source="direct")
    monitor.chain = RunnableLambda(lambda _: output(finding(flame, severity="关注")))
    assert asyncio.run(monitor.analyze([flame])).events[0].severity == "关注"
    monitor.chain = RunnableLambda(lambda _: output())
    assert not asyncio.run(monitor.analyze([flame])).events
    assert not hasattr(monitor, "_detect")


@pytest.mark.parametrize("bad", ["不是JSON", "bad_id", "bad_quote", "history_only", "bad_keyword"])
def test_invalid_monitor_output_is_corrected_with_same_public_input(bad):
    monitor = MonitorAgent()
    new, old = message(), message("old")
    event = finding(new)
    if bad == "bad_id":
        event["evidence"][0]["message_id"] = "invented"
    elif bad == "bad_quote":
        event["evidence"][0]["quote"] = "正文没有这句话"
    elif bad == "history_only":
        event["evidence"][0]["message_id"] = old.id
    elif bad == "bad_keyword":
        event["keywords"] = ["没有出现的关键词"]
    calls = []
    def generate(values):
        calls.append(deepcopy(values))
        if len(calls) == 1:
            return "不是JSON" if bad == "不是JSON" else output(event)
        return output(finding(new))
    monitor.chain = RunnableLambda(generate)
    result = asyncio.run(monitor.analyze([new], [old]))
    assert len(calls) == 2 and monitor.last_attempts == 2
    assert "第1次未通过校验" in calls[1]["repair_feedback"]
    assert calls[0]["new_messages"] == calls[1]["new_messages"]
    assert result.events[0].evidence[0].message_id == new.id


def test_monitor_can_group_multiple_events_without_fabricated_fire_coordinates():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    def generate(values):
        rows = json.loads(values["new_messages"])
        return output(*[dict(title="独立事件" + str(i), summary="按模型判断分别核实。", severity=severity,
                            reasoning="两条证据指向不同问题。", evidence=[{"message_id": row["id"], "quote": row["content"]}])
                        for i, (row, severity) in enumerate(zip(rows[:2], ("紧急", "关注")))])
    engine.monitor.chain = RunnableLambda(generate)
    candidates = [message("first", content="楼道浓烟很大", community_id="A-WEST", building_id="B-W-01"),
                  message("second", content="另一处闻到煤气味", community_id="A-EAST", building_id="B-E-01")]
    engine.reports = asyncio.run(engine._monitor(candidates, context=[]))
    assert len(engine.reports) == 2 and [r.severity for r in engine.reports] == ["紧急", "关注"]
    assert all(not r.fire_ids and not r.fire_positions and r.fire_position is None for r in engine.reports)
    assert all(r.generation_attempts == 1 and r.reasoning for r in engine.reports)


@pytest.mark.parametrize("failure,code", [(RuntimeError, "request_failed"), (TimeoutError, "timeout"), (None, "validation_failed")])
def test_monitor_failure_rolls_back_whole_step_and_can_resume(failure, code):
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    before = engine.snapshot().model_dump(mode="json")
    observations, reported = deepcopy(engine._observations), set(engine._reported_message_ids)
    rng = engine.fire_random.getstate()
    good = engine.monitor.chain
    def fail(_):
        if failure:
            raise failure("PRIVATE-MONITOR-KEY-DO-NOT-EXPOSE")
        return "invalid JSON"
    engine.monitor.chain = RunnableLambda(fail)
    engine.start()
    asyncio.run(engine.tick())
    assert not engine.running and engine.generation_error.code == code
    assert engine.generation_error.agent_role == "monitor"
    assert "PRIVATE-MONITOR" not in engine.generation_error.model_dump_json()
    after = engine.snapshot().model_dump(mode="json")
    after["generation_error"] = None
    assert after == before
    assert engine._observations == observations and engine._reported_message_ids == reported
    assert engine.fire_random.getstate() == rng
    engine.monitor.chain = good
    engine.start()
    asyncio.run(engine.tick())
    assert engine.simulation_minute == 10 and not engine.generation_error


def test_missing_monitor_configuration_blocks_before_generating_resident_messages():
    engine = SimulationEngine()
    engine.monitor.chain = None
    engine.start()
    assert not engine.running and engine.generation_error.agent_role == "monitor"
    assert engine.generation_error.code == "missing_key"
    asyncio.run(engine.tick())
    assert engine.simulation_minute == 0 and not engine.chats


@pytest.mark.real_chain
def test_qwen_monitor_chain_uses_existing_credentials_and_safe_public_prompt(monkeypatch):
    import langchain_openai
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen-plus")
    monkeypatch.setenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    captured = []
    new = message(fire_id="HIDDEN-TRUTH")
    def model(**kwargs):
        def generate(prompt):
            captured.append((kwargs, prompt.to_messages()))
            return AIMessage(content=output(finding(new)))
        return RunnableLambda(generate)
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", model)
    result = asyncio.run(MonitorAgent().analyze([new]))
    options, messages = captured[0]
    assert options["model"] == "qwen-plus" and options["temperature"] == .2
    assert options["base_url"].endswith("/compatible-mode/v1") and options["max_retries"] == 0
    assert "HIDDEN-TRUTH" not in messages[1].content
    assert "居民所属楼栋只是报告者住址" in messages[0].content
    assert result.events[0].severity == "关注"


@pytest.mark.real_chain
def test_qwen38_monitor_uses_low_effort_and_formats_empty_events_example(monkeypatch):
    import langchain_openai
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen3.8-flash")
    monkeypatch.delenv("MONITOR_REASONING_EFFORT", raising=False)
    captured = []
    def model(**kwargs):
        def generate(prompt):
            captured.append((kwargs, prompt.to_messages()))
            return AIMessage(content=output())
        return RunnableLambda(generate)
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", model)
    assert not asyncio.run(MonitorAgent().analyze([message()])).events
    options, messages = captured[0]
    assert options["reasoning_effort"] == "low" and "thinking_budget" not in options
    assert '{"events":[]}' in messages[0].content and "居民表：" in messages[1].content


@pytest.mark.real_chain
def test_actual_sdk_sends_low_effort_to_mock_http_gateway(monkeypatch):
    import httpx
    import langchain_openai
    real_model = langchain_openai.ChatOpenAI
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen3.8-flash")
    monkeypatch.setenv("DASHSCOPE_BASE_URL", "https://gateway.invalid/v1")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("MONITOR_REASONING_EFFORT", "low")
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "mock-completion", "object": "chat.completion", "created": 0,
            "model": "qwen3.8-flash", "choices": [{"index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": output()}}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            monkeypatch.setattr(langchain_openai, "ChatOpenAI",
                                lambda **kwargs: real_model(**kwargs, http_async_client=client))
            assert not (await MonitorAgent().analyze([message()])).events
    asyncio.run(run())
    assert len(requests) == 1
    assert requests[0]["reasoning_effort"] == "low" and requests[0]["model"] == "qwen3.8-flash"
    assert "thinking_budget" not in requests[0]
    assert "居民表：" in requests[0]["messages"][1]["content"]


def test_monitor_has_no_rule_fallback_after_repeated_invalid_output():
    monitor = MonitorAgent()
    calls = []
    def invalid(_):
        calls.append(1)
        return "invalid JSON"
    monitor.chain = RunnableLambda(invalid)
    with pytest.raises(AgentGenerationError) as error:
        asyncio.run(monitor.analyze([message()]))
    assert len(calls) == 4 and error.value.issue.code == "validation_failed"
    assert error.value.issue.agent_role == "monitor"


@pytest.mark.parametrize("changes", [{"reasoning": "   "}, {"uncertainties": [" " * 3]}])
def test_blank_reasoning_or_uncertainties_are_not_published(changes):
    monitor = MonitorAgent()
    new = message()
    calls = []
    def generate(_):
        calls.append(1)
        return output(finding(new, **changes)) if len(calls) == 1 else output(finding(new))
    monitor.chain = RunnableLambda(generate)
    assert asyncio.run(monitor.analyze([new])).events[0].reasoning.strip()
    assert len(calls) == 2


@pytest.mark.parametrize("field,size", [("summary", 201), ("reasoning", 161), ("location_hint", 121)])
def test_overlong_reports_are_corrected_not_truncated(field, size):
    monitor = MonitorAgent()
    new, calls = message(), []
    def generate(values):
        calls.append(deepcopy(values))
        return output(finding(new, **{field: "长" * size})) if len(calls) == 1 else output(finding(new))
    monitor.chain = RunnableLambda(generate)
    result = asyncio.run(monitor.analyze([new]))
    assert len(calls) == 2 and getattr(result.events[0], field) == finding(new)[field]
    assert calls[1]["speakers"] == calls[0]["speakers"]


def test_request_timings_log_validation_corrections_without_chat_or_credentials(caplog):
    caplog.set_level(logging.INFO, logger="uvicorn.error.monitor")
    monitor = MonitorAgent()
    new = message(content="PRIVATE-CHAT-DO-NOT-LOG")
    calls = []
    def generate(_):
        calls.append(1)
        return "PRIVATE-INVALID-OUTPUT" if len(calls) == 1 else output(finding(new))
    monitor.chain = RunnableLambda(generate)
    asyncio.run(monitor.analyze([new]))
    records = [record.getMessage() for record in caplog.records]
    finished = [row for row in records if "Monitor request finished:" in row]
    assert len(finished) == 2 and "status=invalid" in finished[0] and "status=valid" in finished[1]
    assert "attempt=1" in finished[0] and "attempt=2" in finished[1]
    assert len({re.search(r"analysis=(\w+)", row).group(1) for row in records}) == 1
    for row in finished:
        for key in ("request_ms", "validation_ms", "total_ms"):
            assert float(re.search(rf"{key}=([\d.]+)", row).group(1)) >= 0
    assert "PRIVATE-" not in caplog.text


def test_request_timing_is_separate_from_validation_and_total(monkeypatch, caplog):
    import app.monitoring as monitoring
    caplog.set_level(logging.INFO, logger="uvicorn.error.monitor")
    clock = iter([0, 1, 4, 5, 7, 10])
    monkeypatch.setattr(monitoring, "perf_counter", lambda: next(clock))
    monitor = MonitorAgent()
    monitor.chain = RunnableLambda(lambda _: output())
    asyncio.run(monitor.analyze([message()]))
    assert "request_ms=3000.0 validation_ms=2000.0 total_ms=10000.0" in caplog.text


@pytest.mark.parametrize("failure,status", [(TimeoutError, "timeout"), (RuntimeError, "request_failed")])
def test_request_failure_records_one_elapsed_time_without_retry_or_raw_error(caplog, failure, status):
    caplog.set_level(logging.INFO, logger="uvicorn.error.monitor")
    monitor = MonitorAgent()
    def fail(_):
        raise failure("PRIVATE-KEY-DO-NOT-LOG")
    monitor.chain = RunnableLambda(fail)
    with pytest.raises(AgentGenerationError):
        asyncio.run(monitor.analyze([message()]))
    finished = [record.getMessage() for record in caplog.records if "Monitor request finished:" in record.getMessage()]
    assert len(finished) == 1 and f"status={status}" in finished[0]
    assert "request_ms=" in finished[0] and "total_ms=" in finished[0]
    assert monitor.last_attempts == 1 and "PRIVATE-KEY" not in caplog.text


def test_cancelled_monitor_request_is_timed_and_cancellation_propagates(caplog):
    caplog.set_level(logging.INFO, logger="uvicorn.error.monitor")
    monitor = MonitorAgent()
    async def run():
        entered = asyncio.Event()
        async def generate(_):
            entered.set()
            await asyncio.sleep(30)
        monitor.chain = RunnableLambda(generate)
        task = asyncio.create_task(monitor.analyze([message()]))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(run())
    assert "status=cancelled" in caplog.text and "request_ms=" in caplog.text
