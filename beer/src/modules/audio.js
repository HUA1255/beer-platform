// 录音播放与缓存（#21）：把录音原件的音频字节交给面板的播放器。
//
//   GET /api/beer/recordings/:id/audio
//     本机上传过的录音在上传时已经留了一份到缓存，直接读本地；
//     本地没有时向家里 GET /recordings/{id}/audio 下载，先写临时文件再改名，失败不留半个文件。
//     返回音频字节，支持 HTTP Range（浏览器拖动进度条用），每次播放更新 lastPlayedAt。
//
// 缓存目录在内容库之外：<Beer 数据目录>/audio-cache/，索引是同目录的 audio-cache.json，
// 每条记录 { id, file, size, lastPlayedAt }。超过 config.audioCacheLimitGB 时按 lastPlayedAt
// 最久远的先删，只删这个目录里的文件，不碰库和家里原件。
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from '../http/router.js'
import { homeError, homeFetch, readHomeBody } from '../home-client.js'

const CACHE_DIR_NAME = 'audio-cache'
const INDEX_NAME = 'audio-cache.json'
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000 // 大文件从 NAS 下载，给足时间
const GB = 1024 * 1024 * 1024

const CONTENT_TYPES = {
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
}

const EXT_BY_TYPE = {
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/opus': '.opus',
}

export function register(router, ctx) {
  router.get('/recordings/:id/audio', async req => play(ctx, req.params.id, req))
}

/** 播放一条录音：本地缓存优先，没有就向家里下载。 */
async function play(ctx, id, req) {
  const cache = await openCache(ctx)
  let entry = findEntry(cache.entries, id)
  if (!entry) {
    entry = await downloadFromHome(ctx, cache, id)
  }
  entry.lastPlayedAt = ctx.now().toISOString()
  await saveIndex(cache)
  // 先淘汰别人，保证这次要播的文件还在；播完再看一次，单个文件就超过上限时把这条也清掉。
  await evictOverLimit(ctx, cache, { keepId: id })
  await sendAudio(req, join(cache.dir, entry.file))
  await evictOverLimit(ctx, cache)
}

