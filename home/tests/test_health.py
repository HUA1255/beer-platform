from dataclasses import replace

import httpx
from fastapi.testclient import TestClient

from home_service.app import create_app

from .conftest import AUTH, settled, upload, wait_for
from .test_summary import mail_settings, smtp_sink  # noqa: F401 - smtp_sink 是夹具


def test_health_reports_all_machines_online(client):
    r = client.get("/health", headers=AUTH)
    assert r.status_code == 200
    machines = r.json()["machines"]
    assert machines["mac_mini"] == {"online": True}
    assert machines["nas"] == {"online": True}
    assert machines["windows"] == {"online": True, "ready": True, "version": "1.0.0", "bilibili_login": "valid"}


def test_health_uses_v1_health(client, fake_beebox):
    client.get("/health", headers=AUTH)
    assert fake_beebox.count("GET", "/v1/health") == 1


def test_health_reports_windows_and_nas_offline(start, settings):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    settings.originals_dir.rmdir()
    with start(httpx.MockTransport(refuse)) as client:
        machines = client.get("/health", headers=AUTH).json()["machines"]
    assert machines["windows"] == {"online": False}
    assert machines["nas"] == {"online": False}
    assert machines["mac_mini"] == {"online": True}


# ---- B 站登录失效提醒 ----

def start_with_mail(settings, fake_beebox, port, **changes):
    app = create_app(replace(mail_settings(settings, port), **changes),
                     beebox_transport=httpx.ASGITransport(app=fake_beebox.app))
    return TestClient(app)


def test_expired_bilibili_login_sends_one_reminder(settings, fake_beebox, smtp_sink):
    fake_beebox.bilibili_login = "expired"
    with start_with_mail(settings, fake_beebox, smtp_sink.port) as client:
        assert client.get("/health", headers=AUTH).json()["machines"]["windows"]["bilibili_login"] == "expired"
        client.get("/health", headers=AUTH)
    assert len(smtp_sink.messages) == 1
    mail = smtp_sink.parsed()
    assert "B 站登录已失效" in mail["subject"]
    assert "http://windows-beebox/console" in mail.get_content()

    # 重启后同一次失效不再重发
    with start_with_mail(settings, fake_beebox, smtp_sink.port) as client:
        client.get("/health", headers=AUTH)
    assert len(smtp_sink.messages) == 1


def test_reminder_sent_again_after_login_recovers_and_expires(settings, fake_beebox, smtp_sink):
    with start_with_mail(settings, fake_beebox, smtp_sink.port) as client:
        fake_beebox.bilibili_login = "expired"
        client.get("/health", headers=AUTH)
        fake_beebox.bilibili_login = "valid"
        client.get("/health", headers=AUTH)
        fake_beebox.bilibili_login = "expired"
        client.get("/health", headers=AUTH)
    assert len(smtp_sink.messages) == 2


def test_valid_login_sends_no_reminder(settings, fake_beebox, smtp_sink):
    with start_with_mail(settings, fake_beebox, smtp_sink.port) as client:
        client.get("/health", headers=AUTH)
    assert smtp_sink.messages == []


def test_reminder_checked_when_submitting_recording(settings, fake_beebox, smtp_sink):
    fake_beebox.bilibili_login = "expired"
    with start_with_mail(settings, fake_beebox, smtp_sink.port) as client:
        rec_id = upload(client)
        assert wait_for(client, rec_id, settled)["status"] == "ready"  # 失效不影响录音转写
    assert len(smtp_sink.messages) == 1


def test_background_health_check_sends_reminder_without_beer(settings, fake_beebox, smtp_sink):
    import time

    fake_beebox.bilibili_login = "expired"
    with start_with_mail(settings, fake_beebox, smtp_sink.port, health_interval=0.05):
        deadline = time.monotonic() + 5
        while not smtp_sink.messages and time.monotonic() < deadline:
            time.sleep(0.02)
    assert len(smtp_sink.messages) == 1
