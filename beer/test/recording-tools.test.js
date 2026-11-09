// 转录 AI 工具（#22）的执行函数测试：不经过宿主，直接调用 recordings.js 导出的三个函数。
// 家里服务一律用 startFake 代替，只断言返回文本、发给假家里的请求和错误信息。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { submitFromPath, toolStatus, toolResult } from '../src/modules/recordings.js'
import { registerRecordingTools } from '../src/index.js'
import { startBeer, startFake, deadUrl, makeTempDir } from './helpers/beer.js'

const HOME_KEY = 'home-key-1'
const AUDIO_BYTES = Buffer.from('BEER-TOOL-AUDIO-BYTES-0123456789')

/** 家里服务返回的录音视图（和 home/README.md 的字段一致）。 */
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

test('提交：读本地文件，用 multipart 和 Bearer 发给家里，返回录音编号和五步状态文本', async t => {
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-9', filename: 'meeting.m4a' }) }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-audio-')
  const audioPath = join(dir, 'meeting.m4a')
  await writeFile(audioPath, AUDIO_BYTES)

  const value = await submitFromPath(beer.context, { filePath: audioPath })

  assert.equal(value.id, 'rec-9')
  assert.equal(value.filename, 'meeting.m4a')
  assert.match(value.text, /rec-9/)
  assert.match(value.text, /meeting\.m4a/)
  assert.match(value.text, /上传：已完成/)
  assert.match(value.text, /排队：进行中/)
  assert.match(value.text, /转写：待处理/)
  assert.match(value.text, /摘要：待处理/)
  assert.match(value.text, /入库：待处理/)

  assert.equal(home.requests.length, 1)
  const sent = home.requests[0]
  assert.equal(sent.method, 'POST')
  assert.equal(sent.path, '/recordings')
  assert.equal(sent.headers.authorization, `Bearer ${HOME_KEY}`)
  assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.match(sent.raw.toString('utf8'), /name="file"; filename="meeting\.m4a"/)
  assert.ok(sent.raw.includes(AUDIO_BYTES), 'multipart 里的文件内容应原样到达')
})

test('提交：filename 可选参数决定家里保存的文件名，中文名按 UTF-8 编码', async t => {
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-2', filename: '自定义名字.m4a' }) }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-audio-', { 'meeting.m4a': AUDIO_BYTES })

  const value = await submitFromPath(beer.context, { filePath: join(dir, 'meeting.m4a'), filename: '自定义名字.m4a' })

  assert.equal(value.filename, '自定义名字.m4a')
  const raw = home.requests[0].raw.toString('utf8')
  // python-multipart 按 UTF-8 解码 filename 的原始字节（不认 filename*），所以直接断言原文。
  assert.match(raw, /filename="自定义名字\.m4a"/)
})

test('提交：filePath 不是绝对路径时直接拒绝', async t => {
  const beer = await startBeer(t, { vault: false })

  await assert.rejects(
    () => submitFromPath(beer.context, { filePath: 'meeting.m4a' }),
    /绝对路径/,
  )
})

test('提交：filename 不能是「.」或「..」', async t => {
  const beer = await startBeer(t, { vault: false })
  const dir = await makeTempDir(t, 'beer-audio-', { 'meeting.m4a': AUDIO_BYTES })

  for (const name of ['.', '..']) {
    await assert.rejects(
      () => submitFromPath(beer.context, { filePath: join(dir, 'meeting.m4a'), filename: name }),
      /filename/,
    )
  }
})

test('提交：文件不存在时给清楚的中文错误，不打扰家里', async t => {
  const home = await startFake(t, { 'POST /recordings': () => recView() })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-audio-')

  await assert.rejects(
    () => submitFromPath(beer.context, { filePath: join(dir, '不存在.m4a') }),
    /文件不存在/,
  )
  assert.equal(home.requests.length, 0)
})

test('提交：扩展名不支持时拒绝，不打扰家里', async t => {
  const home = await startFake(t, { 'POST /recordings': () => recView() })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-audio-', { '笔记.txt': '不是录音' })

  await assert.rejects(
    () => submitFromPath(beer.context, { filePath: join(dir, '笔记.txt') }),
    /不支持这种文件/,
  )
  assert.equal(home.requests.length, 0)
})

test('提交：家里 401 时错误文本提醒检查 home-api-key', async t => {
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 401, body: { detail: '缺少或错误的访问密钥', error_code: 'UNAUTHORIZED' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': 'bad-key' } })
  const dir = await makeTempDir(t, 'beer-audio-', { 'meeting.m4a': AUDIO_BYTES })

  await assert.rejects(
    () => submitFromPath(beer.context, { filePath: join(dir, 'meeting.m4a') }),
    /home-api-key/,
  )
})

test('提交：家里连不上时错误文本包含「家里暂时连不上」', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-audio-', { 'meeting.m4a': AUDIO_BYTES })

  await assert.rejects(
    () => submitFromPath(beer.context, { filePath: join(dir, 'meeting.m4a') }),
    /家里暂时连不上/,
  )
})

