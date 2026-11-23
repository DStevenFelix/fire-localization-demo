"""旧 LOCAL30x25 存档到整城的纯数据迁移；不创建模型、不请求网络、不换算旧定位票数。"""

from copy import deepcopy
import hashlib
import random

from .spatial import ORIGINAL_COMMUNITIES, load_spatial_model, load_city_scene
from .world import create_entities, create_map_metadata, create_residents


def legacy_fingerprint(encode):
    """仅识别本项目已知的 48 人旧定义，不把未知或损坏的存档当作可迁移数据。"""
    original = {p["id"]: p for p in load_spatial_model()["pois"]}
    residents = []
    for resident in create_residents():
        if resident.community_id not in ORIGINAL_COMMUNITIES:
            continue
        row = resident.model_dump(mode="json")
        row["position"] = dict(zip(("x", "y"), original[resident.building_id]["center"]))
        residents.append(row)
    payload = {"schema": 1, "fire_mode": "single", "map": load_spatial_model(), "residents": residents}
    return hashlib.sha256(encode(payload).encode()).hexdigest()


def shift_point(point):
    if point is not None:
        dx, dy = load_city_scene()["original_map_placement"]["offset"]
        point["x"] += dx
        point["y"] += dy


def migrate_message(message):
    row = deepcopy(message)
    shift_point(row.get("position"))
    return row


def migrate_report(report):
    row = deepcopy(report)
    for item in [*row.get("buildings", []), *row.get("residents", [])]:
        shift_point(item)
    shift_point(row.get("fire_position"))
    for item in row.get("fire_positions", []):
        shift_point(item)
    return row


def migrate_checkpoints(engine_data, localization_data):
    engine, loc = deepcopy(engine_data), deepcopy(localization_data)
    state = engine["state"]
    if state["map"]["width"] != 30 or state["map"]["height"] != 25:
        raise ValueError("旧存档坐标范围与已知版本不符")
    residents = create_residents()
    entities = create_entities()
    by_id = {e.id: e for e in entities}
    groups = {}
    for resident in residents:
        group = groups.setdefault(resident.community_id, {"id": resident.community_id,
            "name": by_id[resident.community_id].name, "resident_ids": [], "building_ids": []})
        group["resident_ids"].append(resident.id)
        if resident.building_id not in group["building_ids"]:
            group["building_ids"].append(resident.building_id)
        engine["agent_random"].setdefault(resident.id, random.Random(f"{engine['seed']}:{resident.id}").getstate())
    for group_id in groups:
        engine["community_random"].setdefault(group_id, random.Random(f"{engine['seed']}:{group_id}").getstate())
        state["chat_totals"].setdefault(group_id, 0)
    state.update(entities=[e.model_dump(mode="json") for e in entities],
                 residents=[r.model_dump(mode="json") for r in residents], communities=list(groups.values()),
                 map=create_map_metadata().model_dump(mode="json"), running=False)
    for fire in state["fires"]:
        shift_point(fire["position"])
    state["chats"] = [migrate_message(row) for row in state["chats"]]
    state["reports"] = [migrate_report(row) for row in state["reports"]]
    prediction = loc["state"].get("prediction")
    if prediction:
        if prediction.get("coordinate_system", "local_cartesian_meters") not in ("local_cartesian_meters", "LOCAL30x25"):
            raise ValueError("旧预测坐标系不兼容")
        dx, dy = load_city_scene()["original_map_placement"]["offset"]
        for candidate in prediction["candidates"]:
            candidate["coordinates"]["x_m"] += dx
            candidate["coordinates"]["y_m"] += dy
        prediction["coordinate_system"] = "CITY90x75"
    # 保留旧结果供回看，但 schema=1 的合并簇不能伪装成 schema=3 的独立候选票数。
    loc["state"]["cold_minutes"] = 60
    return engine, loc
