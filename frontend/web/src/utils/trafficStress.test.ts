import { expect, test } from 'vitest';
import { poiRegistry } from './poiRegistry';
import { toCity } from './mapCoordinates';
import { distance, inTankZone, isFireStationOnly, roadPieces, type Point } from './roadNetwork';
import { conflicts, TrafficSimulation } from './trafficSimulation';

const pieceIds = new Map([...roadPieces].map(([id, piece]) => [piece, id]));
const tanks = [...poiRegistry.values()].filter(poi => poi.type === 'Tank');

function exerciseTraffic(target: Point, signalOffset: number) {
  const sim = new TrafficSimulation();
  const failures: unknown[] = [];
  const stopped = new Map(sim.all.map(car => [car.id, { point: car.pose.point, seconds: 0, longest: 0 }]));
  let time = 0;
  let closedZoneEntry = false;
  let stationOnlyEntry: string | undefined;
  let overlap: string[] | undefined;
  const walkingDuringEmergency = new Set<string>();
  const pedestrianCount = sim.pedestrians.actors.length;
  const describe = () => sim.trucks.map(truck => ({ id: truck.id, status: truck.status,
    xy: truck.pose.point.map(n => Number(n.toFixed(3))), lane: pieceIds.get(truck.cursor.piece),
    offset: Number(truck.cursor.distance.toFixed(3)), next: pieceIds.get(truck.path[truck.index + 1]),
    junction: truck.junction, connector: truck.cursor.piece.junction, red: truck.waitingForSignal,
    length: truck.cursor.piece.length, telemetry: truck.telemetry,
    stopped: stopped.get(truck.id)?.seconds,
    signal: truck.cursor.piece.to && sim.signals.getIntersectionState(truck.cursor.piece.to)?.phase,
    near: sim.trucks.filter(other => other !== truck && distance(other.pose.point, truck.pose.point) < 4)
      .map(other => [other.id, other.status, pieceIds.get(other.cursor.piece), other.junction]),
  }));
  function advance(seconds: number, until = () => false) {
    for (let elapsed = 0; elapsed < seconds - 1e-8 && !until(); elapsed += .25) {
      const outside = sim.cars.filter(car => !inTankZone(car.cursor.piece));
      const pedestrians = sim.tankZoneClosed ? sim.pedestrians.actors.map(actor => actor.point) : [];
      const dt = Math.min(.25, seconds - elapsed);
      sim.tick(dt);
      time += dt;
      if (!overlap) {
        const vehicles = sim.all;
        for (const [index, first] of vehicles.entries()) {
          const second = vehicles.slice(index + 1).find(other => conflicts(first, other, 0));
          if (second) { overlap = [first.id, second.id]; break; }
        }
      }
      if (sim.tankZoneClosed && outside.some(car => inTankZone(car.cursor.piece))) closedZoneEntry = true;
      stationOnlyEntry ??= sim.cars.find(car => isFireStationOnly(car.cursor.piece))?.id;
      if (sim.tankZoneClosed) sim.pedestrians.actors.forEach((actor, index) => {
        if (distance(pedestrians[index], actor.point) > .01) walkingDuringEmergency.add(actor.id);
      });
      for (const car of sim.all) {
        const state = stopped.get(car.id)!;
        if (distance(state.point, car.pose.point) > .05) {
          state.point = car.pose.point;
          state.seconds = 0;
        } else {
          state.seconds += dt;
          state.longest = Math.max(state.seconds, state.longest);
        }
      }
    }
  }
  function reach(stage: string, seconds: number, done: () => boolean) {
    advance(seconds, done);
    if (!done()) failures.push({ stage, time, trucks: describe(), carsInZone: sim.cars.filter(car => inTankZone(car.cursor.piece)).map(car => car.id) });
  }
  const spraying = (count: number) => sim.sceneSnapshot.filter(truck => truck.waterTarget).length === count;
  const home = () => sim.trucks.every(truck => truck.status === 'idle');

  advance(signalOffset);
  sim.setTankZoneClosed(true);
  advance(6);
  sim.setIncident(target, 3);
  // Exercise diversion of moving trucks, then recall them before they finish returning.
  advance(2);
  sim.setIncident(target, 1);
  advance(1.5);
  sim.setIncident(target, 2);
  advance(2.5);
  sim.setIncident(target, 3);
  reach('three trucks dispatched', 100, () => spraying(3));
  reach('district evacuated', 75, () => sim.cars.every(car => !inTankZone(car.cursor.piece)));
  sim.setIncident(target, 1);
  reach('at least one released truck starts moving home', 75, () => sim.trucks.some(truck =>
    truck.status === 'returning' && stopped.get(truck.id)!.seconds === 0));
  sim.setIncident(target, 3);
  reach('trucks recalled while returning arrived again', 120, () => spraying(3));
  sim.setIncident(target, 1);
  reach('two trucks released while one keeps spraying', 600, () => spraying(1) && sim.trucks.filter(truck => truck.status === 'idle').length === 2);
  sim.setIncident(target, 3);
  reach('redispatched trucks reached fire', 180, () => spraying(3));
  sim.setTankZoneClosed(false);
  sim.setIncident(null, 3);
  reach('all trucks parked after extinction', 600, home);
  reach('normal cars re-enter the district', 100, () => sim.cars.some(car => inTankZone(car.cursor.piece)));
  advance(240);
  const prolonged = sim.cars.filter(car => stopped.get(car.id)!.seconds > 240).map(car => ({ id: car.id,
    point: car.pose.point, lane: pieceIds.get(car.cursor.piece), junction: car.junction, seconds: stopped.get(car.id)!.seconds,
    next: pieceIds.get(car.path[car.index + 1]), signal: car.cursor.piece.to && sim.signals.getIntersectionState(car.cursor.piece.to)?.phase,
    nearby: sim.all.filter(other => car !== other && distance(car.pose.point, other.pose.point) < 7)
      .map(other => [other.id, pieceIds.get(other.cursor.piece), other.junction, stopped.get(other.id)?.seconds]),
  }));
  return { failures, closedZoneEntry, stationOnlyEntry, overlap, prolonged, seconds: time, longestCarWait: Math.max(...sim.cars.map(car => stopped.get(car.id)!.longest)),
    pedestrians: sim.pedestrians.actors.length, pedestrianCount, walkingDuringEmergency: walkingDuringEmergency.size };
}

const offsets = process.env.TRAFFIC_STRESS === '1' ? [0, 17, 49, 115] : [17];
test.each(tanks.flatMap(poi => offsets.map(offset => ({ poi, offset }))))('$poi.id with $offset seconds of initial traffic', ({ poi, offset }) => {
  const target = toCity({ x_m: poi.center[0], y_m: poi.center[1] }, poi.coordinate_system);
  const result = exerciseTraffic([target.x_m, target.y_m], offset);
  expect(result.failures, JSON.stringify(result)).toEqual([]);
  expect(result.closedZoneEntry).toBe(false);
  expect(result.stationOnlyEntry).toBeUndefined();
  expect(result.overlap).toBeUndefined();
  expect(result.prolonged, JSON.stringify(result)).toEqual([]);
  expect(result.pedestrians).toBe(result.pedestrianCount);
  expect(result.walkingDuringEmergency).toBe(result.pedestrianCount);
  if (process.env.TRAFFIC_STRESS === '1') console.info(`${poi.id} +${offset}s: ${result.seconds}s simulated, longest car wait ${result.longestCarWait}s`);
}, 20_000);
