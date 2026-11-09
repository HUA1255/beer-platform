"""按类型摘要、邮件通知、重新总结（#20）的接口测试。

假的模型接口用 httpx.MockTransport（和 tests/fake_asr.py 的做法一致），
假的 SMTP 用本文件里的最小 SMTP sink。只断言接口返回、库里留下的字段，
以及实际发给模型和邮件服务器的内容。
"""

import json
import socketserver
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import replace
from email import message_from_bytes, policy

import httpx
import pytest
from fastapi.testclient import TestClient

from home_service.app import create_app
from home_service.config import Settings

from .conftest import AUTH, settled, steps, upload, wait_for
from .fake_asr import MD, SRT

# ---- 假模型：OpenAI 兼容 chat/completions ----


class FakeModel:
    """记录每次请求；类型判断和摘要用不同的固定回复，可按测试改。"""

    def __init__(self):
        self.requests: list[dict] = []
        self.type_reply = '{"type": "会议"}'
        self.summary_reply = "## 结论\n\n录音分页开始做了。"
        self.fail = False
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        self.requests.append({
            "url": str(request.url),
            "headers": dict(request.headers),
            "json": body,
        })
        if self.fail:
            return httpx.Response(500, json={"error": {"message": "upstream exploded"}})
        prompt = body["messages"][-1]["content"]
        content = self.type_reply if "只输出 JSON" in prompt else self.summary_reply
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}}]})

    @property
    def prompts(self) -> list[str]:
        return [r["json"]["messages"][-1]["content"] for r in self.requests]

    @property
    def summary_prompts(self) -> list[str]:
        return [p for p in self.prompts if "只输出 JSON" not in p]


@pytest.fixture
def fake_model():
    return FakeModel()


@pytest.fixture
def summary_settings(tmp_path):
    originals = tmp_path / "nas" / "录音原件"
    originals.mkdir(parents=True)
    return Settings(
        access_key="home-test-key",
        originals_dir=originals,
        db_path=tmp_path / "home.sqlite3",
        asr_base_url="http://windows-asr",
        asr_token="asr-test-token",
        poll_interval=0.0,
        opencode_base="http://opencode-fake",
        opencode_api_key="go-key-1",
    )


@contextmanager
def start_home(settings, fake_asr, fake_model, summarizer=None):
    app = create_app(
        settings,
        asr_transport=httpx.ASGITransport(app=fake_asr.app),
        llm_transport=fake_model.transport,
        summarizer=summarizer,
    )
    with TestClient(app) as client:
        yield client


@pytest.fixture
def client(summary_settings, fake_asr, fake_model):
    with start_home(summary_settings, fake_asr, fake_model) as c:
        yield c


# ---- 最小 SMTP sink（明文，支持 EHLO / MAIL / RCPT / DATA / QUIT） ----


class SmtpSink:
    def __init__(self):
        self.messages: list[bytes] = []
        self._current: list[bytes] = []
        sink = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.wfile.write(b"220 test-smtp\r\n")
                data = False
                for raw in self.rfile:
                    line = raw.rstrip(b"\r\n")
                    if data:
                        if line == b".":
                            sink.messages.append(b"\r\n".join(sink._current))
                            sink._current = []
                            data = False
                            self.wfile.write(b"250 OK\r\n")
                        else:
                            sink._current.append(line)
                        continue
                    cmd = line.decode("utf-8", "replace").upper()
                    if cmd.startswith("EHLO"):
                        self.wfile.write(b"250-test-smtp\r\n250 HELP\r\n")
                    elif cmd.startswith("HELO"):
                        self.wfile.write(b"250 test-smtp\r\n")
                    elif cmd.startswith("MAIL FROM") or cmd.startswith("RCPT TO"):
                        self.wfile.write(b"250 OK\r\n")
                    elif cmd.startswith("DATA"):
                        data = True
                        self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                    elif cmd.startswith("QUIT"):
                        self.wfile.write(b"221 Bye\r\n")
                        break
                    else:
                        self.wfile.write(b"250 OK\r\n")

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def parsed(self, index: int = 0):
        return message_from_bytes(self.messages[index], policy=policy.default)


