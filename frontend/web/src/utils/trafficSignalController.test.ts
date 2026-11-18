import { expect, test } from 'vitest';
import city from '../../../../city_scene/city_scene.json';
import local from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import animation from '../../../../city_scene/pedestrian_animation.json';
import config from '../config/trafficControl.json';
import { distance, garage, lanes, pose, stationJunction, type Piece } from './roadNetwork';
import { junctionKey } from './trafficSignalGeometry';
import { crossingPathsConflict, intersections, signalCoverage, signalCrosswalks, TrafficSignalController } from './trafficSignalController';
import { conflicts, TrafficSimulation } from './trafficSimulation';

const run = (signals: TrafficSignalController, seconds: number) => {
  for (let t = 0; t < seconds - 1e-8; t += .1) signals.advance(Math.min(.1, seconds - t));
};
const until = (advance: () => void, predicate: () => boolean, steps = 4000) => {
  for (let i = 0; i < steps && !predicate(); i++) advance();
  expect(predicate()).toBe(true);
};
function isolate(sim: TrafficSimulation) {
  sim.pedestrians.actors.forEach(a => {
    const crossing = a.route.segments[a.index].crosswalk;
    if (crossing) sim.signals.release(sim.signals.getCrosswalkControl(crossing)!.intersection.id, a.id);
  });
  sim.pedestrians.actors.splice(0);
}
function fixture(count = 1) {
  const sim = new TrafficSimulation(); isolate(sim);
  const car = sim.cars.find(c => c.path.some(p => p.road && p.length > 8 && sim.signals.getLaneControl(p)))!;
  const lane = car.path.find(p => p.road && p.length > 8 && sim.signals.getLaneControl(p))!;
  const cars = [car, ...sim.cars.filter(c => c !== car)].slice(0, count);
  sim.cars.splice(0, sim.cars.length, ...cars); sim.trucks.splice(0);
  cars.forEach((c, i) => {
    c.path = car.path; c.index = c.path.indexOf(lane);
    c.cursor = { piece: lane, distance: sim.signals.stopDistance(lane, .65) - 2 - i * 2 };
    c.pose = pose(c.cursor); c.speed = 1.4; c.junction = undefined;
  });
  return { sim, cars, lane, control: sim.signals.getLaneControl(lane)! };
}

test('coverage derives actual vehicle branches, all city junctions, boundary joins and every crosswalk', () => {
  const signals = new TrafficSignalController();
  const controlled = new Set(intersections.map(i => i.id));
  city.nodes.filter(n => n.edge_ids.length >= 3).forEach(n => expect(controlled.has(junctionKey(n.center))).toBe(true));
  local.nodes.forEach(n => {
    const center = n.center.map((v, i) => v + city.original_map_placement.offset[i]);
    const count = lanes.filter(l => l.to === junctionKey(center)).length;
    expect(controlled.has(junctionKey(center))).toBe(count >= 3);
  });
  [...new Set(lanes.map(l => l.to!))].forEach(id => {
    if (id === stationJunction) return;
    expect(controlled.has(id)).toBe(lanes.filter(l => l.to === id).length >= 3 || signalCrosswalks.some(c => c.junction === id));
  });
  expect(signalCoverage.boundaryJoins).toHaveLength(8);
  signalCoverage.boundaryJoins.forEach(id => {
    const joined = lanes.filter(l => l.to === id);
    expect(joined).toHaveLength(2);
    expect(joined.every(l => l.next.length > 0)).toBe(true);
    expect(controlled.has(id)).toBe(false);
  });
  expect(intersections.find(i => i.id === stationJunction)!.entries.filter(e => garage.includes(e.lane))).toHaveLength(1);
  expect(new Set(garage.map(lane => signals.getLaneControl(lane)!.entry.id)).size).toBe(1);
  const stopPoints = garage.map(lane => pose({ piece: lane, distance: signals.getLaneControl(lane)!.entry.stopLine }).point);
  stopPoints.forEach(p => expect(distance(p, stopPoints[0])).toBeLessThan(1e-6));
  expect(signalCrosswalks.filter(c => !c.original).map(c => c.id)).toEqual(animation.crosswalks.map(c => c.id));
  expect(signalCrosswalks.filter(c => c.original)).toHaveLength(config.originalCrosswalks.length);
  expect(new Set(intersections.flatMap(i => i.crosswalks.map(c => c.id))).size).toBe(signalCrosswalks.length);
});

