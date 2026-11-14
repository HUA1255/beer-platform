// 素材导入（#12）：把链接、本地图片 / PDF、文字整理成素材条目，供面板接口和 AI 工具共用。
//   POST /api/beer/materials/import/url { url, title?, tags?, type? }  → 201 { entry }
//     B 站 / YouTube 视频链接（#34）不当场写条目：交给家里转写，→ 202 { video }（家里的录音视图），
//     进度在录音分页看，转写完由录音分页的取回写成「视频」条目。家里连不上 → 502「家里暂时连不上」。
//   POST /api/beer/materials/import/file { filePath, title?, type?, tags?, summary? } → 201 { entry }
//   POST /api/beer/materials/import/text { title, content, tags?, type? } → 201 { entry }
// 条目结构和手动素材一样：`内容库/素材/<日期>-<名称>/index.md`，开头属性至少写标题、类型、标签、
// 状态（待整理）、来源、日期。标签先经 materials.js 的 assertKnownTags 校验，不在标签表里 → 400
// tag_unknown，一个文件都不写；抓页面失败 → 502 fetch_failed，也不留半成品。
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { HttpError, reply } from '../http/router.js'
import { createEntry } from './library.js'
import { submitVideo } from './recordings.js'
import { localDate } from '../dates.js'
import {
  MATERIALS_FOLDER,
  GUIDE_PATH,
  TAGS_PATH,
  DEFAULT_TYPES,
  assertKnownTags,
  createMaterial,
  ensureMaterialsInit,
  readMaterialEntry,
  requireTitle,
} from './materials.js'

const FETCH_TIMEOUT_MS = 20_000
const MAX_ARTICLE_CHARS = 200_000
// 普通浏览器 UA：不少站点会拒绝 Node 默认的 `node` UA。
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 视频站只保存页面标题和简介，不抓正文。 */
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'vimeo.com', 'douyin.com']

/** 这几个站的视频交给家里转出文字稿和摘要（#34），和家里服务 POST /videos 收的一致。 */
const TRANSCRIBE_HOSTS = ['bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be']

/** 本地文件导入支持的后缀，以及写进 `类型:` 的值。 */
const FILE_TYPES = new Map([
  ['.jpg', '图片'],
  ['.jpeg', '图片'],
  ['.png', '图片'],
  ['.gif', '图片'],
  ['.webp', '图片'],
  ['.avif', '图片'],
  ['.pdf', 'PDF'],
])

export function register(router, ctx) {
  router.post('/materials/import/url', async req => {
    const body = (await req.json()) ?? {}
    const url = normalizeUrl(body.url)
    if (isTranscribableVideo(url)) return reply(202, { video: await submitVideoLink(ctx, url) })
    const entry = await importUrl(ctx, body)
    return reply(201, { entry })
  })
  router.post('/materials/import/file', async req => {
    const entry = await importFile(ctx, (await req.json()) ?? {})
    return reply(201, { entry })
  })
  router.post('/materials/import/text', async req => {
    const entry = await createTextMaterial(ctx, (await req.json()) ?? {})
    return reply(201, { entry })
  })
}

/**
 * 导入一个链接。
 * - 视频站：只存 `og:title` / `<title>`、`og:description` / `meta description`，类型固定「链接」。
 * - 普通文章：去掉 script/style/nav/header/footer/aside，优先 `<article>`，其次 `<body>`，
 *   转成纯文本后最多留 200k 字符。
 */
export async function importUrl(ctx, body = {}) {
  const url = normalizeUrl(body.url)
  if (body.type === '视频') throw new HttpError(400, 'url_invalid', '「视频」素材只支持 B 站和 YouTube 的视频链接')
  const tags = await assertKnownTags(ctx, body.tags ?? [])
  const video = isVideoUrl(url)
  const html = await fetchHtml(ctx, url)
  const meta = pageMeta(html)
  const fetchedTitle = cleanFetchedTitle(meta.title) || cleanFetchedTitle(titleFromUrl(url))
  const title = optionalTitle(body.title, fetchedTitle)
  // 视频站规定记「链接」；普通链接允许调用方显式指定类型。
  const type = video ? '链接' : optionalType(body.type, '链接')
  const content = video ? videoSummary(meta, url) : articleText(html) || meta.description || '（页面没有可提取的正文）'
  return writeImportedEntry(ctx, {
    title,
    type,
    tags,
    source: url.toString(),
    content,
  })
}

