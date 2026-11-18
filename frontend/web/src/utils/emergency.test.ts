import { afterEach, expect, test, vi } from 'vitest';
import { createEmergencyMock } from '../../e2e/emergencyMock';
import { EmergencyService } from './emergency';
import { connectTrafficControl } from './trafficSignalController';
import { conflicts, TrafficSimulation } from './trafficSimulation';
import { getDispatchNetwork, roadPieces } from './roadNetwork';
import config from '../config/emergency.json';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.useRealTimers(); });
function setup(connected = true) {
  const traffic = new TrafficSimulation(), service = new EmergencyService(traffic), mock = createEmergencyMock(service);
  cleanups.push(connectTrafficControl(traffic.signals), service.attach());
  if (connected) cleanups.push(service.connect(mock.adapter));
  return { traffic, service, mock };
}

test('two centrally configured drones start idle and their snapshots are shared by both displays', () => {
  const { service } = setup();
  expect(service.getSnapshot().drones.map(d => [d.id, d.status])).toEqual([['DRONE-01', 'idle'], ['DRONE-02', 'idle']]);
  expect(service.getSceneActors().map(a => a.position)).toEqual(service.getSnapshot().drones.map(d => d.position));
});

test('an active incident rejects another target and retains the current incident', () => {
  const { service, mock } = setup(); mock.begin();
  const incident = service.getSnapshot().incident;
  expect(service.receive({ type: 'fire.detected', targetPoiId: 'T-SE-01', incidentId: 'another', messageId: 'another', occurredAt: 100 }).accepted).toBe(false);
  expect(service.getSnapshot().incident).toBe(incident);
});

test('all display subscribers see the advanced drone frame even when registered before attach', () => {
  const traffic = new TrafficSimulation(), service = new EmergencyService(traffic);
  const frames: unknown[] = [];
  cleanups.push(traffic.subscribe(() => frames.push(service.getSnapshot().drones)));
  cleanups.push(service.attach());
  const mock = createEmergencyMock(service); mock.begin();
  Array.from({ length: 20 }, () => {
    traffic.tick(.1);
    expect(frames.at(-1)).toBe(service.getSnapshot().drones);
    expect(service.getSceneActors().map(d => d.position)).toEqual(service.getSnapshot().drones.map(d => d.position));
  });
});

test('route end and explicit idle telemetry clear paths while preserving externally controlled status', () => {
  const { service, traffic, mock } = setup(); mock.begin(); traffic.tick(20);
  expect(service.getSnapshot().drones.every(d => !d.path && d.status === 'flying')).toBe(true);
  const d = service.getDrone('DRONE-01')!;
  mock.emit({ type: 'drone.return', drone: { ...d, status: 'idle', updatedAt: 100, path: [d.position, config.drones[0].position] } });
  expect(service.getDrone(d.id)?.path).toBeUndefined();
});

test('completed assessment and proposals require an actual dispatch and explicit observation', async () => {
  const { service, mock, traffic } = setup();
  mock.emit({ type: 'fire.detected', targetPoiId: 'T-SW-01' });
  const before = service.getSnapshot().incident;
  expect(mock.emit({ type: 'drone.observed', droneId: 'DRONE-01' }).accepted).toBe(false);
  expect(mock.emit({ type: 'fire.assessed', assessment: { targetPoiId: 'T-SW-01', status: 'completed', severity: 2, result: 'test' } }).accepted).toBe(false);
  const plan = mock.prepare(1, 2, false);
  expect(mock.emit({ type: 'plan.proposed', plan }).accepted).toBe(false);
  await service.confirm();
  expect(service.getSnapshot().incident).toBe(before);
  expect(mock.commands).toHaveLength(0);
  expect(traffic.trucks.every(t => t.status === 'idle')).toBe(true);
  expect(traffic.signals.getMode()).toBe('normal');
});

