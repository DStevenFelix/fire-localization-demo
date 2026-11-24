import { expect, test, type Page } from '@playwright/test';
import type { OpinionPost, Poi, Prediction, Session } from '../src/types';

const tanks: Poi[] = [
  { poi_id: 'T-SW-01', name: '西南 1 号储罐', type: 'tank', coordinates: { x_m: 9.72, y_m: 8.99 }, can_post: false },
  { poi_id: 'T-NE-01', name: '东北 1 号储罐', type: 'tank', coordinates: { x_m: 17.58, y_m: 15.42 }, can_post: false },
  { poi_id: 'T-SE-01', name: '东南 1 号储罐', type: 'tank', coordinates: { x_m: 17.45, y_m: 8.96 }, can_post: false },
  { poi_id: 'T-NW-01', name: '西北 1 号储罐', type: 'tank', coordinates: { x_m: 9.79, y_m: 16.23 }, can_post: false },
];
const prediction: Prediction = { candidates: [tanks[0], tanks[1], tanks[3]].map((tank, i) => ({ ...tank,
  rank: i + 1, votes: 3 - i, confidence: 1, score: 3 - i, relative_score: (3 - i) / 6 })),
  processed_count: 3, pending_count: 0, active_cluster_count: 3, cold_cluster_count: 0, status: 'located_candidates' };

async function socialNetFixture(page: Page, includeFire = true) {
  let session: Session;
  let posts: OpinionPost[] = [];
  let sequence = 0;
  const actions: string[] = [];
  const prepare = (target: string): Session => ({ session_id: String(++sequence).padStart(32, '0'), target_poi_id: target,
    seed: 42, mode: 'offline', status: 'prepared', analysis_frozen: false, paused: false, post_count: 0, processed_count: 0,
    ignored_count: 0, batch_count: 0, ground_truth: tanks.find(tank => tank.poi_id === target)!,
    prediction: null, evaluation: null, error: null, created_at: '', started_at: null, completed_at: null });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (path === '/health') return route.fulfill({ json: { status: 'ok' } });
    if (path === '/pois') return route.fulfill({ json: tanks });
    if (path === '/scenarios') return route.fulfill({ json: { scenarios: tanks, default_target_poi_id: tanks[0].poi_id } });
    if (path === '/scenarios/active') return route.fulfill({ json: session?.status === 'running' ? session : null });
    if (path === '/scenarios/prepare') {
      const { target_poi_id, source } = route.request().postDataJSON();
      expect(source).toBe('socialnet');
      session = prepare(target_poi_id);
    } else if (path === '/localization/run') {
      const { paused = false, ...body } = route.request().postDataJSON();
      expect(body).toEqual({ session_id: session.session_id, confirm_paid_api: true });
      actions.push('start:' + session.target_poi_id);
      session.status = 'running';
      session.paused = paused;
    } else if (path.endsWith('/posts')) {
      return route.fulfill({ json: { session_id: session.session_id, post_count: posts.length, posts } });
    } else if (path.endsWith('/pause')) {
      session.paused = route.request().postDataJSON().paused;
      actions.push(session.paused ? 'pause' : 'resume');
    } else if (path.endsWith('/handoff')) {
      actions.push('handoff');
      session.analysis_frozen = true;
    } else if (path.endsWith('/stop')) {
      actions.push('stop');
      session.status = 'completed';
    } else if (path.endsWith('/reset')) {
      actions.push('reset');
      posts = [];
      session = prepare(session.target_poi_id);
    }
    return route.fulfill({ json: session });
  });
  return { actions, add(...items: string[]) {
    for (const text of items) posts.push({ id: 'post-' + (posts.length + 1), text });
    session.post_count = posts.length;
    if (posts.length >= 3 && !session.analysis_frozen) {
      const output = includeFire ? prediction : { ...prediction, candidates: prediction.candidates.map((candidate, i) =>
        i === 2 ? { ...candidate, ...tanks[2] } : candidate) };
      Object.assign(session, { processed_count: 3, batch_count: 1, prediction: output });
    }
  } };
}

const start = (page: Page) => page.getByRole('button', { name: '开始仿真', exact: true });
const current = (page: Page) => page.locator('.opinion-entry-current strong');

async function startConfirmed(page: Page) {
  await start(page).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认并开始仿真' }).click();
}

async function advance(page: Page, seconds: number) {
  await page.evaluate(async seconds => {
    const modulePath = '/src/utils/emergency.ts';
    const sim = (await import(modulePath)).getEmergencyService().traffic;
    for (let time = 0; time < seconds; time += .1) sim.tick(.1);
  }, seconds);
}

test('all three candidate misses keep the bridge exercise waiting for additional reconnaissance', async ({ page }) => {
  const mock = await socialNetFixture(page, false);
  await page.goto('/?workspace=bridge-demo');
  await expect(start(page)).toBeEnabled();
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await page.getByLabel('火情场景').selectOption('T-NW-01');
  await page.getByRole('button', { name: '关闭仿真设置' }).click();
  await startConfirmed(page);
  mock.add('发现烟雾', '远处有火光', '需要侦查确认');
  await page.getByRole('button', { name: '移交应急处置' }).click();
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await advance(page, 120);
  await expect(page.getByTestId('emergency-phase')).toHaveText('火点尚未确认');
  await expect(page.locator('[data-recon-stage=observed]')).toHaveCount(3);
  await expect(page.locator('[data-recon-stage=observed]').filter({ hasText: '未发现火点' })).toHaveCount(3);
  await expect(page.getByTestId('emergency-plan')).toHaveCount(0);
  await expect(page.locator('[data-fire-truck][data-status=idle]')).toHaveCount(4);
  await expect(page.locator('[data-drone-path][points=""]')).toHaveCount(2);
  await expect(page.locator('[data-event-type="recon.confirmed"]')).toHaveCount(0);
});

