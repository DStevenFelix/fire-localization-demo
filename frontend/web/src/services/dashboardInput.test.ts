import { expect, test, vi } from 'vitest';
import { connectDashboardSource, DashboardInput, mediaSlots, registerDashboard, responders, trackingTimeoutMs, visibleDeviceRoute } from './dashboardInput';
import { cityToDevice, deviceToCity, tabletopCalibration } from '../utils/deviceCoordinates';
import { sceneToPixel, scenePixelToCity } from '../utils/mapCoordinates';

test('physical corners and centre agree with the saved map, and rotate or reverse through explicit calibration', () => {
  const systems = new Map([[tabletopCalibration.sourceCoordinateSystem, tabletopCalibration]]);
  for (const [x, y, cityX, cityY] of [[0, 0, 30, 25], [2.5, 2, 45, 37.5], [5, 4, 60, 50]]) {
    const city = deviceToCity({ x, y }, tabletopCalibration.sourceCoordinateSystem, systems, tabletopCalibration.version);
    expect(city).toEqual({ x: cityX, y: cityY });
    expect(cityToDevice(city, tabletopCalibration)).toEqual({ x, y });
    const roundTrip = scenePixelToCity(sceneToPixel({ x_m: city.x, y_m: city.y }));
    expect(roundTrip.x_m).toBeCloseTo(cityX, 10);
    expect(roundTrip.y_m).toBeCloseTo(cityY, 10);
  }
  const reversed = { ...tabletopCalibration, sourceCoordinateSystem: 'CAMERA_MM', version: 'v2',
    origin: '东北原点', axisDirection: 'X 南、Y 西，毫米',
    physicalBounds: [0, 0, 4000, 5000], transform: [0, -.006, -.00625, 0, 30, 25] } satisfies typeof tabletopCalibration;
  systems.set(reversed.sourceCoordinateSystem, reversed);
  expect(deviceToCity({ x: 4000, y: 5000 }, 'CAMERA_MM', systems, 'v2')).toEqual({ x: 30, y: 25 });
  const anchor = cityToDevice({ x: 60, y: 50 }, reversed);
  expect(anchor.x).toBeCloseTo(0, 10);
  expect(anchor.y).toBeCloseTo(0, 10);
  expect(() => deviceToCity({ x: 1, y: 1 }, 'CAMERA_MM', systems, 'v1')).toThrow(/标定/);
});

