import os
import shutil
import tempfile
from pathlib import Path

import pytest

# must happen before anything imports app.config / app.db
_TMP = Path(tempfile.mkdtemp(prefix="mixai-test-"))
os.environ.update(
    {
        "APP_ENV": "dev",
        "APP_SECRET": "test-secret",
        "DATABASE_URL": f"sqlite:///{(_TMP / 'test.db').as_posix()}",
        "DATA_DIR": str(_TMP / "data"),
        "ADMIN_EMAIL": "admin@test.local",
        "ADMIN_PASSWORD": "pw-test-123",
        "ADMIN_NAME": "Tester",
        "GEN_DRIVER": "mock",
        "COMFY_URLS": "",
        "CORS_ORIGINS": "http://localhost:5173",
        # nothing listens on port 9: tests never reach a real Ollama unless they install a fake transport
        "LLM_BASE_URL": "http://127.0.0.1:9/v1",
        "LLM_API": "openai",
        "LLM_MODEL_REASONING": "fake-reasoner",
        "LLM_MODEL_CREATIVE": "fake-writer",
        "LLM_MODEL_VISION": "fake-eye",
        "LLM_REASONING_FORMAT": "deepseek",
        # older tests script the fake LLM call by call; an extra enhancer call would shift them
        "MAGIC_PROMPT_DEFAULT": "off",
    }
)

from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402,F401
from app.config import get_settings  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.drivers.mock import MockDriver  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import seed  # noqa: E402

ADMIN = {"email": "admin@test.local", "password": "pw-test-123"}


def pytest_sessionfinish(session, exitstatus):
    engine.dispose()
    shutil.rmtree(_TMP, ignore_errors=True)


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    shutil.rmtree(get_settings().data_dir, ignore_errors=True)
    get_settings().data_dir.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as db:
        seed(db)
    yield


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def anon():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def client():
    with TestClient(app) as c:
        r = c.post("/api/auth/login", json=ADMIN)
        assert r.status_code == 200, r.text
        yield c


@pytest.fixture
def fast_driver():
    return lambda: MockDriver(step_seconds=0)


@pytest.fixture
def project(client):
    r = client.post("/api/projects", json={"title": "Reef", "authoring_mode": "scene_by_scene"})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def character(client, project):
    r = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Diver", "description": "Grey hair"})
    assert r.status_code == 201, r.text
    return r.json()
