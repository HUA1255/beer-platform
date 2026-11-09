// 演示模式：不装 DSH Desktop，也能在浏览器里看到 Beer 的真实面板。
//
//   npm run demo            → http://127.0.0.1:4173
//
// 后端是真的 Beer（createBeerHandler，和 DSH Desktop 里跑的是同一份代码），读写一个现建的示例库；
// 家里服务、opencode go 模型和限额接口用 demoFetch 模拟，返回固定的示例数据。
// 宿主（React、工作台注册、AI 对话）由 demo/index.html 里的小垫片提供。
//
// 环境变量：DEMO_PORT（默认 4173）、DEMO_VAULT（示例库位置，默认系统临时目录下的 Beer 示例库，每次启动重建）。
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBeerContext, createBeerHandler } from '../src/app.js'
import { demoArticlePath, demoVault } from './vault.js'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.DEMO_PORT || 4173)
const vaultDir = process.env.DEMO_VAULT || join(tmpdir(), 'Beer 示例库')
const dataDir = join(tmpdir(), 'beer-demo-data')

const HOME = 'http://home.demo'
const OPENCODE = 'http://opencode.demo'

// ---- 模拟的家里服务 ----

const iso = minutesAgo => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const steps = done => ['上传', '排队', '转写', '摘要', '入库'].map((name, i) => ({
  key: ['upload', 'queue', 'transcribe', 'summarize', 'store'][i],
  name,
  status: i < done ? 'done' : i === done ? 'running' : 'pending',
}))

const recordings = [
  { id: 'rec-3', filename: '产品周会-11月第二周.m4a', status: 'processing', steps: steps(2), progress: 58, created_at: iso(6), updated_at: iso(1) },
  { id: 'rec-2', filename: '口述-关于慢写作.m4a', status: 'ready', steps: steps(5), progress: 100, summary_type: '口述灵感', created_at: iso(90), updated_at: iso(80) },
  { id: 'rec-1', filename: '讲座-个人知识管理的十年.m4a', status: 'stored', steps: steps(5), progress: 100, summary_type: '课程讲座', created_at: iso(60 * 26), updated_at: iso(60 * 25) },
].map(r => ({ error_code: null, error: null, original_path: `/录音原件/${r.id}/${r.filename}`, ...r }))

const transcripts = {
  'rec-2': {
    summary: '- 慢写作不是写得慢，而是让一个想法在笔记里放够时间\n- 每条灵感先进素材库，攒够三条相关的再动笔\n- 发布前给自己留一晚，第二天早上再改一遍',
    markdown: '# 口述-关于慢写作\n\n[00:00] 最近一直在想慢写作这件事……\n[00:42] 我发现真正写得好的那几篇，都是素材攒了很久的……\n',
    srt: '1\n00:00:00,000 --> 00:00:05,000\n最近一直在想慢写作这件事\n',
  },
}

function homeRoute(method, path) {
  if (method === 'GET' && path === '/health') {
    return { ok: true, machines: { mac_mini: { online: true }, windows: { online: true }, nas: { online: true } } }
  }
  if (method === 'GET' && path.startsWith('/recordings?')) {
    const status = new URLSearchParams(path.split('?')[1]).get('status')
    return { recordings: status ? recordings.filter(r => r.status === status) : recordings }
  }
  if (method === 'GET' && path === '/recordings') return { recordings }
  const m = path.match(/^\/recordings\/([^/?]+)(\/[a-z]+)?$/)
  const rec = m && recordings.find(r => r.id === m[1])
  if (rec && method === 'GET' && !m[2]) return rec
  if (rec && method === 'GET' && m[2] === '/transcript') {
    return { id: rec.id, filename: rec.filename, summary_type: rec.summary_type, ...(transcripts[rec.id] ?? { summary: '', markdown: '', srt: '' }) }
  }
  if (rec && method === 'POST' && m[2] === '/stored') { rec.status = 'stored'; return rec }
  return undefined
}

// ---- 模拟的 opencode go ----

const BRIEF_ANGLES = {
  angles: [
    { title: '为什么我把灵感先丢进素材库，而不是直接写', why: '口述录音里反复提到「攒够三条再动笔」，读者也在问怎么积累选题', materials: ['内容库/素材/2026-11-09-口述-关于慢写作/index.md'] },
    { title: '十年个人知识管理，留下来的只有三个习惯', why: '讲座文字稿信息量大，适合整理成一篇清单式长文', materials: ['内容库/素材/2026-11-08-讲座-个人知识管理的十年/index.md'] },
    { title: '把 Obsidian 当成写作流水线的起点', why: '两篇收藏的文章都在讨论「笔记 → 文章」的转化，可以写自己的做法', materials: ['内容库/素材/2026-11-07-从笔记到文章/index.md'] },
  ],
}

