"""假的 voice-transcription（ASRbox 0.4.0 接口的子集），供接口测试使用。

测试通过属性控制场景：
- ready：就绪检查结果
- script：每个新任务在 GET /tasks/{id} 时依次返回的状态序列（最后一个保持不变）
- retry_script：任务被 retry 后使用的状态序列
- hold：为 True 时任务停在当前状态不前进
"""

import uuid

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

TOKEN = "asr-test-token"
MD = "**说话人 1** [00:00]\n大家好，今天讨论第一版的范围。\n"
SRT = "1\n00:00:00,000 --> 00:00:02,000\n大家好，今天讨论第一版的范围。\n"


class FakeASR:
    def __init__(self):
        self.ready = True
        self.script = ["queued", "transcribing", "completed"]
        self.retry_script = ["queued", "transcribing", "completed"]
        self.hold = False
        self.tasks: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.app = self._build()

    def count(self, method: str, path_prefix: str) -> int:
        return sum(1 for m, p in self.requests if m == method and p.startswith(path_prefix))

    def _advance(self, task: dict) -> None:
        if not self.hold and task["step"] < len(task["seq"]) - 1:
            task["step"] += 1

    def _view(self, task: dict) -> dict:
        status = task["seq"][task["step"]]
        progress = {"queued": 0, "transcribing": 70.0}.get(status, 100.0)
        error_code = {"failed": "CHUNK_FAILED", "interrupted": "TASK_INTERRUPTED",
                      "failed_resumable": "CHUNK_FAILED"}.get(status)
        return {"id": task["id"], "filename": task["filename"], "status": status,
                "progress": progress, "error": "boom" if error_code else None,
                "error_code": error_code}

    def _build(self) -> FastAPI:
        app = FastAPI()
        fake = self

        @app.middleware("http")
        async def auth(request: Request, call_next):
            fake.requests.append((request.method, request.url.path))
            if request.url.path != "/health" and request.headers.get("authorization") != f"Bearer {TOKEN}":
                return JSONResponse({"detail": "ASRbox API authentication required"}, status_code=401)
            return await call_next(request)

        @app.get("/health")
        def health():
            return {"status": "ok", "version": "0.4.0", "active_tasks": 0}

        @app.get("/transcriptions/readiness")
        def readiness():
            if fake.ready:
                return {"ready": True, "backend": "local", "message": "Ready", "missing_models": []}
            return {"ready": False, "backend": "local", "message": "Missing models: qwen3-asr-1.7b",
                    "missing_models": ["qwen3-asr-1.7b"]}

        @app.post("/transcriptions")
        async def create(file: UploadFile = File(...), output_formats: str | None = Form(None)):
            data = await file.read()
            task = {"id": str(uuid.uuid4()), "filename": file.filename, "size": len(data),
                    "seq": list(fake.script), "step": 0}
            fake.tasks[task["id"]] = task
            return fake._view(task)

        @app.get("/tasks/{task_id}")
        def get_task(task_id: str):
            task = fake.tasks.get(task_id)
            if not task:
                return JSONResponse({"detail": "Task not found"}, status_code=404)
            view = fake._view(task)
            fake._advance(task)
            return view

        @app.post("/tasks/{task_id}/retry")
        def retry(task_id: str):
            task = fake.tasks[task_id]
            task["seq"], task["step"] = list(fake.retry_script), 0
            return fake._view(task)

        @app.post("/tasks/{task_id}/chunks/retry-failed")
        def retry_chunks(task_id: str):
            return retry(task_id)

        @app.get("/tasks/{task_id}/export/{fmt}")
        def export(task_id: str, fmt: str):
            return PlainTextResponse({"md": MD, "srt": SRT}[fmt])

        return app
