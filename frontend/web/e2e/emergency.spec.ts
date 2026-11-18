import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectMock } from './emergencyDriver';
import type { SceneActorSnapshot } from '../src/types';

declare global { interface Window { emergencyFrame: { fire: boolean; smoke: boolean; actors: { id: string; position: number[]; heading: number; status: string; visible: boolean; water: boolean }[] }; emergencyActors: readonly SceneActorSnapshot[] } }
const screenshots = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/existing/phase3/` : fileURLToPath(new URL('../screenshots/phase3/', import.meta.url));
async function ready(page: Page) {
  await page.route('**/src/components/FireScene3D.tsx*', async route => {
    const response = await route.fetch(), body = await response.text();
    const observed = body.replace('renderer.render(scene, camera);', `
      window.emergencyActors = latest.current.actors.current;
      window.emergencyFrame = { fire: scene.getObjectByName('fire')?.visible ?? false,
        smoke: scene.getObjectByName('smoke-plume')?.children.some(p => p.visible) ?? false,
        actors: scene.getObjectByName('actors')?.children.map(actor => ({ id: actor.name, position: actor.position.toArray(),
          heading: actor.children[0]?.children[0]?.rotation.y ?? 0, status: actor.userData.status, visible: actor.visible,
          water: actor.getObjectByName('water')?.visible ?? false })) ?? [] };
      renderer.render(scene, camera);`);
    expect(observed).not.toBe(body); await route.fulfill({ response, body: observed });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await mkdir(screenshots, { recursive: true });
}
async function snapshot(page: Page, name: string) { await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true }); }
async function advance(page: Page, seconds: number) {
  await page.evaluate(async seconds => {
    const path = '/src/utils/emergency.ts', api = await import(path);
    const sim = api.getEmergencyService().traffic;
    for (let time = 0; time < seconds; time += .1) sim.tick(Math.min(.1, seconds - time));
  }, seconds);
}

test('complete external emergency lifecycle, synchronized drones, confirmation, extinction and safe return', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect(page.locator('[data-drone]')).toHaveCount(2);
  await expect(page.locator('[data-drone][data-status="idle"]')).toHaveCount(2);
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'normal');
  await expect(page.getByLabel('火情等级', { exact: true })).toHaveCount(0);
  await snapshot(page, '01-idle');
  await connectMock(page, 2, 3, true);
  await expect(page.getByTestId('emergency-plan')).toHaveCount(0);
  await advance(page, 2);
  await snapshot(page, '02-drones-flying');
  await advance(page, 15);
  await expect.poll(() => page.evaluate(() => window.emergencyFrame.actors.filter(a => a.id.startsWith('DRONE') && a.visible).length)).toBe(2);
  const drones = await page.locator('[data-drone]').evaluateAll(nodes => nodes.map(n => ({ id: n.getAttribute('data-drone'),
    x: Number(n.getAttribute('data-x')), y: Number(n.getAttribute('data-y')), altitude: Number(n.getAttribute('data-altitude')), heading: Number(n.getAttribute('data-heading')) })));
  const frame = await page.evaluate(() => window.emergencyFrame);
  drones.forEach(d => {
    const actor = frame.actors.find(a => a.id === d.id)!;
    expect(actor.position[0]).toBeCloseTo((d.x - 30) * 1312 / 30 - 656, 3);
    expect(actor.position[2]).toBeCloseTo(524.5 - (d.y - 25) * 1049 / 25, 3);
    expect(actor.position[1]).toBe(d.altitude); expect(actor.heading).toBeCloseTo(d.heading, 6);
  });
  await page.evaluate(() => ['DRONE-01', 'DRONE-02'].forEach(droneId => window.emergencyTest.emit({ type: 'drone.observed', droneId })));
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'observing');
  await page.evaluate(() => window.emergencyTest.prepare(2, 3, false));
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'awaiting_confirmation');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/03-drones-3d-large-fire.png` });
  await expect(page.getByTestId('emergency-plan')).toContainText('2 辆消防车');
  await expect(page.getByTestId('emergency-plan')).toContainText('EXT-FIRE-VEHICLE-');
  await expect(page.locator('[data-fire-truck][data-status="idle"]')).toHaveCount(3);
  await snapshot(page, '04-plan-awaiting-confirmation');
  await page.getByRole('button', { name: '确认并执行方案', exact: true }).click();
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'fire_trucks_dispatched');
  await expect(page.getByText('消防沿线信号优先 · 冲突方向停车 · 其余路口正常运行', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await page.getByLabel('交通信号灯', { exact: true }).check();
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await advance(page, 2);
  expect(await page.locator('[data-signal-state="green"]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-emergency-priority="true"]').count()).toBeLessThan(await page.locator('[data-intersection]').count());
  await snapshot(page, '05-city-lockdown');
  await advance(page, 200);
  await expect(page.locator('[data-fire-truck][data-status="arrived"]')).toHaveCount(2);
  await snapshot(page, '06-trucks-arrived');
  await page.evaluate(() => window.emergencyTest.commands.filter(c => c.type === 'plan.confirm').forEach(command => {
    if (command.type !== 'plan.confirm') return;
    command.plan.dispatches.forEach(d => { window.emergencyTest.emit({ type: 'truck.arrived', vehicleId: d.vehicleId }); window.emergencyTest.emit({ type: 'truck.extinguishing', vehicleId: d.vehicleId }); });
  }));
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguishing');
  await expect.poll(() => page.evaluate(() => window.emergencyFrame.actors.some(a => a.water))).toBe(true);
  await snapshot(page, '07-extinguishing');
  await page.evaluate(() => { window.emergencyTest.emit({ type: 'fire.extinguished' }); window.emergencyTest.emit({ type: 'fire.extinguished' }); });
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'extinguished');
  await expect.poll(() => page.evaluate(() => window.emergencyFrame.fire)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.emergencyFrame.smoke)).toBe(false);
  await snapshot(page, '08-extinguished');
  await expect(page.locator('.traffic-lockdown-status')).toHaveCount(0);
  await advance(page, 2);
  expect(await page.locator('[data-signal-state="green"]').count()).toBeGreaterThan(0);
  await snapshot(page, '09-traffic-restored-returning');
  await expect(page.locator('[data-drone][data-status="returning"]')).toHaveCount(2);
  await snapshot(page, '10-responders-returning');
  await advance(page, 900);
  await page.evaluate(() => window.emergencyTest.dockDrones());
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'completed');
  await expect(page.locator('[data-fire-truck][data-status="idle"]')).toHaveCount(3);
  await snapshot(page, '11-completed');
  const commands = await page.evaluate(() => window.emergencyTest.commands.map(c => ({ type: c.type, commandId: c.commandId })));
  const phases = await page.evaluate(() => window.emergencyTest.phases);
  const milestones = ['fire_detected', 'drone_dispatched', 'observing', 'assessment_completed', 'awaiting_confirmation',
    'traffic_lockdown', 'fire_trucks_dispatched', 'fire_trucks_arrived', 'extinguishing', 'extinguished', 'traffic_restored', 'returning', 'completed'];
  expect(phases).toEqual(expect.arrayContaining(milestones));
  expect(milestones.map(phase => phases.indexOf(phase))).toEqual(milestones.map(phase => phases.indexOf(phase)).sort((a, b) => a - b));
  expect(commands.filter(c => c.type === 'plan.confirm')).toHaveLength(1);
  expect(commands.filter(c => c.type === 'responders.return')).toHaveLength(1);
  await writeFile(`${screenshots}/demonstration.json`, JSON.stringify({ commands, phases, drones, errors }, null, 2));
  expect(errors).toEqual([]);
});

