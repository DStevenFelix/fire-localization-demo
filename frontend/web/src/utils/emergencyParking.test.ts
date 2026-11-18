import { afterEach, expect, test, vi } from 'vitest';
import { TrafficSimulation } from './trafficSimulation';
import { EmergencyService } from './emergency';
import { createEmergencyMock } from '../../e2e/emergencyMock';
import { roadPieces } from './roadNetwork';
import { connectTrafficControl } from './trafficSignalController';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });

test.each([0, .08, .4, 1])('responders clear intersections when parking after startup offset %s', async offset => {
  const traffic = new TrafficSimulation();
  const service = new EmergencyService(traffic);
  const mock = createEmergencyMock(service);
  cleanups.push(connectTrafficControl(traffic.signals), service.attach(), service.connect(mock.adapter));
  for (let t = 0; t < 115.3 + offset - 1e-8; t += .05) traffic.tick(.05);
  expect(traffic.cars).toHaveLength(27);
  mock.begin();
  const plan = mock.prepare(2, 3);
  expect(plan.dispatches).toHaveLength(2);
  plan.dispatches.forEach(dispatch => {
    const lane = roadPieces.get(dispatch.route!.pieceIds.at(-1)!)!;
    expect(dispatch.route!.stop).toBeGreaterThanOrEqual(traffic.signals.exitClearance(lane, lane.from!, .84));
  });
  await service.confirm();
  for (let time = 0; time < 300 && !traffic.trucks.filter(t => t.external).every(t => t.status === 'arrived'); time += .05) traffic.tick(.05);
  expect(traffic.trucks.filter(t => t.status === 'arrived')).toHaveLength(2);
  plan.dispatches.forEach(dispatch => mock.emit({ type: 'truck.extinguishing', vehicleId: dispatch.vehicleId }));
  expect(mock.emit({ type: 'fire.extinguished' }).accepted).toBe(true);
  await vi.waitFor(() => expect(service.getSnapshot().incident?.phase).toBe('returning'));
  traffic.tick(2);
  const distances = new Map(traffic.cars.map(car => [car.id, 0]));
  for (let time = 0; time < 900; time += .05) {
    const before = traffic.cars.map(car => car.pose.point);
    traffic.tick(.05);
    traffic.cars.forEach((car, i) => distances.set(car.id, distances.get(car.id)! + Math.hypot(car.pose.point[0] - before[i][0], car.pose.point[1] - before[i][1])));
    if (time >= 100 && traffic.trucks.every(t => t.status === 'idle') && service.getSnapshot().drones.every(d => !d.path) &&
      [...distances.values()].every(distance => distance > .2)) break;
  }
  expect(traffic.trucks.every(t => t.status === 'idle')).toBe(true);
  expect(traffic.cars.filter(car => distances.get(car.id)! <= .2).map(car => ({
    id: car.id, point: car.pose.point, road: car.cursor.piece.road, to: car.cursor.piece.to,
  }))).toEqual([]);
}, 60000);