/**
 * 导入本地图片或 PDF：原文件保留文件名复制进条目文件夹，`index.md` 写
 * `类型: 图片|PDF`、`原件: <原文件名>`、`来源: 本地文件`；正文用调用方给的摘要，
 * 没有摘要就写「（待补充）」（识别不了文字的扫描件只存原文件）。
 */
export async function importFile(ctx, body = {}) {
  const { filePath, name, type: kind } = localFileOf(body.filePath)
  if (body.type !== undefined && body.type !== null && body.type !== '') {
    if (typeof body.type !== 'string' || body.type.trim() !== kind) {
      throw new HttpError(400, 'type_invalid', `这个文件的类型是「${kind}」，和 type 对不上`)
    }
  }
  const tags = await assertKnownTags(ctx, body.tags ?? [])
  const title = optionalTitle(body.title, cleanFetchedTitle(basename(filePath, extname(filePath))) || '未命名')
  const summary = optionalText(body.summary, '摘要', 'summary_invalid')
  const bytes = await readSourceFile(filePath)

  return writeImportedEntry(ctx, {
    title,
    type: kind,
    tags,
    source: '本地文件',
    content: summary || '（待补充）',
    extra: { 原件: name },
    files: { [name]: bytes },
  })
}

/** 校验本地文件：必须是绝对路径、存在且是文件、后缀在支持列表里，否则 400。 */
function localFileOf(filePath) {
  if (typeof filePath !== 'string' || !filePath || !isAbsolute(filePath)) {
    throw new HttpError(400, 'file_path_invalid', 'filePath 必须是本地文件的绝对路径')
  }
  const ext = extname(filePath).toLowerCase()
  const kind = FILE_TYPES.get(ext)
  if (!kind) {
    throw new HttpError(400, 'file_type_invalid', '只支持图片（jpg/jpeg/png/gif/webp/avif）和 PDF')
  }
  const name = basename(filePath)
  if (!name) throw new HttpError(400, 'file_path_invalid', 'filePath 必须指向一个文件')
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, 'file_path_invalid', '文件名里不能有换行等控制字符')
  }
  return { filePath, name, type: kind }
}

async function readSourceFile(filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    throw new HttpError(400, 'file_path_invalid', '这个文件不存在，无法导入')
  }
  if (!info.isFile()) throw new HttpError(400, 'file_path_invalid', 'filePath 必须指向一个文件，不能是文件夹')
  try {
    return await readFile(filePath)
  } catch {
    throw new HttpError(400, 'file_read_failed', '读不到这个文件，检查一下权限')
  }
}

function optionalText(value, label, code) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new HttpError(400, code, `${label}必须是字符串`)
  return value.trim()
}

/** 文字素材：正文直接写进条目，类型固定「文字」。 */
export async function createTextMaterial(ctx, body = {}) {
  const title = requireTitle(body.title)
  const content = optionalText(body.content, '正文', 'content_invalid')
  if (!content) throw new HttpError(400, 'content_invalid', '正文不能为空')
  if (body.type !== undefined && body.type !== null && body.type !== '') {
    if (typeof body.type !== 'string' || body.type.trim() !== '文字') {
      throw new HttpError(400, 'type_invalid', '文字素材的类型只能是「文字」')
    }
  }
  const tags = await assertKnownTags(ctx, body.tags ?? [])
  return writeImportedEntry(ctx, {
    title,
    type: '文字',
    tags,
    source: '手动录入',
    content,
  })
}

