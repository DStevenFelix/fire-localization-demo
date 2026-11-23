# 定位编排层：把成功监测关联的公开原帖排队，在线程中顺序调用定位引擎。
# 维护会话/运行代际、迟到证据重建与恢复状态；数据库检查点优先于磁盘工作 Memory。

"""Sequential background inference, source-post deduplication and reset isolation."""

import asyncio
import logging
from copy import deepcopy
import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from fire_locator.models import SHANGHAI

from .localization_provider import (create_localizer, LocalizationConfigurationError,
                                    localization_spatial_fingerprint)
from .models import LocalizationJob, LocalizationState
from .spatial import ROOT
from .storage import StorageError

logger = logging.getLogger("uvicorn.error.localization")
# 固定纪元仅用于把仿真分钟转换为定位时间戳，时间窗按仿真推进，不按真实等待时长。
EPOCH = datetime(2000, 1, 1, 8, tzinfo=SHANGHAI)


# 将实时监测与同步定位算法解耦；队列失败不回滚已提交的群聊。
class LocalizationService:
    # 允许测试注入引擎工厂，正式默认使用在线适配层，并初始化隔离会话。
    def __init__(self, factory=None, runtime_root: Path | None = None):
        self.factory = factory or create_localizer
        self.runtime_root = runtime_root or ROOT / "runtime" / "localization"
        self.on_change = None
        self.on_persist = None
        self._task = None
        self._closed = False
        self._workers = {}
        self.reset()

    # 更换会话和运行代际，清空业务状态；已在线程运行的请求仍由代际检查隔离。
    def reset(self):
        previous = getattr(self, "_engine", None)
        previous_session = getattr(getattr(self, "state", None), "session_id", None)
        if previous and previous_session not in self.busy_sessions() and hasattr(previous.embeddings, "client"):
            previous.embeddings.client.close()
        if self._task and not self._task.done():
            if self._task is not asyncio.current_task():
                self._task.cancel()
                self._task = None
        elif self._task:
            self._task = None
        self.state = LocalizationState(session_id=uuid4().hex)
        self._generation = uuid4().hex
        self._memory_checkpoint = None
        self._restored_memory = None
        self._suspended = False
        self._config_fingerprint = self.configuration_fingerprint()
        self._engine = None
        self._posts = {}
        self._payloads = {}
        self._reports = set()
        self._journal = {}
        self._clock = 0

    # 对模型、地址、提供商及规则生成兼容指纹，不包含密钥值。
    @staticmethod
    def configuration_fingerprint():
        # Hash configuration only; key values never enter a checkpoint or its signature.
        names = ("LOCALIZATION_EMBEDDING_MODEL", "LOCALIZATION_EMBEDDING_BASE_URL", "OPENAI_MODEL",
                 "OPENAI_BASE_URL", "DASHSCOPE_MODEL", "DASHSCOPE_BASE_URL", "LOCALIZATION_REASONING_EFFORT")
        values = {name: os.getenv(name, "").strip() for name in names}
        values["chat_provider"] = "openai" if os.getenv("OPENAI_API_KEY", "").strip() else "dashscope"
        from fire_locator.config import Settings
        values["rules"] = {"algorithm": "independent-poi-weighted-v3", "memory_schema": 3,
                           "radius": Settings.radius_m, "sector": Settings.sector_degrees,
                           "threshold": Settings.match_threshold, "cold_minutes": Settings.cold_minutes,
                           "batch_size": Settings.batch_size}
        values["spatial"] = localization_spatial_fingerprint()
        return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()

    # 深拷贝队列、已收原帖、成功日志和确认的 Memory，用于宿主原子保存。
    def checkpoint(self):
        return deepcopy({"state": self.state.model_dump(mode="json"), "posts": self._posts,
                         "payloads": self._payloads, "reports": sorted(self._reports), "journal": self._journal,
                         "clock": self._clock, "memory": self._memory_checkpoint,
                         "configuration": self._config_fingerprint})

    # 从数据库检查点恢复；运行中任务转待处理并默认暂停，配置不兼容则显式失败。
    def restore(self, data, *, paused=True):
        self.reset()
        self.state = LocalizationState.model_validate(data["state"])
        self.state.revision += 1
        self._posts, self._payloads = deepcopy(data["posts"]), deepcopy(data["payloads"])
        self._reports, self._journal = set(data["reports"]), deepcopy(data["journal"])
        self._clock = data["clock"]
        self._memory_checkpoint = deepcopy(data["memory"])
        self._restored_memory = deepcopy(data["memory"])
        self._config_fingerprint = data["configuration"]
        for job in self.state.jobs:
            if job.status == "running":
                job.status = "queued"
        if self.state.status == "running":
            self.state.status = "queued"
        self._suspended = paused
        self.state.resume_pending = paused and any(j.status == "queued" for j in self.state.jobs)
        if not self._memory_checkpoint:
            # A first-time configuration fix cannot mix vectors when none have been checkpointed.
            self._config_fingerprint = self.configuration_fingerprint()
            from fire_locator.config import Settings
            self.state.cold_minutes = Settings.cold_minutes
        elif self._config_fingerprint != self.configuration_fingerprint():
            self.state.status = "failed"
            self.state.error = "定位存档的模型或规则与当前配置不兼容，请恢复原配置或重置仿真。"
            for job in self.state.jobs:
                if job.status == "queued":
                    job.status, job.error = "failed", self.state.error
                    break
            self.state.resume_pending = False

    # 允许待处理任务继续；实际调度仍需 wake，不会自动重试 failed 任务。
    def resume(self):
        self._suspended = False
        self.state.resume_pending = False

    # 记录单调前进的仿真分钟，用于无新报告时的证据过期计算。
    def advance_time(self, minute):
        self._clock = max(self._clock, minute)

    # 返回状态深拷贝，避免调用方修改内部任务队列。
    def snapshot(self):
        return self.state.model_copy(deep=True)

    # 只构造公开 Post 字段；报告和原帖分别去重，同一原帖级别变化也不重复计票。
    def submit(self, event):
        report_ids = list(dict.fromkeys(event["report_ids"]))
        if not set(report_ids) - self._reports:
            return
        posts = []
        for row in event["posts"]:
            # Full Post validation happens in the worker: bad localization input must not abort a committed tick.
            post = {"id": row["id"], "timestamp": (EPOCH + timedelta(minutes=row["simulation_minute"])).isoformat(),
                    "text": row["text"], "location_poi_id": row["location_poi_id"], "urgency": row["urgency"]}
            if post["id"] in self._posts or any(p["id"] == post["id"] for p in posts):
                # Severity may change in later reports; a source message still votes once.
                continue
            posts.append(post)
        self._reports.update(report_ids)
        self.state.revision += 1
        if not posts:
            for job in self.state.jobs:
                if set(job.message_ids).intersection(row["id"] for row in event["posts"]):
                    job.report_ids = list(dict.fromkeys([*job.report_ids, *report_ids]))
            return
        posts.sort(key=lambda p: (p["timestamp"], p["id"]))
        for post in posts:
            self._posts[post["id"]] = post
        job = LocalizationJob(id="loc-" + uuid4().hex[:12], report_ids=report_ids,
                              message_ids=[p["id"] for p in posts], simulation_minute=event["simulation_minute"])
        self._payloads[job.id] = posts
        self.state.jobs.append(job)
        if self.state.status not in ("failed", "running"):
            self.state.status = "queued"

    # 仅将失败任务重新入队，不清除已成功处理的原帖去重状态。
    def retry(self, job_id):
        job = next((j for j in self.state.jobs if j.id == job_id), None)
        if job is None:
            raise KeyError(job_id)
        if job.status != "failed":
            raise ValueError("只能重试失败的定位任务")
        job.status, job.error = "queued", None
        self.state.status, self.state.error = "queued", None
        self.state.revision += 1

    # 先调用持久化回调，再发送更新；保存失败时不得发布未确认的结果。
    async def notify(self):
        self.state.revision += 1
        if self.on_persist:
            self.on_persist()
        if self.on_change:
            await self.on_change(self.snapshot())

    # 只有未关闭、未挂起且无活动调度任务时才创建 worker，避免并行消费队列。
    def wake(self):
        if not self._closed and not self._suspended and (self._task is None or self._task.done()):
            self._task = asyncio.create_task(self._guarded_work())

    # 列出仍有底层线程工作的会话，供重新激活和缓存删除等待使用。
    def busy_sessions(self):
        return {identity[0] for task, identity in self._workers.items() if not task.done()}

    # 回收已退出代际的模型客户端；线程完成不意味着其结果可回写当前会话。
    def _worker_done(self, task):
        identity = self._workers.pop(task, None)
        if (self._closed or identity and identity[1] != self._generation) and not task.cancelled():
            try:
                result = task.result()
                engine = result[0]
                if engine and hasattr(engine.embeddings, "client"):
                    engine.embeddings.client.close()
            except Exception:
                logger.warning("Retired localization worker could not be closed")

    # 捕获持久化故障并挂起定位，让最后确认的数据库状态保持权威。
    async def _guarded_work(self):
        try:
            await self._work()
        except StorageError:
            self._suspended = True
            logger.error("Localization checkpoint failed; processing paused, uncommitted result not published")

    # 在线程中恢复或创建引擎；迟到原帖触发按原时间重放，缓存避免重复外部请求。
    def _process(self, engine, posts, journal, folder, minute, restored_memory, config_fingerprint):
        replayed = False
        try:
            if engine is None:
                if config_fingerprint != self.configuration_fingerprint():
                    raise LocalizationConfigurationError("定位存档的模型或规则与当前配置不兼容，请恢复原配置或重置仿真。")
                path = folder / ("resume-" + uuid4().hex[:8] + ".json" if restored_memory else "memory.json")
                engine = self.factory(path)
                if restored_memory:
                    if restored_memory["signature"] != engine.memory.signature:
                        if hasattr(engine.embeddings, "client"):
                            engine.embeddings.client.close()
                        engine = None
                        raise LocalizationConfigurationError("定位 Memory 与当前模型或地图规则不兼容，请恢复原配置或重置仿真。")
                    engine.memory.restore(restored_memory)
            last = engine.memory.last_received
            unseen = [p for p in posts if p["id"] not in engine.memory.seen]
            # 引擎要求原帖按时间递增；新报告可能引用旧帖，因此合并成功日志后按原时刻重建。
            if last and any(p["timestamp"] < last for p in unseen):
                # Reports can cite older posts. Preserve original time instead of falsifying arrival time.
                previous = engine
                engine = self.factory(folder / ("replay-" + uuid4().hex[:8] + ".json"))
                if hasattr(previous.embeddings, "client"):
                    previous.embeddings.client.close()
                merged = {**journal, **{p["id"]: p for p in posts}}
                posts = sorted(merged.values(), key=lambda p: (p["timestamp"], p["id"]))
                replayed = True
            result = engine.ingest(posts, flush=True)
            prediction = engine.prediction(EPOCH + timedelta(minutes=minute))
            from fire_locator.providers import atomic_json
            atomic_json(folder / "result.json", {"prediction": prediction, "clusters": engine.cluster_summary(), "audit": result})
            return engine, prediction, engine.cluster_summary(), result, replayed, None
        except Exception as error:
            return engine, None, [], None, replayed, error

    # 只用保存的充分统计量计算过期及排名，不创建 Chat 或 Embedding 客户端。
    @staticmethod
    def _predict_checkpoint(data, minute):
        # Expiry/ranking of stored sufficient statistics needs no Chat or Embedding client.
        import threading
        from fire_locator.config import Settings
        from fire_locator.engine import FireLocalizer
        from fire_locator.memory import LocalizationMemory
        from fire_locator.poi import PoiRepository
        view = FireLocalizer.__new__(FireLocalizer)
        view.settings, view.repository, view.lock = Settings(root=ROOT), PoiRepository(ROOT), threading.RLock()
        view.memory = LocalizationMemory(None, data["signature"])
        view.memory.restore(data)
        return view.prediction(EPOCH + timedelta(minutes=minute))

    # 顺序推进任务和排名时钟；每次异步等待后校验会话/代际，丢弃旧运行结果。
    async def _work(self):
        while not self._closed and not self._suspended and self.state.status != "failed":
            job = next((j for j in self.state.jobs if j.status == "queued"), None)
            if job and self.state.session_id in self.busy_sessions():
                # A reactivated run shares its cache directory with a retiring generation.
                # Wait for those file writers before creating another provider for that run.
                blockers = [task for task, identity in self._workers.items()
                            if identity[0] == self.state.session_id and not task.done()]
                await asyncio.gather(*(asyncio.shield(task) for task in blockers), return_exceptions=True)
                continue
            if job is None:
                if (self._engine or self._memory_checkpoint) and self.state.prediction and self.state.prediction["current_time"] < (EPOCH + timedelta(minutes=self._clock)).isoformat():
                    session, generation = self.state.session_id, self._generation
                    active_engine = self._engine
                    if active_engine:
                        prediction = await asyncio.to_thread(active_engine.prediction, EPOCH + timedelta(minutes=self._clock))
                    else:
                        prediction = await asyncio.to_thread(self._predict_checkpoint, deepcopy(self._memory_checkpoint), self._clock)
                    if session == self.state.session_id and generation == self._generation and not self._closed:
                        self.state.prediction = prediction
                        await self.notify()
                    elif active_engine and hasattr(active_engine.embeddings, "client"):
                        active_engine.embeddings.client.close()
                    continue
                return
            session, generation = self.state.session_id, self._generation
            payload, journal, engine = self._payloads[job.id], dict(self._journal), self._engine
            minute = max(job.simulation_minute, self._clock)
            job.status, job.error = "running", None
            job.attempts += 1
            self.state.status = "running"
            await self.notify()

            # 异步等待可能跨越重置或同档重新载入；会话和代际必须同时匹配。
            if session != self.state.session_id or generation != self._generation or self._closed:
                if engine and hasattr(engine.embeddings, "client"):
                    engine.embeddings.client.close()
                continue
            start = perf_counter()
            folder = self.runtime_root / session
            # 阻塞的 Chat/Embedding 在后台线程运行；shield 保留线程任务，重置后仍需等它结束才能清目录。
            worker = asyncio.create_task(asyncio.to_thread(
                self._process, engine, payload, journal, folder, minute, deepcopy(self._restored_memory),
                self._config_fingerprint))
            self._workers[worker] = (session, generation)
            worker.add_done_callback(self._worker_done)
            engine, prediction, clusters, audit, replayed, error = await asyncio.shield(worker)
            elapsed = (perf_counter() - start) * 1000
            if session != self.state.session_id or generation != self._generation or self._closed:
                if engine and hasattr(engine.embeddings, "client"):
                    engine.embeddings.client.close()
                continue
            self._engine = engine
            self._memory_checkpoint = deepcopy(engine.memory.to_dict()) if engine else self._memory_checkpoint
            self._restored_memory = None if engine else self._restored_memory
            job.elapsed_ms, job.replayed = round(elapsed, 1), replayed
            if error:
                message = (str(error) if isinstance(error, LocalizationConfigurationError) else
                           "定位依赖未安装，请更新 requirements.txt。" if isinstance(error, ModuleNotFoundError) else
                           "定位请求或输出处理失败，请检查模型配置和网络后手动重试。")
                job.status, job.error = "failed", message
                self.state.status, self.state.error = "failed", message
            else:
                job.status = "completed"
                self.state.prediction, self.state.clusters = prediction, clusters
                self.state.error = None
                self.state.status = "queued" if any(j.status == "queued" for j in self.state.jobs) else "completed"
                for post in self._payloads[job.id]:
                    self._journal[post["id"]] = post
            logger.info("Localization finished: job=%s status=%s posts=%d elapsed_ms=%.1f replayed=%s",
                        job.id, job.status, len(job.message_ids), elapsed, replayed)
            await self.notify()

    # 等待当前调度任务结束，主要供确定性测试使用，不主动发起处理。
    async def wait_idle(self):
        if self._task:
            await self._task

    # 停调度并等待线程写入结束，再释放客户端；宿主之后才释放存档进程锁。
    async def close(self):
        self._closed = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._workers:
            # Keep the store owner lock until old writers have actually stopped.
            await asyncio.gather(*list(self._workers), return_exceptions=True)
        if self._engine and hasattr(self._engine.embeddings, "client"):
            self._engine.embeddings.client.close()
