from collections import Counter
import hashlib
import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.models import FirePolicy, Point
from app.spatial import DATA_ROOT, load_spatial_model, line_midpoint
from app.simulation import SimulationEngine
from app.world import RESIDENT_CAPACITY, create_entities, create_map_metadata, create_residents


def test_new_model_is_the_only_map_source_and_has_415_unique_entities():
    model = load_spatial_model()
    entities = create_entities()
    by_id = {e.id: e for e in entities}
    assert len(by_id) == len(entities) == 415
    assert Counter(e.kind for e in entities) == {
        "area": 37, "road": 31, "intersection": 72, "tank": 8, "building": 123, "pipeline": 4, "entrance":120, "node":12, "reserve":1, "facility":7}
    for collection in ("pois", "areas", "roads", "nodes"):
        for row in model[collection]:
            entity = by_id[row["id"]]
            center = row.get("center") or line_midpoint(row["centerline"]["coordinates"])
            assert entity.name == row["name"]
            assert entity.position == Point(x=center[0]+30, y=center[1]+25)
            assert entity.source == "spatial_model"
            assert entity.parent_id == row.get("parent_id")
    assert not any(e.id.startswith(("POI-", "VEH-")) for e in entities)


def test_geometry_bounds_and_registered_centers_are_valid():
    entities = create_entities()
    for entity in entities:
        assert 0 <= entity.x <= entity.x + entity.width <= 90.001
        assert 0 <= entity.y <= entity.y + entity.height <= 75.001
        assert entity.position is not None
        if entity.kind in ("building", "tank", "pipeline"):
            assert entity.geometry.points
            assert entity.x <= entity.position.x <= entity.x + entity.width
            assert entity.y <= entity.position.y <= entity.y + entity.height
            for neighbor in entity.neighbors:
                other = next(e for e in entities if e.id == neighbor.id)
                assert neighbor.distance == pytest.approx(math.dist(
                    (entity.position.x, entity.position.y), (other.position.x, other.position.y)))


def test_resident_allocation_and_home_positions():
    residents = create_residents()
    entities = {e.id: e for e in create_entities()}
    assert len(residents) == len({r.id for r in residents}) == len({r.name for r in residents}) == 300
    assert Counter(r.building_id for r in residents) == RESIDENT_CAPACITY
    assert set(RESIDENT_CAPACITY.values()) == {4}
    assert len(SimulationEngine().buildings) == 75
    assert Counter(r.community_id for r in residents) == {"A-WEST":20, "A-EAST":16, "A-SOUTH-W":8, "A-SOUTH-E":4, "EXT-C-001":52, "EXT-C-002":24, "EXT-C-003":12, "EXT-C-004":60, "EXT-C-005":64, "EXT-C-006":40}
    for resident in residents:
        home = entities[resident.building_id]
        assert resident.position == home.position
        assert resident.id in home.residents
        assert resident.community_id == home.area_id
    assert all(not e.residents for e in entities.values() if e.entity_type != "residential_building")


def test_simulation_and_locator_share_identical_ids_and_centers():
    from fire_locator.poi import PoiRepository
    from app.spatial import ROOT
    repository = PoiRepository(ROOT)
    for entity in create_entities():
        poi = repository.pois[entity.id]
        assert entity.position == Point(x=poi.x_m, y=poi.y_m)
    assert set(repository.tanks) == {e.id for e in create_entities() if e.kind == "tank"}
    assert line_midpoint([[0, 0], [2, 0], [2, 6]]) == [2, 2]


def test_registered_image_hash_and_coordinate_metadata():
    model = load_spatial_model()
    assert hashlib.sha256((DATA_ROOT / "map_original.png").read_bytes()).hexdigest() == model["source"]["sha256"]
    metadata = create_map_metadata()
    assert metadata.source == "city_scene/poi_catalog.json"
    assert metadata.origin == "southwest" and metadata.width == 90 and metadata.height == 75
    assert metadata.image_width == 1313 and metadata.image_height == 1050
    assert metadata.coordinate_basis == "registered_center"
    assert Point(x=30, y=25)
    with pytest.raises(ValidationError):
        Point(x=90.01, y=12)


def test_eight_possible_tanks_have_only_one_active_fire_and_clear_reopens_capacity(monkeypatch):
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1, suppression_factor=.95))
    monkeypatch.setattr(engine.fire_random, "random", lambda: 0)
    for _ in range(20):
        engine._maybe_spawn_fire()
    assert len(engine.fires) == 1
    assert len([e for e in engine.entities if e.kind == "tank"]) == 8
    assert engine.next_fire_probability == 0
    for fire in engine.fires:
        tank = engine._entity_by_id[fire.nearest_poi_id]
        assert tank.kind == "tank" and fire.position == tank.position and fire.area_id == tank.area_id
    original = engine.fires[0]
    engine.clear_fire(original.id)
    assert engine.next_fire_probability == 1
    assert engine._maybe_spawn_fire() is not None
    assert len(engine.fires) == 1


def test_map_api_controls_assets_and_ten_rooms():
    from app.main import app, engine
    engine.reset()
    with TestClient(app) as client:
        assert client.get("/map-assets/map_original.png").status_code == 200
        state = client.get("/api/state").json()
        assert len(state["residents"]) == 300 and len(state["communities"]) == 10
        assert client.post("/api/fire", json={"x":19,"y":10}).status_code == 405
        assert client.put("/api/fire-policy", json={"base_probability":1.1}).status_code == 422
        assert client.put("/api/fire-policy", json={"suppression_factor":1}).status_code == 422
        assert client.put("/api/fire-policy", json={"base_probability":1,"suppression_factor":.25}).status_code == 200
        state = client.post("/api/simulation", json={"action":"step"}).json()
        assert len(state["fires"]) == 1 and len(state["chats"]) == 30
        assert {m["community_id"] for m in state["chats"]} == {c["id"] for c in state["communities"]}
        assert state["fires"][0]["area_id"].startswith("A-TANK-")
        fire_id = state["fires"][0]["id"]
        for _ in range(3):
            state = client.post("/api/simulation", json={"action":"step"}).json()
            assert len(state["fires"]) == 1 and state["fires"][0]["id"] == fire_id
            assert state["next_fire_probability"] == 0
        assert client.delete("/api/fire/unknown").status_code == 404
        assert client.delete("/api/fire/"+fire_id).json()["fires"] == []
        assert client.post("/api/simulation", json={"action":"step"}).json()["fires"][0]["id"] != fire_id
        assert client.post("/api/simulation",json={"action":"reset"}).json()["localization"]["jobs"] == []
    engine.fire_policy = FirePolicy()
