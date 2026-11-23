"""Single-request resident generation and paused-error UI against the mock server."""

import argparse
import asyncio
import json

from playwright.async_api import async_playwright

from check_map_browser import ARTIFACTS, step


async def main(url):
    ARTIFACTS.mkdir(exist_ok=True)
    errors, results = [], []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--disable-dev-shm-usage', '--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1600, 'height': 1000})
        # Only the explicit mock-server application exposes this route.
        response = await context.request.post(url + '/_test/model', data={'mode': 'valid'})
        assert response.ok, 'Run against tests/mock_server.py, never a real model server'
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        await context.request.put(url + '/api/fire-policy', data={'base_probability': 0, 'suppression_factor': .25})
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(url)
        await page.wait_for_selector('.community-row')
        state = await step(page)
        before = state['simulation_minute'], [m['id'] for m in state['chats']]
        await context.request.post(url + '/_test/model', data={'mode': 'request_failure'})
        await page.locator('#step-button').click()
        await page.wait_for_function("window.sceneMap.data.generation_error?.code === 'request_failed'")
        await page.locator('#generation-error').wait_for(state='visible')
        assert await page.locator('#system-status').inner_text() == '已暂停'
        assert '模型请求失败' in await page.locator('#generation-error-message').inner_text()
        current = await (await context.request.get(url + '/api/state')).json()
        assert (current['simulation_minute'], [m['id'] for m in current['chats']]) == before
        assert 'TEST-PRIVATE' not in await page.locator('body').inner_text()
        for viewport in [{'width': 1600, 'height': 1000}, {'width': 1024, 'height': 768}, {'width': 390, 'height': 844}]:
            await page.set_viewport_size(viewport)
            await page.evaluate('window.scrollTo(0, 0)')
            metrics = await page.evaluate('''() => ({width:innerWidth, documentWidth:document.documentElement.scrollWidth,
                errorHeight:document.getElementById('generation-error').getBoundingClientRect().height,
                textFits:document.getElementById('generation-error-message').scrollWidth<=document.getElementById('generation-error-message').clientWidth+1})''')
            assert metrics['documentWidth'] <= viewport['width'] and metrics['textFits'] and metrics['errorHeight'] > 0
            name = 'desktop' if viewport['width'] == 1600 else 'tablet' if viewport['width'] == 1024 else 'mobile'
            await page.screenshot(path=str(ARTIFACTS / ('generation-error-' + name + '.png')), animations='disabled')
            results.append({'viewport': name, **metrics})
        await page.set_viewport_size({'width': 1600, 'height': 1000})
        await context.request.post(url + '/_test/model', data={'mode': 'valid'})
        repaired = await step(page)
        assert repaired['simulation_minute'] == before[0] + 5
        assert repaired['generation_error'] is None
        assert all(m['generation_source'] == 'llm' for m in repaired['chats'])
        assert all(m['generation_attempts'] == 1 for m in repaired['chats'] if m['simulation_minute'] == repaired['simulation_minute'])
        assert await page.locator('#generation-error').is_hidden()
        await page.locator('[data-community=A10]').click()
        assert '本地' not in await page.locator('.chat-panel').inner_text()
        await context.request.post(url + '/_test/model', data={'mode': 'timeout'})
        await page.locator('#start-button').click()
        await page.wait_for_function("window.sceneMap.data.generation_error?.code === 'timeout'")
        assert not await page.evaluate('window.sceneMap.data.running')
        timeout_state = await (await context.request.get(url + '/api/state')).json()
        limit = timeout_state['generation_error']['timeout_seconds']
        assert limit > 0 and f'{limit:g} 秒' in await page.locator('#generation-error-message').inner_text()
        await context.request.post(url + '/_test/model', data={'mode': 'validation_failure'})
        await page.locator('#step-button').click()
        await page.wait_for_function("window.sceneMap.data.generation_error?.code === 'validation_failed'")
        assert '未返回聊天正文' in await page.locator('#generation-error-message').inner_text()
        invalid_state = await (await context.request.get(url + '/api/state')).json()
        assert invalid_state['generation_error']['attempts'] == 1
        assert '原因' in await page.locator('#generation-error-message').inner_text()
        await context.request.post(url + '/_test/model', data={'mode': 'valid'})
        await step(page)
        assert await page.locator('#generation-error').is_hidden()
        await page.locator('#reset-button').click()
        await page.wait_for_function('window.sceneMap.data.simulation_minute === 0')
        assert not errors, errors
        await browser.close()
    print(json.dumps({'checks': results, 'single_request_residents': True, 'browser_errors': errors}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8011')
    asyncio.run(main(parser.parse_args().url))
