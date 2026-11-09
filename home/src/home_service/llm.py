"""opencode go 的 OpenAI 兼容 chat/completions 调用（按类型摘要用）。

文档要求每个客户端带稳定短串的 `x-opencode-session`（用于路由和缓存），
这里每个服务进程生成一次。错误统一成中文消息，由 summarizer 转成摘要步骤的失败码。
"""

import uuid

import httpx

DEFAULT_MODEL = "deepseek-v4.1-flash"
CHAT_PATH = "/inference/go/openai/v1/chat/completions"
TIMEOUT_SECONDS = 120.0

# 进程内稳定：同一个服务实例的所有摘要调用共用一个会话串。
SESSION_ID = "home-" + uuid.uuid4().hex[:12]


class LLMError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str = DEFAULT_MODEL,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.model = model or DEFAULT_MODEL
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "x-opencode-session": SESSION_ID,
            },
            transport=transport,
            timeout=httpx.Timeout(TIMEOUT_SECONDS),
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def complete(self, messages: list[dict], temperature: float = 0.2) -> str:
        """发一次 chat/completions，返回助手回复的正文。"""
        payload = {"model": self.model, "messages": messages, "temperature": temperature}
        try:
            r = await self._http.post(CHAT_PATH, json=payload)
        except httpx.TransportError as e:
            raise LLMError("MODEL_UNREACHABLE", f"连不上 opencode go 的模型接口（或超时）：{e}") from e
        if r.status_code in (401, 403):
            raise LLMError("MODEL_UNAUTHORIZED", "opencode go 不认这个 API key，请检查 HOME_OPENCODE_API_KEY")
        if r.status_code >= 400:
            raise LLMError("MODEL_UPSTREAM_ERROR", f"opencode go 模型接口返回 {r.status_code}，没有生成摘要")
        try:
            body = r.json()
        except ValueError as e:
            raise LLMError("MODEL_BAD_RESPONSE", "opencode go 返回的内容不是 JSON，没有生成摘要") from e
        content = (body.get("choices") or [{}])[0].get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            raise LLMError("MODEL_BAD_RESPONSE", "opencode go 的模型响应格式看不懂（接口可能改了），没有生成摘要")
        return content
