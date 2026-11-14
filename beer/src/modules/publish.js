// 发布分页：审核成稿和已确认的文章，主稿与平台版本逐行对照，确认后发布到 Rin 博客。
//   GET  /api/beer/publish[?includePublished=1]
//        → { articles: [{ path, title, status, main, versions: [{ platform, content, diff, userEdited }] }] }
//   POST /api/beer/publish/confirm { path } → 成稿 → 已确认 → 已发布（发布失败时停在已确认，可重试）
//   POST /api/beer/publish/retry { path }   → 对已确认的文章重跑发布
//
// 规则：
// - 默认只列「成稿」「已确认」的文章（归档区不列）；includePublished=1 时补上「已发布」，
//   给知乎 / 小红书发布包补记录和重看包用。#16 的 publish-packages.js 复用这里的
//   readArticle / setStatus / appendRecordLine。
// - main / content 都是去掉开头属性区的正文；diff 以主稿为基准，added 是平台版本新增的行。
// - 主稿只允许改 frontmatter 的 `状态:` / `状态时间:` 两行，正文逐字不动；改状态走 library.saveNote 的版本校验。
// - 图片：条目 images/ 下的图片全部上传，正文里的 images/x.png 换成上传后的地址；
//   Obsidian 的 ![[图片]] / ![[图片|300]] / ![[图片|说明]] 按 library.findAsset 的规则在库里找
//   （笔记所在文件夹 → 库根 → 整个库按文件名），上传后换成标准的 ![说明](地址)。
//   有一张 ![[图片]] 找不到就整篇不发（422 image_missing），一张图都不传。主稿正文不改。
// - Rin 博客接口：POST {rinApiBase}/api/feed 新建文章，POST {rinApiBase}/api/storage 上传图片，
//   用钥匙串里的 `rin-admin-username` / `rin-admin-password` 调 POST {rinApiBase}/api/auth/login
//   换管理员令牌（JWT，Rin 签 24 小时）。令牌只存在内存里：快过期时提前重新登录，
//   被拒（401/403）时重新登录一次再重试同一个请求。发布记录追加到条目里的 `发布记录.md`。
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { HttpError } from '../http/router.js'
import {
  STATUS_CONFIRMED,
  STATUS_FINAL,
  STATUS_PUBLISHED,
  articleIndexPath,
  parseFrontmatter,
  withStatusLine,
} from './articles.js'
import { createNote, findAsset, listFolder, locate, readNote, saveNote } from './library.js'
import { PLATFORMS, bodyOf, diffLineList } from './versions.js'
import { preparePackages } from './publish-packages.js'
import { versionEdited } from '../platform-versions.js'
import { localDateTime } from '../dates.js'

export const PUBLISHABLE_STATUSES = [STATUS_FINAL, STATUS_CONFIRMED]
export const RECORD_FILE = '发布记录.md'
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'])
const ARTICLES_DIR = '内容库/文章'
const IMAGE_DIR = 'images'
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}
const RIN_TIMEOUT_MS = 30_000
const USERNAME_NAME = 'rin-admin-username'
const PASSWORD_NAME = 'rin-admin-password'
// 离过期不到 5 分钟就当已过期；令牌里读不出 exp 时按 23 小时算（Rin 签的是 24 小时）。
const TOKEN_EARLY_EXPIRY_MS = 5 * 60_000
const TOKEN_FALLBACK_TTL_MS = 23 * 60 * 60_000
// 每个 Beer 上下文一份登录状态：{ base, token, expiresAt }。
const rinSessions = new WeakMap()
export const RIN_SECRET_NAMES = [USERNAME_NAME, PASSWORD_NAME]

/** 设置弹层改了 Rin 账号或密码后调用：丢掉内存里的令牌，下次发布用新账号密码重新登录。 */
export function forgetRinSession(ctx) {
  rinSessions.delete(ctx)
}

export function register(router, ctx) {
  router.get('/publish', async req => listPublishable(ctx, {
    includePublished: req.query.get('includePublished') === '1',
  }))
  router.post('/publish/confirm', async req => {
    const body = (await req.json()) ?? {}
    return confirmPublish(ctx, body.path)
  })
  router.post('/publish/retry', async req => {
    const body = (await req.json()) ?? {}
    return retryPublish(ctx, body.path)
  })
}

