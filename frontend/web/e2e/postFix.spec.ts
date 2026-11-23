import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assess, connectMock } from './emergencyDriver';
import type { SceneActorSnapshot } from '../src/types';
import type { EmergencyService } from '../src/utils/emergency';

const output = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/existing/phase3-layout-v3/post-fix/` : fileURLToPath(new URL('../screenshots/phase3-layout-v3/post-fix/', import.meta.url));
declare global {
  interface Window {
    postFrame: { target: string; root: string; center: number[]; names: string[]; fire: boolean; smoke: boolean;
      fireTarget: string; fireCount: number; cameraAspect: number; buffer: number[]; disposedChildren: number[];
      input: readonly SceneActorSnapshot[];
      actors: { id: string; position: number[]; heading: number; status: string; visible: boolean }[] };
  }
}

async function ready(page: Page) {
  await page.route('**/src/components/FireScene3D.tsx*', async route => {
    const response = await route.fetch(), body = await response.text();
    const observed = body.replace('renderer.render(scene, camera);', `
      if (window.postRoot && window.postRoot !== current?.root) window.postDisposed.push(window.postRoot.children.length);
      window.postDisposed ??= [];
      window.postRoot = current?.root;
      window.postFrame = { target: latest.current.targetId, root: current?.root.name,
        center: controls.target.toArray(), names: current?.root.children.map(n=>n.name) ?? [],
        fire: scene.getObjectByName('fire')?.visible ?? false,
        smoke: scene.getObjectByName('smoke-plume')?.children.some(p=>p.visible) ?? false,
        fireTarget: scene.getObjectByName('fire')?.userData.targetId,
        fireCount: current?.root.children.filter(n=>n.name==='fire').length ?? 0,
        cameraAspect: camera.aspect, buffer:[renderer.domElement.width,renderer.domElement.height],
        disposedChildren: window.postDisposed, input: latest.current.actors.current,
        actors:scene.getObjectByName('actors')?.children.map(a=>({id:a.name,position:a.position.toArray(),
          heading:a.children[0]?.children[0]?.rotation.y,status:a.userData.status,visible:a.visible})) ?? [] };
      renderer.render(scene, camera);`);
    expect(observed).not.toBe(body);
    await route.fulfill({ response, body: observed });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await mkdir(output, { recursive: true });
}

async function measureFrames(page: Page, label: string, count: number) {
  const frames = await page.evaluate(async count => {
    const path = '/src/utils/emergency.ts', service: EmergencyService = (await import(path)).getEmergencyService();
    const frames = [];
    for (let i = 0; i < count; i++) {
      service.traffic.tick(.1);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      frames.push({ drones: service.getSnapshot().drones, frame: window.postFrame,
        svg: [...document.querySelectorAll<SVGGElement>('[data-drone]')].map(n => ({ id: n.dataset.drone!,
          x: Number(n.dataset.x), y: Number(n.dataset.y), heading: Number(n.dataset.heading),
          altitude: Number(n.dataset.altitude), status: n.dataset.status })),
        paths: [...document.querySelectorAll<SVGPolylineElement>('[data-drone-path]')].map(n => ({ id: n.dataset.dronePath, points: n.getAttribute('points') })) });
    }
    return frames;
  }, count);
  frames.forEach(f => f.drones.forEach(d => {
    const svg = f.svg.find(a => a.id === d.id)!, input = f.frame.input.find(a => a.id === d.id)!, model = f.frame.actors.find(a => a.id === d.id)!;
    expect([svg.x, svg.y, svg.heading, svg.altitude, svg.status]).toEqual([d.position.x, d.position.y, d.heading, d.altitude, d.status]);
    expect(input.position).toEqual(d.position);
    const points = f.paths.find(p => p.id === d.id)!.points!;
    expect(points.split(' ').filter(Boolean).length).toBe(d.path?.length ?? 0);
    if (d.path) {
      const distance = Math.min(...d.path.slice(1).map((end, i) => {
        const start = d.path![i], dx = end.x - start.x, dy = end.y - start.y;
        const ratio = Math.max(0, Math.min(1, ((d.position.x - start.x) * dx + (d.position.y - start.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(d.position.x - start.x - ratio * dx, d.position.y - start.y - ratio * dy);
      }));
      expect(distance).toBeLessThan(1e-10);
    }
    expect(Math.abs(model.position[0] - ((d.position.x - 30) * 1312 / 30 - 656))).toBeLessThan(1e-10);
    expect(Math.abs(model.position[2] - (524.5 - (d.position.y - 25) * 1049 / 25))).toBeLessThan(1e-10);
    expect([model.position[1], model.heading, model.status]).toEqual([d.altitude, d.heading, d.status]);
    expect(f.frame.actors.filter(a => a.id === d.id)).toHaveLength(1);
  }));
  return { label, frames };
}

test('F1 eight formal selections, correct groups and disposed old roots', async ({ page }) => {
  test.setTimeout(90000);
  await ready(page);
  const spatial = JSON.parse(await readFile(new URL('../../../fire_poi/fire_sandbox_spatial_model.json', import.meta.url), 'utf8'));
  const tanks: { id: string; parent_id: string }[] = spatial.pois.filter((p: { entity_type: string }) => p.entity_type === 'Tank');
  const results = [];
  for (const tank of tanks) {
    await page.getByRole('button', { name: '仿真设置', exact: true }).click();
    await page.getByLabel('火情场景').selectOption(tank.id);
    await page.getByRole('button', { name: '关闭仿真设置' }).click();
    await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', tank.id);
    await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-target-id', tank.id);
    await expect.poll(() => page.evaluate(() => window.postFrame.target)).toBe(tank.id);
    await expect.poll(() => page.evaluate(() => window.postFrame.fire)).toBe(false);
    const frame = await page.evaluate(() => window.postFrame);
    expect(frame.disposedChildren.every(n => n === 0)).toBe(true);
    results.push({ normal: tank.id, frame });
  }
  for (const tank of tanks) {
    await page.reload();
    await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '仿真设置', exact: true }).click();
    await page.getByLabel('火情场景').selectOption(tank.id);
    await page.getByRole('button', { name: '关闭仿真设置' }).click();
    await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
    await assess(page, tank.id);
    await page.getByRole('button', { name: '仿真设置', exact: true }).click();
    await expect(page.getByLabel('火情场景')).toBeDisabled();
    await page.getByRole('button', { name: '关闭仿真设置' }).click();
    await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', tank.id);
    await expect.poll(() => page.evaluate(() => window.postFrame.fireTarget)).toBe(tank.id);
    const frame = await page.evaluate(() => window.postFrame);
    expect(frame.root).toBe(tank.parent_id);
    expect(frame.names.filter(n => n.startsWith('T-')).sort()).toEqual(tanks.filter(t => t.parent_id === tank.parent_id).map(t => t.id).sort());
    expect(frame.names).toContain(`F-PIPE-${tank.id.split('-')[1]}`);
    expect(frame.names).toContain('original-map');
    const buildings: { id: string; entity_type: string; parent_id: string }[] = spatial.pois;
    buildings.filter(p => p.entity_type === 'Building' && p.parent_id === tank.parent_id).forEach(p => expect(frame.names).toContain(p.id));
    expect(frame.fireCount).toBe(1);
    expect(frame.disposedChildren.every(n => n === 0)).toBe(true);
    await expect(page.getByRole('region', { name: '火场信息', exact: true })).toContainText(tank.id);
    await page.screenshot({ path: `${output}/tank-${tank.id}.png`, fullPage: true });
    results.push({ burning: tank.id, frame });
  }
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await page.screenshot({ path: `${output}/f1-active-target-locked.png`, fullPage: true });
  await writeFile(`${output}/f1-tank-switching.json`, JSON.stringify({ passed: true, results }, null, 2));
});

test('F2 F3 real routes and identical frames through flight, telemetry, return and completed scene selection', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await ready(page); await connectMock(page, 2, 3, true);
  await page.evaluate(async () => {
    const path = '/src/utils/emergency.ts', service: EmergencyService = (await import(path)).getEmergencyService();
    service.getSnapshot().drones.forEach(d => window.emergencyTest.emit({ type: 'drone.update', drone: { ...d,
      updatedAt: d.updatedAt + 1, path: [d.position, { x: d.position.x, y: 30 }, d.path!.at(-1)!] } }));
  });
  await expect(page.locator('[data-drone-path][points]')).toHaveCount(2);
  const paths = await page.locator('[data-drone-path]').evaluateAll(nodes => nodes.map(n => ({ id: n.getAttribute('data-drone-path'), points: n.getAttribute('points'), color: n.getAttribute('stroke') })));
  expect(paths[0].color).not.toBe(paths[1].color);
  expect(paths.every(p => p.points!.split(' ').length === 3)).toBe(true);
  const samples = [await measureFrames(page, 'outbound', 25)];
  await page.screenshot({ path: `${output}/f2-double-drone-routes.png`, fullPage: true });
  await page.evaluate(async () => {
    const path = '/src/utils/emergency.ts', service: EmergencyService = (await import(path)).getEmergencyService(), d = service.getDrone('DRONE-01')!;
    window.emergencyTest.emit({ type: 'drone.update', drone: { ...d, position: { x: 39, y: 33 }, path: [{ x: 39, y: 33 }, { x: 39, y: 34 }], heading: -.7, altitude: 97, updatedAt: d.updatedAt + 1 } });
  });
  samples.push(await measureFrames(page, 'external-route-and-telemetry', 1));
  await page.evaluate(async () => { const path = '/src/utils/emergency.ts'; (await import(path)).getEmergencyService().traffic.tick(10); });
  await expect(page.locator('[data-drone-path][points=""]')).toHaveCount(2);
  expect(await page.locator('[data-drone-path]').evaluateAll(nodes => nodes.every(n => n.getAttribute('points') === ''))).toBe(true);
  await page.screenshot({ path: `${output}/f3-double-drone-3d.png`, fullPage: true });
  await page.evaluate(() => {
    ['DRONE-01', 'DRONE-02'].forEach(droneId => window.emergencyTest.emit({ type: 'drone.observed', droneId }));
    window.emergencyTest.prepare(2, 3, false);
  });
  await page.getByRole('button', { name: '确认并执行方案', exact: true }).click();
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'fire_trucks_dispatched');
  await page.evaluate(async () => {
    const path = '/src/utils/emergency.ts', service: EmergencyService = (await import(path)).getEmergencyService();
    for (let t = 0; t < 300 && !service.traffic.trucks.filter(t => t.external).every(t => t.status === 'arrived'); t += .1) service.traffic.tick(.1);
    service.getSnapshot().incident!.plan!.dispatches.forEach(d => window.emergencyTest.emit({ type: 'truck.extinguishing', vehicleId: d.vehicleId }));
  });
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguishing');
  await page.screenshot({ path: `${output}/fire-trucks-extinguishing.png`, fullPage: true });
  await page.evaluate(() => window.emergencyTest.emit({ type: 'fire.extinguished' }));
  await expect(page.locator('[data-drone][data-status="returning"]')).toHaveCount(2);
  samples.push(await measureFrames(page, 'returning', 25));
  await page.screenshot({ path: `${output}/fire-trucks-and-drones-returning.png`, fullPage: true });
  await page.evaluate(async () => {
    const path = '/src/utils/emergency.ts', service: EmergencyService = (await import(path)).getEmergencyService();
    for (let t = 0; t < 900 && !service.traffic.trucks.every(t => t.status === 'idle'); t += .2) service.traffic.tick(.2);
    window.emergencyTest.dockDrones();
  });
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'completed');
  const history = await page.evaluate(async () => { const path = '/src/utils/emergency.ts'; return (await import(path)).getEmergencyService().getSnapshot().incident; });
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await expect(page.getByLabel('火情场景')).toBeEnabled();
  await page.getByRole('button', { name: '关闭仿真设置' }).click();
  for (const id of ['T-NW-01', 'T-SW-02', 'T-NE-02']) {
    await page.getByRole('button', { name: '仿真设置', exact: true }).click();
    await page.getByLabel('火情场景').selectOption(id);
    await page.getByRole('button', { name: '关闭仿真设置' }).click();
    await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
    await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', id);
    await expect.poll(() => page.evaluate(() => window.postFrame.target)).toBe(id);
    await expect.poll(() => page.evaluate(() => window.postFrame.fire || window.postFrame.smoke)).toBe(false);
  }
  await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', 'T-NE-02');
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-target-id', 'T-NE-02');
  await expect(page.getByRole('region', { name: '火场信息', exact: true })).toContainText('T-NE-02');
  await expect.poll(() => page.evaluate(() => window.postFrame.fire || window.postFrame.smoke)).toBe(false);
  const after = await page.evaluate(async () => { const path = '/src/utils/emergency.ts'; return (await import(path)).getEmergencyService().getSnapshot().incident; });
  expect(after).toEqual(history);
  await page.screenshot({ path: `${output}/f1-completed-select-new-tank.png`, fullPage: true });
  await writeFile(`${output}/f1-completed-switching.json`, JSON.stringify({ passed: true, history, after, frame: await page.evaluate(() => window.postFrame) }, null, 2));
  await writeFile(`${output}/f2-drone-path.json`, JSON.stringify({ passed: true, paths, samples }, null, 2));
  await writeFile(`${output}/f3-drone-sync.json`, JSON.stringify({ passed: true, tolerance: 1e-10, samples, errors }, null, 2));
  expect(errors).toEqual([]);
});

test('F4 missing or partial observation blocks dispatch, all assigned observations enable formal confirmation', async ({ page }) => {
  await ready(page); await connectMock(page, 1, 2, true);
  const denied = await page.evaluate(async () => {
    const path = '/src/utils/emergency.ts', service: EmergencyService = (await import(path)).getEmergencyService();
    const assessment = { targetPoiId: 'T-SW-01', status: 'completed' as const, severity: 2 as const, result: 'test' };
    const before = service.getSnapshot().incident;
    const missing = window.emergencyTest.emit({ type: 'fire.assessed', assessment });
    window.emergencyTest.emit({ type: 'drone.observed', droneId: 'DRONE-01' });
    const partial = window.emergencyTest.emit({ type: 'fire.assessed', assessment });
    window.emergencyTest.prepare(1, 2, false);
    await service.confirm();
    return { before, missing, partial, after: service.getSnapshot(), commands: window.emergencyTest.commands, mode: service.traffic.signals.getMode() };
  });
  expect(denied.missing.accepted).toBe(false); expect(denied.partial.accepted).toBe(false);
  expect(denied.commands).toEqual([]); expect(denied.mode).toBe('normal');
  await expect(page.locator('[data-fire-truck][data-status="idle"]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '确认并执行方案', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${output}/f4-observation-blocked.png`, fullPage: true });
  await page.evaluate(() => {
    window.emergencyTest.emit({ type: 'drone.observed', droneId: 'DRONE-02' });
    window.emergencyTest.prepare(1, 2, false);
  });
  await expect(page.getByRole('button', { name: '确认并执行方案', exact: true })).toBeEnabled();
  await page.screenshot({ path: `${output}/f4-observed-plan-allowed.png`, fullPage: true });
  await page.getByRole('button', { name: '确认并执行方案', exact: true }).click();
  await expect(page.locator('[data-fire-truck][data-status="en-route"]')).toHaveCount(1);
  await writeFile(`${output}/f4-observation-gate.json`, JSON.stringify({ passed: true, denied, confirmed: await page.evaluate(() => window.emergencyTest.commands) }, null, 2));
});
