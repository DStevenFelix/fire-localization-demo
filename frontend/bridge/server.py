"""Local bridge for isolated sandbox demonstrations; no paid calls on startup."""
from __future__ import annotations

import json
import hashlib
import math
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import CancelledError, ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from fire_locator.config import Settings
from fire_locator.demo import generate
from fire_locator.engine import FireLocalizer
from fire_locator.models import Post
from fire_locator.poi import DEFAULT_TARGET_ID, PoiRepository
from fire_locator.providers import atomic_json
from .socialnet import BATCH_SIZE, PENDING_CAPACITY, POLL_SECONDS, SocialNet, StreamRun
from .traffic_signals import TrafficSignals

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = PROJECT_ROOT / "runtime" / "frontend"
SESSION_ID = re.compile(r"^[0-9a-f]{32}$")
DATA_FILES = ("fire_sandbox_spatial_model.json", "map_config.json", "map_original.png")
DEMO_POST_COUNT = 100
STABLE_TOP1_BATCHES = 6
SPATIAL_FILES = ('city_scene.json', 'poi_catalog.json', 'poi_hierarchy.json',
                 'fire_resources.json', 'runtime-manifest.json', 'handoff_schema.json')


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def poi_view(poi) -> dict:
    return {"poi_id": poi.id, "name": poi.name, "type": poi.type,
            "coordinates": {"x_m": poi.x_m, "y_m": poi.y_m},
            "can_post": poi.type not in {"tank", "tank_group"}}


class PrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_poi_id: str = DEFAULT_TARGET_ID
    mode: Literal["offline", "live"] = "offline"
    seed: int = Field(default=42, ge=0, le=2**31-1)
    source: Literal["demo", "socialnet"] = "demo"


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    confirm_paid_api: bool = Field(default=False, strict=True)
    paused: bool = Field(default=False, strict=True)
    auto_handoff: bool = Field(default=False, strict=True)


class PauseRequest(BaseModel):
    paused: bool = Field(strict=True)


