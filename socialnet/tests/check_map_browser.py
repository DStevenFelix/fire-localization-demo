"""Browser regression checks; dependencies and artifacts stay inside the project."""

import argparse
import asyncio
import json
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

PROJECT = Path(__file__).resolve().parent.parent
ARTIFACTS = PROJECT / ".artifacts"


async def popup_bounds(page):
    result = await page.evaluate("""() => {
        const shell = document.getElementById('map-shell').getBoundingClientRect();
        const popup = document.getElementById('entity-inspector').getBoundingClientRect();
        return {shell: shell.toJSON(), popup: popup.toJSON()};
    }""")
    shell, popup = result["shell"], result["popup"]
    assert popup["x"] >= shell["x"] and popup["y"] >= shell["y"], result
    assert popup["right"] <= shell["right"] and popup["bottom"] <= shell["bottom"], result
    return result


async def click_world(page, x, y):
    target = await page.evaluate("""([x,y]) => {
        const map = document.getElementById('community-map');
        const p = map.createSVGPoint(); p.x = x*40; p.y = (25-y)*40;
        const screen = p.matrixTransform(map.getScreenCTM());
        return {x: screen.x, y: screen.y};
    }""", [x, y])
    await page.mouse.click(target["x"], target["y"])
    return target


async def step(page):
    async with page.expect_response(lambda r: r.url.endswith('/api/simulation') and r.request.method == 'POST') as info:
        await page.locator('#step-button').click()
    response = await info.value
    assert response.status == 200
    await page.wait_for_function("!document.getElementById('step-button').disabled")
    return await response.json()


async def visible_pad_check(page):
    return await page.evaluate("""async () => {
        const map = document.getElementById('community-map');
        const clone = map.cloneNode(true);
        ['scene-features', 'scene-labels', 'scene-axes', 'scene-highlights', 'scene-fire'].forEach(id => clone.querySelector('#'+id)?.remove());
        clone.setAttribute('viewBox', '0 0 1200 1000');
        clone.setAttribute('width', '1200'); clone.setAttribute('height', '1000');
        const image = new Image();
        const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], {type:'image/svg+xml'}));
        try {
            image.src = source;
            await image.decode();
            const canvas = document.createElement('canvas'); canvas.width=1200; canvas.height=1000;
            const ctx = canvas.getContext('2d', {willReadFrequently:true}); ctx.drawImage(image,0,0);
            const bad = []; let samples = 0;
            const probe = (id,x,y) => {
                const rgb = Array.from(ctx.getImageData(Math.round(x*40),Math.round((25-y)*40),1,1).data).slice(0,3);
                samples++;
                if (rgb.some((value,i)=>Math.abs(value-[194,201,197][i])>4)) bad.push({id,x,y,rgb});
            };
            const entities = window.sceneMap.data.entities;
            entities.filter(e=>['A23','A24'].includes(e.area_id) && e.id.startsWith('POI-')).forEach(e=>{
                const parts = e.geometry.shape==='compound' ? e.geometry.components : [{x:e.position.x,y:e.position.y,radius:e.width/2}];
                parts.forEach(p=>{
                    const r=p.radius, depth=Math.max(.175,r*.47);
                    const left=p.x-r-.1375, right=p.x+r+.3875;
                    const top=p.y+r*.83+.032, bottom=p.y-r*.83-depth-.3125;
                    [[left,bottom],[right,bottom],[left,top],[right,top],[(left+right)/2,bottom]].forEach(([x,y])=>probe(e.id,x,y));
                });
            });
            entities.filter(e=>e.kind==='pipeline').forEach(e=>e.geometry.components.forEach(c=>c.points.forEach(p=>{
                [-.1125,.1125].forEach(dx=>[-.1125,.1125].forEach(dy=>probe(e.id,p.x+dx,p.y+dy)));
            })));
            return {samples,bad};
        } finally { URL.revokeObjectURL(source); }
    }""")