async function writeImportedEntry(ctx, { title, type, tags, source, content, extra = {}, files = {} }) {
  const date = localDate(ctx.now())
  const note = importedNote({ title, type, tags, source, date, content, extra })
  // 先保证说明文件和标签表存在（已有的不动），再落条目；AI 下次整理时一定有东西可读。
  await ensureMaterialsInit(ctx)
  const created = await createEntry(ctx, MATERIALS_FOLDER, `${date}-${title}`, { ...files, 'index.md': note })
  return readMaterialEntry(ctx, created.path)
}

/** 导入条目的开头属性：标题、类型、标签、状态、来源、额外属性、日期。 */
function importedNote({ title, type, tags, source, date, content, extra }) {
  const lines = [
    '---',
    `标题: ${title}`,
    `类型: ${type}`,
    `标签: [${tags.join(', ')}]`,
    '状态: 待整理',
    `来源: ${source}`,
    ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
    `日期: ${date}`,
    '---',
    `# ${title}`,
    '',
  ]
  const text = String(content ?? '').trim()
  return lines.join('\n') + '\n' + (text ? text + '\n' : '')
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HttpError(400, 'url_invalid', 'url 必须是 http 或 https 链接')
  }
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    throw new HttpError(400, 'url_invalid', 'url 不是合法的链接')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'url_invalid', '只支持 http 或 https 链接')
  }
  return url
}

function isVideoUrl(url) {
  return hostIn(url, VIDEO_HOSTS)
}

function hostIn(url, sites) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  return sites.some(site => host === site || host.endsWith(`.${site}`))
}

/** B 站 / YouTube 的链接：交给家里转写，不在这里抓页面。 */
export function isTranscribableVideo(url) {
  return hostIn(url, TRANSCRIBE_HOSTS)
}

/** 把视频链接交给家里；连不上时直接失败（不排队），并说清楚视频没提交。 */
async function submitVideoLink(ctx, url) {
  try {
    return await submitVideo(ctx, url.toString())
  } catch (e) {
    if (e instanceof HttpError && e.code === 'home_unreachable') {
      throw new HttpError(502, 'home_unreachable', '家里暂时连不上，视频没有提交；确认 Mac mini 在线后再试')
    }
    throw e
  }
}

/** 抓页面：20 秒超时、普通浏览器 UA；网络错误、超时、非 2xx 一律 502 fetch_failed。 */
async function fetchHtml(ctx, url) {
  let res
  try {
    res = await ctx.fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
  } catch (e) {
    throw new HttpError(502, 'fetch_failed', `抓取页面失败：${fetchReason(e)}`)
  }
  if (!res.ok) throw new HttpError(502, 'fetch_failed', `抓取页面失败：对方返回 ${res.status}`)
  try {
    return await res.text()
  } catch (e) {
    throw new HttpError(502, 'fetch_failed', `抓取页面失败：${fetchReason(e)}`)
  }
}

function fetchReason(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return '请求超时'
  return '连不上这个网址'
}

/** 页面标题和简介：og 优先，其次 `<title>` / `meta description`。 */
function pageMeta(html) {
  return {
    title: metaContent(html, ['og:title', 'twitter:title']) || tagText(html, 'title'),
    description: metaContent(html, ['og:description', 'twitter:description', 'description']),
  }
}

function metaContent(html, keys) {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? []
  const wanted = new Set(keys.map(key => key.toLowerCase()))
  for (const tag of metas) {
    const attrs = attributesOf(tag)
    const name = (attrs.property ?? attrs.name ?? '').trim().toLowerCase()
    if (!wanted.has(name)) continue
    const content = decodeEntities(attrs.content ?? '').replace(/\s+/g, ' ').trim()
    if (content) return content
  }
  return ''
}

function tagText(html, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(html)
  return m ? decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : ''
}

