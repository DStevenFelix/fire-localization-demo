# 规范空间数据入口：校验底图与坐标约定，为世界构造和正式定位提供共同几何依据。

"""Single source of geometry for simulation, rendering and localization."""

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = ROOT / "fire_poi"
CITY_ROOT = ROOT / "city_scene"
ORIGINAL_COMMUNITIES = ("A-WEST", "A-EAST", "A-SOUTH-W", "A-SOUTH-E")


# 首次读取并缓存规范 JSON，核对坐标、底图 SHA-256 和全局实体 ID 唯一性。
@lru_cache(maxsize=1)
def load_spatial_model():
    model = json.loads((DATA_ROOT / "fire_sandbox_spatial_model.json").read_text(encoding="utf-8"))
    config = json.loads((DATA_ROOT / "map_config.json").read_text(encoding="utf-8"))
    if model["coordinate_system"] != config["coordinate_system"] or model["source"] != config["source"]:
        raise ValueError("地图坐标或来源不一致")
    crs = model["coordinate_system"]
    if (crs["origin"] != "southwest" or crs["extent"] != [0, 0, 30, 25]
            or crs["x_axis"] != "east" or crs["y_axis"] != "north" or crs["unit"] != "simulation_unit"):
        raise ValueError("地图坐标系不兼容")
    if hashlib.sha256((DATA_ROOT / "map_original.png").read_bytes()).hexdigest() != config["source"]["sha256"]:
        raise ValueError("底图校验失败")
    ids = [row["id"] for group in ("pois", "areas", "roads", "nodes") for row in model[group]]
    if len(ids) != len(set(ids)):
        raise ValueError("地图实体 ID 重复")
    return model


# 筛选原社区和扩展社区的可发帖住宅，统一使用 CITY 中心坐标。
def residential_pois():
    # 原住宅保留 ID，仅平移坐标；can_post=false 的辅助住宅不分配住户。
    dx, dy = load_city_scene()["original_map_placement"]["offset"]
    homes = [{**p, "center": [p["center"][0] + dx, p["center"][1] + dy]}
             for p in load_spatial_model()["pois"]
             if p.get("parent_id") in ORIGINAL_COMMUNITIES and p["entity_type"] == "Building"]
    homes.extend({**p, "parent_id": p["community_id"]} for p in load_city_catalog()
                 if p["type"] == "building" and p["category"] == "residential" and p["can_post"])
    return homes


@lru_cache(maxsize=1)
def load_city_scene():
    """校验冻结整城数据及放置规则，原始 LOCAL 数据保持不变。"""
    scene = json.loads((CITY_ROOT / "city_scene.json").read_text(encoding="utf-8"))
    manifest = json.loads((CITY_ROOT / "import-manifest.json").read_text(encoding="utf-8"))
    if hashlib.sha256((CITY_ROOT / "city_scene.json").read_bytes()).hexdigest() != manifest["files"]["city_scene.json"]:
        raise ValueError("整城场景校验失败")
    if scene["coordinate_system"] != {"id": "CITY90x75", "origin": "southwest", "x_axis": "east",
                                      "y_axis": "north", "unit": "simulation_unit", "extent": [0, 0, 90, 75]}:
        raise ValueError("整城坐标系不兼容")
    placement = scene["original_map_placement"]
    if (placement["offset"] != [30, 25] or placement["extent"] != [30, 25, 60, 50]
            or placement["coordinate_system"] != "LOCAL30x25"
            or placement["sha256"] != load_spatial_model()["source"]["sha256"]):
        raise ValueError("原图整城放置不兼容")
    return scene


@lru_cache(maxsize=1)
def load_city_catalog():
    load_city_scene()
    data = (CITY_ROOT / "poi_catalog.json").read_bytes()
    manifest = json.loads((CITY_ROOT / "import-manifest.json").read_text(encoding="utf-8"))
    if hashlib.sha256(data).hexdigest() != manifest["files"]["poi_catalog.json"]:
        raise ValueError("扩展 POI 校验失败")
    catalog = json.loads(data)
    original = load_spatial_model()
    ids = [p["id"] for group in ("pois", "areas", "roads", "nodes") for p in original[group]]
    ids.extend(p["id"] for p in catalog)
    if len(ids) != len(set(ids)) or any(p["coordinate_system"] != "CITY90x75" for p in catalog):
        raise ValueError("整城 POI ID 或坐标不兼容")
    return catalog


# 计算全住宅覆盖半径，仅作几何分析；正式定位采用另一组默认的 15，不使用此值。
def localization_search_radius() -> int:
    """Cover every residential vantage/tank pair, in canonical simulation units."""
    homes = residential_pois()
    dx, dy = load_city_scene()["original_map_placement"]["offset"]
    tanks = [{**p, "center": [p["center"][0] + dx, p["center"][1] + dy]}
             for p in load_spatial_model()["pois"] if p["entity_type"] == "Tank"]
    if not homes or not tanks:
        raise ValueError("定位范围计算需要住宅与储罐的规范中心坐标")
    return math.ceil(max(math.dist(home["center"], tank["center"]) for home in homes for tank in tanks))


# 按累计线段长度求折线半程点，不能用首尾坐标均值代替弯曲道路的参照中心。
def line_midpoint(points):
    lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
    remaining = sum(lengths) / 2
    for a, b, length in zip(points, points[1:], lengths):
        if length and remaining <= length:
            return [a[i] + (b[i] - a[i]) * remaining / length for i in (0, 1)]
        remaining -= length
    return points[-1]


COMMUNITIES = ORIGINAL_COMMUNITIES + tuple(p["id"] for p in load_city_catalog() if p["type"] == "community")
ROADS = dict(zip(ORIGINAL_COMMUNITIES, ("锦安路", "东源路", "兴业大道", "兴业大道")))
for _community in (p for p in load_city_catalog() if p["type"] == "community"):
    _road = min((p for p in load_city_catalog() if p["type"] == "road" and p["can_post"]),
                key=lambda p: math.dist(_community["center"], p["center"]))
    ROADS[_community["id"]] = _road["name"]
