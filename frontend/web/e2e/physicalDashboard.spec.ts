import { expect, test } from '@playwright/test';
import type { connectExampleDashboardSource } from '../src/services/dashboardSourceExample';

declare global {
  interface Window {
    fieldExample: ReturnType<typeof connectExampleDashboardSource>;
  }
}

test('external field packets drive four trucks, two drones and the dispatch timeline in physical mode', async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('dashboard-source')).toHaveAttribute('data-source-mode', 'physical');
  await expect(page.locator('[data-fire-truck][data-location=virtual]')).toHaveCount(4);
  await expect(page.locator('[data-drone][data-location=virtual]')).toHaveCount(2);
  await page.evaluate(async () => {
    const path = '/src/services/dashboardSourceExample.ts';
    const { connectExampleDashboardSource } = await import(path);
    window.fieldExample = connectExampleDashboardSource();
  });
  const caseId = 'field-incident';
  const trucks = [1, 2, 3, 4];
  const drones = [1, 2];
  const truck = (i: number) => page.locator(`[data-fire-truck="${i}"]`);
  const drone = (i: number) => page.locator(`[data-drone="DRONE-0${i}"]`);
  const event = (serial: string) => page.locator(`[data-event-id="example:${serial}"]`);
  let serial = 0;
  const send = (topic: string, body: object, options: { id?: string; offset?: number; incident?: string } = {}) =>
    page.evaluate(({ topic, body, id, offset, incident }) => window.fieldExample.publish({
      topic, body, serial: id, sampled: Date.now() + offset, incident,
    }), { topic, body, id: options.id ?? `packet-${++serial}`, offset: options.offset ?? 0, incident: options.incident ?? caseId });
  const accept = async (...args: Parameters<typeof send>) => expect(await send(...args)).toEqual({ accepted: true });
  const dispatch = (phase: string, summary: string, options: { id?: string; incident?: string; offset?: number } = {}, details: object = {}) =>
    accept('dispatch', { agent: 'dispatch', type: phase, phase, summary, ...details }, options);
  const panel = page.getByTestId('emergency-phase');
  const fix = (deviceId: string, kind: string, east: number, north: number, details: object = {}) =>
    ({ deviceId, kind, east, north, yaw: 90, ...details });

  await accept('source', { sourceId: '现场网关', state: 'online' });
  await expect(page.getByText('现场网关 · 在线')).toBeVisible();
  await dispatch('侦查任务已下发', '对两个候选点采集图像', { id: 'scout-order' }, { taskId: 'scout-1', deviceId: 'aircraft-1' });
  await expect(panel).toHaveText('侦查任务已下发');
  await expect(event('scout-order')).toHaveAttribute('data-incident-id', caseId);
  await expect(event('scout-order')).toHaveAttribute('data-task-id', 'scout-1');
  await expect(event('scout-order')).toHaveAttribute('data-device-id', 'DRONE-01');
  for (const i of drones) {
    const deviceId = `aircraft-${i}`, taskId = `scout-${i}`;
    await accept('link', { deviceId, state: 'online' });
    await expect(drone(i)).toHaveAttribute('data-connection', 'online');
    await expect(drone(i)).toHaveAttribute('data-location', 'virtual');
    await expect(drone(i)).toHaveAttribute('data-status', 'idle');
    await accept('task', { deviceId, taskId, phase: '已接单', status: 'dispatched' });
    await expect(drone(i)).toHaveAttribute('data-status', 'dispatched');
    await expect(drone(i)).toHaveAttribute('data-location', 'virtual');
    await accept('task', { deviceId, taskId, phase: '已起飞', status: 'flying' });
    await expect(drone(i)).toHaveAttribute('data-status', 'flying');
    await accept('fix', fix(deviceId, 'drone', i, 2, { taskId, altitudeMeters: 1.2 + i }));
    await expect(drone(i)).toHaveAttribute('data-x', String(30 + 6 * i));
    await expect(drone(i)).toHaveAttribute('data-altitude-meters', String(1.2 + i));
    await accept('plan', { deviceId, taskId, coordinateSystem: 'CITY90x75', purpose: 'reconnaissance',
      route: [{ x: 36 + i, y: 38 }, { x: 42 + i, y: 44 }] });
    await expect(drone(i)).toHaveAttribute('data-x', String(30 + 6 * i));
    await accept('fix', fix(deviceId, 'drone', i + .5, 3, { taskId, status: 'observing' }));
    await expect(drone(i)).toHaveAttribute('data-x', String(33 + 6 * i));
    await expect(drone(i)).toHaveAttribute('data-y', '43.75');
    await expect(drone(i)).toHaveAttribute('data-status', 'observing');
    const path = page.locator(`[data-drone-path="DRONE-0${i}"]`);
    await expect(path).toHaveAttribute('points', /^\S+ \S+$/);
    await expect(page.locator(`[data-drone-track="DRONE-0${i}"]`)).toHaveAttribute('points', '');
    const candidatePoiId = `T-NW-0${i}`;
    await accept('candidate', { deviceId, taskId, candidatePoiId, rank: i, stage: 'observed', result: `热成像 ${i}` });
    await expect(page.locator(`[data-recon-candidate="${candidatePoiId}"]`)).toHaveAttribute('data-recon-stage', 'observed');
    await expect(path).not.toHaveAttribute('points', '');
    await accept('task', { deviceId, taskId, phase: '侦查结果已回传', result: `热成像 ${i}` }, { id: `scout-report-${i}` });
    await expect(event(`scout-report-${i}`)).toContainText(`热成像 ${i}`);
    await accept('task', { deviceId, taskId, phase: '返航中', status: 'returning' });
    await expect(drone(i)).toHaveAttribute('data-status', 'returning');
    await accept('plan', { deviceId, taskId, coordinateSystem: 'CITY90x75', purpose: 'return',
      route: [{ x: 42 + i, y: 44 }, { x: 35, y: 31 }] });
    await expect(path).toHaveAttribute('points', '');
  }
  await dispatch('侦查反馈已返回', '收到两架无人机反馈', {}, { taskId: 'scout-1', deviceId: 'aircraft-1' });
  await expect(panel).toHaveText('侦查反馈已返回');
  await dispatch('侦查目标已确认', '收到储罐编号，等待火情上报', {}, { targetPoiId: 'T-NW-01' });
  await expect(page.getByText('等待火情状态', { exact: true })).toBeVisible();
  await expect(page.getByTestId('fire-marker')).toHaveCount(0);
  await accept('confirmation', { confirmedFirePoiId: 'T-NW-01', result: '热成像确认储罐起火' });
  await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'burning');
  await dispatch('消防车调度已下发', '四车分路前往 1 号罐', {}, { targetPoiId: 'T-NW-01', fireStatus: 'burning' });
  await expect(panel).toHaveText('消防车调度已下发');
  await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'burning');
  for (const i of trucks) {
    const deviceId = `rig-${i}`, taskId = `dispatch-${i}`;
    await accept('link', { deviceId, state: 'online' });
    await expect(truck(i)).toHaveAttribute('data-location', 'virtual');
    await expect(truck(i)).toHaveAttribute('data-status', 'idle');
    await accept('fix', fix(deviceId, 'fireTruck', i, 1));
    await expect(truck(i)).toHaveAttribute('data-x', (30 + 6 * i).toFixed(4));
    await expect(truck(i)).toHaveAttribute('data-y', '31.2500');
    await expect(truck(i)).toHaveAttribute('data-heading', String(Math.PI / 2));
    await accept('plan', { deviceId, taskId, coordinateSystem: 'CITY90x75', route: [{ x: 30 + 6 * i, y: 32 }, { x: 30 + 6 * i, y: 40.625 }] },
      { id: `plan-${i}` });
    await expect(truck(i)).toHaveAttribute('data-status', 'idle');
    await accept('task', { deviceId, taskId, phase: '车辆接受调度', status: 'en-route' }, { id: `accept-${i}`, offset: -2_000 });
    await expect(truck(i)).toHaveAttribute('data-status', 'en-route');
    await expect(event(`accept-${i}`)).toHaveAttribute('data-task-id', taskId);
    await expect(event(`plan-${i}`)).toHaveAttribute('data-device-id', `EXT-FIRE-VEHICLE-0${i}`);
  }
  for (const north of [1.5, 2, 2.5]) {
    for (const i of trucks) {
      await accept('fix', fix(`rig-${i}`, 'fireTruck', i, north, { taskId: `dispatch-${i}` }));
      await expect(truck(i)).toHaveAttribute('data-x', (30 + 6 * i).toFixed(4));
      await expect(truck(i)).toHaveAttribute('data-y', (25 + 6.25 * north).toFixed(4));
    }
  }
  const paths = await page.locator('[data-truck-path]').evaluateAll(nodes => nodes.map(node => node.getAttribute('points')));
  const tracks = await page.locator('[data-truck-track]').evaluateAll(nodes => nodes.map(node => node.getAttribute('points')));
  expect(new Set(paths).size).toBe(4);
  expect(paths.every(line => line?.split(' ').length === 2)).toBe(true);
  expect(tracks).toEqual(['', '', '', '']);
  await expect(page.locator('[data-fire-truck][data-status=en-route]')).toHaveCount(4);
  await expect(panel).toHaveText('消防车调度已下发');

  const phases = [['arrived', '抵达火场'], ['extinguishing', '开始灭火'], ['returning', '车辆返回'], ['idle', '返回待命']];
  for (const [status, phase] of phases) {
    if (status === 'returning') {
      await dispatch('灭火完成', '现场确认火势已扑灭', { id: 'extinguished' }, { fireStatus: 'extinguished' });
      await expect(panel).toHaveText('灭火完成');
      await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguished');
      await expect(page.locator('[data-water-for][visibility=visible]')).toHaveCount(0);
    }
    for (const i of trucks) {
      await accept('task', { deviceId: `rig-${i}`, taskId: `dispatch-${i}`, phase, status }, { id: `${status}-${i}` });
      await expect(truck(i)).toHaveAttribute('data-status', status);
      await expect(event(`${status}-${i}`)).toContainText(phase);
    }
    if (status === 'arrived') {
      await expect(page.locator('[data-water-for][visibility=visible]')).toHaveCount(0);
      await expect(page.locator('[data-truck-path][points=""]')).toHaveCount(4);
      await accept('plan', { deviceId: 'rig-1', taskId: 'dispatch-1', coordinateSystem: 'CITY90x75',
        route: [{ x: 35, y: 31 }, { x: 40, y: 40 }] });
      await expect(page.locator('[data-truck-path][points=""]')).toHaveCount(4);
    }
    if (status === 'extinguishing') {
      await expect(page.locator('[data-water-for][visibility=visible]')).toHaveCount(4);
      await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'extinguishing');
      await dispatch('灭火中', '四车已开始处置', {}, { fireStatus: 'extinguishing' });
      await page.clock.fastForward(8_500);
      await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'extinguishing');
    }
    if (status === 'returning') {
      await accept('plan', { deviceId: 'rig-1', taskId: 'dispatch-1', purpose: 'return', coordinateSystem: 'CITY90x75',
        route: [{ x: 36, y: 40.625 }, { x: 36, y: 35 }] });
      await accept('fix', fix('rig-1', 'fireTruck', 1, 2.2, { taskId: 'dispatch-1' }));
      await expect(truck(1)).toHaveAttribute('data-y', '38.7500');
      await expect(page.locator('[data-truck-path][points=""], [data-truck-track][points=""]')).toHaveCount(8);
    }
  }
  await expect(panel).toHaveText('灭火完成');
  const completed = { agent: 'dispatch', type: '处置结果', phase: '任务结束', summary: '现场确认处置结束' };
  await accept('dispatch', completed, { id: 'completed' });
  expect(await send('dispatch', completed, { id: 'completed' })).toEqual({ accepted: true, duplicate: true });
  await expect(panel).toHaveText('任务结束');
  await expect(event('completed')).toHaveCount(1);
  await dispatch('历史反馈', '延迟送达的侦查反馈', { id: 'late-agent', offset: -3_000 });
  await expect(event('late-agent')).toContainText('延迟送达的侦查反馈');
  await expect(panel).toHaveText('任务结束');

  const badFixes = [
    [fix('unknown', 'fireTruck', 1, 1), 0, /未知设备/],
    [fix('rig-1', 'fireTruck', 6, 1), 0, /越界/],
    [fix('rig-1', 'fireTruck', 1, 1, { calibration: 'obsolete' }), 0, /标定/],
    [fix('rig-1', 'fireTruck', 1, 1), -15_000, /逆序/],
  ] as const;
  for (const [body, offset, error] of badFixes) {
    expect(await send('fix', body, { offset })).toMatchObject({ accepted: false });
    await expect(page.getByTestId('dashboard-input-error')).toHaveText(error);
    await expect(truck(1)).toHaveAttribute('data-y', '38.7500');
  }
  expect(await page.evaluate(() => window.fieldExample.publish({ invalid: true }))).toMatchObject({ accepted: false });
  await expect(page.getByTestId('dashboard-input-error')).toHaveText(/示例传输消息格式无效/);
  await accept('link', { deviceId: 'aircraft-2', state: 'disconnected' });
  await expect(page.getByTestId('dashboard-input-error')).toHaveCount(0);
  await expect(drone(2)).toHaveAttribute('data-connection', 'disconnected');
  await expect(drone(2)).toHaveAttribute('data-status', 'returning');
  await dispatch('任务失败', '二次侦查通信中断', { id: 'failed', incident: 'field-incident-2' });
  await expect(panel).toHaveText('任务失败');
  await expect(event('failed')).toHaveAttribute('data-incident-id', 'field-incident-2');
  await page.clock.fastForward(11_000);
  await expect(truck(1)).toHaveAttribute('data-location', 'stale');
  await expect(truck(1)).toHaveAttribute('data-y', '38.7500');
  await expect(drone(2)).toHaveAttribute('data-location', 'stale');
  await accept('source', { sourceId: '现场网关', state: 'disconnected' });
  await expect(page.getByText('现场网关 · 已断联')).toBeVisible();

  await page.getByLabel('数据来源').selectOption('mock');
  await expect(page.getByTestId('dashboard-source')).toHaveAttribute('data-source-mode', 'simulation');
  expect(await send('link', { deviceId: 'rig-4', state: 'online' })).toMatchObject({ accepted: false });
  await expect(event('failed')).toHaveCount(0);
  await page.getByLabel('数据来源').selectOption('physical');
  await expect(page.locator('[data-fire-truck][data-location=virtual]')).toHaveCount(4);
  await expect(panel).toHaveText('等待任务');
});