test('six devices share one route and position boundary without introducing a standby-to-fix segment', () => {
  const ids = responders.map(device => device.id);
  const input = new DashboardInput('physical', { calibrations: [tabletopCalibration], idMap: { 'robot-4': ids[3] } });
  const now = Date.now(), send = (eventType: string, payload: unknown, sequence: number, occurredAt = now) =>
    input.consume({ sourceMode: 'physical', eventType, payload, eventId: `event-${sequence}`, occurredAt, incidentId: 'incident-1' });
  expect(new Set(ids).size).toBe(6);
  expect(Object.values(input.getSnapshot().devices).every(device => !device.locatedAt && device.track.length === 0)).toBe(true);
  expect(mediaSlots.filter(slot => 'deviceId' in slot).map(slot => slot.deviceId)).toEqual(ids.slice(0, 4));
  expect(send('device.connection', { deviceId: ids[4], state: 'online' }, 0).accepted).toBe(true);
  expect(input.getSnapshot().devices[ids[4]]).toMatchObject({ status: 'idle', connection: 'online', position: { x: 28.6, y: 23.15 } });
  for (const [index, device] of responders.entries()) {
    const deviceId = index === 3 ? 'robot-4' : device.id;
    const telemetry = { deviceId, kind: device.kind, coordinateSystem: tabletopCalibration.sourceCoordinateSystem,
      calibrationVersion: tabletopCalibration.version, position: { x: index / 2, y: 2 }, headingRadians: index / 3 };
    const first = send('device.telemetry', telemetry, 1 + index);
    expect(first.accepted).toBe(true);
    const state = input.getSnapshot().devices[device.id];
    expect(state.track).toEqual([{ x: 30 + 3 * index, y: 37.5 }]);
    expect(send('device.route', { deviceId, taskId: `route-${index}`, route: [{ x: 1, y: 2 }, { x: 1.2 + index / 2, y: 3 }],
      coordinateSystem: 'LOCAL30x25' }, 10 + index).accepted).toBe(true);
    expect(send('device.telemetry', { ...telemetry, position: { x: index / 2, y: 2.5 } }, 20 + index, now + 1).accepted).toBe(true);
    expect(input.getSnapshot().devices[device.id].track).toHaveLength(2);
    expect(input.getSnapshot().devices[device.id].route?.[1].x).toBeCloseTo(31.2 + index / 2);
    expect(send('device.telemetry', { ...telemetry, position: { x: -1, y: 0 } }, 30 + index, now + 2).accepted).toBe(false);
    expect(send('device.telemetry', telemetry, 40 + index, now - 1000).accepted).toBe(false);
  }
  expect(send('device.connection', { deviceId: ids[3], state: 'disconnected' }, 99, now + 10).accepted).toBe(true);
  input.expirePositions(now + trackingTimeoutMs + 20);
  expect(input.getSnapshot().devices[ids[3]]).toMatchObject({ stale: true, connection: 'disconnected', track: [{ x: 39, y: 37.5 }, { x: 39, y: 40.625 }] });
  expect(send('device.telemetry', { deviceId: 'unknown' }, 100).accepted).toBe(false);
  expect(send('device.connection', { deviceId: ids[3], state: 'online' }, 101, now - 60_000).accepted).toBe(false);
});

test('session scope and transport cleanup keep simulated and physical messages apart', () => {
  const first = new DashboardInput('physical'), second = new DashboardInput('simulation');
  first.setSession('A');
  const detach = registerDashboard(first);
  let receive: Parameters<Parameters<typeof connectDashboardSource>[0]>[0] = () => { throw new Error('not connected'); };
  const close = vi.fn();
  connectDashboardSource(listener => { receive = listener; return close; }, raw => raw);
  const message = { sourceMode: 'physical', eventType: 'agent.event', eventId: 'agent-event', sessionId: 'A', occurredAt: Date.now(),
    payload: { agent: 'dispatch', type: '调度', phase: '已派遣', summary: '路线下发' } };
  expect(receive(message)).toEqual({ accepted: true });
  expect(receive(message)).toEqual({ accepted: true, duplicate: true });
  expect(receive({ ...message, eventId: 'older', occurredAt: Date.now() - 6000, payload: { ...message.payload, phase: '等待' } }).accepted).toBe(true);
  expect(first.getSnapshot().agents.dispatch?.phase).toBe('已派遣');
  expect(first.getSnapshot().log.map(entry => entry.id)).toEqual(['agent-event', 'older']);
  first.setSession('B');
  expect(first.getSnapshot().log).toEqual([]);
  expect(receive(message).accepted).toBe(false);
  expect(receive({ ...message, sessionId: 'B', sourceMode: 'simulation' }).accepted).toBe(false);
  detach();
  expect(close).toHaveBeenCalledOnce();
  const stop = registerDashboard(second);
  expect(receive(message).accepted).toBe(false);
  expect(second.getSnapshot().log).toEqual([]);
  stop();
});