@pytest.fixture
def smtp_sink():
    sink = SmtpSink()
    yield sink
    sink.close()


def mail_settings(settings, port, security="none"):
    return replace(
        settings,
        smtp_host="127.0.0.1",
        smtp_port=port,
        smtp_security=security,
        smtp_user="",
        smtp_password="",
        mail_to="me@example.com",
    )


def closed_port() -> int:
    """占一个端口再释放，得到一个肯定连不上的 SMTP 端口。"""
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---- 类型判断与摘要 ----


def test_summary_type_detected_and_saved(client, fake_model):
    rec_id = upload(client, name="周会.m4a")

    r = wait_for(client, rec_id, settled)

    assert r["status"] == "ready"
    assert r["summary_type"] == "会议"
    assert r["summary"] == fake_model.summary_reply
    assert steps(client, rec_id)["summarize"] == "done"


def test_transcript_returns_summary_and_type(client, fake_model):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)

    body = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()

    assert body["markdown"] == MD
    assert body["srt"] == SRT
    assert body["summary"] == fake_model.summary_reply
    assert body["summary_type"] == "会议"


def test_recording_list_exposes_summary_and_type(client, fake_model):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)

    listed = client.get("/recordings", headers=AUTH).json()["recordings"]
    mine = next(r for r in listed if r["id"] == rec_id)

    assert mine["summary"] == fake_model.summary_reply
    assert mine["summary_type"] == "会议"
    assert mine["mail_error"] is None


def test_model_request_uses_opencode_endpoint_and_session_header(client, fake_model):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)

    first = fake_model.requests[0]
    assert first["url"] == "http://opencode-fake/inference/go/openai/v1/chat/completions"
    assert first["headers"]["authorization"] == "Bearer go-key-1"
    assert first["headers"]["x-opencode-session"]  # 稳定短串，文档要求带
    assert first["json"]["model"] == "deepseek-v4.1-flash"
    assert first["headers"]["x-opencode-session"] == fake_model.requests[1]["headers"]["x-opencode-session"]


@pytest.mark.parametrize("kind, marker", [
    ("会议", "谁说了什么"),
    ("口述灵感", "原话"),
    ("课程讲座", "知识点大纲"),
])
def test_each_type_uses_its_own_prompt_and_saves_that_type(summary_settings, fake_asr, fake_model, kind, marker):
    fake_model.type_reply = json.dumps({"type": kind}, ensure_ascii=False)
    fake_model.summary_reply = f"## {marker}\n\n内容。"
    with start_home(summary_settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="录音.m4a")
        r = wait_for(client, rec_id, settled)

        assert r["summary_type"] == kind
        assert fake_model.summary_prompts[-1].startswith("你在整理")
        assert marker in fake_model.summary_prompts[-1], f"{kind} 的提示词应包含「{marker}」"
        # 判断类型的提示词里列了三种类型
        assert all(t in fake_model.prompts[0] for t in ("会议", "口述灵感", "课程讲座"))


def test_unknown_type_falls_back_to_meeting_with_note(summary_settings, fake_asr, fake_model):
    fake_model.type_reply = '{"type": "访谈"}'
    with start_home(summary_settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="访谈.m4a")
        r = wait_for(client, rec_id, settled)

        assert r["summary_type"] == "会议"
        assert r["summary"].startswith("> 类型未能识别")
        assert fake_model.summary_reply in r["summary"]


def test_unparsable_type_reply_falls_back_to_meeting(summary_settings, fake_asr, fake_model):
    fake_model.type_reply = "这看起来像一场会议，但没有按 JSON 回。"
    with start_home(summary_settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="会议.m4a")
        r = wait_for(client, rec_id, settled)

        assert r["summary_type"] == "会议"
        assert r["summary"].startswith("> 类型未能识别")


