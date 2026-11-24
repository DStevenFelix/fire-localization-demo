import type { Page } from '@playwright/test';
import type { Candidate, Poi, Session } from '../src/types';

export async function startWithPrediction(page: Page, transform: (session: Session) => Session = session => session) {
  let active: Session;
  await page.route(/\/api\/localization\/(?:run|[0-9a-f]{32}(?:\/posts|\/handoff|\/pause)?)$/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/run')) {
      const { session_id: id, paused = false } = route.request().postDataJSON();
      const session: Session = await (await page.request.get('/api/localization/' + id, { headers: { Connection: 'close' } })).json();
      const { scenarios }: { scenarios: Poi[] } = await (await page.request.get('/api/scenarios', { headers: { Connection: 'close' } })).json();
      const otherTanks = scenarios.filter(poi => poi.poi_id !== session.target_poi_id);
      const candidates: Candidate[] = [session.ground_truth, ...otherTanks.slice(0, 2)]
        .map((poi, i) => ({ ...poi, rank: i + 1, votes: 3 - i, confidence: 1, score: 3 - i, relative_score: (3 - i) / 6 }));
      active = transform({ ...session, status: 'running', paused, batch_count: 1, post_count: 3, processed_count: 3,
        evaluation: { top1_hit: true, top3_hit: true, target_rank: 1, distance_m: 0 }, prediction: { candidates,
          processed_count: 3, pending_count: 0, active_cluster_count: 3, cold_cluster_count: 0, status: 'located_candidates' } });
      return route.fulfill({ status: 202, json: active });
    }
    if (!active || !path.includes(active.session_id)) return route.fallback();
    if (path.endsWith('/posts')) return route.fulfill({ json: { session_id: active.session_id, post_count: 0, posts: [] } });
    if (path.endsWith('/handoff')) active = { ...active, analysis_frozen: true };
    if (path.endsWith('/pause')) active = { ...active, paused: route.request().postDataJSON().paused };
    return route.fulfill({ json: active });
  });
  await page.getByRole('button', { name: '开始仿真', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认并开始仿真' }).click();
}
