import asyncio

import httpx
import pytest

from home_service.beebox import BeeBoxClient, check_base_url
from home_service.config import Settings
from home_service.pipeline import Pipeline
from home_service.store import Store

from .conftest import AUTH, settled, steps, upload, wait_for
from .fake_beebox import MD, SRT, TOKEN, VIDEO, FakeBeeBox


def test_uploaded_recording_is_transcribed_and_waits_for_beer(client, fake_beebox):
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert steps(client, rec_id) == {"upload": "done", "queue": "done", "transcribe": "done",
                                     "summarize": "done", "store": "pending"}
    assert [s["name"] for s in r["steps"]] == ["上传", "排队", "转写", "摘要", "入库"]
    assert r["job_status"] == "succeeded"
    assert r["stage"] == "done"
    # 先上传文件拿到 id，再建任务
    assert fake_beebox.count("POST", "/v1/files") == 1
    assert fake_beebox.count("POST", "/v1/jobs", exact=True) == 1
    [job] = fake_beebox.jobs.values()
    assert job["source"]["type"] == "file"
    assert fake_beebox.files[job["source"]["file_id"]]["data"] == b"fake-audio-bytes"


def test_only_v1_endpoints_are_called(client, fake_beebox):
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    client.post(f"/recordings/{rec_id}/stored", headers=AUTH)
    client.get("/health", headers=AUTH)

    assert fake_beebox.requests
    assert all(path.startswith("/v1/") for _, path in fake_beebox.requests)


def test_transcript_returns_markdown_srt_and_source(client):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)

    r = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["markdown"] == MD
    assert body["srt"] == SRT
    assert body["filename"] == "周会.m4a"
    assert body["source"]["text_source"] == "asr"
    assert body["source"]["filename"] == "周会.m4a"


def test_transcript_not_available_while_transcribing(client, fake_beebox):
    fake_beebox.hold = True  # 停在排队
    rec_id = upload(client)
    wait_for(client, rec_id, lambda r: r["steps"][1]["status"] == "running")

    r = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error_code"] == "NOT_READY"


def test_progress_and_stage_shown_while_running(client, fake_beebox):
    fake_beebox.script = ["queued", "running"]  # 一直转写中
    rec_id = upload(client)

    r = wait_for(client, rec_id, lambda r: r["steps"][2]["status"] == "running" and r["stage"] == "transcribe")
    assert r["status"] == "processing"
    assert r["steps"][1]["status"] == "done"
    assert r["job_status"] == "running"
    assert r["progress"] == 70.0  # BeeBox 的 0.7 换算成百分比，Beer 照旧按 0–100 显示