/** 解析一个标签里的属性；属性顺序不重要，值可以用单引号、双引号或裸写。 */
function attributesOf(tag) {
  const attrs = {}
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  for (const m of tag.matchAll(re)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

/** 文章正文：去掉脚本、样式、导航、页头页脚和侧栏，优先 article，其次 body。 */
function articleText(html) {
  const cleaned = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|nav|header|footer|aside|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const article = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(cleaned)
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(cleaned)
  const fragment = article ? article[1] : body ? body[1] : cleaned
  return htmlToText(fragment).slice(0, MAX_ARTICLE_CHARS)
}

/** HTML 转纯文本：块级标签换行，去掉剩余标签，解实体，压缩连续空行。 */
function htmlToText(html) {
  const withBreaks = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|li|h[1-6]|blockquote|pre|figure|figcaption|tr|ul|ol|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(withBreaks)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const NAMED_ENTITIES = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
}

/** 解常用 HTML 实体；`&amp;` 最后解，免得 `&amp;lt;` 被解成 `<`。 */
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, name) => {
      const key = name.toLowerCase()
      if (key === 'amp') return m
      return NAMED_ENTITIES[key] ?? m
    })
    .replace(/&amp;/gi, '&')
}

function codePoint(code) {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ''
  return String.fromCodePoint(code)
}

function videoSummary(meta, url) {
  const lines = []
  if (meta.title) lines.push(`标题：${meta.title}`)
  if (meta.description) lines.push(`简介：${meta.description}`)
  lines.push(`链接：${url.toString()}`)
  return lines.join('\n\n')
}

function titleFromUrl(url) {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last) || url.hostname
  } catch {
    return last || url.hostname
  }
}

/** 抓来的标题可能是网页里的多行文本：压成一行，截到 100 个字（不切断代理对）。 */
function cleanFetchedTitle(text) {
  const line = String(text ?? '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()
  return [...line].slice(0, 100).join('')
}

function optionalTitle(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return requireTitle(value)
}

function optionalType(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !DEFAULT_TYPES.includes(value.trim())) {
    throw new HttpError(400, 'type_invalid', `类型只能是 ${DEFAULT_TYPES.join('、')}`)
  }
  return value.trim()
}

/**
 * AI 工具 `beer_save_material` 的执行逻辑：按参数里的字段选择导入方式。
 * 不经过 HTTP，直接调本模块的函数；失败时抛带中文原因的 HttpError。
 */
export async function saveMaterial(ctx, args = {}) {
  const title = requireTitle(args.title)
  const type = materialTypeOf(args)
  const tags = args.tags ?? []

  if (type === '视频' || (type === '链接' && isTranscribableArg(args.url))) {
    const url = typeof args.url === 'string' && args.url.trim() ? normalizeUrl(args.url) : null
    if (!url || !isTranscribableVideo(url)) {
      throw new HttpError(400, 'url_invalid', '「视频」素材要提供 B 站或 YouTube 的视频链接 url')
    }
    return { video: await submitVideoLink(ctx, url) }
  }
  if (type === '链接') {
    if (typeof args.url !== 'string' || !args.url.trim()) {
      throw new HttpError(400, 'url_invalid', '链接素材要提供 url')
    }
    return importUrl(ctx, { url: args.url, title, tags, type: '链接' })
  }
  if (type === '图片' || type === 'PDF') {
    if (typeof args.filePath !== 'string' || !args.filePath) {
      throw new HttpError(400, 'file_path_invalid', '图片或 PDF 素材要提供本地文件的绝对路径 filePath')
    }
    return importFile(ctx, { filePath: args.filePath, title, tags, type, summary: args.summary })
  }
  if (type === '文字') {
    const content = textOf(args.content) || textOf(args.summary)
    return createTextMaterial(ctx, { title, content, tags, type: '文字' })
  }
  if (type === '手动') {
    return createMaterial(ctx, {
      title,
      type: '手动',
      tags,
      content: textOf(args.content) || textOf(args.summary),
      source: typeof args.url === 'string' && args.url.trim() ? args.url.trim() : '手动录入',
    })
  }
  throw new HttpError(400, 'type_invalid', `类型只能是 ${DEFAULT_TYPES.join('、')}`)
}

