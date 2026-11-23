import { startWithPrediction } from './predictionFixture';
import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assess, connectMock } from './emergencyDriver';

declare global {
  interface Window { sceneLifecycle: { frames: number; observers: number; contextsLost: number; stacks: string[] } }
  interface Window { sceneFrame: { camera: number[]; aspect: number; projectionAspect: number; fireTarget: string; effects: { visible: boolean; severity: number; size: number; smokeCount: number; smokeOpacity: number; heat: number; geometries: number }; actors: { id: string; position: number[]; visible: boolean; status: string; water: boolean }[] } }
}

const screenshots = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/existing/` : fileURLToPath(new URL('../screenshots/', import.meta.url));
const sceneTanks: { id: string }[] = JSON.parse(readFileSync(new URL('../../../fire_poi/fire_sandbox_spatial_model.json', import.meta.url), 'utf8')).pois.filter((poi: { entity_type: string }) => poi.entity_type === 'Tank');

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-texture', 'ready');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).scrollIntoViewIfNeeded();
}

async function observeScene(page: Page) {
  // Observe the actual graph at the render call without adding an app debug API.
  await page.route('**/src/components/FireScene3D.tsx*', async route => {
    const response = await route.fetch();
    const body = await response.text();
    const observed = body.replace('renderer.render(scene, camera);', `
      window.sceneFrame = { camera: camera.position.toArray(), aspect: camera.aspect,
        projectionAspect: camera.projectionMatrix.elements[5] / camera.projectionMatrix.elements[0], fireTarget: scene.getObjectByName('fire')?.userData.targetId ?? '',
        effects: { visible: scene.getObjectByName('fire')?.visible ?? false,
          severity: scene.getObjectByName('fire')?.userData.severity ?? 0,
          size: scene.getObjectByName('flame-plume')?.scale.x ?? 0,
          smokeCount: scene.getObjectByName('smoke-plume')?.children.filter(puff => puff.visible).length ?? 0,
          smokeOpacity: Math.max(0, ...(scene.getObjectByName('smoke-plume')?.children.map(puff => puff.material.uniforms.opacity.value) ?? [])),
          heat: scene.getObjectByName('heat-light')?.intensity ?? 0,
          geometries: renderer.info.memory.geometries },
        actors: scene.getObjectByName('actors')?.children.map(actor => ({ id: actor.name, position: actor.position.toArray(), visible: actor.visible,
          status: actor.userData.status, water: actor.getObjectByName('water')?.visible ?? false })) ?? [] };
      renderer.render(scene, camera);`);
    expect(observed).not.toBe(body);
    await route.fulfill({ response, body: observed });
  });
}

async function settledCamera(page: Page) {
  let previous: number[] | null = null;
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.sceneFrame.camera);
    const delta = previous ? Math.hypot(...current.map((value, i) => value - previous![i])) : Infinity;
    previous = current;
    return delta;
  }, { intervals: [100] }).toBeLessThan(.02);
  return previous!;
}

test('eight live scenarios, unchanged map geometry, 3D controls and responsive layout', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await observeScene(page);
  await ready(page);
  const scene = page.getByTestId('fire-scene-canvas');
  await mkdir(screenshots, { recursive: true });
  // Snapshot after the camera settles; flames remain animated.
  await expect(scene).toHaveAttribute('data-target-id', 'T-SW-01');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/fire-scene-default.png` });
  const mapBox = await page.locator('.map-canvas').boundingBox();
  // Layout dimensions are quantized to 1/64 of a CSS pixel.
  expect(Math.abs(mapBox!.height - mapBox!.width * 1050 / 1313)).toBeLessThanOrEqual(1 / 64);
  expect(await page.locator('.map-canvas').evaluate(element => getComputedStyle(element).aspectRatio)).toBe('1313 / 1050');
  const initialView = await page.getByTestId('sandbox-svg').getAttribute('viewBox');
  for (const tank of sceneTanks) {
    await page.reload();
    await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '仿真设置', exact: true }).click();
    await page.getByLabel('火情场景').selectOption(tank.id);
    await page.getByRole('button', { name: '关闭仿真设置' }).click();
    await assess(page, tank.id);
    await expect(scene).toHaveAttribute('data-target-id', tank.id);
    await expect(scene).toHaveAttribute('data-rendered', 'true');
    await expect.poll(() => page.evaluate(() => window.sceneFrame.fireTarget)).toBe(tank.id);
    expect(await page.evaluate(() => window.sceneFrame.effects.visible)).toBe(true);
    await settledCamera(page);
    await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/fire-visual-${tank.id}.png` });
    await expect(page.getByRole('region', { name: '火场信息', exact: true })).toContainText(tank.id);
    const after = (await page.locator('.map-canvas').boundingBox())!;
    expect(after.width).toBe(mapBox!.width);
    expect(after.height).toBe(mapBox!.height);
    await expect(page.getByTestId('sandbox-svg')).toHaveAttribute('viewBox', initialView!);
  }
  await page.getByRole('region', { name: '三维火场展示', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/fire-scene-southeast.png` });
  await page.getByRole('button', { name: '复位三维视角' }).click();
  const canvas = scene.locator('canvas');
  const box = (await canvas.boundingBox())!;
  const normal = await canvas.screenshot();
  const initialCamera = await settledCamera(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 65, box.y + box.height / 2 + 20, { steps: 10 });
  await page.mouse.up();
  expect(Buffer.compare(normal, await canvas.screenshot())).not.toBe(0);
  const rotated = await settledCamera(page);
  expect(Math.hypot(...rotated.map((value, i) => value - initialCamera[i]))).toBeGreaterThan(10);
  await page.mouse.wheel(0, -180);
  const zoomed = await settledCamera(page);
  expect(Math.hypot(...zoomed.map((value, i) => value - rotated[i]))).toBeGreaterThan(10);
  await page.getByRole('button', { name: '复位三维视角' }).click();
  const resetCamera = await settledCamera(page);
  expect(Math.hypot(...resetCamera.map((value, i) => value - initialCamera[i]))).toBeLessThan(.1);
  expect(await page.getByRole('button', { name: /测试|调试|切换状态/ }).count()).toBe(0);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1920, height: 1080 }, { width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => canvas.evaluate(element => Math.abs(element.getBoundingClientRect().width / element.getBoundingClientRect().height - (innerWidth <= 540 ? 4 / 3 : 16 / 9)))).toBeLessThan(.001);
    const dimensions = await canvas.evaluate((element: HTMLCanvasElement) => {
      const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect();
      return { width: box.width, height: box.height, parentWidth: parent.width, parentHeight: parent.height,
        bufferWidth: element.width, bufferHeight: element.height, dpr: Math.min(devicePixelRatio, 1.75) };
    });
    expect(Math.abs(dimensions.width - dimensions.parentWidth)).toBeLessThanOrEqual(1 / 64);
    expect(Math.abs(dimensions.height - dimensions.parentHeight)).toBeLessThanOrEqual(1 / 64);
    expect(Math.abs(dimensions.bufferWidth - dimensions.width * dimensions.dpr)).toBeLessThanOrEqual(1);
    expect(Math.abs(dimensions.bufferHeight - dimensions.height * dimensions.dpr)).toBeLessThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => Math.abs(window.sceneFrame.aspect - document.querySelector('.fire-scene-canvas')!.getBoundingClientRect().width / document.querySelector('.fire-scene-canvas')!.getBoundingClientRect().height))).toBeLessThan(1e-10);
    const projection = await page.evaluate(() => window.sceneFrame);
    expect(Math.abs(projection.projectionAspect - projection.aspect)).toBeLessThan(1e-10);
  }
  expect(errors).toEqual([]);
});

