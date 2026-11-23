import pytest

from app.agents import MonitorAgent, ResidentAgent
from dialogue_fixtures import model_fixture, monitor_fixture


def pytest_configure(config):
    config.addinivalue_line("markers", "real_chain: exercise production chain construction, without the model double")


@pytest.fixture(autouse=True)
def mock_agents(monkeypatch, request, tmp_path):
    monkeypatch.setenv("SIMULATION_STORAGE_PATH", str(tmp_path / "simulation.sqlite3"))
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_API_KEY", "")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_BASE_URL", "")
    monkeypatch.setenv("LOCALIZATION_EMBEDDING_MODEL", "")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    if not request.node.get_closest_marker("real_chain"):
        monkeypatch.setattr(ResidentAgent, "_build_chain", model_fixture)
        monkeypatch.setattr(MonitorAgent, "_build_chain", monitor_fixture)