// ---- 列表 ----

/** `includePublished` 给发布分页补记录用：已发布的文章也能重看包、补另一个平台的链接。 */
async function listPublishable(ctx, { includePublished = false } = {}) {
  const statuses = includePublished ? [...PUBLISHABLE_STATUSES, STATUS_PUBLISHED] : PUBLISHABLE_STATUSES
  const listing = await listFolder(ctx, ARTICLES_DIR)
  if (!listing.exists) return { articles: [] }
  const articles = []
  for (const entry of listing.entries) {
    if (entry.kind !== 'folder' || entry.name.startsWith('.') || entry.name === '_归档') continue
    const path = entry.path + '/index.md'
    let note
    try {
      note = await readNote(ctx, path)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) continue // 不是文章条目
      throw e
    }
    const meta = parseFrontmatter(note.content)
    const status = meta['状态'] || ''
    if (!statuses.includes(status)) continue
    const main = bodyOf(note.content)
    const versions = []
    for (const platform of PLATFORMS) {
      const version = await readVersion(ctx, entry.path, platform, main)
      if (version) versions.push(version)
    }
    articles.push({
      path,
      title: meta['标题'] || stripDate(entry.name),
      status,
      main,
      versions,
      modifiedAt: note.modifiedAt,
    })
  }
  // 待确认的成稿在前，其次已确认，最后已发布；同状态里最近改过的在前；结果稳定。
  const rank = { [STATUS_FINAL]: 0, [STATUS_CONFIRMED]: 1, [STATUS_PUBLISHED]: 2 }
  articles.sort((a, b) => {
    if (a.status !== b.status) return rank[a.status] - rank[b.status]
    return b.modifiedAt.localeCompare(a.modifiedAt) || a.title.localeCompare(b.title, 'zh-Hans-CN')
  })
  return { articles: articles.map(({ modifiedAt, ...article }) => article) }
}

/** 读一个平台版本；不存在返回 null。userEdited 的判断和 versions.js 一致（frontmatter 里的生成内容版本）。 */
async function readVersion(ctx, folder, platform, main) {
  const path = folder + '/' + platform + '.md'
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  }
  const meta = parseFrontmatter(note.content)
  const content = bodyOf(note.content)
  const recorded = meta['生成内容版本'] || null
  return {
    platform,
    content,
    diff: diffLineList(main, content),
    // 没有生成元数据的平台文件视为用户自己写的，和 versions.js 一样。
    userEdited: versionEdited(content, recorded),
  }
}

