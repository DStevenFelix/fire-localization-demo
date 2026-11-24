import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { startWithPrediction } from './predictionFixture';

async function ready(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?workspace=bridge-demo');
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
  await expect(page.getByTestId('truth-marker')).toBeVisible();
  await expect(page.getByRole('region', { name: '火情沙盘地图', exact: true }).getByText('0 批 · 0 / 0 条', { exact: true })).toBeVisible();
}

async function verifyOverlay(page: Page, withPrediction = true) {
  const measured = await page.getByTestId('sandbox-svg').evaluate(svg => {
    const image = svg.querySelector('[data-layer="original-map"]')!.getBoundingClientRect();
    const truth = svg.querySelector('[data-testid="truth-marker"] circle')!;
    const finalMarker = svg.querySelector('[data-testid="prediction-marker"]');
    const prediction = finalMarker?.querySelector('circle');
    const predictedPoi = finalMarker && svg.querySelector(`[data-poi="${finalMarker.getAttribute('data-poi-id')}"] circle`);
    const poi = svg.querySelector('[data-poi="T-SW-01"] circle')!;
    const center = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const coordinates = (element: Element | null) => element && ['cx', 'cy'].map(name => Number(element.getAttribute(name)));
    return { aspect: image.width / image.height, truth: center(truth), poi: center(poi), truthSvg: coordinates(truth), poiSvg: coordinates(poi),
      prediction: prediction ? center(prediction) : null, predictedPoi: predictedPoi ? center(predictedPoi) : null,
      predictionSvg: coordinates(prediction ?? null), predictedPoiSvg: coordinates(predictedPoi) };
  });
  expect(measured.aspect).toBeCloseTo(1313 / 1050, 4);
  expect(measured.truthSvg).toEqual(measured.poiSvg);
  expect(measured.truth.x).toBeCloseTo(measured.poi.x, 3);
  expect(measured.truth.y).toBeCloseTo(measured.poi.y, 3);
  if (withPrediction) {
    expect(measured.predictionSvg).toEqual(measured.predictedPoiSvg);
    expect(measured.prediction!.x).toBeCloseTo(measured.predictedPoi!.x, 3);
    expect(measured.prediction!.y).toBeCloseTo(measured.predictedPoi!.y, 3);
  }
}

test('streaming prediction, measured map, layers, zoom, reset and refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await expect(page.locator('g[data-poi]')).toHaveCount(29);
  await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', 'T-SW-01');
  const truth = page.getByTestId('truth-marker').locator('circle');
  expect(Number(await truth.getAttribute('cx'))).toBeCloseTo(1738.32394, 1);
  expect(Number(await truth.getAttribute('cy'))).toBeCloseTo(1722.641, 1);
  await page.locator('[data-poi="T-SW-02"]').hover();
  await expect(page.locator('.poi-tooltip')).toContainText('华安能源西南罐区2号储罐');
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await page.getByLabel('POI', { exact: true }).uncheck();
  await expect(page.locator('g[data-poi]')).toHaveCount(0);
  await page.getByLabel('POI', { exact: true }).check();
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await page.getByRole('button', { name: '放大地图' }).click();
  expect(Number(await truth.getAttribute('cx'))).toBeCloseTo(1738.32394, 1);
  await page.getByTestId('sandbox-svg').hover();
  await page.mouse.wheel(0, -100);
  await page.getByRole('button', { name: '重置地图视图' }).click();
  await expect(page.getByTestId('sandbox-svg')).toHaveAttribute('viewBox', '1313 1050 1313 1050');
  await startWithPrediction(page);
  await expect(page.getByTestId('evidence-marker').first()).toBeVisible();
  await expect(page.locator('.candidate-row')).toHaveCount(3);
  await page.getByRole('button', { name: '移交应急处置' }).click();
  await expect(page.getByTestId('emergency-phase')).toHaveText('无人机巡查候选');
  await expect(page.locator('[data-recon-stage=assigned]')).toHaveCount(3);
  await expect(page.getByTestId('emergency-plan')).toHaveCount(0);
  await expect(page.getByTestId('prediction-marker')).toBeVisible();
  await expect(page.getByRole('region', { name: '火情沙盘地图', exact: true }).getByText('1 批 · 3 / 3 条', { exact: true })).toBeVisible();
  await expect(page.getByTestId('truth-marker').locator('text')).toHaveText('Ground Truth');
  await expect(page.getByTestId('prediction-marker').locator('text')).toHaveText('最终定位 · Top1');
  await verifyOverlay(page);
  await page.getByRole('button', { name: /^高亮候选 2 / }).click();
  await expect(page.getByTestId('candidate-marker')).toBeVisible();
  const directory = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/existing/` : fileURLToPath(new URL('../screenshots/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/offline-candidate-1440.png`, fullPage: true });
  await page.getByRole('button', { name: /^高亮候选 1 / }).click();
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
  await page.getByRole('button', { name: '全局重置' }).click();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('[data-drone][data-status="idle"]')).toHaveCount(2);
  await expect(page.locator('[data-drone-path][points=""], [data-truck-path][points=""]')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await page.getByLabel('火情场景').selectOption('T-SE-01');
  await page.getByRole('button', { name: '关闭仿真设置' }).click();
  await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', 'T-SE-01');
  await page.reload({ waitUntil: 'domcontentloaded' });
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
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await page.getByRole('button', { name: 'Live 付费模型', exact: true }).click();
  await page.getByRole('button', { name: '关闭仿真设置' }).click();
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始仿真', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('SocialNet 会调用已配置的模型');
  await expect(page.getByRole('dialog')).toContainText('每 3 条');
  await expect(page.getByRole('button', { name: '确认并开始仿真' })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(runs).toBe(0);
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
});

