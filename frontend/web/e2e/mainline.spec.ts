import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { InputResult } from '../src/services/dashboardInput';
import type { TrafficSimulation } from '../src/utils/trafficSimulation';

declare global {
  interface Window {
    mainlineTraffic: TrafficSimulation;
    hardwareReceiver: (message: unknown) => InputResult;
    mainlineDetached: boolean;
    testMediaStream: MediaStream;
    testMediaSources: MediaStream[];
    testMediaUrls: string[];
    sceneBackgrounds: Record<string, number[]>;
  }
}

const frames = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/mainline` : fileURLToPath(new URL('../screenshots/mainline/', import.meta.url));
const truckIds = [1, 2, 3, 4].map(index => `EXT-FIRE-VEHICLE-0${index}`);
const viewports = [{ width: 1920, height: 1080 }, { width: 1600, height: 900 }, { width: 1366, height: 768 }];

async function openMock(page: Page) {
  await page.setViewportSize(viewports[2]);
  await page.route('**/src/components/VehicleLayer.tsx*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const observed = source.replace(/const sim\s*=\s*simulation;/, '$& window.mainlineTraffic = simulation;');
    expect(observed).not.toBe(source);
    await route.fulfill({ response, body: observed });
  });
  await page.route('**/src/components/FireScene3D.tsx*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const observed = source.replace('renderer.render(scene, camera);', `$&
      const samples = window.sceneBackgrounds ??= {};
      const status = latest.current.status;
      if (current && !samples[status]) {
        const gl = renderer.getContext(), rgba = new Uint8Array(4);
        gl.readPixels(0, gl.drawingBufferHeight - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        samples[status] = Array.from(rgba);
      }`);
    expect(observed).not.toBe(source);
    await route.fulfill({ response, body: observed });
  });
  await page.goto('/?workspace=mock');
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-texture', 'ready');
  await mkdir(frames, { recursive: true });
}

async function advance(page: Page, seconds: number) {
  await page.evaluate(async seconds => {
    for (let elapsed = 0; elapsed < seconds; elapsed += .25) {
      window.mainlineTraffic.tick(.25);
      await Promise.resolve();
    }
  }, seconds);
}

test('default workbench fits all three screen sizes, physical devices start waiting and the station is identifiable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.control-column > section')).toHaveCount(4);
  await expect(page.locator('[data-fire-truck][data-location=virtual]')).toHaveCount(4);
  await expect(page.locator('[data-drone][data-location=virtual]')).toHaveCount(2);
  await expect(page.locator('[data-drone-station=EXT-P-DRONE]')).toHaveCount(1);
  await expect(page.locator('[data-media-status=idle]')).toHaveCount(8);
  await expect(page.getByTestId('sandbox-svg')).toHaveAttribute('viewBox', '0 0 3939 3150');
  await expect(page.getByText('等待调度连接')).toBeVisible();
  await expect(page.getByText('等待算法定位')).toBeVisible();
  await expect(page.getByText('等待本轮事件')).toBeVisible();
  const colors = await page.evaluate(() => ({ page: getComputedStyle(document.body).backgroundColor,
    panel: getComputedStyle(document.querySelector('.media-card')!).backgroundColor,
    title: getComputedStyle(document.querySelector('.card-heading h2')!).color,
    action: getComputedStyle(document.documentElement).getPropertyValue('--gis-action').trim() }));
  expect(colors).toEqual({ page: 'rgb(235, 237, 239)', panel: 'rgb(253, 253, 253)', title: 'rgb(36, 41, 46)', action: '#345d83' });
  await expect(page.locator('body')).not.toContainText(/开发测试|仅供验收|Mock/);
  await mkdir(frames, { recursive: true });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const panelBounds = await page.locator('.media-column > section, .control-column > section, .map-column > section')
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    expect(panelBounds).toHaveLength(8);
    for (const bounds of panelBounds) {
      expect(bounds.height).toBeGreaterThan(100);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(viewport.width + .1);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.height + .1);
    }
    expect(await page.evaluate(() => ({
      x: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
      y: document.documentElement.scrollHeight <= innerHeight && document.body.scrollHeight <= innerHeight,
    }))).toEqual({ x: true, y: true });
    expect(panelBounds[2].right).toBeLessThan(panelBounds[3].left);
    expect(panelBounds[3].right).toBeLessThan(panelBounds[4].left);
    const sceneFits = await page.locator('.fire-scene-frame').evaluate(frame => {
      const area = frame.getBoundingClientRect(), card = frame.closest('section')!.getBoundingClientRect();
      return area.height > 100 && area.bottom <= card.bottom && area.right <= card.right;
    });
    expect(sceneFits).toBe(true);
    await page.screenshot({ path: `${frames}/workbench-${viewport.width}x${viewport.height}.png` });
  }
  await page.getByRole('button', { name: '仿真设置' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭仿真设置' }).click();
  const svg = page.getByTestId('sandbox-svg');
  await page.getByRole('button', { name: '放大地图' }).click();
  const before = await svg.getAttribute('viewBox');
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * .32, box.y + box.height * .75);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .40, box.y + box.height * .79, { steps: 5 }); await page.mouse.up();
  await expect(svg).not.toHaveAttribute('viewBox', before!);
});

test('four Mock trucks dispatch, move concurrently, spray and return to their own front-end bays', async ({ page }) => {
  test.setTimeout(90_000);
  await openMock(page);
  const scene = page.getByRole('region', { name: '三维火场展示' });
  const colors = await scene.evaluate(element => Object.fromEntries([
    '.fire-scene-toolbar', '.fire-scene-view-controls button[aria-pressed="true"]', '.fire-scene-reset', '.fire-status', '.fire-scene-viewport',
  ].map(selector => [selector, getComputedStyle(element.querySelector(selector)!).backgroundColor])));
  expect(colors).toEqual({ '.fire-scene-toolbar': 'rgb(253, 253, 253)', '.fire-scene-view-controls button[aria-pressed="true"]': 'rgb(227, 235, 242)',
    '.fire-scene-reset': 'rgb(253, 253, 253)', '.fire-status': 'rgb(253, 253, 253)', '.fire-scene-viewport': 'rgb(241, 243, 245)' });
  await expect.poll(() => page.evaluate(() => window.sceneBackgrounds?.normal)).toEqual([241, 243, 245, 255]);
  await scene.screenshot({ path: `${frames}/scene-3d-normal.png` });
  const trucks = page.locator('[data-fire-truck]');
  await expect(trucks).toHaveCount(4);
  expect(await trucks.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-actor')))).toEqual(truckIds);
  const bays = await page.locator('[data-fire-bay]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-x'), node.getAttribute('data-y')]));
  const start = await trucks.evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-x'), node.getAttribute('data-y')].map(Number)));
  expect(start).toEqual(bays.map(bay => bay.map(Number)));
  expect(await page.locator('[data-feed-slot^=ground]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-device')))).toEqual(truckIds);
  await page.getByRole('button', { name: '查看消防站' }).click();
  await page.screenshot({ path: `${frames}/mock-four-bays.png` });
  await page.getByRole('button', { name: '全图', exact: true }).click();
  await page.getByRole('button', { name: '开始演练' }).click();
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'burning');
  await expect.poll(() => page.evaluate(() => window.sceneBackgrounds?.burning)).toEqual([241, 243, 245, 255]);
  await scene.screenshot({ path: `${frames}/scene-3d-burning.png` });
  await page.screenshot({ path: `${frames}/drill-fire.png` });
  await advance(page, 3);
  await expect(page.getByTestId('top1-name')).toContainText('2号');
  await expect(page.locator('.candidate-row')).toHaveCount(3);
  expect(await page.locator('.candidate-row').last().evaluate(row =>
    row.getBoundingClientRect().bottom <= row.closest('.result-content')!.getBoundingClientRect().bottom)).toBe(true);
  await expect.poll(() => page.locator('.opinion-entry-current .opinion-post-text').evaluate(text => {
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    const top = text.getBoundingClientRect().top;
    return text.closest('.opinion-viewport')!.getBoundingClientRect().bottom - top >= lineHeight && text.clientHeight >= lineHeight;
  })).toBe(true);
  await page.screenshot({ path: `${frames}/drill-top3.png`, animations: 'disabled' });
  await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'burning');
  await advance(page, 4);
  await expect(page.getByTestId('top1-name')).toContainText('2号');
  await expect(page.getByTestId('prediction-marker')).toHaveAttribute('data-poi-id', 'T-NW-02');
  await expect(page.locator('[data-recon-stage=assigned]')).toHaveCount(3);
  await expect(page.locator('[data-drone][data-status=flying]')).toHaveCount(1);
  await expect(page.locator('[data-drone-path]:not([points=""])')).toHaveCount(2);
  await page.screenshot({ path: `${frames}/recon-patrol.png` });
  const reports = page.locator('[data-recon-stage=observed]');
  for (let i = 0; i < 100 && await reports.count() < 3; i++) await advance(page, .5);
  await expect(reports).toHaveCount(3);
  await expect(page.locator('[data-recon-candidate=T-NW-02]')).toContainText('未发现火点');
  await expect(page.locator('[data-recon-candidate=T-NW-01]')).toContainText('发现火点');
  await expect(page.locator('[data-recon-candidate=T-NW-01]')).toHaveAttribute('data-device-id', 'DRONE-02');
  await expect(page.locator('[data-recon-candidate=T-NE-01]')).toHaveAttribute('data-device-id', 'DRONE-01');
  expect(await reports.last().evaluate(row => row.getBoundingClientRect().bottom <= row.closest('.emergency-content')!.getBoundingClientRect().bottom)).toBe(true);
  await page.screenshot({ path: `${frames}/recon-three-reports.png` });
  const hovering = page.locator('[data-drone][data-status=observing]');
  for (let i = 0; i < 100 && await hovering.count() < 2; i++) await advance(page, .5);
  await expect(hovering).toHaveCount(2);
  const centers = await page.evaluate(async () => {
    const registry = '/src/utils/poiRegistry.ts';
    const { poiRegistry } = await import(registry);
    return poiRegistry.get('T-NW-01').center;
  });
  const watcher = page.locator('[data-drone=DRONE-01]');
  expect(Number(await watcher.getAttribute('data-x'))).toBeCloseTo(centers[0] + 30, 6);
  expect(Number(await watcher.getAttribute('data-y'))).toBeCloseTo(centers[1] + 25, 6);
  await expect(page.locator('[data-drone-path]:not([points=""])')).toHaveCount(0);
  await page.screenshot({ path: `${frames}/recon-confirmed-hover.png` });
  const motion = await page.evaluate(async () => {
    const traffic = window.mainlineTraffic;
    let overlapping = false;
    const movers = new Set<string>();
    for (let i = 0; i < 1000 && !overlapping; i++) {
      const before = traffic.trucks.map(truck => truck.pose.point);
      traffic.tick(.1);
      await Promise.resolve();
      const moved = traffic.trucks.filter((truck, i) => truck.status === 'en-route' &&
        Math.hypot(truck.pose.point[0] - before[i][0], truck.pose.point[1] - before[i][1]) > .0001);
      moved.forEach(truck => movers.add(truck.id));
      overlapping = moved.length === 4;
    }
    return { overlapping, movers: [...movers].sort() };
  });
  expect(motion).toEqual({ overlapping: true, movers: truckIds });
  await advance(page, .2);
  await expect(trucks).toHaveCount(4);
  await expect(page.getByTestId('emergency-plan')).toContainText('4 辆消防车');
  const lines = await page.locator('[data-truck-path]').evaluateAll(nodes => nodes.map(node => node.getAttribute('points') ?? ''));
  expect(new Set(lines).size).toBe(4);
  expect(lines.every(line => line.split(' ').length > 1)).toBe(true);
  await expect(page.locator('[data-truck-track][points=""]')).toHaveCount(4);
  await page.screenshot({ path: `${frames}/mock-four-dispatched.png` });
  const outbound = await page.evaluate(async () => {
    const traffic = window.mainlineTraffic, onRoad = new Set<string>();
    for (let i = 0; i < 500 && onRoad.size < 4; i++) {
      traffic.tick(.1);
      await Promise.resolve();
      traffic.trucks.filter(truck => truck.cursor.piece.road && truck.status === 'en-route').forEach(truck => onRoad.add(truck.id));
    }
    return [...onRoad].sort();
  });
  expect(outbound).toEqual(truckIds);
  await page.screenshot({ path: `${frames}/mock-four-on-roads.png` });
  const sprays = page.locator('[data-water-for][visibility=visible]');
  for (let i = 0; i < 180 && await sprays.count() < 4; i++) await advance(page, .5);
  await expect(sprays).toHaveCount(4);
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguishing');
  await expect(page.locator('[data-truck-path]:not([points=""])')).toHaveCount(0);
  await page.screenshot({ path: `${frames}/mock-suppressing-2d-3d.png` });
  await page.getByRole('button', { name: '重置地图视图', exact: true }).click();
  await page.screenshot({ path: `${frames}/mock-suppressing-map-closeup.png` });
  await page.getByRole('button', { name: '全图', exact: true }).click();
  await scene.screenshot({ path: `${frames}/mock-suppressing-3d.png` });
  await advance(page, 4);
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguishing');
  await advance(page, 6);
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguished');
  await expect(sprays).toHaveCount(0);
  await page.screenshot({ path: `${frames}/mock-extinguished.png` });
  await expect(page.locator('[data-drone][data-status=returning]')).toHaveCount(2);
  const beforeReturn = await watcher.getAttribute('data-x');
  await advance(page, 1);
  await expect(watcher).not.toHaveAttribute('data-x', beforeReturn!);
  await expect(page.locator('[data-drone-path]:not([points=""]), [data-truck-path]:not([points=""])')).toHaveCount(0);
  await page.screenshot({ path: `${frames}/mock-return-no-lines.png` });
  await advance(page, 600);
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'completed');
  await expect(page.locator('[data-drone][data-status=charging]')).toHaveCount(2);
  expect(await trucks.evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-x'), node.getAttribute('data-y')].map(Number)))).toEqual(start);
  for (const agent of ['舆情监测', '火情定位', '调度']) await expect(page.getByRole('region', { name: '事件时间线' }).getByText(agent, { exact: true }).first()).toBeAttached();
  await page.screenshot({ path: `${frames}/mock-completed.png` });
});

test('the real input seam maps calibrated positions and tasks and isolates media, traffic snapshots and subscriptions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始仿真' })).toBeEnabled();
  await expect(page.locator('[data-fire-truck][data-location=virtual]')).toHaveCount(4);
  const result = await page.evaluate(async () => {
    const inputPath = '/src/services/dashboardInput.ts', coordsPath = '/src/utils/deviceCoordinates.ts';
    const api = await import(inputPath), coords = await import(coordsPath);
    api.connectDashboardSource((receive: Window['hardwareReceiver']) => {
      window.hardwareReceiver = receive;
      return () => {
        window.mainlineDetached = true;
        window.testMediaStream?.getTracks().forEach(track => track.stop());
        window.testMediaSources?.forEach(stream => stream.getTracks().forEach(track => track.stop()));
        window.testMediaUrls?.forEach(url => URL.revokeObjectURL(url));
      };
    }, (raw: unknown) => raw, { calibrations: [coords.tabletopCalibration], idMap: { 'robot-04': 'EXT-FIRE-VEHICLE-04' } });
    const now = Date.now();
    const send = (eventType: string, payload: unknown, sequence: number) => window.hardwareReceiver({
      eventType, payload, sourceMode: 'physical', eventId: `physical-${sequence}`, occurredAt: now, incidentId: 'field-a',
    });
    const messages = [
      send('device.connection', { deviceId: 'DRONE-01', state: 'online' }, 1),
      send('device.telemetry', { deviceId: 'robot-04', kind: 'fireTruck', position: { x: 2.5, y: 2 },
        coordinateSystem: 'PHYSICAL_SW_METERS', calibrationVersion: 'axis-aligned-v1', headingRadians: 1.5, accuracyMeters: .04 }, 2),
      send('device.route', { deviceId: 'robot-04', taskId: 'field-task', coordinateSystem: 'LOCAL30x25',
        route: [{ x: 15, y: 12.5 }, { x: 19, y: 12.5 }] }, 3),
      send('device.task', { deviceId: 'robot-04', taskId: 'field-task', phase: '行驶确认', result: '现场接单' }, 4),
      send('agent.event', { agent: 'dispatch', phase: '侦察反馈已收到', type: '反馈', summary: '无人机报告已核实' }, 5),
    ];
    messages.push(send('agent.event', { agent: 'dispatch', phase: '侦察反馈已收到', type: '反馈', summary: '无人机报告已核实' }, 5));
    const svg = document.querySelector('svg[data-testid=sandbox-svg]') as SVGSVGElement;
    const matrix = svg.getScreenCTM()!;
    const center = coords.cityToScreen({ x: 45, y: 37.5 }, matrix);
    const roundTrip = coords.screenToCity(center, matrix);
    return { messages, roundTrip };
  });
  expect(result.messages.every(message => message.accepted)).toBe(true);
  expect(result.messages.at(-1)).toEqual({ accepted: true, duplicate: true });
  expect(result.roundTrip.x).toBeCloseTo(45, 7);
  expect(result.roundTrip.y).toBeCloseTo(37.5, 7);
  const fourth = page.locator('[data-fire-truck="4"]');
  await expect(fourth).toHaveAttribute('data-x', '45.0000');
  await expect(fourth).toHaveAttribute('data-y', '37.5000');
  await expect(fourth).toHaveAttribute('data-heading', '1.5');
  await expect(page.locator('[data-drone=DRONE-01]')).toHaveAttribute('data-status', 'idle');
  await expect(page.locator('[data-drone=DRONE-01]')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('[data-truck-track$="04"]')).toHaveAttribute('points', '');
  await expect(page.locator('[data-truck-path$="04"]')).toHaveAttribute('points', /1969.5,1575 /);
  await expect(page.locator('[data-event-id=physical-5]')).toHaveCount(1);
  await expect(page.locator('[data-device-card$="04"]')).toContainText('现场接单');
  await page.getByRole('button', { name: '放大地图' }).click();
  const aligned = await page.evaluate(async () => {
    const path = '/src/utils/deviceCoordinates.ts';
    const { cityToScreen, screenToCity } = await import(path);
    const svg = document.querySelector('svg[data-testid=sandbox-svg]') as SVGSVGElement;
    const vehicle = svg.querySelector('[data-fire-truck="4"]') as SVGGElement;
    const matrix = svg.getScreenCTM()!;
    const mapped = cityToScreen({ x: 45, y: 37.5 }, matrix);
    const actual = new DOMPoint().matrixTransform(vehicle.getScreenCTM()!);
    return { diff: Math.hypot(actual.x - mapped.x, actual.y - mapped.y), city: screenToCity(actual, matrix) };
  });
  expect(aligned.diff).toBeLessThan(.001);
  expect(aligned.city.x).toBeCloseTo(45, 7);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    const drawing = canvas.getContext('2d')!;
    drawing.fillStyle = '#407f86'; drawing.fillRect(0, 0, 64, 48);
    window.testMediaStream = canvas.captureStream(10);
    window.testMediaSources = []; window.testMediaUrls = [];
    const paint = () => {
      if (!window.testMediaStream.active) return;
      drawing.fillRect(0, 0, 64, 48);
      setTimeout(paint, 100);
    };
    paint();
    const ids = ['air-video-1', 'air-video-2', 'air-video-3', 'air-image-1', 'ground-video-1', 'ground-video-2', 'ground-video-3', 'ground-video-4'];
    ids.forEach((slotId, index) => {
      const kind = index === 3 ? 'image' : 'video';
      const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#407f86"/></svg>'], { type: 'image/svg+xml' });
      const url = kind === 'image' ? URL.createObjectURL(blob) : undefined;
      const stream = kind === 'video' ? window.testMediaStream.clone() : undefined;
      if (url) window.testMediaUrls.push(url);
      if (stream) window.testMediaSources.push(stream);
      const result = window.hardwareReceiver({ sourceMode: 'physical', eventType: 'media.feed', eventId: `media-${index}`,
        occurredAt: Date.now(), payload: { slotId, kind, feedId: `camera-${index}`, status: 'ready',
          deviceId: slotId.startsWith('ground') ? `EXT-FIRE-VEHICLE-0${index - 3}` : undefined, url, stream } });
      if (!result.accepted) throw new Error(result.error);
    });
  });
  await expect(page.locator('[data-media-status=playing]')).toHaveCount(8);
  expect(await page.locator('[data-feed-slot] video').evaluateAll(videos =>
    new Set(videos.map(video => (video as HTMLVideoElement).srcObject)).size)).toBe(7);
  for (const [index, deviceId] of truckIds.entries()) {
    const slot = page.locator(`[data-feed-slot=ground-video-${index + 1}]`);
    await expect(slot).toHaveAttribute('data-device', deviceId);
    await expect(slot).toHaveAttribute('data-feed-id', `camera-${index + 4}`);
  }
  const mismatch = await page.evaluate(() => window.hardwareReceiver({
    sourceMode: 'physical', eventType: 'media.feed', eventId: 'wrong-media-device', occurredAt: Date.now(),
    payload: { slotId: 'ground-video-1', kind: 'video', feedId: 'wrong-camera', status: 'connecting', deviceId: 'EXT-FIRE-VEHICLE-02' },
  }));
  expect(mismatch).toMatchObject({ accepted: false });
  await expect(page.getByTestId('dashboard-input-error')).toHaveText(/媒体源与设备归属不匹配/);
  await expect(page.locator('[data-feed-slot=ground-video-1]')).toHaveAttribute('data-feed-id', 'camera-4');
  const replaced = await page.evaluate(() => {
    const stream = window.testMediaStream.clone();
    window.testMediaSources.push(stream);
    const send = (feedId: string, status: string, id: string) => window.hardwareReceiver({
      sourceMode: 'physical', eventType: 'media.feed', eventId: id, occurredAt: Date.now(),
      payload: { slotId: 'ground-video-1', kind: 'video', feedId, status, stream: status === 'ready' ? stream : undefined },
    });
    return [send('new-camera', 'ready', 'replacement'), send('camera-4', 'disconnected', 'superseded-camera-ended')];
  });
  expect(replaced).toMatchObject([{ accepted: true }, { accepted: false }]);
  await expect(page.locator('[data-feed-slot=ground-video-1]')).toHaveAttribute('data-feed-id', 'new-camera');
  await expect(page.locator('[data-feed-slot=ground-video-1] [data-media-status=playing]')).toBeVisible();
  await page.evaluate(() => {
    const send = (slotId: string, feedId: string, status: string, id: string) => window.hardwareReceiver({
      sourceMode: 'physical', eventType: 'media.feed', eventId: id, occurredAt: Date.now(),
      payload: { slotId, kind: 'video', feedId, status },
    });
    send('ground-video-3', 'camera-6', 'disconnected', 'lost');
    send('ground-video-4', 'camera-7', 'error', 'video-error');
    send('air-video-2', 'camera-1', 'reconnecting', 'media-reconnect');
    window.hardwareReceiver({ sourceMode: 'physical', eventType: 'traffic.snapshot', eventId: 'lights', occurredAt: Date.now(),
      payload: { devices: { '192.168.1.111': { connected: true, groups: Array.from({ length: 16 }, () => ({ color: 'yellow_flash', countdown: 3 })) } } } });
  });
  await expect(page.locator('[data-feed-slot=ground-video-3] [data-media-status=disconnected]')).toHaveCount(1);
  await expect(page.locator('[data-feed-slot=ground-video-4] [data-media-status=error]')).toHaveCount(1);
  await expect(page.locator('[data-feed-slot=air-video-2] [data-media-status=reconnecting]')).toHaveCount(1);
  await expect(page.locator('[data-media-status=playing]')).toHaveCount(5);
  await expect(page.locator('[data-hardware-status=online] [data-signal-state=yellow_flash]').first()).toBeAttached();
  await page.screenshot({ path: `${frames}/message-integration.png` });
  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(['invalid image'], { type: 'image/png' }));
    window.testMediaUrls.push(url);
    return window.hardwareReceiver({ sourceMode: 'physical', eventType: 'media.feed', eventId: 'invalid-image', occurredAt: Date.now(),
      payload: { slotId: 'air-image-1', kind: 'image', feedId: 'invalid-image', status: 'ready', url } });
  });
  await expect(page.locator('[data-feed-slot="air-image-1"] [data-media-status=error]')).toHaveCount(1);
  await page.getByLabel('数据来源').selectOption('mock');
  expect(await page.evaluate(() => window.mainlineDetached)).toBe(true);
  await expect(page.locator('[data-hardware-status]')).toHaveCount(0);
  await expect(page.locator('[data-event-id=physical-5]')).toHaveCount(0);
  await expect(page.locator('[data-media-status=idle]')).toHaveCount(8);
  await page.getByLabel('数据来源').selectOption('physical');
  await expect(page.locator('[data-fire-truck][data-location=virtual]')).toHaveCount(4);
  expect(await page.evaluate(() => window.hardwareReceiver({}).accepted)).toBe(false);
});
