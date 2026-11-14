// 文章：在 `内容库/文章/` 下新建条目、列条目、改状态、改标题、归档、删除，以及给 AI 帮手生成 prompt。
//   POST /api/beer/articles { title }             → 201 { path, folder, title, status: '选题' }
//   GET  /api/beer/articles?status=&includeArchived=1 → { articles: [{ path, folder, title, status, date, modifiedAt, statusTime, words, archived }] }
//   POST /api/beer/articles/status { path, status }   → { path, status, askGeneratePlatformVersions? }
//   POST /api/beer/articles/title { path, title }     → { path, title }
//   POST /api/beer/articles/archive { path }          → { path, folder }
//   POST /api/beer/articles/delete { path }           → { path, trashedTo }
//   GET  /api/beer/articles/assist?path=&kind=outline|facts|counter|titles → { prompt }
//
// 条目 = `内容库/文章/<YYYY-MM-DD>-<名称>/index.md`。主稿正文只由用户写：
// 改状态只动 frontmatter 的 `状态:` 和 `状态时间:` 两行，改标题只动正文第一个 `# ` 行，
// 程序不写正文其他内容。`状态时间:` 是这次改状态的时间（ISO），首页「等了几天」和「确认时间」都按它算；
// 旧文章没有这个字段时首页退回文件修改时间（见 README）。
// 文件读写一律经 library.js 的 locate / listFolder / readNote / createNote / saveNote；
// 删除复用 trash.js 的 moveToTrash，归档只在库内移动文件夹。
import { lstat, mkdir, rename } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { HttpError, reply } from '../http/router.js'
import { createNote, listFolder, locate, readNote, saveNote } from './library.js'
import { moveToTrash } from './trash.js'
import { bodyOf } from '../platform-versions.js'
import { localDate } from '../dates.js'

export const ARTICLES_DIR = '内容库/文章'
export const ARCHIVE_DIR = ARTICLES_DIR + '/_归档'
/** 记录这次改状态的时间，首页算「等了几天」和「确认时间」用。 */
export const STATUS_TIME_KEY = '状态时间'
/** 三个只能由写作流程进入的状态；「已确认」「已发布」只能由发布流程改。 */
export const STATUS_TOPIC = '选题'
export const STATUS_DRAFT = '草稿'
export const STATUS_FINAL = '成稿'
export const STATUS_CONFIRMED = '已确认'
export const STATUS_PUBLISHED = '已发布'
export const STATUSES = [STATUS_TOPIC, STATUS_DRAFT, STATUS_FINAL, STATUS_CONFIRMED, STATUS_PUBLISHED]
/** 用户能手动切换的状态。 */
export const MANUAL_STATUSES = [STATUS_TOPIC, STATUS_DRAFT, STATUS_FINAL]
const ARCHIVED_FILTER = '已归档'

export function register(router, ctx) {
  router.post('/articles', async req => {
    const body = (await req.json()) ?? {}
    return reply(201, await createArticle(ctx, body.title))
  })
  router.get('/articles', async req => listArticles(ctx, req.query))
  router.post('/articles/status', async req => {
    const body = (await req.json()) ?? {}
    return updateStatus(ctx, body.path, body.status, body.baseVersion)
  })
  router.post('/articles/title', async req => {
    const body = (await req.json()) ?? {}
    return updateTitle(ctx, body.path, body.title, body.baseVersion)
  })
  router.post('/articles/archive', async req => {
    const body = (await req.json()) ?? {}
    return archiveArticle(ctx, body.path)
  })
  router.post('/articles/delete', async req => {
    const body = (await req.json()) ?? {}
    return deleteArticle(ctx, body.path)
  })
  router.get('/articles/assist', async req => assist(ctx, req.query.get('path'), req.query.get('kind')))
}

/** 新建一篇「选题」文章，返回 { path, folder, title, status }；选题等模块直接复用。 */
export async function createArticle(ctx, rawTitle) {
  const title = cleanTitle(rawTitle)
  if (!title) throw new HttpError(400, 'title_invalid', '文章标题不能为空')
  return withLock(async () => {
    const date = localDate(ctx.now())
    const folder = await freeFolder(ctx, `${ARTICLES_DIR}/${date}-${safeName(title)}`)
    const path = folder + '/index.md'
    await createNote(ctx, path, newArticleContent(title, date))
    return { path, folder, title, status: STATUS_TOPIC }
  })
}

