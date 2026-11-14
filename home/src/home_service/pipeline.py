"""转录调度：就绪检查 → 提交到 BeeBox → 跟进 → 导出 md/srt → 摘要。

每一步开始和结束都落库；失败的那一步记为 failed，重试时从这一步接着做。
「入库」一步由 Beer 取回结果后确认（POST /recordings/{id}/stored），不在这里推进。

BeeBox 任务只有五种公开状态（queued / running / succeeded / failed / cancelled）。
重试时：任务失败且 retryable → 让 BeeBox 从断点接着跑；否则（不可重试、已取消、
BeeBox 上已没有这个任务）→ 重新提交一个新任务。
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from .beebox import (
    CANCELLED,
    FAILED,
    QUEUED,
    SUCCEEDED,
    TERMINAL_FAILURES,
    BeeBoxClient,
    BeeBoxError,
    JobGone,
    hint,
)
from .store import Store

log = logging.getLogger(__name__)

# 摘要扩展点：拿到录音记录（含 transcript_md），返回要保存的字段（如 {"summary": ...}）。
# #20 的默认实现见 summarizer.py；重新总结时会带 type_=<类型> 调用。
Summarizer = Callable[..., Awaitable[dict]]
HealthObserver = Callable[[dict], Awaitable[None]]


async def no_summary(rec: dict) -> dict:
    return {}


async def _ignore_health(body: dict) -> None:
    return None


class StepFailed(Exception):
    def __init__(self, code: str, message: str, retryable: bool = True):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


class Pipeline:
    def __init__(self, store: Store, beebox: BeeBoxClient, poll_interval: float, summarizer: Summarizer = no_summary,
                 fetch_audio: Callable[[dict], Awaitable[Path]] | None = None,
                 on_health: HealthObserver = _ignore_health):
        self.store, self.beebox, self.poll_interval, self.summarizer = store, beebox, poll_interval, summarizer
        # 本地暂存被清掉之后（原件只在 NAS 上），提交前用它把原件取回来
        self.fetch_audio = fetch_audio
        # 每次读到 BeeBox 的 /v1/health 都交给它（B 站登录失效提醒）
        self.on_health = on_health
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

    async def wait(self, rec_id: str) -> None:
        task = self._tasks.get(rec_id)
        if task is not None:
            await task

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
        except (StepFailed, BeeBoxError) as e:
            self.store.set_step(rec_id, step, "failed", error_code=e.code, error=e.message,
                                retryable=int(e.retryable))
        except asyncio.CancelledError:
            raise  # 服务停止：步骤保持 running，下次启动续跑
        except Exception as e:  # noqa: BLE001
            log.exception("录音 %s 在 %s 一步出错", rec_id, step)
            self.store.set_step(rec_id, step, "failed", error_code="INTERNAL_ERROR", error=str(e), retryable=1)

    async def _check_ready(self) -> None:
        body = await self.beebox.check_ready()
        try:
            await self.on_health(body)
        except Exception:  # noqa: BLE001 - 登录提醒出错不影响转写
            log.exception("处理 B 站登录状态时出错")

    async def _ensure_remote_job(self, rec_id: str) -> str:
        """保证 BeeBox 上有一个在跑（或已完成）的任务；能续就续，不重新上传。"""
        rec = self.store.get(rec_id)
        job_id = rec["asr_task_id"]
        if job_id:
            try:
                job = await self.beebox.get_job(job_id)
            except JobGone:
                job = None
            if job and job["status"] not in TERMINAL_FAILURES:
                return job_id
            if job and job["status"] == FAILED and job.get("retryable"):
                await self._check_ready()
                await self.beebox.retry(job_id)
                return job_id
            if job:
                # 不可重试的失败或已取消：这个任务没用了，删掉再新建（删不掉就留给 BeeBox 的保留期清理）
                await self._drop_job(job_id)
        await self._check_ready()
        if rec["source_url"]:
            job_id = await self.beebox.submit_url(rec["source_url"])
        else:
            audio = Path(rec["original_path"])
            if not audio.is_file() and self.fetch_audio is not None:
                audio = await self.fetch_audio(rec)
            job_id = await self.beebox.submit_file(audio, rec["filename"])
        self.store.update(rec_id, asr_task_id=job_id, asr_status=QUEUED, asr_stage=QUEUED, progress=0.0)
        return job_id

    async def _drop_job(self, job_id: str) -> None:
        try:
            await self.beebox.delete_job(job_id)
        except BeeBoxError as e:
            log.warning("删除 BeeBox 任务 %s 失败：%s", job_id, e.message)

    async def _follow(self, rec_id: str, job_id: str, wait_while: Callable[[str], bool]) -> dict:
        while True:
            job = await self.beebox.get_job(job_id)
            status = job["status"]
            self.store.update(rec_id, asr_status=status, asr_stage=job.get("stage"),
                              progress=round(float(job.get("progress") or 0.0) * 100, 1))
            if status == FAILED:
                code = job.get("error_code") or "TASK_FAILED"
                raise StepFailed(code, hint(code, job.get("error")), retryable=bool(job.get("retryable")))
            if status == CANCELLED:
                raise StepFailed("TASK_CANCELLED", hint("TASK_CANCELLED"), retryable=True)
            if not wait_while(status):
                return job
            await asyncio.sleep(self.poll_interval)

    async def _job_id(self, rec_id: str, first: bool) -> str:
        # 本轮第一步（新录音、重启续跑、用户重试）要确认远端任务；之后的步骤沿用同一个任务
        if first:
            return await self._ensure_remote_job(rec_id)
        return self.store.get(rec_id)["asr_task_id"]

    async def _queue(self, rec_id: str, first: bool) -> None:
        job_id = await self._job_id(rec_id, first)
        await self._follow(rec_id, job_id, lambda s: s == QUEUED)

    async def _transcribe(self, rec_id: str, first: bool) -> None:
        job_id = await self._job_id(rec_id, first)
        await self._follow(rec_id, job_id, lambda s: s != SUCCEEDED)
        md = await self.beebox.export(job_id, "md")
        srt = await self.beebox.export(job_id, "srt")
        # 文字来源、标题、作者、时长、原链接（视频链接任务用得上）
        source = (await self.beebox.result(job_id)).get("source") or {}
        self.store.update(rec_id, transcript_md=md, transcript_srt=srt, source_info=json.dumps(source, ensure_ascii=False),
                          progress=100.0, error_code=None, error=None, retryable=None)

    async def _summarize(self, rec_id: str, first: bool) -> None:
        fields = await self.summarizer(self.store.get(rec_id))
        if fields:
            self.store.update(rec_id, **fields)