test('real SVG truck positions reach the 3D view without moving the fire to an incorrect prediction', async ({ page }) => {
  test.setTimeout(90000);
  await observeScene(page);
  await ready(page);
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await connectMock(page, 1);
  await startWithPrediction(page, session => {
    session.analysis_frozen = true;
    session.prediction!.candidates[0] = { ...session.prediction!.candidates[0], poi_id: 'T-SE-01',
      name: '华安能源东南罐区1号储罐', coordinates: { x_m: 47.446646, y_m: 33.960915 } };
    session.evaluation = { top1_hit: false, top3_hit: false, target_rank: null, distance_m: 5.243 };
    return session;
  });
  await expect(page.getByTestId('prediction-marker')).toHaveAttribute('data-poi-id', 'T-SE-01');
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-target-id', 'T-SW-01');
  await page.getByRole('button', { name: '确认并执行方案', exact: true }).click();
  await expect(page.locator('[data-fire-truck][data-status="en-route"]')).toHaveCount(1);
  // The existing road simulation is allowed to run faster through its own UI.
  await page.getByLabel('仿真倍速').selectOption('2');
  await page.getByRole('button', { name: '继续仿真', exact: true }).click();
  await expect(page.locator('[data-fire-truck][data-status="arrived"]')).toHaveCount(1, { timeout: 40000 });
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  const svgTrucks = await page.locator('[data-fire-truck]').evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute('data-actor'), x: Number(element.getAttribute('data-x')), y: Number(element.getAttribute('data-y')), status: element.getAttribute('data-status'),
  })));
  await expect.poll(() => page.evaluate(() => window.sceneFrame.actors.filter(actor => actor.status === 'arrived').length)).toBe(1);
  const frame = await page.evaluate(() => window.sceneFrame);
  expect(frame.fireTarget).toBe('T-SW-01');
  svgTrucks.map(svg => {
    const model = frame.actors.find(actor => actor.id === svg.id)!;
    expect(model.position[0]).toBeCloseTo((svg.x - 30) * 1312 / 30 - 656, 2);
    expect(model.position[2]).toBeCloseTo(524.5 - (svg.y - 25) * 1049 / 25, 2);
    expect(model.status).toBe(svg.status);
    // Arrival is independent from the external start-of-extinguishing event.
    expect(model.water).toBe(false);
  });
  await expect(page.getByTestId('fire-scene-canvas')).toHaveAttribute('data-status', 'burning');
});

