// /api/beer/ 下的小路由表。每个模块拿到一个 router，按相对路径注册接口：
//
//   router.get('/vault', async req => ({ status: 'unset' }))
//   router.put('/layout/chat/:tab', async req => { const body = await req.json(); ... })
//
// handler 返回普通值 → 200 JSON；返回 reply(status, body) → 指定状态码；
// 抛 HttpError → { error: { code, message } }；其他异常 → 500。
// 需要自己写响应（流式下载、上传）时直接用 req.res，然后返回 undefined。

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

const REPLY = Symbol('reply')
export function reply(status, body) {
  return { [REPLY]: true, status, body }
}

const MAX_JSON_BYTES = 1024 * 1024

export function createRouter(prefix) {
  const routes = []

  function add(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean)
    routes.push({ method, parts, handler })
  }

  function match(method, path) {
    const segs = path.split('/').filter(Boolean)
    let methodMismatch = false
    for (const route of routes) {
      if (route.parts.length !== segs.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i]
        if (p.startsWith(':')) {
          try { params[p.slice(1)] = decodeURIComponent(segs[i]) } catch { ok = false; break }
        } else if (p !== segs[i]) { ok = false; break }
      }
      if (!ok) continue
      if (route.method !== method) { methodMismatch = true; continue }
      return { route, params }
    }
    return { methodMismatch }
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://beer.local')
      const path = url.pathname === prefix ? '/' : url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : undefined
      if (path === undefined) throw new HttpError(404, 'not_found', '没有这个接口')
      const found = match(req.method ?? 'GET', path)
      if (!found.route) {
        if (found.methodMismatch) throw new HttpError(405, 'method_not_allowed', '不支持这个请求方法')
        throw new HttpError(404, 'not_found', '没有这个接口')
      }
      const request = {
        method: req.method,
        params: found.params,
        query: url.searchParams,
        headers: req.headers,
        req,
        res,
        json: () => readJson(req),
      }
      const result = await found.route.handler(request)
      if (res.headersSent || res.writableEnded) return
      if (result && result[REPLY]) return sendJson(res, result.status, result.body)
      return sendJson(res, 200, result ?? {})
    } catch (e) {
      if (res.headersSent) { res.destroy(); return }
      if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } })
      return sendJson(res, 500, { error: { code: 'internal', message: String(e?.message ?? e) } })
    }
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    handle,
  }
}

export function sendJson(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'too_large', '请求体太大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad_json', '请求体不是合法的 JSON')
  }
}