test('cycles the SocialNet display, freezes predictions at handoff and stops on extinction', async ({ page }) => {
  test.setTimeout(60000);
  const mock = await socialNetFixture(page);
  await page.goto('/?workspace=bridge-demo');
  await expect(start(page)).toBeEnabled();
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await page.getByRole('button', { name: '仿真设置', exact: true }).click();
  await page.getByLabel('火情场景').selectOption('T-NW-01');
  await page.getByRole('button', { name: '关闭仿真设置' }).click();
  await startConfirmed(page);
  await expect(page.getByText('滚动已暂停')).toBeVisible();
  await page.getByRole('button', { name: '继续仿真', exact: true }).click();
  await expect(page.getByText('等待 SocialNet 发帖')).toBeVisible();
  expect(mock.actions).toEqual(['start:T-NW-01', 'resume']);

  mock.add('看到黑烟', '罐区有火光');
  await expect(current(page)).toHaveText('post-1');
  await expect(current(page)).toHaveText('post-2');
  await expect(current(page)).toHaveText('post-1');
  await expect(page.getByRole('button', { name: '移交应急处置' })).toHaveCount(0);
  mock.add('火光越来越大');
  await expect(current(page)).toHaveText('post-3');
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  await expect(page.getByRole('button', { name: '移交应急处置' })).toBeEnabled();
  await page.getByRole('button', { name: '移交应急处置' }).click();
  await expect(page.getByTestId('prediction-marker')).toHaveAttribute('data-poi-id', 'T-SW-01');
  await expect(page.getByTestId('fire-marker')).toHaveAttribute('data-poi-id', 'T-NW-01');
  const route = await page.evaluate(async () => {
    const servicePath = '/src/utils/emergency.ts', registryPath = '/src/utils/poiRegistry.ts';
    const [{ getEmergencyService }, { poiRegistry }] = await Promise.all([import(servicePath), import(registryPath)]);
    const drone = getEmergencyService().getSnapshot().drones[0];
    return drone.path.slice(1).map(({ x, y }: { x: number; y: number }) => [...poiRegistry.values()].find(poi =>
      poi.type === 'Tank' && Math.hypot(poi.center[0] + 30 - x, poi.center[1] + 25 - y) < 0.001)?.id);
  });
  expect(route).toEqual(['T-SW-01']);
  await expect(page.locator('[data-recon-stage=assigned]')).toHaveCount(3);
  await expect(page.getByTestId('emergency-plan')).toHaveCount(0);
  await page.getByRole('button', { name: '继续仿真', exact: true }).click();
  mock.add('移交后仍然接收新帖');
  await expect(current(page)).toHaveText('post-4');
  await expect(page.getByRole('region', { name: '定位结果详情' })).toContainText('已定位 3 / 4 条');
  await advance(page, 140);
  await expect(page.getByTestId('emergency-plan')).toBeVisible();
  await advance(page, 160);
  await page.getByRole('button', { name: '确认已灭火' }).click();
  await expect(page.getByText('滚动已停止')).toBeVisible();
  const stopped = await current(page).textContent();
  await page.waitForTimeout(1150);
  await expect(current(page)).toHaveText(stopped!);
  expect(mock.actions).toEqual(['start:T-NW-01', 'resume', 'pause', 'handoff', 'resume', 'stop']);
  await page.getByRole('button', { name: '全局重置' }).click();
  await expect(current(page)).toHaveCount(0);
  await expect(start(page)).toBeEnabled();
  expect(mock.actions.at(-1)).toBe('reset');
});

test('global pause freezes the visible post and resumes the same session', async ({ page }) => {
  const mock = await socialNetFixture(page);
  await page.goto('/');
  await startConfirmed(page);
  mock.add('第一条初筛帖子', '第二条初筛帖子');
  await expect(current(page)).toHaveText('post-1');
  await page.getByRole('button', { name: '全局暂停', exact: true }).click();
  const resume = page.getByRole('button', { name: '继续仿真', exact: true });
  await expect(resume).toBeEnabled();
  await expect(page.getByText('滚动已暂停')).toBeVisible();
  await expect(page.getByTestId('sandbox-svg')).toHaveAttribute('data-simulation-paused', 'true');
  await page.waitForTimeout(1150);
  await expect(current(page)).toHaveText('post-1');
  expect(mock.actions).toEqual(['start:T-SW-01', 'pause']);
  await resume.click();
  await expect(current(page)).toHaveText('post-2');
  await expect(page.getByTestId('sandbox-svg')).toHaveAttribute('data-simulation-paused', 'false');
  expect(mock.actions).toEqual(['start:T-SW-01', 'pause', 'resume']);
});

test('a refreshed page can reset the running source before the first prediction', async ({ page }) => {
  const mock = await socialNetFixture(page);
  await page.goto('/');
  await startConfirmed(page);
  mock.add('第一条初筛帖子');
  await expect(current(page)).toHaveText('post-1');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(current(page)).toHaveText('post-1');
  await page.getByRole('button', { name: '全局重置' }).click();
  await expect(current(page)).toHaveCount(0);
  await expect(start(page)).toBeEnabled();
  expect(mock.actions).toEqual(['start:T-SW-01', 'reset']);
});