test.each(['idle', 'charging', 'returning', 'observing'] as const)('%s telemetry cannot create a reconnaissance assignment', status => {
  const { service, mock } = setup();
  mock.emit({ type: 'fire.detected', targetPoiId: 'T-SW-01' });
  const d = service.getDrone('DRONE-01')!;
  const result = mock.emit({ type: 'drone.update', drone: { ...d, status, updatedAt: 1 } });
  expect(result.accepted).toBe(status !== 'observing');
  expect(service.getSnapshot().incident).toMatchObject({ droneIds: [], observedIds: [], phase: 'fire_detected' });
  expect(mock.emit({ type: 'drone.observed', droneId: d.id }).accepted).toBe(false);
  expect(mock.emit({ type: 'fire.assessed', assessment: { targetPoiId: 'T-SW-01', status: 'completed', severity: 1, result: 'test' } }).accepted).toBe(false);
});

test.each([1, 2])('observation gate follows the %i drones actually assigned to this incident', async count => {
  const { service, mock, traffic } = setup();
  mock.emit({ type: 'fire.detected', targetPoiId: 'T-SW-01' });
  service.getSnapshot().drones.slice(0, count).forEach((d, index) =>
    mock.emit({ type: 'drone.update', drone: { ...d, status: 'flying', targetPoiId: 'T-SW-01', updatedAt: index + 10 } }));
  const assessment = { targetPoiId: 'T-SW-01', status: 'completed' as const, severity: 2 as const, result: 'test' };
  expect(mock.emit({ type: 'fire.assessed', assessment }).accepted).toBe(false);
  expect(mock.emit({ type: 'drone.observed', droneId: 'DRONE-01' }).accepted).toBe(true);
  if (count === 2) {
    const before = service.getSnapshot().incident;
    expect(mock.emit({ type: 'fire.assessed', assessment }).accepted).toBe(false);
    expect(service.getSnapshot().incident).toBe(before);
    mock.emit({ type: 'drone.observed', droneId: 'DRONE-02' });
  }
  const observed = service.getSnapshot().incident;
  mock.emit({ type: 'drone.observed', droneId: 'DRONE-01' });
  expect(service.getSnapshot().incident).toBe(observed);
  expect(mock.emit({ type: 'fire.assessed', assessment }).accepted).toBe(true);
  mock.prepare(1, 2, false);
  expect(service.getSnapshot().incident?.phase).toBe('awaiting_confirmation');
  expect(traffic.trucks.every(t => t.status === 'idle')).toBe(true);
  await service.confirm();
  expect(service.getSnapshot().incident?.confirmed).toBe(true);
  expect(mock.commands.filter(c => c.type === 'plan.confirm')).toHaveLength(1);
});

test('unassigned, wrong-incident and pre-dispatch observations cannot satisfy the gate', () => {
  const { service, mock } = setup(); mock.begin();
  const before = service.getSnapshot().incident;
  expect(service.receive({ type: 'drone.observed', droneId: 'DRONE-01', incidentId: 'previous-incident', messageId: 'old-incident', occurredAt: 200 }).accepted).toBe(false);
  expect(service.receive({ type: 'drone.observed', droneId: 'DRONE-01', incidentId: 'TEST-INCIDENT-01', messageId: 'old-time', occurredAt: 0 }).accepted).toBe(false);
  expect(service.getSnapshot().incident).toBe(before);
  expect(before?.observedIds).toEqual([]);
});

test('a new reconnaissance assignment invalidates the old assessment and proposal', async () => {
  const { service, mock } = setup(); const plan = mock.prepare(1);
  const d = service.getDrone('DRONE-01')!;
  mock.emit({ type: 'drone.update', drone: { ...d, status: 'dispatched', updatedAt: 100 } });
  expect(service.getSnapshot().incident).toMatchObject({ observedIds: ['DRONE-02'], assessment: undefined, plan: undefined });
  expect(mock.emit({ type: 'plan.proposed', plan }).accepted).toBe(false);
  await service.confirm();
  expect(mock.commands).toHaveLength(0);
});

