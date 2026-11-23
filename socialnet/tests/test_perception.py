import asyncio
from collections import Counter
from itertools import combinations, product
import math
import random

import pytest

from app.agents import MonitorAgent, ResidentContext
from app.models import FirePolicy
from app.simulation import SimulationEngine, perception_probabilities

SIGNALS = ("odor", "smoke", "flame")


class FixedDraws:
    def __init__(self, draws):
        self.draws = iter(draws)

    def random(self):
        return next(self.draws, 0.999999)


def scene():
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    fire = engine._maybe_spawn_fire()
    resident = min(engine.residents, key=lambda r: engine._distance(r.position, fire.position))
    return engine, fire, resident


def test_probabilities_are_smooth_bounded_and_monotone():
    distances = (0, 5, 10.99, 11, 11.01, 11.32, 16.99, 17, 17.01, 25, 40)
    for intensity in range(1, 6):
        previous = {s: 1 for s in SIGNALS}
        for distance in distances:
            values = perception_probabilities(distance, intensity)
            assert set(values) == set(SIGNALS)
            for signal, probability in values.items():
                assert 0 < probability < 1
                assert probability <= previous[signal]
            previous = values
    for distance in distances:
        for signal in SIGNALS:
            values = [perception_probabilities(distance, i)[signal] for i in range(1, 6)]
            assert values == sorted(values)
    for boundary in (11, 17):
        before = perception_probabilities(boundary - 1e-6, 4)
        after = perception_probabilities(boundary + 1e-6, 4)
        assert all(abs(before[s] - after[s]) < 1e-6 for s in SIGNALS)


@pytest.mark.parametrize("selected", list(product((False, True), repeat=3)))
def test_every_signal_combination_including_none_is_possible(selected):
    engine, fire, resident = scene()
    fire.intensity = 1
    observation = engine._observation(resident, fire, FixedDraws([0 if active else .999999 for active in selected]))
    expected = [s for s, active in zip(SIGNALS, selected) if active]
    if not expected:
        assert observation is None
        return
    assert observation.signals == expected
    assert set(observation.cues) == set(expected)
    # No smoke is smuggled into a flame-only observation or its generated message.
    if "smoke" not in expected:
        assert "烟" not in observation.proximity_hint
        if "flame" in expected:
            assert all("烟" not in text for text in observation.cues["flame"])
    context = ResidentContext(resident=resident, building=engine._entity_by_id[resident.building_id],
                              fire=fire, distance_to_fire=None, is_nearest_building=True,
                              simulation_minute=5, intent="observation", topic_key="fire", observation=observation)
    values = engine.agents[resident.id].prompt_values(context)
    assert '"signals"' in values["observation_context"]
    content = asyncio.run(engine.agents[resident.id].speak(context))
    public = engine.agents[resident.id].last_evidence_quotes
    assert set(public).intersection(SIGNALS) <= set(expected)
    assert set(public).intersection(SIGNALS)
    if "odor" in public:
        assert "味" in content
    if "flame" in public:
        assert "火光" in content or "明火" in content
    if expected == ["flame"]:
        assert "烟" not in content
    if expected == ["odor"]:
        assert "火光" not in content and "明火" not in content


def test_independent_sampling_matches_marginal_and_joint_probabilities():
    engine, fire, resident = scene()
    fire.intensity = 5
    distance = engine._distance(resident.position, fire.position)
    probabilities = perception_probabilities(distance, fire.intensity)
    rng, n = random.Random(1987), 15000
    outcomes = Counter()
    for _ in range(n):
        o = engine._observation(resident, fire, rng)
        outcomes[tuple(o.signals) if o else ()] += 1
    for signal in SIGNALS:
        count = sum(amount for signals, amount in outcomes.items() if signal in signals)
        assert count / n == pytest.approx(probabilities[signal], abs=.015)
    for pair in combinations(SIGNALS, 2):
        count = sum(amount for signals, amount in outcomes.items() if set(pair) <= set(signals))
        assert count / n == pytest.approx(math.prod(probabilities[s] for s in pair), abs=.015)
    assert outcomes[()] / n == pytest.approx(math.prod(1-p for p in probabilities.values()), abs=.01)
    assert len(outcomes) == 8


def test_previous_jinan_distance_no_longer_excludes_odor_or_flame():
    engine, fire, _ = scene()
    fire.intensity = 5
    resident = min((r for r in engine.residents if r.community_id == "A-WEST"), key=lambda r: engine._distance(r.position, fire.position))
    distance = engine._distance(resident.position, fire.position)
    assert distance > 11
    probabilities = perception_probabilities(distance, fire.intensity)
    assert probabilities["odor"] > .2 and probabilities["flame"] > .2
    rng = random.Random(10)
    observed = set()
    for _ in range(100):
        o = engine._observation(resident, fire, rng)
        if o:
            observed.update(o.signals)
    assert observed == set(SIGNALS)


def test_no_sampled_signal_produces_daily_chat_not_a_fake_observation(monkeypatch):
    monkeypatch.setattr("app.simulation.perception_probabilities", lambda distance, intensity: {s: 0 for s in SIGNALS})
    engine = SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    assert engine.fires and len(engine.chats) == 3 * len(engine.communities)
    assert not engine.reports
    assert all(m.topic == "daily" and not m.evidence_signals and m.evidence_source == "none" and m.fire_id is None for m in engine.chats)


def test_multiple_senses_do_not_multiply_witnesses_and_hearsay_does_not_grant_senses():
    engine, fire, _ = scene()
    asyncio.run(engine.tick())
    base = engine.chats[0]
    odor_smoke = base.model_copy(update={"intent": "observation", "topic": "fire", "evidence_source": "direct", "evidence_signals": ["odor", "smoke"]})
    monitor = MonitorAgent()
    assert asyncio.run(monitor.analyze([odor_smoke])).events[0].severity == "警告"
    flame = odor_smoke.model_copy(update={"evidence_signals": ["odor", "smoke", "flame"]})
    assert asyncio.run(monitor.analyze([flame])).events[0].severity == "紧急"
    echoes = [flame.model_copy(update={"id": f"echo-{i}", "intent": "reply", "evidence_signals": [], "evidence_source": "hearsay", "building_id": str(i)}) for i in range(4)]
    assert asyncio.run(monitor.analyze(echoes)).events[0].severity == "警告"