function stripDate(name) {
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

// ---- 确认与发布 ----

/**
 * 确认发布：
 * 1. 成稿先把状态改成「已确认」（只动状态行）；已经是「已确认」的跳过这步，直接重跑发布。
 * 2. 上传条目 images/ 下的图片，替换正文里的相对路径，再调 Rin 的 /api/feed。
 * 3. 成功后状态改成「已发布」，并往 发布记录.md 追加一行。
 * 任何一步失败都不写发布记录，状态停在失败前的那一步（原状态或「已确认」）。
 */
async function confirmPublish(ctx, rawPath) {
  const article = await readArticle(ctx, rawPath)
  const status = article.meta['状态'] || ''
  if (status === STATUS_PUBLISHED) throw new HttpError(409, 'status_invalid', '这篇文章已经发布过了')
  if (!PUBLISHABLE_STATUSES.includes(status)) {
    throw new HttpError(409, 'status_invalid', '只有「成稿」或「已确认」的文章能发布')
  }
  if (status === STATUS_FINAL) await setStatus(ctx, article, STATUS_CONFIRMED)
  return finishPublish(ctx, article.path)
}

/** 重试：只对已确认（发布失败）的文章重跑发布，不重复改状态。 */
async function retryPublish(ctx, rawPath) {
  const article = await readArticle(ctx, rawPath)
  const status = article.meta['状态'] || ''
  if (status !== STATUS_CONFIRMED) {
    throw new HttpError(409, 'status_invalid', `当前状态是「${status || '无'}」，只有「已确认」的文章能重试发布`)
  }
  return finishPublish(ctx, article.path)
}

/** 发布本身：读最新主稿（状态已确认）→ 上传图片 → 提交 feed → 改状态 → 写记录。 */
async function finishPublish(ctx, path) {
  const article = await readArticle(ctx, path)
  const published = await publishToRin(ctx, article)

  // 发完再读一次主稿，只改状态行；中间用户在 Obsidian 里改了正文也逐字保留。
  const latest = await readArticle(ctx, path)
  await setStatus(ctx, latest, STATUS_PUBLISHED)
  const recordPath = await appendRecord(ctx, latest, published)
  const packages = await buildPublishPackages(ctx, latest.path)

  return {
    path: latest.path,
    status: STATUS_PUBLISHED,
    feedId: published.feedId,
    link: published.link,
    images: published.images,
    record: recordPath,
    publishedAt: ctx.now().toISOString(),
    ...packages,
  }
}

/**
 * 发布成功后顺手准备知乎 / 小红书发布包（只读库、写 Beer 数据目录，不向任何平台发请求）。
 * 包准备失败不影响已经成功的发布：回空数组和错误说明，文章状态和发布记录保持已发布。
 */
async function buildPublishPackages(ctx, path) {
  try {
    return { packages: await preparePackages(ctx, path) }
  } catch (e) {
    return { packages: [], packageError: e?.message ?? String(e) }
  }
}

/** 只替换 frontmatter 的 `状态:` / `状态时间:` 两行；带读取时的版本保存，被别处改过就 409。 */
export async function setStatus(ctx, article, status) {
  const content = withStatusLine(article.note.content, status, ctx.now().toISOString())
  const saved = await saveNote(ctx, article.path, content, article.note.version)
  if (saved.conflict) {
    throw new HttpError(409, 'edit_conflict', '这篇文章在你确认时被别处改过，状态没有保存，原文件保持不变')
  }
  return saved
}

// ---- Rin 博客 ----

async function publishToRin(ctx, article) {
  const base = String(ctx.config.rinApiBase ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new HttpError(503, 'rin_not_configured', '还没配置 Rin 博客接口地址（配置项 rinApiBase）')
  // 先拿到令牌：账号密码缺失或登录失败时，一张图片都不上传。
  await rinToken(ctx, base)

  const embeds = await resolveEmbeds(ctx, article)
  const uploaded = new Map() // 磁盘路径 → url，同一张图只传一次
  const images = await uploadImages(ctx, base, article, uploaded)
  let content = article.body
  for (const embed of embeds) {
    let url = uploaded.get(embed.file)
    if (!url) {
      const name = basename(embed.file)
      url = await uploadImage(ctx, base, embed.file, name, name.replace(/\s+/g, '-'))
      uploaded.set(embed.file, url)
      images.push({ name, url })
    }
    // 先换嵌入再换 images/ 路径，免得 ![[images/x.png]] 里的路径先被换掉
    content = content.split(embed.raw).join(`![${embed.alt}](${url})`)
  }
  for (const image of images) content = replaceImageRef(content, image.name, image.url)

  const payload = {
    title: article.meta['标题'] || firstBodyHeading(article.body),
    content,
    draft: false,
    listed: true,
    tags: [],
  }
  const summary = article.meta['摘要'] || article.meta['summary']
  if (summary) payload.summary = summary

  const res = await rinFetch(ctx, base, '/api/feed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await readJson(res)
  const feedId = data?.insertedId ?? data?.id
  if (!isId(feedId)) {
    throw new HttpError(502, 'rin_bad_response', 'Rin 博客没有返回文章编号，发布结果无法确认')
  }
  const rawLink = typeof data?.url === 'string' ? data.url.trim() : ''
  const link = rawLink ? (rawLink.startsWith('/') ? base + rawLink : rawLink) : null
  return { feedId: String(feedId), link, images }
}

/** 逐张上传条目 images/ 下的图片；返回 [{ name, url }]，顺序按文件夹列表。uploaded 记下 磁盘路径 → url。 */
async function uploadImages(ctx, base, article, uploaded) {
  const listing = await listFolder(ctx, article.folder + '/' + IMAGE_DIR)
  if (!listing.exists) return []
  const images = []
  for (const entry of listing.entries) {
    if (entry.kind !== 'file') continue
    if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    const file = await locate(ctx, entry.path)
    const url = await uploadImage(ctx, base, file, entry.name, entry.name)
    uploaded.set(file, url)
    images.push({ name: entry.name, url })
  }
  return images
}

async function uploadImage(ctx, base, file, name, key) {
  const bytes = await readFile(file)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: IMAGE_TYPES[extname(name).toLowerCase()] }), name)
  form.append('key', key)
  const res = await rinFetch(ctx, base, '/api/storage', { method: 'POST', body: form })
  const data = await readJson(res)
  if (typeof data?.url !== 'string' || !data.url) {
    throw new HttpError(502, 'rin_bad_response', `Rin 博客没有返回「${name}」的地址，发布失败`)
  }
  return data.url
}