test('stop lines and lights follow actual approach geometry and lie before crosswalk entrances', () => {
  intersections.forEach(i => i.entries.forEach(e => {
    expect(e.stopLine).toBeGreaterThanOrEqual(0); expect(e.stopLine).toBeLessThanOrEqual(e.lane.length);
    expect(e.lamp.every(Number.isFinite)).toBe(true);
    expect(distance(e.lamp, i.point)).toBeLessThan(7);
    i.crosswalks.forEach(c => {
      const a = c.points[0], b = c.points[1];
      const along = ((a[0] + b[0]) / 2 - e.lane.points[0][0]) * e.heading[0] + ((a[1] + b[1]) / 2 - e.lane.points[0][1]) * e.heading[1];
      if (along > 0 && along < e.lane.length && Math.abs((b[0] - a[0]) * e.heading[0] + (b[1] - a[1]) * e.heading[1]) < .01)
        expect(e.stopLine).toBeLessThanOrEqual(along - c.halfWidth);
    });
  }));
});

test('every intersection cycles through exclusive groups and at least 1.5 seconds of all red', () => {
  const signals = new TrafficSignalController();
  const last = new Map(signals.getAllSignalStates().map(s => [s.intersectionId, { phase: s.phase, groupId: s.groupId, red: 0 }]));
  const seen = new Set<string>();
  for (let frame = 0; frame < 800; frame++) {
    signals.advance(.25);
    signals.getAllSignalStates().forEach(state => {
      const intersection = intersections.find(i => i.id === state.intersectionId)!;
      const vehicles = Object.entries(state.vehicles).filter(([, color]) => color === 'green').map(([id]) => id);
      const pedestrians = Object.entries(state.pedestrians).filter(([, color]) => color === 'green').map(([id]) => id);
      expect(vehicles.length === 0 || pedestrians.length === 0).toBe(true);
      const greenEntries = intersection.entries.filter(e => vehicles.includes(e.id));
      greenEntries.forEach(a => greenEntries.forEach(b => expect(Math.abs(a.heading[0] * b.heading[1] - a.heading[1] * b.heading[0])).toBeLessThan(1e-6)));
      const group = intersection.groups.find(g => g.id === state.groupId);
      expect([...vehicles, ...pedestrians].sort()).toEqual([...(group?.members ?? [])].sort());
      const previous = last.get(state.intersectionId)!;
      if (state.phase !== 'all_red' && previous.phase === 'all_red') expect(previous.red + .25).toBeGreaterThanOrEqual(config.timing.allRed);
      if (state.phase !== 'all_red' && previous.phase !== 'all_red') expect(state.groupId).toBe(previous.groupId);
      previous.red = state.phase === 'all_red' ? previous.red + .25 : 0; previous.phase = state.phase;
      previous.groupId = state.groupId;
      if (group) seen.add(`${state.intersectionId}:${group.id}`);
    });
  }
  expect(seen.size).toBe(intersections.reduce((n, i) => n + i.groups.length, 0));
});

test('T junctions identify the opposite main road and separate the actual branch', () => {
  const tees = intersections.filter(i => i.kind === 't_junction');
  expect(tees.length).toBeGreaterThan(0);
  tees.forEach(i => {
    const main = i.groups.find(g => g.id === i.mainGroup)!;
    expect(main.members).toHaveLength(2);
    expect(i.groups.filter(g => g.kind === 'vehicle').map(g => g.members.length).sort()).toEqual([1, 2]);
    const entries = i.entries.filter(e => main.members.includes(e.id));
    expect(entries[0].heading[0] * entries[1].heading[0] + entries[0].heading[1] * entries[1].heading[1]).toBeCloseTo(-1);
  });
  intersections.filter(i => i.crosswalks.length === 0).forEach(i => expect(i.groups.every(g => g.kind === 'vehicle')).toBe(true));
});

test('crossing pedestrian paths conflict; disjoint and shared sidewalk endpoints do not', () => {
  expect(crossingPathsConflict([[0, 0], [2, 2]], [[0, 2], [2, 0]])).toBe(true);
  expect(crossingPathsConflict([[0, 0], [2, 0]], [[0, 1], [2, 1]])).toBe(false);
  expect(crossingPathsConflict([[0, 0], [2, 0]], [[2, 0], [2, 2]])).toBe(false);
  expect(crossingPathsConflict([[0, 0], [2, 0]], [[1, 0], [3, 0]])).toBe(true);
  expect(crossingPathsConflict([[0, 0], [2, 0]], [[1, 0], [1, 2]])).toBe(true);
  intersections.forEach(i => i.groups.filter(g => g.kind === 'pedestrian').forEach(g => g.members.forEach((id, n) =>
    g.members.slice(n + 1).forEach(other => expect(crossingPathsConflict(i.crosswalks.find(c => c.id === id)!.points, i.crosswalks.find(c => c.id === other)!.points)).toBe(false)))));
});

