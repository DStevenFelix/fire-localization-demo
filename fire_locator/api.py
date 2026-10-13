"""单进程本地服务：POST /posts 由生成 Agent 推入帖子。"""
import os
from datetime import datetime, timedelta
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings
from .engine import FireLocalizer
from .models import Post, SHANGHAI

app = FastAPI(title="火灾定位 LangChain Demo", version="0.1.0")


class IngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    posts: list[Post] = Field(default_factory=list, max_length=1000)
    flush: bool = False


@lru_cache(maxsize=1)
def get_engine():
    settings = Settings.load()
    offline = os.getenv("FIRE_OFFLINE", "0") == "1"
    return FireLocalizer(settings, offline, settings.root/"runtime"/("api_offline" if offline else "api_live")/"memory.json", resume=True)


@app.get("/health")
def health():
    return {"status": "ok", "batch_size": Settings.load().batch_size, "offline": os.getenv("FIRE_OFFLINE", "0") == "1"}


@app.post("/posts")
def ingest(request: IngestRequest):
    now = datetime.now(SHANGHAI)
    # HTTP 服务为实时入口，历史模拟数据请使用 replay，避免历史证据复活。
    if any(post.timestamp < now-timedelta(minutes=60) or post.timestamp > now+timedelta(minutes=1) for post in request.posts):
        raise HTTPException(422, "实时帖子时间必须位于最近 60 分钟内；历史数据请用 replay")
    try:
        return get_engine().ingest(request.posts, request.flush)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except Exception as error:
        raise HTTPException(503, f"批处理未完成 ({type(error).__name__})，已接受的帖子保留在待处理队列，可重试") from None


@app.get("/prediction")
def prediction():
    return get_engine().prediction(datetime.now(SHANGHAI))


@app.get("/pois")
def pois():
    return [{"poi_id": poi.id, "name": poi.name, "type": poi.type,
             "coordinates": {"x_m": poi.x_m, "y_m": poi.y_m}, "can_post": poi.type not in {"tank", "tank_group"}}
            for poi in get_engine().repository.pois.values()]
