# 正式定位适配层：复用应用 Chat 配置，单独读取 Embedding 配置，并注入缓存适配器。
# 不选用离线模型；提取和向量缓存按定位会话隔离，支持迟到原帖重放时复用结果。

"""Live adapters for the imported engine. No offline provider is selected here."""

import hashlib
import json
import os
import logging
from functools import lru_cache
from time import perf_counter

import httpx
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import ChatPromptTemplate

from .llm import create_chat_model, request_timeout_seconds
from .spatial import ROOT

logger = logging.getLogger("uvicorn.error.localization")


# 可安全显示给用户的定位配置问题，与提供商原始异常区分。
class LocalizationConfigurationError(ValueError):
    pass


@lru_cache(maxsize=1)
def localization_spatial_fingerprint():
    """完整定位空间快照的内容指纹；数据修改与模型配置一样在重启后生效。"""
    from fire_locator.poi import PoiRepository
    return PoiRepository(ROOT).fingerprint


# 校验专用 Embedding 配置，注入在线适配器；半径与冷却时长采用新版算法默认值。
def create_localizer(state_path):
    required = ("LOCALIZATION_EMBEDDING_API_KEY", "LOCALIZATION_EMBEDDING_BASE_URL", "LOCALIZATION_EMBEDDING_MODEL")
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        raise LocalizationConfigurationError("请配置 " + "、".join(missing) + "，再重试定位。")
    from fire_locator.config import Settings
    from fire_locator.engine import FireLocalizer
    from fire_locator.models import BatchExtraction, Extraction
    from fire_locator.providers import BatchExtractor, SYSTEM_PROMPT, SiliconFlowEmbeddings, atomic_json

    model = create_chat_model(temperature=0, agent_role="localizer")
    if model is None:
        raise LocalizationConfigurationError("定位 Chat 模型未配置，请配置现有千问 API Key。")

    # 缓存成功的逐帖语义提取，迟到原帖重建时复用；不缓存失败结果。
    class CachedExtractor(BatchExtractor):
        # 复用宿主 Chat 模型和输出契约，从当前会话目录加载提取缓存。
        def __init__(self):
            self.calls = 0
            self.parser = PydanticOutputParser(pydantic_object=BatchExtraction)
            prompt = ChatPromptTemplate.from_messages([
                ("system", SYSTEM_PROMPT), ("human", "帖子列表：\n{posts_json}")
            ]).partial(format_instructions=self.parser.get_format_instructions())
            self.chain = prompt | model | self.parser
            self.path = state_path.parent / "extractions.json"
            self.cache = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}

        # 只向模型提交缓存缺失原帖，校验后保存并按输入顺序返回结果。
        def extract(self, posts):
            keys = [hashlib.sha256(p.model_dump_json().encode()).hexdigest() for p in posts]
            missing_posts = [p for p, key in zip(posts, keys) if key not in self.cache]
            if missing_posts:
                started = perf_counter()
                status = "failed"
                try:
                    results = super().extract(missing_posts)
                    status = "valid"
                finally:
                    logger.info("Localization Chat: posts=%d status=%s elapsed_ms=%.1f",
                                len(missing_posts), status, (perf_counter()-started)*1000)
                by_id = {r.post_id: r for r in results}
                for post, key in zip(posts, keys):
                    if key not in self.cache:
                        self.cache[key] = by_id[post.id].model_dump()
                atomic_json(self.path, self.cache)
            return [Extraction.model_validate(self.cache[key]) for key in keys]

    # 沿用通用向量传输实现，改用宿主专用配置，并把每次请求尝试数设为 1。
    class LiveEmbeddings(SiliconFlowEmbeddings):
        max_attempts = 1

        # 记录请求状态和耗时，不记录原帖、向量或服务响应正文。
        def _request(self, texts):
            started = perf_counter()
            status = "failed"
            try:
                result = super()._request(texts)
                status = "valid"
                return result
            finally:
                logger.info("Localization Embedding: texts=%d status=%s elapsed_ms=%.1f",
                            len(texts), status, (perf_counter()-started)*1000)

        # 建立当前会话向量缓存和统一超时客户端，不读取旧 SILICONFLOW_API_KEY 配置。
        def __init__(self):
            self.model = os.environ[required[2]].strip()
            self.base_url = os.environ[required[1]].strip().rstrip("/")
            self.api_key = os.environ[required[0]].strip()
            if not self.base_url.startswith(("https://", "http://")):
                raise LocalizationConfigurationError("Embedding 地址必须是有效的 HTTP(S) Base URL。")
            self.path = state_path.parent / "embeddings.json"
            self.cache = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
            self.poi_cache = {}
            self.client = httpx.Client(timeout=request_timeout_seconds())
            self.request_count = self.cache_hits = 0

    embeddings = LiveEmbeddings()
    settings = Settings(root=ROOT, batch_size=10, embedding_model=embeddings.model,
                        embedding_base=embeddings.base_url, deepseek_model=model.model_name,
                        deepseek_base=str(model.openai_api_base or ""))
    try:
        logger.info("Localization geometry: radius=%s simulation_units; sector=%s degrees; cold_minutes=%s; per-POI weighted evidence",
                    settings.radius_m, settings.sector_degrees, settings.cold_minutes)
        return FireLocalizer(settings=settings, embeddings=embeddings, extractor=CachedExtractor(),
                             state_path=state_path, offline=False,
                             poi_cache_path=state_path.parent / "poi_embeddings.json")
    except Exception:
        embeddings.client.close()
        raise
