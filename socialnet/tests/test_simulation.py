import asyncio
import random

import pytest

from app.models import FirePolicy
from app.simulation import SimulationEngine


def test_default_fire_policy_and_reset_preserves_custom_settings():
    engine = SimulationEngine()
    assert engine.fire_policy.base_probability == 0.30
    assert engine.fire_policy.suppression_factor == 0.25
    assert engine.next_fire_probability == 0.30
    assert engine.snapshot().next_fire_probability == 0.30
    assert 1 - (1 - engine.fire_policy.base_probability) ** 3 == pytest.approx(0.657)
    engine.fire_policy = FirePolicy(base_probability=1)
    engine._maybe_spawn_fire()
    engine.fire_policy = FirePolicy()
    assert engine.next_fire_probability == 0
    engine.fire_policy = FirePolicy(base_probability=0.4, suppression_factor=0.2)
    engine.reset()
    assert engine.fire_policy == FirePolicy(base_probability=0.4, suppression_factor=0.2)
    assert engine.next_fire_probability == 0.4


def test_nearest_residents_observe_random_fire_and_report_correct_source(monkeypatch):
    monkeypatch.setattr("app.simulation.perception_probabilities", lambda distance, intensity: {"odor": 1, "smoke": 1, "flame": 1})
    engine = SimulationEngine(seed=11, fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    fire = engine.fires[0]
    home = engine._entity_by_id[fire.nearest_building_id]
    assert len(engine.chats) == 3 * len(engine.communities)
    observed = [m for m in engine.chats if m.intent == "observation"]
    assert len(observed) == len(engine.communities)
    assert {m.community_id for m in observed} == {c.id for c in engine.communities}
    assert all(message.fire_id == fire.id for message in observed)
    assert all(any(word in message.content for word in ("烟", "焦", "火")) for message in observed)
    report = engine.reports[0]
    assert set(m.id for m in observed) <= set(report.related_message_ids)
    for building in report.buildings:
        entity = engine._entity_by_id[building["id"]]
        assert building["x"] == entity.position.x
        assert building["y"] == entity.position.y
    assert report.fire_ids == [] and report.fire_positions == [] and report.fire_position is None
    assert report.reasoning and report.generation_source == "llm"


def test_daily_tick_without_fire():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    asyncio.run(engine.tick())
    assert engine.chats
    assert not engine.reports
    assert not engine.fires
    assert engine.simulation_minute == 5


def test_random_fire_probability_and_allowed_region_distribution():
    engine = SimulationEngine()
    trials, appeared = 1500, 0
    areas = set()
    for seed in range(trials):
        engine.fires.clear()
        engine.fire_random = random.Random(seed)
        for _ in range(3):
            fire = engine._maybe_spawn_fire()
            if fire:
                appeared += 1
                area = engine._entity_by_id[fire.area_id]
                areas.add(area.id)
                assert area.x < fire.position.x < area.x + area.width
                assert area.y < fire.position.y < area.y + area.height
                assert engine._entity_by_id[fire.nearest_poi_id].area_id == area.id
                break
    assert appeared / trials == pytest.approx(1 - (1 - engine.fire_policy.base_probability)**3, abs=0.025)
    assert areas == {"A-TANK-NW", "A-TANK-NE", "A-TANK-SW", "A-TANK-SE"}


@pytest.mark.parametrize("suppression_factor", [0, .25, .95])
def test_single_fire_persists_until_cleared_and_suppression_cannot_enable_another(suppression_factor):
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1, suppression_factor=suppression_factor))
    first = engine._maybe_spawn_fire()
    assert engine.next_fire_probability == 0
    rng_state = engine.fire_random.getstate()
    for _ in range(15):
        assert engine._maybe_spawn_fire() is None
    assert len(engine.fires) == 1 and engine.fires[0].id == first.id
    assert engine.fire_random.getstate() == rng_state
    old = {fire.id for fire in engine.fires}
    for _ in range(3):
        asyncio.run(engine.tick())
        assert len(engine.fires) == 1 and engine.next_fire_probability == 0
    assert {fire.id for fire in engine.fires} == old
    assert first.intensity == 2
    assert all(message.fire_id in old for message in engine.chats if message.topic != "daily")
    assert all(message.fire_id is None for message in engine.chats if message.topic == "daily")
    engine.clear_fire(first.id)
    assert not engine.fires and engine.next_fire_probability == 1
    second = engine._maybe_spawn_fire()
    assert second is not None and second.id != first.id and len(engine.fires) == 1
    engine.clear_fire()
    assert not engine.fires and engine.next_fire_probability == 1


def test_reset_clears_fires_and_replays_seeded_positions():
    engine = SimulationEngine(seed=7, fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    point = engine.fires[0].position
    contents = [message.content for message in engine.chats]
    engine.running = True
    engine.reset()
    assert engine.simulation_minute == 0
    assert not engine.running
    assert not engine.fires
    assert not engine.chats
    assert not engine.reports
    asyncio.run(engine.tick())
    assert engine.fires[0].position == point
    assert [message.content for message in engine.chats] == contents
