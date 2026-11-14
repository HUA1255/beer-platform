"""假的 BeeBox（`/v1` 接口的子集），供接口测试使用。契约以 BeeBox 仓库的 openapi.json 为准。

测试通过属性控制场景：
- ready：/v1/health 的 ready
- bilibili_login：/v1/health 的 B 站登录状态（valid / expired / absent）
- script：每个新任务在 GET /v1/jobs/{id} 时依次返回的公开状态（最后一个保持不变），
  只有 queued / running / succeeded / failed / cancelled 五种
- retry_script：任务被重试后使用的状态序列
- fail_code / fail_retryable：任务失败时的 error_code 与 retryable
- hold：为 True 时任务停在当前状态不前进
"""

import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response

TOKEN = "beebox-test-token"
MD = "**说话人 1** [00:00]\n大家好，今天讨论第一版的范围。\n"
SRT = "1\n00:00:00,000 --> 00:00:02,000\n大家好，今天讨论第一版的范围。\n"
VIDEO = {"title": "测试视频", "author": "测试 UP 主", "duration_ms": 61000, "text_source": "platform_manual"}

STAGES = {"queued": "queued", "running": "transcribe", "succeeded": "done", "failed": "failed",
          "cancelled": "cancelled"}
PROGRESS = {"queued": 0.0, "running": 0.7, "succeeded": 1.0, "failed": 0.4, "cancelled": 0.0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _error(status: int, detail: str, code: str, stage: str) -> JSONResponse:
    return JSONResponse({"detail": detail, "error_code": code, "stage": stage}, status_code=status)


class FakeBeeBox:
    def __init__(self):
        self.ready = True
        self.bilibili_login = "valid"
        self.script = ["queued", "running", "succeeded"]
        self.retry_script = ["queued", "running", "succeeded"]
        self.fail_code = "SPEECH_ENGINE_FAILED"
        self.fail_retryable = True
        self.hold = False
        self.files: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.app = self._build()

    def count(self, method: str, path: str, exact: bool = False) -> int:
        """按方法和路径统计请求；默认按前缀匹配，exact=True 时要求路径完全相同。"""
        return sum(1 for m, p in self.requests if m == method and (p == path if exact else p.startswith(path)))

    def forget(self, job_id: str) -> None:
        """模拟 BeeBox 已清理这个任务（保留期到了或被删除）。"""
        self.jobs.pop(job_id, None)

    @staticmethod
    def _status(job: dict) -> str:
        return job["seq"][job["step"]]

    def _advance(self, job: dict) -> None:
        if not self.hold and job["step"] < len(job["seq"]) - 1:
            job["step"] += 1

    def _source(self, job: dict) -> dict:
        src = job["source"]
        if src["type"] == "url":
            return {"type": "url", "url": src["url"], "part": None, **VIDEO}
        file = self.files.get(src["file_id"], {})
        return {"type": "file", "file_id": src["file_id"], "filename": file.get("filename"),
                "duration_ms": 2000, "text_source": "asr"}

    def _view(self, job: dict) -> dict:
        status = self._status(job)
        failed = status == "failed"
        return {
            "id": job["id"], "kind": "transcription", "status": status, "stage": STAGES[status],
            "progress": PROGRESS[status], "source": self._source(job), "options": {},
            "error": "boom" if failed else None,
            "error_code": self.fail_code if failed else ("TASK_CANCELLED" if status == "cancelled" else None),
            "retryable": self.fail_retryable if failed else False,
            "created_at": job["created_at"], "updated_at": _now(), "completed_at": None,
        }

    def _build(self) -> FastAPI:
        app = FastAPI()
        fake = self

        @app.middleware("http")
        async def auth(request: Request, call_next):
            fake.requests.append((request.method, request.url.path))
            if request.url.path != "/v1/health" and request.headers.get("authorization") != f"Bearer {TOKEN}":
                return _error(401, "The supplied Bearer token is invalid", "AUTH_INVALID_TOKEN", "auth")
            return await call_next(request)

        @app.get("/v1/health")
        def health():
            return {"online": True, "ready": fake.ready, "version": "1.0.0", "commit": "abc1234",
                    "queue": {"paused": False, "length": 0}, "gpu": {"available": True},
                    "bilibili_login": fake.bilibili_login}

        @app.post("/v1/files", status_code=201)
        async def upload(file: UploadFile = File(...)):
            data = await file.read()
            file_id = uuid.uuid4().hex
            fake.files[file_id] = {"filename": file.filename, "data": data}
            return {"id": file_id, "filename": file.filename, "size_bytes": len(data), "sha256": "x",
                    "created_at": _now(), "download_url": f"/v1/files/{file_id}/content"}

        @app.post("/v1/jobs", status_code=201)
        async def create(payload: dict):
            source = payload.get("source") or {}
            if payload.get("kind", "transcription") != "transcription":
                return _error(400, "unsupported kind", "UNSUPPORTED_KIND", "validation")
            if source.get("type") == "file":
                if source.get("file_id") not in fake.files:
                    return _error(404, "file not found", "FILE_NOT_FOUND", "intake")
            elif source.get("type") == "url":
                if not source.get("url"):
                    return _error(400, "url missing", "INVALID_SOURCE", "validation")
            else:
                return _error(400, "unsupported source", "UNSUPPORTED_SOURCE_TYPE", "validation")
            job = {"id": uuid.uuid4().hex, "source": source, "options": payload.get("options") or {},
                   "seq": list(fake.script), "step": 0, "created_at": _now()}
            fake.jobs[job["id"]] = job
            return fake._view(job)

        def find(job_id: str, stage: str):
            job = fake.jobs.get(job_id)
            if job is None:
                return None, _error(404, f"Job {job_id} not found", "JOB_NOT_FOUND", stage)
            return job, None

        @app.get("/v1/jobs/{job_id}")
        def get_job(job_id: str):
            job, err = find(job_id, "jobs")
            if err:
                return err
            view = fake._view(job)
            fake._advance(job)
            return view

        @app.post("/v1/jobs/{job_id}/retry")
        def retry(job_id: str):
            job, err = find(job_id, "retry")
            if err:
                return err
            if fake._status(job) != "failed" or not fake.fail_retryable:
                return _error(409, "not retryable", "JOB_NOT_RETRYABLE", "retry")
            job["seq"], job["step"] = list(fake.retry_script), 0
            return fake._view(job)

        @app.get("/v1/jobs/{job_id}/result")
        def result(job_id: str):
            job, err = find(job_id, "result")
            if err:
                return err
            if fake._status(job) != "succeeded":
                return _error(409, "not succeeded", "JOB_NOT_SUCCEEDED", "result")
            return {"job_id": job_id, "status": "succeeded", "text": "大家好，今天讨论第一版的范围。",
                    "segments": [], "paragraphs": [], "speakers": [], "source": fake._source(job)}

        @app.get("/v1/jobs/{job_id}/exports/{fmt}")
        def export(job_id: str, fmt: str):
            job, err = find(job_id, "export")
            if err:
                return err
            if fake._status(job) != "succeeded":
                return _error(409, "not succeeded", "JOB_NOT_SUCCEEDED", "export")
            if fmt not in ("md", "srt"):
                return _error(400, "unsupported format", "UNSUPPORTED_FORMAT", "export")
            return PlainTextResponse({"md": MD, "srt": SRT}[fmt])

        @app.delete("/v1/jobs/{job_id}")
        def delete(job_id: str):
            job, err = find(job_id, "delete")
            if err:
                return err
            if fake._status(job) in ("queued", "running"):
                return _error(409, "job active", "JOB_ACTIVE", "delete")
            fake.jobs.pop(job_id)
            if job["source"]["type"] == "file":
                fake.files.pop(job["source"]["file_id"], None)
            return Response(status_code=204)

        return app