test('field subscriptions keep their own ID mappings and report setup and envelope errors', () => {
  const input = new DashboardInput('physical');
  const detach = registerDashboard(input);
  const listeners: ((raw: unknown) => ReturnType<DashboardInput['consume']>)[] = [];
  const subscribe = (receive: typeof listeners[number]) => {
    listeners.push(receive);
    return vi.fn();
  };
  const [first, second] = responders;
  connectDashboardSource(subscribe, raw => raw, { idMap: { robot: first.id } });
  connectDashboardSource(subscribe, raw => raw, { idMap: { robot: second.id } });
  connectDashboardSource(subscribe, raw => {
    if (raw === null) throw new RangeError('无法解析设备报文');
    throw new TypeError('适配器程序错误');
  });
  const message = { sourceMode: 'physical', eventType: 'device.connection', occurredAt: Date.now(),
    payload: { deviceId: 'robot', state: 'online' } };
  expect(listeners[0]({ ...message, eventId: 'source-a:1' }).accepted).toBe(true);
  expect(listeners[1]({ ...message, eventId: 'source-b:1' }).accepted).toBe(true);
  expect(input.getSnapshot().devices[first.id].connection).toBe('online');
  expect(input.getSnapshot().devices[second.id].connection).toBe('online');
  expect(listeners[2](null)).toEqual({ accepted: false, error: '无法解析设备报文' });
  expect(input.getSnapshot().rejected).toBe('无法解析设备报文');
  expect(() => listeners[2](0)).toThrow(TypeError);
  connectDashboardSource(subscribe, raw => raw, { calibrations: [{ ...tabletopCalibration, transform: [1, 1, 1, 1, 0, 0] }] });
  expect(input.getSnapshot().rejected).toMatch(/标定参数无效/);
  expect(listeners).toHaveLength(3);
  expect(listeners[0]({ ...message, eventId: 'source-a:2', eventType: 'agent.event',
    payload: { agent: 'location', type: '候选', phase: '候选更新', summary: '外部候选' } }).accepted).toBe(false);
  expect(input.getSnapshot().agents.location).toBeUndefined();
  detach();
});

test('field task feedback and routes use separate timestamps and survive independent Bridge session changes', () => {
  const input = new DashboardInput('physical');
  const deviceId = responders[0].id;
  const snapshot = () => input.getSnapshot().devices[deviceId];
  const now = Date.now();
  const send = (eventId: string, eventType: string, payload: object, offset: number, sessionId?: string) =>
    input.consume({ sourceMode: 'physical', eventId, eventType, payload: { deviceId, taskId: 'field-task', ...payload },
      incidentId: 'field-incident', occurredAt: now + offset, sessionId });
  const path = { coordinateSystem: 'CITY90x75', route: [{ x: 31, y: 31 }, { x: 35, y: 35 }] };
  expect(send('plan', 'device.route', path, -20).accepted).toBe(true);
  expect(snapshot().task?.phase).toBeUndefined();
  expect(send('dispatch', 'device.task', { phase: '已接单', status: 'en-route' }, -30).accepted).toBe(true);
  expect(snapshot()).toMatchObject({ status: 'en-route', route: path.route, task: { id: 'field-task', phase: '已接单' } });
  expect(send('latest', 'device.task', { phase: '抵达', status: 'arrived' }, -10).accepted).toBe(true);
  const fix = { kind: 'fireTruck', position: { x: 34, y: 34 }, coordinateSystem: 'CITY90x75', headingRadians: 0, status: 'en-route' };
  expect(send('fix', 'device.telemetry', fix, -15).accepted).toBe(true);
  expect(snapshot()).toMatchObject({ status: 'arrived', position: fix.position, connection: 'online' });
  expect(send('old-disconnect', 'device.connection', { state: 'disconnected' }, -16).accepted).toBe(false);
  expect(send('disconnect', 'device.connection', { state: 'disconnected' }, -2).accepted).toBe(true);
  expect(send('still-late', 'device.telemetry', { ...fix, status: undefined }, -5).accepted).toBe(true);
  expect(snapshot().connection).toBe('disconnected');
  expect(send('fix-after-loss', 'device.telemetry', { ...fix, status: undefined }, 0).accepted).toBe(true);
  expect(snapshot()).toMatchObject({ status: 'arrived', position: fix.position, connection: 'online' });
  input.setSession('bridge-session');
  expect(send('latest', 'device.task', { phase: '抵达' }, -10)).toEqual({ accepted: true, duplicate: true });
  expect(send('obsolete', 'device.task', { phase: '前往火场' }, -11).accepted).toBe(false);
  expect(send('other-task', 'device.route', { ...path, taskId: 'other-task' }, -21).accepted).toBe(false);
  expect(snapshot()).toMatchObject({ status: 'arrived', route: path.route, task: { phase: '抵达' } });
  expect(input.getSnapshot().log.find(entry => entry.id === 'latest')).toMatchObject({
    deviceId, taskId: 'field-task', incidentId: 'field-incident', status: '抵达',
  });
});

