import { expect, test } from 'vitest';
import { EmergencyService } from './emergency';
import { EmergencyDemo, type DemoNotice } from './emergencyDemo';
import { connectTrafficControl } from './trafficSignalController';
import { TrafficSimulation } from './trafficSimulation';

test('manual handoff completes reconnaissance, revises the active fleet, and returns every responder', async () => {
  const traffic = new TrafficSimulation(() => .5);
  const service = new EmergencyService(traffic);
  const notices: DemoNotice[] = [];
  const demo = new EmergencyDemo(service, notice => notices.push(notice));
  const disconnectSignals = connectTrafficControl(traffic.signals);
  const detach = service.attach(demo);
  const incident = () => service.getSnapshot().incident!;

  async function advanceUntil(condition: () => boolean, limit: number) {
    for (let elapsed = 0; !condition() && elapsed < limit; elapsed += .08) {
      traffic.tick(.08);
      await Promise.resolve();
    }
    expect(condition(), `stalled at ${incident().phase}: ${JSON.stringify(traffic.trucks.map(t => ({
      status: t.status, point: t.pose.point, road: t.cursor.piece.road, direction: [t.cursor.piece.from, t.cursor.piece.to],
      s: t.cursor.distance, stop: t.stop, junction: t.junction, waiting: t.waitingForSignal,
    })))}`).toBe(true);
  }

  try {
    demo.applySettings(3);
    expect(service.getSnapshot().incident).toBeNull();
    demo.start('session-1', 'T-SW-01');
    expect(notices).toHaveLength(0);
    expect(service.getSnapshot().drones.every(d => d.status === 'flying')).toBe(true);
    expect(demo.canConfirmExtinction()).toBe(false);
    demo.confirmExtinction();
    expect(incident().phase).toBe('drone_dispatched');
    await advanceUntil(() => incident().confirmed, 30);
    expect(incident().observedIds).toHaveLength(2);
    expect(notices.map(n => n.severity)).toEqual([3]);
    expect(incident().plan?.dispatches).toHaveLength(3);
    await advanceUntil(() => traffic.trucks.some(t => t.cursor.piece.road && t.status === 'en-route'), 15);
    demo.applySettings(1);
    expect(incident().plan?.dispatches).toHaveLength(1);
    expect(incident().assessment).toMatchObject({ severity: 1, source: '模拟演示' });
    const cancelled = traffic.trucks.filter(t => t.id !== incident().plan?.dispatches[0].vehicleId);
    expect(cancelled.every(t => ['idle', 'returning', 'return-waiting'].includes(t.status))).toBe(true);
    demo.applySettings(2);
    expect(incident().plan?.dispatches).toHaveLength(2);
    expect(notices.map(n => n.severity)).toEqual([3, 1, 2]);
    await advanceUntil(() => traffic.sceneSnapshot.filter(t => t.waterTarget).length === 2, 120);
    traffic.tick(20);
    expect(incident().fireStatus).toBe('extinguishing');
    expect(traffic.sceneSnapshot.filter(t => t.waterTarget)).toHaveLength(2);
    demo.applySettings(1);
    expect(incident().plan?.dispatches).toHaveLength(1);
    traffic.tick(12);
    expect(incident().fireStatus).toBe('extinguishing');
    expect(traffic.sceneSnapshot.some(t => t.waterTarget)).toBe(true);
    expect(demo.canConfirmExtinction()).toBe(true);
    demo.confirmExtinction();
    expect(incident().fireStatus).toBe('extinguished');
    expect(traffic.sceneSnapshot.some(t => t.waterTarget)).toBe(false);
    expect(demo.canConfirmExtinction()).toBe(false);
    await advanceUntil(() => incident().phase === 'completed', 600);
    expect(traffic.trucks.every(t => t.status === 'idle')).toBe(true);
    expect(service.getSnapshot().drones.every(d => d.status === 'charging' && d.altitude === 0)).toBe(true);
    expect(traffic.signals.getMode()).toBe('normal');
  } finally {
    detach();
    disconnectSignals();
  }
}, 20_000);

test.each(['T-SW-01', 'T-SW-02', 'T-SE-01', 'T-SE-02', 'T-NW-01', 'T-NW-02', 'T-NE-01', 'T-NE-02'])(
  'three-truck demonstration completes at %s', async (target) => {
    const traffic = new TrafficSimulation(() => .5);
    const service = new EmergencyService(traffic);
    const demo = new EmergencyDemo(service, () => {});
    const disconnectSignals = connectTrafficControl(traffic.signals);
    const detach = service.attach(demo);
    try {
      demo.applySettings(3);
      demo.start(target, target);
      for (let elapsed = 0; service.getSnapshot().incident?.phase !== 'completed' && elapsed < 600; elapsed += .08) {
        traffic.tick(.08);
        if (demo.canConfirmExtinction() && traffic.sceneSnapshot.filter(t => t.waterTarget).length === 3) demo.confirmExtinction();
        await Promise.resolve();
      }
      const incident = service.getSnapshot().incident;
      expect(incident?.phase, JSON.stringify({ phase: incident?.phase, trucks: traffic.trucks.map(t => [t.status, t.pose.point, t.cursor.piece.road, t.junction]) })).toBe('completed');
    } finally {
      detach();
      disconnectSignals();
    }
  }, 20_000);
