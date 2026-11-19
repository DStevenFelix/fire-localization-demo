import { expect, test, type Page } from '@playwright/test';
import type { Session, SessionPosts } from '../src/types';

declare global {
  interface Window {
    opinionSamples: { id: string; text: string; at: number; fits: boolean; signal: boolean }[];
  }
}

const postsPath = /\/api\/localization\/[0-9a-f]{32}\/posts$/;
const panel = (page: Page) => page.getByRole('region', { name: '舆情监测 Agent', exact: true });
const start = (page: Page) => page.getByRole('button', { name: '开始定位', exact: true });
const currentPost = (page: Page) => panel(page).locator('.opinion-entry-current');
const radar = (page: Page) => panel(page).locator('.opinion-radar');
const sweep = (page: Page) => radar(page).locator('.opinion-radar-sweep');
const signal = (page: Page) => radar(page).locator('.opinion-radar-signal');

test('real session plays all 100 posts once at the display cadence after localization completes', async ({ page }, testInfo) => {
  test.setTimeout(150000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const postResponse = page.waitForResponse(response => postsPath.test(response.url()) && response.ok());
  await page.goto('/');
  const data: SessionPosts = await (await postResponse).json();
  expect(data.post_count).toBe(100);
  await expect(panel(page).getByText('PUBLIC OPINION MONITORING', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('已展示 0 / 100', { exact: true })).toBeVisible();
  await expect(currentPost(page)).toHaveCount(0);
  await expect(radar(page)).toHaveAttribute('data-active', 'false');
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'paused');
  await expect(signal(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.opinionSamples = [];
    const viewport = document.querySelector('.opinion-viewport')!;
    let last: Element | null = null;
    let lastSignal: Element | null = null;
    new MutationObserver(() => {
      const post = viewport.querySelector('.opinion-entry-current');
      if (!post || post === last) return;
      last = post;
      const body = post.querySelector('.opinion-post-text')!;
      const signal = document.querySelector('.opinion-radar-signal');
      window.opinionSamples.push({
        id: post.querySelector('strong')!.textContent!,
        text: body.textContent!,
        at: performance.now(),
        fits: body.scrollHeight <= body.clientHeight,
        signal: signal !== null && signal !== lastSignal,
      });
      lastSignal = signal;
    }).observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/localization/run') && response.status() === 202);
  await start(page).click();
  const run: Session = await (await accepted).json();
  expect(run.session_id).toBe(data.session_id);
  await expect(currentPost(page).locator('strong')).toHaveText(data.posts[0].id);
  await expect(radar(page)).toHaveAttribute('data-active', 'true');
  await expect(sweep(page)).toHaveCSS('animation-duration', '4s');
  await expect(sweep(page)).toHaveCSS('animation-timing-function', 'linear');
  await expect(currentPost(page)).toHaveCSS('animation-duration', '0.35s');
  await expect(currentPost(page).locator('time')).toHaveAttribute('datetime', data.posts[0].timestamp);
  await expect(currentPost(page)).toContainText('发帖位置');
  await expect(currentPost(page)).toContainText(`紧急程度 · ${data.posts[0].urgency}`);
  await expect(currentPost(page).locator('strong')).toHaveText(data.posts[1].id);
  await expect(panel(page).locator('.opinion-entry-outgoing')).toHaveCSS('visibility', 'hidden');
  await expect(currentPost(page).locator('.opinion-post-text')).toHaveJSProperty('scrollTop', 0);
  await expect(page.getByTestId('run-button-state')).toHaveText('Completed');
  await expect(panel(page).getByText('播放中', { exact: true })).toBeVisible();
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'running');
  await expect.poll(() => sweep(page).evaluate(element => element.getAnimations()[0]?.effect?.getComputedTiming().currentIteration)).toBeGreaterThanOrEqual(1);
  await expect(panel(page).getByText('定位已处理 100 / 100 条 · 10 批', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('播放完成', { exact: true })).toBeVisible({ timeout: 120000 });
  await expect(panel(page).getByText('已展示 100 / 100', { exact: true })).toBeVisible();
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'paused');
  const stoppedAngle = await sweep(page).evaluate(element => getComputedStyle(element).transform);
  await page.waitForTimeout(1100);
  await expect(sweep(page)).toHaveCSS('transform', stoppedAngle);
  await expect(signal(page)).toHaveCSS('visibility', 'hidden');
  const samples = await page.evaluate(() => window.opinionSamples);
  expect(samples.map(({ id, text }) => ({ id, text }))).toEqual(data.posts.map(({ id, text }) => ({ id, text })));
  expect(samples.every(sample => sample.fits)).toBe(true);
  expect(samples.filter(sample => sample.signal)).toHaveLength(100);
  const intervals = samples.slice(1).map((sample, index) => sample.at - samples[index].at);
  expect(intervals.every(interval => interval >= 750 && interval <= 1500)).toBe(true);
  await testInfo.attach('replay-timing', {
    body: JSON.stringify({ count: samples.length, signalCount: samples.filter(sample => sample.signal).length,
      spanMs: samples.at(-1)!.at - samples[0].at, minIntervalMs: Math.min(...intervals), maxIntervalMs: Math.max(...intervals) }),
    contentType: 'application/json',
  });
  await testInfo.attach('radar-stopped', { body: await panel(page).screenshot(), contentType: 'image/png' });
});

test('accepted failure waits for the post response then replays and resets cleanly', async ({ page }) => {
  let releasePosts!: () => void;
  const gate = new Promise<void>(resolve => { releasePosts = resolve; });
  await page.route(postsPath, async route => {
    await gate;
    await route.continue();
  });
  await page.route('**/api/localization/run', async route => {
    const sessionId = route.request().postDataJSON().session_id;
    const session: Session = await (await page.request.get(`/api/localization/${sessionId}`)).json();
    await route.fulfill({ status: 202, json: { ...session, status: 'failed',
      error: { error_type: 'RuntimeError', message: '测试运行失败' } } });
  });
  await page.goto('/');
  await start(page).click();
  await expect(page.getByTestId('run-button-state')).toHaveText('Failed');
  await expect(panel(page).getByText('正在加载帖子', { exact: true })).toBeVisible();
  await expect(currentPost(page)).toHaveCount(0);
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'paused');
  releasePosts();
  await expect(panel(page).getByText('已展示 2 / 100', { exact: true })).toBeVisible();
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sweep(page)).toHaveCSS('animation-name', 'none');
  const next = page.waitForResponse(response => postsPath.test(response.url()) && response.ok());
  await page.getByRole('button', { name: '全局重置', exact: true }).click();
  await next;
  await expect(panel(page).getByText('等待定位启动', { exact: true })).toBeVisible();
  await page.waitForTimeout(1100);
  await expect(currentPost(page)).toHaveCount(0);
  await expect(radar(page)).toHaveAttribute('data-active', 'false');
  await expect(signal(page)).toHaveCount(0);
  await expect(panel(page).getByText('已展示 0 / 100', { exact: true })).toBeVisible();
});

