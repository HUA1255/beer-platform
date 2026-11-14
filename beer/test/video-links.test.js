// 视频链接转录（#34）：B 站 / YouTube 链接交给家里 POST /videos，取回时写成「视频」条目。
// 家里服务一律用 startFake 代替，只断言 Beer 的返回、库里的文件、发给假家里的请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles } from './helpers/beer.js'
import { createSaveMaterialTool, saveMaterial } from '../src/modules/material-import.js'

const HOME_KEY = 'home-key-1'
const BILI = 'https://www.bilibili.com/video/BV1xx411c7mD'
const NOW = () => new Date(2026, 10, 11, 12, 0, 0)
const ENTRY = '内容库/素材/2026-11-11-十分钟讲清 AI 工作流'
const MARKDOWN = '# 十分钟讲清 AI 工作流\n\n大家好，今天聊 AI 工作流。\n'
const SRT = '1\n00:00:00,000 --> 00:00:02,000\n大家好，今天聊 AI 工作流。\n'

function steps(status = {}) {
  return [
    { key: 'upload', name: '提交链接', status: 'done' },
    { key: 'queue', name: '排队', status: status.queue ?? 'pending' },
    { key: 'transcribe', name: '转写', status: status.transcribe ?? 'pending' },
    { key: 'summarize', name: '摘要', status: status.summarize ?? 'pending' },
    { key: 'store', name: '入库', status: 'pending' },
  ]
}

function videoView(over = {}) {
  return {
    id: 'vid-1',
    kind: 'video',
    filename: BILI,
    title: BILI,
    source_url: BILI,
    author: null,
    duration_ms: null,
    text_source: null,
    original_path: null,
    status: 'processing',
    steps: steps(),
    progress: 0,
    error_code: null,
    error: null,
    summary: null,
    summary_type: null,
    ...over,
  }
}

function readyVideo(over = {}) {
  return videoView({
    status: 'ready',
    title: '十分钟讲清 AI 工作流',
    author: '测试 UP 主',
    duration_ms: 615000,
    text_source: 'platform_manual',
    steps: steps({ queue: 'done', transcribe: 'done', summarize: 'done' }),
    progress: 100,
    summary_type: '视频',
    ...over,
  })
}

const TRANSCRIPT = {
  id: 'vid-1',
  kind: 'video',
  filename: BILI,
  title: '十分钟讲清 AI 工作流',
  source_url: BILI,
  markdown: MARKDOWN,
  srt: SRT,
  summary: '## 一句话概括\n\n讲 AI 工作流。',
  summary_type: '视频',
  source: { type: 'url', url: BILI, title: '十分钟讲清 AI 工作流', author: '测试 UP 主', duration_ms: 615000, text_source: 'platform_manual' },
}

function homeWithVideos(t, extra = {}) {
  return startFake(t, {
    'POST /videos': (_req, body) => ({ status: 201, body: videoView({ source_url: body?.url, filename: body?.url, title: body?.url }) }),
    ...extra,
  })
}

// ---- 提交 ----

test('导入链接：B 站链接交给家里 POST /videos，返回 202 和家里的视图，库里不写条目、不抓页面', async t => {
  const home = await homeWithVideos(t)
  let fetched = 0
  const beer = await startBeer(t, {
    vault: {},
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
    fetch: (...args) => { if (!String(args[0]).startsWith(home.url)) fetched += 1; return fetch(...args) },
  })

  const res = await beer.api('POST', '/materials/import/url', { url: BILI, tags: ['AI 工具'] })

  assert.equal(res.status, 202)
  assert.equal(res.body.video.id, 'vid-1')
  assert.equal(res.body.video.kind, 'video')
  assert.equal(fetched, 0, '不该去抓视频页面')
  assert.deepEqual(home.requests.map(r => `${r.method} ${r.path}`), ['POST /videos'])
  assert.deepEqual(home.requests[0].body, { url: BILI })
  assert.equal(home.requests[0].headers.authorization, `Bearer ${HOME_KEY}`)
  assert.deepEqual(await listFiles(beer.vault), [])
})

test('导入链接：YouTube（youtu.be）也交给家里', async t => {
  const home = await homeWithVideos(t)
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const res = await beer.api('POST', '/materials/import/url', { url: 'https://youtu.be/abc123' })
  assert.equal(res.status, 202)
  assert.deepEqual(home.requests[0].body, { url: 'https://youtu.be/abc123' })
})

test('导入链接：家里连不上时 502「家里暂时连不上」，不排队、库里不写东西', async t => {
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })
  const res = await beer.api('POST', '/materials/import/url', { url: BILI })
  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.match(res.body.error.message, /家里暂时连不上/)
  assert.deepEqual(await listFiles(beer.vault), [])
})

test('导入链接：家里拒绝的链接按原状态码和错误码透传', async t => {
  const home = await startFake(t, {
    'POST /videos': () => ({ status: 400, body: { detail: '只支持 B 站和 YouTube 的视频链接', error_code: 'UNSUPPORTED_URL' } }),
  })
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const res = await beer.api('POST', '/materials/import/url', { url: BILI })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'UNSUPPORTED_URL')
})

test('AI 工具：B 站链接（不填类型或填「链接」「视频」）都提交给家里，返回去录音分页看进度的说明', async t => {
  const home = await homeWithVideos(t)
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  for (const type of [undefined, '链接', '视频']) {
    const saved = await saveMaterial(beer.context, { title: '一个视频', url: BILI, type })
    assert.equal(saved.video.id, 'vid-1')
  }
  assert.equal(home.requests.filter(r => r.path === '/videos').length, 3)

  const tool = createSaveMaterialTool(config => config, beer.context)
  const text = await tool.execute({ title: '一个视频', url: BILI }, {})
  assert.match(text, /已把视频交给家里转写/)
  assert.match(text, /录音分页/)
  assert.match(text, /「视频」/)
  assert.deepEqual(await listFiles(beer.vault), [])
})

