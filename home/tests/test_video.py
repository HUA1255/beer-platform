"""按链接提交视频（#34）：POST /videos → 和录音同一条流水线 → 「视频」摘要 → 邮件。"""

import pytest

from .conftest import AUTH, settled, steps, wait_for
from .fake_beebox import MD, SRT, VIDEO
from .test_summary import (  # noqa: F401 - pytest 夹具
    client as summary_client,
    fake_model,
    mail_settings,
    smtp_sink,
    start_home,
    summary_settings,
)

BILI = "https://www.bilibili.com/video/BV1xx411c7mD"


def submit(client, url=BILI):
    r = client.post("/videos", headers=AUTH, json={"url": url})
    assert r.status_code == 201, r.text
    return r.json()


def test_video_link_goes_through_pipeline_and_waits_for_beer(client, fake_beebox):
    created = submit(client)
    assert created["kind"] == "video"
    assert created["source_url"] == BILI
    assert created["original_path"] is None
    assert [s["name"] for s in created["steps"]] == ["提交链接", "排队", "转写", "摘要", "入库"]
    # 还没转写时标题先用原链接
    assert created["title"] == BILI

    r = wait_for(client, created["id"], settled)
    assert r["status"] == "ready"
    assert r["title"] == VIDEO["title"]
    assert r["author"] == VIDEO["author"]
    assert r["duration_ms"] == VIDEO["duration_ms"]
    assert r["text_source"] == "platform_manual"
    # 视频不上传文件
    assert fake_beebox.count("POST", "/v1/files") == 0
    [job] = fake_beebox.jobs.values()
    assert job["source"] == {"type": "url", "url": BILI}


def test_video_transcript_has_markdown_srt_and_source(client):
    rec_id = submit(client)["id"]
    wait_for(client, rec_id, settled)
    t = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()
    assert t["markdown"] == MD and t["srt"] == SRT
    assert t["kind"] == "video" and t["source_url"] == BILI
    assert t["title"] == VIDEO["title"]
    assert t["source"]["text_source"] == "platform_manual"


def test_video_listed_with_recordings(client):
    rec_id = submit(client)["id"]
    wait_for(client, rec_id, settled)
    listed = client.get("/recordings?status=ready", headers=AUTH).json()["recordings"]
    assert [r["id"] for r in listed] == [rec_id]


@pytest.mark.parametrize("url", [
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.bilibili.com/video/BV1xx411c7mD",
    "https://b23.tv/abc123",
])
def test_supported_links_are_accepted(client, url):
    assert submit(client, url)["source_url"] == url


@pytest.mark.parametrize("url, code", [
    ("https://vimeo.com/123", "UNSUPPORTED_URL"),
    ("https://notbilibili.com/video/1", "UNSUPPORTED_URL"),
    ("ftp://www.bilibili.com/video/1", "UNSUPPORTED_URL"),
    ("", "INVALID_URL"),
])
def test_unsupported_links_are_rejected(client, fake_beebox, url, code):
    r = client.post("/videos", headers=AUTH, json={"url": url})
    assert r.status_code == 400
    assert r.json()["error_code"] == code
    assert client.get("/recordings", headers=AUTH).json()["recordings"] == []
    assert fake_beebox.count("POST", "/v1/jobs") == 0


def test_video_failure_shows_reason_and_retry_resubmits_link(client, fake_beebox):
    fake_beebox.script = ["queued", "failed"]
    fake_beebox.fail_code = "VIDEO_LOGIN_REQUIRED"
    fake_beebox.fail_retryable = False
    rec_id = submit(client)["id"]
    r = wait_for(client, rec_id, settled)
    assert r["status"] == "failed"
    assert r["error_code"] == "VIDEO_LOGIN_REQUIRED"
    assert "扫码登录" in r["error"]

    fake_beebox.script = ["queued", "running", "succeeded"]
    assert client.post(f"/recordings/{rec_id}/retry", headers=AUTH).status_code == 202
    r = wait_for(client, rec_id, lambda rec: settled(rec) and rec["status"] == "ready")
    assert fake_beebox.count("POST", "/v1/jobs", exact=True) == 2
    assert fake_beebox.count("POST", "/v1/files") == 0


def test_video_has_no_audio_on_nas(client):
    rec_id = submit(client)["id"]
    wait_for(client, rec_id, settled)
    r = client.get(f"/recordings/{rec_id}/audio", headers=AUTH)
    assert r.status_code == 404
    assert r.json()["error_code"] == "NO_AUDIO"


def test_video_store_confirmation_deletes_beebox_job(client, fake_beebox):
    rec_id = submit(client)["id"]
    wait_for(client, rec_id, settled)
    r = client.post(f"/recordings/{rec_id}/stored", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["status"] == "stored"
    assert fake_beebox.jobs == {}
    assert steps(client, rec_id)["store"] == "done"


# ---- 「视频」摘要 ----


def test_video_uses_video_summary_without_type_detection(summary_client, fake_model):
    rec_id = submit(summary_client)["id"]
    r = wait_for(summary_client, rec_id, lambda rec: settled(rec) and rec["status"] == "ready")
    assert r["summary_type"] == "视频"
    # 不问模型类型，只发一次摘要请求，提示词是「视频」那份，带标题和作者
    assert len(fake_model.requests) == 1
    [prompt] = fake_model.summary_prompts
    assert "## 一句话概括" in prompt and "## 可以怎么写" in prompt
    assert f"视频标题：{VIDEO['title']}" in prompt
    assert f"作者：{VIDEO['author']}" in prompt


def test_video_can_be_resummarized_as_other_type_and_back(summary_client, fake_model):
    rec_id = submit(summary_client)["id"]
    wait_for(summary_client, rec_id, lambda rec: settled(rec) and rec["status"] == "ready")
    r = summary_client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "课程讲座"})
    assert r.status_code == 200 and r.json()["summary_type"] == "课程讲座"
    r = summary_client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "视频"})
    assert r.status_code == 200 and r.json()["summary_type"] == "视频"


def test_video_email_has_title_link_and_summary(summary_settings, fake_beebox, fake_model, smtp_sink):
    settings = mail_settings(summary_settings, smtp_sink.port)
    with start_home(settings, fake_beebox, fake_model) as client:
        rec_id = submit(client)["id"]
        r = wait_for(client, rec_id, lambda rec: settled(rec) and rec["status"] == "ready")
        assert r["mail_error"] is None
        mail = smtp_sink.parsed()
        assert mail["subject"] == f"视频已转写：{VIDEO['title']}"
        body = mail.get_content().replace("\r\n", "\n")
        assert f"链接：{BILI}" in body
        assert "类型：视频" in body
        assert fake_model.summary_reply in body
