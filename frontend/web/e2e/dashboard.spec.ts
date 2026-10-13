import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
  await expect(page.getByTestId('truth-marker')).toBeVisible();
  await expect(page.getByTestId('run-button-state')).toHaveText('Ready');
}

async function verifyOverlay(page: Page, withPrediction = true) {
  const measured = await page.getByTestId('sandbox-svg').evaluate(svg => {
    const image = svg.querySelector('image')!.getBoundingClientRect();
    const truth = svg.querySelector('[data-testid="truth-marker"] circle')!;
    const prediction = svg.querySelector('[data-testid="prediction-marker"] circle');
    const poi = svg.querySelector('[data-poi="POI-HA-SW-02"] circle')!;
    const center = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    return { aspect: image.width / image.height, truth: center(truth), poi: center(poi),
      prediction: prediction ? center(prediction) : null };
  });
  expect(measured.aspect).toBeCloseTo(1707 / 1280, 4);
  expect(measured.truth.x).toBeCloseTo(measured.poi.x, 4);
  expect(measured.truth.y).toBeCloseTo(measured.poi.y, 4);
  if (withPrediction) {
    expect(measured.prediction!.x).toBeCloseTo(measured.truth.x, 4);
    expect(measured.prediction!.y).toBeCloseTo(measured.truth.y, 4);
  }
}

