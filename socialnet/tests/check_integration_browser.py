"""Offline browser contract for the merged map/chat/monitor/localizer; mock server only."""
import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright

ARTIFACTS = Path(__file__).resolve().parents[1] / ".artifacts"


async def main(url, artifacts=ARTIFACTS):
    artifacts.mkdir(parents=True, exist_ok=True)
    errors, checks = [], []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context(viewport={"width":1600,"height":1100})
        assert (await context.request.post(url+"/_test/model", data={"mode":"valid"})).ok
        await context.request.post(url+"/api/simulation", data={"action":"reset"})
        await context.request.put(url+"/api/fire-policy", data={"base_probability":1,"suppression_factor":.9})
        page = await context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(url)
        await page.wait_for_selector("#community-map [data-testid=map-image]")
        await page.wait_for_function("window.sceneMap?.data?.residents.length===300")
        assert await page.locator(".community-row").count() == 10
        assert await page.locator("#agent-count").inner_text() == "300"
        pixels = await page.evaluate("""async () => {
          const img = new Image(); img.src=document.querySelector('#community-map [data-testid=map-image]').getAttribute('href'); await img.decode();
          const c=document.createElement('canvas'); c.width=c.height=40; const x=c.getContext('2d');x.drawImage(img,0,0,40,40);
          const d=x.getImageData(0,0,40,40).data, colors=new Set();for(let i=0;i<d.length;i+=4) colors.add(d[i]+','+d[i+1]+','+d[i+2]);
          return {w:img.naturalWidth,h:img.naturalHeight,colors:colors.size}; }""")
        assert pixels["w"] == 1313 and pixels["h"] == 1050 and pixels["colors"] > 100

        async def step():
            before = await page.evaluate("window.sceneMap.data.simulation_minute")
            await page.locator("#step-button").click()
            await page.wait_for_function("n=>window.sceneMap.data.simulation_minute===n+5", arg=before)
            return await (await context.request.get(url+"/api/state")).json()

        state = await step()
        assert len(state["chats"]) == 30 and len(state["fires"]) == 1
        await page.wait_for_function("window.sceneMap.data.localization.status==='completed'")
        assert await page.locator(".candidate-row").count() > 0
        assert await page.locator('[data-testid="prediction-marker"]').count() == 1
        assert await page.locator("#community-map [data-fire-id]").count() == 1
        alignment = await page.evaluate("""() => window.sceneMap.data.entities.filter(e=>['tank','building','pipeline'].includes(e.kind)).every(e=>{
          const dot=document.querySelector('#community-map [data-id="'+e.id+'"] circle');
          return dot && Math.abs(+dot.getAttribute('cx')-e.position.x/90*3939)<.0001 && Math.abs(+dot.getAttribute('cy')-(75-e.position.y)/75*3150)<.0001;
        })""")
        assert alignment
        assert len(state["entities"]) == 415 and state["map"]["coordinate_system"] == "CITY90x75"
        assert await page.locator('[data-layer="city-roads"]').count() == 1
        assert await page.locator('[data-layer="city-buildings"]').count() == 1
        assert await page.locator('[data-testid="map-image"]').get_attribute("x") == "1313"
        assert await page.locator('[data-testid="map-image"]').get_attribute("y") == "1050"
        # 扩展住宅的真实指针点击也必须跳到相应居民群，坐标不能被二次平移。
        home = next(e for e in state["entities"] if e["source"] == "city_scene" and e["entity_type"] == "residential_building")
        await page.evaluate("id=>window.sceneMap.select(id,true)",home["id"])
        coords = await page.evaluate("""id=>{const s=document.querySelector('#community-map svg'),e=window.sceneMap.data.entities.find(e=>e.id===id);
          const p=new DOMPoint(e.position.x/90*3939,(75-e.position.y)/75*3150).matrixTransform(s.getScreenCTM());return {x:p.x,y:p.y};}""",home["id"])
        await page.mouse.click(coords["x"],coords["y"])
        assert await page.locator("#entity-id").inner_text() == home["id"]
        expected_community = next(c["name"] for c in state["communities"] if c["id"] == home["area_id"])
        assert await page.locator("#chat-title").inner_text() == expected_community
        await page.locator("#close-inspector").click()
        await page.locator("#zoom-fit").click()
        # Real pointer selection must route to the community and show an anchored popup.
        coords = await page.evaluate("""() => {const s=document.querySelector('#community-map svg'),e=window.sceneMap.data.entities.find(e=>e.id==='B-W-01');
          const p=new DOMPoint(e.position.x/90*3939,(75-e.position.y)/75*3150).matrixTransform(s.getScreenCTM());return {x:p.x,y:p.y};}""")
        await page.mouse.click(coords["x"], coords["y"])
        await page.wait_for_function("document.getElementById('chat-title').textContent==='锦安社区'")
        assert await page.locator("#entity-inspector").is_visible()
        assert await page.locator("#chat-list .chat-message").count() == 3
        observation = next(m for m in state["chats"] if m["community_id"] == "A-WEST" and m["evidence_signals"])
        card = page.locator("#chat-" + observation["id"])
        assert await card.locator("p").inner_text() == observation["content"]
        assert await card.locator(".building-tag").inner_text() == observation["building_name"]
        assert await page.locator("#chat-list .chat-evidence, #chat-list .evidence-tag").count() == 0
        assert await page.locator("#chat-list .reply-quote").count() == 1
        await page.locator("#close-inspector").click()
        await page.locator("#zoom-in").click()
        assert await page.evaluate("window.sceneMap.zoom>1")
        box = await page.locator("#community-map svg").bounding_box()
        before = await page.locator("#community-map svg").get_attribute("viewBox")
        await page.mouse.move(box["x"]+box["width"]*.5,box["y"]+box["height"]*.5)
        await page.mouse.down();await page.mouse.move(box["x"]+box["width"]*.6,box["y"]+box["height"]*.6,steps=8);await page.mouse.up()
        assert before != await page.locator("#community-map svg").get_attribute("viewBox")
        await page.locator("#zoom-fit").click()
        await page.locator(".candidate-row").first.click()
        assert (await page.locator("#entity-id").inner_text()).startswith("T-")
        await page.locator("#close-inspector").click()

        for community, total in [(c["id"],len(c["resident_ids"])) for c in state["communities"]]:
            if await page.locator("#community-back").is_visible():
                await page.locator("#community-back").click()
            await page.locator('[data-community="'+community+'"]').click()
            await page.locator("#community-members-button").click()
            assert await page.locator(".resident-profile").count() == total
            await page.locator("#community-members-button").click()

        await context.request.post(url+"/_test/model", data={"mode":"localization_failure"})
        await step()
        await page.wait_for_function("window.sceneMap.data.localization.status==='failed'")
        assert "TEST-PRIVATE" not in await page.locator("body").inner_text()
        old_minute = await page.evaluate("window.sceneMap.data.simulation_minute")
        await step()
        assert await page.evaluate("window.sceneMap.data.simulation_minute") == old_minute+5
        assert not await page.evaluate("window.sceneMap.data.generation_error")
        await page.locator(".localization-jobs:not(.localization-clusters) summary").click()
        await context.request.post(url+"/_test/model", data={"mode":"valid"})
        await page.locator("[data-retry]").first.click()
        await page.wait_for_function("window.sceneMap.data.localization.status==='completed'")
        assert await page.locator("#localization-error").is_hidden()

        # A slow localizer does not delay the simulation step; reset invalidates its result.
        await context.request.post(url+"/_test/model", data={"mode":"localization_delay"})
        await step()
        await page.wait_for_function("window.sceneMap.data.localization.status==='running'")
        old_session = await page.evaluate("window.sceneMap.data.localization.session_id")
        await page.locator("#reset-button").click()
        await page.wait_for_function("window.sceneMap.data.simulation_minute===0")
        new_session=await page.evaluate("window.sceneMap.data.localization.session_id")
        assert new_session != old_session
        assert (await context.request.post(url+"/_test/localization-release")).ok
        for _ in range(100):
            status = await (await context.request.get(url+"/_test/status")).json()
            if old_session not in status["localization_workers"]:
                break
            await asyncio.sleep(.05)
        else:
            raise AssertionError("The retired localization worker did not finish")
        assert await page.evaluate("window.sceneMap.data.localization.session_id") == new_session
        assert not await page.evaluate("window.sceneMap.data.localization.jobs.length")
        assert not await page.locator('[data-testid="prediction-marker"]').count()
        assert await page.evaluate("window.sceneMap.zoom") == 1
        await context.request.post(url+"/_test/model", data={"mode":"valid"})
        await step()
        await page.wait_for_function("window.sceneMap.data.localization.status==='completed'")

        for width in (1600,1024,390):
            await page.set_viewport_size({"width":width,"height":1100})
            await page.locator("#community-map").scroll_into_view_if_needed()
            metrics=await page.evaluate("""() => ({width:innerWidth,documentWidth:document.documentElement.scrollWidth,
              badText:[...document.querySelectorAll('.candidate-row,.localization-error,.panel-header h2')].filter(e=>e.scrollWidth>e.clientWidth+1).length,
              mapWidth:document.getElementById('community-map').clientWidth})""")
            assert metrics["documentWidth"] <= width and metrics["badText"] == 0 and metrics["mapWidth"] > 250, metrics
            await page.screenshot(path=str(artifacts/f"integration-{width}.png"),full_page=True,animations="disabled")
            checks.append(metrics)
        assert not errors, errors
        await browser.close()
    print(json.dumps({"checks":checks,"image":pixels,"aligned_pois":alignment,"browser_errors":errors},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--url",default="http://127.0.0.1:8011")
    parser.add_argument("--artifacts", type=Path, default=ARTIFACTS)
    args=parser.parse_args()
    asyncio.run(main(args.url, args.artifacts))