function chatReply(messages) {
  const prompt = messages.map(m => m.content).join('\n')
  if (prompt.includes('"angles"')) return JSON.stringify(BRIEF_ANGLES)
  if (prompt.includes('短段落短句子')) {
    return '把写作搬进一个工作台后，我每周多出 3 小时 ✍️\n\n以前写一篇文章，光找素材就要半小时👇\n\n📌 录音上传，自动转写 + 摘要\n📌 每天早上一份选题简报\n📌 写完确认一次，各平台版本自动生成\n\n现在找素材的时间几乎没有了。你写东西最花时间的是哪一步？\n\n#写作 #效率工具 #Obsidian #个人知识管理'
  }
  return '# 我把写作搬进了一个工作台\n\n**结论先说：找素材的时间几乎归零，写作时间多了一倍。**\n\n## 问题：素材散落在四个地方\n\n手机录音、电脑笔记、NAS 上的文件、收藏夹里的文章……每次动笔前都要先花半小时找东西。\n\n## 做法：一条从录音到发布的流水线\n\n录音上传后自动转写和摘要，进素材库；每天早上生成一份选题简报；写完确认一次，知乎、小红书版本自动生成。\n\n## 效果\n\n半年下来，写作本身的时间多了，发布也不再是负担。'
}

function opencodeRoute(method, path, body) {
  if (method === 'GET' && path === '/zen/go/v1/usage') {
    return {
      usage: {
        rolling: { status: 'ok', percent: 18, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
        weekly: { status: 'ok', percent: 42, resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString() },
        monthly: { status: 'ok', percent: 27, resetsAt: new Date(Date.now() + 21 * 86400_000).toISOString() },
      },
    }
  }
  if (method === 'POST' && path.endsWith('/chat/completions')) {
    const { messages = [] } = JSON.parse(body || '{}')
    return { choices: [{ message: { role: 'assistant', content: chatReply(messages) } }] }
  }
  return undefined
}

/** 代替真实网络：只认上面两个假地址，别的一律当连不上。 */
async function demoFetch(input, init = {}) {
  const url = new URL(String(input))
  const method = (init.method || 'GET').toUpperCase()
  const path = url.pathname + url.search
  const body = typeof init.body === 'string' ? init.body : undefined
  let result
  if (url.origin === HOME) result = homeRoute(method, path)
  else if (url.origin === OPENCODE) result = opencodeRoute(method, url.pathname, body)
  else throw new TypeError('演示模式不连外网：' + url.origin)
  await new Promise(resolve => setTimeout(resolve, 120)) // 让加载状态看得出来
  if (result === undefined) return Response.json({ error: { code: 'NOT_FOUND', message: '演示数据里没有' } }, { status: 404 })
  return Response.json(result)
}

// ---- 启动 ----

await rm(vaultDir, { recursive: true, force: true })
await rm(dataDir, { recursive: true, force: true })
for (const [rel, content] of Object.entries(demoVault())) {
  const file = join(vaultDir, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}
await mkdir(dataDir, { recursive: true })

const secrets = { 'home-api-key': 'demo', 'opencode-go-api-key': 'demo' }
const context = createBeerContext({
  config: { root: dataDir, homeApiBase: HOME, opencodeGoBase: OPENCODE },
  secrets: { get: async name => secrets[name], set: async (name, value) => { secrets[name] = value } },
  fetch: demoFetch,
})
const beer = createBeerHandler({ context })

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/beer-client.js': ['../client/beer-client.js', 'text/javascript; charset=utf-8'],
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path.startsWith('/api/beer')) return beer(req, res)
  const hit = STATIC[path]
  if (!hit) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-cache' })
  res.end(await readFile(join(here, hit[0])))
})

server.listen(port, '127.0.0.1', async () => {
  // 先替用户选好示例库，打开就是有内容的样子
  const call = (method, path, body) => fetch(`http://127.0.0.1:${port}/api/beer${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  await call('PUT', '/vault', { path: vaultDir })
  // 给成稿生成知乎、小红书版本，发布分页就有多平台对照可看
  await call('POST', '/articles/versions/generate', { path: demoArticlePath() })
  console.log(`Beer 演示模式：http://127.0.0.1:${port}\n示例库：${vaultDir}`)
})