test('real Offline prepare, run, measured map, layers, zoom, reset and refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', 'POI-HA-SW-02');
  const truth = page.getByTestId('truth-marker').locator('circle');
  expect(Number(await truth.getAttribute('cx'))).toBeCloseTo(678, 1);
  expect(Number(await truth.getAttribute('cy'))).toBeCloseTo(713, 1);
  await page.locator('[data-poi="POI-HA-SW-03"]').hover();
  await expect(page.locator('.poi-tooltip')).toContainText('成品2号储罐');
  await page.getByRole('button', { name: '显示或隐藏 POI' }).click();
  await expect(page.locator('g[data-poi]')).toHaveCount(0);
  await page.getByRole('button', { name: '显示或隐藏 POI' }).click();
  await page.getByRole('button', { name: '放大地图' }).click();
  expect(Number(await truth.getAttribute('cx'))).toBeCloseTo(678, 1);
  await page.getByTestId('sandbox-svg').hover();
  await page.mouse.wheel(0, -100);
  await page.getByRole('button', { name: '重置地图视图' }).click();
  await expect(page.getByTestId('sandbox-svg')).toHaveAttribute('viewBox', '0 0 1707 1280');
  await page.getByRole('button', { name: '坐标校准' }).click();
  await expect(page.getByRole('spinbutton', { name: '校准 left' })).toHaveValue('160');
  await page.getByRole('button', { name: '坐标校准' }).click();
  // A short network delay makes the running presentation observable even in Offline.
  await page.route('**/api/localization/run', async route => {
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.getByRole('button', { name: '开始定位', exact: true }).click();
  await expect(page.getByTestId('run-button-state')).toHaveText('Analyzing...');
  await expect(page.getByTestId('prediction-marker')).toBeVisible();
  await expect(page.getByTestId('top1-name')).toHaveText('成品1号储罐');
  await expect(page.locator('.candidate-row')).toHaveCount(3);
  await expect(page.getByTestId('truth-marker')).toBeVisible();
  await expect(page.getByTestId('prediction-marker')).toHaveAttribute('data-poi-id', 'POI-HA-SW-02');
  await expect(page.locator('.metrics-row')).toContainText('0.000');
  await expect(page.getByTestId('distance-error')).toHaveText('0.00m');
  await expect(page.getByTestId('run-button-state')).toHaveText('Completed');
  await expect(page.getByTestId('truth-marker').locator('text')).toHaveText('Ground Truth');
  await expect(page.getByTestId('prediction-marker').locator('text')).toHaveText('AI Prediction');
  const prediction = page.getByTestId('prediction-marker').locator('circle').first();
  expect(Number(await prediction.getAttribute('cx'))).toBeCloseTo(678, 1);
  expect(Number(await prediction.getAttribute('cy'))).toBeCloseTo(713, 1);
  const truthLabel = await page.getByTestId('truth-marker').locator('text').boundingBox();
  const predictionLabel = await page.getByTestId('prediction-marker').locator('text').boundingBox();
  expect(truthLabel!.y).toBeGreaterThan(predictionLabel!.y + predictionLabel!.height);
  await page.getByRole('button', { name: '高亮候选 2 成品2号储罐' }).click();
  await expect(page.getByTestId('candidate-marker')).toBeVisible();
  const directory = fileURLToPath(new URL('../screenshots/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const candidateLabel = await page.getByTestId('candidate-marker').locator('text').boundingBox();
  expect(candidateLabel!.x).toBeGreaterThan(truthLabel!.x + truthLabel!.width);
  await page.screenshot({ path: `${directory}/offline-candidate-1440.png`, fullPage: true });
  await page.getByRole('button', { name: '高亮候选 1 成品1号储罐' }).click();
  await expect(page.getByTestId('candidate-marker')).toHaveCount(0);
  await page.screenshot({ path: `${directory}/offline-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await verifyOverlay(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.prediction-breath').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.screenshot({ path: `${directory}/offline-1920.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1366, height: 900 });
  await verifyOverlay(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '重置演示' }).click();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
  await expect(page.getByTestId('run-button-state')).toHaveText('Ready');
  await page.getByLabel('火情场景').selectOption('POI-HA-SE-01');
  await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', 'POI-HA-SE-01');
  await page.reload();
  await expect(page.getByTestId('truth-marker')).toBeVisible();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyOverlay(page, false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${directory}/initial-mobile.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('Live requires explicit secondary confirmation; cancel makes no run request', async ({ page }) => {
  let runs = 0;
  page.on('request', request => { if (request.url().endsWith('/api/localization/run')) runs++; });
  await ready(page);
  await page.getByRole('button', { name: 'Live 付费模型', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始定位', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认并开始 Live' })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(runs).toBe(0);
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
});

test('empty result displays no red prediction', async ({ page }) => {
  await page.route('**/api/localization/**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === 'completed') {
      body.prediction.candidates = [];
      body.prediction.status = 'no_active_evidence';
      body.evaluation = { top1_hit: false, top3_hit: false, target_rank: null, distance_m: null };
    }
    await route.fulfill({ response, json: body });
  });
  await ready(page);
  await page.getByRole('button', { name: '开始定位', exact: true }).click();
  await expect(page.getByText('当前没有定位候选')).toBeVisible();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
});

test('wrong prediction stays at its actual returned coordinates', async ({ page }) => {
  await page.route('**/api/localization/**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === 'completed') {
      body.prediction.candidates[0] = { ...body.prediction.candidates[0], poi_id: 'POI-HA-SE-01', name: '原料1号储罐', coordinates: { x_m: 16.462, y_m: 10.759 } };
      body.evaluation = { top1_hit: false, top3_hit: false, target_rank: null, distance_m: 5.243 };
    }
    await route.fulfill({ response, json: body });
  });
  await ready(page);
  await page.getByRole('button', { name: '开始定位', exact: true }).click();
  await expect(page.getByTestId('prediction-marker')).toHaveAttribute('data-poi-id', 'POI-HA-SE-01');
  await expect(page.getByText('未命中真实火点', { exact: true })).toBeVisible();
  const circle = page.getByTestId('prediction-marker').locator('circle').first();
  expect(Number(await circle.getAttribute('cx'))).toBeCloseTo(920, 1);
  expect(Number(await circle.getAttribute('cy'))).toBeCloseTo(708, 1);
  expect(Number(await page.getByTestId('truth-marker').locator('circle').getAttribute('cx'))).toBeCloseTo(678, 1);
});

test('worker errors expose a sanitized error state and permit reset', async ({ page }) => {
  await page.route('**/api/localization/**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === 'completed') {
      body.status = 'failed'; body.prediction = null; body.evaluation = null;
      body.error = { error_type: 'RuntimeError', message: '测试异常状态，运行模式未切换。' };
    }
    await route.fulfill({ response, json: body });
  });
  await ready(page);
  await page.getByRole('button', { name: '开始定位', exact: true }).click();
  await page.locator('.run-error summary').click();
  await expect(page.getByText('RuntimeError', { exact: true })).toBeVisible();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await page.getByRole('button', { name: '重置演示' }).click();
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeEnabled();
});

test('unavailable bridge has an explicit error and disabled run', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '测试桥接服务不可用' }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('桥接服务未连接');
  await expect(page.getByRole('button', { name: '开始定位', exact: true })).toBeDisabled();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
});
