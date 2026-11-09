// 录音分页的接口测试（#19）：上传转发、列表 / 单条转发、sync 写入素材、顶栏机器状态。
// 家里服务一律用 startFake 代替，只断言 Beer 的返回、库里的文件、发给假家里的请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles, PREFIX } from './helpers/beer.js'

const HOME_KEY = 'home-key-1'

/** 家里服务返回的录音视图（和 home/README.md 的字段一致，另含 #19 加的 original_path）。 */
function recView(over = {}) {
  return {
    id: 'rec-1',
    filename: '周会.m4a',
    status: 'processing',
    steps: [
      { key: 'upload', name: '上传', status: 'done' },
      { key: 'queue', name: '排队', status: 'running' },
      { key: 'transcribe', name: '转写', status: 'pending' },
      { key: 'summarize', name: '摘要', status: 'pending' },
      { key: 'store', name: '入库', status: 'pending' },
    ],
    progress: 20,
    error_code: null,
    error: null,
    created_at: '2026-11-05T02:00:00+00:00',
    updated_at: '2026-11-05T02:00:10+00:00',
    original_path: '/Volumes/NAS/录音原件/rec-1/周会.m4a',
    ...over,
  }
}

/** 用 multipart 把一段音频交给 Beer（和面板里的拖入上传走同一条路）。 */
async function upload(beer, bytes, filename = 'meeting.m4a') {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/mp4' }), filename)
  const res = await fetch(beer.url + PREFIX + '/recordings', { method: 'POST', body: form })
  const text = await res.text()
  let body = text
  try { body = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, body }
}

/** 1 MiB 以上的测试音频：内容可辨认，末尾一段特征字节，用来核对转发是否完整。 */
function bigAudio(size = 1024 * 1024 + 4096) {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251
  const tail = Buffer.from('BEER-RECORDING-TAIL-0123456789', 'ascii')
  tail.copy(bytes, size - tail.length)
  return bytes
}

test('上传：把 multipart 原文和 Bearer 密钥转给家里，返回家里的录音视图', async t => {
  const home = await startFake(t, { 'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-9', filename: 'meeting.m4a' }) }) })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await upload(beer, Buffer.from('fake-audio-bytes'), 'meeting.m4a')

  assert.equal(res.status, 201)
  assert.equal(res.body.id, 'rec-9')
  assert.equal(res.body.status, 'processing')
  assert.deepEqual(res.body.steps.map(s => [s.key, s.status]), [
    ['upload', 'done'], ['queue', 'running'], ['transcribe', 'pending'], ['summarize', 'pending'], ['store', 'pending'],
  ])
  assert.equal(home.requests.length, 1)
  const sent = home.requests[0]
  assert.equal(sent.method, 'POST')
  assert.equal(sent.path, '/recordings')
  assert.equal(sent.headers.authorization, `Bearer ${HOME_KEY}`)
  assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.match(sent.raw.toString('utf8'), /name="file"; filename="meeting.m4a"/)
  assert.ok(sent.raw.includes(Buffer.from('fake-audio-bytes')), 'multipart 里的文件内容应原样到达')
})

test('上传：1 MiB 以上的文件完整转发，不截断', async t => {
  const home = await startFake(t, { 'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-big', filename: 'big.m4a' }) }) })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const audio = bigAudio()

  const res = await upload(beer, audio, 'big.m4a')

  assert.equal(res.status, 201)
  const sent = home.requests[0]
  assert.equal(sent.headers['content-length'], String(sent.raw.length))
  assert.ok(sent.raw.length >= audio.length)
  assert.notEqual(sent.raw.indexOf(audio), -1, '1 MiB 的录音内容应完整出现在转发的 multipart 里')
})

test('上传：家里连不上时直接返回「家里暂时连不上」，库和数据目录里都不留下排队文件', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })
  const beforeData = await listFiles(beer.dataDir)

  const res = await upload(beer, Buffer.from('audio'), 'meeting.m4a')

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.match(res.body.error.message, /家里暂时连不上/)
  assert.deepEqual(await listFiles(beer.vault), [])
  assert.deepEqual(await listFiles(beer.dataDir), beforeData)
})

test('上传：家里返回 503 ORIGINALS_UNAVAILABLE 时按原状态码和错误码透传', async t => {
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 503, body: { detail: '录音原件路径不可用', error_code: 'ORIGINALS_UNAVAILABLE' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await upload(beer, Buffer.from('audio'), 'meeting.m4a')

  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'ORIGINALS_UNAVAILABLE')
  assert.equal(res.body.error.message, '录音原件路径不可用')
})

