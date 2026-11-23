# 共享模型工厂：统一提供商配置、请求时限和安全错误信息；不在此处加载 .env。

"""Shared provider configuration and credential-safe generation errors."""

import asyncio
import logging
import math
import os

from .models import GenerationIssue

MAX_GENERATION_ATTEMPTS = 4
OUTER_TIMEOUT_GRACE_SECONDS = 5
logger = logging.getLogger("uvicorn.error.monitor")


# 读取并验证统一时限，默认 90 秒，允许范围为 5–600 秒。
def request_timeout_seconds() -> float:
    raw = os.getenv("LLM_REQUEST_TIMEOUT_SECONDS", "").strip() or "90"
    try:
        timeout = float(raw)
    except ValueError:
        raise ValueError("LLM_REQUEST_TIMEOUT_SECONDS 必须是5到600之间的秒数。") from None
    if not math.isfinite(timeout) or not 5 <= timeout <= 600:
        raise ValueError("LLM_REQUEST_TIMEOUT_SECONDS 必须是5到600之间的秒数。")
    return timeout


# 给异步模型调用增加请求时限加 5 秒的外层上限，避免无限等待。
async def invoke_chat_model(chain, values):
    return await asyncio.wait_for(chain.ainvoke(values),
                                  timeout=request_timeout_seconds() + OUTER_TIMEOUT_GRACE_SECONDS)


# 居民/监测共享的领域异常，携带安全错误对象供上层暂停和展示。
class AgentGenerationError(Exception):
    # 保留结构化问题，异常文本仅采用可展示的消息。
    def __init__(self, issue: GenerationIssue):
        super().__init__(issue.message)
        self.issue = issue


# OPENAI_API_KEY 优先；按角色配置模型温度与思考参数，关闭 SDK 自动重试。
def create_chat_model(temperature: float, *, agent_role: str = "resident"):
    dashscope_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()
    api_key = openai_key or dashscope_key
    if not api_key:
        return None
    from langchain_openai import ChatOpenAI

    base_url = (os.getenv("OPENAI_BASE_URL", "").strip() or os.getenv("DASHSCOPE_BASE_URL", "").strip()
                or ("https://dashscope.aliyuncs.com/compatible-mode/v1" if dashscope_key else ""))
    dashscope = bool(dashscope_key and not openai_key)
    model = (os.getenv("DASHSCOPE_MODEL", "").strip() or "qwen-plus") if dashscope else (os.getenv("OPENAI_MODEL", "").strip() or "gpt-4o-mini")
    kwargs = dict(model=model, api_key=api_key, temperature=temperature, timeout=request_timeout_seconds(), max_retries=0)
    if agent_role in ("monitor", "localizer"):
        variable = "MONITOR_REASONING_EFFORT" if agent_role == "monitor" else "LOCALIZATION_REASONING_EFFORT"
        effort = os.getenv(variable, "").strip() or "low"
        if effort not in {"low", "medium", "xhigh", "default"}:
            raise ValueError(f"{variable} 必须为 low、medium、xhigh 或 default。")
        # These effort values are documented for Qwen3.8, not every compatible model.
        if effort != "default" and model.startswith("qwen3.8-"):
            kwargs["reasoning_effort"] = effort
        logger.info("%s model configured: reasoning_effort=%s timeout_seconds=%g",
                    "Monitor" if agent_role == "monitor" else "Localization",
                    kwargs.get("reasoning_effort", "provider_default"), request_timeout_seconds())
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


# 把超时、认证、限流和其他请求错误归类，不将可能含凭据的异常原文返回页面。
def request_issue(error: Exception, attempts: int, agent_role="resident", resident_id="", resident_name="") -> GenerationIssue:
    from openai import APITimeoutError, AuthenticationError, RateLimitError

    if isinstance(error, (TimeoutError, APITimeoutError)):
        timeout = request_timeout_seconds()
        code, message = "timeout", f"模型请求超时（当前请求时限 {timeout:g} 秒），本步未提交。可稍后重试；持续超时请检查网关或提高请求时限。"
    elif isinstance(error, AuthenticationError):
        code, message = "request_failed", "模型认证失败，请检查 API Key、地域和模型权限。"
    elif isinstance(error, RateLimitError):
        code, message = "request_failed", "模型请求受限，请检查调用频率和账户额度。"
    else:
        code, message = "request_failed", "模型请求失败，请检查网络、服务地址及模型配置。"
    return GenerationIssue(code=code, message=message, agent_role=agent_role, resident_id=resident_id,
                           resident_name=resident_name, attempts=attempts,
                           timeout_seconds=request_timeout_seconds() if code == "timeout" else None)
