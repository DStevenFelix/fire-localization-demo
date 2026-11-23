"""Archive manager UI against an isolated mock backend; never use a production URL."""

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
ARTIFACTS=ROOT/".artifacts"/("run-manager-browser-"+uuid4().hex[:8])


async def main():
    ARTIFACTS.mkdir(parents=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1",0));port=listener.getsockname()[1]
    url=f"http://127.0.0.1:{port}"
    env=dict(os.environ,OPENAI_API_KEY="",DASHSCOPE_API_KEY="",LOCALIZATION_EMBEDDING_API_KEY="",
             LANGSMITH_TRACING="false",LANGCHAIN_TRACING_V2="false",PYTHONDONTWRITEBYTECODE="1",
             SIMULATION_INTERVAL_SECONDS="3600",SIMULATION_STORAGE_PATH=str(ARTIFACTS/"simulation.sqlite3"),
             SIMULATION_TEST_RUNTIME=str(ARTIFACTS/"localization"))
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def start():
        with (ARTIFACTS/"server.log").open("ab") as log:
            process=subprocess.Popen([str(ROOT/".venv/bin/python"),"-B","-m","uvicorn","mock_server:app",
                "--app-dir","tests","--host","127.0.0.1","--port",str(port)],cwd=ROOT,env=env,stdout=log,stderr=log)
        for _ in range(200):
            if process.poll() is not None:raise RuntimeError("Mock backend failed; see server.log")
            try:
                with opener.open(url+"/api/state",timeout=.3) as response:
                    if response.status==200:return process
            except OSError:time.sleep(.05)
        process.terminate();process.wait(timeout=15);raise RuntimeError("Mock startup timed out")
    def stop(process):
        process.terminate()
        try:process.wait(timeout=15)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    process=await asyncio.to_thread(start)
    try:
        async with async_playwright() as p:
            browser=await p.chromium.launch(args=["--no-sandbox","--disable-dev-shm-usage"])
            context=await browser.new_context(viewport={"width":1600,"height":1100})
            try:
                await context.request.put(url+"/api/fire-policy",data={"base_probability":1})
                for _ in range(2):await context.request.post(url+"/api/simulation",data={"action":"step"})
                for _ in range(200):
                    old=await (await context.request.get(url+"/api/state")).json()
                    if old["localization"]["status"]=="completed":break
                    await asyncio.sleep(.02)
                aid=old["persistence"]["run_id"]
                blank=await (await context.request.post(url+"/api/simulation",data={"action":"reset"})).json()
                bid=blank["persistence"]["run_id"]
                page=await context.new_page();other=await context.new_page();errors=[]
                for view in (page,other):
                    view.on("pageerror",lambda e:errors.append(str(e)))
                    await view.goto(url);await view.wait_for_function("window.sceneMap?.data?.persistence.activation_id")
                    await view.locator("#archive-button").click()
                    await view.wait_for_selector(".archive-item")
                start_box=await page.locator("#start-button").bounding_box()
                archive_box=await page.locator("#archive-button").bounding_box()
                assert archive_box["x"]>=start_box["x"]+start_box["width"]
                assert abs(archive_box["height"]-start_box["height"])<1
                counts=await (await context.request.get(url+"/_test/status")).json()
                await page.locator('[data-run-load="'+aid+'"]').click()
                for view in (page,other):
                    await view.wait_for_function("id=>window.sceneMap.data.persistence.run_id===id",arg=aid)
                    assert not await view.evaluate("window.sceneMap.data.running")
                after=await (await context.request.get(url+"/_test/status")).json()
                assert counts["calls"]==after["calls"] and counts["monitor_calls"]==after["monitor_calls"]
                assert await page.evaluate("window.sceneMap.data.simulation_minute")==10
                await page.evaluate("old=>{acceptData(old);render();}",old)
                assert await page.evaluate("window.sceneMap.data.persistence.activation_sequence")>old["persistence"]["activation_sequence"]
                await page.evaluate("old=>{old.localization.revision=999999;state.socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'localization',localization:old.localization,persistence:old.persistence})}));}",old)
                assert await page.evaluate("window.sceneMap.data.localization.revision")!=999999
                # Start one slow step, then load another archive; the step must finish first.
                await page.locator("#archive-button").click();await page.wait_for_selector('[data-run-load="'+bid+'"]')
                await context.request.post(url+"/_test/model",data={"mode":"resident_delay"})
                step=asyncio.create_task(context.request.post(url+"/api/simulation",data={"action":"step"}))
                for _ in range(100):
                    status=await (await context.request.get(url+"/_test/status")).json()
                    if status["calls"]:break
                    await asyncio.sleep(.01)
                await page.locator('[data-run-load="'+bid+'"]').click()
                await page.wait_for_function("document.getElementById('archive-feedback').textContent.includes('等待当前步骤')")
                assert await page.locator("#start-button").is_disabled()
                assert (await context.request.post(url+"/api/simulation",data={"action":"step"})).status==409
                assert (await step).ok
                await page.wait_for_function("id=>window.sceneMap.data.persistence.run_id===id",arg=bid)
                await context.request.post(url+"/_test/model",data={"mode":"valid"})
                await page.locator("#archive-button").click();await page.wait_for_selector('[data-run-load="'+aid+'"]')
                await page.locator('[data-run-load="'+aid+'"]').click()
                await page.wait_for_function("id=>window.sceneMap.data.persistence.run_id===id",arg=aid)
                assert await page.evaluate("window.sceneMap.data.simulation_minute")==15
                await page.locator("#archive-button").click();await page.wait_for_selector('[data-run-delete="'+bid+'"]')
                for width in (1600,1024,390):
                    await page.set_viewport_size({"width":width,"height":1100})
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth")
                    box=await page.locator("#archive-dialog").bounding_box()
                    assert box["width"]<=width and box["x"]>=0
                    await page.screenshot(path=str(ARTIFACTS/f"archive-{width}.png"),animations="disabled")
                await page.set_viewport_size({"width":1600,"height":1100})
                # Cancel first, then permanently delete the non-current blank archive.
                await page.locator('[data-run-delete="'+bid+'"]').click()
                assert await page.locator("#archive-delete-dialog").is_visible()
                await page.locator("#archive-delete-cancel").click()
                assert (await (await context.request.get(url+"/api/runs")).json())["total"]==2
                await page.locator('[data-run-delete="'+bid+'"]').click();await page.locator("#archive-delete-confirm").click()
                await page.wait_for_function("id=>!document.querySelector('[data-run-id=\"'+id+'\"]')",arg=bid)
                await other.wait_for_function("id=>!document.querySelector('[data-run-id=\"'+id+'\"]')",arg=bid)
                # Deleting the active record creates an empty paused replacement everywhere.
                await page.locator('[data-run-delete="'+aid+'"]').click()
                assert "空白轮次" in await page.locator("#archive-delete-description").inner_text()
                await page.locator("#archive-delete-confirm").click()
                for view in (page,other):
                    await view.wait_for_function("id=>window.sceneMap.data.persistence.run_id!==id && window.sceneMap.data.simulation_minute===0",arg=aid)
                    assert not await view.evaluate("window.sceneMap.data.running")
                cid=await page.evaluate("window.sceneMap.data.persistence.run_id")
                listing=await (await context.request.get(url+"/api/runs")).json()
                assert listing["total"]==1 and listing["items"][0]["run_id"]==cid
                await asyncio.to_thread(stop,process);process=await asyncio.to_thread(start)
                await page.reload();await page.wait_for_function("window.sceneMap?.data?.persistence.restored")
                assert await page.evaluate("window.sceneMap.data.persistence.run_id")==cid
                assert (await (await context.request.get(url+"/api/runs")).json())["total"]==1
                assert not errors,errors
                print(json.dumps({"load_without_model_calls":True,"waits_for_step":True,"delete_cancel":True,
                    "delete_archived":True,"delete_current_creates_blank":True,"multi_page_sync":True,
                    "stale_activation_rejected":True,"restart_keeps_choice":True,"browser_errors":errors,
                    "artifacts":str(ARTIFACTS)},ensure_ascii=False))
            finally:await browser.close()
    finally:
        if process.poll() is None:await asyncio.to_thread(stop,process)


if __name__=="__main__":asyncio.run(main())
