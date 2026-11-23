"""Read-only responsive header verification; does not start or step the simulation."""

import argparse
import asyncio
import json
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright

from check_map_browser import ARTIFACTS


async def main(url):
    ARTIFACTS.mkdir(exist_ok=True)
    errors, checks = [], []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--disable-dev-shm-usage', '--no-sandbox'])
        page = await browser.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(url)
        await page.wait_for_selector('#scene-features')
        assert await page.title() == '火灾应急管理仿真社交网络系统'
        assert await page.locator('.brand h1').inner_text() == '火灾应急管理仿真社交网络系统'
        assert await page.locator('.brand-section-title').inner_text() == '多智能体事件发现agent'
        script_version = parse_qs(urlsplit(await page.locator('script[src*="/static/app.js"]').get_attribute('src')).query)['v']
        style_version = parse_qs(urlsplit(await page.locator('link[rel=stylesheet]').get_attribute('href')).query)['v']
        assert script_version == style_version and script_version[0]
        assert await page.locator('.monitor-panel .section-number, .monitor-panel .agent-badge').count() == 0
        assert await page.locator('.monitor-panel h2').inner_text() == '监测 Agent'
        assert await page.locator('#chat-title').inner_text() == '社区居民群聊'
        await page.locator('[data-community=A10]').click()
        assert await page.locator('#chat-title').inner_text() == '锦安社区'
        await page.locator('#community-back').click()
        assert await page.locator('#chat-title').inner_text() == '社区居民群聊'
        for width in (1600, 1280, 1024, 768, 390, 320):
            await page.set_viewport_size({'width': width, 'height': 1000})
            metrics = await page.evaluate('''() => {
                const rect = selector => document.querySelector(selector).getBoundingClientRect();
                const heading = rect('.brand h1'), secondary = rect('.brand-section-title'), status = rect('.status-strip');
                const headers = [...document.querySelectorAll('.panel > .panel-header')];
                const titleOffsets = headers.map(e=>e.querySelector('h2').getBoundingClientRect().top-e.getBoundingClientRect().top);
                const overlap = (a,b) => a.left < b.right-1 && b.left < a.right-1 && a.top < b.bottom-1 && b.top < a.bottom-1;
                return {width:innerWidth, documentWidth:document.documentElement.scrollWidth,
                    overlap:overlap(heading,secondary)||overlap(heading,status)||overlap(secondary,status),
                    titlesFit:[...document.querySelectorAll('.brand h1, .brand-section-title')].every(e=>e.scrollWidth<=e.clientWidth+1),
                    centerError:Math.abs((secondary.left+secondary.right)/2-innerWidth/2),
                    panelHeaderHeights:headers.map(e=>e.getBoundingClientRect().height),
                    titleOffsets,
                    logoWidth:rect('.brand-mark').width};
            }''')
            assert metrics['documentWidth'] <= width and not metrics['overlap'] and metrics['titlesFit'], metrics
            assert metrics['logoWidth'] == 42
            assert metrics['centerError'] <= 1, metrics
            assert metrics['panelHeaderHeights'] == [72, 72, 72], metrics
            assert max(metrics['titleOffsets']) - min(metrics['titleOffsets']) <= 1, metrics
            if width in (1600, 390):
                await page.locator('.topbar').screenshot(path=str(ARTIFACTS / ('header-' + str(width) + '.png')))
                if width == 1600:
                    await page.locator('.monitor-panel .panel-header').screenshot(path=str(ARTIFACTS / 'monitor-header.png'))
                    await page.screenshot(path=str(ARTIFACTS / 'unified-panel-headers-desktop.png'))
            checks.append(metrics)
        assert not errors, errors
        await browser.close()
    print(json.dumps({'checks': checks, 'browser_errors': errors}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8000')
    asyncio.run(main(parser.parse_args().url))
