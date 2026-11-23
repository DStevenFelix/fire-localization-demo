"""Browser-test application. Start explicitly with --app-dir tests, never in production."""

from fastapi import HTTPException
import asyncio
from threading import Event
from langchain_core.runnables import RunnableLambda

from app.agents import MonitorAgent, ResidentAgent
from dialogue_fixtures import model_fixture, monitor_fixture

control = {"mode": "valid", "calls": 0, "corrections": 0, "monitor_calls": 0}
localization_release = Event()


def controlled_model(agent):
    model = model_fixture(agent)
    async def generate(values):
        control["calls"] += 1
        if control["mode"] == "resident_delay":
            await asyncio.sleep(.4)
        if control["mode"] == "request_failure":
            raise RuntimeError("TEST-PRIVATE-PROVIDER-RESPONSE")
        if control["mode"] == "timeout":
            raise TimeoutError("TEST-PRIVATE-TIMEOUT")
        if control["mode"] == "validation_failure":
            return ""
        return await model.ainvoke(values)
    return RunnableLambda(generate)


ResidentAgent._build_chain = controlled_model


def controlled_monitor(agent):
    model = monitor_fixture(agent)
    async def generate(values):
        control["monitor_calls"] += 1
        if control["mode"] == "monitor_failure":
            raise RuntimeError("TEST-PRIVATE-MONITOR-RESPONSE")
        if control["mode"] == "monitor_timeout":
            raise TimeoutError("TEST-PRIVATE-MONITOR-TIMEOUT")
        if control["mode"] == "monitor_invalid" or (control["mode"] == "monitor_repair_once" and values["repair_feedback"] == "无，首次生成。"):
            return "not JSON"
        return await model.ainvoke(values)
    return RunnableLambda(generate)


MonitorAgent._build_chain = controlled_monitor
from app.main import app  # noqa: E402
from app import main
import os
from pathlib import Path

if os.getenv("SIMULATION_TEST_RUNTIME"):
    main.localization.runtime_root = Path(os.environ["SIMULATION_TEST_RUNTIME"])


def controlled_localizer(path):
    from app.spatial import ROOT
    from fire_locator.engine import FireLocalizer
    from fire_locator.config import Settings
    engine = FireLocalizer(Settings(root=ROOT), offline=True, state_path=path)
    original = engine.extractor.extract
    def extract(posts):
        if control["mode"] == "localization_failure":
            raise TimeoutError("TEST-PRIVATE-LOCALIZATION")
        if control["mode"] == "localization_delay" and not localization_release.wait(12):
            raise TimeoutError("Mock localization was not released")
        return original(posts)
    engine.extractor.extract = extract
    return engine


main.localization.factory = controlled_localizer


@app.get("/_test/status")
async def test_status():
    return {**control, "localization_workers": sorted(main.localization.busy_sessions())}


@app.post("/_test/localization-release")
async def release_localization():
    localization_release.set()
    return {"released": True}


@app.post("/_test/model")
async def set_model(payload: dict):
    mode = payload.get("mode")
    if mode not in ("valid", "resident_delay", "request_failure", "timeout", "validation_failure",
                    "monitor_failure", "monitor_timeout", "monitor_invalid", "monitor_repair_once",
                    "localization_failure", "localization_delay"):
        raise HTTPException(status_code=400, detail="Invalid test mode")
    if mode == "localization_delay":
        localization_release.clear()
    control.update(mode=mode, calls=0, corrections=0, monitor_calls=0)
    return control