test('cancellation and delayed or malformed external events preserve a usable responsive page', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page); await connectMock(page, 1, 1);
  await page.getByRole('button', { name: '取消执行', exact: true }).click();
  await expect(page.getByRole('region', { name: '应急联动指挥' })).toContainText('方案已取消');
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'assessment_completed');
  await advance(page, 20); await expect(page.locator('[data-fire-truck][data-status="idle"]')).toHaveCount(3);
  expect(await page.evaluate(() => window.emergencyTest.commands)).toHaveLength(0);
  await page.evaluate(() => window.emergencyTest.raw({ type: 'drone.update', drone: { position: { x: NaN } } }));
  await expect(page.getByRole('region', { name: '应急联动指挥' }).getByRole('alert')).toContainText('应急数据格式无效');
  await page.evaluate(() => window.emergencyTest.emit({ type: 'operation.failed', operation: 'assessment', message: '侦察影像连接中断' }));
  await expect(page.getByRole('region', { name: '应急联动指挥' })).toContainText('侦察影像连接中断');
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 1000 }, { width: 1366, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const clipped = await page.locator('.emergency-card,.fire-scene-card,.control-card').evaluateAll(elements => elements.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
    expect(clipped).toEqual([]);
    await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
    await snapshot(page, `responsive-${viewport.width}`);
  }
  expect(errors).toEqual([]);
});
