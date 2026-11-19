import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { EmergencyService } from '../src/utils/emergency';
import type { createEmergencyMock } from './emergencyMock';
import type { SceneActorSnapshot } from '../src/types';

const output = process.env.FIRE_ACCEPTANCE_DIR ?? fileURLToPath(new URL('../screenshots/traffic-drone-fire/', import.meta.url));
declare global {
  interface Window {
    acceptanceService: EmergencyService;
    acceptanceMock: ReturnType<typeof createEmergencyMock>;
    acceptanceFrame: {
      fire: boolean; smoke: boolean; target: string; firePosition: number[]; camera: number[];
      stationVisible: boolean; stationBays: { id: string; position: number[] }[];
      input: readonly SceneActorSnapshot[];
      actors: { id: string; position: number[]; heading: number; visible: boolean; status: string; water: boolean }[];
    };
  }
}

async function ready(page: Page) {
  await page.route('**/src/components/FireScene3D.tsx*', async route => {
    const response = await route.fetch();
    const body = await response.text();
    const observed = body.replace('renderer.render(scene, camera);', `
      window.acceptanceFrame = {
        fire: scene.getObjectByName('fire')?.visible ?? false,
        smoke: scene.getObjectByName('smoke-plume')?.children.some(p => p.visible) ?? false,
        target: scene.getObjectByName('fire')?.userData.targetId,
        firePosition: scene.getObjectByName('fire')?.position.toArray(), camera: camera.position.toArray(),
        stationVisible: scene.getObjectByName('EXT-P-DRONE')?.visible ?? false,
        stationBays: scene.getObjectByName('EXT-P-DRONE')?.children.filter(p => p.name.startsWith('bay:')).map(p => ({id:p.name,position:p.position.toArray()})) ?? [],
        input: latest.current.actors.current,
        actors: scene.getObjectByName('actors')?.children.map(a => ({ id:a.name,position:a.position.toArray(),
          heading:a.children[0]?.children[0]?.rotation.y,visible:a.visible,status:a.userData.status,
          water:a.getObjectByName('water')?.visible ?? false })) ?? [] };
      renderer.render(scene, camera);`);
    expect(observed).not.toBe(body);
    await route.fulfill({ response, body: observed });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await page.evaluate(async () => {
    const servicePath = '/src/utils/emergency.ts';
    const fixturePath = '/e2e/emergencyMock.ts';
    const service = (await import(servicePath)).getEmergencyService();
    const fixture = await import(fixturePath);
    window.acceptanceService = service;
    window.acceptanceMock = fixture.createEmergencyMock(service, 'ISOLATED-ACCEPTANCE');
    service.connect(window.acceptanceMock.adapter);
  });
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await page.getByLabel('交通信号灯', { exact: true }).check();
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await mkdir(`${output}/screenshots`, { recursive: true });
}

async function screenshot(page: Page, name: string) {
  // Camera easing uses the render clock independently of the paused simulation.
  let previous: number[] | undefined;
  await expect.poll(async () => {
    const camera = await page.evaluate(() => window.acceptanceFrame.camera);
    const delta = previous ? Math.hypot(...camera.map((n, i) => n - previous![i])) : Infinity;
    previous = camera;
    return delta;
  }, { intervals: [100] }).toBeLessThan(.05);
  await page.screenshot({ path: `${output}/screenshots/${name}.png`, fullPage: true });
}

async function auditTraffic(page: Page, seconds: number, stopAtPassage = false, finish?: 'arrived' | 'home') {
  return page.evaluate(async ({ seconds, stopAtPassage, finish }) => {
    const conflictPath = '/src/utils/trafficSimulation.ts';
    const { conflicts } = await import(conflictPath);
    const roadPath = '/src/utils/roadNetwork.ts';
    const { followsOnSameLane } = await import(roadPath);
    const sim = window.acceptanceService.traffic;
    const distance = new Map(sim.cars.map(car => [car.id, 0]));
    const violations: { actor: string; intersection: string; color: string }[] = [];
    const collisions: string[][] = [];
    const seenPriority = new Set<string>();
    const seenGroups = new Set<string>();
    let passage: { vehicle: string; intersection: string; road: string | undefined; signals: ReturnType<typeof sim.signals.getAllSignalStates> } | undefined;
    let time = 0;
    while (time < seconds - 1e-8) {
      const before = sim.all.map(vehicle => ({ id: vehicle.id, point: vehicle.pose.point,
        lane: vehicle.cursor.piece, offset: vehicle.cursor.distance, junction: vehicle.junction, fire: vehicle.fire, status: vehicle.status,
        signals: sim.signals.getLaneControl(vehicle.cursor.piece) ? sim.signals.getIntersectionState(sim.signals.getLaneControl(vehicle.cursor.piece)!.intersection.id) : undefined }));
      const step = Math.min(.05, seconds - time);
      sim.tick(step);
      time += step;
      sim.all.forEach((vehicle, index) => {
        const old = before[index];
        if (!vehicle.fire) distance.set(vehicle.id, distance.get(vehicle.id)! + Math.hypot(vehicle.pose.point[0] - old.point[0], vehicle.pose.point[1] - old.point[1]));
        const control = sim.signals.getLaneControl(old.lane);
        if (vehicle.junction && vehicle.junction !== old.junction && (!old.junction || !sim.signals.sharesClearanceZone(old.junction, vehicle.junction)) &&
          control && old.offset <= sim.signals.stopDistance(old.lane, vehicle.fire ? .84 : .65) + 1e-6) {
          const state = sim.signals.getIntersectionState(control.intersection.id)!;
          const yielding = !vehicle.fire && before.some(truck => truck.fire && truck.status === 'en-route' &&
            followsOnSameLane({ piece: old.lane, distance: old.offset }, { piece: truck.lane, distance: truck.offset }));
          if (vehicle.fire && old.status === 'en-route' && old.lane.road) passage = { vehicle: vehicle.id, intersection: control.intersection.id,
            road: old.lane.road, signals: sim.signals.getAllSignalStates() };
          else if (!yielding && state.vehicles[control.entry.id] !== 'green' && old.signals?.vehicles[control.entry.id] !== 'green')
            violations.push({ actor: vehicle.id, intersection: control.intersection.id, color: state.vehicles[control.entry.id] });
        }
      });
      sim.all.forEach((vehicle, index) => sim.all.slice(index + 1).forEach(other => {
        if (conflicts(vehicle, other, 0)) collisions.push([vehicle.id, other.id]);
      }));
      sim.signals.getAllSignalStates().forEach(state => {
        if (state.emergencyPriority) seenPriority.add(state.intersectionId);
        if (state.groupId) seenGroups.add(`${state.intersectionId}:${state.groupId}`);
      });
      if (passage && stopAtPassage) break;
      if (finish === 'arrived' && sim.trucks.filter(t => t.external).every(t => t.status === 'arrived')) break;
      if (finish === 'home' && time >= 100 && sim.trucks.every(t => t.status === 'idle') && window.acceptanceService.getSnapshot().drones.every(d => !d.path)) break;
    }
    return { seconds: time, sampleInterval: .05, physicalMaxStep: .022, violations, collisions, movedCars: [...distance].filter(([, value]) => value > .2).length,
      carDistances: Object.fromEntries(distance), seenPriority: [...seenPriority], groupsSeen: seenGroups.size, passage,
      trucks: sim.trucks.map(t => ({ id: t.id, status: t.status, position: t.pose.point, road: t.cursor.piece.road })),
      waitingCars: sim.cars.filter(c => c.waitingForSignal).length, signals: sim.signals.getAllSignalStates() };
  }, { seconds, stopAtPassage, finish });
}

async function synchronizedDrones(page: Page) {
  await expect.poll(() => page.evaluate(() => window.acceptanceFrame.actors.filter(a => a.id.startsWith('DRONE')).length)).toBe(2);
  return page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const drones = window.acceptanceService.getSnapshot().drones;
    const frame = window.acceptanceFrame;
    return drones.map(drone => {
      const svg = document.querySelector<SVGGElement>(`[data-drone="${drone.id}"]`)!;
      const actor = frame.actors.find(a => a.id === drone.id)!;
      const route = document.querySelector(`[data-drone-path="${drone.id}"]`)!.getAttribute('points');
      return { id: drone.id, position: drone.position, status: drone.status, route, visible: actor.visible,
        svgError: Math.hypot(Number(svg.dataset.x) - drone.position.x, Number(svg.dataset.y) - drone.position.y),
        sceneError: Math.hypot(actor.position[0] - ((drone.position.x - 30) * 1312 / 30 - 656),
          actor.position[2] - (524.5 - (drone.position.y - 25) * 1049 / 25), actor.position[1] - drone.altitude),
        headingError: Math.abs(actor.heading - drone.heading) };
    });
  });
}

