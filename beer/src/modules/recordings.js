// 录音分页（#19）：把录音上传转发给家里服务，列出 / 查询录音，把就绪的结果取回写成素材条目，
// 以及顶栏要的三台机器在线状态。家里服务接口见 home/README.md。
//
//   POST /api/beer/recordings              multipart 原文转发给家里 POST /recordings（不读进内存）
//   GET  /api/beer/recordings[?status=]    转发 GET /recordings；sync=1 时先取回一次（30 秒内不重复）
//   GET  /api/beer/recordings/:id          转发单条录音
//   GET  /api/beer/recordings/:id/transcript  转发文字稿和摘要（面板展开摘要用）
//   POST /api/beer/recordings/:id/retry    转发重试
//   DELETE /api/beer/recordings/:id        转发删除（家里只删失败的记录，NAS 原件不动），成功后清本机音频缓存
//   POST /api/beer/recordings/:id/summarize  转给家里 POST /resummarize，按指定类型重做摘要
//   POST /api/beer/recordings/sync         取回 status=ready 的结果写入内容库，再向家里确认入库
//   GET  /api/beer/machines                家里 /health 的三台机器在线状态
//
// 家里连不上时一律 502 home_unreachable「家里暂时连不上」，不写本地队列；
// 家里自己的错误（如 503 ORIGINALS_UNAVAILABLE、409 NOT_FAILED）按原状态码和错误码透传。
//
// 对话里的三个 AI 工具（#22）也在这里执行，绕过 HTTP 直接调同一套家里转发：
//   submitFromPath(ctx, { filePath, filename })  读本机文件 → 家里 POST /recordings
//   toolStatus(ctx, id)                          家里 GET /recordings/{id}
//   toolResult(ctx, id)                          家里 GET /recordings/{id}/transcript
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { HttpError, reply } from '../http/router.js'
import { createEntry, listFolder, readNote, safeEntryName, saveNote } from './library.js'
import { createUploadTap, dropCachedAudio } from './audio.js'
import { HOME_DOWN, homeError, homeFetch, homeJson, homeUpload, readHomeBody } from '../home-client.js'
import { localDate } from '../dates.js'

const HOME_STATUSES = new Set(['processing', 'failed', 'ready', 'stored'])
const MATERIALS_FOLDER = '内容库/素材'
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000 // 大文件经本机转发，给足时间
const SYNC_MIN_INTERVAL_MS = 30_000

// AI 工具提交本机文件时接受的扩展名 → multipart 里的 content-type。
// 和面板的 accept="audio/*,video/*" 对齐，常见格式都收，其余给清楚的中文错误。
const AUDIO_TYPES = new Map([
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.wma', 'audio/x-ms-wma'],
  ['.amr', 'audio/amr'],
  ['.aiff', 'audio/aiff'],
  ['.aif', 'audio/aiff'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],
  ['.webm', 'video/webm'],
])

const STEP_KEYS = ['upload', 'queue', 'transcribe', 'summarize', 'store']
const STEP_NAMES = { upload: '上传', queue: '排队', transcribe: '转写', summarize: '摘要', store: '入库' }
const STEP_STATUS_NAMES = { pending: '待处理', running: '进行中', done: '已完成', failed: '失败' }
const RECORDING_STATUS_NAMES = { processing: '处理中', failed: '失败', ready: '结果已就绪', stored: '已入库' }

export function register(router, ctx) {
  const syncState = { lastSyncAt: 0, inflight: null } // 自动取回的限流和并发去重，只在这个服务实例里有效
  router.post('/recordings', async req => upload(ctx, req))
  router.get('/recordings', async req => listRecordings(ctx, req, syncState))
  router.get('/recordings/:id', async req => forward(ctx, 'GET', recordingPath(req)))
  router.get('/recordings/:id/transcript', async req => forward(ctx, 'GET', recordingPath(req) + '/transcript'))
  router.post('/recordings/:id/retry', async req => forward(ctx, 'POST', recordingPath(req) + '/retry'))
  router.delete('/recordings/:id', async req => deleteRecording(ctx, req.params.id))
  router.post('/recordings/:id/summarize', async req => {
    const body = await req.json()
    return forward(ctx, 'POST', recordingPath(req) + '/resummarize', {
      body,
      after: async view => ({ ...view, entryUpdated: await syncSummaryEntry(ctx, req.params.id, view) }),
    })
  })
  router.post('/recordings/sync', async () => syncOnce(ctx, syncState))
  router.get('/machines', async () => machines(ctx))
}