test('overlapping short links share occupancy until the whole compound junction has cleared', () => {
  const signals = new TrafficSignalController(), zone = signalCoverage.compoundZones[0];
  expect(zone).toContain(stationJunction);
  signals.setMode('emergency_lockdown'); signals.setEmergencyAccess('responding', true);
  signals.occupy(zone[0], 'clearing', 'vehicle');
  zone.forEach(id => expect(signals.isOccupied(id)).toBe(true));
  const lane = intersections.find(i => i.id === zone[1])!.entries[0].lane;
  expect(signals.canEnterVehicle(lane, 'responding', true)).toBe(false);
  expect(signals.canEnterVehicle(lane, 'clearing', false)).toBe(true);
  signals.setMode('normal'); run(signals, 3);
  zone.forEach(id => expect(signals.getIntersectionState(id)!.phase).toBe('all_red'));
  signals.release(zone[0], 'clearing'); run(signals, .1);
  zone.forEach(id => expect(signals.getIntersectionState(id)!.phase).toBe('vehicle'));
});

test('lockdown, subscriptions, idempotence, immutable snapshots and guarded recovery use one service', () => {
  const signals = new TrafficSignalController(); run(signals, 2);
  let changes = 0; const unsubscribe = signals.subscribe(() => changes++);
  signals.setMode('emergency_lockdown'); expect(changes).toBe(1);
  signals.setMode('emergency_lockdown'); expect(changes).toBe(1);
  run(signals, 70); expect(changes).toBe(1);
  signals.getAllSignalStates().forEach(s => {
    expect(Object.values(s.vehicles).every(c => c === 'red')).toBe(true);
    expect(Object.values(s.pedestrians).every(c => c === 'red')).toBe(true);
    expect(Object.isFrozen(s.vehicles)).toBe(true);
  });
  const id = intersections[0].id;
  signals.occupy(id, 'clearing', 'vehicle'); signals.setMode('normal'); run(signals, 4);
  expect(signals.getIntersectionState(id)!.phase).toBe('all_red');
  signals.release(id, 'clearing'); run(signals, .1);
  expect(signals.getIntersectionState(id)!.phase).toBe('vehicle');
  expect(signals.getIntersectionState('missing')).toBeUndefined();
  unsubscribe(); const before = changes; signals.setMode('emergency_lockdown'); expect(changes).toBe(before);
});

test('ordinary cars stop before the stop line, queue without overlaps and resume their same paths', () => {
  const { sim, cars, lane } = fixture(3);
  const paths = cars.map(c => c.path);
  sim.signals.setMode('emergency_lockdown');
  for (let t = 0; t < 200; t++) {
    sim.tick(.05);
    expect(cars.every(c => c.cursor.piece === lane && c.cursor.distance <= sim.signals.stopDistance(lane, .65) + 1e-7)).toBe(true);
    cars.forEach((car, i) => cars.slice(i + 1).forEach(other => expect(conflicts(car, other, 0)).toBe(false)));
  }
  expect(cars[0].cursor.distance).toBeCloseTo(sim.signals.stopDistance(lane, .65));
  const stopped = cars.map(c => c.cursor.distance); sim.tick(2);
  expect(cars.map(c => c.cursor.distance)).toEqual(stopped);
  sim.signals.setMode('normal');
  until(() => sim.tick(.1), () => cars.every(c => c.cursor.piece !== lane), 1800);
  cars.forEach((c, i) => expect(c.path).toBe(paths[i]));
});

test('every controlled road entrance, including junctions without zebras, stops at red without acquiring a crossing', () => {
  intersections.flatMap(i => i.entries).filter(e => Boolean(e.lane.road)).forEach(entry => {
    const sim = new TrafficSimulation(); isolate(sim);
    const car = sim.cars[0], next = entry.lane.next[0];
    sim.cars.splice(1); sim.trucks.splice(0);
    car.path = next.junction ? [entry.lane, next, next.next[0]] : [entry.lane, next];
    car.index = 0; car.junction = undefined;
    const stop = sim.signals.stopDistance(entry.lane, .65);
    car.cursor = { piece: entry.lane, distance: Math.max(0, stop - 1) }; car.pose = pose(car.cursor);
    sim.signals.setMode('emergency_lockdown'); sim.tick(4);
    expect(car.cursor.piece, entry.id).toBe(entry.lane);
    expect(car.cursor.distance, entry.id).toBeLessThanOrEqual(stop + 1e-7);
    expect(car.junction, entry.id).toBeUndefined();
  });
}, 15000);

