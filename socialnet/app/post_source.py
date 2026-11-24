"""Headless SocialNet service for the fire-localization demo."""
from __future__ import annotations

import asyncio
import logging
import math
import os
from collections import deque
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from .models import FirePolicy, GenerationIssue
from .post_archive import PostArchive, PostArchives
from .simulation import SimulationEngine


logger = logging.getLogger(__name__)
PUBLISH_SECONDS = 10
MAX_PUBLISH_POSTS = 5
PREPARED_POST_TARGET = 2 * MAX_PUBLISH_POSTS


class StartRun(BaseModel):
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    target_poi_id: str
    seed: int = Field(ge=0, le=2**31-1)
    paused: bool = Field(default=False, strict=True)


class PauseRun(BaseModel):
    paused: bool = Field(strict=True)


def create_app(engine_factory=SimulationEngine, *, archives: PostArchives | None = None) -> FastAPI:
    if archives is None:
        archives = PostArchives(Path(__file__).resolve().parents[1] / "runtime" / "post_runs")
    lock = asyncio.Lock()
    posts = deque(maxlen=1024)
    unpublished = deque()
    has_room = asyncio.Event()
    discarded_through = 0
    archived_through = 0
    run: StartRun | None = None
    archive: PostArchive | None = None
    paused = False
    engine: SimulationEngine | None = None
    worker: asyncio.Task | None = None
    publisher: asyncio.Task | None = None
    publish_interval = PUBLISH_SECONDS

    async def generate(source: SimulationEngine, archive: PostArchive):
        nonlocal archived_through
        while source.running:
            await has_room.wait()
            await source.tick()
            if not source.running:
                return
            new_messages = [post for post in source.chats if post.sequence > archived_through]
            archives.append(archive, new_messages)
            if new_messages:
                archived_through = new_messages[-1].sequence
            origins = {post.id: post.building_id for post in new_messages}
            for record in source.discovery_pending:
                if "fire" not in record.categories:
                    continue
                unpublished.append({"sequence": record.sequence, "id": record.message_id,
                                    "text": record.content, "simulation_minute": record.simulation_minute,
                                    "timestamp": record.timestamp, "location_poi_id": origins[record.message_id]})
            if len(unpublished) >= PREPARED_POST_TARGET:
                has_room.clear()
            # Yield even when nobody observed the fire or the model returned immediately.
            await asyncio.sleep(0.1)

    async def publish():
        nonlocal discarded_through
        while engine.running:
            await asyncio.sleep(publish_interval)
            if not engine.running:
                return
            for _ in range(min(MAX_PUBLISH_POSTS, len(unpublished))):
                if len(posts) == posts.maxlen:
                    discarded_through = posts[0]["sequence"]
                posts.append(unpublished.popleft())
            if len(unpublished) < PREPARED_POST_TARGET:
                has_room.set()

    async def run_generator(source: SimulationEngine, archive: PostArchive):
        try:
            await generate(source, archive)
        except OSError:
            logger.warning("Post source cannot write its run archive")
            source.running = False
            source.generation_error = GenerationIssue(code="internal_error", message="SocialNet 帖子存档写入失败")
        except Exception as error:
            # A bad response or local failure must not leave the API claiming that it is still generating.
            logger.warning("Post source stopped: %s", type(error).__name__)
            source.running = False
            source.generation_error = GenerationIssue(code="internal_error", message="帖子源生成失败")

    async def stop():
        nonlocal worker, publisher
        if engine is not None:
            engine.running = False
        tasks = [task for task in (worker, publisher) if task is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        worker = publisher = None

    def start_workers():
        nonlocal worker, publisher
        worker = asyncio.create_task(run_generator(engine, archive))
        publisher = asyncio.create_task(publish())

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal engine, publish_interval
        publish_interval = float(os.getenv("POST_SOURCE_PUBLISH_SECONDS", str(PUBLISH_SECONDS)))
        if not math.isfinite(publish_interval) or publish_interval <= 0:
            raise ValueError("POST_SOURCE_PUBLISH_SECONDS must be positive and finite")
        # Build resident model clients once before readiness. Reset the simulation state between runs.
        engine = engine_factory(fire_policy=FirePolicy(base_probability=0), posts_only=True)
        try:
            yield
        finally:
            await stop()

    api = FastAPI(title="SocialNet 火情帖子源", lifespan=lifespan)

    @api.get("/api/post-source/health")
    async def health():
        return {"status": "ok", "mode": "posts_only"}

    @api.post("/api/post-source/runs")
    async def start(command: StartRun):
        nonlocal run, archive, discarded_through, archived_through, paused
        async with lock:
            if engine is None:
                raise HTTPException(503, "SocialNet 帖子源尚未就绪")
            if run == command and (engine.running or paused):
                return {"run_id": run.run_id}
            if engine.running or paused:
                raise HTTPException(409, "SocialNet 正在为另一轮仿真生成帖子")
            await stop()
            engine.seed = command.seed
            engine.reset()
            try:
                engine.ignite_tank(command.target_poi_id)
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
            engine.start()
            if not engine.running:
                raise HTTPException(503, "SocialNet 居民模型配置不可用，请检查 SocialNet 的 .env")
            try:
                archive = archives.open(command.run_id, command.target_poi_id, command.seed)
            except OSError:
                engine.running = False
                raise HTTPException(507, "SocialNet 无法创建帖子存档，请检查磁盘空间和目录权限") from None
            posts.clear()
            unpublished.clear()
            has_room.set()
            discarded_through = 0
            archived_through = 0
            run = command
            paused = command.paused
            engine.running = not paused
            if not paused:
                start_workers()
            return {"run_id": run.run_id}

    @api.get("/api/post-source/runs/{run_id}/posts")
    async def get_posts(run_id: str, after: int = Query(0, ge=0)):
        if run is None or run.run_id != run_id or engine is None:
            raise HTTPException(404, "SocialNet 仿真轮次不存在")
        if after < discarded_through:
            raise HTTPException(409, "读取进度落后于 SocialNet 的帖子缓冲区")
        return {"posts": [post for post in posts if post["sequence"] > after],
                "running": engine.running, "paused": paused, "failed": engine.generation_error is not None}

    @api.put("/api/post-source/runs/{run_id}/pause")
    async def set_pause(run_id: str, command: PauseRun):
        nonlocal paused
        async with lock:
            if run is None or run.run_id != run_id or engine is None or archive is None:
                raise HTTPException(404, "SocialNet 仿真轮次不存在")
            if not engine.running and not paused:
                raise HTTPException(409, "本轮发帖已结束，需要重置后开始新一轮")
            if command.paused != paused:
                if command.paused:
                    paused = True
                    await stop()
                else:
                    engine.start()
                    if not engine.running:
                        raise HTTPException(503, "SocialNet 居民模型配置不可用，无法继续发帖")
                    paused = False
                    start_workers()
            return {"running": engine.running, "paused": paused}

    @api.post("/api/post-source/runs/{run_id}/stop")
    async def stop_run(run_id: str, reset: bool = False):
        nonlocal run, archive, paused, discarded_through
        async with lock:
            if run is not None and run.run_id == run_id:
                await stop()
                paused = False
                if reset:
                    run = None
                    archive = None
                    engine.reset()
                    posts.clear()
                    unpublished.clear()
                    discarded_through = 0
            return {"running": False}

    return api


load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = create_app()
