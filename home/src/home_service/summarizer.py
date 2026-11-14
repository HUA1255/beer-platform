"""按录音类型生成摘要（#20），视频链接任务用「视频」类型（#34）。

流程：模型判断类型（只输出 JSON）→ 按类型生成 Markdown 摘要 → 发通知邮件。
视频链接任务跳过判断，直接按「视频」整理；重新总结时也可以手动选「视频」。
- 类型不认识（或模型没按 JSON 回）时按「会议」处理，并在摘要开头注明。
- 发信失败不影响摘要：只在字段里留下 mail_error，摘要步骤仍算完成。
- 模型错误（llm.py 的 MODEL_*）转成摘要步骤的 failed，可由 /retry 重做。
"""

import json
import logging

from .llm import LLMError
from .mailer import Mailer
from .pipeline import StepFailed

log = logging.getLogger(__name__)

TYPES = ("会议", "口述灵感", "课程讲座", "视频")
VIDEO_TYPE = "视频"  # 视频链接任务（#34）直接用这个类型，不经模型判断
FALLBACK_TYPE = "会议"
FALLBACK_NOTE = "> 类型未能识别，已按「会议」整理。\n\n"

CLASSIFY_PROMPT = """你是录音整理助手。先判断这段录音属于哪种类型：会议、口述灵感、课程讲座。
判断依据：多人轮流发言、围绕议题讨论并形成决定的是会议；一个人随口说想法、讲写作素材的是口述灵感；
老师系统讲授知识、有章节和知识点的是课程讲座。
只输出 JSON，格式为 {{"type": "会议"}}，type 只能是「会议」「口述灵感」「课程讲座」之一，不要输出其他内容。

文字稿：
{transcript}"""

SUMMARY_PROMPTS = {
    "会议": """你在整理一场会议的录音。请用 Markdown 输出三节：
## 结论
这场会议定下了什么（没形成结论就写「没有形成明确结论」）。
## 要点
3-8 条，每条一句话。
## 谁说了什么
按发言人整理，用文字稿里的「说话人 N」标识，尽量保留关键原话。""",
    "口述灵感": """你在整理一段口述灵感。这是一闪而过的想法，整理时要尽量保留原话和语气，
不要改写成公文，也不要替我下结论。请用 Markdown 输出：
## 原话
挑出最有价值的原话片段，保持原样。
## 可以怎么写
把这段灵感整理成写作素材：可能的切入角度、可以用的例子、想表达的判断。""",
    "课程讲座": """你在整理一堂课程或讲座。请用 Markdown 输出：
## 知识点大纲
按讲课顺序列出知识点，用多级列表表示层次。
## 值得记下的观点
3-8 条，保留讲者的表述和例子，不要扩写成教程。""",
    "视频": """你在整理一个网络视频的文字稿（来自字幕或语音识别）。请用 Markdown 输出三节：
## 一句话概括
这个视频讲了什么。
## 要点
3-8 条，按视频顺序，保留作者的表述和例子，不要扩写。
## 可以怎么写
把视频内容整理成写作素材：可能的切入角度、可以用的例子和观点，不要替我下结论。""",
}


def parse_type(text: str) -> str | None:
    """从模型回复里抠出类型；接受 ```json 代码块，也接受夹杂说明文字。"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    candidates = [cleaned]
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end > start:
        candidates.append(cleaned[start:end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        value = data.get("type") if isinstance(data, dict) else None
        return value.strip() if isinstance(value, str) and value.strip() in TYPES else None
    return None


def _source(rec: dict) -> dict:
    try:
        return json.loads(rec.get("source_info") or "{}") or {}
    except ValueError:
        return {}


def video_context(rec: dict) -> str:
    """视频的标题和作者给模型做背景；录音没有这一段。"""
    if not rec.get("source_url"):
        return ""
    src = _source(rec)
    lines = [f"{label}：{src[key]}" for key, label in (("title", "视频标题"), ("author", "作者")) if src.get(key)]
    return ("\n".join(lines) + "\n\n") if lines else ""


class RecordingSummarizer:
    """Summarizer 扩展点的真实实现；create_app(summarizer=...) 可注入假的替换。"""

    def __init__(self, llm, mailer: Mailer | None = None):
        self.llm, self.mailer = llm, mailer

    async def __call__(self, rec: dict, type_: str | None = None) -> dict:
        """type_ 为 None 时先让模型判断；指定类型时跳过判断（重新总结）。"""
        transcript = rec.get("transcript_md") or ""
        try:
            fallback = False
            if type_ is not None:
                summary_type = type_
            elif rec.get("source_url"):
                summary_type = VIDEO_TYPE
            else:
                summary_type, fallback = await self._detect(transcript)
            summary = await self._write(summary_type, transcript, video_context(rec))
        except LLMError as e:
            raise StepFailed(e.code, e.message) from e

        if fallback:
            summary = FALLBACK_NOTE + summary
        fields = {"summary": summary, "summary_type": summary_type}
        if type_ is None:
            await self._mail(rec, summary_type, summary, fields)
        return fields

    async def _detect(self, transcript: str) -> tuple[str, bool]:
        """返回（类型, 是否退回到会议）。"""
        reply = await self.llm.complete([
            {"role": "system", "content": "你只负责判断录音类型，回复必须是一个 JSON 对象。"},
            {"role": "user", "content": CLASSIFY_PROMPT.format(transcript=transcript)},
        ], temperature=0.0)
        found = parse_type(reply)
        return (found, False) if found else (FALLBACK_TYPE, True)

    async def _write(self, summary_type: str, transcript: str, context: str = "") -> str:
        prompt = SUMMARY_PROMPTS[summary_type] + "\n\n" + context + "文字稿：\n" + transcript
        return await self.llm.complete([
            {"role": "system", "content": "你是中文录音整理助手，只输出 Markdown 摘要正文。"},
            {"role": "user", "content": prompt},
        ])

    async def _mail(self, rec: dict, summary_type: str, summary: str, fields: dict) -> None:
        if not self.mailer or not self.mailer.configured:
            log.info("没有配置 SMTP，跳过录音 %s 的通知邮件", rec.get("id"))
            return
        if rec.get("source_url"):
            name = _source(rec).get("title") or rec["source_url"]
            subject = f"视频已转写：{name}"
            body = f"视频「{name}」已转写完成。\n\n链接：{rec['source_url']}\n\n类型：{summary_type}\n\n{summary}\n"
        else:
            name = rec.get("filename") or rec.get("id")
            subject = f"录音已转写：{name}"
            body = f"录音「{name}」已转写完成。\n\n类型：{summary_type}\n\n{summary}\n"
        try:
            await self.mailer.send(subject, body)
        except Exception as e:  # noqa: BLE001 - 发信失败不能让摘要变失败
            log.warning("录音 %s 的通知邮件发送失败：%s", rec.get("id"), e)
            fields["mail_error"] = getattr(e, "message", None) or f"发邮件失败：{e}"
            return
        fields["mail_error"] = None
