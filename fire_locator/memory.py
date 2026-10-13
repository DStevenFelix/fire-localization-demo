"""领域 Memory：维护聚类、向量充分统计量、待处理帖子和去重状态。"""
import copy
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from .providers import atomic_json


@dataclass
class Cluster:
    id: str
    last_timestamp: str
    count: int = 0
    candidates: list[str] = field(default_factory=list)
    votes: dict[str, int] = field(default_factory=dict)
    vector_sum: list[float] = field(default_factory=list)
    cold: bool = False

    @property
    def confidence(self) -> float:
        if self.count < 2:
            return 1.0  # 单帖子缺少成对样本，采用中性约定，输出中保留 count。
        total = np.asarray(self.vector_sum, dtype=float)
        return float(np.clip((np.dot(total, total)-self.count)/(self.count*(self.count-1)), -1, 1))

    @property
    def leading_poi_id(self):
        return min(self.votes, key=lambda key: (-self.votes[key], key)) if self.votes else None

    def append(self, candidates: list[str], vector: list[float], timestamp: datetime):
        unit = np.asarray(vector, dtype=float)
        norm = np.linalg.norm(unit)
        if not np.isfinite(unit).all() or not np.isfinite(norm) or norm <= 0:
            raise ValueError("无效帖子向量")
        unit = unit/norm
        if self.vector_sum and len(unit) != len(self.vector_sum):
            raise ValueError("向量维度变化，不能混用不同 embedding 模型的状态")
        self.vector_sum = (np.asarray(self.vector_sum)+unit).tolist() if self.vector_sum else unit.tolist()
        self.count += 1
        self.last_timestamp = max(self.last_timestamp, timestamp.isoformat())
        self.candidates = sorted(set(self.candidates) | set(candidates))
        for poi_id in candidates:
            self.votes[poi_id] = self.votes.get(poi_id, 0)+1

    def merge(self, other: "Cluster"):
        self.count += other.count
        self.last_timestamp = max(self.last_timestamp, other.last_timestamp)
        self.vector_sum = (np.asarray(self.vector_sum)+np.asarray(other.vector_sum)).tolist()
        self.candidates = sorted(set(self.candidates) | set(other.candidates))
        for key, value in other.votes.items():
            self.votes[key] = self.votes.get(key, 0)+value


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
            if data.get("signature") != signature or data.get("schema_version") != 1:
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
        return {"schema_version": 1, "signature": self.signature,
                "clusters": [asdict(c) for c in self.clusters],
                **{key: getattr(self, key) for key in ("pending", "seen", "last_received", "next_cluster_id", "batch_count", "processed_count", "ignored_count", "last_batch")}}

    def expire(self, timestamp: datetime, cold_minutes: int):
        for cluster in self.clusters:
            if timestamp-datetime.fromisoformat(cluster.last_timestamp) > timedelta(minutes=cold_minutes):
                cluster.cold = True

    def add_evidence(self, candidates: list[str], vector: list[float], timestamp: datetime, cold_minutes: int) -> Cluster:
        self.expire(timestamp, cold_minutes)
        overlap = [c for c in self.clusters if not c.cold and set(c.candidates).intersection(candidates)]
        if overlap:
            # 一条桥接帖子可能同时连接多个簇，合并后只计一次该帖子。
            cluster = overlap[0]
            for other in overlap[1:]:
                cluster.merge(other)
                self.clusters.remove(other)
        else:
            cluster = Cluster(f"C{self.next_cluster_id:04d}", timestamp.isoformat())
            self.next_cluster_id += 1
            self.clusters.append(cluster)
        cluster.append(candidates, vector, timestamp)
        return cluster
