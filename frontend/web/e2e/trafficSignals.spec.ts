import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TrafficSimulation } from '../src/utils/trafficSimulation';
import trafficConfig from '../src/config/trafficControl.json' with { type: 'json' };

declare global { interface Window { trafficSimulation: TrafficSimulation } }
const screenshots = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/existing/` : fileURLToPath(new URL('../screenshots/', import.meta.url));

async function ready(page: Page) {
  // 只在浏览器测试中获取正在渲染的真实实例，不给正式页面增加调试入口。
  await page.route('**/src/components/VehicleLayer.tsx*', async route => {
    const response = await route.fetch(), body = await response.text();
    const observed = body.replace(/const sim\s*=\s*simulation;/, '$& window.trafficSimulation = simulation;');
    expect(observed).not.toBe(body);
    await route.fulfill({ response, body: observed });
  });
  await page.goto('/?workspace=bridge-demo');
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await mkdir(screenshots, { recursive: true });
}
async function showSignals(page: Page, visible: boolean) {
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await page.getByLabel('交通信号灯', { exact: true }).setChecked(visible);
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
}

test('six hardware signals keep their lamp colors offline and refresh on reconnection', async ({ page }) => {
  await page.route('**/api/scenarios/active', route => route.fulfill({ json: null }));
  await page.addInitScript(() => {
    class SignalSource extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | undefined;
      onerror: (() => void) | undefined;
      constructor() {
        super();
        window.addEventListener('hardware-test', this.receive);
      }
      private receive = (event: Event) => {
        const devices = (event as CustomEvent).detail;
        if (devices) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ devices }) }));
        else this.onerror?.();
      };
      close() { window.removeEventListener('hardware-test', this.receive); }
    }
    Object.defineProperty(window, 'EventSource', { value: SignalSource });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '全局暂停', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  const send = async (color: string | null, connected = true) => page.evaluate(([color, connected]) => {
    const devices = color && Object.fromEntries([111, 112, 113, 114, 115, 116].map(suffix =>
      [`192.168.1.${suffix}`, { connected, groups: Array.from({ length: 16 }, () => ({ color, countdown: 2 })) }]));
    window.dispatchEvent(new CustomEvent('hardware-test', { detail: devices }));
  }, [color, connected] as const);
  await send('green');
  const live = page.locator('[data-hardware-status="online"]');
  await expect(live).toHaveCount(6);
  await expect(page.locator('[data-intersection="35.762195,37.631077"], [data-intersection="45.022866,37.631077"], [data-intersection="54.260671,37.631077"]')).toHaveCount(0);
  const lampPositions = await page.locator('[data-pedestrian-signal^="LOCAL-ZEBRA-"]').evaluateAll(elements =>
    Object.fromEntries(elements.map(element => {
      const lamp = element as SVGGElement;
      const { e, f } = lamp.transform.baseVal.getItem(0).matrix;
      return [`${lamp.dataset.pedestrianSignal}:${lamp.dataset.signalEnd}`, [e, f]];
    })));
  expect(Object.keys(lampPositions)).toHaveLength(trafficConfig.originalCrosswalks.length * 2);
  trafficConfig.originalCrosswalks.forEach(({ pixels: [x1, y1, x2, y2] }, index) => {
    const id = `LOCAL-ZEBRA-${String(index + 1).padStart(3, '0')}`;
    const centers = x2 - x1 > y2 - y1
      ? [[x1 - 8, (y1 + y2) / 2], [x2 + 8, (y1 + y2) / 2]]
      : [[(x1 + x2) / 2, y1 - 8], [(x1 + x2) / 2, y2 + 8]];
    centers.forEach(([x, y], end) => {
      expect(lampPositions[`${id}:${end}`][0]).toBeCloseTo(1313 + x, 3);
      expect(lampPositions[`${id}:${end}`][1]).toBeCloseTo(1050 + y, 3);
    });
  });
  const junction = page.locator('[data-intersection="35.762195,29.361296"]');
  const vehicle = junction.locator('[data-vehicle-signal]').first();
  await expect(vehicle).toHaveAttribute('data-signal-state', 'green');
  await vehicle.click();
  const details = page.getByRole('complementary', { name: '路口信号详情' });
  await expect(details).toContainText('实机同步');
  await send('green', false);
  await expect(details).toContainText('信号机离线');
  await expect(vehicle).toHaveAttribute('data-signal-state', 'green');
  await send('yellow');
  await expect(details).toContainText('实机同步');
  await expect(vehicle).toHaveAttribute('data-signal-state', 'yellow');
  await send(null);
  await expect(details).toContainText('信号机离线');
  await expect(vehicle).toHaveAttribute('data-signal-state', 'yellow');
});

test('default hidden signals, real traffic control, live details, all red, recovery and all viewport sizes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect(page.locator('[data-layer="traffic-signals"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="vehicles"] [data-actor]')).toHaveCount(27);
  await expect(page.locator('[data-fire-truck]')).toHaveCount(4);
  const initial = await page.evaluate(() => window.trafficSimulation.cars.map(c => c.pose.point));
  await page.evaluate(() => window.trafficSimulation.tick(12));
  expect(await page.evaluate(initial => window.trafficSimulation.cars.some((c, i) =>
    Math.hypot(c.pose.point[0] - initial[i][0], c.pose.point[1] - initial[i][1]) > .2), initial)).toBe(true);
  const coverage = await page.evaluate(async () => {
    const path = '/src/utils/trafficSignalController.ts';
    const api = await import(path);
    return { ...api.signalCoverage, sameService: api.getTrafficControlService() === window.trafficSimulation.signals,
      groups: api.intersections.map((i: { id: string; region: string; kind: string; entries: unknown[]; crosswalks: unknown[] }) =>
        ({ id: i.id, region: i.region, kind: i.kind, approaches: i.entries.length, crosswalks: i.crosswalks.length })) };
  });
  expect(coverage.sameService).toBe(true);
  await writeFile(`${screenshots}/traffic-coverage.json`, JSON.stringify(coverage, null, 2));
  await showSignals(page, true);
  await expect(page.locator('[data-intersection]')).toHaveCount(coverage.intersections);
  await expect(page.locator('[data-pedestrian-signal]')).toHaveCount(coverage.crosswalks * 2);
  await page.getByRole('button', { name: '全图', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/traffic-city-normal.png`, fullPage: true });
  await page.getByRole('button', { name: '重置地图视图', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/traffic-original.png`, fullPage: true });
  const junction = page.locator('[data-intersection="35.762195,29.361296"]');
  const marker = junction.locator('[data-vehicle-signal]').first();
  const before = await page.evaluate(() => window.trafficSimulation.signals.getAllSignalStates());
  await marker.click();
  await expect(page.getByRole('complementary', { name: '路口信号详情' })).toContainText('35.762195,29.361296');
  expect(await page.evaluate(() => window.trafficSimulation.signals.getAllSignalStates())).toEqual(before);
  await page.evaluate(() => window.trafficSimulation.signals.setMode('emergency_lockdown'));
  await expect(page.getByRole('complementary', { name: '路口信号详情' })).toContainText('应急全红管制');
  expect(await page.locator('[data-signal-state="green"]').count()).toBe(0);
  await page.getByTestId('sandbox-svg').click({ position: { x: 450, y: 260 } });
  await expect(page.getByRole('complementary', { name: '路口信号详情' })).toHaveCount(0);
  await showSignals(page, false);
  await page.evaluate(() => window.trafficSimulation.tick(60));
  const stopped = await page.locator('[data-layer="vehicles"] [data-actor]').evaluateAll(nodes => nodes.map(n => n.getAttribute('transform')));
  await page.evaluate(() => window.trafficSimulation.tick(2));
  expect(await page.locator('[data-layer="vehicles"] [data-actor]').evaluateAll(nodes => nodes.map(n => n.getAttribute('transform')))).toEqual(stopped);
  await expect(page.locator('[data-pedestrian-route]')).toHaveCount(0);
  await showSignals(page, true);
  await page.getByRole('button', { name: '全图', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/traffic-lockdown.png`, fullPage: true });
  await page.evaluate(() => window.trafficSimulation.signals.setMode('normal'));
  expect(await page.locator('[data-signal-state="green"]').count()).toBe(0);
  await page.evaluate(() => window.trafficSimulation.tick(2));
  expect(await page.locator('[data-signal-state="green"]').count()).toBeGreaterThan(0);
  await page.screenshot({ path: `${screenshots}/traffic-restored.png`, fullPage: true });

  // 用真实滚轮和拖动操作检查锚点；灯具仍采用城市坐标，屏幕尺寸随视图克制缩放。
  await page.getByTestId('sandbox-svg').scrollIntoViewIfNeeded();
  const anchor = await page.getByTestId('sandbox-svg').evaluate(element => {
    const p = new DOMPoint(15 / 90 * 3939, (75 - 12) / 75 * 3150).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, -600);
  await expect.poll(async () => Number((await page.getByTestId('sandbox-svg').getAttribute('viewBox'))!.split(' ')[2])).toBeLessThan(2100);
  const extension = page.locator('[data-intersection="15.000000,12.000000"] [data-vehicle-signal]').first();
  const mapAnchor = () => extension.evaluate(element => {
    const marker = element as SVGGElement;
    const svg = marker.ownerSVGElement!, screen = new DOMPoint(0, 0).matrixTransform(marker.getScreenCTM()!);
    const world = screen.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: world.x, y: world.y };
  });
  const beforeDrag = await mapAnchor();
  const box = (await page.getByTestId('sandbox-svg').boundingBox())!;
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6 + 25, box.y + box.height * .6 - 20); await page.mouse.up();
  const afterDrag = await mapAnchor();
  expect(afterDrag.x).toBeCloseTo(beforeDrag.x, 6); expect(afterDrag.y).toBeCloseTo(beforeDrag.y, 6);
  await page.screenshot({ path: `${screenshots}/traffic-extension.png`, fullPage: true });
  await page.getByRole('button', { name: '重置地图视图', exact: true }).click();
  for (const viewport of [{ width: 1366, height: 900 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
    await page.screenshot({ path: `${screenshots}/traffic-${viewport.width}.png`, fullPage: true });
  }
  expect(await page.getByRole('button', { name: /全红|解除管制|调试|测试入口/ }).count()).toBe(0);
  expect(errors).toEqual([]);
});