test('normal traffic, shared station and complete incident use the actual business lifecycle', async ({ page }) => {
  test.setTimeout(360000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  const normal = await auditTraffic(page, 100);
  await writeFile(`${output}/normal-traffic.json`, JSON.stringify(normal, null, 2));
  expect(normal.violations).toEqual([]);
  expect(normal.collisions).toEqual([]);
  expect(normal.movedCars).toBe(27);
  expect(normal.groupsSeen).toBeGreaterThan(100);
  await page.getByRole('button', { name: '查看无人机站', exact: true }).click();
  await page.getByRole('button', { name: '无人机站', exact: true }).click();
  const idle = await synchronizedDrones(page);
  expect(idle.every(d => d.svgError < 1e-9 && d.sceneError < 1e-9 && d.visible)).toBe(true);
  expect(idle.map(d => d.status)).toEqual(['idle', 'idle']);
  await screenshot(page, '01-normal-standby-station');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${output}/screenshots/drone-station-3d-closeup.png` });
  await page.getByRole('button', { name: '重置地图视图', exact: true }).click();
  await page.getByRole('button', { name: '火场', exact: true }).click();
  expect(await page.evaluate(() => window.acceptanceMock.emit({ type: 'fire.detected', targetPoiId: 'T-SW-01' }))).toEqual({ accepted: true });
  await page.getByRole('button', { name: '开始定位', exact: true }).click();
  await expect(page.getByTestId('run-button-state')).toHaveText('Completed', { timeout: 60000 });
  await expect(page.getByRole('region', { name: '定位结果', exact: true }).locator('.poi-id')).toContainText('T-SW-01');
  await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-status', 'burning');
  await expect.poll(() => page.evaluate(() => window.acceptanceFrame.fire && window.acceptanceFrame.smoke)).toBe(true);
  await screenshot(page, '02-fire-detected');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${output}/screenshots/fire-closeup.png` });
  await page.evaluate(() => window.acceptanceMock.begin());
  await page.getByRole('button', { name: '查看无人机站', exact: true }).click();
  await page.getByRole('button', { name: '无人机站', exact: true }).click();
  const takeoffAudit = await auditTraffic(page, .3);
  const takeoff = await synchronizedDrones(page);
  expect(takeoff.every(d => d.visible && d.route && d.svgError < 1e-9 && d.sceneError < 1e-9)).toBe(true);
  await screenshot(page, '03-drone-takeoff');
  const flightOutbound = await auditTraffic(page, 5);
  await page.getByRole('button', { name: '全图', exact: true }).click();
  await page.getByRole('button', { name: '火场', exact: true }).click();
  const flying = await synchronizedDrones(page);
  expect(flying.every(d => d.visible && d.route && d.sceneError < 1e-9)).toBe(true);
  await screenshot(page, '03c-drone-flight-routes');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${output}/screenshots/drone-mission-closeup.png` });
  const flightAudit = await auditTraffic(page, 10);
  await page.getByRole('button', { name: '重置地图视图', exact: true }).click();
  await page.getByRole('button', { name: '火场', exact: true }).click();
  const observing = await synchronizedDrones(page);
  expect(observing.every(d => d.visible && d.sceneError < 1e-9)).toBe(true);
  await page.evaluate(() => {
    window.acceptanceService.getSnapshot().drones.forEach(d => window.acceptanceMock.emit({ type: 'drone.observed', droneId: d.id }));
    window.acceptanceMock.prepare(2, 3, false);
  });
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'awaiting_confirmation');
  await screenshot(page, '03b-drone-observation-result');
  await page.getByRole('button', { name: '确认并执行方案', exact: true }).click();
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'fire_trucks_dispatched');
  await page.getByRole('button', { name: '查看消防站', exact: true }).click();
  const dispatched = await auditTraffic(page, 2);
  expect(dispatched.signals.every(s => !s.emergencyPriority)).toBe(true);
  expect(dispatched.signals.some(s => !s.emergencyPriority && Object.values(s.vehicles).includes('green'))).toBe(true);
  await screenshot(page, '04-dispatch-priority');
  const passage = await auditTraffic(page, 120, true);
  expect(passage.passage).toBeDefined();
  expect(passage.violations).toEqual([]);
  expect(passage.collisions).toEqual([]);
  await page.getByRole('button', { name: '全图', exact: true }).click();
  const intersection = passage.passage!.intersection.split(',').map(Number);
  const anchor = await page.getByTestId('sandbox-svg').evaluate((element, intersection) => {
    const p = new DOMPoint(intersection[0] / 90 * 3939, (75 - intersection[1]) / 75 * 3150).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, intersection);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => Number((await page.getByTestId('sandbox-svg').getAttribute('viewBox'))!.split(' ')[2])).toBeLessThan(2000);
  await page.locator(`[data-intersection="${passage.passage!.intersection}"] [data-vehicle-signal]`).first().click();
  await expect(page.getByRole('complementary', { name: '路口信号详情' })).toContainText('正常运行');
  await screenshot(page, '05-controlled-intersection-passage');
  await page.getByRole('region', { name: '火情沙盘地图', exact: true }).screenshot({ path: `${output}/screenshots/traffic-priority-closeup.png` });
  const response = await auditTraffic(page, 240, false, 'arrived');
  expect(response.trucks.filter(t => t.status === 'arrived')).toHaveLength(2);
  expect(response.violations).toEqual([]);
  expect(response.collisions).toEqual([]);
  await page.getByRole('button', { name: '重置地图视图', exact: true }).click();
  await page.evaluate(() => window.acceptanceService.getSnapshot().incident!.plan!.dispatches.forEach(d => {
    window.acceptanceMock.emit({ type: 'truck.arrived', vehicleId: d.vehicleId });
    window.acceptanceMock.emit({ type: 'truck.extinguishing', vehicleId: d.vehicleId });
  }));
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguishing');
  await writeFile(`${output}/extinguishing-frame.json`, JSON.stringify(await page.evaluate(() => window.acceptanceFrame), null, 2));
  await expect.poll(() => page.evaluate(() => window.acceptanceFrame.actors.filter(a => a.water).length)).toBe(2);
  await screenshot(page, '06-extinguishing');
  expect(await page.evaluate(() => window.acceptanceMock.emit({ type: 'fire.extinguished' }))).toEqual({ accepted: true });
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguished');
  await expect.poll(() => page.evaluate(() => window.acceptanceFrame.fire || window.acceptanceFrame.smoke)).toBe(false);
  await screenshot(page, '07-extinguished');
  const returnAudit = await auditTraffic(page, 2);
  const returning = await synchronizedDrones(page);
  expect(returning.every(d => d.status === 'returning' && d.route && d.sceneError < 1e-9)).toBe(true);
  expect(returnAudit.signals.every(s => !s.emergencyPriority)).toBe(true);
  await screenshot(page, '08-traffic-restored-returning');
  const recovery = await auditTraffic(page, 900, false, 'home');
  expect(recovery.trucks.every(t => t.status === 'idle')).toBe(true);
  expect(recovery.signals.every(s => !s.emergencyPriority)).toBe(true);
  expect(recovery.movedCars).toBe(27);
  expect(recovery.violations).toEqual([]);
  expect(recovery.collisions).toEqual([]);
  const landed = await page.evaluate(() => window.acceptanceService.getSnapshot().drones.map(d => ({ id: d.id, position: d.position, path: d.path })));
  expect(landed.map(d => d.position)).toEqual([{ x: 28.6, y: 23.15 }, { x: 28.6, y: 24.85 }]);
  expect(landed.every(d => !d.path)).toBe(true);
  await page.evaluate(() => window.acceptanceMock.dockDrones());
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'completed');
  await page.getByRole('button', { name: '查看无人机站', exact: true }).click();
  await page.getByRole('button', { name: '无人机站', exact: true }).click();
  const docked = await synchronizedDrones(page);
  expect(docked.every(d => d.status === 'charging' && d.visible && d.sceneError < 1e-9)).toBe(true);
  await screenshot(page, '09-returned-standby');
  const business = await page.evaluate(() => ({ commands: window.acceptanceMock.commands, phases: window.acceptanceMock.phases,
    mode: window.acceptanceService.traffic.signals.getMode(), incident: window.acceptanceService.getSnapshot().incident }));
  await writeFile(`${output}/full-lifecycle.json`, JSON.stringify({ normal, idle, takeoff, observing, dispatched, passage, response,
    flying, returning, recovery, landed, docked, business, errors, intermediateAudits: [takeoffAudit, flightOutbound, flightAudit, returnAudit] }, null, 2));
  expect(errors).toEqual([]);
});

test('eight detected tank targets share actual SVG and Three.js positions', async ({ page }) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const ids = ['T-NW-01', 'T-NW-02', 'T-NE-01', 'T-NE-02', 'T-SW-01', 'T-SW-02', 'T-SE-01', 'T-SE-02'];
  const results = [];
  for (const id of ids) {
    await ready(page);
    await page.getByRole('button', { name: '仿真设置', exact: true }).click();
    await page.getByLabel('火情场景').selectOption(id);
    await page.getByRole('button', { name: '关闭仿真设置' }).click();
    await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
    expect(await page.evaluate(id => window.acceptanceMock.emit({ type: 'fire.detected', targetPoiId: id }), id)).toEqual({ accepted: true });
    await page.getByRole('button', { name: '开始定位', exact: true }).click();
    await expect(page.getByTestId('run-button-state')).toHaveText('Completed', { timeout: 60000 });
    await expect(page.getByRole('region', { name: '定位结果', exact: true }).locator('.poi-id')).toContainText(id);
    await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-poi-id', id);
    await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', id);
    await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-target-id', id);
    await expect.poll(() => page.evaluate(() => window.acceptanceFrame.target)).toBe(id);
    await expect.poll(() => page.evaluate(() => window.acceptanceFrame.fire)).toBe(true);
    const mapping = await page.evaluate(async id => {
      const dataPath = '/src/utils/fireSceneData.ts';
      const { getFireScene, localToScene } = await import(dataPath);
      const tank = getFireScene(id).target;
      const p = localToScene(tank.center);
      const marker = document.querySelector('[data-testid="truth-marker"] circle')!;
      const svg = { x: Number(marker.getAttribute('cx')), y: Number(marker.getAttribute('cy')) };
      return { id, name: tank.name, predictionName: document.querySelector('[data-testid="top1-name"]')?.textContent,
        predictionId: document.querySelector('.poi-id')?.textContent, local: tank.center, city: { x: tank.center[0] + 30, y: tank.center[1] + 25 }, svg, expectedScene: p,
        actualFire: window.acceptanceFrame.firePosition, actualTarget: window.acceptanceFrame.target };
    }, id);
    expect(mapping.actualFire[0]).toBeCloseTo(mapping.expectedScene.x, 8);
    expect(mapping.predictionName).toBe(mapping.name);
    expect(mapping.actualFire[2]).toBeCloseTo(mapping.expectedScene.z, 8);
    expect(mapping.svg.x).toBeCloseTo(mapping.city.x / 90 * 3939, 8);
    expect(mapping.svg.y).toBeCloseTo((75 - mapping.city.y) / 75 * 3150, 8);
    await expect(page.getByRole('region', { name: '火场信息', exact: true })).toContainText(id);
    await screenshot(page, `tank-${id}`);
    results.push(mapping);
  }
  await writeFile(`${output}/eight-tank-mapping.json`, JSON.stringify(results, null, 2));
});
