"""Real UI on a temporary offline server: mixed risks, history, races and responsive layout."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
from uuid import uuid4
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/".artifacts"/("discovery-browser-"+uuid4().hex[:8])


async def main():
    ARTIFACTS.mkdir(parents=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1",0));port=listener.getsockname()[1]
    url=f"http://127.0.0.1:{port}"
    env=dict(os.environ,OPENAI_API_KEY="",DASHSCOPE_API_KEY="",LOCALIZATION_EMBEDDING_API_KEY="",
             LANGSMITH_TRACING="false",LANGCHAIN_TRACING_V2="false",PYTHONDONTWRITEBYTECODE="1",
             SIMULATION_STORAGE_PATH=str(ARTIFACTS/"simulation.sqlite3"),
             SIMULATION_TEST_RUNTIME=str(ARTIFACTS/"localization"))
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def start():
        with (ARTIFACTS/"server.log").open("ab") as log:
            process=subprocess.Popen([str(ROOT/".venv/bin/python"),"-B","-m","uvicorn","discovery_mock_server:app",
                                      "--app-dir","tests","--host","127.0.0.1","--port",str(port)],
                                     cwd=ROOT,env=env,stdout=log,stderr=log)
        for _ in range(240):
            if process.poll() is not None:raise RuntimeError("Mock startup failed; see server.log")
            try:
                with opener.open(url+"/api/state",timeout=.3) as response:
                    if response.status==200:return process
            except OSError:time.sleep(.05)
        process.terminate();process.wait(timeout=10)
        raise RuntimeError("Mock startup timed out")
    def stop(process):
        process.terminate()
        try:process.wait(timeout=15)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    process=await asyncio.to_thread(start)
    try:
        async with async_playwright() as playwright:
            browser=await playwright.chromium.launch(args=["--no-sandbox","--disable-dev-shm-usage"])
            try:
                page=await browser.new_page(viewport={"width":1600,"height":1100});errors=[]
                page.on("pageerror",lambda error:errors.append(str(error)))
                await page.goto(url)
                await page.wait_for_function("window.sceneMap?.data?.discovery")
                assert await page.locator("#discovery-scanned").inner_text()=="0"
                await page.request.put(url+"/api/fire-policy",data={"base_probability":0})
                await page.request.post(url+"/_test/discovery")
                for _ in range(4):
                    response=await page.request.post(url+"/api/simulation",data={"action":"step"})
                    assert response.ok,await response.text()
                await page.wait_for_function("window.sceneMap.data.discovery.candidate_total===80")
                state=await page.evaluate("window.sceneMap.data");run=state["persistence"]["run_id"]
                assert await page.locator("#discovery-list .discovery-card").count()==50
                assert await page.locator("#discovery-scanned").inner_text()=="120"
                assert await page.locator("#discovery-forwarded").inner_text()=="32"
                assert await page.locator("#discovery-list img").count()==0
                assert not await page.evaluate("window.BAD")
                assert "转述" in await page.locator("#discovery-list").inner_text()
                await page.locator('[data-community="A-WEST"]').click()
                assert await page.locator("#discovery-community").input_value()==""
                assert await page.locator("#discovery-list .discovery-card").count()==50
                await page.locator("#discovery-category").select_option("security")
                assert await page.locator("#discovery-list .discovery-card").count()>0
                assert all("治安" in text for text in await page.locator("#discovery-list .discovery-card-top").all_inner_texts())
                await page.locator("#discovery-category").select_option("")
                await page.locator("#discovery-community").select_option("A-WEST")
                assert "锦安" in await page.locator("#discovery-list").inner_text()
                await page.locator("#discovery-list .discovery-reasons summary").first.click()
                assert await page.locator("#discovery-list .discovery-reasons[open]").count()==1
                await page.locator("#community-switch").select_option("A-EAST")
                assert await page.locator("#discovery-community").input_value()=="A-WEST"
                assert await page.locator("#discovery-list .discovery-reasons[open]").count()==1
                await page.locator("[data-discovery-source]").first.click()
                await page.locator("#history-detail").wait_for(state="visible")
                assert "焦味" in await page.locator("#history-detail-body").inner_text()
                await page.locator("#history-detail-close").click()
                await page.locator("#discovery-community").select_option("")
                await page.locator("#discovery-older").click()
                await page.wait_for_function("document.querySelector('#discovery-scope').textContent.includes('历史分页')")
                assert await page.locator("#discovery-list .discovery-card").count()==30
                assert await page.locator("#discovery-older").is_disabled()
                await page.locator("#discovery-latest").click()
                assert await page.locator("#discovery-list .discovery-card").count()==50
                # The two column panels must scroll independently.
                scroll=await page.evaluate("""() => {const d=document.querySelector('#discovery-list'), c=document.querySelector('#chat-list');
                    const before=c.scrollTop;d.scrollTop=80;return {discovery:d.scrollTop,chat:c.scrollTop,before};} """)
                assert scroll["discovery"]>0 and scroll["chat"]==scroll["before"]
                layouts={}
                for width in (1600,1024,390):
                    await page.set_viewport_size({"width":width,"height":1100})
                    await page.wait_for_timeout(100)
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth"),width
                    chat=await page.locator(".chat-panel").bounding_box();discovery=await page.locator(".discovery-panel").bounding_box()
                    assert discovery["y"]>=chat["y"]+chat["height"]-1
                    assert (await page.locator("#discovery-list").bounding_box())["height"]>90
                    await page.locator(".discovery-panel").scroll_into_view_if_needed()
                    await page.screenshot(path=str(ARTIFACTS/f"discovery-{width}.png"),full_page=True)
                    layouts[str(width)]={"chat_height":round(chat["height"]),"discovery_height":round(discovery["height"])}
                await page.set_viewport_size({"width":1600,"height":1100})
                # A delayed history response must not overwrite a changed filter.
                async def delayed(route):
                    response=await route.fetch();await asyncio.sleep(.5);await route.fulfill(response=response)
                await page.route("**/api/discovery?*",delayed)
                await page.locator("#discovery-older").click()
                await page.locator("#discovery-category").select_option("traffic")
                await page.wait_for_timeout(800)
                assert "最近50" in await page.locator("#discovery-scope").inner_text()
                assert all("交通" in text for text in await page.locator("#discovery-list .discovery-card-top").all_inner_texts())
                await page.locator("#discovery-category").select_option("")
                await page.locator("#discovery-older").click()
                reset=await (await page.request.post(url+"/api/simulation",data={"action":"reset"})).json()
                await page.wait_for_function("window.sceneMap.data.discovery.scanned_total===0")
                await page.wait_for_timeout(800)
                assert await page.locator("#discovery-list .discovery-card").count()==0
                await page.unroute("**/api/discovery?*",delayed)
                # Switch back and restart without any generation; state and history remain intact.
                new=reset["persistence"]["run_id"]
                assert (await page.request.post(url+f"/api/runs/{run}/activate",data={"expected_run_id":new})).ok
                await page.wait_for_function("window.sceneMap.data.discovery.candidate_total===80")
                await asyncio.to_thread(stop,process);process=await asyncio.to_thread(start)
                await page.reload();await page.wait_for_function("window.sceneMap?.data?.persistence.restored")
                assert (await page.evaluate("window.sceneMap.data.discovery"))==state["discovery"]
                counts=await (await page.request.get(url+"/_test/status")).json()
                assert counts["calls"]==counts["monitor_calls"]==0
                assert not errors,errors
                result={"candidate_total":80,"retained":50,"older_page":30,"layouts":layouts,
                        "public_html_escaped":True,"independent_filters_and_scroll":True,
                        "stale_response_ignored":True,"restart_without_model_calls":True,"browser_errors":errors}
                (ARTIFACTS/"validation.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
                print(json.dumps(dict(result,artifacts=str(ARTIFACTS)),ensure_ascii=False))
            finally:await browser.close()
    finally:
        if process.poll() is None:await asyncio.to_thread(stop,process)


if __name__=="__main__":asyncio.run(main())
