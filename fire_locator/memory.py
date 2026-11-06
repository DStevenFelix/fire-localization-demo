"""领域 Memory：维护聚类、向量充分统计量、待处理帖子和去重状态。"""
import copy
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from .providers import atomic_json

FULL_VOTE_UNITS = 100
VAGUE_VOTE_UNITS = 34


@dataclass
class Cluster:
    id: str
    poi_id: str
    last_timestamp: str
    count: int = 0
    vector_sum: list[float] = field(default_factory=list)
    cold: bool = False
    vote_units: int = 0

    @property
    def confidence(self) -> float:
        if self.count < 2:
            return 1.0  # 单帖子缺少成对样本，采用中性约定，输出中保留 count。
        total = np.asarray(self.vector_sum, dtype=float)
        return float(np.clip((np.dot(total, total)-self.count)/(self.count*(self.count-1)), -1, 1))

    @property
    def leading_poi_id(self):
        return self.poi_id

    @property
    def votes(self):
        return {self.poi_id: self.vote_units / FULL_VOTE_UNITS}

    def append_unit(self, unit: np.ndarray, timestamp: datetime, vote_units: int):
        if self.vector_sum and len(unit) != len(self.vector_sum):
            raise ValueError("向量维度变化，不能混用不同 embedding 模型的状态")
        self.vector_sum = (np.asarray(self.vector_sum)+unit).tolist() if self.vector_sum else unit.tolist()
        self.count += 1
        self.vote_units += vote_units
        self.last_timestamp = timestamp.isoformat()


class LocalizationMemory:
    def __init__(self, path: Path | None, signature: str, resume: bool = False):
        self.path = path
        self.signature = signature
        self.clusters: list[Cluster] = []
        self.pending: list[dict] = []
        self.seen: dict[str, str] = {}
        self.last_received: str | None = None
        self.next_cluster_id = 1
        self.batch_count = 0
        self.processed_count = 0
        self.ignored_count = 0
        self.last_batch: list[dict] = []
        if resume and path and path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("signature") != signature or data.get("schema_version") != 3:
                raise ValueError("Memory 的 POI、模型或规则不一致，请使用新的状态文件")
            for key in ("pending", "seen", "last_received", "next_cluster_id", "batch_count", "processed_count", "ignored_count", "last_batch"):
                setattr(self, key, data[key])
            self.clusters = [Cluster(**item) for item in data["clusters"]]

    def clone(self):
        return copy.deepcopy(self)

    def save(self):
        if self.path:
            atomic_json(self.path, self.to_dict())

    def to_dict(self):
        return {"schema_version": 3, "signature": self.signature,
                "clusters": [asdict(c) for c in self.clusters],
                **{key: getattr(self, key) for key in ("pending", "seen", "last_received", "next_cluster_id", "batch_count", "processed_count", "ignored_count", "last_batch")}}

    def expire(self, timestamp: datetime, cold_minutes: int):
        for cluster in self.clusters:
            if not cluster.cold and timestamp-datetime.fromisoformat(cluster.last_timestamp) >= timedelta(minutes=cold_minutes):
                cluster.cold = True

    def add_evidence(self, candidates: list[str], vector: list[float], timestamp: datetime, cold_minutes: int,
                     *, vote_units: int = FULL_VOTE_UNITS) -> list[Cluster]:
        if vote_units not in (VAGUE_VOTE_UNITS, FULL_VOTE_UNITS):
            raise ValueError("无效投票权重")
        unit = np.asarray(vector, dtype=float)
        norm = np.linalg.norm(unit)
        if unit.ndim != 1 or not np.isfinite(unit).all() or not np.isfinite(norm) or norm <= 0:
            raise ValueError("无效帖子向量")
        unit = unit/norm
        self.expire(timestamp, cold_minutes)
        active = {c.poi_id: c for c in self.clusters if not c.cold}
        updated = []
        for poi_id in dict.fromkeys(candidates):
            cluster = active.get(poi_id)
            if cluster is None:
                cluster = Cluster(f"C{self.next_cluster_id:04d}", poi_id, timestamp.isoformat())
                self.next_cluster_id += 1
                self.clusters.append(cluster)
            cluster.append_unit(unit, timestamp, vote_units)
            updated.append(cluster)
        return updated