def test_beer_confirms_store_step_and_beebox_job_is_deleted(client, fake_beebox):
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    [job_id] = fake_beebox.jobs

    r = client.post(f"/recordings/{rec_id}/stored", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["status"] == "stored"
    assert steps(client, rec_id)["store"] == "done"
    assert fake_beebox.count("DELETE", f"/v1/jobs/{job_id}") == 1
    assert fake_beebox.jobs == {}


def test_store_succeeds_even_if_beebox_job_already_gone(client, fake_beebox):
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    fake_beebox.forget(next(iter(fake_beebox.jobs)))

    r = client.post(f"/recordings/{rec_id}/stored", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["status"] == "stored"


def test_store_confirmation_rejected_before_ready(client, fake_beebox):
    fake_beebox.hold = True
    rec_id = upload(client)

    r = client.post(f"/recordings/{rec_id}/stored", headers=AUTH)
    assert r.status_code == 409


def test_new_results_are_listed_for_beer(client):
    first = upload(client, name="a.m4a")
    second = upload(client, name="b.m4a")
    wait_for(client, first, settled)
    wait_for(client, second, settled)

    listed = client.get("/recordings", headers=AUTH, params={"status": "ready"}).json()["recordings"]
    assert {r["id"] for r in listed} == {first, second}

    client.post(f"/recordings/{first}/stored", headers=AUTH)
    listed = client.get("/recordings", headers=AUTH, params={"status": "ready"}).json()["recordings"]
    assert [r["id"] for r in listed] == [second]


# ---- 失败与重试：按五种状态与 retryable ----

def test_not_ready_fails_queue_step_then_retry_continues(client, fake_beebox):
    fake_beebox.ready = False
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["status"] == "failed"
    assert steps(client, rec_id)["queue"] == "failed"
    assert r["error_code"] == "BEEBOX_NOT_READY"
    assert r["retryable"] is True
    assert fake_beebox.count("POST", "/v1/files") == 0

    fake_beebox.ready = True
    assert client.post(f"/recordings/{rec_id}/retry", headers=AUTH).status_code == 202
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert r["error_code"] is None
    assert r["retryable"] is None


def test_retryable_failure_resumes_on_beebox_without_reupload(client, fake_beebox):
    fake_beebox.script = ["queued", "running", "failed"]
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert steps(client, rec_id) == {"upload": "done", "queue": "done", "transcribe": "failed",
                                     "summarize": "pending", "store": "pending"}
    assert r["error_code"] == "SPEECH_ENGINE_FAILED"
    assert r["job_status"] == "failed"
    assert r["retryable"] is True
    assert "转写引擎出错" in r["error"]

    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert fake_beebox.count("POST", "/v1/files") == 1  # 没有重新上传
    assert fake_beebox.count("POST", "/v1/jobs", exact=True) == 1
    assert fake_beebox.count("POST", "/v1/jobs/") == 1  # 走的是任务重试接口


def test_interrupted_job_reported_and_resumed(client, fake_beebox):
    fake_beebox.script = ["queued", "running", "failed"]
    fake_beebox.fail_code = "TASK_INTERRUPTED"
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["error_code"] == "TASK_INTERRUPTED"
    assert "重启打断" in r["error"]
    assert steps(client, rec_id)["transcribe"] == "failed"

    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    assert wait_for(client, rec_id, settled)["status"] == "ready"
    assert client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()["markdown"] == MD


def test_non_retryable_failure_is_reported_and_retry_submits_new_job(client, fake_beebox):
    fake_beebox.script = ["queued", "failed"]
    fake_beebox.fail_code = "MODEL_NOT_DOWNLOADED"
    fake_beebox.fail_retryable = False
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["status"] == "failed"
    assert r["error_code"] == "MODEL_NOT_DOWNLOADED"
    assert r["retryable"] is False
    assert "控制台下载" in r["error"]
    [old_job] = fake_beebox.jobs

    # 用户在 BeeBox 控制台下好模型后点重试：不能在原任务上重试，改为新建任务
    fake_beebox.script = ["queued", "running", "succeeded"]
    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert fake_beebox.count("POST", f"/v1/jobs/{old_job}/retry") == 0
    assert fake_beebox.count("DELETE", f"/v1/jobs/{old_job}") == 1
    assert fake_beebox.count("POST", "/v1/files") == 2
    assert old_job not in fake_beebox.jobs


def test_cancelled_job_fails_and_retry_submits_new_job(client, fake_beebox):
    fake_beebox.script = ["queued", "cancelled"]
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["status"] == "failed"
    assert r["error_code"] == "TASK_CANCELLED"
    assert r["job_status"] == "cancelled"

    fake_beebox.script = ["queued", "running", "succeeded"]
    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    assert wait_for(client, rec_id, settled)["status"] == "ready"
    assert fake_beebox.count("POST", "/v1/jobs", exact=True) == 2


def test_job_gone_on_beebox_resubmits_from_original(client, fake_beebox):
    fake_beebox.script = ["queued", "running", "failed"]
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    fake_beebox.forget(next(iter(fake_beebox.jobs)))  # 比如过了保留期

    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    fake_beebox.script = ["queued", "running", "succeeded"]
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert fake_beebox.count("POST", "/v1/files") == 2


def test_retry_rejected_when_not_failed(client):
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    assert client.post(f"/recordings/{rec_id}/retry", headers=AUTH).status_code == 409


def test_wrong_token_fails_with_hint(settings, fake_beebox):
    with _start_with(settings, fake_beebox, beebox_token="wrong") as client:
        rec_id = upload(client)
        r = wait_for(client, rec_id, settled)
        assert r["error_code"] == "AUTH_INVALID_TOKEN"
        assert "HOME_BEEBOX_TOKEN" in r["error"]


def _start_with(settings, fake_beebox, **changes):
    from dataclasses import replace

    from fastapi.testclient import TestClient

    from home_service.app import create_app

    app = create_app(replace(settings, **changes), beebox_transport=httpx.ASGITransport(app=fake_beebox.app))
    return TestClient(app)


def test_windows_unreachable_fails_with_clear_error(start):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    with start(httpx.MockTransport(refuse)) as client:
        rec_id = upload(client)
        r = wait_for(client, rec_id, settled)
        assert r["status"] == "failed"
        assert r["error_code"] == "WINDOWS_UNREACHABLE"
        assert steps(client, rec_id)["queue"] == "failed"


# ---- 视频链接任务（给 #34 用的能力） ----

def test_video_link_job_is_submitted_followed_and_returns_source(tmp_path):
    fake = FakeBeeBox()

    async def run():
        store = Store(tmp_path / "home.sqlite3")
        beebox = BeeBoxClient("http://windows-beebox", TOKEN, transport=httpx.ASGITransport(app=fake.app))
        pipeline = Pipeline(store, beebox, poll_interval=0.0)
        url = "https://www.bilibili.com/video/BV1xx411c7mD"
        store.create("v1", "测试视频", "", source_url=url)
        pipeline.start("v1")
        await pipeline.wait("v1")
        rec = store.get("v1")
        await beebox.aclose()
        store.close()
        return url, rec

    url, rec = asyncio.run(run())
    assert rec["steps"]["transcribe"] == "done"
    assert rec["transcript_md"] == MD and rec["transcript_srt"] == SRT
    assert fake.count("POST", "/v1/files") == 0
    [job] = fake.jobs.values()
    assert job["source"] == {"type": "url", "url": url}
    import json
    source = json.loads(rec["source_info"])
    assert source["url"] == url
    assert source["title"] == VIDEO["title"] and source["author"] == VIDEO["author"]
    assert source["text_source"] == "platform_manual"


def test_video_link_failure_maps_error_code(tmp_path):
    fake = FakeBeeBox()
    fake.script = ["queued", "failed"]
    fake.fail_code = "VIDEO_LOGIN_REQUIRED"

    async def run():
        store = Store(tmp_path / "home.sqlite3")
        beebox = BeeBoxClient("http://windows-beebox", TOKEN, transport=httpx.ASGITransport(app=fake.app))
        pipeline = Pipeline(store, beebox, poll_interval=0.0)
        store.create("v1", "需要登录的视频", "", source_url="https://www.bilibili.com/video/BV1")
        pipeline.start("v1")
        await pipeline.wait("v1")
        rec = store.get("v1")
        await beebox.aclose()
        store.close()
        return rec

    rec = asyncio.run(run())
    assert rec["error_code"] == "VIDEO_LOGIN_REQUIRED"
    assert "扫码登录" in rec["error"]


# ---- 配置 ----

@pytest.mark.parametrize("url", ["http://win:17494/v1", "http://win:17494/api", "win:17494", "http://win:17494/?x=1"])
def test_base_url_must_be_host_only(url):
    with pytest.raises(ValueError):
        check_base_url(url)


def test_base_url_trailing_slash_is_normalized():
    assert check_base_url("http://win:17494/") == "http://win:17494"


def test_old_asr_env_names_are_rejected_with_rename_hint(monkeypatch, tmp_path):
    for name, value in {"HOME_ACCESS_KEY": "k", "HOME_ORIGINALS_DIR": str(tmp_path), "HOME_DB_PATH": str(tmp_path / "d"),
                        "HOME_ASR_BASE_URL": "http://win:8080/api"}.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError, match="HOME_BEEBOX_BASE_URL"):
        Settings.from_env()


def test_beebox_env_names_are_read(monkeypatch, tmp_path):
    for name, value in {"HOME_ACCESS_KEY": "k", "HOME_ORIGINALS_DIR": str(tmp_path), "HOME_DB_PATH": str(tmp_path / "d"),
                        "HOME_BEEBOX_BASE_URL": "http://win:17494", "HOME_BEEBOX_TOKEN": "t"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("HOME_ASR_BASE_URL", raising=False)
    monkeypatch.delenv("HOME_ASR_TOKEN", raising=False)
    s = Settings.from_env()
    assert (s.beebox_base_url, s.beebox_token) == ("http://win:17494", "t")


# ---- 状态持久化 ----

def test_progress_survives_restart_and_pipeline_resumes(start, fake_beebox):
    fake_beebox.hold = True
    with start() as client:
        rec_id = upload(client)
        # 已提交到 BeeBox、正在排队（有了进度数字）
        wait_for(client, rec_id, lambda r: r["steps"][1]["status"] == "running" and r["progress"] is not None)

    fake_beebox.hold = False
    with start() as client:  # 模拟服务重启
        r = wait_for(client, rec_id, settled)
        assert r["status"] == "ready"
    assert fake_beebox.count("POST", "/v1/files") == 1


def test_finished_state_persists_across_restart(start):
    with start() as client:
        rec_id = upload(client)
        wait_for(client, rec_id, settled)
        client.post(f"/recordings/{rec_id}/stored", headers=AUTH)

    with start() as client:
        assert steps(client, rec_id)["store"] == "done"
        assert client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).status_code == 200


# ---- 删除失败的录音（#30） ----

def test_delete_failed_recording_keeps_original_on_nas(client, fake_beebox, settings):
    fake_beebox.ready = False
    rec_id = upload(client, name="烟测.wav")
    original = client.get(f"/recordings/{rec_id}", headers=AUTH).json()["original_path"]
    wait_for(client, rec_id, settled)

    r = client.delete(f"/recordings/{rec_id}", headers=AUTH)
    assert r.status_code == 204
    assert client.get(f"/recordings/{rec_id}", headers=AUTH).status_code == 404
    listed = client.get("/recordings", headers=AUTH).json()["recordings"]
    assert rec_id not in {x["id"] for x in listed}
    # 没配 WebDAV 时本地目录就是 NAS 挂载点，原件必须还在
    assert open(original, "rb").read() == b"fake-audio-bytes"


def test_delete_failed_recording_also_deletes_beebox_job(client, fake_beebox):
    fake_beebox.script = ["queued", "failed"]
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    [job_id] = fake_beebox.jobs

    assert client.delete(f"/recordings/{rec_id}", headers=AUTH).status_code == 204
    assert fake_beebox.count("DELETE", f"/v1/jobs/{job_id}") == 1


def test_delete_missing_recording_is_404(client):
    r = client.delete("/recordings/nope", headers=AUTH)
    assert r.status_code == 404
    assert r.json()["error_code"] == "NOT_FOUND"


def test_delete_rejected_unless_failed(client, fake_beebox):
    done = upload(client)
    wait_for(client, done, settled)
    r = client.delete(f"/recordings/{done}", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error_code"] == "NOT_FAILED"

    fake_beebox.hold = True
    running = upload(client)
    assert client.delete(f"/recordings/{running}", headers=AUTH).status_code == 409
    assert client.get(f"/recordings/{running}", headers=AUTH).status_code == 200


def test_deleted_recording_stays_gone_after_restart(start, fake_beebox):
    fake_beebox.ready = False
    with start() as client:
        rec_id = upload(client)
        wait_for(client, rec_id, settled)
        assert client.delete(f"/recordings/{rec_id}", headers=AUTH).status_code == 204
    with start() as client:
        assert client.get(f"/recordings/{rec_id}", headers=AUTH).status_code == 404


@pytest.mark.parametrize("code, words", [
    ("DOWNLOAD_NETWORK_ERROR", "网络出错"),
    ("LOCAL_TOOL_MISSING", "ffmpeg"),
])
def test_video_download_errors_have_chinese_hints(code, words):
    from home_service.beebox import hint

    text = hint(code, "boom")
    assert words in text and "BeeBox 转写出错" not in text
