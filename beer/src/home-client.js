// 家里服务（Mac mini）的 HTTP 客户端：录音转发、播放下载、首页摘要都走这里。
// 接口见 home/README.md；地址来自 config.homeApiBase，密钥是钥匙串里的 home-api-key。
//
//   homeFetch(ctx, method, path, { body, headers, timeout, duplex }) → Response
//   homeUpload(ctx, method, path, { body, headers, timeout })        → Response（body 是 Node 可读流，守背压）
//   homeJson(ctx, method, path, opts)                              → 解析后的 JSON（非 2xx 抛错）
//   homeError(status, body)                                        → HttpError（家里的错误码和消息透传）
//
// 连不上 / 超时一律 502 home_unreachable「家里暂时连不上」；读不出密钥 503，不写本地队列。
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'
import { HttpError } from './http/router.js'

export const HOME_DOWN = '家里暂时连不上'
export const CALL_TIMEOUT_MS = 15_000

/** 用钥匙串里的 home-api-key 调家里；连不上 / 超时一律变成「家里暂时连不上」。 */
export async function homeFetch(ctx, method, path, { body, headers = {}, timeout = CALL_TIMEOUT_MS, duplex } = {}) {
  const key = await homeKey(ctx)
  const url = ctx.config.homeApiBase.replace(/\/+$/, '') + path
  try {
    return await ctx.fetch(url, {
      method,
      headers: { ...headers, authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(timeout),
      ...(duplex ? { duplex } : {}),
    })
  } catch {
    throw new HttpError(502, 'home_unreachable', HOME_DOWN)
  }
}

/**
 * 把一个 Node 可读流作为请求体上传给家里（录音上传专用），返回 Response。
 * 不用 fetch：Node 自带的 fetch 发流式请求体时不守背压，家里读得慢它也照样往下读，
 * 1 GB 录音会在 Beer 进程里攥住约 1 GB（#31）。这里用 node:http + pipeline，家里读多快就读多快。
 * 密钥、超时、连不上时的错误和 homeFetch 一致。
 */
export async function homeUpload(ctx, method, path, { body, headers = {}, timeout = CALL_TIMEOUT_MS } = {}) {
  const key = await homeKey(ctx)
  const url = new URL(ctx.config.homeApiBase.replace(/\/+$/, '') + path)
  const transport = url.protocol === 'https:' ? https : http
  const signal = AbortSignal.timeout(timeout)
  let req
  try {
    req = transport.request(url, {
      method,
      headers: { ...headers, authorization: `Bearer ${key}` },
      signal,
    })
  } catch {
    body.destroy()
    throw new HttpError(502, 'home_unreachable', HOME_DOWN)
  }
  const response = new Promise((resolve, reject) => {
    req.once('response', resolve)
    req.once('error', reject)
  })
  let sent = false
  const sending = pipeline(body, req).then(() => { sent = true }, () => {})
  try {
    const res = await response
    const chunks = []
    for await (const chunk of res) chunks.push(chunk)
    // 家里没读完就先回了（一般是报错）：不再往下发，上游的流一起关掉。
    if (!sent && !(res.statusCode >= 200 && res.statusCode < 300)) req.destroy()
    await sending
    const status = res.statusCode
    const noBody = status === 204 || status === 304
    return new Response(noBody ? null : Buffer.concat(chunks), {
      status,
      headers: Object.entries(res.headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.map(v => [name, v]) : [[name, String(value)]]),
    })
  } catch {
    req.destroy()
    body.destroy()
    throw new HttpError(502, 'home_unreachable', HOME_DOWN)
  }
}

/** 钥匙串里的 home-api-key；读不出或还没设一律 503。 */
async function homeKey(ctx) {
  let key
  try {
    key = await ctx.secrets.get('home-api-key')
  } catch {
    throw new HttpError(503, 'home_keychain_error', '读不出钥匙串里的家里服务访问密钥（钥匙串可能已锁定）')
  }
  if (!key) throw new HttpError(503, 'home_no_key', '钥匙串里还没有家里服务的访问密钥（账号名 home-api-key）')
  return key
}

/** 调家里并读 JSON；非 2xx 用家里的状态码和错误码，回包不是 JSON 时 502 home_bad_response。 */
export async function homeJson(ctx, method, path, options = {}) {
  const res = await homeFetch(ctx, method, path, options)
  const body = await readHomeBody(res)
  if (!res.ok) throw homeError(res.status, body)
  if (body === undefined) throw new HttpError(502, 'home_bad_response', '家里返回的内容看不懂')
  return body
}

/** 家里回包按 JSON 解析；不是 JSON 时返回 undefined（调用方决定怎么报错）。 */
export async function readHomeBody(res) {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** 家里错误形状 { detail, error_code } → Beer 统一的 { error: { code, message } }。 */
export function homeError(status, body) {
  const code = typeof body?.error_code === 'string' ? body.error_code
    : typeof body?.error?.code === 'string' ? body.error.code : 'home_error'
  const message = typeof body?.detail === 'string' ? body.detail
    : typeof body?.error?.message === 'string' ? body.error.message : `家里返回 ${status}`
  return new HttpError(status, code, message)
}