/** 把上传请求体（multipart 原文）流式转给家里，保留 content-type 里的 boundary。 */
async function upload(ctx, req) {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !/^multipart\/form-data\b/i.test(contentType)) {
    throw new HttpError(400, 'upload_invalid', '上传录音要用 multipart/form-data（字段名 file）')
  }
  const headers = { 'content-type': contentType }
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length']

  // 边转发边把同一份请求体写到缓存目录的临时文件：家里接收成功后再从里面抽出音频文件，
  // 这样本机上传的录音马上就能本地播放；失败时 discard，临时文件不留。
  const tap = await createUploadTap(ctx, req.req, { length: Number(req.headers['content-length']) })
  let res
  try {
    res = await homeUpload(ctx, 'POST', '/recordings', {
      body: tap.body,
      headers,
      timeout: UPLOAD_TIMEOUT_MS,
    })
  } catch (e) {
    await tap.discard()
    throw e
  }
  const body = await readHomeBody(res)
  if (!res.ok) {
    await tap.discard()
    throw homeError(res.status, body)
  }
  if (body === undefined) {
    await tap.discard()
    throw new HttpError(502, 'home_bad_response', '家里返回的内容看不懂')
  }
  // 家里接收成功才有录音编号，把这次上传的原件留一份到缓存，播放时直接读本地。
  if (typeof body.id === 'string' && body.id) await tap.save({ id: body.id, contentType })
  else await tap.discard()
  return reply(res.status, body)
}

/**
 * 删除失败的录音（#30）：家里只删失败状态的记录（其他状态 409 NOT_FAILED），NAS 上的原件不动。
 * 家里删成功（204）后再清本机音频缓存；家里拒绝或连不上时缓存原样保留。
 */
async function deleteRecording(ctx, id) {
  const res = await homeFetch(ctx, 'DELETE', '/recordings/' + encodeURIComponent(id))
  if (!res.ok) throw homeError(res.status, await readHomeBody(res))
  const cacheCleared = await dropCachedAudio(ctx, id)
  return { deleted: true, id, cacheCleared }
}

async function listRecordings(ctx, req, syncState) {
  const status = req.query.get('status')
  if (status !== null && !HOME_STATUSES.has(status)) {
    throw new HttpError(400, 'status_invalid', 'status 只能是 processing / failed / ready / stored')
  }
  if (req.query.get('sync') === '1') await syncOnce(ctx, syncState, { throttle: true })
  const query = status === null ? '' : `?status=${encodeURIComponent(status)}`
  return forward(ctx, 'GET', '/recordings' + query)
}

const SUMMARY_TIMEOUT_MS = 5_000

/**
 * 首页汇总用：家里正在处理 / 失败的录音摘要，不返回整份列表。
 * 家里连不上（含没配密钥）时返回 online: false 和 error，不抛错，首页照常可用。
 */
export async function recordingSummary(ctx) {
  let body
  try {
    // 首页只是看一眼进度，家里不在线时别让整个首页等满 15 秒。
    body = await homeJson(ctx, 'GET', '/recordings', { timeout: SUMMARY_TIMEOUT_MS })
  } catch (e) {
    const message = e instanceof HttpError && e.code === 'home_unreachable' ? HOME_DOWN
      : e instanceof HttpError ? e.message : HOME_DOWN
    return { online: false, processing: [], failedCount: 0, error: message }
  }
  const recordings = Array.isArray(body?.recordings) ? body.recordings : []
  const processing = recordings
    .filter(rec => rec?.status === 'processing')
    .map(rec => ({
      id: typeof rec.id === 'string' ? rec.id : String(rec.id ?? ''),
      filename: typeof rec.filename === 'string' ? rec.filename : '',
      progress: progressOf(rec.progress),
      step: currentStepOf(rec.steps),
    }))
  const failedCount = recordings.filter(rec => rec?.status === 'failed').length
  return { online: true, processing, failedCount }
}

function progressOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** 进行中的那一步名称；没有 running 时退回最后一个 done 的步骤名。 */
function currentStepOf(steps) {
  if (!Array.isArray(steps)) return ''
  const running = steps.find(step => step?.status === 'running')
  if (running && typeof running.name === 'string') return running.name
  const done = [...steps].reverse().find(step => step?.status === 'done')
  return done && typeof done.name === 'string' ? done.name : ''
}