# ---- 邮件 ----


def test_email_contains_type_and_summary(summary_settings, fake_asr, fake_model, smtp_sink):
    settings = mail_settings(summary_settings, smtp_sink.port)
    with start_home(settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="周会.m4a")
        r = wait_for(client, rec_id, lambda rec: settled(rec) and rec["status"] == "ready")

        assert r["mail_error"] is None
        assert len(smtp_sink.messages) == 1
        mail = smtp_sink.parsed()
        assert mail["subject"] == "录音已转写：周会.m4a"
        body = mail.get_content().replace("\r\n", "\n")
        assert "类型：会议" in body
        assert fake_model.summary_reply in body


def test_without_smtp_configuration_mail_is_skipped(client, fake_model):
    rec_id = upload(client, name="周会.m4a")
    r = wait_for(client, rec_id, settled)

    # 没有 SMTP 也不影响摘要；mail_error 保持为空
    assert r["status"] == "ready"
    assert r["summary"] == fake_model.summary_reply
    assert r["mail_error"] is None


def test_smtp_failure_keeps_summary_and_exposes_mail_error(summary_settings, fake_asr, fake_model):
    settings = mail_settings(summary_settings, closed_port())
    with start_home(settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="周会.m4a")
        r = wait_for(client, rec_id, settled)

        assert r["status"] == "ready"
        assert steps(client, rec_id)["summarize"] == "done"
        assert r["summary"] == fake_model.summary_reply
        assert r["mail_error"]
        assert client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).status_code == 200


# ---- 模型失败与重试 ----


def test_model_failure_fails_summarize_step_and_retry_redoes_it(summary_settings, fake_asr, fake_model):
    fake_model.fail = True
    with start_home(summary_settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="周会.m4a")
        r = wait_for(client, rec_id, settled)

        assert r["status"] == "failed"
        assert steps(client, rec_id)["summarize"] == "failed"
        assert r["error_code"] == "MODEL_UPSTREAM_ERROR"
        assert client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).status_code == 409

        fake_model.fail = False
        assert client.post(f"/recordings/{rec_id}/retry", headers=AUTH).status_code == 202
        r = wait_for(client, rec_id, settled)
        assert r["status"] == "ready"
        assert r["summary"] == fake_model.summary_reply
        assert r["summary_type"] == "会议"
        assert r["error_code"] is None


# ---- 重新总结 ----


def test_resummarize_overwrites_summary_but_keeps_transcript_bytes(client, fake_model):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)
    before = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()
    fake_model.summary_reply = "## 原话\n\n「这个点子得记下来。」"

    r = client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "口述灵感"})

    assert r.status_code == 200
    assert r.json()["summary_type"] == "口述灵感"
    assert r.json()["summary"] == fake_model.summary_reply
    after = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()
    assert after["markdown"] == before["markdown"] == MD
    assert after["srt"] == before["srt"] == SRT
    assert after["summary"] == fake_model.summary_reply
    assert after["summary_type"] == "口述灵感"
    # 重新总结只调一次模型（跳过类型判断），用的是指定类型的提示词
    assert len(fake_model.requests) == 3
    assert "原话" in fake_model.prompts[-1]


def test_resummarize_rejects_unknown_type(client, fake_model):
    rec_id = upload(client, name="周会.m4a")
    wait_for(client, rec_id, settled)

    r = client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "访谈"})

    assert r.status_code == 400
    assert r.json()["error_code"] == "TYPE_INVALID"
    assert client.get(f"/recordings/{rec_id}", headers=AUTH).json()["summary"] == fake_model.summary_reply


def test_resummarize_rejected_before_ready(fake_asr, summary_settings, fake_model):
    fake_asr.hold = True
    with start_home(summary_settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="周会.m4a")
        wait_for(client, rec_id, lambda r: r["steps"][1]["status"] == "running")

        r = client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "会议"})

        assert r.status_code == 409
        assert r.json()["error_code"] == "NOT_READY"