test.each(['fire.assessed', 'plan.proposed'] as const)('a delayed %s from an earlier assignment cannot replace current reconnaissance', type => {
  const { service, mock } = setup(); const plan = mock.prepare(1);
  const assessment = service.getSnapshot().incident!.assessment!;
  const d = service.getDrone('DRONE-01')!;
  service.receive({ type: 'drone.update', incidentId: 'TEST-INCIDENT-01', messageId: 'new-dispatch', occurredAt: 100,
    drone: { ...d, status: 'dispatched', updatedAt: 100 } });
  service.receive({ type: 'drone.observed', incidentId: 'TEST-INCIDENT-01', messageId: 'new-observation', occurredAt: 200, droneId: d.id });
  const before = service.getSnapshot().incident;
  expect(service.receive({ ...(type === 'fire.assessed' ? { type, assessment } : { type, plan }),
    incidentId: 'TEST-INCIDENT-01', messageId: 'delayed-result', occurredAt: 199 }).accepted).toBe(false);
  expect(service.getSnapshot().incident).toBe(before);
});
test('independent tasks interpolate supplied paths, heading and altitude without inventing routes', () => {
  const { service, traffic, mock } = setup(); mock.begin();
  const before = service.getSnapshot().drones;
  traffic.tick(.5);
  const after = service.getSnapshot().drones;
  expect(after[0].position).not.toEqual(before[0].position);
  expect(after[1].position).not.toEqual(before[1].position);
  expect(after.map(d => d.altitude)).toEqual([110, 125]);
  expect(after[0].heading).toBeCloseTo(Math.atan2(before[0].path![1].y - before[0].position.y, before[0].path![1].x - before[0].position.x));
  const originalSecond = after[1];
  mock.emit({ type: 'drone.update', drone: { ...after[0], path: undefined, updatedAt: 100, position: { x: 39, y: 32 }, heading: -1, altitude: 95, status: 'observing' } });
  expect(service.getDrone('DRONE-02')).toBe(originalSecond);
  expect(service.getDrone('DRONE-01')).toMatchObject({ heading: -1, altitude: 95, status: 'observing' });
});
test('stale telemetry is ignored and path end never infers observation completion', () => {
  const { service, traffic, mock } = setup(); mock.begin(); traffic.tick(10);
  const d = service.getDrone('DRONE-01')!;
  expect(d.status).toBe('flying');
  mock.emit({ type: 'drone.update', drone: { ...d, position: { x: 0, y: 0 }, updatedAt: 0 } });
  expect(service.getDrone(d.id)!.position).toEqual(d.position);
  mock.emit({ type: 'drone.observed', droneId: d.id });
  expect(service.getDrone(d.id)!.status).toBe('observing');
});
test.each([1, 2, 3] as const)('external severity %i updates fire display without changing truck count', severity => {
  const { service, mock } = setup(); mock.prepare(1, severity);
  expect(service.getSnapshot().incident?.assessment).toMatchObject({ severity });
  expect(service.getSnapshot().incident?.plan?.dispatches).toHaveLength(1);
  expect(service.getSnapshot().incident?.fireStatus).toBe('burning');
});
test.each([null, {}, { type: 'fire.detected', messageId: 'm', incidentId: 'i', occurredAt: 1, targetPoiId: 'R-01' },
  { type: 'drone.update', messageId: 'm', incidentId: 'i', occurredAt: 1, drone: { id: 'DRONE-03' } }])('invalid input cannot crash or introduce a fire target: %j', input => {
  const { service } = setup(); expect(service.receive(input).accepted).toBe(false); expect(service.getSnapshot().incident).toBeNull();
});
test('assessment failure displays a failure and never assigns a severity', () => {
  const { service, mock } = setup(); mock.emit({ type: 'fire.detected', targetPoiId: 'T-SW-01' });
  mock.emit({ type: 'fire.assessed', assessment: { targetPoiId: 'T-SW-01', status: 'failed', message: '影像不可用' } });
  expect(service.getSnapshot().incident).toMatchObject({ phase: 'failed', fireStatus: 'normal', error: '影像不可用' });
  expect(service.getSnapshot().incident?.assessment).not.toHaveProperty('severity');
});
test('a failed reassessment clears its proposal and never falls back to a visual severity', () => {
  const { service, mock } = setup(); mock.prepare(1, 3);
  mock.emit({ type: 'fire.assessed', assessment: { targetPoiId: 'T-SW-01', status: 'failed', message: '影像失效' } });
  expect(service.getSnapshot().incident).toMatchObject({ fireStatus: 'normal', phase: 'failed' });
  expect(service.getSnapshot().incident?.plan).toBeUndefined();
});
test('adapter subscription errors stay at the connection boundary', () => {
  const { service, mock } = setup(false);
  expect(() => service.connect({ ...mock.adapter, subscribe() { throw new Error('连接失败'); } })).not.toThrow();
  expect(service.getSnapshot()).toMatchObject({ connected: false, inputError: '连接失败' });
});
test('external fixture plans against moving traffic without retaining old pedestrian occupancy', async () => {
  const { service, mock, traffic } = setup(); traffic.tick(7);
  const plan = mock.prepare(2); await service.confirm();
  for (let time = 0; time < 300 && !plan.dispatches.every(d => traffic.trucks.find(t => t.id === d.vehicleId)!.status === 'arrived'); time += .1) traffic.tick(.1);
  expect(plan.dispatches.every(d => traffic.trucks.find(t => t.id === d.vehicleId)!.status === 'arrived')).toBe(true);
});
test('approved route updates retain the current physical position and reject disconnected pieces', async () => {
  const { mock, service, traffic } = setup(); const plan = mock.prepare(1); await service.confirm();
  const dispatch = plan.dispatches[0], truck = traffic.trucks.find(t => t.id === dispatch.vehicleId)!, before = [...truck.pose.point];
  expect(mock.emit({ type: 'truck.route', vehicleId: dispatch.vehicleId, route: dispatch.route! }).accepted).toBe(true);
  expect(truck.pose.point).toEqual(before);
  expect(mock.emit({ type: 'truck.route', vehicleId: dispatch.vehicleId, route: { pieceIds: ['lane:0'], stop: 1 } }).accepted).toBe(false);
});
test('proposal and cancellation keep all trucks parked and normal signals; results are retained', async () => {
  const { service, mock, traffic } = setup(); mock.prepare();
  const before = traffic.trucks.map(t => t.pose.point);
  service.cancel(); await service.confirm(); traffic.tick(10);
  expect(traffic.trucks.map(t => t.pose.point)).toEqual(before);
  expect(traffic.signals.getMode()).toBe('normal'); expect(mock.commands).toHaveLength(0);
  expect(service.getSnapshot().incident).toMatchObject({ cancelled: true, assessment: { status: 'completed' } });
  service.reopen(); await service.confirm(); expect(mock.commands).toHaveLength(1);
});
test('confirmation is idempotent and gives access to exactly the selected vehicles', async () => {
  const { service, mock, traffic } = setup(); const plan = mock.prepare(1);
  await Promise.all([service.confirm(), service.confirm()]); await service.confirm();
  expect(mock.commands).toHaveLength(1); expect(traffic.signals.getMode()).toBe('normal');
  traffic.trucks.forEach(t => expect(traffic.signals.hasEmergencyAccess(t.id)).toBe(plan.dispatches.some(d => d.vehicleId === t.id)));
});
test('missing adapter or traffic initialization preserves the pending proposal', async () => {
  const { service, mock, traffic } = setup(false); mock.prepare(); await service.confirm();
  expect(service.getSnapshot().incident?.error).toContain('数据源未连接');
  cleanups.push(service.connect(mock.adapter));
  const disconnect = connectTrafficControl(traffic.signals); disconnect(); await service.confirm();
  expect(service.getSnapshot().incident?.error).toContain('尚未初始化');
  expect(mock.commands).toHaveLength(0); expect(traffic.signals.getMode()).toBe('normal');
});
test('missing official path never falls back to a client dispatch algorithm', async () => {
  const { service, mock, traffic } = setup(); const plan = mock.prepare();
  mock.emit({ type: 'plan.proposed', plan: { ...plan, id: 'no-route', dispatches: plan.dispatches.map(d => ({ ...d, route: undefined })) } });
  await service.confirm(); expect(service.getSnapshot().incident?.error).toContain('正式路径');
  expect(traffic.signals.getMode()).toBe('normal'); expect(traffic.trucks.every(t => t.status === 'idle')).toBe(true);
});
test('route provider resolves commands before any vehicle starts', async () => {
  const { service, mock } = setup(); const plan = mock.prepare(1);
  cleanups.push(service.connect({ ...mock.adapter, resolveRoute: async () => plan.dispatches[0].route! }));
  mock.emit({ type: 'plan.proposed', plan: { ...plan, id: 'resolved', dispatches: plan.dispatches.map(d => ({ ...d, route: undefined })) } });
  await service.confirm(); expect(service.getSnapshot().incident?.confirmed).toBe(true);
});
test('invalid route cannot teleport a truck or start traffic control', async () => {
  const { service, mock, traffic } = setup(); const plan = mock.prepare(1), before = traffic.trucks.map(t => t.pose.point);
  mock.emit({ type: 'plan.proposed', plan: { ...plan, id: 'bad-path', dispatches: plan.dispatches.map(d => ({ ...d, route: { pieceIds: ['lane:0'], stop: 1 } })) } });
  await service.confirm(); expect(traffic.trucks.map(t => t.pose.point)).toEqual(before); expect(traffic.signals.getMode()).toBe('normal');
});
test('position streams limit route progress while retaining small-step movement and collision checks', async () => {
  const { service, mock, traffic } = setup(); const plan = mock.prepare(1); await service.confirm();
  const truck = traffic.trucks.find(t => t.id === plan.dispatches[0].vehicleId)!, p = truck.pose.point;
  expect(mock.emit({ type: 'truck.position', vehicleId: truck.id, position: { x: p[0], y: p[1] }, updatedAt: 1 }).accepted).toBe(true);
  traffic.tick(.2); expect(truck.pose.point).toEqual(p);
  expect(mock.emit({ type: 'truck.position', vehicleId: truck.id, position: { x: 0, y: 0 }, updatedAt: 2 }).accepted).toBe(false);
});
test('duplicate messages and semantic duplicates do not replace a confirmed plan or rekindle extinguished fire', async () => {
  const { service, mock } = setup(); mock.prepare(1);
  const event = { type: 'fire.detected', targetPoiId: 'T-SW-01', messageId: 'duplicate', incidentId: 'TEST-INCIDENT-01', occurredAt: 100 };
  expect(service.receive(event).accepted).toBe(true); expect(service.receive(event).accepted).toBe(true);
  const assessment = service.getSnapshot().incident!.assessment!;
  mock.emit({ type: 'fire.assessed', assessment });
  expect(service.getSnapshot().incident?.phase).toBe('awaiting_confirmation');
  await service.confirm(); expect(service.getSnapshot().incident?.confirmed).toBe(true);
});
test.each(['drone', 'assessment', 'dispatch', 'extinguish'] as const)('%s failure is visible and can explicitly request recovery', async operation => {
  const { service, mock } = setup(); mock.prepare(); mock.emit({ type: 'operation.failed', operation, message: `${operation}失败` });
  expect(service.getSnapshot().incident?.phase).toBe('failed');
  await service.retry(); expect(mock.commands[0].type).toBe('operation.retry');
  expect(service.getSnapshot().incident?.phase).toBe('awaiting_confirmation');
});
test('timeouts expose retryable errors even when the external implementation ignores AbortSignal', async () => {
  vi.useFakeTimers(); const { service, mock } = setup(); mock.prepare();
  cleanups.push(service.connect({ ...mock.adapter, execute: () => new Promise(() => {}) }));
  const pending = service.confirm(); await vi.advanceTimersByTimeAsync(15001); await pending;
  expect(service.getSnapshot().incident?.error).toContain('超时'); expect(service.getSnapshot().pending).toBe(false);
  expect(service.getSnapshot().incident?.confirmed).toBe(false);
});
test('transport disconnect cancels requests and detaching stops drone animation subscriptions', async () => {
  const { service, mock, traffic } = setup(); mock.prepare();
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  const before = service.getSnapshot().drones.map(d => d.position); traffic.tick(5);
  expect(service.getSnapshot().drones.map(d => d.position)).toEqual(before);
});
test('road export preserves every legal connector and includes the previously excluded vehicle access road', () => {
  const network = getDispatchNetwork();
  expect(network.length).toBe(roadPieces.size); expect(network.every(p => p.next.every(id => roadPieces.has(id)))).toBe(true);
  expect(network.some(p => p.road === 'R-07')).toBe(true);
});
test('full lifecycle uses actual fleet, explicit extinguishing, normal traffic recovery and safe return', async () => {
  const { service, mock, traffic } = setup(); const plan = mock.prepare(2); await service.confirm();
  expect(traffic.cars).toHaveLength(27); expect(traffic.trucks).toHaveLength(3);
  for (let t = 0; t < 300 && !plan.dispatches.every(d => traffic.trucks.find(truck => truck.id === d.vehicleId)!.status === 'arrived'); t += .2) traffic.tick(.2);
  expect(plan.dispatches.map(d => traffic.trucks.find(t => t.id === d.vehicleId)!.status), JSON.stringify(traffic.trucks.map(t => ({ id: t.id, point: t.pose.point, status: t.status, index: t.index, length: t.path.length, distance: t.cursor.distance, stop: t.stop, road: t.cursor.piece.road, junction: t.junction, end: t.path.at(-1)?.points })))).toEqual(['arrived', 'arrived']);
  expect(service.getSnapshot().incident?.fireStatus).toBe('burning');
  plan.dispatches.forEach(d => { mock.emit({ type: 'truck.arrived', vehicleId: d.vehicleId }); mock.emit({ type: 'truck.extinguishing', vehicleId: d.vehicleId }); });
  traffic.tick(30); expect(service.getSnapshot().incident?.fireStatus).toBe('extinguishing');
  mock.emit({ type: 'fire.extinguished' }); mock.emit({ type: 'fire.extinguished' });
  await vi.waitFor(() => expect(mock.commands.filter(c => c.type === 'responders.return')).toHaveLength(1));
  expect(traffic.signals.getMode()).toBe('normal'); expect(service.getSnapshot().incident?.fireStatus).toBe('extinguished');
  plan.dispatches.forEach(d => expect(traffic.signals.hasEmergencyAccess(d.vehicleId)).toBe(false));
  for (let t = 0; t < 900 && !traffic.trucks.every(truck => truck.status === 'idle'); t += .2) traffic.tick(.2);
  mock.dockDrones(); expect(service.getSnapshot().incident?.phase).toBe('completed');
  expect(traffic.trucks.every(t => !traffic.signals.hasEmergencyAccess(t.id))).toBe(true);
  expect(traffic.all.every((v, i) => traffic.all.slice(i + 1).every(other => !conflicts(v, other)))).toBe(true);
  service.receive({ type: 'fire.detected', incidentId: 'NEXT-INCIDENT', messageId: 'next-incident', occurredAt: 1000, targetPoiId: 'T-NE-01' });
  const next = service.getSnapshot().incident;
  expect(next).toMatchObject({ id: 'NEXT-INCIDENT', droneIds: [], observedIds: [] });
  mock.emit({ type: 'drone.observed', droneId: 'DRONE-01' });
  expect(service.getSnapshot().incident).toBe(next);
}, 20000);

