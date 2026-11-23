# 独立定位算法：逐帖提取地点、筛选储罐、按候选独立累计加权证据，输出 CITY90x75 的全局 Top3。

import hashlib
import json
import threading
from datetime import datetime, timedelta
from pathlib import Path

from langchain_core.runnables import RunnableLambda

from .config import Settings
from .memory import FULL_VOTE_UNITS, VAGUE_VOTE_UNITS, LocalizationMemory
from .models import Post
from .poi import PoiRepository
from .providers import BatchExtractor, OfflineEmbeddings, PoiMatcher, SiliconFlowEmbeddings


# 定位算法入口，不依赖居民或群聊引擎；宿主仅通过公开 Post 与预测结果交互。
class FireLocalizer:
    # 建立规则/数据签名和模型依赖；注入点与 POI 预热缓存用于宿主兼容，不改变算法计票。
    def __init__(self, settings: Settings | None = None, offline: bool = False,
                 state_path: Path | None = None, resume: bool = False, *, poi_cache_path: Path | None = None,
                 embeddings=None, extractor=None):
        self.settings = settings or Settings.load()
        self.offline = offline
        self.repository = PoiRepository(self.settings.root)
        # 宿主注入在线适配器，保留本包独立构造和显式离线测试入口。
        if embeddings is not None:
            self.embeddings = embeddings
        elif offline:
            self.embeddings = OfflineEmbeddings()
        else:
            self.embeddings = SiliconFlowEmbeddings(self.settings, self.settings.root / "runtime" / "embedding_cache.json")
        try:
            self.extractor = extractor if extractor is not None else BatchExtractor(self.settings, self.repository, offline)
            if poi_cache_path is not None and isinstance(self.embeddings, SiliconFlowEmbeddings):
                self.embeddings.preload_poi_names([poi.name for poi in self.repository.pois.values()], poi_cache_path)
            self.matcher = PoiMatcher(self.repository, self.embeddings, self.settings.match_threshold)
        except Exception:
            if isinstance(self.embeddings, SiliconFlowEmbeddings):
                self.embeddings.client.close()
            raise
        signature = hashlib.sha256(json.dumps({"algorithm": "independent-poi-weighted-v3",
                                              "poi": self.repository.fingerprint, "mode": offline,
                                              "model": self.embeddings.model, "base": self.embeddings.base_url,
                                              "llm": self.settings.deepseek_model, "batch": self.settings.batch_size,
                                              "radius": self.settings.radius_m, "sector": self.settings.sector_degrees,
                                              "threshold": self.settings.match_threshold,
                                              "cold_minutes": self.settings.cold_minutes}, sort_keys=True).encode()).hexdigest()
        self.memory = LocalizationMemory(state_path, signature, resume)
        self.lock = threading.RLock()
        self.batch_runnable = RunnableLambda(self._process_batch)

    # 校验整组输入、摘要去重、先存 pending 再处理；每批最多 10 条，flush 立即处理尾批。
    def ingest(self, posts: list[Post | dict], flush: bool = False) -> dict:
        """接受 1/N 条帖子，累积到 batch_size；flush 显式处理不足一批的尾部。"""
        with self.lock:
            validated = [p if isinstance(p, Post) else Post.model_validate(p) for p in posts]
            staging = self.memory.clone()
            duplicates = 0
            for post in validated:
                self.repository.validate_location(post.location_poi_id)
                data = post.model_dump(mode="json")
                digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                if post.id in staging.seen:
                    if staging.seen[post.id] != digest:
                        raise ValueError(f"相同帖子 ID 的内容发生变化: {post.id}")
                    duplicates += 1
                    continue
                if staging.last_received and post.timestamp < datetime.fromisoformat(staging.last_received):
                    raise ValueError("帖子必须按时间非递减到达，请先排序；迟到帖子不改变已发布结果")
                staging.seen[post.id] = digest
                staging.pending.append(data)
                staging.last_received = post.timestamp.isoformat()
            # 输入先持久化为待处理队列；API 错误后重试不会丢帖或重复投票。
            staging.save()
            self.memory = staging
            updates = []
            while len(self.memory.pending) >= self.settings.batch_size or (flush and self.memory.pending):
                batch = [Post.model_validate(item) for item in self.memory.pending[:self.settings.batch_size]]
                updates.append(self.batch_runnable.invoke(batch))
            return {"mode": "offline" if self.offline else "live", "duplicates": duplicates,
                    "pending_count": len(self.memory.pending), "updates": updates,
                    "processed_count": self.memory.processed_count,
                    "ignored_count": self.memory.ignored_count,
                    "llm_calls_this_process": self.extractor.calls,
                    "embedding_requests_this_process": self.embeddings.request_count}

    # 先完成所有外部请求，再在克隆状态上提交；只有方向或正文匹配地点的帖子得 1 票，其余得 0.34 票。
    def _process_batch(self, posts: list[Post]) -> dict:
        extractions = self.extractor.extract(posts)
        # 所有外部调用及验证完成后才修改簇，整批提交。
        resolved = []
        references = [item.reference for item in extractions if self.matcher.needs_embedding(item.reference)]
        self.embeddings.embed_documents(references)
        for post, item in zip(posts, extractions, strict=True):
            origin, similarity, reason = self.matcher.resolve(item, post.location_poi_id)
            candidates = self.repository.candidates(origin, item.direction, self.settings.radius_m, self.settings.sector_degrees)
            resolved.append((post, item, origin, similarity, reason, candidates))
        relevant = [post.text for post, _, _, _, _, candidates in resolved if candidates]
        vectors = iter(self.embeddings.embed_documents(relevant))
        staging = self.memory.clone()
        audit = []
        for post, item, origin, similarity, reason, candidates in resolved:
            staging.expire(post.timestamp, self.settings.cold_minutes)
            detail = {"post_id": post.id, "timestamp": post.timestamp.isoformat(), "reference": item.reference,
                      "direction": item.direction, "origin_poi_id": origin.id, "origin_name": origin.name,
                      "match_similarity": similarity, "reference_resolution": reason,
                      "candidate_poi_ids": candidates, "urgency": post.urgency}
            if candidates:
                # 发帖位置可用于几何回退，但不算正文提供的定位线索。
                has_location = reason in {"exact_name_or_alias", "semantic_match"}
                vote_units = FULL_VOTE_UNITS if item.direction != "附近" or has_location else VAGUE_VOTE_UNITS
                clusters = staging.add_evidence(candidates, next(vectors), post.timestamp, self.settings.cold_minutes,
                                                vote_units=vote_units)
                detail.update(status="accepted", vote_weight=vote_units / FULL_VOTE_UNITS,
                              cluster_ids=[cluster.id for cluster in clusters])
            else:
                detail.update(status="ignored_no_tank_in_range", vote_weight=0, cluster_ids=[])
                staging.ignored_count += 1
            audit.append(detail)
        del staging.pending[:len(posts)]
        staging.processed_count += len(posts)
        staging.batch_count += 1
        staging.last_batch = audit
        staging.save()
        self.memory = staging
        return {"batch_number": staging.batch_count, "batch_size": len(posts), "posts": audit,
                "prediction": self.prediction(posts[-1].timestamp)}

    # 只汇总未满冷却时长的候选簇；得分为票数乘非负文本一致性，相对分数不是火灾概率。
    def prediction(self, at: datetime | None = None) -> dict:
        with self.lock:
            if at is None and self.memory.last_received:
                at = datetime.fromisoformat(self.memory.last_received)
            if at is None:
                from .models import SHANGHAI
                at = datetime.now(SHANGHAI)
            eligible = [c for c in self.memory.clusters if not c.cold and at-datetime.fromisoformat(c.last_timestamp) < timedelta(minutes=self.settings.cold_minutes)]
            aggregate = {}
            for cluster in eligible:
                for poi_id, votes in cluster.votes.items():
                    item = aggregate.setdefault(poi_id, {"votes": 0, "score": 0.0, "coherence_total": 0.0, "cluster_ids": []})
                    item["votes"] += votes
                    item["score"] += votes*max(0, cluster.confidence)
                    item["coherence_total"] += votes*cluster.confidence
                    item["cluster_ids"].append(cluster.id)
            total = sum(item["score"] for item in aggregate.values())
            ranked = sorted(aggregate, key=lambda key: (-aggregate[key]["score"], -aggregate[key]["votes"], key))[:3]
            candidates = []
            for rank, poi_id in enumerate(ranked, 1):
                info = aggregate[poi_id]
                poi = self.repository.tanks[poi_id]
                candidates.append({"rank": rank, "poi_id": poi.id, "name": poi.name,
                                   "coordinates": {"x_m": poi.x_m, "y_m": poi.y_m},
                                   "votes": info["votes"], "confidence": round(info["coherence_total"]/info["votes"], 6),
                                   "score": round(info["score"], 6),
                                   "relative_score": round(info["score"]/total, 6) if total else 0,
                                   "cluster_ids": info["cluster_ids"]})
            return {"current_time": at.isoformat(), "coordinate_system": self.repository.coordinate_system["id"],
                    "candidates": candidates, "active_cluster_count": len(eligible),
                    "cold_cluster_count": len(self.memory.clusters)-len(eligible),
                    "processed_count": self.memory.processed_count, "pending_count": len(self.memory.pending),
                    "status": "located_candidates" if candidates else "no_active_evidence"}

    # 保留簇摘要接口，但新版每簇只对应一个候选，votes 可以是小数。
    def cluster_summary(self):
        with self.lock:
            return [{"id": c.id, "count": c.count, "cold": c.cold, "confidence": c.confidence,
                     "leading_poi_id": c.leading_poi_id, "votes": c.votes,
                     "last_timestamp": c.last_timestamp} for c in self.memory.clusters]