test('上传：不是 multipart 的请求在本地就拒绝，不打扰家里', async t => {
  const home = await startFake(t, { 'POST /recordings': () => ({ status: 201, body: recView() }) })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await fetch(beer.url + PREFIX + '/recordings', { method: 'POST', body: 'not multipart' })

  assert.equal(res.status, 400)
  assert.equal(home.requests.length, 0)
})

test('列表：转发 status 过滤并原样返回家里的录音列表', async t => {
  const home = await startFake(t, {
    'GET /recordings': () => ({ recordings: [recView({ id: 'rec-1' }), recView({ id: 'rec-2', status: 'ready' })] }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('GET', '/recordings?status=ready')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.recordings.map(r => [r.id, r.status]), [['rec-1', 'processing'], ['rec-2', 'ready']])
  assert.equal(home.requests[0].path, '/recordings?status=ready')
  assert.equal(home.requests[0].headers.authorization, `Bearer ${HOME_KEY}`)
})

test('列表：家里连不上时返回明确错误，库里不新增任何东西', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('GET', '/recordings')

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.match(res.body.error.message, /家里暂时连不上/)
  assert.deepEqual(await listFiles(beer.vault), [])
})

test('单条和重试：原样转发，家里的 409 NOT_FAILED 按原状态码和错误码透传', async t => {
  const home = await startFake(t, {
    'GET /recordings/rec-1': () => recView({ id: 'rec-1', status: 'failed', error_code: 'CHUNK_FAILED', error: '分块失败' }),
    'POST /recordings/rec-1/retry': () => ({ status: 409, body: { detail: '这条录音没有失败的步骤', error_code: 'NOT_FAILED' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const one = await beer.api('GET', '/recordings/rec-1')
  assert.equal(one.status, 200)
  assert.equal(one.body.error_code, 'CHUNK_FAILED')

  const retry = await beer.api('POST', '/recordings/rec-1/retry')
  assert.equal(retry.status, 409)
  assert.equal(retry.body.error.code, 'NOT_FAILED')
  assert.equal(retry.body.error.message, '这条录音没有失败的步骤')
  assert.deepEqual(home.requests.map(r => `${r.method} ${r.path}`), ['GET /recordings/rec-1', 'POST /recordings/rec-1/retry'])
})

test('机器状态：转发家里 /health 的三台机器在线状态', async t => {
  const home = await startFake(t, {
    'GET /health': () => ({
      status: 'ok',
      machines: { mac_mini: { online: true }, windows: { online: true }, nas: { online: false } },
    }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('GET', '/machines')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    online: true,
    machines: { mac_mini: { online: true }, windows: { online: true }, nas: { online: false } },
  })
  assert.equal(home.requests[0].headers.authorization, `Bearer ${HOME_KEY}`)
})

test('机器状态：家里连不上时返回 online: false 和「家里暂时连不上」', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('GET', '/machines')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { online: false, error: '家里暂时连不上' })
})

test('文字稿：家里还没好时 409 NOT_READY 按原状态码和错误码透传', async t => {
  const home = await startFake(t, {
    'GET /recordings/rec-1/transcript': () => ({ status: 409, body: { detail: '转写结果还没好', error_code: 'NOT_READY' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('GET', '/recordings/rec-1/transcript')

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'NOT_READY')
  assert.equal(res.body.error.message, '转写结果还没好')
})

test('重新总结：把类型转发到家里 /resummarize，返回家里的录音视图', async t => {
  const home = await startFake(t, {
    'POST /recordings/rec-1/resummarize': (_req, body) => recView({
      id: 'rec-1', status: 'ready', summary_type: body.type, summary: '## 原话\n\n记下来。',
    }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('POST', '/recordings/rec-1/summarize', { type: '口述灵感' })

  assert.equal(res.status, 200)
  assert.equal(res.body.summary_type, '口述灵感')
  assert.equal(res.body.summary, '## 原话\n\n记下来。')
  assert.equal(home.requests.length, 1)
  assert.equal(home.requests[0].method, 'POST')
  assert.equal(home.requests[0].path, '/recordings/rec-1/resummarize')
  assert.equal(home.requests[0].headers.authorization, `Bearer ${HOME_KEY}`)
  assert.match(home.requests[0].headers['content-type'], /^application\/json/)
  assert.deepEqual(home.requests[0].body, { type: '口述灵感' })
})

test('重新总结：家里的 400 TYPE_INVALID 和 409 NOT_READY 按原状态码和错误码透传', async t => {
  const home = await startFake(t, {
    'POST /recordings/rec-1/resummarize': (_req, body) => (body.type === '会议'
      ? { status: 409, body: { detail: '转写结果还没好', error_code: 'NOT_READY' } }
      : { status: 400, body: { detail: 'type 只能是 会议 / 口述灵感 / 课程讲座', error_code: 'TYPE_INVALID' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const badType = await beer.api('POST', '/recordings/rec-1/summarize', { type: '访谈' })
  assert.equal(badType.status, 400)
  assert.equal(badType.body.error.code, 'TYPE_INVALID')

  const notReady = await beer.api('POST', '/recordings/rec-1/summarize', { type: '会议' })
  assert.equal(notReady.status, 409)
  assert.equal(notReady.body.error.code, 'NOT_READY')
})

test('重新总结：家里连不上时返回 home_unreachable', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('POST', '/recordings/rec-1/summarize', { type: '会议' })

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.match(res.body.error.message, /家里暂时连不上/)
})

// ---- 重新总结后同步已入库的素材条目 ----

const SUMMARY_ENTRY = '内容库/素材/2026-11-05-周会'
const SUMMARY_INDEX = SUMMARY_ENTRY + '/index.md'
const ORIGINAL_TRANSCRIPT = '# 周会\n\n[00:01] 原文字稿，不能动。\n'
const ORIGINAL_SRT = '1\n00:00:01,000 --> 00:00:03,000\n原文字稿，不能动。\n'
const ORIGINAL_INDEX = [
  '---',
  '类型: 会议',
  '状态: 待整理',
  '来源: 录音',
  '原件: /Volumes/NAS/录音原件/rec-1/周会.m4a',
  '录音编号: rec-1',
  '日期: 2026-11-05',
  '---',
  '',
  '旧摘要',
  '',
].join('\n')

/** 假家里：按指定类型 / 摘要重新总结。 */
async function startResummarizeHome(t, { summary_type, summary }) {
  return startFake(t, {
    'POST /recordings/rec-1/resummarize': () => recView({ id: 'rec-1', status: 'ready', summary_type, summary }),
  })
}

test('重新总结：已入库的素材条目同步类型和摘要，文字稿和 srt 一个字节都不动', async t => {
  const home = await startResummarizeHome(t, { summary_type: '口述灵感', summary: '## 新摘要\n\n新的内容。' })
  const beer = await startBeer(t, {
    vault: {
      [SUMMARY_INDEX]: ORIGINAL_INDEX,
      [SUMMARY_ENTRY + '/transcript.md']: ORIGINAL_TRANSCRIPT,
      [SUMMARY_ENTRY + '/transcript.srt']: ORIGINAL_SRT,
    },
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
  })

  const res = await beer.api('POST', '/recordings/rec-1/summarize', { type: '口述灵感' })

  assert.equal(res.status, 200)
  assert.equal(res.body.summary_type, '口述灵感')
  assert.equal(res.body.entryUpdated, SUMMARY_INDEX)
  assert.equal(await readFile(join(beer.vault, SUMMARY_INDEX), 'utf8'), [
    '---',
    '类型: 口述灵感',
    '状态: 待整理',
    '来源: 录音',
    '原件: /Volumes/NAS/录音原件/rec-1/周会.m4a',
    '录音编号: rec-1',
    '日期: 2026-11-05',
    '---',
    '',
    '## 新摘要',
    '',
    '新的内容。',
    '',
  ].join('\n'))
  // 文字稿和字幕完全不动。
  assert.equal(await readFile(join(beer.vault, SUMMARY_ENTRY, 'transcript.md'), 'utf8'), ORIGINAL_TRANSCRIPT)
  assert.equal(await readFile(join(beer.vault, SUMMARY_ENTRY, 'transcript.srt'), 'utf8'), ORIGINAL_SRT)
})

test('重新总结：没入库的录音只返回家里结果，不新建素材条目', async t => {
  const home = await startResummarizeHome(t, { summary_type: '会议', summary: '新的摘要。' })
  const beer = await startBeer(t, {
    vault: {},
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
  })

  const res = await beer.api('POST', '/recordings/rec-1/summarize', { type: '会议' })

  assert.equal(res.status, 200)
  assert.equal(res.body.entryUpdated, null)
  assert.equal(res.body.summary, '新的摘要。')
  assert.deepEqual(await listFiles(beer.vault), [], '不该为没入库的录音建条目')
})

// ---- 取回并写入素材 ----

const ENTRY = '内容库/素材/2026-11-05-周会'
const MARKDOWN = '# 周会\n\n说话人 1：今天讨论录音分页。\n'
const SRT = '1\n00:00:01,000 --> 00:00:03,000\n今天讨论录音分页。\n'

/** 一个「结果就绪、等 Beer 取回」的录音视图。 */
function readyView(over = {}) {
  return recView({
    id: 'rec-1',
    filename: '周会.m4a',
    status: 'ready',
    steps: [
      { key: 'upload', name: '上传', status: 'done' },
      { key: 'queue', name: '排队', status: 'done' },
      { key: 'transcribe', name: '转写', status: 'done' },
      { key: 'summarize', name: '摘要', status: 'done' },
      { key: 'store', name: '入库', status: 'pending' },
    ],
    progress: 100,
    ...over,
  })
}

/** 假家里：ready 列表 + 若干条文字稿 + stored 确认，记录收到的请求。 */
async function startReadyHome(t, recordings, transcripts) {
  const routes = {
    'GET /recordings': () => ({ recordings }),
  }
  for (const [id, transcript] of Object.entries(transcripts)) {
    routes[`GET /recordings/${id}/transcript`] = () => transcript
    routes[`POST /recordings/${id}/stored`] = () => recView({ id, status: 'stored' })
  }
  return startFake(t, routes)
}

// 取回时间固定，素材条目的日期就固定（日期按取回当天，本机时区）。
const NOW = () => new Date(2026, 10, 5, 12, 0, 0)

test('取回：把 ready 的录音写成素材条目（开头属性、文字稿、字幕），并向家里确认入库', async t => {
  const home = await startReadyHome(t, [readyView()], {
    'rec-1': { id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: SRT, summary: null },
  })
  const beer = await startBeer(t, {
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
    now: NOW,
  })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    imported: [{ id: 'rec-1', filename: '周会.m4a', path: ENTRY }],
    skipped: [],
  })
  assert.deepEqual(await listFiles(beer.vault), [
    `${ENTRY}/index.md`,
    `${ENTRY}/transcript.md`,
    `${ENTRY}/transcript.srt`,
  ])
  assert.equal(await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8'), [
    '---',
    '标题: 周会',
    '类型: 未知',
    '状态: 待整理',
    '来源: 录音',
    '原件: /Volumes/NAS/录音原件/rec-1/周会.m4a',
    '录音编号: rec-1',
    '日期: 2026-11-05',
    '---',
    '',
    '摘要待生成',
    '',
  ].join('\n'))
  assert.equal(await readFile(join(beer.vault, ENTRY, 'transcript.md'), 'utf8'), MARKDOWN)
  assert.equal(await readFile(join(beer.vault, ENTRY, 'transcript.srt'), 'utf8'), SRT)

  const toHome = home.requests.map(r => `${r.method} ${r.path}`)
  assert.deepEqual(toHome, [
    'GET /recordings?status=ready',
    'GET /recordings/rec-1/transcript',
    'POST /recordings/rec-1/stored',
  ])
  assert.ok(home.requests.every(r => r.headers.authorization === `Bearer ${HOME_KEY}`))
})

test('取回：摘要和类型有值时写进条目正文和「类型」属性', async t => {
  const home = await startReadyHome(t, [readyView({ summary_type: '会议' })], {
    'rec-1': { id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: SRT, summary: '结论：录音分页开始做了。', summary_type: '会议' },
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY }, now: NOW })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  const index = await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8')
  assert.match(index, /^类型: 会议$/m)
  assert.match(index, /结论：录音分页开始做了。/)
})

test('取回：重复 sync 不重复写、不覆盖已有条目，只补一次入库确认', async t => {
  const home = await startReadyHome(t, [readyView()], {
    'rec-1': { id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: SRT, summary: null },
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY }, now: NOW })
  assert.equal((await beer.api('POST', '/recordings/sync')).status, 200)
  const before = await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8')
  // 用户在 Obsidian 里改过这个条目：再次 sync 不能覆盖。
  await writeFile(join(beer.vault, ENTRY, 'index.md'), before + '\n我加的一段\n')

  const again = await beer.api('POST', '/recordings/sync')

  assert.equal(again.status, 200)
  assert.deepEqual(again.body, {
    imported: [],
    skipped: [{ id: 'rec-1', filename: '周会.m4a', path: ENTRY }],
  })
  assert.deepEqual(await listFiles(beer.vault), [
    `${ENTRY}/index.md`,
    `${ENTRY}/transcript.md`,
    `${ENTRY}/transcript.srt`,
  ])
  assert.equal(await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8'), before + '\n我加的一段\n')
  assert.equal(home.requests.filter(r => r.method === 'POST' && r.path === '/recordings/rec-1/stored').length, 2)
})

test('取回：已经写过的条目（录音编号 对得上）不重写，即使条目结构被改过', async t => {
  const home = await startReadyHome(t, [readyView()], {
    'rec-1': { id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: SRT, summary: null },
  })
  const beer = await startBeer(t, {
    vault: { [`${ENTRY}/index.md`]: '---\n录音编号: rec-1\n---\n\n我自己的版本\n' },
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
    now: NOW,
  })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.skipped, [{ id: 'rec-1', filename: '周会.m4a', path: ENTRY }])
  assert.equal(await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8'), '---\n录音编号: rec-1\n---\n\n我自己的版本\n')
  assert.deepEqual(await listFiles(beer.vault), [`${ENTRY}/index.md`])
})

test('取回：同日同名的录音避让成 -2、-3，文件名里的不安全字符被去掉', async t => {
  const recordings = [
    readyView({ id: 'rec-a', filename: '周会.m4a' }),
    readyView({ id: 'rec-b', filename: '周会.m4a' }),
    readyView({ id: 'rec-c', filename: '会议:录音?.m4a' }),
    readyView({ id: 'rec-d', filename: '?.m4a' }),
  ]
  const transcripts = {}
  for (const r of recordings) transcripts[r.id] = { id: r.id, filename: r.filename, markdown: `# ${r.id}\n`, srt: '', summary: null }
  const home = await startReadyHome(t, recordings, transcripts)
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY }, now: NOW })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.imported.map(e => e.path), [
    '内容库/素材/2026-11-05-周会',
    '内容库/素材/2026-11-05-周会-2',
    '内容库/素材/2026-11-05-会议录音',
    '内容库/素材/2026-11-05-录音',
  ])
  for (const [path, id] of [
    ['内容库/素材/2026-11-05-周会', 'rec-a'],
    ['内容库/素材/2026-11-05-周会-2', 'rec-b'],
  ]) {
    assert.match(await readFile(join(beer.vault, path, 'index.md'), 'utf8'), new RegExp(`^录音编号: ${id}$`, 'm'))
  }
})

test('取回：已有同名文件夹但没有相同录音编号时，新条目用 -2，不碰原文件夹', async t => {
  const home = await startReadyHome(t, [readyView()], {
    'rec-1': { id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: SRT, summary: null },
  })
  const beer = await startBeer(t, {
    vault: { [`${ENTRY}/index.md`]: '# 别人的周会\n' },
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
    now: NOW,
  })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.imported.map(e => e.path), ['内容库/素材/2026-11-05-周会-2'])
  assert.equal(await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8'), '# 别人的周会\n')
})

test('取回：文字稿还没好（409 NOT_READY）的那条跳过，不写半成品条目，其他照常', async t => {
  const recordings = [readyView({ id: 'rec-a' }), readyView({ id: 'rec-b', filename: '第二个.m4a' })]
  const home = await startFake(t, {
    'GET /recordings': () => ({ recordings }),
    'GET /recordings/rec-a/transcript': () => ({ status: 409, body: { detail: '转写结果还没好', error_code: 'NOT_READY' } }),
    'GET /recordings/rec-b/transcript': () => ({ id: 'rec-b', filename: '第二个.m4a', markdown: '# b\n', srt: '', summary: null }),
    'POST /recordings/rec-b/stored': () => recView({ id: 'rec-b', status: 'stored' }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY }, now: NOW })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.imported.map(e => e.id), ['rec-b'])
  assert.deepEqual(res.body.skipped, [{ id: 'rec-a', filename: '周会.m4a', reason: 'NOT_READY' }])
  assert.deepEqual(await listFiles(beer.vault), ['内容库/素材/2026-11-05-第二个/index.md', '内容库/素材/2026-11-05-第二个/transcript.md', '内容库/素材/2026-11-05-第二个/transcript.srt'])
})

test('取回：家里连不上时返回 home_unreachable，库里什么都不写', async t => {
  const beer = await startBeer(t, {
    config: { homeApiBase: await deadUrl(t) },
    secrets: { 'home-api-key': HOME_KEY },
    now: NOW,
  })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.deepEqual(await listFiles(beer.vault), [])
})

test('取回：打开列表时带 sync=1 会先取回一次，30 秒内不重复', async t => {
  const home = await startReadyHome(t, [readyView()], {
    'rec-1': { id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: SRT, summary: null },
  })
  let clock = new Date(2026, 10, 5, 12, 0, 0)
  const beer = await startBeer(t, {
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
    now: () => clock,
  })
  const readyCalls = () => home.requests.filter(r => r.path === '/recordings?status=ready').length

  await beer.api('GET', '/recordings?sync=1')
  assert.equal(readyCalls(), 1)
  assert.deepEqual(await listFiles(beer.vault), [
    `${ENTRY}/index.md`,
    `${ENTRY}/transcript.md`,
    `${ENTRY}/transcript.srt`,
  ])

  clock = new Date(2026, 10, 5, 12, 0, 10)
  await beer.api('GET', '/recordings?sync=1')
  assert.equal(readyCalls(), 1, '30 秒内不应重复取回')

  clock = new Date(2026, 10, 5, 12, 0, 41)
  await beer.api('GET', '/recordings?sync=1')
  assert.equal(readyCalls(), 2, '超过 30 秒后再取回一次')
  assert.deepEqual((await beer.api('POST', '/recordings/sync')).body.imported, [])
})

test('钥匙串里没有家里的访问密钥时不向家里发请求，明确提示', async t => {
  const home = await startFake(t, { 'GET /recordings': () => ({ recordings: [] }) })
  const beer = await startBeer(t, { config: { homeApiBase: home.url } })

  const res = await beer.api('GET', '/recordings')

  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'home_no_key')
  assert.match(res.body.error.message, /home-api-key/)
  assert.equal(home.requests.length, 0)
})

// ---- 删除失败的录音（#30） ----

const cachedAudio = async beer => (await listFiles(join(beer.dataDir, 'audio-cache'))).filter(f => !f.endsWith('.json'))

test('删除：转发给家里 DELETE，成功后清掉本机音频缓存里这一条', async t => {
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-del', filename: '烟测.wav' }) }),
    'DELETE /recordings/rec-del': () => ({ status: 204, body: undefined }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  assert.equal((await upload(beer, Buffer.from('fake-audio-bytes'), '烟测.wav')).status, 201)
  assert.equal((await cachedAudio(beer)).length, 1, '上传后本机应留一份缓存')

  const res = await beer.api('DELETE', '/recordings/rec-del')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { deleted: true, id: 'rec-del', cacheCleared: true })
  assert.deepEqual(await cachedAudio(beer), [])
  const index = JSON.parse(await readFile(join(beer.dataDir, 'audio-cache', 'audio-cache.json'), 'utf8'))
  assert.deepEqual(index.entries.filter(e => e.id === 'rec-del'), [])
  const sent = home.requests.at(-1)
  assert.equal(`${sent.method} ${sent.path}`, 'DELETE /recordings/rec-del')
  assert.equal(sent.headers.authorization, `Bearer ${HOME_KEY}`)
})

test('删除：家里 404 / 409 按原状态码和错误码透传，本机缓存不动', async t => {
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-ok', filename: '周会.m4a' }) }),
    'DELETE /recordings/rec-ok': () => ({ status: 409, body: { detail: '只能删除失败的录音', error_code: 'NOT_FAILED' } }),
    'DELETE /recordings/nope': () => ({ status: 404, body: { detail: '没有这条录音', error_code: 'NOT_FOUND' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  await upload(beer, Buffer.from('fake-audio-bytes'), '周会.m4a')

  const busy = await beer.api('DELETE', '/recordings/rec-ok')
  assert.equal(busy.status, 409)
  assert.equal(busy.body.error.code, 'NOT_FAILED')
  assert.equal(busy.body.error.message, '只能删除失败的录音')
  assert.equal((await cachedAudio(beer)).length, 1, '家里拒绝删除时缓存要留着')

  const missing = await beer.api('DELETE', '/recordings/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'NOT_FOUND')
})

test('删除：家里连不上时返回「家里暂时连不上」', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await beer.api('DELETE', '/recordings/rec-1')

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.match(res.body.error.message, /家里暂时连不上/)
})
