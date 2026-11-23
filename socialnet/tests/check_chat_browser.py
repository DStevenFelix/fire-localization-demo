"""Community routing, background conversation, and responsive chat checks."""

import argparse
import asyncio
import json

from playwright.async_api import async_playwright

from check_map_browser import ARTIFACTS, click_world, step


async def check_room(page, community_id):
    assert await page.locator('#community-switch').input_value() == community_id
    assert await page.evaluate("id => [...document.querySelectorAll('#chat-list .chat-message')].every(e=>e.dataset.communityId===id)", community_id)
    count = await page.locator('#chat-list .chat-message').count()
    assert count > 0
    return count


async def check_evidence(page, message):
    card = page.locator('#chat-' + message['id'])
    assert await card.locator('p').inner_text() == message['content']
    assert await card.locator('.chat-evidence, .evidence-tag').count() == 0


async def main(url):
    ARTIFACTS.mkdir(exist_ok=True)
    errors, results = [], []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--disable-dev-shm-usage', '--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1600, 'height': 1000})
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        await context.request.put(url + '/api/fire-policy', data={'base_probability': 0, 'suppression_factor': .35})
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(url)
        await page.wait_for_selector('.community-row')
        assert await page.locator('.community-row').count() == 2
        assert await page.locator('.chat-panel .section-number').count() == 0
        assert await page.locator('#chat-title').inner_text() == '社区居民群聊'
        await page.locator('.chat-panel').screenshot(path=str(ARTIFACTS / 'chat-communities.png'))
        state = await step(page)
        assert state['chat_totals'] == {'A10': 2, 'A30': 2}
        assert await page.locator('.community-row .unread-count').count() == 2
        await click_world(page, 1.2, 18.0)
        assert await page.locator('#chat-title').inner_text() == '锦安社区'
        assert await check_room(page, 'A10') == 2
        await page.locator('#chat-list .reply-quote').first.click()
        assert await page.locator('.reply-focus').count() == 1
        await page.locator('#community-members-button').click()
        assert await page.locator('.resident-profile').count() == 16
        await page.locator('.resident-profile summary').first.click()
        assert await page.locator('.resident-profile[open]').count() == 1
        state = await step(page)
        assert state['chat_totals'] == {'A10': 4, 'A30': 4}
        assert await page.locator('.resident-profile[open]').count() == 1
        await page.locator('#community-members-button').click()
        assert await check_room(page, 'A10') == 4
        await page.locator('#community-back').click()
        assert await page.locator('[data-community=A30] .unread-count').inner_text() == '4'
        assert await page.locator('[data-community=A10] .unread-count').count() == 0
        await page.locator('[data-community=A30]').click()
        assert await check_room(page, 'A30') == 4
        await page.locator('#community-members-button').click()
        assert await page.locator('.resident-profile').count() == 12
        await page.locator('#community-members-button').click()
        await page.locator('#community-switch').select_option('A10')
        assert await check_room(page, 'A10') == 4
        # Simulation runs in both rooms even while only one is visible.
        before = state['simulation_minute']
        await context.request.post(url + '/api/simulation', data={'action': 'start'})
        await page.wait_for_function('minute => window.sceneMap.data.simulation_minute > minute', arg=before)
        await context.request.post(url + '/api/simulation', data={'action': 'pause'})
        await page.wait_for_function('!window.sceneMap.data.running')
        assert await check_room(page, 'A10') >= 6
        assert await page.evaluate('window.sceneMap.data.chat_totals.A30 >= 6')
        # A selected map area must not reopen its room on each websocket render.
        await page.evaluate("window.sceneMap.select('A10')")
        await page.locator('#community-back').click()
        await step(page)
        assert await page.locator('#community-list').is_visible()
        assert await page.locator('#community-navigation').is_hidden()
        await page.locator('#close-inspector').click()

        await page.locator('#reset-button').click()
        await page.wait_for_function('window.sceneMap.data.simulation_minute === 0')
        await context.request.put(url + '/api/fire-policy', data={'base_probability': 1, 'suppression_factor': .35})
        state = await step(page)
        assert len(state['fires']) == 1 and state['chat_totals'] == {'A10': 3, 'A30': 3}
        await click_world(page, 28.5, 18.1)
        assert await check_room(page, 'A30') == 3
        assert await page.locator('#chat-list .chat-message.fire').count() == 1
        assert await page.locator('#chat-list .reply-quote').count() >= 1
        assert await page.locator('#chat-list .chat-message:not(.fire)').count() == 2
        direct = next(m for m in state['chats'] if m['community_id'] == 'A30' and m['intent'] == 'observation')
        await check_evidence(page, direct)
        heard = [m for m in state['chats'] if m['community_id'] == 'A30' and m['evidence_source'] == 'hearsay']
        for message in heard:
            assert not message['evidence_signals']
            await check_evidence(page, message)
        await page.locator('#close-inspector').click()
        await page.locator('.chat-panel').screenshot(path=str(ARTIFACTS / 'chat-fire-desktop.png'))
        await page.screenshot(path=str(ARTIFACTS / 'chat-workspace.png'), full_page=True)
        await context.request.put(url + '/api/fire-policy', data={'base_probability': 0, 'suppression_factor': .35})
        for _ in range(7):
            await step(page)
        await page.locator('#chat-list').evaluate('e=>e.scrollTop=0')
        await step(page)
        assert await page.locator('#chat-list').evaluate('e=>e.scrollTop') < 2
        await page.locator('#community-switch').select_option('A10')
        assert await check_room(page, 'A10') == 27
        await page.locator('#community-switch').select_option('A30')
        assert await page.locator('#chat-list').evaluate('e=>e.scrollTop') < 2
        results.append({'viewport': 'desktop', 'both_rooms_run': True, 'map_routes_rooms': True, 'scroll_restored': True})

        # Private perception may be richer than what a resident chooses to publish.
        rich = None
        for _ in range(30):
            current = await (await context.request.get(url + '/api/state')).json()
            observations = [m for m in current['chats'] if m['intent'] == 'observation']
            rich = next((m for m in observations if len(m['evidence_quotes']) >= 3), None)
            if rich and len({m['expression_kind'] for m in observations}) >= 4:
                break
            await step(page)
        assert rich and len({m['expression_kind'] for m in observations}) >= 4
        for community_id in ('A10', 'A30'):
            await page.locator('#community-switch').select_option(community_id)
            for message in observations:
                if message['community_id'] == community_id:
                    await check_evidence(page, message)
        await page.locator('#community-switch').select_option(rich['community_id'])
        await page.locator('#chat-' + rich['id']).scroll_into_view_if_needed()
        await page.locator('.chat-panel').screenshot(path=str(ARTIFACTS / 'chat-evidence-desktop.png'), animations='disabled')

        for viewport in [{'width': 1024, 'height': 768}, {'width': 390, 'height': 844}]:
            await page.set_viewport_size(viewport)
            await page.locator('#community-back').click()
            await page.locator('[data-community=' + rich['community_id'] + ']').focus()
            await page.keyboard.press('Enter')
            await check_room(page, rich['community_id'])
            await page.locator('#chat-' + rich['id']).scroll_into_view_if_needed()
            await check_evidence(page, rich)
            metrics = await page.evaluate('''() => ({width:innerWidth, documentWidth:document.documentElement.scrollWidth,
                badButtons:[...document.querySelectorAll('.chat-panel button')].filter(b=>b.offsetParent && b.scrollWidth>b.clientWidth+2).map(b=>b.id||b.className),
                chatHeight:document.getElementById('chat-list').clientHeight})''')
            assert metrics['documentWidth'] <= viewport['width'] and not metrics['badButtons'] and metrics['chatHeight'] > 200, metrics
            name = 'tablet' if viewport['width'] == 1024 else 'mobile'
            await page.locator('.chat-panel').screenshot(path=str(ARTIFACTS / ('chat-'+name+'.png')), animations='disabled')
            await page.locator('#community-members-button').click()
            if not await page.locator('.resident-profile').first.evaluate('e=>e.open'):
                await page.locator('.resident-profile summary').first.click()
            await page.locator('.chat-panel').screenshot(path=str(ARTIFACTS / ('chat-members-'+name+'.png')))
            await page.locator('#community-members-button').click()
            results.append({'viewport': name, **metrics})
        assert not errors, errors
        await context.request.put(url + '/api/fire-policy', data={'base_probability': .30, 'suppression_factor': .25})
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        await browser.close()
    print(json.dumps({'checks': results, 'browser_errors': errors}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8011')
    asyncio.run(main(parser.parse_args().url))