async def main(url):
    ARTIFACTS.mkdir(exist_ok=True)
    errors, results = [], []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--disable-dev-shm-usage', '--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1)
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await context.request.put(url + '/api/fire-policy', data={'base_probability': .30, 'suppression_factor': .25})
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        await page.goto(url)
        await page.wait_for_selector('#scene-features')
        await page.locator('#fire-settings-button').click()
        assert await page.locator('#fire-base-probability').input_value() == '30'
        assert await page.locator('#fire-base-value').inner_text() == '30%'
        assert await page.locator('#fire-suppression').input_value() == '25'
        assert await page.locator('#fire-suppression-value').inner_text() == '0.25'
        assert await page.locator('#three-step-probability').inner_text() == '65.7%'
        await page.locator('#fire-settings-button').click()
        assert await page.locator('#scene-labels > .poi-marker').count() == 28
        assert await page.locator('#scene-areas > [data-kind=area]').count() == 8
        assert await page.locator('#scene-labels > .intersection-marker').count() == 9
        assert await page.locator('#scene-features > [data-kind=tank_group]').count() == 3
        assert await page.locator("[data-id='POI-HA-NE-01'] > .tank-solid").count() == 6
        assert await page.locator('#scene-features > [data-id^="POI-"]').count() == 28
        assert await page.locator('.building-facade').count() == 11
        assert await page.locator('.tank-wall').count() == 26
        assert await page.locator('[data-kind=vehicle], #ignite-mode, #community-map image').count() == 0
        assert await page.locator('#agent-count').inner_text() == '28'
        centers = await page.evaluate("""() => window.sceneMap.data.entities.filter(e => e.id.startsWith('POI-')).every(e => {
            const dot = document.querySelector('#scene-labels [data-id="'+e.id+'"] circle');
            return Math.abs(Number(dot.getAttribute('cx'))-e.position.x*40)<.001 && Math.abs(Number(dot.getAttribute('cy'))-(25-e.position.y)*40)<.001;
        })""")
        assert centers
        layout = await page.evaluate("""() => {
            const map = document.getElementById('map-shell').getBoundingClientRect();
            const header = document.querySelector('.map-panel > .panel-header').getBoundingClientRect();
            const toolbar = document.querySelector('.map-toolbar').getBoundingClientRect();
            return {headerHeight: header.height, toolbarBelowMap: toolbar.top>=map.bottom-1,
                titleSize: getComputedStyle(document.querySelector('.map-panel h2')).fontSize};
        }""")
        assert layout['headerHeight'] == 72 and layout['toolbarBelowMap'] and layout['titleSize'] == '16px', layout
        assert await page.locator('.map-panel .section-number, #map-summary').count() == 0
        overflow = await page.evaluate("""() => {
            const entities = window.sceneMap.data.entities;
            return entities.filter(e=>e.id.startsWith('POI-')).flatMap(e=>{
                const area = entities.find(a=>a.id===e.area_id);
                const b = document.querySelector('#scene-features [data-id="'+e.id+'"]').getBBox();
                const left=area.x*40, top=(25-area.y-area.height)*40;
                return b.x<left-.1 || b.y<top-.1 || b.x+b.width>(area.x+area.width)*40+.1 || b.y+b.height>(25-area.y)*40+.1 ? [{id:e.id, bbox:{x:b.x,y:b.y,width:b.width,height:b.height},area:area.id}] : [];
            });
        }""")
        assert not overflow, overflow
        pad_check = await visible_pad_check(page)
        assert not pad_check['bad'], pad_check
        assert await page.locator('#scene-ground > [data-id=A00] > rect').get_attribute('fill') == '#50ba60'
        station = await page.locator("#scene-features [data-id='POI-FS-01']").evaluate("e => {const b=e.querySelector('.building-facade').getBBox(); return b.height;}")
        assert station == 19
        facility = page.locator("#scene-features [data-id='POI-JA-01']")
        await facility.hover()
        assert await facility.evaluate("e => e.classList.contains('facility-hover')")
        await facility.click()
        assert await page.locator('.selected-entity').count() == 0
        await page.locator('#close-inspector').click()
        await page.mouse.move(1, 1)
        assert not await facility.evaluate("e => e.classList.contains('facility-hover')")
        await page.evaluate("window.sceneMap.select('A21')")
        assert await page.locator('.selected-entity > rect').get_attribute('stroke-width') == '1.2'
        assert await page.locator('#entity-fields .entity-field').count() == 4
        await page.locator('#close-inspector').click()
        await page.locator("#scene-features [data-id='POI-JA-03']").focus()
        await page.keyboard.press('Enter')
        assert await page.locator('#entity-id').inner_text() == 'POI-JA-03'
        await page.keyboard.press('Escape')
        assert not await page.locator('#entity-inspector').is_visible()
        await page.evaluate('document.activeElement.blur()')
        await page.screenshot(path=str(ARTIFACTS / 'map-desktop.png'), full_page=True, animations='disabled')
        await page.locator('#community-map').screenshot(path=str(ARTIFACTS / 'map-scene.png'), animations='disabled')
        campus = await page.locator('#scene-areas > [data-id=A20]').bounding_box()
        await page.screenshot(path=str(ARTIFACTS / 'map-campus.png'), clip=campus, animations='disabled')
        pixels = list(Image.open(ARTIFACTS / 'map-scene.png').convert('RGB').getdata())
        colors = len(set(pixels))
        green = sum(g > r*1.1 and g > b*1.1 for r,g,b in pixels)
        white = sum(min(r,g,b) > 220 for r,g,b in pixels)
        assert colors > 1000 and green/len(pixels) > .08 and white/len(pixels) > .015
        results.append({'viewport': 'desktop', 'poi_centers': centers, 'colors': colors, 'layout': layout, 'facility_overflow': overflow, 'visible_pad': pad_check, 'station_facade_height': station})

        await page.locator('#map-search').fill('锦安二号楼')
        await page.locator('#map-search-results button').first.click()
        assert await page.locator('#entity-name').inner_text() == '锦安社区2号楼'
        assert await page.locator('#entity-residents > span').count() == 4
        assert await page.locator('#entity-coordinate').inner_text() == '(2.025, 14.130) m'
        await popup_bounds(page)
        await page.locator('#close-inspector').click()
        await page.locator('#zoom-fit').click()
        await page.locator('#map-search').fill('')
        target = await click_world(page, 2.025, 16.62)
        assert await page.locator('#entity-id').inner_text() == 'POI-JA-01'
        bounds = await popup_bounds(page)
        assert abs(bounds['popup']['x']-target['x']) < 320
        await page.screenshot(path=str(ARTIFACTS / 'map-popup.png'), full_page=True, animations='disabled')
        await page.locator('#zoom-in').click()
        assert await page.locator('#map-zoom-value').inner_text() == '135%'
        await popup_bounds(page)
        await page.locator('#close-inspector').click()
        before = await page.locator('#community-map').get_attribute('viewBox')
        box = await page.locator('#community-map').bounding_box()
        await page.mouse.move(box['x']+box['width']*.55, box['y']+box['height']*.6)
        await page.mouse.down()
        await page.mouse.move(box['x']+box['width']*.65, box['y']+box['height']*.65, steps=6)
        await page.mouse.up()
        assert await page.locator('#community-map').get_attribute('viewBox') != before
        await page.locator('#zoom-fit').click()
        await page.locator('#show-poi-labels').uncheck()
        assert not await page.locator('.poi-code').first.is_visible()
        await page.locator('#show-poi-labels').check()
        await page.locator('#show-area-boundaries').uncheck()
        assert not await page.locator('.area-boundary').first.is_visible()
        await page.locator('#show-area-boundaries').check()

        await context.request.put(url + '/api/fire-policy', data={'base_probability': 1, 'suppression_factor': .25})
        state = await step(page)
        assert len(state['fires']) == 1
        assert len(state['chats']) == 6
        fire = state['fires'][0]
        await page.wait_for_selector('[data-fire-id]')
        assert await page.locator('.flame-cluster').count() == 4
        await click_world(page, fire['position']['x'], fire['position']['y'])
        assert await page.locator('#entity-id').inner_text() == fire['id']
        assert await page.locator('#clear-selected-fire').is_visible()
        await popup_bounds(page)
        await page.screenshot(path=str(ARTIFACTS / 'map-fire.png'), full_page=True, animations='disabled')
        await page.locator('#clear-selected-fire').click()
        await page.wait_for_selector('#scene-fire:empty', state='attached')
        assert not await page.locator('#entity-inspector').is_visible()

        await page.locator('#fire-settings-button').click()
        await page.locator('#fire-base-probability').evaluate("e => { e.value=100; e.dispatchEvent(new Event('input', {bubbles:true})); }")
        await page.locator('#fire-suppression').evaluate("e => { e.value=95; e.dispatchEvent(new Event('input', {bubbles:true})); }")
        await page.locator('#save-fire-settings').click()
        await page.wait_for_function("!document.getElementById('save-fire-settings').disabled")
        state = await step(page)
        state = await step(page)
        assert len(state['fires']) == 2
        assert await page.locator('[data-fire-id]').count() == 2
        assert await page.locator('.flame-cluster').count() == 8
        assert await page.evaluate("""() => [...document.querySelectorAll('[data-fire-id]')].every(e=>e.getAttribute('clip-path')==='url(#fire-clip-'+e.dataset.areaId+')')""")
        await page.locator('#clear-fire').click()
        await page.wait_for_selector('#scene-fire:empty', state='attached')
        await step(page)
        await page.locator('#reset-button').click()
        await page.wait_for_function("window.sceneMap.data.simulation_minute === 0")
        assert await page.locator('[data-fire-id]').count() == 0

        for viewport in [{'width': 1024, 'height': 768}, {'width': 390, 'height': 844}]:
            await page.set_viewport_size(viewport)
            await page.locator('#zoom-fit').click()
            await page.locator('#map-search').fill('东源社区1号楼')
            await page.locator('#map-search-results button').first.click()
            assert await page.locator('#entity-residents > span').count() == 6
            popup = await popup_bounds(page)
            metrics = await page.evaluate("""() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
                badButtons: [...document.querySelectorAll('button')].filter(b => b.offsetParent && b.scrollWidth>b.clientWidth+2).map(b=>b.id) })""")
            assert metrics['documentWidth'] <= viewport['width'], metrics
            assert not metrics['badButtons'], metrics
            name = 'tablet' if viewport['width'] == 1024 else 'mobile'
            await page.screenshot(path=str(ARTIFACTS / ('map-'+name+'.png')), full_page=True, animations='disabled')
            results.append({'viewport': name, 'layout': metrics, 'popup': popup})
            await page.locator('#close-inspector').click()
            await page.locator('#map-search').fill('')
        assert not errors, errors
        await context.request.put(url + '/api/fire-policy', data={'base_probability': .30, 'suppression_factor': .25})
        await context.request.post(url + '/api/simulation', data={'action': 'reset'})
        await browser.close()
    print(json.dumps({'checks': results, 'browser_errors': errors}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8011')
    asyncio.run(main(parser.parse_args().url))
