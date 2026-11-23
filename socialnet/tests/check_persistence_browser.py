"""Start/restart an isolated mock backend; verify persistence through the real browser UI."""

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

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / ".artifacts" / ("persistence-browser-" + uuid4().hex[:8])


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
        log=(ARTIFACTS/"server.log").open("ab")
        process=subprocess.Popen([str(ROOT/".venv/bin/python"),"-B","-m","uvicorn","mock_server:app",
                                  "--app-dir","tests","--host","127.0.0.1","--port",str(port)],
                                 cwd=ROOT,env=env,stdout=log,stderr=log)
        log.close()
        for _ in range(200):
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
        async with async_playwright() as p:
            browser=await p.chromium.launch(args=["--no-sandbox","--disable-dev-shm-usage"])
            context=await browser.new_context(viewport={"width":1600,"height":1100})
            try:
                await context.request.put(url+"/api/fire-policy",data={"base_probability":1})
                for _ in range(45):
                    assert (await context.request.post(url+"/api/simulation",data={"action":"step"})).ok
                page=await context.new_page();errors=[]
                page.on("pageerror",lambda e:errors.append(str(e)))
                await page.goto(url)
                await page.wait_for_function("window.sceneMap?.data?.localization.status==='completed'",timeout=60000)
                state=await page.evaluate("window.sceneMap.data")
                assert state["simulation_minute"]==225 and state["report_total"]==45
                run_id=state["persistence"]["run_id"]
                assert "已保存" in await page.locator("#persistence-status").inner_text()
                await page.locator('[data-community="A-WEST"]').click()
                assert await page.locator("#chat-list .chat-message").count()==120
                first=await page.locator("#chat-list .chat-message").first.get_attribute("id")
                await page.locator("#chat-list").evaluate("el=>el.scrollTop=0")
                before=(await page.locator("#"+first).bounding_box())["y"]
                await page.locator("[data-load-messages]").click()
                await page.wait_for_function("document.querySelectorAll('#chat-list .chat-message').length===135")
                after=(await page.locator("#"+first).bounding_box())["y"]
                assert abs(after-before)<4,(before,after)
                await page.locator("[data-load-reports]").click()
                await page.wait_for_function("document.querySelectorAll('#report-list .report-card').length===45")
                all_reports=await (await context.request.get(url+"/api/reports?limit=200")).json()
                old_report=all_reports["items"][0]
                await page.reload()
                await page.wait_for_function("window.sceneMap?.data?.simulation_minute===225")
                await page.locator(".localization-jobs:not(.localization-clusters) summary").click()
                await page.locator('[data-report="'+old_report["id"]+'"]').first.click()
                await page.locator("#history-detail").wait_for(state="visible")
                assert old_report["summary"] in await page.locator("#history-detail-body").inner_text()
                await page.locator("#history-detail-close").click()
                await asyncio.to_thread(stop,process)
                process=await asyncio.to_thread(start)
                await page.reload()
                await page.wait_for_function("window.sceneMap?.data?.persistence.restored")
                restored=await page.evaluate("window.sceneMap.data")
                assert restored["persistence"]["run_id"]==run_id and not restored["running"]
                for key in ("fires","simulation_minute","chat_totals","report_total"):
                    assert restored[key]==state[key]
                assert restored["localization"]["prediction"]==state["localization"]["prediction"]
                counts=await (await context.request.get(url+"/_test/status")).json()
                assert counts["calls"]==counts["monitor_calls"]==0
                assert "已恢复，等待继续" in await page.locator("#persistence-status").inner_text()
                await page.locator("#step-button").click()
                await page.wait_for_function("window.sceneMap.data.simulation_minute===230")
                assert await page.evaluate("window.sceneMap.data.fires.length")==1
                await page.locator('[data-community="A-WEST"]').click()
                entered,release=asyncio.Event(),asyncio.Event()
                async def delay_history(route):
                    response=await route.fetch();body=await response.body()
                    entered.set();await release.wait();await route.fulfill(response=response,body=body)
                await page.route("**/api/communities/*/messages?*",delay_history)
                await page.locator("[data-load-messages]").click()
                await asyncio.wait_for(entered.wait(),5)
                await page.locator("#reset-button").click()
                await page.wait_for_function("window.sceneMap.data.simulation_minute===0")
                release.set();await page.wait_for_timeout(300)
                assert await page.locator("#chat-list .chat-message").count()==0
                assert await page.evaluate("window.sceneMap.data.persistence.run_id")!=run_id
                for width in (1600,390):
                    await page.set_viewport_size({"width":width,"height":1100})
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth")
                assert not errors,errors
                print(json.dumps({"restart_restores":True,"model_calls_on_restore":0,"history_messages":135,
                                  "history_reports":45,"history_scroll_stable":True,"stale_response_ignored":True,
                                  "browser_errors":errors,"artifacts":str(ARTIFACTS)},ensure_ascii=False))
            finally:await browser.close()
    finally:
        if process.poll() is None:await asyncio.to_thread(stop,process)


if __name__=="__main__":asyncio.run(main())
