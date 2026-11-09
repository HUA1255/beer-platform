// 首页的接口测试（#23）：只通过 /api/beer/ 验证汇总结果——待发布文章、当天简报、编辑冲突、
// 录音进度、本周产出和规则积累；家里服务、模型都用 startFake 代替。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles, makeTempDir } from './helpers/beer.js'

const MODEL_PATH = 'POST /inference/go/openai/v1/chat/completions'
const TODAY = '2026-11-06'
const BRIEF_PATH = `内容库/选题简报/${TODAY}.md`
const MAIN = '内容库/文章/2026-11-02-本周成稿/index.md'
const CONFIRMED = '内容库/文章/2026-11-03-待确认/index.md'
const OLD_DRAFT = '内容库/文章/2026-10-10-旧成稿/index.md'
const PUBLISHED = '内容库/文章/2026-11-04-已发布/index.md'
const DRAFT = '内容库/文章/2026-11-05-草稿/index.md'

const note = (title, status, date, body = '') => `---
标题: ${title}
状态: ${status}
日期: ${date}
---

# ${title}

${body}`

const material = (title) => `---
类型: 文字
标签: [写作]
状态: 可用
---

# ${title}

素材正文。
`

const BRIEF = `---
日期: ${TODAY}
类型: 选题简报
状态: 已生成
生成时间: 2026-11-06T00:00:00.000Z
---

# ${TODAY} 选题简报

## 角度

### 1. 测试角度
**为什么值得写：** 因为测试。
**素材：** （没有指定素材）

## 素材清单

- （最近 30 天没有素材）
`

const VAULT = {
  [MAIN]: note('本周成稿', '成稿', '2026-11-02'),
  [CONFIRMED]: note('待确认', '已确认', '2026-11-03'),
  [OLD_DRAFT]: note('旧成稿', '成稿', '2026-10-10'),
  [PUBLISHED]: note('已发布', '已发布', '2026-11-04'),
  [DRAFT]: note('草稿', '草稿', '2026-11-05'),
  '内容库/素材/2026-11-02-周会/index.md': material('周会'),
  '内容库/素材/2026-11-01-周日素材/index.md': material('周日素材'),
  '内容库/素材/2026-10-05-旧素材/index.md': material('旧素材'),
  '内容库/素材/随手笔记/index.md': material('随手笔记'),
  [BRIEF_PATH]: BRIEF,
  '内容库/选题简报/2026-11-01.md': BRIEF.replaceAll(TODAY, '2026-11-01'),
  '内容库/规则/硬规则.md': '# 我的硬规则\n\n- 硬规则一\n- 硬规则二\n',
  '内容库/规则/软规则.md': '# 我的软规则\n\n- 软规则一\n',
}

/** 用注入的本地时间改文件修改时间（周统计看修改时间）。 */
async function setMtime(beer, path, localIso) {
  const when = new Date(localIso)
  await utimes(join(beer.vault, path), when, when)
}

/** 起一个连得上、但没有录音的家里服务。 */
async function emptyHome(t) {
  return startFake(t, { 'GET /recordings': () => ({ recordings: [] }) })
}

test('GET /home：汇总待确认发布、当天简报、本周产出和规则积累', async t => {
  const home = await emptyHome(t)
  const beer = await startBeer(t, {
    vault: VAULT,
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': 'home-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })
  await beer.api('PUT', '/rules/settings', { enabled: true })
  await setMtime(beer, MAIN, '2026-11-02T12:00:00')
  await setMtime(beer, CONFIRMED, '2026-11-03T12:00:00')
  await setMtime(beer, OLD_DRAFT, '2026-10-10T12:00:00')
  await setMtime(beer, PUBLISHED, '2026-11-04T12:00:00')
  await setMtime(beer, DRAFT, '2026-11-05T12:00:00')
  await setMtime(beer, '内容库/素材/随手笔记/index.md', '2026-11-02T12:00:00')

  const res = await beer.api('GET', '/home')

  assert.equal(res.status, 200)
  assert.equal(res.body.date, TODAY)
  assert.deepEqual(res.body.tasks.publishPending, [
    { path: CONFIRMED, title: '待确认', status: '已确认' },
    { path: MAIN, title: '本周成稿', status: '成稿' },
    { path: OLD_DRAFT, title: '旧成稿', status: '成稿' },
  ])
  assert.deepEqual(res.body.tasks.brief, { path: BRIEF_PATH, exists: true, generatedToday: true })
  assert.deepEqual(res.body.tasks.editConflicts, [])
  assert.deepEqual(res.body.recordings, { online: true, processing: [], failedCount: 0 })
  // 本周从周一 2026-11-02 起算：周日的素材不算；没有日期前缀的素材按修改时间算。
  assert.deepEqual(res.body.week, { since: '2026-11-02', materials: 2, drafts: 1, published: 1 })
  assert.deepEqual(res.body.rules, { enabled: true, hard: 2, soft: 1, pending: 0 })
})