/** 原样转发一个 JSON 请求；状态码和错误码都保留家里的。body 有值时按 JSON 发。after 用来补返回字段。 */
async function forward(ctx, method, path, { body: payload, after } = {}) {
  const res = await homeFetch(ctx, method, path, payload === undefined ? {} : {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  })
  const body = await readHomeBody(res)
  if (!res.ok) throw homeError(res.status, body)
  if (body === undefined) throw new HttpError(502, 'home_bad_response', '家里返回的内容看不懂')
  return reply(res.status, after ? await after(body) : body)
}

/** 顶栏用：家里三台机器的在线状态。连不上不报错，返回 online: false 让面板显示「家里暂时连不上」。 */
async function machines(ctx) {
  let health
  try {
    health = await homeJson(ctx, 'GET', '/health')
  } catch (e) {
    const message = e instanceof HttpError && e.code === 'home_unreachable' ? HOME_DOWN : e?.message ?? HOME_DOWN
    return { online: false, error: message }
  }
  const m = health?.machines
  if (!m || typeof m !== 'object') return { online: false, error: HOME_DOWN }
  const online = value => ({ online: value?.online === true })
  return {
    online: true,
    machines: { mac_mini: online(m.mac_mini), windows: online(m.windows), nas: online(m.nas) },
  }
}

/**
 * 取回家里 status=ready 的录音，写成 `内容库/素材/<日期>-<名称>/`：
 * index.md（开头属性 + 摘要）、transcript.md、transcript.srt，然后向家里确认入库。
 * 已经写过的录音（条目里的 `录音编号:` 对得上）不再写、不覆盖，只补一次入库确认。
 * 条目日期取取回当天（本机时区）。
 */
async function syncOnce(ctx, syncState, { throttle = false } = {}) {
  // 自动取回和面板按钮可能同时触发：同一时间只跑一次，后到的等到同一个结果。
  if (syncState.inflight) return syncState.inflight
  const now = ctx.now()
  if (throttle && now.getTime() - syncState.lastSyncAt < SYNC_MIN_INTERVAL_MS) {
    return { imported: [], skipped: [] }
  }
  syncState.inflight = runSync(ctx, syncState, now).finally(() => { syncState.inflight = null })
  return syncState.inflight
}

async function runSync(ctx, syncState, now) {
  const list = await homeJson(ctx, 'GET', '/recordings?status=ready')
  syncState.lastSyncAt = now.getTime()
  const recordings = Array.isArray(list?.recordings) ? list.recordings : []
  if (!recordings.length) return { imported: [], skipped: [] }
  const known = await entriesByRecordingId(ctx)
  const imported = []
  const skipped = []

  for (const rec of recordings) {
    const id = typeof rec?.id === 'string' ? rec.id.trim() : ''
    if (!id) continue

    // 已写过（上次可能写完还没确认入库）：只补确认，不碰文件。
    const existing = known.get(id)
    if (existing) {
      await confirmStored(ctx, id)
      skipped.push({ id, filename: rec.filename, path: existing })
      continue
    }

    let transcript
    try {
      transcript = await homeJson(ctx, 'GET', `/recordings/${encodeURIComponent(id)}/transcript`)
    } catch (e) {
      // 家里连不上 / 家里自己出错要停下；这条还没好（409 等）就跳过，别写半成品。
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
        skipped.push({ id, filename: rec.filename, reason: e.code })
        continue
      }
      throw e
    }

    const date = localDate(now)
    const entry = await createEntry(ctx, MATERIALS_FOLDER, `${date}-${safeEntryName(fileStem(rec.filename), '录音')}`, {
      'index.md': indexNote(rec, transcript, date),
      'transcript.md': transcriptText(transcript?.markdown),
      'transcript.srt': transcriptText(transcript?.srt),
    })
    known.set(id, entry.path)
    await confirmStored(ctx, id)
    imported.push({ id, filename: rec.filename, path: entry.path })
  }
  return { imported, skipped }
}

/** 内容库/素材 里已有的条目：录音编号 → 条目路径。只认开头属性里的字段。 */
async function entriesByRecordingId(ctx) {
  const listing = await listFolder(ctx, MATERIALS_FOLDER)
  const known = new Map()
  if (!listing.exists) return known
  for (const item of listing.entries) {
    if (item.kind !== 'folder') continue
    let note
    try {
      note = await readNote(ctx, `${item.path}/index.md`)
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'not_found' || e.code === 'not_markdown')) continue
      throw e
    }
    const m = /^录音编号:[ \t]*(.+?)[ \t]*\r?$/m.exec(frontmatterOf(note.content))
    if (m && !known.has(m[1])) known.set(m[1], item.path)
  }
  return known
}

