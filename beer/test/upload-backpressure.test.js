// 上传给家里时守住背压（#31）：家里收得慢，Beer 就跟着慢慢读，内存不随文件大小增长。
// 假家里每收一块就停一下；上传过程中每 100 毫秒强制回收一次内存，记下 Beer 多攥了多少。
// Node 自带的 fetch 发流式请求体时不守背压，这两个测试在它上面峰值约等于文件大小。
import test from 'node:test'
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { startBeer, listen, makeTempDir, PREFIX } from './helpers/beer.js'
import { submitFromPath } from '../src/modules/recordings.js'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc')

const HOME_KEY = 'home-key-1'
const SIZE = 48 * 1024 * 1024
const LIMIT = 8 * 1024 * 1024 // 修好后实测不到 1 MB；不守背压时约等于文件大小

/** 假家里：POST /recordings 每收一块停 2 毫秒（读得慢），读完回 201。 */
async function startSlowHome(t) {
  let received = 0
  const server = await listen(t, (req, res) => {
    req.on('data', chunk => {
      received += chunk.length
      req.pause()
      setTimeout(() => req.resume(), 2)
    })
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'rec-big', filename: 'big.m4a', status: 'processing', steps: [], progress: 0 }))
    })
  })
  return { url: server.url, received: () => received }
}

/** 跑 work 期间每 100 毫秒回收一次内存，返回 [work 的结果, 比开始时多出的 arrayBuffers 峰值]。 */
async function measurePeak(work) {
  gc()
  const before = process.memoryUsage().arrayBuffers
  let peak = 0
  const timer = setInterval(() => {
    gc()
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - before)
  }, 100)
  try {
    return [await work(), peak]
  } finally {
    clearInterval(timer)
  }
}

/**
 * 扮演浏览器把文件用 multipart 传给 Beer。测试和 Beer 在同一个进程里，
 * 这头也得守背压（不能用 fetch），否则量到的是测试自己攥的内存。
 */
async function postMultipart(url, path, size) {
  const boundary = '----beer-test-boundary'
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Readable.from((async function* () {
    yield head
    for await (const chunk of createReadStream(path)) yield chunk
    yield tail
  })())
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(head.length + size + tail.length),
      },
    }, async res => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    })
    req.on('error', reject)
    pipeline(body, req).catch(reject)
  })
}

const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB'

/** 用流写一个大文件，测试进程自己不攥着整份内容。 */
async function writeBigFile(path, size) {
  const handle = await open(path, 'w')
  const chunk = Buffer.alloc(1024 * 1024, 7)
  try {
    for (let done = 0; done < size; done += chunk.length) await handle.write(chunk)
  } finally {
    await handle.close()
  }
}

test('面板上传：家里读得慢时 Beer 内存峰值远小于文件大小，上传照常成功', async t => {
  const home = await startSlowHome(t)
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-big-')
  const path = join(dir, 'big.m4a')
  await writeBigFile(path, SIZE)

  const [res, peak] = await measurePeak(() => postMultipart(beer.url + PREFIX + '/recordings', path, SIZE))

  assert.equal(res.status, 201)
  assert.equal(res.body.id, 'rec-big')
  assert.ok(home.received() > SIZE, '整份 multipart 应完整到达家里')
  assert.ok(peak < LIMIT, `上传 ${mb(SIZE)} 时 Beer 多攥了 ${mb(peak)}`)
})

test('AI 工具提交：家里读得慢时 Beer 内存峰值远小于文件大小，提交照常成功', async t => {
  const home = await startSlowHome(t)
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-big-')
  const path = join(dir, 'big.m4a')
  await writeBigFile(path, SIZE)

  const [value, peak] = await measurePeak(() => submitFromPath(beer.context, { filePath: path }))

  assert.equal(value.id, 'rec-big')
  assert.ok(home.received() > SIZE, '整份 multipart 应完整到达家里')
  assert.ok(peak < LIMIT, `提交 ${mb(SIZE)} 时 Beer 多攥了 ${mb(peak)}`)
})

test('面板上传：家里没读完请求体就先回 503，Beer 照原样透传错误，不卡住', async t => {
  const home = await listen(t, (req, res) => {
    res.writeHead(503, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ detail: '录音原件路径不可用', error_code: 'ORIGINALS_UNAVAILABLE' }))
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url }, secrets: { 'home-api-key': HOME_KEY } })
  const dir = await makeTempDir(t, 'beer-big-')
  const path = join(dir, 'big.m4a')
  await writeBigFile(path, SIZE)

  const res = await postMultipart(beer.url + PREFIX + '/recordings', path, SIZE)

  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'ORIGINALS_UNAVAILABLE')
  assert.equal(res.body.error.message, '录音原件路径不可用')
})