test('AI 工具：「视频」类型配其他站的链接被拒，不打扰家里', async t => {
  const home = await homeWithVideos(t)
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  await assert.rejects(
    () => saveMaterial(beer.context, { title: '别的站', url: 'https://vimeo.com/1', type: '视频' }),
    e => e.code === 'url_invalid' && /B 站或 YouTube/.test(e.message),
  )
  assert.equal(home.requests.length, 0)
})

test('AI 工具：家里连不上时报「家里暂时连不上」', async t => {
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })
  await assert.rejects(
    () => saveMaterial(beer.context, { title: '一个视频', url: BILI }),
    e => /家里暂时连不上/.test(e.message),
  )
})

// ---- 取回 ----

function readyHome(t, view = readyVideo(), transcript = TRANSCRIPT) {
  return startFake(t, {
    'GET /recordings': () => ({ recordings: [view] }),
    'GET /recordings/vid-1/transcript': () => transcript,
    'POST /recordings/vid-1/stored': () => ({ ...view, status: 'stored' }),
  })
}

test('取回：视频写成「视频」条目，来源是原链接，带作者、时长、文字来源，正文是摘要，另有全文和字幕', async t => {
  const home = await readyHome(t)
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY }, now: NOW })

  const res = await beer.api('POST', '/recordings/sync')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.imported, [{ id: 'vid-1', filename: BILI, path: ENTRY }])
  assert.deepEqual(await listFiles(beer.vault), [`${ENTRY}/index.md`, `${ENTRY}/transcript.md`, `${ENTRY}/transcript.srt`])
  assert.equal(await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8'), [
    '---',
    '标题: 十分钟讲清 AI 工作流',
    '类型: 视频',
    '摘要类型: 视频',
    '状态: 待整理',
    `来源: ${BILI}`,
    '作者: 测试 UP 主',
    '时长: 10:15',
    '文字来源: 平台字幕',
    '录音编号: vid-1',
    '日期: 2026-11-11',
    '---',
    '',
    '## 一句话概括',
    '',
    '讲 AI 工作流。',
    '',
  ].join('\n'))
  assert.equal(await readFile(join(beer.vault, ENTRY, 'transcript.md'), 'utf8'), MARKDOWN)
  assert.equal(await readFile(join(beer.vault, ENTRY, 'transcript.srt'), 'utf8'), SRT)
  assert.ok(home.requests.some(r => r.method === 'POST' && r.path === '/recordings/vid-1/stored'))

  // 素材分页按「视频」筛得到
  const list = await beer.api('GET', '/materials?type=' + encodeURIComponent('视频'))
  assert.deepEqual(list.body.entries.map(e => [e.title, e.type, e.source]), [['十分钟讲清 AI 工作流', '视频', BILI]])
})

test('取回：语音识别出来的视频记「文字来源: 语音识别」', async t => {
  const transcript = { ...TRANSCRIPT, source: { ...TRANSCRIPT.source, text_source: 'asr' } }
  const home = await readyHome(t, readyVideo({ text_source: 'asr' }), transcript)
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY }, now: NOW })
  await beer.api('POST', '/recordings/sync')
  assert.match(await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8'), /^文字来源: 语音识别$/m)
})

test('重新总结：视频条目只改「摘要类型」和正文，「类型: 视频」不变，文字稿不动', async t => {
  const original = [
    '---',
    '标题: 十分钟讲清 AI 工作流',
    '类型: 视频',
    '摘要类型: 视频',
    '状态: 可用',
    `来源: ${BILI}`,
    '录音编号: vid-1',
    '日期: 2026-11-11',
    '---',
    '',
    '旧摘要',
    '',
  ].join('\n')
  const home = await startFake(t, {
    'POST /recordings/vid-1/resummarize': () => readyVideo({ summary_type: '课程讲座', summary: '## 知识点大纲\n\n- 一' }),
  })
  const beer = await startBeer(t, {
    vault: { [`${ENTRY}/index.md`]: original, [`${ENTRY}/transcript.md`]: MARKDOWN },
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
  })

  const res = await beer.api('POST', '/recordings/vid-1/summarize', { type: '课程讲座' })

  assert.equal(res.status, 200)
  assert.equal(res.body.entryUpdated, `${ENTRY}/index.md`)
  const note = await readFile(join(beer.vault, ENTRY, 'index.md'), 'utf8')
  assert.match(note, /^类型: 视频$/m)
  assert.match(note, /^摘要类型: 课程讲座$/m)
  assert.match(note, /^状态: 可用$/m)
  assert.match(note, /## 知识点大纲/)
  assert.ok(!note.includes('旧摘要'))
  assert.equal(await readFile(join(beer.vault, ENTRY, 'transcript.md'), 'utf8'), MARKDOWN)
})

test('首页：处理中的视频显示视频标题', async t => {
  const home = await startFake(t, {
    'GET /recordings': () => ({ recordings: [videoView({ title: '十分钟讲清 AI 工作流', steps: steps({ queue: 'running' }) })] }),
  })
  const beer = await startBeer(t, { vault: {}, config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const res = await beer.api('GET', '/home')
  assert.equal(res.body.recordings.processing[0].title, '十分钟讲清 AI 工作流')
  assert.equal(res.body.recordings.processing[0].kind, 'video')
})
