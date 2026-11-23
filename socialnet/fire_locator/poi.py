# 统一空间索引：原始 90 项平移 [30,25] 后合并扩展 325 项；can_post 控制发帖资格，预测目标仍为原始八罐。

import hashlib
import json
import math
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from .config import Settings

DEFAULT_TARGET_ID = "T-SW-01"

ANGLES = {"东": 0, "东北": 45, "北": 90, "西北": 135, "西": 180, "西南": 225, "南": 270, "东南": 315}


@dataclass(frozen=True)
class Poi:
    id: str
    name: str
    type: str
    x_m: float
    y_m: float
    aliases: tuple[str, ...] = ()
    can_post: bool = True


# 加载冻结整城数据和原图，保留原始中心供审计，以统一 CITY 坐标做空间计算。
class PoiRepository:
    """统一读取新地图的规范 JSON；按用户约定 1 仿真单位 = 1 米。"""

    # 先校验原图，随后把原对象平移一次、扩展对象直接载入；指纹不包含本机绝对路径。
    def __init__(self, root: Path):
        self.data_root = root / "fire_poi"
        spatial = json.loads((self.data_root / "fire_sandbox_spatial_model.json").read_text(encoding="utf-8"))
        self.map_config = json.loads((self.data_root / "map_config.json").read_text(encoding="utf-8"))
        self.coordinate_system = self.map_config["coordinate_system"]
        if self.coordinate_system != spatial["coordinate_system"] or any(
            self.coordinate_system.get(key) != value for key, value in
            {"origin": "southwest", "x_axis": "east", "y_axis": "north", "unit": "simulation_unit",
             "extent": [0, 0, 30, 25]}.items()
        ):
            raise ValueError("地图坐标约定不兼容：要求西南原点、东/北正方向的30×25仿真坐标")
        if self.map_config["source"] != spatial["source"]:
            raise ValueError("地图配置与空间模型的底图来源不一致")
        source = self.map_config["source"]
        if source["file"] != "map_original.png" or hashlib.sha256(
            (self.data_root / "map_original.png").read_bytes()
        ).hexdigest() != source["sha256"]:
            raise ValueError("底图 SHA-256 与地图元数据不一致")
        self.pois: dict[str, Poi] = {}
        types = {"Tank": "tank", "Building": "building", "Facility": "facility",
                 "Region": "region", "Green Area": "green_area", "Pavement": "pavement",
                 "Road": "road", "Intersection": "intersection", "RoadNode": "node"}
        # nodes 已包含 intersections，避免重复载入路口。道路以中心线的半程点为参照。
        for collection in ("pois", "areas", "roads", "nodes"):
            for item in spatial[collection]:
                center = item.get("center")
                if center is None and collection == "roads":
                    center = self._line_midpoint(item["centerline"]["coordinates"])
                kind = types[item["entity_type"]]
                self._add(Poi(item["id"], item["name"], kind,
                              *map(float, center), tuple(item.get("aliases", [])), kind != "tank"))
        self.original_pois = self.pois.copy()
        scene = json.loads((root / "city_scene/city_scene.json").read_text(encoding="utf-8"))
        extended = json.loads((root / "city_scene/poi_catalog.json").read_text(encoding="utf-8"))
        self.coordinate_system = scene["coordinate_system"]
        placement = scene["original_map_placement"]
        self.city_offset = tuple(placement["offset"])
        dx, dy = self.city_offset
        if (self.coordinate_system != {"id": "CITY90x75", "origin": "southwest", "x_axis": "east",
                                      "y_axis": "north", "unit": "simulation_unit", "extent": [0, 0, 90, 75]}
                or placement["coordinate_system"] != "LOCAL30x25" or placement["sha256"] != source["sha256"]
                or placement["extent"] != [dx, dy, dx+30, dy+25]
                or not (0 <= dx <= 60 and 0 <= dy <= 50)):
            raise ValueError("整城坐标或原图放置不兼容")
        self.pois = {key: replace(p, x_m=p.x_m+dx, y_m=p.y_m+dy) for key, p in self.original_pois.items()}
        for item in extended:
            if item["coordinate_system"] != self.coordinate_system["id"] or not isinstance(item["can_post"], bool):
                raise ValueError(f"扩展 POI 坐标或发帖资格无效: {item['id']}")
            self._add(Poi(item["id"], item["name"], item["type"], *map(float, item["center"]),
                          tuple(item.get("aliases", [])), item["can_post"]))
        self.relations = spatial["relations"]
        self.id_redirects = spatial.get("id_redirects", {})
        self.tanks = {key: self.pois[key] for key, poi in self.original_pois.items() if poi.type == "tank"}
        self.fingerprint = hashlib.sha256(json.dumps(
            {"pois": [asdict(p) for p in self.pois.values()], "coordinate_system": self.coordinate_system,
             "meters_per_simulation_unit": 1, "city_offset": self.city_offset,
             "source": source, "model_version": spatial["model_version"]},
            sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    @staticmethod
    def _line_midpoint(points):
        lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
        remaining = sum(lengths) / 2
        for a, b, length in zip(points, points[1:], lengths):
            if length and remaining <= length:
                return [a[i] + (b[i] - a[i]) * remaining / length for i in (0, 1)]
            remaining -= length
        return points[-1]

    def _add(self, poi: Poi):
        xmin, ymin, xmax, ymax = self.coordinate_system["extent"]
        if (poi.id in self.pois or not all(math.isfinite(v) for v in (poi.x_m, poi.y_m))
                or not (xmin <= poi.x_m <= xmax and ymin <= poi.y_m <= ymax)):
            raise ValueError(f"POI 重复或坐标无效: {poi.id}")
        self.pois[poi.id] = poi

    # 检查来源存在且 can_post 为真；可作参照不意味着可作预测火灾目标。
    def validate_location(self, poi_id: str):
        if poi_id not in self.pois:
            raise ValueError(f"未知发帖 POI: {poi_id}")
        if not self.pois[poi_id].can_post:
            raise ValueError(f"该 POI 不允许作为发帖位置: {poi_id}")

    # 筛选距离不超过 15、方向偏差不超过半张角的储罐；附近不限制方向。
    def candidates(self, origin: Poi, direction: str, radius: float = Settings.radius_m,
                   sector: float = Settings.sector_degrees) -> list[str]:
        result = []
        for poi in self.tanks.values():
            dx, dy = poi.x_m-origin.x_m, poi.y_m-origin.y_m
            distance = math.hypot(dx, dy)
            if distance > radius + 1e-9:
                continue
            if direction != "附近" and distance > 1e-9:
                angle = math.degrees(math.atan2(dy, dx)) % 360
                difference = abs((angle-ANGLES[direction]+180) % 360-180)
                if difference > sector/2 + 1e-9:
                    continue
            result.append(poi.id)
        return sorted(result)