async function confirmStored(ctx, id) {
  await homeJson(ctx, 'POST', `/recordings/${encodeURIComponent(id)}/stored`)
}

/**
 * 重新总结成功后同步已入库的素材条目：开头属性的 `类型:` 换成新的 summary_type，
 * frontmatter 之后的正文换成新摘要；transcript.md / transcript.srt 一个字节都不动。
 * 没入库的录音只返回 null，不新建条目。
 */
async function syncSummaryEntry(ctx, rawId, view) {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!id) return null
  const folder = (await entriesByRecordingId(ctx)).get(id)
  if (!folder) return null
  const path = `${folder}/index.md`
  const note = await readNote(ctx, path)
  const content = withNewSummary(note.content, view)
  if (content === note.content) return path
  const saved = await saveNote(ctx, path, content, note.version)
  if (saved.conflict) {
    throw new HttpError(409, 'edit_conflict', '录音摘要已经更新，但素材条目刚被别处改过，没有同步；刷新后再试')
  }
  return path
}

/**
 * 只改素材条目的 `类型:` 行和 frontmatter 之后的正文；其他属性逐字保留。
 * 新摘要为空时只改类型、保留原正文，不写占位覆盖用户写的东西。
 */
function withNewSummary(content, view) {
  const raw = String(content)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== '---') return raw
  let end = lines.indexOf('---', 1)
  if (end < 0) return raw

  const type = oneLine(view?.summary_type) || oneLine(view?.type)
  if (type) {
    let found = false
    for (let i = 1; i < end; i++) {
      if (/^类型\s*:/.test(lines[i])) {
        lines[i] = `类型: ${type}`
        found = true
        break
      }
    }
    if (!found) {
      lines.splice(end, 0, `类型: ${type}`)
      end += 1
    }
  }

  const summary = typeof view?.summary === 'string' ? view.summary.trim() : ''
  if (!summary) return lines.join(eol)
  const body = summary.replace(/\r\n?/g, '\n').split('\n')
  return [...lines.slice(0, end + 1), '', ...body, ''].join(eol)
}

/** 素材条目：开头是工单要求的属性，正文是摘要（没有时先占位）。 */
function indexNote(rec, transcript, date) {
  const type = oneLine(rec?.summary_type) || oneLine(rec?.type) || '未知'
  const original = oneLine(rec?.original_path ?? rec?.original) || '未知'
  const summary = typeof transcript?.summary === 'string' && transcript.summary.trim()
    ? transcript.summary.trim()
    : '摘要待生成'
  const title = oneLine(fileStem(rec?.filename)) || '录音'
  return [
    '---',
    `标题: ${title}`,
    `类型: ${type}`,
    '状态: 待整理',
    '来源: 录音',
    `原件: ${original}`,
    `录音编号: ${oneLine(rec?.id)}`,
    `日期: ${date}`,
    '---',
    '',
    summary,
    '',
  ].join('\n')
}

function fileStem(filename) {
  const name = typeof filename === 'string' ? filename : ''
  const base = name.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]*$/, '').trim()
}

function transcriptText(value) {
  return typeof value === 'string' ? value : ''
}

function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s*\r?\n\s*/g, ' ').trim() : ''
}

/** 只取开头 `---` 之间的属性，正文里出现 `录音编号:` 不算。 */
function frontmatterOf(content) {
  const text = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : ''
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  return m ? m[1] : ''
}

function recordingPath(req) {
  return '/recordings/' + encodeURIComponent(req.params.id)
}

// ---- 对话里的 AI 工具（#22） ----

/**
 * beer_transcribe_submit 的执行逻辑：读本机音频文件，按家里的上传格式（multipart 字段 file）
 * 转发给家里 POST /recordings，返回录音编号和五步状态摘要。
 * 本机文件问题抛 400 中文错误；家里连不上抛带「家里暂时连不上」的中文错误。
 */