class SessionService:
    def __init__(self, runtime_root: Path):
        self.runtime_root = runtime_root
        self.repository = PoiRepository(PROJECT_ROOT)
        self.extended_pois = json.loads((PROJECT_ROOT / 'city_scene/poi_catalog.json').read_text(encoding='utf-8'))
        self.extended_by_id = {poi['id']: poi for poi in self.extended_pois}
        self.city_offset = json.loads((PROJECT_ROOT / 'city_scene/city_scene.json').read_text(encoding='utf-8'))['original_map_placement']['offset']
        self.spatial_fingerprint = hashlib.sha256(b''.join((PROJECT_ROOT / 'city_scene' / name).read_bytes() for name in SPATIAL_FILES)).hexdigest()
        self.post_rules_fingerprint = hashlib.sha256(b'\0'.join(
            (PROJECT_ROOT / 'fire_locator' / name).read_bytes() for name in ('demo.py', 'poi.py')
        )).hexdigest()
        self.sessions: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.post_cache_lock = threading.Lock()
        self.live_config_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fire-demo")
        self.collector = ThreadPoolExecutor(max_workers=1, thread_name_prefix="socialnet-feed")
        self.stream_control = threading.RLock()
        self.streams: dict[str, StreamRun] = {}
        self.socialnet = SocialNet()

    def _folder(self, session_id: str) -> Path:
        if not SESSION_ID.fullmatch(session_id):
            raise HTTPException(404, "演示会话不存在")
        return self.runtime_root / session_id

    def _persist(self, session: dict):
        atomic_json(self._folder(session["session_id"]) / "session.json", session)

    def _get_locked(self, session_id: str) -> dict:
        folder = self._folder(session_id)
        if session_id not in self.sessions:
            path = folder / "session.json"
            if not path.exists():
                raise HTTPException(404, "演示会话不存在")
            session = json.loads(path.read_text(encoding="utf-8"))
            if session.get("poi_fingerprint") != self.repository.fingerprint:
                raise HTTPException(409, "会话属于其他地图版本，请重新准备场景")
            if session.get('spatial_fingerprint') != self.spatial_fingerprint:
                raise HTTPException(409, '扩展空间数据已变更，请重新准备场景')
            if session["status"] == "running":
                session.update(status="failed", evaluation=None,
                    error={"error_type": "InterruptedRun", "message": "服务重启中断了本轮演示，请重置后重试。"}, completed_at=now())
                self._persist(session)
            self.sessions[session_id] = session
        return self.sessions[session_id]

    def get(self, session_id: str) -> dict:
        with self.lock:
            return json.loads(json.dumps(self._get_locked(session_id)))

    def active_stream(self) -> dict | None:
        with self.lock:
            for session_id, stream in reversed(self.streams.items()):
                if not stream.stop.is_set() and self.sessions[session_id]["status"] == "running":
                    return self.get(session_id)
        return None

    def posts(self, session_id: str) -> dict:
        folder = self._folder(session_id)
        with self.lock:
            # The normal session lookup can recover an interrupted run and write to disk.
            session = self.sessions.get(session_id)
            if session is None:
                try:
                    session = json.loads((folder / "session.json").read_text(encoding="utf-8"))
                except FileNotFoundError:
                    raise HTTPException(404, "演示会话不存在") from None
                if session.get("poi_fingerprint") != self.repository.fingerprint:
                    raise HTTPException(409, "会话属于其他地图版本，请重新准备场景")
                if session.get("spatial_fingerprint") != self.spatial_fingerprint:
                    raise HTTPException(409, "扩展空间数据已变更，请重新准备场景")
            if session.get("source") == "socialnet":
                stream = self.streams.get(session_id)
                return {"session_id": session_id, "post_count": session["post_count"],
                        "posts": list(stream.recent) if stream else []}
        try:
            lines = (folder / "demo_posts.jsonl").read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            raise HTTPException(404, "会话帖子文件不存在") from None
        posts = sorted((Post.model_validate_json(line) for line in lines if line.strip()),
            key=lambda post: post.timestamp)
        return {"session_id": session_id, "post_count": len(posts), "posts": posts}

    def _post_cache_path(self, request: PrepareRequest) -> Path:
        # Offline and Live use the same generated inputs. The seed and rules still matter.
        identity = (request.target_poi_id, request.seed, DEMO_POST_COUNT, Settings.radius_m,
                    self.repository.fingerprint, self.post_rules_fingerprint)
        key = hashlib.sha256(json.dumps(identity).encode('utf-8')).hexdigest()
        return self.runtime_root / '_demo_posts' / f'{key}.json'

    def _publish_post_cache(self, cache_path: Path, posts: str, metadata: dict) -> None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        # Publish both artifacts together. A failed generator or writer leaves no cache hit.
        with TemporaryDirectory(dir=cache_path.parent) as temporary:
            staged = Path(temporary) / cache_path.name
            atomic_json(staged, {'posts': posts, 'metadata': metadata})
            staged.replace(cache_path)

    def _prepare_posts(self, request: PrepareRequest, output: Path) -> dict:
        cache_path = self._post_cache_path(request)
        with self.post_cache_lock:
            try:
                cached = json.loads(cache_path.read_text(encoding='utf-8'))
                posts, metadata = cached['posts'], cached['metadata']
                if not isinstance(posts, str) or not isinstance(metadata, dict):
                    raise ValueError('Invalid post cache')
            except (FileNotFoundError, ValueError, KeyError, TypeError):
                metadata = generate(self.repository, output, DEMO_POST_COUNT, request.seed, request.target_poi_id)
                self._publish_post_cache(cache_path, output.read_text(encoding='utf-8'), metadata)
                return metadata

        # The runner still reads its own session files, so edits to one run cannot affect others.
        output.write_text(posts, encoding='utf-8')
        atomic_json(output.with_suffix('.meta.json'), metadata)
        return metadata

    def prepare(self, request: PrepareRequest) -> dict:
        with self.stream_control:
            return self._prepare(request)

    def _prepare(self, request: PrepareRequest) -> dict:
        if request.target_poi_id not in self.repository.tanks:
            raise HTTPException(422, "真实火点必须是原始 POI 数据中的独立储罐")
        session_id = uuid.uuid4().hex
        folder = self._folder(session_id)
        folder.mkdir(parents=True, exist_ok=False)
        target = poi_view(self.repository.original_pois[request.target_poi_id])
        ground_truth = {key: target[key] for key in ("poi_id", "name", "coordinates")}
        post_count = 0
        if request.source == "demo":
            isolated_root = folder / "root"
            (isolated_root / "fire_poi").mkdir(parents=True)
            for name in DATA_FILES:
                shutil.copy2(self.repository.data_root / name, isolated_root / "fire_poi" / name)
            (isolated_root / "city_scene").mkdir()
            for name in SPATIAL_FILES:
                shutil.copy2(PROJECT_ROOT / "city_scene" / name, isolated_root / "city_scene" / name)
            try:
                post_count = self._prepare_posts(request, folder / "demo_posts.jsonl")["post_count"]
            except ValueError:
                raise HTTPException(422, "该储罐暂无可用的模拟观察点，请选择其他场景") from None
        session = {"session_id": session_id, "mode": request.mode, "status": "prepared",
            "source": request.source, "analysis_frozen": False, "paused": False,
            "poi_fingerprint": self.repository.fingerprint,
            "spatial_fingerprint": self.spatial_fingerprint,
            "target_poi_id": request.target_poi_id, "seed": request.seed, "post_count": post_count,
            "ground_truth": ground_truth, "prediction": None, "evaluation": None,
            "processed_count": 0, "ignored_count": 0, "batch_count": 0, "batch_history": [], "error": None,
            "created_at": now(), "started_at": None, "completed_at": None}
        with self.lock:
            self.sessions[session_id] = session
            self._persist(session)
        return self.get(session_id)

    def run(self, request: RunRequest) -> dict:
        with self.stream_control:
            return self._run(request)

    def _run(self, request: RunRequest) -> dict:
        if self.get(request.session_id).get("source") == "socialnet":
            return self._start_stream(request)
        with self.lock:
            session = self._get_locked(request.session_id)
            if session["mode"] == "live" and request.confirm_paid_api is not True:
                raise HTTPException(403, "Live 会产生模型 API 费用，请主动确认本次付费调用")
            if session["status"] != "prepared":
                raise HTTPException(409, "本轮已启动，请等待完成或重置后开始新一轮")
            session.update(status="running", started_at=now(), prediction=None, evaluation=None, error=None)
            self._persist(session)
            self.executor.submit(self._execute, request.session_id)
        return self.get(request.session_id)

    def _start_stream(self, request: RunRequest) -> dict:
        session_id = request.session_id
        if not request.confirm_paid_api:
            raise HTTPException(403, "SocialNet 发帖会产生模型 API 费用，请确认后启动")
        with self.stream_control:
            snapshot = self.get(session_id)
            if snapshot["status"] == "running":
                return snapshot
            if snapshot["status"] != "prepared":
                raise HTTPException(409, "请先重置，再启动新一轮仿真")
            try:
                self.socialnet.start(snapshot, paused=request.paused)
                with self.lock:
                    session = self.sessions[session_id] | {"status": "running", "started_at": now(), "paused": request.paused,
                                                           "auto_handoff": request.auto_handoff}
                    self._persist(session)
                    self.sessions[session_id] = session
                    stream = self.streams[session_id] = StreamRun()
                    self.collector.submit(self._collect_stream, session_id, stream)
            except Exception:
                self._stop_source_if_available(session_id)
                raise
            return self.get(session_id)

    def _collect_stream(self, session_id: str, stream: StreamRun):
        with self.lock:
            if stream.stop.is_set():
                return
            epoch = datetime.fromisoformat(self.sessions[session_id]["started_at"]).replace(second=0, microsecond=0)
        after = 0
        retries = 0
        while not stream.stop.is_set():
            try:
                page = self.socialnet.posts(session_id, after)
                retries = 0
            except HTTPException as error:
                retries += 1
                if error.status_code == 503 and retries < 5:
                    stream.stop.wait(POLL_SECONDS)
                    continue
                self._stream_failure(session_id, stream, "SocialNetFeedError", str(error.detail), failed=True)
                self._stop_source_if_available(session_id)
                return
            try:
                with self.lock:
                    if stream.stop.is_set():
                        return
                    session = self.sessions[session_id]
                    for item in page["posts"]:
                        sequence = item["sequence"]
                        if sequence <= after:
                            continue
                        after = sequence
                        post = Post(id=item["id"], text=item["text"], location_poi_id=item["location_poi_id"],
                                    timestamp=epoch + timedelta(minutes=item["simulation_minute"]), urgency="中")
                        stream.recent.append(post.model_dump(mode="json") | {"timestamp": item["timestamp"]})
                        session["post_count"] += 1
                        if session["analysis_frozen"] or session["error"]:
                            continue
                        self.repository.validate_location(post.location_poi_id)
                        if len(stream.pending) >= PENDING_CAPACITY:
                            self._stream_failure(session_id, stream, "QueueFull", "定位来不及处理新帖，已暂停定位并继续展示帖子。")
                        else:
                            stream.pending.append(post)
                    if page["posts"]:
                        self._persist(session)
                    if page["running"] and not session.get("paused") and not session["analysis_frozen"] and not session["error"] and len(stream.pending) >= BATCH_SIZE and (
                            stream.analysis is None or stream.analysis.done()):
                        batch = [stream.pending.popleft() for _ in range(BATCH_SIZE)]
                        stream.analysis = self.executor.submit(self._analyze_stream, session_id, stream, batch)
            except Exception:
                self._stream_failure(session_id, stream, "InvalidSocialNetPost", "SocialNet 帖子格式或发帖 POI 不匹配。", failed=True)
                self._stop_source_if_available(session_id)
                return
            if not page["running"] and not page.get("paused"):
                message = "SocialNet 发帖失败，请检查生成端模型配置或重置重试。" if page["failed"] else "SocialNet 已停止生成帖子。"
                self._stream_failure(session_id, stream, "SocialNetStopped", message, failed=True)
                return
            stream.stop.wait(POLL_SECONDS)

    def _analyze_stream(self, session_id: str, stream: StreamRun, batch: list[Post]):
        try:
            with self.lock:
                if stream.stop.is_set() or stream.analysis_stopped.is_set():
                    return
                snapshot = self.get(session_id)
                if snapshot.get("paused"):
                    stream.pending.extendleft(reversed(batch))
                    return
            offline = snapshot["mode"] == "offline"
            if stream.engine is None:
                settings = Settings(root=PROJECT_ROOT, batch_size=BATCH_SIZE)
                if not offline:
                    with self.live_config_lock:
                        settings = replace(Settings.load(), root=settings.root, batch_size=BATCH_SIZE)
                stream.engine = FireLocalizer(settings, offline=offline, persist_text_embeddings=False,
                    poi_cache_path=self.runtime_root / "_poi_embeddings.json", cancel_event=stream.analysis_stopped)
            engine = stream.engine
            with self.lock:
                if stream.stop.is_set():
                    return
                session = self.sessions[session_id]
                if session["analysis_frozen"] or session["error"]:
                    return
                if session.get("paused"):
                    stream.pending.extendleft(reversed(batch))
                    return
            update = engine.ingest(batch)["updates"][-1]
            prediction = update["prediction"]
            with self.lock:
                if stream.stop.is_set():
                    return
                session = self.sessions[session_id]
                if session["analysis_frozen"] or session["error"]:
                    return
                progress = {"prediction": prediction, "processed_count": engine.memory.processed_count,
                            "ignored_count": engine.memory.ignored_count, "batch_count": engine.memory.batch_count}
                session.update(**progress, evaluation=self._evaluate(prediction, session["ground_truth"]))
                session["batch_history"] = [*session["batch_history"][-59:],
                    {"batch_number": progress["batch_count"], **{key: progress[key] for key in ("prediction", "processed_count", "ignored_count")}}]
                self._auto_handoff_locked(session)
                self._persist(session)
        except CancelledError:
            return
        except Exception:
            self._stream_failure(session_id, stream, "LocalizationError", "定位请求失败，请检查模型配置后重置。")

    def _stream_failure(self, session_id: str, stream: StreamRun, kind: str, message: str, *, failed: bool = False):
        with self.lock:
            if stream.stop.is_set():
                return
            session = self.sessions[session_id]
            if session["analysis_frozen"] and not failed:
                return
            session["error"] = {"error_type": kind, "message": message}
            self._end_analysis(stream)
            if failed:
                session.update(status="failed", completed_at=now())
            self._persist(session)

    def _stop_source_if_available(self, session_id: str):
        try:
            self.socialnet.stop(session_id, reset=True)
        except HTTPException:
            pass

    def _end_analysis(self, stream: StreamRun):
        stream.analysis_stopped.set()
        stream.pending.clear()

        def close_engine(_future=None):
            if stream.engine and hasattr(stream.engine.embeddings, "client"):
                stream.engine.embeddings.client.close()
            stream.engine = None

        if stream.analysis is not None and not stream.analysis.done():
            stream.analysis.add_done_callback(close_engine)
        else:
            close_engine()

    def _handoff_locked(self, session: dict, trigger: str):
        if session["analysis_frozen"]:
            return
        session.update(analysis_frozen=True, handoff_trigger=trigger)
        self._end_analysis(self.streams[session["session_id"]])

    def _auto_handoff_locked(self, session: dict):
        if not session.get("auto_handoff") or session["analysis_frozen"] or session["paused"] or session["error"]:
            return
        recent = session["batch_history"][-STABLE_TOP1_BATCHES:]
        if len(recent) < STABLE_TOP1_BATCHES:
            return
        leaders = [next((c["poi_id"] for c in batch["prediction"]["candidates"] if c["rank"] == 1), None)
                   for batch in recent]
        if leaders[0] and all(leader == leaders[0] for leader in leaders):
            self._handoff_locked(session, "stable_top1")

    def handoff(self, session_id: str) -> dict:
        with self.lock:
            session = self._get_locked(session_id)
            if session.get("source") != "socialnet" or session["status"] != "running" or not (
                    session.get("prediction") or {}).get("candidates"):
                raise HTTPException(409, "至少有一个定位候选且仿真在运行时才能移交")
            self._handoff_locked(session, "manual")
            self._persist(session)
            return self.get(session_id)

    def set_pause(self, session_id: str, paused: bool) -> dict:
        with self.stream_control:
            session = self.get(session_id)
            if session.get("source") != "socialnet" or session["status"] != "running":
                raise HTTPException(409, "只有进行中的 SocialNet 仿真可以暂停或继续")
            self.socialnet.set_pause(session_id, paused)
            with self.lock:
                current = self.sessions[session_id]
                current["paused"] = paused
                self._auto_handoff_locked(current)
                self._persist(current)
                return self.get(session_id)

    def stop_stream(self, session_id: str, *, reset: bool = False) -> dict:
        with self.stream_control:
            snapshot = self.get(session_id)
            if snapshot.get("source") != "socialnet":
                raise HTTPException(409, "本轮不是 SocialNet 流式会话")
            if not reset and not snapshot["analysis_frozen"]:
                raise HTTPException(409, "请先移交应急处置")
            if snapshot["status"] != "prepared":
                self.socialnet.stop(session_id, reset=reset)
            with self.lock:
                stream = self.streams.get(session_id)
                if stream:
                    stream.stop.set()
                    self._end_analysis(stream)
                    if reset:
                        stream.recent.clear()
                        self.streams.pop(session_id)
                if snapshot["status"] != "prepared":
                    session = self.sessions[session_id]
                    session.update(status="completed", completed_at=now(), error=None, paused=False)
                    self._persist(session)
            return self.get(session_id)

    def _evaluate(self, prediction: dict, truth: dict) -> dict:
        candidates = prediction["candidates"]
        ids = [item["poi_id"] for item in candidates]
        top1 = next((item for item in candidates if item["rank"] == 1), None)
        top_coordinates = None
        if top1:
            extended = self.extended_by_id.get(top1["poi_id"])
            top_coordinates = extended["center"] if extended else [
                top1["coordinates"][key] + (0 if prediction.get("coordinate_system") == "CITY90x75" else self.city_offset[i])
                for i, key in enumerate(("x_m", "y_m"))]
        return {"top1_hit": bool(top1 and top1["poi_id"] == truth["poi_id"]), "top3_hit": truth["poi_id"] in ids,
                "target_rank": ids.index(truth["poi_id"]) + 1 if truth["poi_id"] in ids else None,
                "distance_m": round(math.hypot(top_coordinates[0] - truth["coordinates"]["x_m"] - self.city_offset[0],
                    top_coordinates[1] - truth["coordinates"]["y_m"] - self.city_offset[1]), 6) if top_coordinates else None}

    def _execute(self, session_id: str):
        engine = None
        folder = self._folder(session_id)
        try:
            snapshot = self.get(session_id)
            if snapshot["mode"] == "offline":
                # Never load .env, instantiate paid providers, or enable remote tracing offline.
                settings = Settings(root=folder / "root", batch_size=10)
            else:
                # The original Settings loader accesses credentials internally only after consent.
                with self.live_config_lock:
                    settings = replace(Settings.load(), root=folder / "root", batch_size=10)
            posts = sorted([Post.model_validate(json.loads(line)) for line in
                (folder / "demo_posts.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()],
                key=lambda post: post.timestamp)
            engine = FireLocalizer(settings, offline=snapshot["mode"] == "offline",
                state_path=folder / "memory.json", resume=False,
                poi_cache_path=self.runtime_root / "_poi_embeddings.json")
            updates = []
            # 离线批次耗时远低于轮询周期，展示间隔不参与算法时间或推理。
            interval = float(os.getenv("FIRE_OFFLINE_BATCH_INTERVAL", "0.4")) if snapshot["mode"] == "offline" else 0
            if not math.isfinite(interval) or interval < 0:
                raise ValueError("离线批次间隔必须是非负有限数")
            for start in range(0, len(posts), settings.batch_size):
                response = engine.ingest(posts[start:start+settings.batch_size], flush=True)
                updates.extend(response["updates"])
                prediction = response["updates"][-1]["prediction"]
                with self.lock:
                    session = self.sessions[session_id]
                    session.update(prediction=prediction, processed_count=engine.memory.processed_count,
                        ignored_count=engine.memory.ignored_count, batch_count=engine.memory.batch_count)
                    session["batch_history"].append({"batch_number": engine.memory.batch_count,
                        "processed_count": engine.memory.processed_count,
                        "ignored_count": engine.memory.ignored_count, "prediction": prediction})
                    # 先写完整批次审计，再发布同版本会话；API 读取始终受同一锁保护。
                    atomic_json(folder / "batch_results.json", updates)
                    self._persist(session)
                if interval and start+settings.batch_size < len(posts):
                    time.sleep(interval)
            prediction = engine.prediction()  # Uses original synthetic evidence time, not wall clock.
            evaluation = self._evaluate(prediction, snapshot["ground_truth"])
            report = {"mode": snapshot["mode"], "input_count": len(posts),
                "processed_count": engine.memory.processed_count, "ignored_count": engine.memory.ignored_count,
                "batch_count": engine.memory.batch_count, "extractor_invocations": engine.extractor.calls,
                "embedding_requests": engine.embeddings.request_count,
                "prediction": prediction, "evaluation": evaluation,
                "note": "模拟帖子用于流程演示；得分不是经校准的火灾概率。"}
            atomic_json(folder / "prediction.json", prediction)
            atomic_json(folder / "report.json", report)
            atomic_json(folder / "batch_results.json", updates)
            with self.lock:
                session = self.sessions[session_id]
                session.update(status="completed", prediction=prediction, evaluation=evaluation,
                    processed_count=engine.memory.processed_count, ignored_count=engine.memory.ignored_count,
                    batch_count=engine.memory.batch_count, completed_at=now())
                self._persist(session)
        except Exception as error:
            # Exception messages and tracebacks from providers may contain credentials: discard them.
            failure = {"error_type": type(error).__name__, "message": "本轮定位失败，请检查本地服务或模型配置后重置重试；运行模式未切换。"}
            atomic_json(folder / "failure.json", failure)
            with self.lock:
                session = self.sessions[session_id]
                # 保留最近成功发布的预测、历史和进度，不暴露失败提供者的异常原文。
                session.update(status="failed", error=failure, evaluation=None, completed_at=now())
                self._persist(session)
        finally:
            if engine and hasattr(engine.embeddings, "client"):
                engine.embeddings.client.close()

    def reset(self, session_id: str) -> dict:
        with self.stream_control:
            return self._reset(session_id)

    def _reset(self, session_id: str) -> dict:
        previous = self.get(session_id)
        if previous.get("source") == "socialnet":
            self.stop_stream(session_id, reset=True)
            self._purge_history(session_id)
            return self.prepare(PrepareRequest(target_poi_id=previous["target_poi_id"], mode=previous["mode"],
                seed=previous["seed"], source="socialnet"))
        with self.lock:
            previous = self._get_locked(session_id)
            if previous["status"] == "running":
                raise HTTPException(409, "正在定位，请等待本轮结束后重置")
            request = PrepareRequest(target_poi_id=previous["target_poi_id"], mode=previous["mode"], seed=previous["seed"])
        # New immutable run directory; previous results are preserved.
        return self.prepare(request)

    def _purge_history(self, reset_id: str):
        with self.lock:
            root = self.runtime_root.resolve(strict=True)
            # Delete the reset session last so a storage failure on an older run can be retried.
            for path in sorted(root.iterdir(), key=lambda path: path.name == reset_id):
                if path.name != "_demo_posts" and not SESSION_ID.fullmatch(path.name):
                    continue
                session = self.sessions.get(path.name)
                if session and session["status"] == "running":
                    continue
                if path.is_symlink() or not path.is_dir() or path.resolve().parent != root:
                    continue
                try:
                    shutil.rmtree(path)
                except OSError:
                    raise HTTPException(500, "无法清理主项目历史文件，请检查 runtime/frontend 的写入权限后重试") from None
                self.sessions.pop(path.name, None)
                stream = self.streams.pop(path.name, None)
                if stream:
                    stream.stop.set()
                    stream.recent.clear()
                    self._end_analysis(stream)


    def shutdown(self):
        for session_id, stream in self.streams.items():
            if not stream.stop.is_set():
                stream.stop.set()
                self._stop_source_if_available(session_id)
            self._end_analysis(stream)
        self.collector.shutdown(wait=True, cancel_futures=True)
        self.executor.shutdown(wait=True, cancel_futures=True)


def create_app(runtime_root: Path = RUNTIME_ROOT) -> FastAPI:
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    service = SessionService(runtime_root)
    signals = TrafficSignals(os.environ.get("FIRE_SIGNAL_HOST", "192.168.1.190"),
                             int(os.environ.get("FIRE_SIGNAL_PORT", "5000")))

    @asynccontextmanager
    async def lifespan(_app):
        try:
            await signals.start()
            yield
        finally:
            await signals.stop()
            service.shutdown()

    api = FastAPI(title="火情可视化独立 Bridge", version="0.1.0", lifespan=lifespan)
    api.state.service = service

    @api.get("/api/traffic-signals/stream")
    async def signal_stream():
        return StreamingResponse(signals.events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @api.get("/api/health")
    def health():
        return {"status": "ok", "algorithm": "original_fire_locator", "default_mode": "offline",
            "live_requires_confirmation": True}

    @api.get("/api/pois")
    def pois():
        return [poi_view(poi) for poi in service.repository.original_pois.values()]

    @api.get("/api/scenarios")
    def scenarios():
        return {"scenarios": [poi_view(service.repository.original_pois[key]) for key in service.repository.tanks],
            "default_target_poi_id": DEFAULT_TARGET_ID}

    @api.get("/api/scenarios/active")
    def active_stream():
        return service.active_stream()

    @api.get('/api/spatial-data')
    def spatial_data():
        return {'version': '1.0.0', 'original': json.loads((PROJECT_ROOT / 'fire_poi/fire_sandbox_spatial_model.json').read_text(encoding='utf-8')),
                'extended': service.extended_pois,
                'extended_relations': json.loads((PROJECT_ROOT / 'city_scene/poi_hierarchy.json').read_text(encoding='utf-8'))['relations'],
                'city_offset': service.city_offset, 'spatial_fingerprint': service.spatial_fingerprint}

    @api.post("/api/scenarios/prepare", status_code=201)
    def prepare(request: PrepareRequest):
        return service.prepare(request)

    @api.post("/api/localization/run", status_code=202)
    def run(request: RunRequest):
        return service.run(request)

    @api.get("/api/localization/{session_id}")
    def get_session(session_id: str):
        return service.get(session_id)

    @api.get("/api/localization/{session_id}/posts")
    def get_posts(session_id: str):
        return service.posts(session_id)

    @api.post("/api/localization/{session_id}/reset", status_code=201)
    def reset(session_id: str):
        return service.reset(session_id)

    @api.post("/api/localization/{session_id}/handoff")
    def handoff(session_id: str):
        return service.handoff(session_id)

    @api.post("/api/localization/{session_id}/stop")
    def stop(session_id: str):
        return service.stop_stream(session_id)

    @api.put("/api/localization/{session_id}/pause")
    def set_pause(session_id: str, request: PauseRequest):
        return service.set_pause(session_id, request.paused)

    return api


app = create_app()