/** 把音频文件写给浏览器；带 Range 时回 206 和 Content-Range，浏览器才能从某一秒开始播。 */
async function sendAudio(req, filePath) {
  const info = await stat(filePath)
  const size = info.size
  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') {
    const res = req.res
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' })
    res.end()
    return
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const headers = {
    'content-type': typeOfFile(filePath),
    'content-length': String(size === 0 ? 0 : end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  const res = req.res
  res.writeHead(range ? 206 : 200, headers)
  if (size === 0) {
    res.end()
    return
  }
  try {
    await pipeline(createReadStream(filePath, { start, end }), res)
  } catch {
    // 浏览器拖动进度条或关掉播放器时会提前断开，不算错误。
    if (!res.writableEnded && !res.destroyed) res.destroy()
  }
}

/**
 * 解析单段 Range。没带 Range（或单位不是 bytes）→ null；语法不对 / 超出文件长度 → 'invalid'。
 * 多段 Range 只取第一段（浏览器播放器不会发多段）。
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.trim()) return null
  const m = /^bytes=(.*)$/i.exec(header.trim())
  if (!m) return null
  const first = m[1].split(',')[0].trim()
  const parts = /^(\d*)-(\d*)$/.exec(first)
  if (!parts) return 'invalid'
  const [, rawStart, rawEnd] = parts
  if (!rawStart && !rawEnd) return 'invalid'
  if (!rawStart) {
    // bytes=-N：最后 N 个字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'invalid'
  let end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isFinite(end) || end < start) return 'invalid'
  if (end >= size) end = size - 1
  return { start, end }
}

function findEntry(entries, id) {
  return entries.find(e => e.id === id) ?? null
}

/** 打开（必要时创建）缓存目录并读出索引，丢掉索引里已经不存在或越界的文件。 */
async function openCache(ctx) {
  const dir = await cacheDir(ctx)
  const indexPath = join(dir, INDEX_NAME)
  let data
  try {
    data = JSON.parse(await readFile(indexPath, 'utf8'))
  } catch {
    data = null
  }
  const raw = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : []
  const entries = []
  for (const item of raw) {
    if (typeof item?.id !== 'string' || typeof item?.file !== 'string') continue
    // 只认缓存目录里的文件名，防止索引被改后删到别处。
    if (basename(item.file) !== item.file || item.file === INDEX_NAME) continue
    let info
    try {
      info = await stat(join(dir, item.file))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    entries.push({
      id: item.id,
      file: item.file,
      size: info.size,
      lastPlayedAt: typeof item.lastPlayedAt === 'string' ? item.lastPlayedAt : new Date(0).toISOString(),
    })
  }
  return { dir, indexPath, entries }
}

async function saveIndex(cache) {
  const body = JSON.stringify({ entries: cache.entries }, null, 2)
  const tmp = `${cache.indexPath}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, body)
  await rename(tmp, cache.indexPath)
}

/** 从家里下载音频到缓存：先写临时文件，成功后再改名为正式文件。 */
async function downloadFromHome(ctx, cache, id) {
  const res = await homeFetch(ctx, 'GET', `/recordings/${encodeURIComponent(id)}/audio`, {
    timeout: DOWNLOAD_TIMEOUT_MS,
  })
  if (!res.ok) {
    const body = await readHomeBody(res)
    throw homeError(res.status, body)
  }

  const ext = extensionOf(res.headers)
  const file = `${safeId(id)}${ext}`
  const target = join(cache.dir, file)
  const tmp = join(cache.dir, `.download-${randomBytes(6).toString('hex')}.part`)
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp, { flags: 'wx' }))
    const info = await stat(tmp)
    await rename(tmp, target)
    const entry = { id, file, size: info.size, lastPlayedAt: ctx.now().toISOString() }
    cache.entries = cache.entries.filter(e => e.id !== id)
    cache.entries.push(entry)
    return entry
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
    throw new HttpError(502, 'home_unreachable', '家里暂时连不上')
  }
}

/** 按 lastPlayedAt 最久远的先删，直到总大小不超过配置的上限。只删缓存目录里的文件。 */
async function evictOverLimit(ctx, cache, { keepId } = {}) {
  const limit = Number(ctx.config.audioCacheLimitGB) * GB
  let total = cache.entries.reduce((sum, e) => sum + e.size, 0)
  if (total <= limit) return
  const sorted = [...cache.entries].sort((a, b) => a.lastPlayedAt.localeCompare(b.lastPlayedAt))
  for (const entry of sorted) {
    if (total <= limit) break
    if (entry.id === keepId) continue // 正在播的这一条先留到这次播完
    await rm(join(cache.dir, entry.file), { force: true }).catch(() => {})
    cache.entries = cache.entries.filter(e => e !== entry)
    total -= entry.size
  }
  await saveIndex(cache)
}

/** 音频文件扩展名：优先 Content-Disposition 里的文件名，其次 Content-Type。 */
function extensionOf(headers) {
  const disposition = headers.get('content-disposition') ?? ''
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  if (named) {
    const ext = extname(named[1]).toLowerCase()
    if (CONTENT_TYPES[ext]) return ext
  }
  const type = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return EXT_BY_TYPE[type] ?? '.bin'
}

function typeOfFile(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** 删除失败录音（#30）时用：把这条录音在本机缓存里的音频和索引记录一并清掉。没有缓存时什么都不做。 */
export async function dropCachedAudio(ctx, id) {
  const cache = await openCache(ctx)
  const gone = cache.entries.filter(e => e.id === id)
  if (!gone.length) return false
  for (const entry of gone) await rm(join(cache.dir, entry.file), { force: true }).catch(() => {})
  cache.entries = cache.entries.filter(e => e.id !== id)
  await saveIndex(cache)
  return true
}

/** 缓存目录：Beer 数据目录下的 audio-cache，和内容库不在同一棵树里。 */
async function cacheDir(ctx) {
  const dir = join(ctx.config.root, CACHE_DIR_NAME)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 本机上传时用：把转发给家里的同一份 multipart 请求体顺带写一份临时文件（边转发边写，
 * 不把大文件读进内存），家里接收成功后再从临时文件里流式抽出第一个文件部分放进缓存。
 * 家里失败就 discard，临时文件删掉，什么都不留。
 *
 * 返回 { body, save({ id, contentType }), discard() }：body 给 ctx.fetch 当请求体。
 */
export async function createUploadTap(ctx, source, { length = null } = {}) {
  const dir = await cacheDir(ctx)
  const rawPath = join(dir, `.upload-${randomBytes(6).toString('hex')}.part`)
  const file = createWriteStream(rawPath, { flags: 'wx' })
  const expected = Number.isFinite(length) && length > 0 ? length : null
  let written = 0
  let ended = false
  let diskError = null
  const endFile = () => {
    if (ended) return
    ended = true
    file.end()
  }
  const finished = new Promise((resolve, reject) => {
    file.once('finish', resolve)
    file.once('error', reject)
  })
  finished.catch(() => {})
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      if (diskError) return callback(diskError)
      const flushed = file.write(chunk)
      written += chunk.length
      // 请求头给了长度：写满就关文件，不依赖发送端是否把可读端读到 end。
      if (expected !== null && written >= expected) endFile()
      if (flushed) return callback(null, chunk)
      file.once('drain', () => callback(null, chunk))
    },
    flush(callback) {
      endFile()
      if (file.writableFinished) return callback()
      file.once('finish', () => callback())
    },
  })
  file.on('error', err => {
    diskError = err
    tap.destroy(err)
  })
  source.on('error', err => tap.destroy(err))
  tap.on('end', endFile) // 没有 Content-Length 的 chunked 上传靠它
  tap.on('close', endFile) // 发送端提前关掉流时也要把文件关掉
  source.pipe(tap)

  let settled = false
  const removeRaw = () => rm(rawPath, { force: true }).catch(() => {})
  return {
    body: tap, // Node 可读流，交给 homeUpload 用 pipeline 发（守背压）
    async save({ id, contentType }) {
      if (settled) return
      settled = true
      try {
        // 已经收到家里的 201，请求体早发完了；这里等落盘完成只是为了拿到完整临时文件。
        await withTimeout(finished, 5_000)
        await cacheMultipart(ctx, dir, rawPath, contentType, id)
      } catch {
        // 缓存失败不影响已经成功转发的上传，下次播放再向家里下载。
      } finally {
        await removeRaw()
      }
    },
    async discard() {
      if (settled) return
      settled = true
      tap.destroy()
      file.destroy()
      await removeRaw()
    },
  }
}

async function cacheMultipart(ctx, dir, rawPath, contentType, id) {
  const boundary = boundaryOf(contentType)
  if (!boundary) return
  const extracted = join(dir, `.extract-${randomBytes(6).toString('hex')}.part`)
  let target = null
  try {
    const meta = await extractFirstFilePart(rawPath, boundary, extracted)
    if (!meta) {
      await rm(extracted, { force: true }).catch(() => {})
      return
    }
    const file = `${safeId(id)}${extensionOfPart(meta)}`
    target = join(dir, file)
    const info = await stat(extracted)
    await rm(target, { force: true })
    await rename(extracted, target)
    const cache = await openCache(ctx)
    cache.entries = cache.entries.filter(e => e.id !== id)
    cache.entries.push({ id, file, size: info.size, lastPlayedAt: ctx.now().toISOString() })
    await saveIndex(cache)
    await evictOverLimit(ctx, cache)
  } catch {
    // 索引写失败等：别留下一个索引里没有、永远不会被淘汰的孤儿音频。
    if (target) await rm(target, { force: true }).catch(() => {})
    await rm(extracted, { force: true }).catch(() => {})
  }
}

/**
 * 从一个 multipart 原始文件里流式抽出第一个带 filename 的部分，写到 destPath。
 * 只保留一个分块大小的重叠区，1 GiB 的录音也不会整份读进内存。
 * 返回 { filename, contentType }，找不到文件部分或文件被截断时返回 null。
 */
async function extractFirstFilePart(rawPath, boundary, destPath) {
  const delimiter = Buffer.from(`--${boundary}`)
  const separator = Buffer.from(`\r\n--${boundary}`)
  const headerEnd = Buffer.from('\r\n\r\n')
  const MAX_HEADERS = 256 * 1024
  let pending = Buffer.alloc(0)
  let phase = 'preamble'
  let headers = ''
  let meta = null
  let out = null
  let done = false

  const openOut = () => {
    out = createWriteStream(destPath, { flags: 'wx' })
    return new Promise((resolve, reject) => {
      out.once('open', resolve)
      out.once('error', reject)
    })
  }
  const writeOut = async chunk => {
    if (!chunk.length) return
    if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
  }

  try {
    for await (const chunk of createReadStream(rawPath)) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (!done) {
        if (phase === 'preamble') {
          const at = pending.indexOf(delimiter)
          if (at < 0) {
            pending = tail(pending, delimiter.length - 1)
            break
          }
          pending = pending.subarray(at + delimiter.length)
          phase = 'boundary'
          continue
        }
        if (phase === 'boundary') {
          if (pending.length < 2) break
          if (pending[0] === 0x2d && pending[1] === 0x2d) { done = true; break } // 结束标记 --
          if (pending[0] === 0x0d && pending[1] === 0x0a) pending = pending.subarray(2)
          phase = 'headers'
          continue
        }
        if (phase === 'headers') {
          const at = pending.indexOf(headerEnd)
          if (at < 0) {
            if (pending.length > MAX_HEADERS) throw new Error('multipart 头太大')
            break
          }
          headers = pending.subarray(0, at).toString('utf8')
          pending = pending.subarray(at + headerEnd.length)
          if (/filename\s*=/i.test(headers)) {
            await openOut()
            meta = { filename: filenameOf(headers), contentType: contentTypeOf(headers) }
            phase = 'content'
          } else {
            phase = 'skip'
          }
          continue
        }
        if (phase === 'content') {
          const at = pending.indexOf(separator)
          if (at < 0) {
            // 分隔符可能横跨两个分块：末尾留一段重叠区，前面的先写盘。
            const keep = separator.length + 1
            if (pending.length > keep) {
              await writeOut(pending.subarray(0, pending.length - keep))
              pending = pending.subarray(pending.length - keep)
            }
            break
          }
          await writeOut(pending.subarray(0, at))
          done = true
          continue
        }
        if (phase === 'skip') {
          const at = pending.indexOf(separator)
          if (at < 0) {
            pending = tail(pending, separator.length + 1)
            break
          }
          pending = pending.subarray(at + separator.length)
          phase = 'boundary'
          continue
        }
      }
      if (done) break
    }
  } finally {
    if (out) await new Promise(resolve => out.end(resolve))
  }
  return done && meta ? meta : null
}

function tail(buffer, length) {
  return buffer.length > length ? buffer.subarray(buffer.length - length) : buffer
}

function boundaryOf(contentType) {
  if (typeof contentType !== 'string') return null
  const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return m ? (m[1] ?? m[2]) : null
}

/** multipart 部分头里的文件名和内容类型。 */
function filenameOf(headers) {
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(headers)
  if (quoted) return quoted[1]
  const plain = /filename\s*=\s*([^;\r\n]+)/i.exec(headers)
  return plain ? plain[1].trim() : ''
}

function contentTypeOf(headers) {
  const m = /^content-type\s*:\s*(.+)$/im.exec(headers)
  return m ? m[1].trim() : ''
}

function extensionOfPart(meta) {
  const byName = extname(meta.filename ?? '').toLowerCase()
  if (byName && CONTENT_TYPES[byName]) return byName
  const type = String(meta.contentType ?? '').split(';')[0].trim().toLowerCase()
  return EXT_BY_TYPE[type] ?? '.bin'
}

/** 等一会儿，超时就不等了（并清掉定时器，别拖住进程退出）。 */
async function withTimeout(promise, ms) {
  let timer
  try {
    await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(resolve, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 录音编号只用来拼缓存文件名，去掉路径分隔符等。 */
function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'recording'
}
