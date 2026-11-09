import time
from contextlib import contextmanager

import httpx
import pytest
from fastapi.testclient import TestClient

from home_service.app import create_app
from home_service.config import Settings

from .fake_asr import TOKEN, FakeASR

KEY = "home-test-key"
AUTH = {"Authorization": f"Bearer {KEY}"}


@pytest.fixture
def fake_asr():
    return FakeASR()


@pytest.fixture
def settings(tmp_path):
    originals = tmp_path / "nas" / "录音原件"
    originals.mkdir(parents=True)
    return Settings(
        access_key=KEY,
        originals_dir=originals,
        db_path=tmp_path / "home.sqlite3",
        asr_base_url="http://windows-asr",
        asr_token=TOKEN,
        poll_interval=0.0,
    )


@pytest.fixture
def start(settings, fake_asr):
    """返回一个上下文管理器：启动家里服务，yield TestClient。可重复调用模拟重启。"""

    @contextmanager
    def _start(transport: httpx.AsyncBaseTransport | None = None):
        app = create_app(settings, asr_transport=transport or httpx.ASGITransport(app=fake_asr.app))
        with TestClient(app) as client:
            yield client

    return _start


@pytest.fixture
def client(start):
    with start() as c:
        yield c


def upload(client, name="会议.m4a", data=b"fake-audio-bytes"):
    r = client.post("/recordings", headers=AUTH, files={"file": (name, data, "audio/mp4")})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def steps(client, rec_id):
    r = client.get(f"/recordings/{rec_id}", headers=AUTH)
    assert r.status_code == 200, r.text
    return {s["key"]: s["status"] for s in r.json()["steps"]}


def wait_for(client, rec_id, predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while True:
        r = client.get(f"/recordings/{rec_id}", headers=AUTH).json()
        if predicate(r):
            return r
        if time.monotonic() > deadline:
            raise AssertionError(f"等待超时，当前：{r}")
        time.sleep(0.02)


def settled(r):
    """流水线停下：要么失败，要么摘要一步已完成。"""
    st = {s["key"]: s["status"] for s in r["steps"]}
    return "failed" in st.values() or st["summarize"] == "done"
