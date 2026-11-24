import { expect, test } from 'vitest';
import { DashboardInput } from '../services/dashboardInput';
import { EmergencyService } from './emergency';
import { EmergencyDemo } from './emergencyDemo';
import { connectSimulatedResponders, prepareMockSession, runMockExercise } from './mockExercise';
import { mockTruckHomes, stationExit } from './roadNetwork';
import { conflicts, TrafficSimulation } from './trafficSimulation';
import { connectTrafficControl } from './trafficSignalController';
import config from '../config/emergency.json';

test.each([4, 2])('Mock dispatches %i responders from the uniform parking layout and safely returns them', async count => {
  const traffic = new TrafficSimulation(() => .5, undefined, undefined, mockTruckHomes);
  const service = new EmergencyService(traffic);
  const input = new DashboardInput('simulation');
  const demo = new EmergencyDemo(service, () => {}, input);
  let session = prepareMockSession();
  input.setSession(session.session_id);
  const disconnectSignals = connectTrafficControl(traffic.signals);
  const detach = service.attach(demo), disconnect = connectSimulatedResponders(input, service);
  const stop = runMockExercise(session, count, input, service, demo, next => { session = next; }, () => {});
  const homes = traffic.trucks.map(truck => truck.pose.point);
  expect(new Set(homes.map(home => home.join(','))).size).toBe(4);
  expect(traffic.trucks.every(truck => truck.cursor.piece.next[0] === stationExit)).toBe(true);
  const moving = new Set<string>();
  let parallel = 0;
  let fullSpraySeconds = 0;
  try {
    for (let elapsed = 0; session.status !== 'completed' && elapsed < 650; elapsed += .1) {
      const before = traffic.trucks.map(truck => truck.pose.point);
      traffic.tick(.1);
      let live = 0;
      traffic.trucks.forEach((truck, i) => {
        if (truck.status === 'en-route' && Math.hypot(truck.pose.point[0] - before[i][0], truck.pose.point[1] - before[i][1]) > 1e-8) {
          moving.add(truck.id);
          live++;
        }
      });
      parallel = Math.max(parallel, live);
      if (Object.values(input.getSnapshot().devices).filter(device => device.waterTarget).length === count) fullSpraySeconds += .1;
      if (traffic.trucks.some((truck, i) => traffic.trucks.slice(i + 1).some(other => conflicts(truck, other, 0))))
        throw new Error('仿真消防车形体重叠');
      await Promise.resolve();
    }
    const incident = service.getSnapshot().incident;
    expect(session.status, JSON.stringify({ phase: incident?.phase, error: incident?.error, trucks: traffic.trucks.map(truck => ({ id: truck.id,
      status: truck.status, pose: truck.pose, lane: truck.cursor.piece.road, junction: truck.junction,
      offset: truck.cursor.distance, stop: truck.stop })) })).toBe('completed');
    expect(session.batch_count).toBe(2);
    expect(session.batch_history?.map(batch => batch.prediction.candidates[0].poi_id)).toEqual(['T-NW-02', 'T-NW-02']);
    expect(session.evaluation).toMatchObject({ top1_hit: false, top3_hit: true, target_rank: 2 });
    expect(incident?.targetPoiId).toBe('T-NW-01');
    expect(input.getSnapshot().reconnaissance.map(report => report.stage)).toEqual(['observed', 'observed', 'observed']);
    expect(incident?.plan?.dispatches).toHaveLength(count);
    expect(incident?.phase).toBe('completed');
    expect(fullSpraySeconds).toBeGreaterThanOrEqual(config.mockSuppressionSeconds - .11);
    expect(moving.size).toBe(count);
    expect(parallel).toBe(count);
    expect(traffic.trucks.map(truck => truck.pose.point)).toEqual(homes);
    expect(input.getSnapshot().log.filter(entry => entry.type === 'device.route' && entry.source.startsWith('EXT-FIRE')).map(entry => entry.source))
      .toEqual(expect.arrayContaining([...moving]));
  } finally {
    stop(); disconnect(); detach(); disconnectSignals();
  }
}, 25_000);