test('delayed return events for different trucks are both applied and complete the incident', async () => {
  const { service, mock, traffic } = setup();
  cleanups.push(service.connect({ ...mock.adapter, execute: async () => {} }));
  const plan = mock.prepare(2); await service.confirm();
  for (let time = 0; time < 300 && !plan.dispatches.every(d => traffic.trucks.find(t => t.id === d.vehicleId)!.status === 'arrived'); time += .2) traffic.tick(.2);
  expect(mock.emit({ type: 'truck.extinguishing', vehicleId: plan.dispatches[0].vehicleId }).accepted).toBe(true);
  mock.emit({ type: 'fire.extinguished' });
  await vi.waitFor(() => expect(service.getSnapshot().pending).toBe(false));
  expect(service.receive({ type: 'truck.return', vehicleId: plan.dispatches[1].vehicleId,
    incidentId: 'TEST-INCIDENT-01', messageId: 'return-second', occurredAt: 200 }).accepted).toBe(true);
  expect(service.receive({ type: 'truck.return', vehicleId: plan.dispatches[0].vehicleId,
    incidentId: 'TEST-INCIDENT-01', messageId: 'return-first-delayed', occurredAt: 100 }).accepted).toBe(true);
  expect(service.getSnapshot().incident!.returningIds).toEqual(expect.arrayContaining(plan.dispatches.map(d => d.vehicleId)));
  for (let time = 0; time < 900 && !traffic.trucks.every(t => t.status === 'idle'); time += .2) traffic.tick(.2);
  mock.dockDrones();
  expect(service.getSnapshot().incident!.phase).toBe('completed');
}, 20000);
