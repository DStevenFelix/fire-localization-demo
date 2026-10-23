"""先选唯一真实着火罐，再从非罐观察点生成 100 条模拟帖子。"""
import random
from datetime import datetime, timedelta
from pathlib import Path

from .models import Post, SHANGHAI
from .poi import DEFAULT_TARGET_ID, PoiRepository
from .providers import atomic_json


def generate(repository: PoiRepository, output: Path, count: int = 100, seed: int = 42,
             target_id: str = DEFAULT_TARGET_ID, radius: float = 10, sector: float = 45):
    if target_id not in repository.tanks:
        raise ValueError("真实着火点必须是独立罐子")
    if count < 1:
        raise ValueError("count 必须大于 0")
    rng = random.Random(seed)
    target = repository.tanks[target_id]
    # 只选择实际几何范围覆盖真实罐子的观察点/方向，ground truth 不进入帖子输入。
    observers = []
    for origin in repository.pois.values():
        if origin.type not in {"building", "facility", "road", "intersection", "node"}:
            continue
        for direction in ("东", "东北", "北", "西北", "西", "西南", "南", "东南"):
            if target_id in repository.candidates(origin, direction, radius, sector):
                observers.append((origin, direction))
    if not observers:
        raise ValueError("没有可观察到指定罐子的非罐发帖点")
    # 从当前地图选择范围内无罐的观察点，不依赖已废弃的消防站。
    empty_observers = [p for p in repository.pois.values()
                       if p.type in {"building", "road", "intersection", "node"}
                       and not repository.candidates(p, "附近", radius, sector)]
    start = datetime(2026, 10, 23, 14, 0, tzinfo=SHANGHAI)
    templates = ["{ref}{direction}边有浓烟，像是罐体那边冒出来的！", "刚经过{ref}，{direction}侧看见火光，烟越来越大。",
                 "{ref}的{direction}方向有黑烟，远处好像有明火。", "从{ref}望过去，{direction}边的烟一直没散，挺让人担心的。"]
    posts = []
    vague = ["附近闻到一股烧焦味，是什么东西着了？", "抬头看到火光了，还有黑烟，大家注意一下！", "这会儿闻到很重的烟味，窗户先关上。", "天边一团浓烟，不知道具体在哪里。"]
    low = ["楼道里又堆了纸箱，觉得有火灾隐患。", "消防通道被杂物挡着了，希望尽快清理。", "附近有人烧东西吗？有点烟味。"]
    for index in range(count):
        origin, direction = rng.choice(observers)
        kind = index % 10
        if kind < 6:
            reference = rng.choice([origin.name, *origin.aliases])
            text = rng.choice(templates).format(ref=reference, direction=direction)
            urgency = rng.choice(["中", "高"])
        elif kind < 8:
            text, urgency = rng.choice(vague), rng.choice(["中", "高"])
        elif kind == 8:
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
    metadata = {"synthetic": True, "seed": seed, "post_count": count,
                "poi_fingerprint": repository.fingerprint, "meters_per_simulation_unit": 1,
                "search_radius_m": radius, "sector_degrees": sector,
                "single_fire_ground_truth": {"poi_id": target.id, "name": target.name,
                                             "coordinates": {"x_m": target.x_m, "y_m": target.y_m}},
                "start_time": start.isoformat(), "end_time": posts[-1]["timestamp"],
                "note": "真实标签仅在此文件用于测试评价，不送入模型或定位算法。"}
    atomic_json(output.with_suffix(".meta.json"), metadata)
    return metadata
