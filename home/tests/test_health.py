import httpx

from .conftest import AUTH


def test_health_reports_all_machines_online(client):
    r = client.get("/health", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["machines"] == {"mac_mini": {"online": True}, "windows": {"online": True},
                                    "nas": {"online": True}}


def test_health_reports_windows_and_nas_offline(start, settings):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    settings.originals_dir.rmdir()
    with start(httpx.MockTransport(refuse)) as client:
        machines = client.get("/health", headers=AUTH).json()["machines"]
    assert machines["windows"] == {"online": False}
    assert machines["nas"] == {"online": False}
    assert machines["mac_mini"] == {"online": True}