const EMBED_PATTERN = /!\[\[([^\]\n]+?)\]\]/g

/**
 * 找出正文里的 Obsidian 图片嵌入 ![[目标|别名]]，在库里定位文件。不是图片的嵌入（笔记等）不管。
 * 别名是数字（300、300x200）时是 Obsidian 的显示尺寸，不当说明文字。
 * 有找不到的就报 422，列出全部缺的图。
 */
async function resolveEmbeds(ctx, article) {
  const embeds = []
  const missing = []
  for (const match of article.body.matchAll(EMBED_PATTERN)) {
    const [target, ...rest] = match[1].split('|')
    const name = target.split('#')[0].trim()
    if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue
    const alias = rest.join('|').trim()
    try {
      const file = await findAsset(ctx, name, article.path)
      embeds.push({ raw: match[0], alt: /^\d+(x\d+)?$/.test(alias) ? '' : alias, file })
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 400)) throw e
      if (!missing.includes(name)) missing.push(name)
    }
  }
  if (missing.length) {
    throw new HttpError(422, 'image_missing', `库里找不到这些图片：${missing.join('、')}，没有发布`)
  }
  return embeds
}

/** 把正文里指向图片的相对路径（images/x.png、./images/x.png）换成上传后的地址。 */
function replaceImageRef(content, name, url) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return content.replace(new RegExp(`(?:\\./)?${IMAGE_DIR}/${escaped}`, 'g'), () => url)
}

/**
 * 调 Rin 接口：统一超时、鉴权头和错误码。令牌被拒时重新登录一次、重发同一个请求；
 * 新令牌也被拒才报错（被拒说明请求没生效，重发不会重复建文章）。
 */
async function rinFetch(ctx, base, path, init = {}) {
  let res = await rinSend(ctx, base + path, await rinToken(ctx, base), init)
  if (isDenied(res)) {
    res = await rinSend(ctx, base + path, await rinToken(ctx, base, { fresh: true }), init)
    if (isDenied(res)) {
      throw new HttpError(502, 'rin_unauthorized', 'Rin 博客刚登录拿到的管理员令牌也被拒绝了，请检查博客账号是否还有管理员权限')
    }
  }
  if (!res.ok) throw new HttpError(502, 'rin_upstream_error', `Rin 博客返回 ${res.status}，发布失败`)
  return res
}

async function rinSend(ctx, url, token, init) {
  try {
    return await ctx.fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(RIN_TIMEOUT_MS),
    })
  } catch {
    throw new HttpError(502, 'rin_unreachable', '连不上 Rin 博客，发布失败')
  }
}

const isDenied = res => res.status === 401 || res.status === 403

/** 取管理员令牌：内存里有且没快过期就直接用，否则用钥匙串里的账号密码登录一次。 */
async function rinToken(ctx, base, { fresh = false } = {}) {
  const now = ctx.now().getTime()
  const cached = rinSessions.get(ctx)
  if (!fresh && cached && cached.base === base && cached.expiresAt - TOKEN_EARLY_EXPIRY_MS > now) {
    return cached.token
  }
  rinSessions.delete(ctx)

  const { username, password } = await rinCredentials(ctx)
  let res
  try {
    res = await ctx.fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(RIN_TIMEOUT_MS),
    })
  } catch {
    throw new HttpError(502, 'rin_unreachable', '连不上 Rin 博客，登录失败')
  }
  if (res.status === 429) {
    throw new HttpError(502, 'rin_login_rate_limited', 'Rin 博客登录太频繁，暂时被拒绝，过几分钟再试')
  }
  if (res.status === 400 || isDenied(res)) {
    throw new HttpError(502, 'rin_login_failed', 'Rin 博客不认钥匙串里的账号密码（rin-admin-username / rin-admin-password），请检查后重试')
  }
  if (!res.ok) throw new HttpError(502, 'rin_upstream_error', `Rin 博客登录返回 ${res.status}`)
  const token = (await readJson(res))?.token
  if (typeof token !== 'string' || !token) {
    throw new HttpError(502, 'rin_bad_response', 'Rin 博客登录成功但没有返回令牌')
  }
  rinSessions.set(ctx, { base, token, expiresAt: jwtExpiresAt(token) ?? now + TOKEN_FALLBACK_TTL_MS })
  return token
}