def test_resummarize_model_failure_keeps_old_summary(summary_settings, fake_asr, fake_model):
    with start_home(summary_settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="周会.m4a")
        wait_for(client, rec_id, settled)
        fake_model.fail = True

        r = client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "课程讲座"})

        assert r.status_code == 502
        assert r.json()["error_code"] == "MODEL_UPSTREAM_ERROR"
        body = client.get(f"/recordings/{rec_id}/transcript", headers=AUTH).json()
        assert body["summary"] == fake_model.summary_reply
        assert body["summary_type"] == "会议"


def test_resummarize_without_model_key_is_unavailable(summary_settings, fake_asr, fake_model):
    settings = replace(summary_settings, opencode_api_key="")
    with start_home(settings, fake_asr, fake_model) as client:
        rec_id = upload(client, name="周会.m4a")
        wait_for(client, rec_id, settled)

        r = client.post(f"/recordings/{rec_id}/resummarize", headers=AUTH, json={"type": "会议"})

        assert r.status_code == 503
        assert r.json()["error_code"] == "SUMMARY_UNAVAILABLE"
        assert len(fake_model.requests) == 0


# ---- 老库迁移 ----


OLD_COLUMNS = ["id", "filename", "original_path", "created_at", "updated_at", "steps", "asr_task_id",
               "asr_status", "progress", "error_code", "error", "transcript_md", "transcript_srt", "summary"]


def make_old_db(path):
    """按 #18/#19 的旧表结构建库并放一条已完成的录音。"""
    db = sqlite3.connect(path)
    decls = {"id": "TEXT PRIMARY KEY", "filename": "TEXT NOT NULL", "original_path": "TEXT NOT NULL",
             "created_at": "TEXT NOT NULL", "updated_at": "TEXT NOT NULL", "steps": "TEXT NOT NULL"}
    db.execute("CREATE TABLE recordings (" + ", ".join(f"{c} {decls.get(c, 'TEXT')}" for c in OLD_COLUMNS) + ")")
    steps_json = json.dumps({"upload": "done", "queue": "done", "transcribe": "done",
                             "summarize": "done", "store": "pending"})
    db.execute(
        "INSERT INTO recordings (id, filename, original_path, created_at, updated_at, steps,"
        " transcript_md, transcript_srt, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("old-1", "旧录音.m4a", "/nas/old-1/旧录音.m4a", "2026-11-01T00:00:00+00:00",
         "2026-11-01T00:01:00+00:00", steps_json, MD, SRT, "旧的摘要"),
    )
    db.commit()
    db.close()


def test_old_database_gets_new_columns_without_losing_data(summary_settings, fake_asr, fake_model, tmp_path):
    old_db = tmp_path / "old.sqlite3"
    make_old_db(old_db)
    settings = replace(summary_settings, db_path=old_db)
    with start_home(settings, fake_asr, fake_model) as client:
        listing = client.get("/recordings", headers=AUTH)
        assert listing.status_code == 200
        [rec] = listing.json()["recordings"]
        assert rec["filename"] == "旧录音.m4a"
        assert rec["summary"] == "旧的摘要"
        assert rec["summary_type"] is None
        assert rec["mail_error"] is None

        body = client.get("/recordings/old-1/transcript", headers=AUTH).json()
        assert body["markdown"] == MD
        assert body["srt"] == SRT

        r = client.post("/recordings/old-1/resummarize", headers=AUTH, json={"type": "课程讲座"})
        assert r.status_code == 200
        assert r.json()["summary_type"] == "课程讲座"
        assert r.json()["summary"] == fake_model.summary_reply

    check = sqlite3.connect(old_db)
    row = check.execute("SELECT filename, transcript_md, transcript_srt, summary_type FROM recordings"
                        " WHERE id = 'old-1'").fetchone()
    check.close()
    assert row == ("旧录音.m4a", MD, SRT, "课程讲座")