test('cars already committed at lockdown finish crossing; an occupied exit prevents new entries', () => {
  const { sim, cars: [car], lane, control } = fixture();
  car.cursor.distance = sim.signals.stopDistance(lane, .65) + .02; car.pose = pose(car.cursor);
  sim.signals.setMode('emergency_lockdown');
  until(() => sim.tick(.05), () => car.cursor.piece !== lane && car.cursor.piece.road !== undefined);
  expect(sim.signals.getIntersectionState(control.intersection.id)!.phase).toBe('all_red');
  const second = fixture(2), leader = second.cars[0], follower = second.cars[1];
  const turn = follower.path[follower.index + 1], exit = turn.next[0];
  leader.cursor = { piece: exit, distance: .5 }; leader.pose = pose(leader.cursor); leader.speed = 0;
  follower.cursor.distance = second.sim.signals.stopDistance(second.lane, .65) - .2; follower.pose = pose(follower.cursor);
  second.sim.tick(20);
  expect(follower.cursor.piece).toBe(second.lane);
  expect(follower.junction).toBeUndefined();
});

test('authorized fire truck waits for occupied crossing, respects physical collisions, then passes all red', () => {
  const { sim, lane, control } = fixture(); sim.cars.splice(0);
  const truckSim = new TrafficSimulation();
  const truck = truckSim.trucks[0];
  const turn = lane.next[0], exit = turn.next[0];
  truck.path = [lane, turn, exit]; truck.index = 0; truck.stop = exit.length - .9; truck.status = 'en-route';
  truck.cursor = { piece: lane, distance: sim.signals.stopDistance(lane, .84) - .5 }; truck.pose = pose(truck.cursor);
  sim.trucks.push(truck); sim.signals.setMode('emergency_lockdown'); sim.signals.setEmergencyAccess(truck.id, false);
  sim.tick(2); expect(truck.cursor.piece).toBe(lane); expect(truck.waitingForSignal).toBe(true);
  sim.signals.setEmergencyAccess(truck.id, true); sim.signals.occupy(control.intersection.id, 'walking', 'pedestrian', control.intersection.crosswalks[0].id);
  const before = truck.pose.point; sim.tick(2); expect(truck.pose.point).toEqual(before);
  sim.signals.release(control.intersection.id, 'walking');
  until(() => sim.tick(.05), () => truck.cursor.piece === exit);
  expect(sim.signals.getMode()).toBe('emergency_lockdown');
  expect(sim.signals.getAllSignalStates().every(s => Object.values(s.vehicles).every(c => c === 'red'))).toBe(true);
  const blocker = truckSim.cars[0]; blocker.cursor = { piece: exit, distance: Math.min(exit.length - .8, truck.cursor.distance + 3) };
  blocker.pose = pose(blocker.cursor); blocker.speed = 0; blocker.path = [exit]; blocker.index = 0;
  sim.cars.push(blocker); sim.tick(3); expect(conflicts(truck, blocker, 0)).toBe(false);
});

test('revoked station access stops each responding truck before the shared road entrance until authorized', () => {
  const sim = new TrafficSimulation(); isolate(sim); sim.cars.splice(0);
  sim.trucks.forEach(t => sim.signals.setEmergencyAccess(t.id, false));
  sim.signals.setMode('emergency_lockdown'); sim.setIncident([39.717988, 33.984756], 1); sim.tick(5);
  const truck = sim.trucks.find(t => t.status === 'en-route')!;
  expect(garage.includes(truck.cursor.piece)).toBe(true);
  expect(truck.cursor.distance).toBeCloseTo(sim.signals.stopDistance(truck.cursor.piece, .84));
  sim.signals.setEmergencyAccess(truck.id, true);
  until(() => sim.tick(.05), () => !garage.includes(truck.cursor.piece));
  expect(sim.trucks).toHaveLength(3);
});