/** 没给 type 时按参数推断：url → 链接，filePath → 图片/PDF，有正文 → 文字，其余手动。 */
function materialTypeOf(args) {
  const raw = typeof args.type === 'string' ? args.type.trim() : ''
  if (raw) {
    if (!DEFAULT_TYPES.includes(raw)) throw new HttpError(400, 'type_invalid', `类型只能是 ${DEFAULT_TYPES.join('、')}`)
    return raw
  }
  if (typeof args.url === 'string' && args.url.trim()) return '链接'
  if (typeof args.filePath === 'string' && args.filePath.trim()) {
    const kind = FILE_TYPES.get(extname(args.filePath).toLowerCase())
    if (!kind) throw new HttpError(400, 'file_type_invalid', '只支持图片（jpg/jpeg/png/gif/webp/avif）和 PDF')
    return kind
  }
  if (textOf(args.content) || textOf(args.summary)) return '文字'
  return '手动'
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isTranscribableArg(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try {
    const url = new URL(raw.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && isTranscribableVideo(url)
  } catch {
    return false
  }
}

/** 视频提交后给 AI 看的文本：说清楚去哪看进度、什么时候出条目。 */
export function formatVideoSubmission(video) {
  return [
    `已把视频交给家里转写：${video?.source_url ?? video?.title ?? ''}（编号 ${video?.id ?? '未知'}）`,
    '进度在录音分页里看（提交链接 → 排队 → 转写 → 摘要 → 入库）；有字幕的视频直接用字幕，没有才跑语音识别。',
    '转写完会发邮件通知，录音分页取回后在素材栏出现一条类型为「视频」的条目，带摘要和全文。',
    '视频条目的标题用视频本身的标题，不带标签；需要标签的话等条目出来后再补。',
  ].join('\n')
}

/** 工具执行结果给 AI 看的文本：新条目路径和属性。 */
export function formatMaterialEntry(entry) {
  return [
    `已写入素材：${entry.path}`,
    `标题：${entry.title}`,
    `类型：${entry.type}`,
    `标签：${entry.tags.length ? entry.tags.join('、') : '（无）'}`,
    `状态：${entry.status}`,
    `来源：${entry.source}`,
  ].join('\n')
}

/**
 * 组装 `beer_save_material` 工具定义。index.js 只负责把 `@deepseek-ai/dsh-tools` 的
 * `defineTool` 和业务上下文传进来并注册。
 */
export function createSaveMaterialTool(defineTool, ctx) {
  return defineTool({
    name: 'beer_save_material',
    description: [
      '把用户丢进对话的链接、图片、PDF 或文字整理成一条素材，写进 Obsidian 库的 内容库/素材/。',
      `写之前必须先读 ${GUIDE_PATH} 里的条目格式和类型说明，再读 ${TAGS_PATH}；`,
      '标签只能从标签表里选，表里没有的标签会被拒绝，需要新标签时先让用户改标签表。',
      '文章链接抓正文；B 站和 YouTube 的视频链接交给家里转出文字稿和摘要（几分钟后在素材栏出现「视频」条目），',
      '其他视频站只存页面标题和简介。',
    ].join(''),
    parameters: {
      title: { type: 'string', required: true, description: '素材标题，必填' },
      type: {
        type: 'string',
        enum: ['链接', '视频', '图片', 'PDF', '文字', '手动'],
        description: '素材类型；不填时按 url / filePath / content 推断。B 站、YouTube 链接按「视频」处理',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签数组，可以为空；每个标签都必须在 内容库/素材/标签表.md 里',
      },
      url: { type: 'string', description: '链接来源；type 为「链接」「视频」或只给 url 时用' },
      filePath: { type: 'string', description: '本地图片或 PDF 的绝对路径；type 为「图片」「PDF」时用' },
      content: { type: 'string', description: '文字正文；type 为「文字」时用' },
      summary: { type: 'string', description: '摘要；图片、PDF 识别文字后的摘要，或文字素材的正文' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    presentCall: args => ({ card: 'generic', kind: 'other', title: '整理素材', rawInput: args }),
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const saved = await saveMaterial(ctx, args)
      return saved?.video ? formatVideoSubmission(saved.video) : formatMaterialEntry(saved)
    },
  })
}
