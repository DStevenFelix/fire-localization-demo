"""Monitor reports, correction and atomic failure checks against the mock server only."""

import argparse
import asyncio
import json

from playwright.async_api import async_playwright

from check_map_browser import ARTIFACTS, step


async def main(url):
    ARTIFACTS.mkdir(exist_ok=True)
    errors, results = [], []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--disable-dev-shm-usage', '--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1600, 'height': 1000})
        response = await context.request.post(url + '/_test/model', data={'mode': 'valid'})
        assert response.ok, 'Run only against tests/mock_server.py'
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        await context.request.put(url + '/api/fire-policy', data={'base_probability': 1, 'suppression_factor': .25})
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(url)
        await page.wait_for_selector('#scene-features')
        state = await step(page)
        assert state['reports']
        report = state['reports'][-1]
        assert report['generation_source'] == 'llm' and report['reasoning']
        assert not report['fire_ids'] and not report['fire_positions'] and report['fire_position'] is None
        assert await page.locator('.report-judgment').count() > 0
        assert '文本位置线索' in await page.locator('.report-card').first.inner_text()
        assert '报告者住址' in await page.locator('.report-card').first.inner_text()
        await context.request.post(url + '/_test/model', data={'mode': 'monitor_repair_once'})
        state = await step(page)
        assert state['reports'][-1]['generation_attempts'] == 2
        before = state['simulation_minute'], [m['id'] for m in state['chats']], [r['id'] for r in state['reports']], state['fires']
        for mode, code in [('monitor_failure', 'request_failed'), ('monitor_timeout', 'timeout'), ('monitor_invalid', 'validation_failed')]:
            await context.request.post(url + '/_test/model', data={'mode': mode})
            await page.locator('#step-button').click()
            await page.wait_for_function('code => window.sceneMap.data.generation_error?.code===code', arg=code)
            state = await (await context.request.get(url + '/api/state')).json()
            assert (state['simulation_minute'], [m['id'] for m in state['chats']], [r['id'] for r in state['reports']], state['fires']) == before
            assert state['generation_error']['agent_role'] == 'monitor' and not state['running']
            assert '监测 Agent' in await page.locator('#generation-error-context').inner_text()
            assert 'TEST-PRIVATE' not in await page.locator('body').inner_text()
        await context.request.post(url + '/_test/model', data={'mode': 'valid'})
        await step(page)
        assert await page.locator('#generation-error').is_hidden()
        for width in (1600, 1024, 390):
            await page.set_viewport_size({'width': width, 'height': 1000})
            await page.locator('.monitor-panel').scroll_into_view_if_needed()
            metrics = await page.evaluate('''() => ({width:innerWidth, documentWidth:document.documentElement.scrollWidth,
                badText:[...document.querySelectorAll('.report-card, .report-judgment dd, .report-uncertainties')].filter(e=>e.scrollWidth>e.clientWidth+1).length})''')
            assert metrics['documentWidth'] <= width and metrics['badText'] == 0, metrics
            await page.locator('.monitor-panel').screenshot(path=str(ARTIFACTS / ('llm-monitor-' + str(width) + '.png')))
            results.append(metrics)
        await context.request.put(url + '/api/fire-policy', data={'base_probability': .3, 'suppression_factor': .25})
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        assert not errors, errors
        await browser.close()
    print(json.dumps({'checks': results, 'monitor_correction': True, 'atomic_rollback': True, 'browser_errors': errors}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8011')
    asyncio.run(main(parser.parse_args().url))