export async function submitFromPath(ctx, { filePath, filename } = {}) {
  const file = await localAudioFile(filePath, filename)
  let res
  try {
    res = await postRecordingFile(ctx, file)
  } catch (e) {
    throw toolError(e, '提交录音')
  }
  const body = await readHomeBody(res)
  if (!res.ok) throw toolError(homeError(res.status, body), '提交录音')
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id) {
    throw new Error('家里返回的内容看不懂：没有录音编号，提交可能没成功，请再试一次')
  }
  return submittedView(body, file.name)
}

export async function toolStatus(ctx, id) {
  const recordingId = requireRecordingId(id)
  let view
  try {
    view = await homeJson(ctx, 'GET', '/recordings/' + encodeURIComponent(recordingId))
  } catch (e) {
    throw toolError(e, `查询录音 ${recordingId}`)
  }
  return statusView(view, recordingId)
}

export async function toolResult(ctx, id) {
  const recordingId = requireRecordingId(id)
  let transcript
  try {
    transcript = await homeJson(ctx, 'GET', `/recordings/${encodeURIComponent(recordingId)}/transcript`)
  } catch (e) {
    // 还没转写完是正常状态（家里 409 NOT_READY），告诉 AI 稍后再取，不算工具失败。
    if (e instanceof HttpError && e.code === 'NOT_READY') {
      return {
        ready: false,
        id: recordingId,
        text: `录音 ${recordingId} 还没转写完，稍后再用 beer_transcribe_result 取一次；也可以用 beer_transcribe_status 查看五步进度`,
      }
    }
    throw toolError(e, `取回录音 ${recordingId} 的转录结果`)
  }
  return transcriptView(transcript, recordingId)
}

/** 校验本机文件：绝对路径、存在、是文件、扩展名支持；返回上传用的文件名和类型。 */
async function localAudioFile(filePath, filename) {
  const path = typeof filePath === 'string' ? filePath.trim() : ''
  if (!path) throw new HttpError(400, 'file_path_missing', '缺少 filePath：请给本机音频文件的绝对路径')
  if (!isAbsolute(path)) throw new HttpError(400, 'file_path_not_absolute', `filePath 必须是绝对路径：${path}`)

  let info
  try {
    info = await stat(path)
  } catch (e) {
    if (e?.code === 'ENOENT') throw new HttpError(400, 'file_not_found', `文件不存在：${path}`)
    throw new HttpError(400, 'file_unreadable', `读不了这个文件：${path}（${e?.code ?? e?.message ?? e}）`)
  }
  if (!info.isFile()) throw new HttpError(400, 'file_not_file', `不是文件：${path}`)

  const ext = extname(path).toLowerCase()
  const contentType = AUDIO_TYPES.get(ext)
  if (!contentType) {
    throw new HttpError(400, 'file_unsupported', `不支持这种文件（${ext || '没有扩展名'}）：只支持常见音频和视频，例如 .m4a、.mp3、.wav、.mp4、.mov`)
  }
  const name = safeFilename(filename) || baseFilename(path)
  if (name === '.' || name === '..') {
    throw new HttpError(400, 'file_name_invalid', `filename 不能是「${name}」：要给一个正常的文件名`)
  }
  return { path, name, contentType, size: info.size }
}

/** 用流拼 multipart，不把整个录音读进内存；文件名用 RFC 5987 的 filename* 带中文。 */
async function postRecordingFile(ctx, file) {
  const boundary = '----beer-' + randomUUID()
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: ${contentDisposition(file.name)}\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Readable.from((async function* () {
    yield head
    for await (const chunk of createReadStream(file.path)) yield chunk
    yield tail
  })())
  return homeUpload(ctx, 'POST', '/recordings', {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(head.length + file.size + tail.length),
    },
    timeout: UPLOAD_TIMEOUT_MS,
  })
}

/** 文件名只留最后一段，去掉换行（不能进 HTTP 头）。 */
function safeFilename(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim().split(/[\\/]/).pop() ?? ''
  return name.replace(/[\r\n]/g, '_').trim()
}

function baseFilename(path) {
  return path.split(/[\\/]/).pop() ?? ''
}

/**
 * 文件名直接以 UTF-8 字节写进 filename（浏览器上传也是这么发的）。
 * 家里用 python-multipart + Starlette，它们按 UTF-8 解码 filename 的原始字节，
 * 但**不认** RFC 5987 的 filename*，所以这里不能用那套编码。
 */