/** 新建条目的固定开头；正文只有一行 H1，之后由用户自己写。 */
function newArticleContent(title, date) {
  return `---\n标题: ${title}\n状态: 选题\n日期: ${date}\n---\n\n# ${title}\n`
}

async function listArticles(ctx, query) {
  return {
    articles: await readArticles(ctx, {
      status: query.get('status') ?? '',
      includeArchived: query.get('includeArchived') === '1',
    }),
  }
}

/**
 * 按状态列文章（供选题等模块复用）：默认不列归档区；`status` 为空时列全部，
 * `status` 是「已归档」时只列归档区，`includeArchived` 让两边一起列。
 */
export async function readArticles(ctx, { status = '', includeArchived = false } = {}) {
  const wantArchived = status === ARCHIVED_FILTER
  const [normal, archived] = await Promise.all([
    readArticleFolders(ctx, ARTICLES_DIR, false),
    includeArchived || wantArchived ? readArticleFolders(ctx, ARCHIVE_DIR, true) : [],
  ])
  let articles = wantArchived ? archived : includeArchived ? [...normal, ...archived] : normal
  if (status && !wantArchived) articles = articles.filter(a => a.status === status)
  // 最近改过的在前；同一时间按标题排，结果稳定。
  articles.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return articles
}

/** 列一个目录下的文章条目（只认带 index.md 的直接子文件夹），跳过隐藏文件夹。 */
async function readArticleFolders(ctx, dir, archived) {
  const listing = await listFolder(ctx, dir)
  if (!listing.exists) return []
  const articles = []
  for (const entry of listing.entries) {
    if (entry.kind !== 'folder' || entry.name.startsWith('.')) continue
    if (!archived && entry.name === '_归档') continue // 归档区只通过「已归档」筛选取
    const path = entry.path + '/index.md'
    let note
    try {
      note = await readNote(ctx, path)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) continue // 不是条目，或者用户手动改过
      throw e
    }
    const meta = parseFrontmatter(note.content)
    articles.push({
      path,
      folder: entry.path,
      title: meta['标题'] || stripDate(entry.name),
      status: meta['状态'] || '',
      date: meta['日期'] || datePrefix(entry.name),
      modifiedAt: note.modifiedAt,
      // 旧文章没有 状态时间 时为 null，由首页决定退回文件修改时间。
      statusTime: statusTimeOf(meta),
      // 字数 = 正文去掉空白后的字符数（不含 frontmatter），首页「成稿待确认」那一行用。
      words: countWords(note.content),
      archived,
    })
  }
  return articles
}

/** frontmatter 里能解析的 `状态时间:`（统一成 ISO）；没有或解析不了返回 null。 */
export function statusTimeOf(meta) {
  const raw = meta?.[STATUS_TIME_KEY]
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** 正文字数：去掉 frontmatter 和空白后的字符数（Markdown 符号也算，口径固定好比较）。 */
export function countWords(content) {
  return [...bodyOf(content)].filter(ch => !/\s/u.test(ch)).length
}

// ---- 改状态 ----

async function updateStatus(ctx, rawPath, status, baseVersion) {
  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    throw new HttpError(400, 'status_invalid', '状态只能是 选题、草稿、成稿、已确认、已发布')
  }
  return withLock(async () => {
    const { path, note, meta } = await readArticleFile(ctx, rawPath)
    const current = meta['状态'] || ''
    if (status === STATUS_CONFIRMED || status === STATUS_PUBLISHED) throw statusLocked()
    if (!MANUAL_STATUSES.includes(current)) throw statusLocked(current)
    const content = withStatusLine(note.content, status, ctx.now().toISOString())
    const saved = await saveNote(ctx, path, content, versionOrCurrent(baseVersion, note.version))
    if (saved.conflict) return editConflict(saved.current)
    const body = { path, status }
    // 只提示，不生成任何平台版本；生成本身在平台版本的工单里。
    if (status === STATUS_FINAL) body.askGeneratePlatformVersions = true
    return body
  })
}

