"""录音原件存储：NAS 上的 WebDAV 是主副本，本地目录只是暂存。

方案已定「录音原件放 NAS、NAS 只存文件、NAS 不接入 Tailscale，Mac mini 经局域网读写」。
2026-11-07 实测：极空间 Z2Pro 的 SMB 在 macOS 上反复挂载后会陷入僵死会话
（`net.smb.fs.kern_hard_deadtimer` 600 秒，卸载还会超时），而同一台 NAS 的 WebDAV
（5005 明文 / 5006 加密，Basic 认证）稳定、快——局域网 PUT 50 MB 约 0.75 秒，回读哈希一致。
所以原件走 WebDAV，不依赖 SMB 挂载点。

分工：
- `save()`：先写本地暂存，再 PUT 到 WebDAV。两步都成功才算上传成功。
- `fetch()`：本地没有就从 WebDAV 拉回暂存（重试、播放时用）。
- `drop()`：入库确认、删除失败录音后删掉本地暂存，原件只留在 NAS。
"""

import logging
from pathlib import Path
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

# WebDAV 的 MKCOL/DELETE 是同步语义，给足超时；PUT 大文件按 120 秒
DEFAULT_TIMEOUT = httpx.Timeout(120.0, connect=5.0)


class OriginalsError(Exception):
    """原件在 NAS 上不可用（连不上、认证失败、没有权限）。"""


async def _file_chunks(path: Path, size: int = 1 << 20):
    """按块读本地文件，供 httpx 流式上传，避免整段录音进内存。"""
    with path.open("rb") as f:
        while chunk := f.read(size):
            yield chunk


class Originals:
    def __init__(
        self,
        local_dir: Path,
        base_url: str = "",
        username: str = "",
        password: str = "",
        root: str = "录音原件",
        client: httpx.AsyncClient | None = None,
    ):
        self._local = Path(local_dir)
        self._base = base_url.rstrip("/")
        self._root = root.strip("/") or "录音原件"
        auth = (username, password) if username else None
        # trust_env=False：NAS 在局域网，不该走 HTTP_PROXY/ALL_PROXY；
        # 而且 Clash 注入的 NO_PROXY 里带 [::1]，httpx 解析会直接抛 InvalidURL。
        self._client = client or httpx.AsyncClient(
            timeout=DEFAULT_TIMEOUT, auth=auth, trust_env=False
        )
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @property
    def uses_webdav(self) -> bool:
        return bool(self._base)

    # ===== 路径 =====

    def local_path(self, rec_id: str, filename: str) -> Path:
        return self._local / rec_id / filename

    def remote_path(self, rec_id: str, filename: str) -> str:
        """原件在 NAS 上的相对路径，Beer 会写进素材条目。"""
        return f"{self._root}/{rec_id}/{filename}"

    def _url(self, path: str) -> str:
        return f"{self._base}/{quote(path.strip('/'))}"

    # ===== 健康 =====

    async def healthy(self) -> bool:
        """NAS 是否可写：PROPFIND 原件根目录，不存在就试着建。"""
        if not self.uses_webdav:
            return self._local.is_dir()
        try:
            r = await self._client.request(
                "PROPFIND", self._url(self._root) + "/", headers={"Depth": "0"}
            )
            if r.status_code == 207:
                return True
            if r.status_code == 404:
                return await self._ensure_dir(self._root)
            log.warning("NAS 原件目录不可用：HTTP %s", r.status_code)
            return False
        except httpx.HTTPError as e:
            log.warning("连不上 NAS：%s", e)
            return False

    async def _ensure_dir(self, path: str) -> bool:
        """逐级 MKCOL；目录已存在时服务器回 405，也算成功。"""
        parts = [p for p in path.split("/") if p]
        for i in range(1, len(parts) + 1):
            sub = "/".join(parts[:i])
            r = await self._client.request("MKCOL", self._url(sub) + "/")
            if r.status_code not in (201, 405):
                log.warning("建 NAS 目录失败 %s：HTTP %s", sub, r.status_code)
                return False
        return True

    # ===== 存取 =====

    async def save(self, rec_id: str, filename: str, chunks) -> Path:
        """把上传流写进本地暂存，再推到 NAS。返回本地暂存路径。"""
        local = self.local_path(rec_id, filename)
        if self.uses_webdav:
            local.parent.mkdir(parents=True, exist_ok=True)
        else:
            # 只配了本地目录时，目录不在就是「NAS 没挂载」，按原有语义报不可用
            if not self._local.is_dir():
                raise OriginalsError(f"录音原件路径不可用：{self._local}")
            local.parent.mkdir()
        try:
            with local.open("wb") as out:
                async for chunk in chunks:
                    out.write(chunk)
            if self.uses_webdav:
                await self._put(local, rec_id, filename)
        except OriginalsError:
            self._discard(local.parent)
            raise
        except Exception:
            self._discard(local.parent)
            raise
        return local

    async def _put(self, local: Path, rec_id: str, filename: str) -> None:
        if not await self._ensure_dir(f"{self._root}/{rec_id}"):
            raise OriginalsError("NAS 上的原件目录建不出来")
        size = local.stat().st_size
        try:
            # 流式上传，但显式给 Content-Length：部分 WebDAV 服务器不认 chunked
            r = await self._client.put(
                self._url(self.remote_path(rec_id, filename)),
                content=_file_chunks(local),
                headers={"Content-Type": "application/octet-stream", "Content-Length": str(size)},
            )
        except httpx.HTTPError as e:
            raise OriginalsError(f"上传到 NAS 失败：{e}") from e
        if r.status_code not in (200, 201, 204):
            raise OriginalsError(f"上传到 NAS 失败：HTTP {r.status_code}")

    async def fetch(self, rec_id: str, filename: str) -> Path:
        """确保本地有原件：没有就从 NAS 拉回暂存目录。"""
        local = self.local_path(rec_id, filename)
        if local.is_file():
            return local
        if not self.uses_webdav:
            raise OriginalsError(f"录音原件不在本地：{local}")
        local.parent.mkdir(parents=True, exist_ok=True)
        try:
            async with self._client.stream("GET", self._url(self.remote_path(rec_id, filename))) as r:
                if r.status_code != 200:
                    raise OriginalsError(f"从 NAS 取原件失败：HTTP {r.status_code}")
                with local.open("wb") as out:
                    async for chunk in r.aiter_bytes(1 << 20):
                        out.write(chunk)
        except httpx.HTTPError as e:
            raise OriginalsError(f"从 NAS 取原件失败：{e}") from e
        return local

    async def drop(self, rec_id: str) -> None:
        """删掉本地暂存（NAS 上的主副本不动）。

        没配 WebDAV 时本地目录就是 NAS 挂载点，里面就是原件本身，不能删。
        """
        if not self.uses_webdav:
            return
        self._discard(self._local / rec_id)

    def _discard(self, directory: Path) -> None:
        import shutil

        shutil.rmtree(directory, ignore_errors=True)