async function rinCredentials(ctx) {
  let username
  let password
  try {
    username = await ctx.secrets.get(USERNAME_NAME)
    password = await ctx.secrets.get(PASSWORD_NAME)
  } catch {
    throw new HttpError(503, 'rin_no_credentials', '读不出钥匙串里的 Rin 博客账号密码（钥匙串可能已锁定）')
  }
  if (!username || !password) {
    throw new HttpError(503, 'rin_no_credentials', '钥匙串里还没有 Rin 博客的账号密码（账号名 rin-admin-username、rin-admin-password）')
  }
  return { username, password }
}

/** 读 JWT 里的 exp（秒）换成毫秒；读不出时回 undefined。不校验签名，只用来判断何时重新登录。 */
function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function readJson(res) {
  return res.json().catch(() => undefined)
}

function isId(value) {
  return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value))
}

function firstBodyHeading(body) {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : '未命名'
}

// ---- 发布记录 ----

/** 读条目里的发布记录；没有时回空内容，不建文件。 */
export async function readRecord(ctx, folder) {
  const path = folder + '/' + RECORD_FILE
  try {
    const note = await readNote(ctx, path)
    return { path, content: note.content, version: note.version }
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { path, content: '', version: null }
    throw e
  }
}

/** 发布记录里的一行：`- <YYYY-MM-DD HH:mm> <平台> <链接>`。 */
export function formatRecordLine(date, platform, target) {
  return `- ${localDateTime(date)} ${platform} ${target}`
}

/**
 * 往条目里的 发布记录.md 追加一行；文件不存在就新建，已有内容原样保留。
 * `skipIf(现有内容)` 为真时视为已经有了，不写文件（回 appended: false）。
 * @returns {Promise<{ path: string, appended: boolean }>}
 */
export async function appendRecordLine(ctx, folder, line, { skipIf } = {}) {
  const path = folder + '/' + RECORD_FILE
  const record = await readRecord(ctx, folder)
  if (skipIf && skipIf(record.content)) return { path, appended: false }
  const separator = record.content && !record.content.endsWith('\n') ? '\n' : ''
  const content = record.content + separator + line + '\n'
  if (record.version) {
    const saved = await saveNote(ctx, path, content, record.version)
    if (saved.conflict) throw new HttpError(409, 'edit_conflict', '发布记录.md 刚被别处改过，没有写入这一行')
  } else {
    try {
      await createNote(ctx, path, content)
    } catch (e) {
      if (e instanceof HttpError && e.code === 'file_exists') {
        throw new HttpError(409, 'edit_conflict', '发布记录.md 刚被别处改过，没有写入这一行')
      }
      throw e
    }
  }
  return { path, appended: true }
}

async function appendRecord(ctx, article, published) {
  const target = published.link || published.feedId
  const result = await appendRecordLine(ctx, article.folder, formatRecordLine(ctx.now(), 'Rin 博客', target))
  return result.path
}

/** 发布记录里的本地时间：`YYYY-MM-DD HH:mm` 由 dates.localDateTime 统一给出。 */

// ---- 主稿 ----

/** 读文章的 index.md（也接受条目文件夹路径），并解析开头属性和正文。 */
export async function readArticle(ctx, rawPath) {
  const path = articleIndexPath(rawPath)
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, 'not_found', '库里没有这篇文章')
    throw e
  }
  return {
    path,
    folder: path.slice(0, -'/index.md'.length),
    note,
    meta: parseFrontmatter(note.content),
    body: bodyOf(note.content),
  }
}
