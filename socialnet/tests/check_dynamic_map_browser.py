"""Check the upstream motion layers against a socialnet mock backend."""
import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


async def check(url, artifacts):
    artifacts.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            page = await browser.new_page(viewport={"width": 1600, "height": 1100})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            assert (await page.request.get(url + "/_test/status")).ok
            assert (await page.request.post(url + "/api/simulation", data={"action": "reset"})).ok
            await page.goto(url)
            svg = page.locator("#community-map svg[data-testid=sandbox-svg]")
            trucks = svg.locator("[data-fire-truck]")
            car = svg.locator("[data-layer=vehicles] [data-actor]").first
            pedestrian = svg.locator("[data-pedestrian-route]").first
            await expect(trucks.locator("xpath=self::*[@data-status='idle']")).to_have_count(3)
            await expect(svg.locator("[data-layer=vehicles] [data-actor]")).to_have_count(56)
            await expect(svg.locator("[data-pedestrian-route]")).to_have_count(440)
            await page.wait_for_function("window.sceneMap.data?.persistence?.activation_id")
            previous = await car.get_attribute("transform"), await pedestrian.get_attribute("transform")
            await page.wait_for_function(
                """previous => ['[data-layer=vehicles] [data-actor]', '[data-pedestrian-route]']
                .every((selector, i) => document.querySelector(selector).getAttribute('transform') !== previous[i])""",
                arg=list(previous),
            )
            assert not await page.evaluate("window.sceneMap.data.running")
            await page.get_by_text("地图图层", exact=True).click()
            for label, layer in (("道路", "city-roads"), ("建筑", "city-buildings"), ("车辆", "vehicles"), ("行人", "pedestrians")):
                toggle = page.get_by_role("checkbox", name=label, exact=True)
                await toggle.uncheck()
                await expect(svg.locator(f"[data-layer={layer}]")).to_be_hidden()
                await toggle.check()
                await expect(svg.locator(f"[data-layer={layer}]")).to_be_visible()
            await page.get_by_text("地图图层", exact=True).click()
            await page.get_by_role("button", name="查看消防站").click()
            assert await page.evaluate("window.sceneMap.zoom") > 1
            await page.get_by_role("button", name="显示全图").click()

            await page.get_by_role("button", name="暂停地图动画").click()
            await expect(svg).to_have_attribute("data-simulation-paused", "true")
            previous = await car.get_attribute("transform"), await pedestrian.get_attribute("transform")
            await page.get_by_role("button", name="开始仿真").click()
            await page.wait_for_function("window.sceneMap.data.running")
            await expect(svg).to_have_attribute("data-simulation-paused", "true")
            assert previous == (await car.get_attribute("transform"), await pedestrian.get_attribute("transform"))
            await page.get_by_role("button", name="暂停仿真", exact=True).click()
            await page.wait_for_function("!window.sceneMap.data.running")
            await page.get_by_role("combobox", name="地图动画倍速").select_option("2")
            await expect(svg).to_have_attribute("data-simulation-speed", "2")

            # Exercise the same SceneMap entrypoint fed by HTTP and WebSocket above.
            # Deterministic snapshots make dispatch checks independent of generated report content.
            await page.evaluate("""() => {
                window.baseMapSnapshot = structuredClone(window.sceneMap.data);
                window.mapPrediction = ({targets, minute=5, status='completed', newActivation=false}) => {
                    const data = structuredClone(window.baseMapSnapshot);
                    data.simulation_minute = minute;
                    data.localization.status = status;
                    const candidates = targets.map((id, index) => {
                        const entity = data.entities.find(item => item.id === id);
                        return {poi_id: id, name: entity.name, rank: index + 1, votes: 2, score: 2,
                            coordinates: {x_m: entity.position.x, y_m: entity.position.y}, cluster_ids: ['test-' + id]};
                    });
                    data.localization.clusters = targets.map(id => ({
                        id: 'test-' + id, cold: false, last_timestamp: '2000-01-01T08:05:00+08:00'
                    }));
                    data.localization.prediction = {coordinate_system: 'CITY90x75', candidates};
                    if (newActivation) data.persistence.activation_id += '-new';
                    window.sceneMap.setData(data);
                };
            }""")
            async def predict(targets, **options):
                await page.evaluate("args => window.mapPrediction(args)", {"targets": targets, **options})

            first, second = "T-SW-01", "T-SW-02"
            await predict([first, second])
            await expect(svg).to_have_attribute("data-dispatch-target", first)
            await expect(svg.locator("[data-fire-truck][data-status=en-route]")).to_have_count(1)
            next_route = await trucks.evaluate_all("rows => rows.map(row => [row.dataset.status, row.getAttribute('transform')])")
            await predict([first, second], status="running")
            await expect(svg).to_have_attribute("data-dispatch-target", first)
            assert next_route == await trucks.evaluate_all("rows => rows.map(row => [row.dataset.status, row.getAttribute('transform')])")
            await predict([second, first])
            await expect(svg).to_have_attribute("data-dispatch-target", second)
            await predict([first])
            await expect(svg.locator("[data-map-candidate=T-SW-02]")).to_have_attribute("data-current", "false")
            await expect(svg).to_have_attribute("data-dispatch-target", first)
            await page.get_by_role("button", name="继续地图动画").click()
            await expect(svg.locator("[data-fire-truck][data-status=arrived]")).to_have_count(1, timeout=40_000)
            await expect(svg.locator("[data-water-for][visibility=visible]")).to_have_count(1)

            for width in (1600, 1024, 390):
                await page.set_viewport_size({"width": width, "height": 1100})
                assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                await page.screenshot(path=str(artifacts / f"dynamic-map-{width}.png"), full_page=True)
            await predict([first], minute=35)
            await expect(svg).to_have_attribute("data-dispatch-target", "")
            await expect(svg.locator("[data-water-for][visibility=visible]")).to_have_count(0)
            await expect(svg.locator("[data-fire-truck][data-status=returning]")).to_have_count(1)
            await predict([first], status="failed")
            await expect(svg).to_have_attribute("data-dispatch-target", "")
            await predict([])
            await expect(svg).to_have_attribute("data-dispatch-target", "")
            assert await svg.locator("[data-testid=historical-candidate-marker]").count() == 2
            await predict([], newActivation=True)
            await expect(svg.locator("[data-map-candidate]")).to_have_count(0)
            await expect(trucks.locator("xpath=self::*[@data-status='idle']")).to_have_count(3)
            await expect(svg).to_have_attribute("data-simulation-speed", "1")
            assert not errors, errors
            print(json.dumps({"vehicles": 56, "pedestrian_routes": 440, "arrival_and_return": True,
                              "display_widths": [1600, 1024, 390], "browser_errors": errors,
                              "artifacts": str(artifacts)}, ensure_ascii=False))
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".artifacts/dynamic-map-browser")
    args = parser.parse_args()
    asyncio.run(check(args.url, args.artifacts))
