"""先选唯一真实着火罐，再从非罐观察点生成 100 条模拟帖子。"""
import math
import random
from datetime import datetime, timedelta
from pathlib import Path

from .config import Settings
from .models import Post, SHANGHAI
from .poi import DEFAULT_TARGET_ID, PoiRepository
from .providers import atomic_json

DETAILED_RADIUS_M = 20
REPORT_RADIUS_M = 30
NEAR_POST_CYCLE = ("directional",)*4 + ("vague",)*3 + ("low",)*2 + ("noise",)*2


def generate(repository: PoiRepository, output: Path, count: int = 100, seed: int = 42,
             target_id: str = DEFAULT_TARGET_ID, radius: float = Settings.radius_m, sector: float = 45):
    if target_id not in repository.tanks:
        raise ValueError("真实着火点必须是独立罐子")
    if count < 1:
        raise ValueError("count 必须大于 0")
    rng = random.Random(seed)
    target = repository.tanks[target_id]
    near, outer, directional = [], [], []
    for origin in repository.pois.values():
        if not origin.can_post or (origin.id in repository.original_pois
                and origin.type not in {"building", "facility", "road", "intersection", "node"}):
            continue
        distance = math.hypot(origin.x_m-target.x_m, origin.y_m-target.y_m)
        if distance > REPORT_RADIUS_M + 1e-9:
            continue
        if distance > DETAILED_RADIUS_M + 1e-9:
            outer.append(origin)
            continue
        near.append(origin)
        for direction in ("东", "东北", "北", "西北", "西", "西南", "南", "东南"):
            if target_id in repository.candidates(origin, direction, DETAILED_RADIUS_M, sector):
                directional.append((origin, direction))
    if not directional:
        raise ValueError("没有可观察到指定罐子的非罐发帖点")
    # 干扰帖仍优先从定位搜索范围内没有储罐的观察点发出。
    empty_observers = [p for p in near if not repository.candidates(p, "附近", radius, sector)]
    start = datetime(2026, 10, 23, 14, 0, tzinfo=SHANGHAI)
    templates = ["{ref}{direction}边有浓烟，像是罐体那边冒出来的！", "刚经过{ref}，{direction}侧看见火光，烟越来越大。",
                 "{ref}的{direction}方向有黑烟，远处好像有明火。", "从{ref}望过去，{direction}边的烟一直没散，挺让人担心的。"]
    posts = []
    vague = ["附近闻到一股烧焦味，是什么东西着了？", "抬头看到火光了，还有黑烟，大家注意一下！", "这会儿闻到很重的烟味，窗户先关上。", "天边一团浓烟，不知道具体在哪里。"]
    low = ["楼道里又堆了纸箱，觉得有火灾隐患。", "消防通道被杂物挡着了，希望尽快清理。", "附近有人烧东西吗？有点烟味。"]
    eligible = near + outer
    near_count = 0
    for index in range(count):
        selected = rng.randrange(len(eligible))
        origin = eligible[selected]
        if selected < len(near):
            kind = NEAR_POST_CYCLE[near_count % len(NEAR_POST_CYCLE)]
            near_count += 1
        else:
            kind = "vague"
        if kind == "directional":
            origin, direction = rng.choice(directional)
            reference = rng.choice([origin.name, *origin.aliases])
            text = rng.choice(templates).format(ref=reference, direction=direction)
            urgency = rng.choice(["中", "高"])
        elif kind == "vague":
            text, urgency = rng.choice(vague), rng.choice(["中", "高"])
        elif kind == "low":
            text, urgency = rng.choice(low), "低"
        else:
            if empty_observers:
                origin = rng.choice(empty_observers)
            text, urgency = "路过时闻到烟味，也不知道是不是远处飘过来的。", "中"
        post = Post(id=f"demo-{index+1:03d}", timestamp=start+timedelta(minutes=index//3),
                    text=text, location_poi_id=origin.id, urgency=urgency)
        posts.append(post.model_dump(mode="json"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(__import__("json").dumps(post, ensure_ascii=False) for post in posts)+"\n", encoding="utf-8")
    # Bridge 的真实标签仍是 LOCAL，预测使用 CITY，两者只在展示/评价时对齐。
    local_target = repository.original_pois[target_id]
    metadata = {"synthetic": True, "seed": seed, "post_count": count,
                "poi_fingerprint": repository.fingerprint, "meters_per_simulation_unit": 1,
                "search_radius_m": radius, "sector_degrees": sector,
                "detailed_radius_m": DETAILED_RADIUS_M, "report_radius_m": REPORT_RADIUS_M,
                "single_fire_ground_truth": {"poi_id": target.id, "name": target.name,
                                             "coordinates": {"x_m": local_target.x_m, "y_m": local_target.y_m}},
                "start_time": start.isoformat(), "end_time": posts[-1]["timestamp"],
                "note": "真实标签仅在此文件用于测试评价，不送入模型或定位算法。"}
    atomic_json(output.with_suffix(".meta.json"), metadata)
    return metadata