function statusLocked(current) {
  return new HttpError(403, 'status_locked', current
    ? `当前状态是「${current}」，不能手动修改；「已确认」「已发布」只能由发布流程改`
    : '「已确认」「已发布」只能由发布流程改，不能手动切换')
}

/**
 * 替换 frontmatter 里的 `状态:` 行，并把 `状态时间:` 写成这次改状态的时间（没有就插在状态行后面）。
 * 正文和别的属性逐字不动。发布流程也复用它（成稿 → 已确认 → 已发布）。
 */
export function withStatusLine(content, status, statusTime) {
  const { lines, eol, end } = splitFrontmatter(content)
  if (end < 0) throw new HttpError(409, 'frontmatter_missing', '这篇文章开头没有属性区（frontmatter），没有改状态')
  let statusIndex = -1
  for (let i = 1; i < end; i++) {
    if (/^状态\s*:/.test(lines[i])) {
      lines[i] = `状态: ${status}`
      statusIndex = i
      break
    }
  }
  if (statusIndex < 0) throw new HttpError(409, 'status_missing', '文章开头的属性区里没有「状态:」这一行，没有改')
  if (statusTime) writeStatusTimeLine(lines, end, statusIndex, statusTime)
  return lines.join(eol)
}

/** 有 `状态时间:` 就替换那一行，没有就插在 `状态:` 后面；旧文章不会因为重复改状态多出好几行。 */
function writeStatusTimeLine(lines, end, statusIndex, statusTime) {
  for (let i = 1; i < end; i++) {
    if (/^状态时间\s*:/.test(lines[i])) {
      lines[i] = `${STATUS_TIME_KEY}: ${statusTime}`
      return
    }
  }
  lines.splice(statusIndex + 1, 0, `${STATUS_TIME_KEY}: ${statusTime}`)
}

/** 读出文章的 index.md（也接受条目文件夹路径），并解析开头属性。 */
async function readArticleFile(ctx, rawPath) {
  const path = articleIndexPath(rawPath)
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, 'not_found', '库里没有这篇文章')
    throw e
  }
  return { path, folder: dirname(path), note, meta: parseFrontmatter(note.content) }
}

export function articleIndexPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) throw new HttpError(400, 'path_invalid', '路径必须是库内的相对路径')
  return /\/index\.md$/i.test(rawPath) ? rawPath : rawPath.replace(/\/+$/, '') + '/index.md'
}

function versionOrCurrent(baseVersion, current) {
  return typeof baseVersion === 'string' && baseVersion ? baseVersion : current
}

function editConflict(current) {
  return reply(409, {
    error: { code: 'edit_conflict', message: '这篇文章在你打开之后被别处改过，没有保存，原文件保持不变' },
    current,
  })
}

// ---- 改标题 ----

async function updateTitle(ctx, rawPath, rawTitle, baseVersion) {
  const title = cleanTitle(rawTitle)
  if (!title) throw new HttpError(400, 'title_invalid', '文章标题不能为空')
  return withLock(async () => {
    const { path, note } = await readArticleFile(ctx, rawPath)
    const content = withTitleLine(note.content, title)
    const saved = await saveNote(ctx, path, content, versionOrCurrent(baseVersion, note.version))
    if (saved.conflict) return editConflict(saved.current)
    return { path, title }
  })
}

/**
 * 改正文第一个 `# ` 标题行（没有就插在 frontmatter 后）；frontmatter 里本来有 `标题:` 时一起改。
 * 没有 `标题:` 时只改 H1，不新增属性；文件夹名和正文其余内容不动。
 */
function withTitleLine(content, title) {
  const { lines, eol, end } = splitFrontmatter(content)
  if (end >= 0) {
    for (let i = 1; i < end; i++) {
      if (/^标题\s*:/.test(lines[i])) {
        lines[i] = `标题: ${title}`
        break
      }
    }
  }
  const bodyStart = end < 0 ? 0 : end + 1
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) {
      lines[i] = `# ${title}`
      return lines.join(eol)
    }
  }
  if (end < 0) {
    lines.unshift(`# ${title}`, '')
  } else if (lines[end + 1] === '') {
    lines.splice(end + 2, 0, `# ${title}`, '')
  } else {
    lines.splice(end + 1, 0, '', `# ${title}`, '')
  }
  return lines.join(eol)
}

