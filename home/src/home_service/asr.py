"""Windows 上 voice-transcription（ASRbox）的 HTTP 客户端。"""

from pathlib import Path

import httpx


class ASRError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class TaskGone(ASRError):
    """Windows 上已没有这个任务（404）。"""


class ASRClient:
    def __init__(self, base_url: str, token: str, transport: httpx.AsyncBaseTransport | None = None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=headers, transport=transport,
            timeout=httpx.Timeout(10.0, read=3600.0, write=3600.0),
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            r = await self._http.request(method, path, **kwargs)
        except httpx.TransportError as e:
            raise ASRError("WINDOWS_UNREACHABLE", f"连不上 Windows 转录服务：{e}") from e
        if r.status_code == 404 and path.startswith("/tasks/"):
            raise TaskGone("ASR_TASK_GONE", "Windows 上找不到这个转写任务")
        if r.status_code == 401:
            raise ASRError("ASR_UNAUTHORIZED", "Windows 转录服务拒绝了 ASRBOX_API_TOKEN")
        if r.status_code >= 400:
            try:
                body = r.json()
            except ValueError:
                body = {}
            raise ASRError(body.get("error_code") or "ASR_ERROR",
                           f"Windows 转录服务返回 {r.status_code}：{body.get('detail') or r.text[:200]}")
        return r

    async def is_online(self) -> bool:
        try:
            r = await self._http.get("/health", timeout=3.0)
            return r.status_code == 200
        except httpx.TransportError:
            return False

    async def check_ready(self) -> None:
        body = (await self._request("GET", "/transcriptions/readiness")).json()
        if not body.get("ready"):
            raise ASRError("ASR_NOT_READY", f"Windows 转录服务未就绪：{body.get('message', '')}")

    async def submit(self, audio: Path, filename: str) -> str:
        with audio.open("rb") as f:
            r = await self._request("POST", "/transcriptions", files={"file": (filename, f)},
                                    data={"output_formats": "md,srt"})
        return r.json()["id"]

    async def get_task(self, task_id: str) -> dict:
        return (await self._request("GET", f"/tasks/{task_id}")).json()

    async def retry(self, task_id: str, resumable: bool) -> None:
        path = f"/tasks/{task_id}/chunks/retry-failed" if resumable else f"/tasks/{task_id}/retry"
        await self._request("POST", path)

    async def export(self, task_id: str, fmt: str) -> str:
        return (await self._request("GET", f"/tasks/{task_id}/export/{fmt}")).text