function contentDisposition(filename) {
  const safe = filename.replace(/[\u0000-\u001f\u007f"\\]/g, '_')
  return `form-data; name="file"; filename="${safe}"`
}

/** 提交成功后的工具值：编号、文件名和五步状态摘要文本。 */
function submittedView(view, requestedName) {
  const id = typeof view.id === 'string' ? view.id : ''
  const filename = typeof view.filename === 'string' && view.filename ? view.filename : requestedName
  const progress = typeof view.progress === 'number' ? view.progress : 0
  return {
    id,
    filename,
    status: typeof view.status === 'string' ? view.status : '',
    progress,
    steps: normalizedSteps(view.steps),
    text: [
      `已提交转录：${filename}（录音编号 ${id}）`,
      `家里状态：${recordingStatusName(view.status)}，进度 ${progress}%`,
      ...stepLines(view.steps),
    ].join('\n'),
  }
}

/** 状态工具值：五步进度、整体状态和失败原因。 */
function statusView(view, fallbackId) {
  const id = typeof view?.id === 'string' && view.id ? view.id : fallbackId
  const filename = typeof view?.filename === 'string' ? view.filename : ''
  const status = typeof view?.status === 'string' ? view.status : ''
  const progress = typeof view?.progress === 'number' ? view.progress : 0
  const error = typeof view?.error === 'string' && view.error ? view.error : null
  const errorCode = typeof view?.error_code === 'string' && view.error_code ? view.error_code : null
  const lines = [
    `录音 ${id}${filename ? `（${filename}）` : ''}`,
    `家里状态：${recordingStatusName(status)}，进度 ${progress}%`,
    ...stepLines(view?.steps),
  ]
  if (error || errorCode) {
    lines.push(`错误：${error ?? errorCode}${error && errorCode ? `（${errorCode}）` : ''}`)
  }
  return { id, filename, status, progress, steps: normalizedSteps(view?.steps), error, errorCode, text: lines.join('\n') }
}

/** 结果工具值：文字稿 markdown 全文和摘要；没有摘要时明确说明。 */
function transcriptView(transcript, fallbackId) {
  const id = typeof transcript?.id === 'string' && transcript.id ? transcript.id : fallbackId
  const filename = typeof transcript?.filename === 'string' ? transcript.filename : ''
  const markdown = typeof transcript?.markdown === 'string' ? transcript.markdown : ''
  const summary = typeof transcript?.summary === 'string' && transcript.summary.trim() ? transcript.summary.trim() : null
  const text = [
    `录音 ${id}${filename ? `（${filename}）` : ''}的转录结果：`,
    `摘要：${summary ?? '暂无摘要（家里还没有生成摘要）'}`,
    '',
    markdown || '（家里没有返回文字稿）',
  ].join('\n')
  return { ready: true, id, filename, markdown, summary, text }
}

function requireRecordingId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new HttpError(400, 'id_missing', '缺少录音编号 id：用 beer_transcribe_submit 返回的 id')
  return id
}

/** 五步固定按 上传 → 排队 → 转写 → 摘要 → 入库 输出，家里缺字段也给出「待处理」。 */
function normalizedSteps(steps) {
  const byKey = new Map()
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (step && typeof step.key === 'string') byKey.set(step.key, step)
    }
  }
  return STEP_KEYS.map(key => {
    const status = typeof byKey.get(key)?.status === 'string' && byKey.get(key).status
      ? byKey.get(key).status
      : STEP_STATUS_NAMES.pending
    return { key, name: STEP_NAMES[key], status, statusName: STEP_STATUS_NAMES[status] ?? status }
  })
}

function stepLines(steps) {
  return normalizedSteps(steps).map(step => `${step.name}：${step.statusName}`)
}

function recordingStatusName(value) {
  return RECORDING_STATUS_NAMES[value] ?? (typeof value === 'string' && value ? value : '未知')
}

/** 家里调用失败 → 对话 AI 看得懂的中文错误；连不上必须带「家里暂时连不上」。 */
function toolError(e, action) {
  if (e instanceof HttpError) {
    if (e.code === 'home_unreachable') {
      return new Error(`家里暂时连不上，${action}失败。确认 Mac mini 和家里服务在线后再试`)
    }
    if (e.status === 401 || e.status === 403) {
      return new Error(`家里服务拒绝了访问（${e.code}），检查钥匙串里的 home-api-key 是否正确`)
    }
    if (e.code === 'NOT_FOUND') return new Error(`家里没有这条录音：${e.message}`)
    return new Error(`家里服务出错（${e.code}）：${e.message}`)
  }
  return new Error(`${action}失败：${e?.message ?? e}`)
}
