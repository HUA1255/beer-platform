// 共享的模型调用：opencode go 的 OpenAI 兼容 chat/completions。
//   chatText(ctx, messages, { model, temperature }) → 模型回复的正文文本
// 其他模块（平台版本、规则学习……）都走这里，不各自拼请求。
// 密钥：钥匙串里的 opencode-go-api-key；地址：config.opencodeGoBase；HTTP 用 ctx.fetch。
// 错误统一成 503 model_no_key / 502 model_unauthorized / model_unreachable / model_upstream_error / model_bad_response，
// 消息都是中文，面板直接显示。
import { randomBytes } from 'node:crypto'
import { HttpError } from './http/router.js'

export const DEFAULT_TEXT_MODEL = 'deepseek-v4.1-flash'
const CHAT_PATH = '/inference/go/openai/v1/chat/completions'
const TIMEOUT_MS = 120_000

export async function chatText(ctx, messages, options = {}) {
  const model = options.model || ctx.config.platformVersionModel || DEFAULT_TEXT_MODEL
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.7

  let key
  try {
    key = await ctx.secrets.get('opencode-go-api-key')
  } catch {
    throw new HttpError(503, 'model_no_key', '读不出钥匙串里的 opencode go API key（钥匙串可能已锁定）')
  }
  if (!key) {
    throw new HttpError(503, 'model_no_key', '钥匙串里还没有 opencode go 的 API key（账号名 opencode-go-api-key）')
  }

  const url = String(ctx.config.opencodeGoBase || '').replace(/\/+$/, '') + CHAT_PATH
  let res
  try {
    res = await ctx.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // 文档要求每段会话带一个稳定的短串（用于路由和缓存）；每次调用生成一个即可。
        'x-opencode-session': `beer-${randomBytes(8).toString('hex')}`,
      },
      body: JSON.stringify({ model, messages, temperature }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new HttpError(502, 'model_unreachable', '连不上 opencode go 的模型接口（或超时），没有生成内容')
  }

  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, 'model_unauthorized', 'opencode go 不认这个 API key，请到钥匙串里更新 opencode-go-api-key')
  }
  if (!res.ok) {
    throw new HttpError(502, 'model_upstream_error', `opencode go 模型接口返回 ${res.status}，没有生成内容`)
  }
  const body = await res.json().catch(() => undefined)
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new HttpError(502, 'model_bad_response', 'opencode go 返回的模型响应格式看不懂（接口可能改了），没有生成内容')
  }
  return content
}
