import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import openpyxl

ANGLES = {"东": 0, "东北": 45, "北": 90, "西北": 135, "西": 180, "西南": 225, "南": 270, "东南": 315}


@dataclass(frozen=True)
class Poi:
    id: str
    name: str
    type: str
    x_m: float
    y_m: float
    aliases: tuple[str, ...] = ()


class PoiRepository:
    """Excel 为坐标来源；JSON 用于核验和载入预计算邻居/空间关系。"""

    def __init__(self, root: Path):
        workbook = openpyxl.load_workbook(root / "city_localization_data_dictionary.xlsx", read_only=True, data_only=True)
        self.pois: dict[str, Poi] = {}
        try:
            for r in list(workbook["POIs"].values)[1:]:
                if r[0]:
                    self._add(Poi(str(r[0]), str(r[1]), str(r[2]), float(r[4]), float(r[5]),
                                  tuple(x.strip() for x in (r[6] or "").split("|") if x.strip())))
            # 面/道路的参照坐标使用中心点；所有坐标仍来自 Excel。
            for r in list(workbook["Areas"].values)[1:]:
                if r[0]:
                    self._add(Poi(str(r[0]), str(r[1]), str(r[2]), (float(r[4])+float(r[5]))/2,
                                  (float(r[6])+float(r[7]))/2))
            for r in list(workbook["Roads"].values)[1:]:
                if r[0]:
                    self._add(Poi(str(r[0]), str(r[1]), "road", (float(r[3])+float(r[5]))/2,
                                  (float(r[4])+float(r[6]))/2))
            for r in list(workbook["Intersections"].values)[1:]:
                if r[0]:
                    self._add(Poi(str(r[0]), str(r[1]), "intersection", float(r[2]), float(r[3])))
        finally:
            workbook.close()
        spatial = json.loads((root / "fire_sandbox_spatial_model.json").read_text(encoding="utf-8"))
        self.relations = spatial["relations"]
        self.nearest_neighbors = {}
        for item in spatial["pois"]:
            poi = self.pois[item["id"]]
            if any(abs(getattr(poi, key)-item["position"][key]) > 1e-6 for key in ("x_m", "y_m")):
                raise ValueError(f"Excel/JSON 坐标不一致: {poi.id}")
            self.nearest_neighbors[poi.id] = item.get("nearest_neighbors", [])
        self.tanks = {k: p for k, p in self.pois.items() if p.type == "tank"}
        self.fingerprint = hashlib.sha256(json.dumps([asdict(p) for p in self.pois.values()],
                                                    sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def _add(self, poi: Poi):
        if poi.id in self.pois or not all(math.isfinite(v) for v in (poi.x_m, poi.y_m)):
            raise ValueError(f"POI 重复或坐标无效: {poi.id}")
        self.pois[poi.id] = poi

    def validate_location(self, poi_id: str):
        if poi_id not in self.pois:
            raise ValueError(f"未知发帖 POI: {poi_id}")
        if self.pois[poi_id].type in {"tank", "tank_group"}:
            raise ValueError("发帖位置必须是非罐 POI")

    def candidates(self, origin: Poi, direction: str, radius: float = 10, sector: float = 45) -> list[str]:
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