test('city business demonstration drives the real simulation and all three synchronized fire trucks', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const sim = window.trafficSimulation;
    sim.tick(12); sim.signals.setMode('emergency_lockdown');
    sim.trucks.forEach(truck => sim.signals.setEmergencyAccess(truck.id, true));
    sim.setIncident([39.717988, 33.984756], 3);
    let responseSeconds = 0;
    while (responseSeconds < 180 && sim.trucks.filter(t => t.status === 'arrived').length !== 3) { sim.tick(.1); responseSeconds += .1; }
    return { responseSeconds, statuses: sim.trucks.map(t => t.status) };
  });
  expect(result.statuses.sort()).toEqual(['arrived', 'arrived', 'arrived', 'idle']);
  await expect(page.locator('[data-fire-truck][data-status="arrived"]')).toHaveCount(3);
  await page.screenshot({ path: `${screenshots}/traffic-emergency-passage.png`, fullPage: true });
  const recovery = await page.evaluate(() => {
    const sim = window.trafficSimulation;
    sim.tick(60); const stopped = sim.cars.map(c => [...c.pose.point]);
    sim.signals.setMode('normal'); sim.setIncident(null, 3);
    let returnSeconds = 0;
    while (returnSeconds < 900 && !sim.trucks.every(t => t.status === 'idle')) { sim.tick(.1); returnSeconds += .1; }
    return { returnSeconds, statuses: sim.trucks.map(t => t.status), carsResumed: sim.cars.some((c, i) => Math.hypot(c.pose.point[0] - stopped[i][0], c.pose.point[1] - stopped[i][1]) > .2) };
  });
  expect(recovery.statuses).toEqual(['idle', 'idle', 'idle', 'idle']); expect(recovery.carsResumed).toBe(true);
  await expect(page.locator('[data-fire-truck][data-status="idle"]')).toHaveCount(4);
  await writeFile(`${screenshots}/traffic-demonstration.json`, JSON.stringify({ response: result, recovery }, null, 2));
});