test('closed outbound lines stay hidden and an old task cannot replace a new one', () => {
  const input = new DashboardInput('physical');
  const deviceId = responders[0].id;
  const now = Date.now();
  const send = (eventId: string, time: number, eventType: string, payload: object) =>
    input.consume({ sourceMode: 'physical', incidentId: 'job', eventId, occurredAt: now + time, eventType, payload: { deviceId, ...payload } });
  const route = { taskId: 'out', coordinateSystem: 'CITY90x75', route: [{ x: 30, y: 31 }, { x: 35, y: 36 }] };
  const device = () => input.getSnapshot().devices[deviceId];
  expect(send('path', -40, 'device.route', route).accepted).toBe(true);
  expect(visibleDeviceRoute(device())).toEqual(route.route);
  expect(send('arrived', -35, 'device.task', { taskId: 'out', phase: '抵达', status: 'arrived' }).accepted).toBe(true);
  expect(visibleDeviceRoute(device())).toBeUndefined();
  expect(send('late-path', -30, 'device.route', route).accepted).toBe(true);
  expect(visibleDeviceRoute(device())).toBeUndefined();
  expect(send('path', -40, 'device.route', route)).toEqual({ accepted: true, duplicate: true });
  expect(send('next', -20, 'device.route', { ...route, taskId: 'next' }).accepted).toBe(true);
  expect(visibleDeviceRoute(device())).toEqual(route.route);
  expect(send('retired', -10, 'device.route', route).accepted).toBe(false);
  expect(device().task?.id).toBe('next');
  expect(send('offline', -5, 'device.connection', { state: 'disconnected' }).accepted).toBe(true);
  expect(send('online', 0, 'device.connection', { state: 'online' }).accepted).toBe(true);
  expect(visibleDeviceRoute(device())).toBeUndefined();
});

test('coordinate-only confirmation drives the fire display and interruption ends the device water effect', () => {
  const input = new DashboardInput('physical', { calibrations: [tabletopCalibration] });
  const deviceId = responders[0].id;
  const now = Date.now();
  const fire = () => input.getSnapshot().agents.dispatch;
  const device = () => input.getSnapshot().devices[deviceId];
  const send = (eventId: string, time: number, eventType: string, payload: object) =>
    input.consume({ sourceMode: 'physical', incidentId: 'job', eventId, occurredAt: now + time, eventType, payload });
  expect(send('fire', -10, 'recon.confirmed', { position: { x: 2.5, y: 2 }, coordinateSystem: 'PHYSICAL_SW_METERS',
    calibrationVersion: 'axis-aligned-v1', result: '热成像确认' }).accepted).toBe(true);
  expect(fire()).toMatchObject({ firePosition: { x: 45, y: 37.5 }, fireStatus: 'burning' });
  expect(send('start', -8, 'device.task', { deviceId, taskId: 'work', phase: '开始灭火', status: 'extinguishing' }).accepted).toBe(true);
  expect(device().waterTarget).toEqual({ x: 45, y: 37.5 });
  expect(fire()?.fireStatus).toBe('extinguishing');
  expect(send('stop', -5, 'agent.event', { agent: 'dispatch', type: '灭火反馈', phase: '作业中断', summary: '设备中断',
    suppression: 'interrupted' }).accepted).toBe(true);
  expect(fire()).toMatchObject({ fireStatus: 'burning', suppression: 'interrupted' });
  expect(device().waterTarget).toBeUndefined();
  expect(send('old-start', -6, 'device.task', { deviceId, taskId: 'work', phase: '开始灭火', status: 'extinguishing' }).accepted).toBe(true);
  expect(device().waterTarget).toBeUndefined();
});