test('状态：返回五步中文名和状态，失败时带错误文本', async t => {
  const failedSteps = [
    { key: 'upload', name: '上传', status: 'done' },
    { key: 'queue', name: '排队', status: 'done' },
    { key: 'transcribe', name: '转写', status: 'failed' },
    { key: 'summarize', name: '摘要', status: 'pending' },
    { key: 'store', name: '入库', status: 'pending' },
  ]
  const home = await startFake(t, {
    'GET /recordings/rec-1': () => recView({ id: 'rec-1', progress: 20 }),
    'GET /recordings/rec-fail': () => recView({
      id: 'rec-fail',
      status: 'failed',
      progress: 60,
      steps: failedSteps,
      error_code: 'CHUNK_FAILED',
      error: '第 3 块转写失败',
    }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const value = await toolStatus(beer.context, 'rec-1')

  assert.equal(value.id, 'rec-1')
  assert.equal(value.status, 'processing')
  assert.match(value.text, /上传：已完成/)
  assert.match(value.text, /排队：进行中/)
  assert.match(value.text, /转写：待处理/)
  assert.match(value.text, /摘要：待处理/)
  assert.match(value.text, /入库：待处理/)
  assert.match(value.text, /进度 20%/)

  const failed = await toolStatus(beer.context, 'rec-fail')
  assert.equal(failed.status, 'failed')
  assert.match(failed.text, /转写：失败/)
  assert.match(failed.text, /第 3 块转写失败/)
  assert.match(failed.text, /CHUNK_FAILED/)

  const sent = home.requests[0]
  assert.equal(sent.method, 'GET')
  assert.equal(sent.path, '/recordings/rec-1')
  assert.equal(sent.headers.authorization, `Bearer ${HOME_KEY}`)
})

test('状态：家里连不上时错误文本包含「家里暂时连不上」', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  await assert.rejects(() => toolStatus(beer.context, 'rec-1'), /家里暂时连不上/)
})

const MARKDOWN = '# 周会\n\n说话人 1：今天讨论转录工具。\n'

test('结果：返回转录 markdown 和摘要', async t => {
  const home = await startFake(t, {
    'GET /recordings/rec-1/transcript': () => ({
      id: 'rec-1',
      filename: '周会.m4a',
      markdown: MARKDOWN,
      srt: '1\n00:00:01,000 --> 00:00:03,000\n今天讨论转录工具。\n',
      summary: '结论：转录工具开始做了。',
    }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const value = await toolResult(beer.context, 'rec-1')

  assert.equal(value.ready, true)
  assert.equal(value.id, 'rec-1')
  assert.equal(value.markdown, MARKDOWN)
  assert.equal(value.summary, '结论：转录工具开始做了。')
  assert.match(value.text, /结论：转录工具开始做了。/)
  assert.match(value.text, /说话人 1：今天讨论转录工具。/)
  assert.equal(home.requests[0].path, '/recordings/rec-1/transcript')
})

test('结果：没有摘要时明确说明', async t => {
  const home = await startFake(t, {
    'GET /recordings/rec-1/transcript': () => ({ id: 'rec-1', filename: '周会.m4a', markdown: MARKDOWN, srt: '', summary: null }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const value = await toolResult(beer.context, 'rec-1')

  assert.equal(value.ready, true)
  assert.equal(value.summary, null)
  assert.match(value.text, /没有摘要|暂无摘要/)
})

test('结果：家里还没转写完时返回「还没转写完」而不是抛异常', async t => {
  const home = await startFake(t, {
    'GET /recordings/rec-1/transcript': () => ({ status: 409, body: { detail: '转写结果还没好', error_code: 'NOT_READY' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const value = await toolResult(beer.context, 'rec-1')

  assert.equal(value.ready, false)
  assert.match(value.text, /还没转写完/)
  assert.doesNotMatch(value.text, /结论|说话人/)
})

test('结果：家里连不上时错误文本包含「家里暂时连不上」', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  await assert.rejects(() => toolResult(beer.context, 'rec-1'), /家里暂时连不上/)
})

test('注册：把三个工具注册到 tools 服务，名称、必填参数和展示都齐全', async t => {
  const beer = await startBeer(t, { vault: false })
  const registered = []
  const toolsCtx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }

  // 测试里用假的 defineTool（不加载宿主包），只验证接线和定义本身。
  const dispose = await registerRecordingTools(toolsCtx, beer.context, definition => definition)

  assert.deepEqual(registered.map(tool => tool.name), [
    'beer_transcribe_submit',
    'beer_transcribe_status',
    'beer_transcribe_result',
  ])

  const [submit, status, result] = registered
  assert.deepEqual(Object.keys(submit.parameters), ['filePath', 'filename'])
  assert.equal(submit.parameters.filePath.required, true)
  assert.equal(submit.parameters.filePath.type, 'string')
  assert.match(submit.parameters.filePath.description, /绝对路径/)
  assert.equal(submit.parameters.filename.required, undefined)
  assert.match(submit.description, /五步|转录/)
  assert.equal(submit.output.schema.type, 'json')
  assert.deepEqual(submit.output.render(null, { text: '状态文本' }), [{ type: 'text', text: '状态文本' }])
  assert.deepEqual(submit.presentCall({ filePath: '/tmp/a.m4a' }), {
    card: 'generic',
    kind: 'other',
    title: '提交转录',
    rawInput: { filePath: '/tmp/a.m4a' },
  })

  assert.deepEqual(Object.keys(status.parameters), ['id'])
  assert.equal(status.parameters.id.required, true)
  assert.match(status.description, /进度/)
  assert.equal(status.presentCall({ id: 'rec-1' }).title, '查转录进度')

  assert.deepEqual(Object.keys(result.parameters), ['id'])
  assert.equal(result.parameters.id.required, true)
  assert.match(result.description, /文字稿|markdown/i)
  assert.equal(result.presentCall({ id: 'rec-1' }).title, '取转录结果')

  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.presentCall({}).card, 'generic')
    assert.equal(tool.presentCall({}).kind, 'other')
  }

  dispose()
})
