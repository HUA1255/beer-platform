"""转录调度：就绪检查 → 提交 → 跟进 → 导出 md/srt → 摘要。

每一步开始和结束都落库；失败的那一步记为 failed，重试时从这一步接着做。
「入库」一步由 Beer 取回结果后确认（POST /recordings/{id}/stored），不在这里推进。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from .asr import ASRClient, ASRError, TaskGone
from .store import Store

log = logging.getLogger(__name__)

QUEUED = {"created", "queued"}
FAILED = {"failed", "cancelled", "interrupted", "failed_resumable"}
RETRYABLE = {"failed", "interrupted", "failed_resumable", "cancelled"}

# 摘要扩展点：拿到录音记录（含 transcript_md），返回要保存的字段（如 {"summary": ...}）。
# #20 的默认实现见 summarizer.py；重新总结时会带 type_=<类型> 调用。
Summarizer = Callable[..., Awaitable[dict]]


async def no_summary(rec: dict) -> dict:
    return {}


class StepFailed(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class Pipeline:
    def __init__(self, store: Store, asr: ASRClient, poll_interval: float, summarizer: Summarizer = no_summary,
                 fetch_audio: Callable[[dict], Awaitable[Path]] | None = None):
        self.store, self.asr, self.poll_interval, self.summarizer = store, asr, poll_interval, summarizer
        # 本地暂存被清掉之后（原件只在 NAS 上），提交前用它把原件取回来
        self.fetch_audio = fetch_audio
        self._tasks: dict[str, asyncio.Task] = {}

    def is_running(self, rec_id: str) -> bool:
        task = self._tasks.get(rec_id)
        return task is not None and not task.done()

    def start(self, rec_id: str) -> None:
        if not self.is_running(rec_id):
            self._tasks[rec_id] = asyncio.create_task(self._run(rec_id))

    def resume_unfinished(self) -> None:
        """服务启动时接着跑上次没跑完（且没失败）的录音。"""
        for rec in self.store.all():
            st = rec["steps"]
            if "failed" not in st.values() and st["summarize"] != "done":
                self.start(rec["id"])

    async def shutdown(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def _run(self, rec_id: str) -> None:
        step, first = "queue", True
        try:
            for step, action in (("queue", self._queue), ("transcribe", self._transcribe),
                                 ("summarize", self._summarize)):
                if self.store.get(rec_id)["steps"][step] == "done":
                    continue
                self.store.set_step(rec_id, step, "running")
                await action(rec_id, first)
                self.store.set_step(rec_id, step, "done")
                first = False
        except StepFailed as e:
            self.store.set_step(rec_id, step, "failed", error_code=e.code, error=e.message)
        except ASRError as e:
            self.store.set_step(rec_id, step, "failed", error_code=e.code, error=e.message)
        except asyncio.CancelledError:
            raise  # 服务停止：步骤保持 running，下次启动续跑
        except Exception as e:  # noqa: BLE001
            log.exception("录音 %s 在 %s 一步出错", rec_id, step)
            self.store.set_step(rec_id, step, "failed", error_code="INTERNAL_ERROR", error=str(e))

    async def _ensure_remote_task(self, rec_id: str) -> str:
        """保证 Windows 上有一个在跑（或已完成）的任务；能续就续，不重新上传。"""
        rec = self.store.get(rec_id)
        task_id = rec["asr_task_id"]
        if task_id:
            try:
                task = await self.asr.get_task(task_id)
            except TaskGone:
                task = None
            if task and task["status"] not in RETRYABLE:
                return task_id
            if task:
                await self.asr.check_ready()
                await self.asr.retry(task_id, resumable=task["status"] == "failed_resumable")
                return task_id
        await self.asr.check_ready()
        audio = Path(rec["original_path"])
        if not audio.is_file() and self.fetch_audio is not None:
            audio = await self.fetch_audio(rec)
        task_id = await self.asr.submit(audio, rec["filename"])
        self.store.update(rec_id, asr_task_id=task_id, asr_status="queued", progress=0.0)
        return task_id

    async def _follow(self, rec_id: str, task_id: str, wait_while: Callable[[str], bool]) -> str:
        while True:
            task = await self.asr.get_task(task_id)
            status = task["status"]
            self.store.update(rec_id, asr_status=status, progress=task.get("progress"))
            if status in FAILED:
                raise StepFailed(task.get("error_code") or "TRANSCRIPTION_FAILED",
                                 task.get("error") or f"转写失败（{status}）")
            if not wait_while(status):
                return status
            await asyncio.sleep(self.poll_interval)

    async def _task_id(self, rec_id: str, first: bool) -> str:
        # 本轮第一步（新录音、重启续跑、用户重试）要确认远端任务；之后的步骤沿用同一个任务
        if first:
            return await self._ensure_remote_task(rec_id)
        return self.store.get(rec_id)["asr_task_id"]

    async def _queue(self, rec_id: str, first: bool) -> None:
        task_id = await self._task_id(rec_id, first)
        await self._follow(rec_id, task_id, lambda s: s in QUEUED)

    async def _transcribe(self, rec_id: str, first: bool) -> None:
        task_id = await self._task_id(rec_id, first)
        await self._follow(rec_id, task_id, lambda s: s != "completed")
        md = await self.asr.export(task_id, "md")
        srt = await self.asr.export(task_id, "srt")
        self.store.update(rec_id, transcript_md=md, transcript_srt=srt, progress=100.0,
                          error_code=None, error=None)

    async def _summarize(self, rec_id: str, first: bool) -> None:
        fields = await self.summarizer(self.store.get(rec_id))
        if fields:
            self.store.update(rec_id, **fields)
