"""Windows 上 BeeBox 的 HTTP 客户端，只调用 `/v1` 接口。

契约见 HUA1255/voice-transcription 的 openapi.json 与 ADR-0009：
任务只有 queued / running / succeeded / failed / cancelled 五种状态，
细节在 stage、progress（0–1）、error_code、retryable；错误统一是 {detail, error_code, stage}。
"""

from pathlib import Path
from urllib.parse import urlsplit

import httpx

# 公开状态（ADR-0009）
QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED = "queued", "running", "succeeded", "failed", "cancelled"
TERMINAL_FAILURES = {FAILED, CANCELLED}

# BeeBox 错误码 → 中文提示（完整表见 BeeBox 的 GET /v1/errors）
ERROR_HINTS = {
    "AUTH_REQUIRED": "BeeBox 要求 token，检查 HOME_BEEBOX_TOKEN",
    "AUTH_INVALID_TOKEN": "BeeBox 拒绝了 token，检查 HOME_BEEBOX_TOKEN 是否和 BEEBOX_API_TOKEN 一致",
    "FILE_TOO_LARGE": "录音文件超过 BeeBox 允许的大小",
    "EMPTY_FILE": "录音文件是空的",
    "FILE_NOT_FOUND": "BeeBox 上已经没有这个文件",
    "JOB_NOT_FOUND": "BeeBox 上找不到这个转写任务",
    "UNSUPPORTED_FORMAT": "BeeBox 不支持这个格式",
    "UNSUPPORTED_MEDIA_FORMAT": "BeeBox 不支持这种音频格式",
    "NO_AUDIO_STREAM": "文件里没有音轨",
    "MODEL_NOT_FOUND": "BeeBox 上没有这个模型",
    "MODEL_NOT_DOWNLOADED": "BeeBox 的模型还没下载，到 BeeBox 控制台下载后再重试",
    "MODEL_COMPATIBILITY_FAILED": "模型在 Windows 上跑不起来",
    "LANGUAGE_REQUIRED": "这个模型需要指定语言",
    "SPEECH_ENGINE_FAILED": "转写引擎出错",
    "TASK_FAILED": "转写失败",
    "TASK_INTERRUPTED": "转写被 BeeBox 重启打断",
    "TASK_CANCELLED": "转写任务在 BeeBox 上被取消",
    "MEDIA_IMPORT_FAILED": "BeeBox 读不了这个文件",
    "INVALID_URL": "链接格式不对",
    "UNSUPPORTED_URL": "只支持 B 站和 YouTube 的视频链接",
    "VIDEO_LOGIN_REQUIRED": "这个视频需要登录才能看，到 BeeBox 控制台扫码登录 B 站或上传 YouTube cookie",
    "VIDEO_NOT_ACCESSIBLE": "视频打不开（可能已删除、私密或有地区限制）",
    "VIDEO_SUBTITLE_UNAVAILABLE": "这个视频没有指定语言的字幕",
    "VIDEO_AUDIO_DOWNLOAD_FAILED": "视频音轨下载失败",
    "DOWNLOAD_NETWORK_ERROR": "下载视频时网络出错（连不上视频站或代理），稍后重试",
    "LOCAL_TOOL_MISSING": "Windows 上的 BeeBox 找不到 ffmpeg / ffprobe，到 BeeBox 配好工具路径后重试",
    "VIDEO_PLATFORM_FAILED": "视频平台出错",
    "INTERNAL_ERROR": "BeeBox 内部出错",
}


def hint(code: str | None, detail: str | None = None) -> str:
    text = ERROR_HINTS.get(code or "", "BeeBox 转写出错")
    return f"{text}（{code}：{detail}）" if detail else f"{text}（{code}）"


def check_base_url(base_url: str) -> str:
    """基址只有一种写法：scheme://host[:port]，不带路径；所有请求都以 /v1 开头。"""
    parts = urlsplit(base_url.strip())
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path.strip("/") or parts.query:
        raise ValueError(f"HOME_BEEBOX_BASE_URL 只能写成 http://<主机>:<端口>，不带路径（现在是 {base_url!r}）")
    return f"{parts.scheme}://{parts.netloc}"


class BeeBoxError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = True):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


class JobGone(BeeBoxError):
    """BeeBox 上已没有这个任务（404，可能过了保留期或被删除）。"""


class BeeBoxClient:
    def __init__(self, base_url: str, token: str, transport: httpx.AsyncBaseTransport | None = None):
        self._http = httpx.AsyncClient(
            base_url=check_base_url(base_url), headers={"Authorization": f"Bearer {token}"},
            transport=transport, timeout=httpx.Timeout(10.0, read=3600.0, write=3600.0),
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            r = await self._http.request(method, path, **kwargs)
        except httpx.TransportError as e:
            raise BeeBoxError("WINDOWS_UNREACHABLE", f"连不上 Windows 上的 BeeBox：{e}") from e
        if r.status_code < 400:
            return r
        try:
            body = r.json()
        except ValueError:
            body = {}
        code = body.get("error_code") or f"BEEBOX_HTTP_{r.status_code}"
        message = hint(code, body.get("detail") or r.text[:200])
        if code == "JOB_NOT_FOUND":
            raise JobGone(code, message)
        raise BeeBoxError(code, message)

    async def health(self) -> dict | None:
        """GET /v1/health（不需要 token）；连不上或返回异常时为 None。"""
        try:
            r = await self._http.get("/v1/health", timeout=3.0)
        except httpx.TransportError:
            return None
        if r.status_code != 200:
            return None
        try:
            return r.json()
        except ValueError:
            return None

    async def check_ready(self) -> dict:
        body = await self.health()
        if body is None:
            raise BeeBoxError("WINDOWS_UNREACHABLE", "连不上 Windows 上的 BeeBox")
        if not body.get("ready"):
            raise BeeBoxError("BEEBOX_NOT_READY", "BeeBox 还没就绪（数据库或存储不可用）")
        return body

    async def upload_file(self, audio: Path, filename: str) -> str:
        with audio.open("rb") as f:
            r = await self._request("POST", "/v1/files", files={"file": (filename, f)})
        return r.json()["id"]

    async def create_job(self, source: dict, options: dict | None = None) -> dict:
        payload = {"kind": "transcription", "source": source}
        if options:
            payload["options"] = options
        return (await self._request("POST", "/v1/jobs", json=payload)).json()

    async def submit_file(self, audio: Path, filename: str) -> str:
        file_id = await self.upload_file(audio, filename)
        return (await self.create_job({"type": "file", "file_id": file_id}))["id"]

    async def submit_url(self, url: str) -> str:
        """视频链接任务（B 站、YouTube），BeeBox 优先用平台字幕。"""
        return (await self.create_job({"type": "url", "url": url}))["id"]

    async def get_job(self, job_id: str) -> dict:
        return (await self._request("GET", f"/v1/jobs/{job_id}")).json()

    async def retry(self, job_id: str) -> dict:
        """BeeBox 自己从断点接着跑；只有 failed 且 retryable 的任务能重试。"""
        return (await self._request("POST", f"/v1/jobs/{job_id}/retry")).json()

    async def result(self, job_id: str) -> dict:
        return (await self._request("GET", f"/v1/jobs/{job_id}/result")).json()

    async def export(self, job_id: str, fmt: str) -> str:
        return (await self._request("GET", f"/v1/jobs/{job_id}/exports/{fmt}")).text

    async def delete_job(self, job_id: str) -> None:
        await self._request("DELETE", f"/v1/jobs/{job_id}")