test('pedestrian waits at red, starts on green, clears after lockdown and continues the saved route after recovery', () => {
  const sim = new TrafficSimulation();
  const pedestrian = sim.pedestrians.actors.find(a => a.id.startsWith('WALK:'))!;
  isolate(sim); sim.pedestrians.actors.push(pedestrian); sim.cars.splice(0); sim.trucks.splice(0);
  const route = pedestrian.route, crossing = route.segments[0].crosswalk!;
  sim.signals.setMode('emergency_lockdown'); sim.tick(5);
  expect(pedestrian.distance).toBe(0); expect(pedestrian.waiting).toBe(true);
  sim.signals.setMode('normal');
  until(() => sim.tick(.1), () => pedestrian.distance > .1);
  expect(sim.signals.getCrosswalkControl(crossing)!.intersection.crosswalks.some(c => c.id === crossing)).toBe(true);
  sim.signals.setMode('emergency_lockdown');
  until(() => sim.tick(.1), () => pedestrian.index === 1);
  const position = pedestrian.point; sim.tick(5); expect(pedestrian.point).toEqual(position);
  expect(pedestrian.distance).toBe(0); expect(pedestrian.waiting).toBe(true);
  sim.signals.setMode('normal'); until(() => sim.tick(.1), () => pedestrian.distance > .1);
  expect(pedestrian.route).toBe(route);
});

test('existing extension pedestrian routes obey their saved crosswalk edges and retain phase continuity', () => {
  const sim = new TrafficSimulation(), actor = sim.pedestrians.actors.find(a => a.route.segments.some(s => s.crosswalk) && !a.id.startsWith('WALK:'))!;
  isolate(sim); sim.cars.splice(0); sim.trucks.splice(0); sim.pedestrians.actors.push(actor);
  actor.index = actor.route.segments.findIndex(s => Boolean(s.crosswalk)); actor.distance = 0;
  sim.signals.setMode('emergency_lockdown'); sim.tick(5); expect(actor.distance).toBe(0);
  sim.signals.setMode('normal'); until(() => sim.tick(.1), () => actor.distance > .02);
  const index = actor.index; sim.signals.setMode('emergency_lockdown');
  until(() => sim.tick(.1), () => actor.index !== index);
  expect(actor.route.segments[actor.index].crosswalk).toBeUndefined();
  const d = actor.distance; sim.tick(1); expect(actor.distance).toBeGreaterThan(d);
});

test('configured fleet contains five actual local cars, all 48 extension routes and three original fire trucks', () => {
  const sim = new TrafficSimulation();
  expect(sim.cars).toHaveLength(53);
  expect(sim.cars.filter(c => c.path.every(p => !p.road || p.road.startsWith('R-')))).toHaveLength(5);
  expect(sim.cars.filter(c => c.path.some(p => p.road?.startsWith('EXT-'))).map(c => c.id)).toEqual(city.traffic_routes.slice(0, 48).map(r => r.id));
  expect(sim.trucks).toHaveLength(3);
});

test('route priority clears occupied junctions, gives one direction green and keeps unrelated programs running', () => {
  const signals = new TrafficSignalController();
  run(signals, 2);
  const intersection = intersections.find(i => i.region === 'extension' && i.groups.filter(g => g.kind === 'vehicle').length > 1)!;
  const requested = intersection.entries.find(e => !intersection.groups[0].members.includes(e.id))!;
  const unrelated = intersections.find(i => !signals.sharesClearanceZone(i.id, intersection.id))!;
  const before = signals.getIntersectionState(unrelated.id);
  signals.setEmergencyAccess('responding', true);
  signals.setMode('emergency_priority');
  expect(signals.getIntersectionState(unrelated.id)?.vehicles).toEqual(before?.vehicles);
  signals.setPriorityApproaches([requested.lane]);
  signals.occupy(intersection.id, 'clearing', 'pedestrian', intersection.crosswalks[0]?.id);
  run(signals, 3);
  expect(signals.getIntersectionState(intersection.id)?.phase).toBe('all_red');
  expect(signals.canEnterVehicle(requested.lane, 'responding', true)).toBe(false);
  signals.release(intersection.id, 'clearing');
  run(signals, .1);
  const priority = signals.getIntersectionState(intersection.id)!;
  expect(priority.emergencyPriority).toBe(true);
  expect(priority.vehicles[requested.id]).toBe('green');
  const group = intersection.groups.find(g => g.members.includes(requested.id))!;
  intersection.entries.filter(e => !group.members.includes(e.id)).forEach(e => {
    expect(priority.vehicles[e.id]).toBe('red');
    expect(signals.canEnterVehicle(e.lane, 'responding', true)).toBe(false);
  });
  expect(Object.values(priority.pedestrians).every(color => color === 'red')).toBe(true);
  expect(signals.getAllSignalStates().some(s => !s.emergencyPriority && Object.values(s.vehicles).includes('green'))).toBe(true);
  signals.setPriorityApproaches([]);
  run(signals, .1);
  expect(signals.getIntersectionState(intersection.id)?.phase).toBe('all_red');
  expect(signals.getIntersectionState(intersection.id)?.emergencyPriority).toBe(false);
  run(signals, config.timing.allRed);
  expect(signals.getIntersectionState(intersection.id)?.phase).toBe('vehicle');
  signals.setMode('normal');
  expect(signals.getAllSignalStates().every(s => !s.emergencyPriority)).toBe(true);
});

