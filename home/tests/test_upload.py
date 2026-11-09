from .conftest import AUTH, upload


def test_upload_returns_id_and_stores_original_under_configured_path(client, settings):
    rec_id = upload(client, name="周会.m4a", data=b"audio-123")

    stored = list(settings.originals_dir.rglob("*.m4a"))
    assert len(stored) == 1
    assert stored[0].read_bytes() == b"audio-123"
    assert rec_id in str(stored[0])


def test_view_reports_original_path_on_nas(client, settings):
    """Beer 取回结果时要把原件在 NAS 上的路径写进素材条目，视图里要带上这个字段。"""
    rec_id = upload(client, name="周会.m4a", data=b"audio-123")

    view = client.get(f"/recordings/{rec_id}", headers=AUTH).json()
    listed = client.get("/recordings", headers=AUTH).json()["recordings"][0]

    expected = str(settings.originals_dir / rec_id / "周会.m4a")
    assert view["original_path"] == expected
    assert listed["original_path"] == expected


def test_original_can_be_downloaded(client):
    rec_id = upload(client, name="周会.m4a", data=b"audio-123")

    r = client.get(f"/recordings/{rec_id}/audio", headers=AUTH)
    assert r.status_code == 200
    assert r.content == b"audio-123"


def test_upload_fails_clearly_when_originals_path_unavailable(client, settings):
    settings.originals_dir.rmdir()  # 比如 NAS 没挂载

    r = client.post("/recordings", headers=AUTH, files={"file": ("a.m4a", b"x", "audio/mp4")})
    assert r.status_code == 503
    assert r.json()["error_code"] == "ORIGINALS_UNAVAILABLE"
    assert client.get("/recordings", headers=AUTH).json()["recordings"] == []


def test_unknown_recording_is_404(client):
    assert client.get("/recordings/nope", headers=AUTH).status_code == 404
    assert client.get("/recordings/nope/audio", headers=AUTH).status_code == 404
