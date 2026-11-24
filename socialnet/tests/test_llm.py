import asyncio

import pytest

from app import llm


@pytest.mark.parametrize("value,expected", [(None, 90), ("", 90), ("  ", 90), ("180", 180), ("5", 5), ("600", 600)])
def test_request_timeout_defaults_and_valid_values(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("LLM_REQUEST_TIMEOUT_SECONDS", raising=False)
    else:
        monkeypatch.setenv("LLM_REQUEST_TIMEOUT_SECONDS", value)
    assert llm.request_timeout_seconds() == expected


@pytest.mark.parametrize("value", ["0", "4", "601", "-1", "bad", "nan", "inf"])
def test_invalid_timeout_cannot_disable_deadline(monkeypatch, value):
    monkeypatch.setenv("LLM_REQUEST_TIMEOUT_SECONDS", value)
    with pytest.raises(ValueError, match="LLM_REQUEST_TIMEOUT_SECONDS"):
        llm.request_timeout_seconds()


def test_model_factory_uses_configured_timeout_without_changing_model_or_retry(monkeypatch):
    import langchain_openai
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen3.8-flash")
    monkeypatch.setenv("LLM_REQUEST_TIMEOUT_SECONDS", "180")
    captured = []
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", lambda **kwargs: captured.append(kwargs) or object())
    llm.create_chat_model(.2)
    assert captured[0]["timeout"] == 180
    assert captured[0]["model"] == "qwen3.8-flash" and captured[0]["max_retries"] == 0
    assert "reasoning_effort" not in captured[0]
    assert captured[0]["extra_body"] == {"enable_thinking": False}


@pytest.mark.parametrize("effort,expected", [(None, "low"), ("", "low"), ("medium", "medium"),
                                           ("xhigh", "xhigh"), ("default", None)])
def test_monitor_effort_is_configurable_and_never_changes_resident_options(monkeypatch, effort, expected):
    import langchain_openai
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen3.8-flash")
    if effort is None:
        monkeypatch.delenv("MONITOR_REASONING_EFFORT", raising=False)
    else:
        monkeypatch.setenv("MONITOR_REASONING_EFFORT", effort)
    captured = []
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", lambda **kwargs: captured.append(kwargs) or object())
    llm.create_chat_model(.2, agent_role="monitor")
    llm.create_chat_model(.9)
    assert captured[0].get("reasoning_effort") == expected
    assert "extra_body" not in captured[0]
    assert "reasoning_effort" not in captured[1] and captured[1]["extra_body"] == {"enable_thinking": False}
    assert captured[0]["model"] == captured[1]["model"] == "qwen3.8-flash"
    assert captured[0]["api_key"] == captured[1]["api_key"] == "test-only-never-used"


@pytest.mark.parametrize("model", ["qwen-plus", "gpt-4o-mini"])
def test_monitor_does_not_send_qwen38_only_parameters_to_other_models(monkeypatch, model):
    import langchain_openai
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("DASHSCOPE_MODEL", model)
    monkeypatch.setenv("MONITOR_REASONING_EFFORT", "low")
    captured = []
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", lambda **kwargs: captured.append(kwargs) or object())
    llm.create_chat_model(.2, agent_role="monitor")
    assert "reasoning_effort" not in captured[0] and "extra_body" not in captured[0]


def test_invalid_monitor_effort_fails_explicitly_but_does_not_affect_residents(monkeypatch):
    import langchain_openai
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-never-used")
    monkeypatch.setenv("MONITOR_REASONING_EFFORT", "typo")
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", lambda **kwargs: object())
    with pytest.raises(ValueError, match="MONITOR_REASONING_EFFORT"):
        llm.create_chat_model(.2, agent_role="monitor")
    assert llm.create_chat_model(.9) is not None


def test_outer_deadline_cannot_preempt_the_configured_request_timeout(monkeypatch):
    monkeypatch.setenv("LLM_REQUEST_TIMEOUT_SECONDS", "180")
    deadlines = []
    class Chain:
        async def ainvoke(self, values):
            return values["text"]
    async def wait(awaitable, timeout):
        deadlines.append(timeout)
        return await awaitable
    monkeypatch.setattr(llm.asyncio, "wait_for", wait)
    assert asyncio.run(llm.invoke_chat_model(Chain(), {"text": "model response"})) == "model response"
    assert deadlines == [185]


def test_real_outer_deadline_cancels_one_request_without_retry(monkeypatch):
    monkeypatch.setattr(llm, "request_timeout_seconds", lambda: .01)
    monkeypatch.setattr(llm, "OUTER_TIMEOUT_GRACE_SECONDS", 0)
    calls, cancelled = [], []
    class Chain:
        async def ainvoke(self, values):
            calls.append(1)
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.append(1)
    with pytest.raises(TimeoutError):
        asyncio.run(llm.invoke_chat_model(Chain(), {}))
    assert calls == [1] and cancelled == [1]


def test_timeout_error_displays_limit_and_actor_without_provider_secrets(monkeypatch):
    monkeypatch.setenv("LLM_REQUEST_TIMEOUT_SECONDS", "90")
    issue = llm.request_issue(TimeoutError("secret-provider-key"), 1, agent_role="monitor")
    assert issue.timeout_seconds == 90 and issue.agent_role == "monitor"
    assert "90 秒" in issue.message and "secret-provider-key" not in issue.model_dump_json()