// ---- 归档与删除 ----

async function archiveArticle(ctx, rawPath) {
  return withLock(async () => {
    const { folder } = await readArticleFile(ctx, rawPath)
    if (folder === ARCHIVE_DIR || folder.startsWith(ARCHIVE_DIR + '/')) {
      throw new HttpError(409, 'already_archived', '这篇文章已经在归档里了')
    }
    const targetFolder = await freeFolder(ctx, `${ARCHIVE_DIR}/${basename(folder)}`)
    const source = await locate(ctx, folder)
    const target = await locate(ctx, targetFolder)
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    return { path: targetFolder + '/index.md', folder: targetFolder }
  })
}

async function deleteArticle(ctx, rawPath) {
  return withLock(async () => {
    const { path, folder, meta } = await readArticleFile(ctx, rawPath)
    // 已发布的文章只能归档，不能删；其余状态删到回收站，之后还能恢复。
    if (meta['状态'] === STATUS_PUBLISHED) {
      throw new HttpError(403, 'published_immutable', '已发布的文章不能删除，只能归档')
    }
    const trashed = await moveToTrash(ctx, folder)
    return { path, trashedTo: trashed.trashedTo }
  })
}

// ---- AI 帮手：只生成 prompt，由面板放进对话草稿或复制；这里不调模型、不写正文 ----

const ASSIST_KINDS = {
  outline: '请根据下面这篇文章列一份详细提纲，指出结构和每部分的要点；只列提纲，不要替作者写正文。',
  facts: '请检查下面这篇文章里的事实性说法，列出需要核实或可能不准确的地方，并说明怎么查证；不要替作者改正文。',
  counter: '请针对下面这篇文章的观点提出反对意见和可能的漏洞，越具体越好；不要替作者改正文。',
  titles: '请为下面这篇文章拟几个候选标题，分别说明适合哪个平台；不要替作者改正文。',
}

async function assist(ctx, rawPath, kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(ASSIST_KINDS, kind)) {
    throw new HttpError(400, 'kind_invalid', 'kind 只能是 outline、facts、counter、titles')
  }
  const { folder, note, meta } = await readArticleFile(ctx, rawPath)
  const title = meta['标题'] || stripDate(basename(folder))
  const prompt = [
    `你是一位写作帮手。${ASSIST_KINDS[kind]}`,
    '',
    `文章标题：${title}`,
    '',
    '文章正文：',
    note.content,
  ].join('\n')
  return { prompt }
}

// ---- 路径与 frontmatter ----

/** 标题变成单行文本：换行按空格处理，免得写坏 frontmatter 和 H1。 */
function cleanTitle(raw) {
  return typeof raw === 'string' ? raw.replace(/[\r\n]+/g, ' ').trim() : ''
}

/** 标题变成安全的文件夹名：去掉文件系统不认的字符和首尾空白；空则用「未命名」。 */
export function safeName(title) {
  const cleaned = String(title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .replace(/[.\s]+$/g, '')
  return cleaned || '未命名'
}

/** 同一天同名时依次试 -2、-3……绝不覆盖已有条目。 */
async function freeFolder(ctx, base) {
  for (let i = 1; i < 1000; i++) {
    const folder = i === 1 ? base : `${base}-${i}`
    if (!(await exists(ctx, folder))) return folder
  }
  throw new HttpError(409, 'article_name_exhausted', '同名的文章太多，换一个标题再试')
}

async function exists(ctx, path) {
  try {
    await lstat(await locate(ctx, path))
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

function splitFrontmatter(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return { lines, eol, end: -1 }
  const end = lines.indexOf('---', 1)
  return { lines, eol, end }
}

export function parseFrontmatter(content) {
  const { lines, end } = splitFrontmatter(content)
  if (end < 0) return {}
  const meta = {}
  for (const line of lines.slice(1, end)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line)
    if (m) meta[m[1].trim()] = m[2].trim()
  }
  return meta
}

function stripDate(name) {
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

function datePrefix(name) {
  return /^(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1] ?? ''
}

// 新建、归档在同一个进程里排队，免得并发时抢到同一个文件夹名。
let lock = Promise.resolve()
function withLock(fn) {
  const run = lock.then(fn, fn)
  lock = run.then(() => {}, () => {})
  return run
}
