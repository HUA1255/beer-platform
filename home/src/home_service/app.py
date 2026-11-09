import logging
import secrets

import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from .asr import ASRClient
from .config import Settings
from .llm import LLMClient
from .mailer import Mailer
from .originals import Originals, OriginalsError
from .pipeline import Pipeline, StepFailed, Summarizer, no_summary
from .store import STEPS, Store
from .summarizer import TYPES as SUMMARY_TYPES
from .summarizer import RecordingSummarizer

log = logging.getLogger(__name__)


def _error(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail, "error_code": code}, status_code=status)


def view(rec: dict, originals: Originals | None = None) -> dict:
    """对外的录音视图：五步进度 + 汇总状态。"""
    steps = rec["steps"]
    if "failed" in steps.values():
        status = "failed"
    elif steps["store"] == "done":
        status = "stored"
    elif steps["summarize"] == "done":
        status = "ready"  # 结果已就绪，等 Beer 取回
    else:
        status = "processing"
    # 原件在 NAS 上的路径（Beer 写进素材条目）；没配 WebDAV 时退回本地路径
    if originals is not None and originals.uses_webdav:
        original_path = originals.remote_path(rec["id"], rec["filename"])
    else:
        original_path = rec["original_path"]
    return {
        "id": rec["id"],
        "filename": rec["filename"],
        "original_path": original_path,
        "status": status,
        "steps": [{"key": k, "name": name, "status": steps[k]} for k, name in STEPS],
        "progress": rec["progress"],
        "error_code": rec["error_code"],
        "error": rec["error"],
        "summary": rec["summary"],
        "summary_type": rec["summary_type"],
        "mail_error": rec["mail_error"],
        "created_at": rec["created_at"],
        "updated_at": rec["updated_at"],
    }


def create_app(
    settings: Settings | None = None,
    asr_transport: httpx.AsyncBaseTransport | None = None,
    llm_transport: httpx.AsyncBaseTransport | None = None,
    summarizer: Summarizer | None = None,
    originals: Originals | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.db_path)
    asr = ASRClient(settings.asr_base_url, settings.asr_token, transport=asr_transport)
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
            summarizer = RecordingSummarizer(
                llm,
                Mailer(settings.smtp_host, settings.smtp_port, settings.smtp_security,
                       settings.smtp_user, settings.smtp_password, settings.mail_to),
            )
        else:
            log.warning("没有配置 HOME_OPENCODE_API_KEY，摘要一步直接通过")
            summarizer = no_summary
    async def fetch_audio(rec: dict) -> Path:
        """本地暂存没了就从 NAS 取回原件（重试、重新提交时用）。"""
        return await originals.fetch(rec["id"], rec["filename"])

    pipeline = Pipeline(store, asr, settings.poll_interval, summarizer, fetch_audio=fetch_audio)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pipeline.resume_unfinished()
        yield
        await pipeline.shutdown()
        await asr.aclose()
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
        return {
            "status": "ok",
            "machines": {
                "mac_mini": {"online": True},
                "windows": {"online": await asr.is_online()},
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
        store.update(rec_id, steps=steps, error_code=None, error=None)
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
                "summary_type": rec["summary_type"]}

    @app.post("/recordings/{rec_id}/resummarize")
    async def resummarize(rec_id: str, payload: dict):
        """按指定类型重做摘要，覆盖原摘要；文字稿和 srt 一个字节都不动。"""
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        summary_type = payload.get("type")
        if summary_type not in SUMMARY_TYPES:
            return _error(400, "TYPE_INVALID", "type 只能是 会议 / 口述灵感 / 课程讲座")
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
        return view(store.get(rec_id), originals)

    @app.get("/recordings/{rec_id}/audio")
    async def download_original(rec_id: str):
        rec = store.get(rec_id)
        if not rec:
            return _error(404, "NOT_FOUND", "没有这条录音")
        try:
            path = await originals.fetch(rec_id, rec["filename"])
        except OriginalsError as e:
            return _error(503, "ORIGINALS_UNAVAILABLE", str(e))
        return FileResponse(path, filename=rec["filename"])

    return app