test('conflicting responder directions switch through the full clearance interval', () => {
  const signals = new TrafficSignalController();
  const intersection = intersections.find(i => i.region === 'extension' && i.groups.filter(g => g.kind === 'vehicle').length > 1)!;
  const first = intersection.entries[0];
  const second = intersection.entries.find(e => !intersection.groups[0].members.includes(e.id))!;
  signals.setMode('emergency_priority');
  signals.setPriorityApproaches([first.lane, second.lane]);
  run(signals, 2);
  expect(signals.getIntersectionState(intersection.id)?.vehicles[first.id]).toBe('green');
  expect(signals.getIntersectionState(intersection.id)?.vehicles[second.id]).toBe('red');
  signals.setPriorityApproaches([second.lane]);
  run(signals, config.timing.allRed - .1);
  expect(signals.getIntersectionState(intersection.id)?.phase).toBe('all_red');
  run(signals, .1);
  expect(signals.getIntersectionState(intersection.id)?.vehicles[first.id]).toBe('red');
  expect(signals.getIntersectionState(intersection.id)?.vehicles[second.id]).toBe('green');
});

test.each([0, .5, 1, 2, 3])('complete city demonstration at offset %s: lockdown, arrival, recovery and return', offset => {
  const sim = new TrafficSimulation();
  sim.tick(12 + offset);
  const tank = local.pois.find(p => p.id === 'T-SW-01')!;
  sim.signals.setMode('emergency_lockdown'); sim.setIncident([tank.center[0] + 30, tank.center[1] + 25], 3);
  for (let i = 0; i < 1800 && !sim.trucks.every(t => t.status === 'arrived'); i++) sim.tick(.1);
  expect(sim.trucks.every(t => t.status === 'arrived'), JSON.stringify(sim.trucks.map(t => ({
    status: t.status, point: t.pose.point, road: t.cursor.piece.road, d: t.cursor.distance, length: t.cursor.piece.length,
    junction: t.junction, waiting: t.waitingForSignal, next: t.path[t.index + 1]?.points,
    near: sim.cars.filter(c => distance(c.pose.point, t.pose.point) < 6).map(c => ({ id: c.id, point: c.pose.point, junction: c.junction })),
  })))).toBe(true);
  sim.tick(60);
  const stopped = sim.cars.map(c => c.pose.point); sim.tick(2);
  expect(sim.cars.map(c => c.pose.point)).toEqual(stopped);
  expect(sim.all.every((a, i) => sim.all.slice(i + 1).every(b => !conflicts(a, b, 0)))).toBe(true);
  sim.signals.setMode('normal'); sim.setIncident(null, 3);
  for (let i = 0; i < 9000 && !sim.trucks.every(t => t.status === 'idle'); i++) sim.tick(.1);
  expect(sim.trucks.every(t => t.status === 'idle'), JSON.stringify(sim.trucks.map(t => ({
    status: t.status, point: t.pose.point, road: t.cursor.piece.road, d: t.cursor.distance, length: t.cursor.piece.length,
    junction: t.junction, waiting: t.waitingForSignal, reversing: t.reversing, blocked: t.blockedFor,
    busy: sim.all.filter(c => c.junction && (signalCoverage.compoundZones[0].includes(c.junction) || c.junction === t.cursor.piece.to))
      .map(c => ({id: c.id, p: c.pose.point, road: c.cursor.piece.road, d: c.cursor.distance, junction: c.junction})),
    near: sim.all.filter(c => c !== t && distance(c.pose.point, t.pose.point) < 6).map(c => ({ id: c.id, point: c.pose.point, junction: c.junction })),
  })))).toBe(true);
  expect(sim.trucks.map(t => t.pose.point)).toEqual(garage.map(p => p.points[0]));
  expect(sim.cars.some((c, i) => distance(c.pose.point, stopped[i]) > .2)).toBe(true);
});
