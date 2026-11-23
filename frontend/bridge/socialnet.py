"""Receive SocialNet's rule-filtered fire posts through its headless API."""
from __future__ import annotations

import os
from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass, field
from threading import Event

import httpx
from fastapi import HTTPException

from fire_locator.engine import FireLocalizer
from fire_locator.models import Post


BATCH_SIZE = 3
DISPLAY_CAPACITY = 60
PENDING_CAPACITY = 300
POLL_SECONDS = 1


@dataclass
class StreamRun:
    stop: Event = field(default_factory=Event)
    analysis_stopped: Event = field(default_factory=Event)
    recent: deque = field(default_factory=lambda: deque(maxlen=DISPLAY_CAPACITY))
    pending: deque[Post] = field(default_factory=deque)
    engine: FireLocalizer | None = None
    analysis: Future | None = None


class SocialNet:
    def __init__(self):
        self.base = os.getenv("SOCIALNET_BASE_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/post-source"

    def _request(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = httpx.request(method, self.base + path, timeout=5, trust_env=False, **kwargs)
        except httpx.RequestError:
            raise HTTPException(503, "无法连接 SocialNet 帖子源，请检查生成端服务") from None
        try:
            data = response.json()
        except ValueError:
            raise HTTPException(502, "SocialNet 帖子源返回了无效响应") from None
        if not isinstance(data, dict):
            raise HTTPException(502, "SocialNet 帖子源返回了无效响应")
        if not response.is_success:
            detail = data.get("detail")
            raise HTTPException(response.status_code, detail if isinstance(detail, str) else "SocialNet 请求失败")
        return data

    def start(self, session: dict, *, paused: bool = False):
        return self._request("POST", "/runs", json={"run_id": session["session_id"],
            "target_poi_id": session["target_poi_id"], "seed": session["seed"], "paused": paused})

    def posts(self, run_id: str, after: int) -> dict:
        return self._request("GET", f"/runs/{run_id}/posts", params={"after": after})

    def set_pause(self, run_id: str, paused: bool):
        return self._request("PUT", f"/runs/{run_id}/pause", json={"paused": paused})

    def stop(self, run_id: str, *, reset: bool = False):
        return self._request("POST", f"/runs/{run_id}/stop", params={"reset": reset})
