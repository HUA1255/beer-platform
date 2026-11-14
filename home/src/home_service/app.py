import asyncio
import json
import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from .beebox import BeeBoxClient, BeeBoxError
from .config import Settings
from .llm import LLMClient
from .login_watch import LoginWatch
from .mailer import Mailer
from .originals import Originals, OriginalsError
from .pipeline import Pipeline, StepFailed, Summarizer, no_summary
from .store import STEPS, Store
from .summarizer import TYPES as SUMMARY_TYPES
from .summarizer import RecordingSummarizer

log = logging.getLogger(__name__)


def _error(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail, "error_code": code}, status_code=status)


# 按链接提交只收 B 站和 YouTube（#34）；其他视频站在 Beer 那边照旧只存标题和简介
VIDEO_HOSTS = ("bilibili.com", "b23.tv", "youtube.com", "youtu.be")


def is_video_url(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme in ("http", "https") and any(host == h or host.endswith("." + h) for h in VIDEO_HOSTS)


def source_of(rec: dict) -> dict:
    return json.loads(rec["source_info"]) if rec["source_info"] else {}


def title_of(rec: dict) -> str:
    """列表和邮件里显示的名字：视频用 BeeBox 给的标题（转写完之前用原链接），录音用文件名。"""
    if rec["source_url"]:
        return (source_of(rec).get("title") or "").strip() or rec["source_url"]
    return rec["filename"]


def view(rec: dict, originals: Originals | None = None) -> dict:
    """对外的录音视图：五步进度 + 汇总状态。视频链接任务也用这个视图，kind 为 video。"""
    steps = rec["steps"]
    video = bool(rec["source_url"])
    if "failed" in steps.values():
        status = "failed"
    elif steps["store"] == "done":
        status = "stored"
    elif steps["summarize"] == "done":
        status = "ready"  # 结果已就绪，等 Beer 取回
    else:
        status = "processing"
    # 原件在 NAS 上的路径（Beer 写进素材条目）；没配 WebDAV 时退回本地路径
    if video:
        original_path = None  # 视频的音频不存 NAS
    elif originals is not None and originals.uses_webdav:
        original_path = originals.remote_path(rec["id"], rec["filename"])
    else:
        original_path = rec["original_path"]
    names = dict(STEPS) | ({"upload": "提交链接"} if video else {})
    source = source_of(rec)
    return {
        "id": rec["id"],
        "kind": "video" if video else "recording",
        "filename": rec["filename"],
        "title": title_of(rec),
        "source_url": rec["source_url"],
        # 视频的作者、时长、文字来源（platform_manual / platform_auto / asr）；转写完之前为 None
        "author": source.get("author") if video else None,
        "duration_ms": source.get("duration_ms"),
        "text_source": source.get("text_source"),
        "original_path": original_path,
        "status": status,
        "steps": [{"key": k, "name": names[k], "status": steps[k]} for k in names],
        "progress": rec["progress"],
        "error_code": rec["error_code"],
        "error": rec["error"],
        # BeeBox 任务的公开状态与阶段（queued / running / succeeded / failed / cancelled；stage 如 transcribe）
        "job_status": rec["asr_status"],
        "stage": rec["asr_stage"],
        # 最近一次失败能否在 BeeBox 上从断点重试；不能时 /retry 会重新提交一个新任务
        "retryable": None if rec["retryable"] is None else bool(rec["retryable"]),
        "summary": rec["summary"],
        "summary_type": rec["summary_type"],
        "mail_error": rec["mail_error"],
        "created_at": rec["created_at"],
        "updated_at": rec["updated_at"],
    }


def create_app(
    settings: Settings | None = None,
    beebox_transport: httpx.AsyncBaseTransport | None = None,
    llm_transport: httpx.AsyncBaseTransport | None = None,
    summarizer: Summarizer | None = None,
    originals: Originals | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.db_path)
    beebox = BeeBoxClient(settings.beebox_base_url, settings.beebox_token, transport=beebox_transport)
    mailer = Mailer(settings.smtp_host, settings.smtp_port, settings.smtp_security,
                    settings.smtp_user, settings.smtp_password, settings.mail_to)
    login_watch = LoginWatch(store, mailer, f"{settings.beebox_base_url}/console")
    originals = originals or Originals(
        settings.originals_dir, settings.webdav_url, settings.webdav_user,
        settings.webdav_password, settings.webdav_root,
    )
    # 没配 opencode go 的 key 时退回 no_summary（摘要一步直接通过，兼容旧部署和旧测试）
    llm = None
    if summarizer is None:
        if settings.opencode_api_key:
            llm = LLMClient(settings.opencode_base, settings.opencode_api_key, settings.summary_model,
                            transport=llm_transport)
            summarizer = RecordingSummarizer(llm, mailer)
        else:
            log.warning("没有配置 HOME_OPENCODE_API_KEY，摘要一步直接通过")
            summarizer = no_summary
    async def fetch_audio(rec: dict) -> Path:
        """本地暂存没了就从 NAS 取回原件（重试、重新提交时用）。"""
        return await originals.fetch(rec["id"], rec["filename"])

    pipeline = Pipeline(store, beebox, settings.poll_interval, summarizer, fetch_audio=fetch_audio,
                        on_health=login_watch.observe)

    async def beebox_health() -> dict | None:
        body = await beebox.health()
        if body is not None:
            try:
                await login_watch.observe(body)
            except Exception:  # noqa: BLE001 - 提醒出错不影响健康检查
                log.exception("处理 B 站登录状态时出错")
        return body

    async def watch_health() -> None:
        while True:
            await beebox_health()
            await asyncio.sleep(settings.health_interval)

    async def drop_job(rec: dict) -> None:
        """结果已入库（或失败记录被删）后删掉 BeeBox 上的任务；删不掉就留给 BeeBox 的 30 天保留期。"""
        if not rec["asr_task_id"]:
            return
        try:
            await beebox.delete_job(rec["asr_task_id"])
        except BeeBoxError as e:
            log.warning("删除 BeeBox 任务 %s 失败：%s", rec["asr_task_id"], e.message)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pipeline.resume_unfinished()
        watcher = asyncio.create_task(watch_health()) if settings.health_interval > 0 else None
        yield
        if watcher is not None:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        await pipeline.shutdown()
        await beebox.aclose()
        await originals.aclose()
        if llm is not None:
            await llm.aclose()
        store.close()

    app = FastAPI(title="家里服务", lifespan=lifespan)

    @app.middleware("http")
    async def require_key(request: Request, call_next):
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(token.encode(), settings.access_key.encode()):
            return _error(401, "UNAUTHORIZED", "缺少或错误的访问密钥")
        return await call_next(request)

    @app.get("/health")
    async def health():
        body = await beebox_health()
        windows = {"online": False} if body is None else {
            "online": bool(body.get("online")), "ready": bool(body.get("ready")),
            "version": body.get("version"), "bilibili_login": body.get("bilibili_login"),
        }
        return {
            "status": "ok",
            "machines": {
                "mac_mini": {"online": True},
                "windows": windows,
                "nas": {"online": await originals.healthy()},
            },
        }

    @app.post("/recordings", status_code=201)
    async def upload(file: UploadFile = File(...)):
        rec_id = uuid.uuid4().hex
        filename = Path(file.filename or "recording").name

        async def chunks():
            while chunk := await file.read(1 << 20):
                yield chunk

        try:
            # 先落本地暂存，再推到 NAS；NAS 不可用就整条失败，和「断网不排队」一致
            target = await originals.save(rec_id, filename, chunks())
        except OriginalsError as e:
            return _error(503, "ORIGINALS_UNAVAILABLE", str(e))
        rec = store.create(rec_id, filename, target)
        pipeline.start(rec_id)
        return view(rec, originals)

    @app.post("/videos", status_code=201)
    async def submit_video(payload: dict):
        """按链接提交 B 站 / YouTube 视频（#34）。后面和录音走同一条流水线，进度在 /recordings 里看。"""
        url = payload.get("url")
        if not isinstance(url, str) or not url.strip():
            return _error(400, "INVALID_URL", "缺少视频链接 url")
        url = url.strip()
        if not is_video_url(url):
            return _error(400, "UNSUPPORTED_URL", "只支持 B 站和 YouTube 的视频链接")
        rec_id = uuid.uuid4().hex
        rec = store.create(rec_id, url, "", source_url=url)
        pipeline.start(rec_id)
        return view(rec, originals)

    @app.get("/recordings")
    def list_recordings(status: str | None = None):
        views = [view(r, originals) for r in store.all()]
        return {"recordings": [v for v in views if status is None or v["status"] == status]}

    @app.get("/recordings/{rec_id}")
    def get_recording(rec_id: str):
        rec = store.get(rec_id)
        return view(rec, originals) if rec else _error(404, "NOT_FOUND", "没有这条录音")

    @app.post("/recordings/{rec_id}/retry", status_code=202)
    async def retry(rec_id: str):
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        steps = rec["steps"]
        if "failed" not in steps.values() or pipeline.is_running(rec_id):
            return _error(409, "NOT_FAILED", "这条录音没有失败的步骤")
        steps = {k: "pending" if v == "failed" else v for k, v in steps.items()}
        store.update(rec_id, steps=steps, error_code=None, error=None, retryable=None)
        pipeline.start(rec_id)
        return view(store.get(rec_id), originals)

    @app.delete("/recordings/{rec_id}", status_code=204)
    async def delete_recording(rec_id: str):
        """只删失败的录音记录；NAS 上的原件不动，只清 Mac mini 上的本地暂存。"""
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        if "failed" not in rec["steps"].values() or pipeline.is_running(rec_id):
            return _error(409, "NOT_FAILED", "只能删除失败的录音")
        store.delete(rec_id)
        await originals.drop(rec_id)
        await drop_job(rec)
        return Response(status_code=204)

    @app.get("/recordings/{rec_id}/transcript")
    def transcript(rec_id: str):
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        if rec["steps"]["summarize"] != "done":
            return _error(409, "NOT_READY", "转写结果还没好")
        return {"id": rec_id, "filename": rec["filename"], "markdown": rec["transcript_md"],
                "srt": rec["transcript_srt"], "summary": rec["summary"],
                "summary_type": rec["summary_type"],
                # BeeBox 结果里的 source：text_source（asr / platform_manual / platform_auto）、标题、作者、时长、原链接
                "kind": "video" if rec["source_url"] else "recording", "title": title_of(rec),
                "source_url": rec["source_url"],
                "source": json.loads(rec["source_info"]) if rec["source_info"] else None}

    @app.post("/recordings/{rec_id}/resummarize")
    async def resummarize(rec_id: str, payload: dict):
        """按指定类型重做摘要，覆盖原摘要；文字稿和 srt 一个字节都不动。"""
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        summary_type = payload.get("type")
        if summary_type not in SUMMARY_TYPES:
            return _error(400, "TYPE_INVALID", "type 只能是 " + " / ".join(SUMMARY_TYPES))
        if rec["steps"]["summarize"] != "done":
            return _error(409, "NOT_READY", "转写结果还没好")
        if not settings.opencode_api_key and summarizer is no_summary:
            return _error(503, "SUMMARY_UNAVAILABLE", "没有配置 HOME_OPENCODE_API_KEY，不能重新总结")
        try:
            fields = await summarizer(rec, type_=summary_type)
        except StepFailed as e:
            return _error(502, e.code, e.message)
        store.update(rec_id, **fields)
        return view(store.get(rec_id), originals)

    @app.post("/recordings/{rec_id}/stored")
    async def confirm_stored(rec_id: str):
        """Beer 把结果写进内容库后确认，五步进度的「入库」完成。"""
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        if rec["steps"]["summarize"] != "done":
            return _error(409, "NOT_READY", "转写结果还没好")
        store.set_step(rec_id, "store", "done")
        # 入库后原件只留在 NAS，本地暂存可以清掉（播放时再取回）
        await originals.drop(rec_id)
        await drop_job(rec)
        return view(store.get(rec_id), originals)

    @app.get("/recordings/{rec_id}/audio")
    async def download_original(rec_id: str):
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        if rec["source_url"]:
            return _error(404, "NO_AUDIO", "视频的音频不存 NAS，到原链接观看")
        try:
            path = await originals.fetch(rec_id, rec["filename"])
        except OriginalsError as e:
            return _error(503, "ORIGINALS_UNAVAILABLE", str(e))
        return FileResponse(path, filename=rec["filename"])

    return app