test('canceled Live confirmation and rejected run leave the feed waiting', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/localization/run', async route => {
    requests++;
    await route.fulfill({ status: 409, json: { detail: '测试启动请求被拒绝' } });
  });
  await page.goto('/');
  await expect(start(page)).toBeEnabled();
  const settings = page.getByRole('button', { name: '仿真设置', exact: true });
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '仿真设置', exact: true });
  await expect(dialog.getByLabel('火情场景').locator('option')).toHaveCount(8);
  await expect(dialog).toContainText('GROUND TRUTH');
  await dialog.getByRole('button', { name: 'Live 付费模型', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
  await start(page).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(requests).toBe(0);
  await expect(panel(page).getByText('等待定位启动', { exact: true })).toBeVisible();
  await settings.click();
  await dialog.getByRole('button', { name: 'Offline 离线模拟', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭仿真设置', exact: true }).click();
  await start(page).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.waitForTimeout(1100);
  expect(requests).toBe(1);
  await expect(currentPost(page)).toHaveCount(0);
  await expect(radar(page)).toHaveAttribute('data-active', 'false');
  await expect(panel(page).getByText('已展示 0 / 100', { exact: true })).toBeVisible();
});

test('changing the scenario discards a late response from the previous session', async ({ page }) => {
  let releaseOldPosts!: () => void;
  const oldResponseGate = new Promise<void>(resolve => { releaseOldPosts = resolve; });
  let oldPath: string | undefined;
  await page.route(postsPath, async route => {
    if (oldPath !== undefined) {
      await route.continue();
      return;
    }
    oldPath = route.request().url();
    const response = await route.fetch();
    await oldResponseGate;
    await route.fulfill({ response });
  });

  const initialRequest = page.waitForRequest(request => postsPath.test(request.url()));
  await page.goto('/');
  const original = await initialRequest;
  const idleAngle = await sweep(page).evaluate(element => getComputedStyle(element).transform);
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '仿真设置', exact: true });
  const newResponse = page.waitForResponse(response => postsPath.test(response.url()) && response.url() !== original.url() && response.ok());
  await dialog.getByLabel('火情场景').selectOption('T-SE-01');
  await dialog.getByRole('button', { name: '关闭仿真设置' }).click();
  const data: SessionPosts = await (await newResponse).json();
  releaseOldPosts();
  await expect(panel(page).getByText('等待定位启动', { exact: true })).toBeVisible();
  await expect(radar(page)).toHaveAttribute('data-active', 'false');
  await expect(signal(page)).toHaveCount(0);
  await start(page).click();
  await expect(currentPost(page).locator('p')).toHaveText(data.posts[0].text);
  await expect(page.getByTestId('truth-marker')).toHaveAttribute('data-poi-id', 'T-SE-01');
  await expect(page.getByTestId('run-button-state')).toHaveText('Completed');
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'running');

  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await dialog.getByLabel('火情场景').selectOption('T-SW-01');
  await dialog.getByRole('button', { name: '关闭仿真设置' }).click();
  await expect(panel(page).getByText('等待定位启动', { exact: true })).toBeVisible();
  await expect(sweep(page)).toHaveCSS('animation-play-state', 'paused');
  await expect(sweep(page)).toHaveCSS('transform', idleAngle);
  await expect(signal(page)).toHaveCount(0);
});