test('external Top3 reconnaissance leads to a separate drone monitoring mission in physical mode', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('dashboard-source')).toHaveAttribute('data-source-mode', 'physical');
  const points = await page.evaluate(async () => {
    const source = '/src/services/dashboardSourceExample.ts';
    const registry = '/src/utils/poiRegistry.ts';
    const { connectExampleDashboardSource } = await import(source);
    const { poiRegistry } = await import(registry);
    window.fieldExample = connectExampleDashboardSource();
    return ['T-NW-02', 'T-NW-01', 'T-NE-01'].map(id => {
      const [x, y] = poiRegistry.get(id).center;
      return { id, x: x + 30, y: y + 25 };
    }) as { id: string; x: number; y: number }[];
  });
  const incident = 'field-recon-monitor';
  const drone = (i: number) => page.locator(`[data-drone="DRONE-0${i}"]`);
  const path = (i: number) => page.locator(`[data-drone-path="DRONE-0${i}"]`);
  const timeline = page.getByRole('region', { name: '事件时间线' });
  const log = (id: string) => timeline.locator(`[data-event-id="example:${id}"]`);
  const send = async (topic: string, id: string, body: object) => {
    const result = await page.evaluate(({ topic, serial, incident, body }) => window.fieldExample.publish({
      topic, serial, sampled: Date.now(), incident, body,
    }), { topic, serial: id, incident, body });
    expect(result, id).toEqual({ accepted: true });
  };
  const checkLog = async (id: string, type: string, i: number, taskId: string, source: string) => {
    await expect(log(id)).toHaveCount(1);
    await expect(log(id)).toHaveAttribute('data-event-type', type);
    await expect(log(id)).toHaveAttribute('data-incident-id', incident);
    await expect(log(id)).toHaveAttribute('data-task-id', taskId);
    await expect(log(id)).toHaveAttribute('data-device-id', `DRONE-0${i}`);
    await expect(log(id).locator('strong')).toHaveText(source);
  };
  const fix = (id: string, i: number, taskId: string, point: { x: number; y: number }, status: string) =>
    send('fix', id, { deviceId: `aircraft-${i}`, taskId, kind: 'drone', east: (point.x - 30) / 6,
      north: (point.y - 25) / 6.25, yaw: 90, altitudeMeters: 1.5, status });
  const at = async (i: number, point: { x: number; y: number }) => {
    await expect.poll(async () => Number(await drone(i).getAttribute('data-x'))).toBeCloseTo(point.x, 6);
    await expect.poll(async () => Number(await drone(i).getAttribute('data-y'))).toBeCloseTo(point.y, 6);
  };

  for (const i of [1, 2]) {
    const deviceId = `aircraft-${i}`;
    const taskId = `recon-${i}`;
    await send('task', taskId, { deviceId, taskId, phase: '接收侦查任务', status: 'dispatched' });
    await checkLog(taskId, 'device.task', i, taskId, `DRONE-0${i}`);
  }
  for (const [index, point] of points.entries()) {
    const rank = index + 1;
    const i = rank === 2 ? 2 : 1;
    const taskId = `recon-${i}`;
    const candidate = { deviceId: `aircraft-${i}`, taskId, candidatePoiId: point.id, rank };
    await send('candidate', `assigned-${rank}`, { ...candidate, stage: 'assigned' });
    const row = page.locator(`[data-recon-candidate="${point.id}"]`);
    await expect(row).toHaveAttribute('data-recon-stage', 'assigned');
    await checkLog(`assigned-${rank}`, 'recon.candidate', i, taskId, `DRONE-0${i}`);
    await fix(`recon-fix-${rank}`, i, taskId, point, rank === 3 ? 'observing' : 'flying');
    await at(i, point);
    await checkLog(`recon-fix-${rank}`, 'device.telemetry', i, taskId, `DRONE-0${i}`);
    const result = rank === 2 ? '热成像发现火点' : '未发现火点';
    await send('candidate', `report-${rank}`, { ...candidate, stage: 'observed', result });
    await expect(row).toHaveAttribute('data-recon-stage', 'observed');
    await expect(row).toHaveAttribute('data-device-id', `DRONE-0${i}`);
    await expect(row).toContainText(result);
    await checkLog(`report-${rank}`, 'recon.candidate', i, taskId, `DRONE-0${i}`);
  }

  const fire = points[1];
  const fireMarker = page.getByTestId('fire-marker');
  await expect(fireMarker.and(page.locator('[data-status="burning"]'))).toHaveCount(0);
  await send('confirmation', 'confirmed', { deviceId: 'aircraft-2', taskId: 'recon-2',
    confirmedFirePoiId: fire.id, result: '确认 1 号储罐起火' });
  await expect(fireMarker).toHaveAttribute('data-poi-id', fire.id);
  await expect(fireMarker).toHaveAttribute('data-status', 'burning');
  await checkLog('confirmed', 'recon.confirmed', 2, 'recon-2', '调度');
  const start = points[2];
  await at(1, start);
  await expect(path(1)).toHaveAttribute('points', '');

  const taskId = 'monitor-fire';
  const mission = { deviceId: 'aircraft-1', taskId };
  await send('dispatch', 'monitor-order', { ...mission, agent: 'dispatch', type: '火场监控',
    phase: '火场监控已下发', summary: '派无人机 1 号监控已确认火点', targetPoiId: fire.id });
  await expect(page.getByTestId('emergency-phase')).toHaveText('火场监控已下发');
  await checkLog('monitor-order', 'agent.event', 1, taskId, '调度');
  await expect(drone(1)).toHaveAttribute('data-status', 'observing');
  await expect(path(1)).toHaveAttribute('points', '');
  await at(1, start);

  await send('task', 'monitor-accepted', { ...mission, phase: '接收火场监控任务', status: 'dispatched' });
  await checkLog('monitor-accepted', 'device.task', 1, taskId, 'DRONE-01');
  await send('plan', 'monitor-route', { ...mission, coordinateSystem: 'CITY90x75', purpose: 'outbound', route: [start, fire] });
  await checkLog('monitor-route', 'device.route', 1, taskId, 'DRONE-01');
  await expect(path(1)).toHaveAttribute('points', /^\S+ \S+$/);
  await at(1, start);
  const midpoint = { x: (start.x + fire.x) / 2, y: (start.y + fire.y) / 2 };
  await fix('monitor-moving', 1, taskId, midpoint, 'flying');
  await at(1, midpoint);
  await checkLog('monitor-moving', 'device.telemetry', 1, taskId, 'DRONE-01');
  await expect(path(1)).toHaveAttribute('points', /^\S+ \S+$/);
  await fix('monitor-arrived', 1, taskId, fire, 'observing');
  await at(1, fire);
  await expect(drone(1)).toHaveAttribute('data-status', 'observing');
  await expect(path(1)).toHaveAttribute('points', '');
  await checkLog('monitor-arrived', 'device.telemetry', 1, taskId, 'DRONE-01');

  await send('task', 'return-order', { ...mission, phase: '结束监控，准备返航' });
  await checkLog('return-order', 'device.task', 1, taskId, 'DRONE-01');
  await send('plan', 'return-route', { ...mission, coordinateSystem: 'CITY90x75', purpose: 'return', route: [fire, start] });
  await checkLog('return-route', 'device.route', 1, taskId, 'DRONE-01');
  await expect(path(1)).toHaveAttribute('points', '');
  await fix('return-moving', 1, taskId, midpoint, 'returning');
  await at(1, midpoint);
  await expect(drone(1)).toHaveAttribute('data-status', 'returning');
  await checkLog('return-moving', 'device.telemetry', 1, taskId, 'DRONE-01');
  await expect(path(1)).toHaveAttribute('points', '');
  await expect(page.locator('[data-drone-track][points=""]')).toHaveCount(2);
  await at(2, fire);
  await expect(page.getByTestId('emergency-phase')).toHaveText('火场监控已下发');
  await expect(timeline.locator('[data-incident-id="field-recon-monitor"]')).toHaveCount(20);
});
