// 接口测试骨架：每个测试准备临时库、启动 Beer 服务端，只通过 /api/beer/ 调用。
//
//   const beer = await startBeer(t)                       // 已选好一个空的临时库
//   const beer = await startBeer(t, { vault: { '内容库/文章/a/index.md': '...' } })
//   const beer = await startBeer(t, { vault: false })     // 还没选库（首次使用）
//   const home = await startFake(t, { 'GET /health': () => ({ ok: true }) })
//   const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': 'k' } })
//   const res = await beer.api('GET', '/vault')           // → { status, body }
//
// 所有临时目录和服务器在测试结束时（t.after）自动清理。
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { createBeerContext, createBeerHandler } from '../../src/app.js'

export const PREFIX = '/api/beer'

/** 建一个临时目录，按 { 相对路径: 内容 } 写入文件。 */
export async function makeTempDir(t, prefix, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

/** 列出目录里所有文件的相对路径（排好序，统一用 / 分隔），用于断言「库里最终有哪些文件」。 */
export async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(e => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  return entries
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name).slice(dir.length + 1).split(sep).join('/'))
    .sort()
}

/** 把一个 (req, res) handler 跑成真正的 HTTP 服务。 */
export async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  let closed = false
  const close = () => {
    if (closed) return Promise.resolve()
    closed = true
    server.closeAllConnections?.()
    return new Promise(resolve => server.close(() => resolve()))
  }
  t.after(close)
  return { url: `http://127.0.0.1:${port}`, close }
}

/** 调用一个 JSON 接口，返回 { status, body }（body 不是 JSON 时为文本）。 */
export async function call(baseUrl, method, path, body) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const res = await fetch(baseUrl + path, init)
  const text = await res.text()
  let parsed = text
  try { parsed = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, body: parsed, headers: res.headers }
}

/** 测试用的假钥匙串：set 直接改 values（传进来的对象），之后 get 读到新值。 */
export function fakeSecrets(values = {}) {
  return {
    get: async name => values[name],
    set: async (name, value) => { values[name] = value },
  }
}

/**
 * 启动 Beer 服务端。
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {false | Record<string,string>} [options.vault]  库里的初始文件；false 表示还没选库
 * @param {object} [options.config]   覆盖插件配置项（家里 API 地址等）
 * @param {Record<string,string> | {get(name:string):Promise<string|undefined>, set?(name:string, value:string):Promise<void>}} [options.secrets]  假钥匙串（传普通对象时 set 会改这个对象）
 * @param {string} [options.dataDir]  复用已有的数据目录（模拟重启）
 * @param {() => Date} [options.now]
 * @param {typeof fetch} [options.fetch]  替换服务端调用外部 HTTP 的方式（默认 globalThis.fetch；测试里可以包一层数请求）
 */
export async function startBeer(t, options = {}) {
  const dataDir = options.dataDir ?? await makeTempDir(t, 'beer-data-')
  const vault = options.vault === false ? undefined : await makeTempDir(t, 'beer-vault-', options.vault ?? {})
  const secrets = typeof options.secrets?.get === 'function' ? options.secrets : fakeSecrets(options.secrets)
  const config = { root: dataDir, ...options.config }
  const context = createBeerContext({ config, secrets, now: options.now, fetch: options.fetch })
  const server = await listen(t, createBeerHandler({ context }))
  const api = (method, path, body) => call(server.url, method, PREFIX + path, body)
  if (vault) {
    const res = await api('PUT', '/vault', { path: vault })
    if (res.status !== 200) throw new Error(`选库失败：${res.status} ${JSON.stringify(res.body)}`)
  }
  return {
    url: server.url,
    api,
    /** 业务上下文：AI 工具的执行函数（#22）直接拿它当 ctx。 */
    context,
    vault,
    dataDir,
    close: server.close,
    /** 关掉当前服务端，用同一数据目录再启动一个（模拟重启 Harness）。 */
    async restart(more = {}) {
      await server.close()
      const next = await startBeer(t, { ...options, ...more, dataDir, vault: false })
      return { ...next, vault }
    },
  }
}

/**
 * 启动一个假的外部 HTTP 服务（家里 API、opencode go、Rin 博客……）。
 * routes: { 'GET /health': (req, body) => 返回值 | { status, body } }
 * 返回值是普通对象时按 200 JSON 回；要指定状态码时返回 { status: <数字>, body }；
 * 要回二进制时返回 { raw: Buffer, contentType?, headers? }（录音播放测试用）。
 * 收到的每个请求都记在 requests 里：{ method, path, headers, body, raw }（raw 是原始 Buffer，
 * 上传转发测试用它核对 multipart 里的文件内容是否原样到达）。
 */
export async function startFake(t, routes = {}) {
  const requests = []
  const server = await listen(t, async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const bytes = Buffer.concat(chunks)
    const raw = bytes.toString('utf8')
    let body = raw
    try { body = raw ? JSON.parse(raw) : undefined } catch {}
    const url = new URL(req.url, 'http://fake')
    requests.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body, raw: bytes })
    const route = routes[`${req.method} ${url.pathname}`]
    let status = 404
    let out = { error: 'not found' }
    if (route) {
      const result = await route(req, body)
      if (result && typeof result === 'object' && Buffer.isBuffer(result.raw)) {
        res.writeHead(typeof result.status === 'number' ? result.status : 200, {
          'content-type': result.contentType ?? 'application/octet-stream',
          ...result.headers,
        })
        res.end(result.raw)
        return
      }
      if (result && typeof result === 'object' && typeof result.status === 'number' && 'body' in result) {
        status = result.status
        out = result.body
      } else {
        status = 200
        out = result
      }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(out === undefined ? '' : JSON.stringify(out))
  })
  return { url: server.url, requests, close: server.close }
}

/** 一个连不上的地址（端口刚被释放），用来模拟「家里连不上」。 */
export async function deadUrl(t) {
  const server = await listen(t, (_req, res) => res.end())
  await server.close()
  return server.url
}
