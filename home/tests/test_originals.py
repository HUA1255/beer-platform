"""录音原件走 NAS WebDAV 的测试（#18 补充，2026-11-07）。

用 httpx MockTransport 扮演极空间：只实现 PROPFIND / MKCOL / PUT / GET / DELETE。
"""

import asyncio

import httpx
import pytest

from home_service.originals import Originals, OriginalsError

BASE = "http://192.168.1.10:5005/your-space"


class FakeDAV:
    """最小的 WebDAV 服务器：dict 当文件系统。"""

    def __init__(self, auth_ok=True):
        self.files: dict[str, bytes] = {}
        self.dirs: set[str] = {""}
        self.auth_ok = auth_ok
        self.puts: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if not self.auth_ok:
            return httpx.Response(401, text="please auth")
        path = request.url.path.removeprefix("/your-space").strip("/")
        method = request.method
        if method == "PROPFIND":
            if path not in self.dirs and path not in self.files:
                return httpx.Response(404)
            return httpx.Response(207, text="<D:multistatus/>")
        if method == "MKCOL":
            if path in self.dirs:
                return httpx.Response(405)  # 已存在
            self.dirs.add(path)
            return httpx.Response(201)
        if method == "PUT":
            self.files[path] = request.read()
            self.puts.append(path)
            return httpx.Response(201)
        if method == "GET":
            if path not in self.files:
                return httpx.Response(404)
            return httpx.Response(200, content=self.files[path])
        if method == "DELETE":
            prefix = path + "/"
            for key in [k for k in self.files if k == path or k.startswith(prefix)]:
                del self.files[key]
            for d in [d for d in self.dirs if d == path or d.startswith(prefix)]:
                self.dirs.discard(d)
            return httpx.Response(204)
        return httpx.Response(405)


def make(tmp_path, dav, **kwargs):
    client = httpx.AsyncClient(transport=httpx.MockTransport(dav.handler), trust_env=False)
    return Originals(tmp_path, BASE, "u", "p", client=client, **kwargs)


def test_save_writes_local_staging_and_pushes_to_nas(tmp_path):
    asyncio.run(_test_save_writes_local_staging_and_pushes_to_nas(tmp_path))


async def _test_save_writes_local_staging_and_pushes_to_nas(tmp_path):
    dav = FakeDAV()
    o = make(tmp_path, dav)

    async def chunks():
        yield b"audio-"
        yield b"123"

    local = await o.save("rec1", "周会.m4a", chunks())

    assert local.read_bytes() == b"audio-123"
    assert dav.files["录音原件/rec1/周会.m4a"] == b"audio-123"
    assert o.remote_path("rec1", "周会.m4a") == "录音原件/rec1/周会.m4a"


def test_fetch_pulls_back_from_nas_after_local_dropped(tmp_path):
    asyncio.run(_test_fetch_pulls_back_from_nas_after_local_dropped(tmp_path))


async def _test_fetch_pulls_back_from_nas_after_local_dropped(tmp_path):
    dav = FakeDAV()
    o = make(tmp_path, dav)

    async def chunks():
        yield b"audio-123"

    await o.save("rec1", "a.m4a", chunks())
    await o.drop("rec1")
    assert not (tmp_path / "rec1").exists()  # 入库后本地不再留

    path = await o.fetch("rec1", "a.m4a")
    assert path.read_bytes() == b"audio-123"
    assert dav.files["录音原件/rec1/a.m4a"] == b"audio-123"  # NAS 那份没被动


def test_upload_fails_when_nas_rejects(tmp_path):
    asyncio.run(_test_upload_fails_when_nas_rejects(tmp_path))


async def _test_upload_fails_when_nas_rejects(tmp_path):
    dav = FakeDAV(auth_ok=False)
    o = make(tmp_path, dav)

    async def chunks():
        yield b"x"

    with pytest.raises(OriginalsError):
        await o.save("rec1", "a.m4a", chunks())
    # 失败要清掉本地半成品，不能留孤儿
    assert not (tmp_path / "rec1").exists()


def test_health_creates_missing_root_and_reports_offline_when_unreachable(tmp_path):
    asyncio.run(_test_health_creates_missing_root_and_reports_offline_when_unreachable(tmp_path))


async def _test_health_creates_missing_root_and_reports_offline_when_unreachable(tmp_path):
    dav = FakeDAV()
    o = make(tmp_path, dav, root="录音原件")
    assert await o.healthy() is True
    assert "录音原件" in dav.dirs  # 根目录不存在时自动建

    def boom(request):
        raise httpx.ConnectError("no route", request=request)

    dead = Originals(tmp_path, BASE, "u", "p",
                     client=httpx.AsyncClient(transport=httpx.MockTransport(boom), trust_env=False))
    assert await dead.healthy() is False


def test_without_webdav_falls_back_to_local_dir(tmp_path):
    asyncio.run(_test_without_webdav_falls_back_to_local_dir(tmp_path))


async def _test_without_webdav_falls_back_to_local_dir(tmp_path):
    o = Originals(tmp_path)
    assert o.uses_webdav is False

    async def chunks():
        yield b"x"

    local = await o.save("rec1", "a.m4a", chunks())
    assert local.read_bytes() == b"x"
    assert await o.healthy() is True


def test_drop_without_webdav_keeps_original(tmp_path):
    asyncio.run(_test_drop_without_webdav_keeps_original(tmp_path))


async def _test_drop_without_webdav_keeps_original(tmp_path):
    o = Originals(tmp_path)

    async def chunks():
        yield b"x"

    local = await o.save("rec1", "a.m4a", chunks())
    await o.drop("rec1")
    assert local.read_bytes() == b"x"