test('component lifecycle cancels frames, disconnects resize, releases WebGL, and supports controlled states', async ({ page }) => {
  await page.context().grantPermissions(['local-network-access'], { origin: 'http://127.0.0.1:5173' });
  await page.addInitScript(() => {
    const active = new Map<number, string>();
    const originalFrame = requestAnimationFrame.bind(window);
    const originalCancel = cancelAnimationFrame.bind(window);
    const counters = { frames: 0, observers: 0, contextsLost: 0, stacks: [] as string[] };
    Object.assign(window, { sceneLifecycle: counters });
    window.requestAnimationFrame = callback => {
      // Scope the counter to this component; Playwright also polls with RAF.
      const own = callback.name === 'render';
      const id = originalFrame(time => { active.delete(id); counters.frames = active.size; counters.stacks = [...active.values()]; callback(time); });
      if (own) active.set(id, new Error().stack ?? '');
      counters.frames = active.size;
      counters.stacks = [...active.values()];
      return id;
    };
    window.cancelAnimationFrame = id => { active.delete(id); counters.frames = active.size; counters.stacks = [...active.values()]; originalCancel(id); };
    const OriginalObserver = ResizeObserver;
    window.ResizeObserver = class extends OriginalObserver {
      constructor(callback: ResizeObserverCallback) { super(callback); counters.observers++; }
      disconnect() { counters.observers--; super.disconnect(); }
    };
    const originalGetExtension = WebGL2RenderingContext.prototype.getExtension;
    Object.defineProperty(WebGL2RenderingContext.prototype, 'getExtension', { value: function(this: WebGL2RenderingContext, name: string) {
      const extension: unknown = Reflect.apply(originalGetExtension, this, [name]);
      if (name !== 'WEBGL_lose_context' || !extension) return extension;
      const context = extension as WEBGL_lose_context;
      return { loseContext: () => { counters.contextsLost++; context.loseContext(); }, restoreContext: () => context.restoreContext() };
    } });
  });
  await page.route('**/scene-harness', async route => {
    const response = await route.fetch({ url: 'http://127.0.0.1:5173/' });
    // 替换入口时移除 main 的时间戳，统一测试模块 URL，避免创建两个 React 根。
    await route.fulfill({ response, body: (await response.text()).replace(/\/src\/main\.tsx(?:\?[^"\s]*)?/, '/e2e/sceneHarness.tsx') });
  });
  await observeScene(page);
  await page.goto('/scene-harness');
  const scene = page.getByTestId('fire-scene-canvas');
  await expect(scene).toHaveAttribute('data-rendered', 'true');
  for (const status of ['normal', 'burning', 'extinguishing', 'extinguished']) {
    await page.evaluate(status => postMessage({ type: 'scene-input', input: { targetId: 'T-NW-02', status } }, location.origin), status);
    await expect(scene).toHaveAttribute('data-status', status);
  }
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => window.sceneLifecycle.frames)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.sceneLifecycle)).toMatchObject({ frames: 1 });
  await page.evaluate(() => postMessage({ type: 'scene-unmount' }, location.origin));
  await expect(scene.locator('canvas')).toHaveCount(0);
  const counters = await page.evaluate(() => window.sceneLifecycle);
  expect(counters.frames).toBe(0);
  expect(counters.observers).toBe(0);
  expect(counters.contextsLost).toBeGreaterThanOrEqual(2); // StrictMode mount/cleanup, then actual unmount.
});

test('visual levels use the actual severity control, animate smoothly and show controlled extinction', async ({ page }) => {
  test.setTimeout(90000);
  await page.context().grantPermissions(['local-network-access'], { origin: 'http://127.0.0.1:5173' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await observeScene(page);
  await ready(page);
  await mkdir(screenshots, { recursive: true });
  const samples: Window['sceneFrame']['effects'][] = [];
  for (const [severity, label] of [['1', 'small'], ['2', 'medium'], ['3', 'large']]) {
    await assess(page, 'T-SW-01', Number(severity) as 1 | 2 | 3);
    await expect.poll(() => page.evaluate(() => window.sceneFrame.effects.severity)).toBe(Number(severity));
    await settledCamera(page);
    let previous = 0;
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.sceneFrame.effects.size);
      const delta = Math.abs(current - previous);
      previous = current;
      return delta;
    }, { intervals: [150] }).toBeLessThan(.001);
    samples.push(await page.evaluate(() => window.sceneFrame.effects));
    await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/fire-visual-${label}.png` });
  }
  expect(samples[1].size).toBeGreaterThan(samples[0].size * 1.5);
  expect(samples[2].size).toBeGreaterThan(samples[1].size * 1.2);
  expect(samples[2].smokeCount).toBeGreaterThan(samples[0].smokeCount);
  expect(samples[2].smokeOpacity).toBeGreaterThan(samples[0].smokeOpacity);
  expect(samples[2].geometries).toBe(samples[0].geometries);
  const canvas = page.getByTestId('fire-scene-canvas').locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 + 15, { steps: 12 });
  await page.mouse.up();
  await settledCamera(page);
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/fire-visual-large-orbit.png` });
  const frameTimes = await page.evaluate(() => new Promise<number[]>(resolve => {
    const samples: number[] = [];
    let previous: number | null = null;
    const sample = (now: number) => {
      if (previous !== null) samples.push(now - previous);
      previous = now;
      if (samples.length === 60) { resolve(samples); return; }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
  await test.info().attach('large-fire-frame-intervals', { body: JSON.stringify(frameTimes), contentType: 'application/json' });
  await page.route('**/scene-harness', async route => {
    const response = await route.fetch({ url: 'http://127.0.0.1:5173/' });
    await route.fulfill({ response, body: (await response.text()).replace(/\/src\/main\.tsx(?:\?[^"\s]*)?/, '/e2e/sceneHarness.tsx') });
  });
  await page.goto('/scene-harness');
  const scene = page.getByTestId('fire-scene-canvas');
  await expect(scene).toHaveAttribute('data-rendered', 'true');
  await page.evaluate(() => postMessage({ type: 'scene-input', input: { targetId: 'T-SW-01', status: 'burning', severity: 3 } }, location.origin));
  await expect.poll(() => page.evaluate(() => window.sceneFrame.effects.size)).toBeGreaterThan(1.2);
  const before = await page.evaluate(() => window.sceneFrame.effects);
  await page.evaluate(() => postMessage({ type: 'scene-input', input: { targetId: 'T-SW-01', status: 'extinguishing', severity: 3 } }, location.origin));
  await expect.poll(() => page.evaluate(() => window.sceneFrame.effects.size)).toBeLessThan(before.size * .65);
  await expect(scene).toHaveAttribute('data-status', 'extinguishing');
  await expect.poll(() => page.evaluate(() => window.sceneFrame.effects.smokeOpacity)).toBeLessThan(before.smokeOpacity * .5);
  await page.evaluate(() => postMessage({ type: 'scene-input', input: { targetId: 'T-SW-01', status: 'extinguished', severity: 3 } }, location.origin));
  await expect.poll(() => page.evaluate(() => window.sceneFrame.effects.visible)).toBe(false);
  expect(await page.evaluate(() => window.sceneFrame.effects.heat)).toBe(0);
  await expect(page.getByRole('region', { name: '火场信息', exact: true })).toContainText('已扑灭');
  await page.getByRole('region', { name: '三维火场展示', exact: true }).screenshot({ path: `${screenshots}/fire-visual-extinguished.png` });
  await page.evaluate(() => postMessage({ type: 'scene-input', input: { targetId: 'T-SW-01', status: 'normal', severity: 3 } }, location.origin));
  await expect(scene).toHaveAttribute('data-status', 'normal');
  expect(await page.evaluate(() => window.sceneFrame.effects.visible)).toBe(false);
  expect(errors).toEqual([]);
});
