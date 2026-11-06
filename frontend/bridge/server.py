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
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from fire_locator.config import Settings
from fire_locator.demo import generate
from fire_locator.engine import FireLocalizer
from fire_locator.models import Post
from fire_locator.poi import DEFAULT_TARGET_ID, PoiRepository
from fire_locator.providers import atomic_json

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = PROJECT_ROOT / "runtime" / "frontend"
SESSION_ID = re.compile(r"^[0-9a-f]{32}$")
DATA_FILES = ("fire_sandbox_spatial_model.json", "map_config.json", "map_original.png")
DEMO_POST_COUNT = 100
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


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    confirm_paid_api: bool = Field(default=False, strict=True)


class SessionService:
    def __init__(self, runtime_root: Path):
        self.runtime_root = runtime_root
        self.repository = PoiRepository(PROJECT_ROOT)
        self.extended_pois = json.loads((PROJECT_ROOT / 'city_scene/poi_catalog.json').read_text(encoding='utf-8'))
        self.extended_by_id = {poi['id']: poi for poi in self.extended_pois}
        self.city_offset = json.loads((PROJECT_ROOT / 'city_scene/city_scene.json').read_text(encoding='utf-8'))['original_map_placement']['offset']
        self.spatial_fingerprint = hashlib.sha256(b''.join((PROJECT_ROOT / 'city_scene' / name).read_bytes() for name in SPATIAL_FILES)).hexdigest()
        self.sessions: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.live_config_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fire-demo")

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

    def prepare(self, request: PrepareRequest) -> dict:
        if request.target_poi_id not in self.repository.tanks:
            raise HTTPException(422, "真实火点必须是原始 POI 数据中的独立储罐")
        session_id = uuid.uuid4().hex
        folder = self._folder(session_id)
        folder.mkdir(parents=True, exist_ok=False)
        isolated_root = folder / "root"
        isolated_root.mkdir()
        (isolated_root / "fire_poi").mkdir()
        for name in DATA_FILES:
            shutil.copy2(self.repository.data_root / name, isolated_root / "fire_poi" / name)
        # The future algorithm receives the same stable data paths inside its existing isolated root.
        (isolated_root / 'city_scene').mkdir()
        for name in SPATIAL_FILES:
            shutil.copy2(PROJECT_ROOT / 'city_scene' / name, isolated_root / 'city_scene' / name)
        try:
            # Ground truth stays in .meta.json and the UI/session; inference receives Post only.
            metadata = generate(self.repository, folder / "demo_posts.jsonl", DEMO_POST_COUNT, request.seed, request.target_poi_id)
        except ValueError:
            raise HTTPException(422, "该储罐暂无可用的模拟观察点，请选择其他场景") from None
        session = {"session_id": session_id, "mode": request.mode, "status": "prepared",
            "poi_fingerprint": self.repository.fingerprint,
            "spatial_fingerprint": self.spatial_fingerprint,
            "target_poi_id": request.target_poi_id, "seed": request.seed, "post_count": metadata["post_count"],
            "ground_truth": metadata["single_fire_ground_truth"], "prediction": None, "evaluation": None,
            "processed_count": 0, "ignored_count": 0, "batch_count": 0, "batch_history": [], "error": None,
            "created_at": now(), "started_at": None, "completed_at": None}
        with self.lock:
            self.sessions[session_id] = session
            self._persist(session)
        return self.get(session_id)

    def run(self, request: RunRequest) -> dict:
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
                state_path=folder / "memory.json", resume=False)
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
            truth = snapshot["ground_truth"]  # Evaluation happens only after inference.
            candidates = prediction["candidates"]
            ids = [item["poi_id"] for item in candidates]
            top1 = next((item for item in candidates if item['rank'] == 1), None)
            top_coordinates = None
            if top1:
                extended = self.extended_by_id.get(top1['poi_id'])
                top_coordinates = extended['center'] if extended else [
                    top1['coordinates'][key] + (0 if prediction.get('coordinate_system') == 'CITY90x75' else self.city_offset[i])
                    for i, key in enumerate(('x_m', 'y_m'))]
            evaluation = {"top1_hit": bool(top1 and top1["poi_id"] == truth["poi_id"]),
                "top3_hit": truth["poi_id"] in ids,
                "target_rank": ids.index(truth["poi_id"])+1 if truth["poi_id"] in ids else None,
                "distance_m": round(math.hypot(top_coordinates[0]-truth['coordinates']['x_m']-self.city_offset[0],
                    top_coordinates[1]-truth['coordinates']['y_m']-self.city_offset[1]), 6) if top_coordinates else None}
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
        with self.lock:
            previous = self._get_locked(session_id)
            if previous["status"] == "running":
                raise HTTPException(409, "正在定位，请等待本轮结束后重置")
            request = PrepareRequest(target_poi_id=previous["target_poi_id"], mode=previous["mode"], seed=previous["seed"])
        # New immutable run directory; previous results are preserved.
        return self.prepare(request)


def create_app(runtime_root: Path = RUNTIME_ROOT) -> FastAPI:
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    service = SessionService(runtime_root)
    @asynccontextmanager
    async def lifespan(_app):
        yield
        service.executor.shutdown(wait=True, cancel_futures=True)

    api = FastAPI(title="火情可视化独立 Bridge", version="0.1.0", lifespan=lifespan)
    api.state.service = service

    @api.get("/api/health")
    def health():
        return {"status": "ok", "algorithm": "original_fire_locator", "default_mode": "offline",
            "live_requires_confirmation": True}

    @api.get("/api/pois")
    def pois():
        return [poi_view(poi) for poi in service.repository.pois.values()]

    @api.get("/api/scenarios")
    def scenarios():
        return {"scenarios": [poi_view(poi) for poi in service.repository.tanks.values()],
            "default_target_poi_id": DEFAULT_TARGET_ID}

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

    @api.post("/api/localization/{session_id}/reset", status_code=201)
    def reset(session_id: str):
        return service.reset(session_id)

    return api


app = create_app()