/** 家里返回的一条录音视图（字段和 home/README.md 一致）。 */
function recView(over = {}) {
  return {
    id: 'rec-1',
    filename: '周会.m4a',
    status: 'processing',
    progress: 20,
    steps: [
      { key: 'upload', name: '上传', status: 'done' },
      { key: 'queue', name: '排队', status: 'done' },
      { key: 'transcribe', name: '转写', status: 'running' },
      { key: 'summarize', name: '摘要', status: 'pending' },
      { key: 'store', name: '入库', status: 'pending' },
    ],
    ...over,
  }
}

test('GET /home：录音只取处理中 / 失败摘要，并带家里的密钥请求列表', async t => {
  const home = await startFake(t, {
    'GET /recordings': () => ({
      recordings: [
        recView({ id: 'rec-1', filename: '周会.m4a', status: 'processing', progress: 62 }),
        recView({ id: 'rec-2', filename: '课程.m4a', status: 'failed', progress: 40 }),
        recView({ id: 'rec-3', filename: '旧录音.m4a', status: 'stored', progress: 100 }),
        recView({ id: 'rec-4', filename: '就绪.m4a', status: 'ready', progress: 90 }),
      ],
    }),
  })
  const beer = await startBeer(t, {
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': 'home-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const res = await beer.api('GET', '/home')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.recordings, {
    online: true,
    processing: [{ id: 'rec-1', filename: '周会.m4a', progress: 62, step: '转写' }],
    failedCount: 1,
  })
  assert.equal(home.requests.length, 1)
  assert.equal(home.requests[0].method, 'GET')
  assert.equal(home.requests[0].path, '/recordings')
  assert.equal(home.requests[0].headers.authorization, 'Bearer home-key')
})

test('GET /home：家里连不上时 recordings.online=false，接口仍是 200', async t => {
  const beer = await startBeer(t, {
    config: { homeApiBase: await deadUrl(t) },
    secrets: { 'home-api-key': 'home-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const res = await beer.api('GET', '/home')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.recordings, {
    online: false,
    processing: [],
    failedCount: 0,
    error: '家里暂时连不上',
  })
  assert.equal(res.body.date, TODAY)
})

test('编辑冲突：冲突后首页出现，同一文件只留最新一条，保存成功后消失', async t => {
  const path = '内容库/文章/2026-11-02-本周成稿/index.md'
  const beer = await startBeer(t, {
    vault: { [path]: '# 原文\n' },
    config: { homeApiBase: await deadUrl(t) },
    secrets: { 'home-api-key': 'home-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })
  const read = () => beer.api('GET', '/library/file?path=' + encodeURIComponent(path))
  const save = baseVersion => beer.api('PUT', '/library/file', {
    path, content: '# 原文\n\nBeer 里改过\n', baseVersion,
  })

  const first = await read()
  await writeFile(join(beer.vault, path), '# 原文\n\nObsidian 里改过\n')
  const conflicted = await save(first.body.version)
  assert.equal(conflicted.status, 409)

  let home = await beer.api('GET', '/home')
  assert.deepEqual(home.body.tasks.editConflicts, [{ path, detectedAt: '2026-11-06T10:00:00.000Z' }])

  // 再冲突一次：同一路径只保留最新的一条。
  const second = await read()
  await writeFile(join(beer.vault, path), '# 原文\n\nObsidian 又改过\n')
  assert.equal((await save(second.body.version)).status, 409)
  home = await beer.api('GET', '/home')
  assert.equal(home.body.tasks.editConflicts.length, 1)
  assert.equal(home.body.tasks.editConflicts[0].path, path)

  // 读最新版本后保存成功：这条记录被清掉。
  const latest = await read()
  const saved = await save(latest.body.version)
  assert.equal(saved.status, 200)
  assert.equal(await readFile(join(beer.vault, path), 'utf8'), '# 原文\n\nBeer 里改过\n')
  home = await beer.api('GET', '/home')
  assert.deepEqual(home.body.tasks.editConflicts, [])
})

test('GET /home：换了库之后，旧库留下的编辑冲突不再显示', async t => {
  const path = '内容库/文章/2026-11-06-冲突/index.md'
  const beer = await startBeer(t, {
    vault: { [path]: '# 原文\n' },
    config: { homeApiBase: await deadUrl(t) },
    secrets: { 'home-api-key': 'home-key' },
  })
  const first = await beer.api('GET', '/library/file?path=' + encodeURIComponent(path))
  await writeFile(join(beer.vault, path), '# 别处改过\n')
  const res = await beer.api('PUT', '/library/file', { path, content: '# Beer 改\n', baseVersion: first.body.version })
  assert.equal(res.status, 409)
  assert.equal((await beer.api('GET', '/home')).body.tasks.editConflicts.length, 1)

  // 换到另一个库，哪怕里面碰巧有同名路径，也不算这个库的冲突
  const other = await makeTempDir(t, 'beer-vault-2-', { [path]: '# 另一个库\n' })
  assert.equal((await beer.api('PUT', '/vault', { path: other })).status, 200)
  assert.deepEqual((await beer.api('GET', '/home')).body.tasks.editConflicts, [])

  // 换回来，记录还在
  assert.equal((await beer.api('PUT', '/vault', { path: beer.vault })).status, 200)
  assert.equal((await beer.api('GET', '/home')).body.tasks.editConflicts.length, 1)
})

test('POST /home/brief/regenerate：调模型生成当天简报，返回路径、正文和角度并写入文件', async t => {
  const angles = [
    { title: '首页要能一眼看完', why: '待办集中在一处。', materials: ['内容库/素材/2026-11-05-周会'] },
    { title: '录音进度别藏起来', why: '转写要等，进度要能看见。', materials: [] },
  ]
  const model = await startFake(t, {
    [MODEL_PATH]: () => ({ choices: [{ message: { content: JSON.stringify({ angles }) } }] }),
  })
  const beer = await startBeer(t, {
    vault: {
      '内容库/素材/2026-11-05-周会/index.md': material('周会'),
    },
    config: { homeApiBase: await deadUrl(t), opencodeGoBase: model.url },
    secrets: { 'home-api-key': 'home-key', 'opencode-go-api-key': 'go-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const res = await beer.api('POST', '/home/brief/regenerate')

  assert.equal(res.status, 200)
  assert.equal(res.body.path, BRIEF_PATH)
  assert.deepEqual(res.body.angles, angles)
  assert.match(res.body.content, new RegExp(`# ${TODAY} 选题简报`))
  assert.match(res.body.content, /首页要能一眼看完/)
  assert.equal(await readFile(join(beer.vault, BRIEF_PATH), 'utf8'), res.body.content)
  // 简报输入只用库里的素材，带上了日期。
  const sent = model.requests[0].body
  assert.match(JSON.stringify(sent.messages), new RegExp(TODAY))
  // 首页随后看到今天的简报已经生成。
  const home = await beer.api('GET', '/home')
  assert.deepEqual(home.body.tasks.brief, { path: BRIEF_PATH, exists: true, generatedToday: true })
})

test('GET /home：待转正的规则计入规则积累', async t => {
  const articlePath = '内容库/文章/2026-11-06-规则测试/index.md'
  const zhihuPath = '内容库/文章/2026-11-06-规则测试/知乎.md'
  const rule = '开头要直接给结论'
  const model = await startFake(t, {
    [MODEL_PATH]: (_req, body) => {
      const system = String(body?.messages?.[0]?.content ?? '')
      if (system.includes('写作规则归纳')) {
        return { choices: [{ message: { content: JSON.stringify({ rules: [{ rule, evidence: '补了结论' }] }) } }] }
      }
      return { choices: [{ message: { content: '知乎改写版\n\n这是给知乎的正文。' } }] }
    },
  })
  const beer = await startBeer(t, {
    vault: { [articlePath]: note('规则测试', '成稿', '2026-11-06', '第一段正文。') },
    config: { homeApiBase: await deadUrl(t), opencodeGoBase: model.url },
    secrets: { 'home-api-key': 'home-key', 'opencode-go-api-key': 'go-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })
  await beer.api('PUT', '/rules/settings', { enabled: true })
  const generated = await beer.api('POST', '/articles/versions/generate', { path: articlePath, platforms: ['知乎'] })
  assert.equal(generated.status, 200)

  // 用户在 Obsidian 里改过知乎版，观察三次后这条规则进入待转正。
  await writeFile(join(beer.vault, zhihuPath), (await readFile(join(beer.vault, zhihuPath), 'utf8')) + '\n补了一句结论。\n')
  for (let i = 0; i < 3; i++) {
    assert.equal((await beer.api('POST', '/rules/observe', { path: zhihuPath, platform: '知乎' })).status, 200)
  }

  const home = await beer.api('GET', '/home')

  assert.equal(home.status, 200)
  assert.deepEqual(home.body.rules, { enabled: true, hard: 0, soft: 0, pending: 1 })
})

test('GET /home：今天还没有选题简报时 exists 和 generatedToday 都是 false，路径仍是今天', async t => {
  const home = await emptyHome(t)
  const beer = await startBeer(t, {
    vault: { '内容库/选题简报/2026-11-05.md': BRIEF.replaceAll(TODAY, '2026-11-05') },
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': 'home-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const res = await beer.api('GET', '/home')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.tasks.brief, { path: BRIEF_PATH, exists: false, generatedToday: false })
  assert.deepEqual(res.body.tasks.publishPending, [])
  assert.deepEqual(res.body.tasks.editConflicts, [])
  assert.deepEqual(res.body.week, { since: '2026-11-02', materials: 0, drafts: 0, published: 0 })
  assert.deepEqual(res.body.rules, { enabled: false, hard: 0, soft: 0, pending: 0 })
})

test('GET /home?ensure=1：今天没有简报时生成一次并写文件，同一天再打开不重复调模型', async t => {
  const model = await startFake(t, {
    [MODEL_PATH]: () => ({
      choices: [{ message: { content: JSON.stringify({ angles: [{ title: '首页要自动出简报', why: '每天第一次打开就该有。', materials: [] }] }) } }],
    }),
  })
  const home = await emptyHome(t)
  const beer = await startBeer(t, {
    vault: {},
    config: { homeApiBase: home.url, opencodeGoBase: model.url },
    secrets: { 'home-api-key': 'home-key', 'opencode-go-api-key': 'go-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const first = await beer.api('GET', '/home?ensure=1')

  assert.equal(first.status, 200)
  assert.deepEqual(first.body.tasks.brief, { path: BRIEF_PATH, exists: true, generatedToday: true })
  assert.match(await readFile(join(beer.vault, BRIEF_PATH), 'utf8'), /首页要自动出简报/)
  assert.equal(model.requests.length, 1)

  const second = await beer.api('GET', '/home?ensure=1')

  assert.equal(second.status, 200)
  assert.deepEqual(second.body.tasks.brief, { path: BRIEF_PATH, exists: true, generatedToday: true })
  assert.equal(model.requests.length, 1, '同一天文件已存在时不再调模型')
  // 首页其余部分照常返回。
  assert.deepEqual(second.body.tasks.publishPending, [])
  assert.equal(second.body.date, TODAY)
})

test('GET /home?ensure=1：模型失败时首页仍 200，tasks.brief 带 error，不写半成品', async t => {
  const model = await startFake(t, {
    [MODEL_PATH]: () => ({ status: 500, body: { error: 'boom' } }),
  })
  const home = await emptyHome(t)
  const beer = await startBeer(t, {
    vault: {},
    config: { homeApiBase: home.url, opencodeGoBase: model.url },
    secrets: { 'home-api-key': 'home-key', 'opencode-go-api-key': 'go-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const res = await beer.api('GET', '/home?ensure=1')

  assert.equal(res.status, 200)
  assert.equal(res.body.date, TODAY)
  assert.equal(res.body.tasks.brief.path, BRIEF_PATH)
  assert.equal(res.body.tasks.brief.exists, false)
  assert.equal(res.body.tasks.brief.generatedToday, false)
  assert.equal(typeof res.body.tasks.brief.error, 'string')
  assert.match(res.body.tasks.brief.error, /返回 500/)
  assert.deepEqual(await listFiles(beer.vault), [], '生成失败不能写简报文件')
  // 其他汇总照常可读。
  assert.deepEqual(res.body.tasks.publishPending, [])
  assert.equal(res.body.recordings.online, true)
})
