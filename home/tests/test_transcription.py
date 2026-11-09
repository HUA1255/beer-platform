import httpx

from .conftest import AUTH, settled, steps, upload, wait_for
from .fake_asr import MD, SRT


def test_uploaded_recording_is_transcribed_and_waits_for_beer(client, fake_asr):
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert steps(client, rec_id) == {"upload": "done", "queue": "done", "transcribe": "done",
                                     "summarize": "done", "store": "pending"}
    assert [s["name"] for s in r["steps"]] == ["上传", "排队", "转写", "摘要", "入库"]
    assert fake_asr.count("GET", "/transcriptions/readiness") >= 1
    assert fake_asr.count("POST", "/transcriptions") == 1


def test_transcript_returns_markdown_and_srt(client):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)

    r = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["markdown"] == MD
    assert body["srt"] == SRT
    assert body["filename"] == "周会.m4a"


def test_transcript_not_available_while_transcribing(client, fake_asr):
    fake_asr.hold = True  # 停在排队
    rec_id = upload(client)
    wait_for(client, rec_id, lambda r: r["steps"][1]["status"] == "running")

    r = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error_code"] == "NOT_READY"


def test_progress_shows_transcribing(client, fake_asr):
    fake_asr.script = ["queued", "transcribing"]  # 一直转写中
    rec_id = upload(client)

    r = wait_for(client, rec_id, lambda r: r["steps"][2]["status"] == "running")
    assert r["status"] == "processing"
    assert r["steps"][1]["status"] == "done"
    assert r["progress"] == 70.0


def test_beer_confirms_store_step(client):
    rec_id = upload(client)
    wait_for(client, rec_id, settled)

    r = client.post(f"/recordings/{rec_id}/stored", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["status"] == "stored"
    assert steps(client, rec_id)["store"] == "done"


def test_store_confirmation_rejected_before_ready(client, fake_asr):
    fake_asr.hold = True
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


# ---- 失败与从断点重试 ----

def test_not_ready_fails_queue_step_then_retry_continues(client, fake_asr):
    fake_asr.ready = False
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["status"] == "failed"
    assert steps(client, rec_id)["queue"] == "failed"
    assert r["error_code"] == "ASR_NOT_READY"
    assert "qwen3-asr-1.7b" in r["error"]
    assert fake_asr.count("POST", "/transcriptions") == 0

    fake_asr.ready = True
    assert client.post(f"/recordings/{rec_id}/retry", headers=AUTH).status_code == 202
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert r["error_code"] is None


def test_failed_transcription_retries_remote_task_without_reupload(client, fake_asr):
    fake_asr.script = ["queued", "transcribing", "failed"]
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert steps(client, rec_id) == {"upload": "done", "queue": "done", "transcribe": "failed",
                                     "summarize": "pending", "store": "pending"}
    assert r["error_code"] == "CHUNK_FAILED"

    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "ready"
    assert fake_asr.count("POST", "/transcriptions") == 1  # 没有重新上传
    assert fake_asr.count("POST", "/tasks/") == 1


def test_interrupted_transcription_can_be_resumed(client, fake_asr):
    fake_asr.script = ["queued", "transcribing", "interrupted"]
    rec_id = upload(client)

    r = wait_for(client, rec_id, settled)
    assert r["error_code"] == "TASK_INTERRUPTED"
    assert steps(client, rec_id)["transcribe"] == "failed"

    client.post(f"/recordings/{rec_id}/retry", headers=AUTH)
    assert wait_for(client, rec_id, settled)["status"] == "ready"
    assert client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()["markdown"] == MD


def test_retry_rejected_when_not_failed(client):
    rec_id = upload(client)
    wait_for(client, rec_id, settled)
    assert client.post(f"/recordings/{rec_id}/retry", headers=AUTH).status_code == 409


def test_windows_unreachable_fails_with_clear_error(start):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    with start(httpx.MockTransport(refuse)) as client:
        rec_id = upload(client)
        r = wait_for(client, rec_id, settled)
        assert r["status"] == "failed"
        assert r["error_code"] == "WINDOWS_UNREACHABLE"
        assert steps(client, rec_id)["queue"] == "failed"


# ---- 状态持久化 ----

def test_progress_survives_restart_and_pipeline_resumes(start, fake_asr):
    fake_asr.script = ["queued", "transcribing", "completed"]
    fake_asr.hold = True
    with start() as client:
        rec_id = upload(client)
        # 已提交到 Windows、正在排队（有了进度数字）
        wait_for(client, rec_id, lambda r: r["steps"][1]["status"] == "running" and r["progress"] is not None)

    fake_asr.hold = False
    with start() as client:  # 模拟服务重启
        r = wait_for(client, rec_id, settled)
        assert r["status"] == "ready"
    assert fake_asr.count("POST", "/transcriptions") == 1


def test_finished_state_persists_across_restart(start):
    with start() as client:
        rec_id = upload(client)
        wait_for(client, rec_id, settled)
        client.post(f"/recordings/{rec_id}/stored", headers=AUTH)

    with start() as client:
        assert steps(client, rec_id)["store"] == "done"
        assert client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).status_code == 200


# ---- 删除失败的录音（#30） ----

def test_delete_failed_recording_keeps_original_on_nas(client, fake_asr, settings):
    fake_asr.ready = False
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


def test_delete_missing_recording_is_404(client):
    r = client.delete("/recordings/nope", headers=AUTH)
    assert r.status_code == 404
    assert r.json()["error_code"] == "NOT_FOUND"


def test_delete_rejected_unless_failed(client, fake_asr):
    done = upload(client)
    wait_for(client, done, settled)
    r = client.delete(f"/recordings/{done}", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error_code"] == "NOT_FAILED"

    fake_asr.hold = True
    running = upload(client)
    assert client.delete(f"/recordings/{running}", headers=AUTH).status_code == 409
    assert client.get(f"/recordings/{running}", headers=AUTH).status_code == 200


def test_deleted_recording_stays_gone_after_restart(start, fake_asr):
    fake_asr.ready = False
    with start() as client:
        rec_id = upload(client)
        wait_for(client, rec_id, settled)
        assert client.delete(f"/recordings/{rec_id}", headers=AUTH).status_code == 204
    with start() as client:
        assert client.get(f"/recordings/{rec_id}", headers=AUTH).status_code == 404
