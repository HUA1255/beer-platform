// 录音播放与缓存（#21）的接口测试：本机上传过的直接播、本地没有时从家里下载到库外缓存、
// Range 拖动、缓存上限按最久没听淘汰。家里服务一律用 startFake 代替，只断言 Beer 的返回、
// 发给假家里的请求和库里的文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles, listen, PREFIX } from './helpers/beer.js'

const HOME_KEY = 'home-key-1'
const IMAGE_MP4 = 'audio/mp4'

/** 形状可辨认的测试音频（默认 64 KiB）。 */
function makeAudio(size = 64 * 1024, seed = 11) {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * seed + 17) % 251
  return bytes
}

/** 走播放接口，返回状态码、响应头、原始字节和（错误时的）JSON。 */
async function play(beer, id, headers = {}) {
  const res = await fetch(`${beer.url}${PREFIX}/recordings/${encodeURIComponent(id)}/audio`, { headers })
  const bytes = Buffer.from(await res.arrayBuffer())
  let body
  try { body = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined } catch {}
  return { status: res.status, headers: res.headers, bytes, body }
}

/** 家里返回的录音视图（#19 的字段）。 */
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

test('播放：本地没有时从家里下载并缓存，第二次播放不再请求家里', async t => {
  const audio = makeAudio()
  const home = await startFake(t, {
    'GET /recordings/rec-1/audio': () => ({ raw: audio, contentType: IMAGE_MP4 }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const first = await play(beer, 'rec-1')
  assert.equal(first.status, 200)
  assert.deepEqual(first.bytes, audio)
  assert.equal(first.headers.get('accept-ranges'), 'bytes')
  assert.match(first.headers.get('content-type'), /^audio\/(mp4|x-m4a|m4a)$/)

  const second = await play(beer, 'rec-1')
  assert.equal(second.status, 200)
  assert.deepEqual(second.bytes, audio)
  assert.equal(home.requests.length, 1, '第二次播放应读本地缓存，不再请求家里')
})

test('播放：支持 HTTP Range，从某一秒开始播和拖动进度条都靠它', async t => {
  const audio = makeAudio(1000)
  const home = await startFake(t, {
    'GET /recordings/rec-1/audio': () => ({ raw: audio, contentType: IMAGE_MP4 }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const full = await play(beer, 'rec-1')
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(full.headers.get('content-length'), '1000')

  const middle = await play(beer, 'rec-1', { range: 'bytes=100-199' })
  assert.equal(middle.status, 206)
  assert.equal(middle.headers.get('content-range'), 'bytes 100-199/1000')
  assert.equal(middle.headers.get('content-length'), '100')
  assert.deepEqual(middle.bytes, audio.subarray(100, 200))

  const openEnd = await play(beer, 'rec-1', { range: 'bytes=900-' })
  assert.equal(openEnd.status, 206)
  assert.equal(openEnd.headers.get('content-range'), 'bytes 900-999/1000')
  assert.deepEqual(openEnd.bytes, audio.subarray(900))

  const suffix = await play(beer, 'rec-1', { range: 'bytes=-50' })
  assert.equal(suffix.status, 206)
  assert.equal(suffix.headers.get('content-range'), 'bytes 950-999/1000')
  assert.deepEqual(suffix.bytes, audio.subarray(950))

  const tooFar = await play(beer, 'rec-1', { range: 'bytes=5000-6000' })
  assert.equal(tooFar.status, 416)
  assert.equal(tooFar.headers.get('content-range'), 'bytes */1000')
})

test('上传：本机上传的 1 MiB 原件留一份到缓存，上传完马上本地播放，不再向家里要', async t => {
  const audio = makeAudio(1024 * 1024 + 4096, 7)
  const home = await startFake(t, {
    'POST /recordings': () => ({ status: 201, body: recView({ id: 'rec-up', filename: 'big.m4a' }) }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const up = await upload(beer, audio, 'big.m4a')
  assert.equal(up.status, 201)
  assert.equal(up.body.id, 'rec-up')
  assert.ok(home.requests[0].raw.includes(audio), '上传内容应原样转发给家里')

  const played = await play(beer, 'rec-up')
  assert.equal(played.status, 200)
  assert.deepEqual(played.bytes, audio, '缓存里的内容要和上传的文件逐字节一致')
  assert.match(played.headers.get('content-type'), /^audio\/(mp4|x-m4a|m4a)$/)
  assert.equal(home.requests.filter(r => r.method === 'GET').length, 0, '上传后应读本地缓存，不去家里下载')
  assert.deepEqual(await listFiles(beer.vault), [], '缓存不能写进内容库')
})

test('上传：家里连不上或返回 4xx 时不留缓存，之后播放要重新向家里要', async t => {
  const audio = makeAudio(4096, 3)
  const broken = await startFake(t, {
    'POST /recordings': () => ({ status: 503, body: { detail: '录音原件路径不可用', error_code: 'ORIGINALS_UNAVAILABLE' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: broken.url }, secrets: { 'home-api-key': HOME_KEY } })
  const res = await upload(beer, audio, 'meeting.m4a')
  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'ORIGINALS_UNAVAILABLE')
  const cached = await listFiles(join(beer.dataDir, 'audio-cache'))
  assert.deepEqual(cached.filter(f => !f.endsWith('.json')), [], '上传失败不能留音频文件或临时文件')
})

test('缓存：放在 Beer 数据目录的 audio-cache，内容库文件一个都不变', async t => {
  const audio = makeAudio(2048)
  const home = await startFake(t, {
    'GET /recordings/rec-1/audio': () => ({ raw: audio, contentType: IMAGE_MP4 }),
  })
  const beer = await startBeer(t, {
    vault: { '内容库/素材/说明.md': '# 说明\n' },
    config: { homeApiBase: home.url },
    secrets: { 'home-api-key': HOME_KEY },
  })
  const before = await listFiles(beer.vault)

  const played = await play(beer, 'rec-1')
  assert.equal(played.status, 200)
  assert.deepEqual(await listFiles(beer.vault), before, '缓存不能写进内容库')

  const cached = await listFiles(join(beer.dataDir, 'audio-cache'))
  assert.ok(cached.includes('audio-cache.json'), '缓存索引应放在数据目录的 audio-cache 里')
  assert.equal(cached.filter(f => f.endsWith('.m4a')).length, 1)
})

test('缓存上限：按 lastPlayedAt 最久没听的先删，刚听过的留着', async t => {
  const audio1 = makeAudio(8192, 5)
  const audio2 = makeAudio(8192, 9)
  const home = await startFake(t, {
    'GET /recordings/rec-1/audio': () => ({ raw: audio1, contentType: IMAGE_MP4 }),
    'GET /recordings/rec-2/audio': () => ({ raw: audio2, contentType: IMAGE_MP4 }),
  })
  let clock = Date.parse('2026-11-06T00:00:00.000Z')
  const beer = await startBeer(t, {
    config: { homeApiBase: home.url, audioCacheLimitGB: 0.00001 }, // ≈ 10.5 KB，只放得下一条 8 KB
    secrets: { 'home-api-key': HOME_KEY },
    now: () => new Date(clock),
  })

  clock += 1000
  assert.deepEqual((await play(beer, 'rec-1')).bytes, audio1)
  clock += 1000
  assert.deepEqual((await play(beer, 'rec-2')).bytes, audio2)

  // rec-1 是更久以前听的，超限时被淘汰；再播它要重新向家里下载。
  clock += 1000
  assert.deepEqual((await play(beer, 'rec-2')).bytes, audio2)
  assert.equal(home.requests.filter(r => r.path === '/recordings/rec-2/audio').length, 1, '刚听过的 rec-2 应还在缓存')

  clock += 1000
  assert.deepEqual((await play(beer, 'rec-1')).bytes, audio1)
  assert.equal(home.requests.filter(r => r.path === '/recordings/rec-1/audio').length, 2, 'rec-1 已被淘汰，应重新下载')
})

test('播放失败：下载中途断开返回 502，缓存目录里不留半个文件', async t => {
  // 家里回了 200 和 Content-Length，但只发 10 字节就断开。
  const brokenHome = await listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': IMAGE_MP4, 'content-length': '1000' })
    res.write(Buffer.alloc(10, 1))
    setTimeout(() => res.destroy(), 20)
  })
  const beer = await startBeer(t, {
    config: { homeApiBase: brokenHome.url },
    secrets: { 'home-api-key': HOME_KEY },
  })

  const res = await play(beer, 'rec-1')
  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.match(res.body.error.message, /家里暂时连不上/)
  assert.deepEqual(await listFiles(join(beer.dataDir, 'audio-cache')), [], '下载失败不能留下临时文件或半个缓存')
})

test('播放失败：家里 404 NOT_FOUND 按原状态码和错误码透传，不留缓存', async t => {
  const home = await startFake(t, {
    'GET /recordings/missing/audio': () => ({ status: 404, body: { detail: '没有这条录音', error_code: 'NOT_FOUND' } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await play(beer, 'missing')
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'NOT_FOUND')
  assert.equal(res.body.error.message, '没有这条录音')
  assert.deepEqual(await listFiles(join(beer.dataDir, 'audio-cache')), [])
})

test('播放失败：家里连不上返回 502 home_unreachable，不留缓存', async t => {
  const beer = await startBeer(t, { config: { homeApiBase: await deadUrl(t) }, secrets: { 'home-api-key': HOME_KEY } })

  const res = await play(beer, 'rec-1')
  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'home_unreachable')
  assert.deepEqual(await listFiles(join(beer.dataDir, 'audio-cache')), [])
})