test('empty result displays no red prediction', async ({ page }) => {
  await ready(page);
  await startWithPrediction(page, session => ({ ...session, status: 'completed', prediction: { ...session.prediction!, candidates: [], status: 'no_active_evidence' } }));
  await expect(page.getByText('当前没有定位候选')).toBeVisible();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
});

test('wrong prediction stays at its actual returned coordinates', async ({ page }) => {
  await ready(page);
  await startWithPrediction(page, session => {
    session.analysis_frozen = true;
    session.prediction!.candidates[0] = { ...session.prediction!.candidates[0], poi_id: 'T-SE-01',
      name: '华安能源东南罐区1号储罐', coordinates: { x_m: 47.446646, y_m: 33.960915 } };
    session.evaluation = { top1_hit: false, top3_hit: false, target_rank: null, distance_m: 5.243 };
    return session;
  });
  await expect(page.getByTestId('prediction-marker')).toHaveAttribute('data-poi-id', 'T-SE-01', { timeout: 30000 });
  await expect(page.getByText('未命中真实火点', { exact: true })).toBeVisible();
  const circle = page.getByTestId('prediction-marker').locator('circle').first();
  expect(Number(await circle.getAttribute('cx'))).toBeCloseTo(2076.58154, 1);
  expect(Number(await circle.getAttribute('cy'))).toBeCloseTo(1723.642, 1);
  expect(Number(await page.getByTestId('truth-marker').locator('circle').getAttribute('cx'))).toBeCloseTo(1738.32394, 1);
});

test('worker errors expose a sanitized error state and permit reset', async ({ page }) => {
  await ready(page);
  await startWithPrediction(page, session => ({ ...session, status: 'failed', prediction: null, evaluation: null,
    error: { error_type: 'RuntimeError', message: '测试异常状态，运行模式未切换。' } }));
  await page.locator('.run-error summary').click();
  await expect(page.getByText('RuntimeError', { exact: true })).toBeVisible();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
  await page.getByRole('button', { name: '全局重置' }).click();
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeEnabled();
});

test('unavailable bridge has an explicit error and disabled run', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '测试桥接服务不可用' }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('桥接服务未连接');
  await expect(page.getByRole('button', { name: '开始仿真', exact: true })).toBeDisabled();
  await expect(page.getByTestId('prediction-marker')).toHaveCount(0);
});
