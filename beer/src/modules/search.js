// 搜索：每次请求直接扫库，不建持久索引（库只有几千个文件；中文按子串匹配）。
//   GET /api/beer/search?q=<查询>&includeTrash=1&scope=<tabId>
//   → { query, total, groups: [{ tabId, title, hits: [{ path, name, title, kind, snippet,
//        highlights: [{ start, end }], matchedIn, tabId, playAt? }] }] }
// 支持条件：`#标签`（frontmatter 标签列表或正文里的 #标签）、`状态:成稿`、`类型:链接`，
// 可和普通关键词混用，其余词按 AND 子串匹配（大小写不敏感）。默认不搜 `.trash`。
// 分页归属按 panel.js 的分页文件夹做最长前缀匹配，不属于任何分页的归到首页。
// 文字稿（transcript.md）里带时间点的行解析出秒数放到 playAt，供面板从那句开始播放。
import { listFolder, parseFrontmatter, readNote } from './library.js'
import { HttpError } from '../http/router.js'
import { listTabs } from './panel.js'

const MAX_DEPTH = 24
const SNIPPET_LIMIT = 120
const SNIPPET_LEAD = 40
const MAX_HIGHLIGHTS = 50

export function register(router, ctx) {
  router.get('/search', async req => search(ctx, req.query))
}

/** 执行一次搜索。query 是 URLSearchParams。 */
export async function search(ctx, query) {
  const raw = query.get('q') ?? ''
  const text = raw.trim()
  if (!text) return { query: text, total: 0, groups: [] }

  const tabs = await listTabs(ctx)
  const scope = query.get('scope')
  const includeTrash = /^(1|true|yes)$/i.test(query.get('includeTrash') ?? '')
  const terms = parseQuery(text)
  const roots = searchRoots(tabs, scope, includeTrash)

  const hits = []
  for (const path of await collectMarkdown(ctx, roots)) {
    let note
    try {
      note = await readNote(ctx, path)
    } catch {
      continue // 扫描期间被删掉 / 读不了的文件跳过，不让一次搜索整个失败
    }
    const hit = matchFile({ path, content: note.content, terms, tabs })
    if (hit) hits.push(hit)
  }

  const groups = []
  for (const tab of tabs) {
    const inTab = hits.filter(hit => hit.tabId === tab.id)
    if (!inTab.length) continue
    inTab.sort(compareHits)
    groups.push({ tabId: tab.id, title: tab.title, hits: inTab })
  }
  return { query: text, total: hits.length, groups }
}

/** 把查询串拆成条件词和普通关键词。 */
function parseQuery(text) {
  const terms = []
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (token.length > 1 && token.startsWith('#')) {
      terms.push({ kind: 'tag', value: token.slice(1) })
    } else if (/^状态[:：]/.test(token)) {
      terms.push({ kind: 'status', value: token.replace(/^状态[:：]/, '') })
    } else if (/^类型[:：]/.test(token)) {
      terms.push({ kind: 'type', value: token.replace(/^类型[:：]/, '') })
    } else {
      terms.push({ kind: 'text', value: token })
    }
  }
  return terms
}

/** 搜哪些文件夹：scope 限定某分页（此时忽略 includeTrash）；否则整个库，includeTrash 时加上 .trash。 */
function searchRoots(tabs, scope, includeTrash) {
  if (scope) {
    const tab = tabs.find(t => t.id === scope)
    if (!tab || typeof tab.folder !== 'string') throw new HttpError(400, 'scope_invalid', '没有这个分页')
    return [tab.folder]
  }
  return includeTrash ? ['', '.trash'] : ['']
}

/** 递归收集库里的 Markdown 相对路径（listFolder 已跳过 `.` 开头的隐藏项）。 */
async function collectMarkdown(ctx, roots) {
  const files = []
  const stack = roots.map(root => ({ dir: root, depth: 0 }))
  while (stack.length) {
    const { dir, depth } = stack.pop()
    if (depth > MAX_DEPTH) continue
    let listing
    try {
      listing = await listFolder(ctx, dir)
    } catch {
      continue
    }
    if (!listing.exists) continue
    for (const entry of listing.entries) {
      if (entry.kind === 'folder') stack.push({ dir: entry.path, depth: depth + 1 })
      else if (/\.md$/i.test(entry.name)) files.push(entry.path)
    }
  }
  return files.sort()
}

/** 一个文件最多算一条命中；所有条件都满足才算。 */
function matchFile({ path, content, terms, tabs }) {
  // 开头属性交给 library.parseFrontmatter 解析；正文按 LF 归一后再匹配。
  const { attributes, body } = parseFrontmatter(content.replace(/\r\n?/g, '\n'))
  const title = titleOf(path, attributes, body)
  const fields = noteFields(path, attributes, body, title)
  const matchedIn = new Set()
  for (const term of terms) {
    const where = matchTerm(term, fields)
    if (!where.length) return null
    for (const name of where) matchedIn.add(name)
  }
  const tab = tabOf(tabs, path, fields.kind)
  const highlightTerms = terms.map(term => (term.kind === 'tag' ? '#' + term.value : term.value))
  // 正文里命中的看正文；只在标签 / 状态 / 类型里命中时，片段写清楚是哪一项。
  const snippet = matchedIn.has('body')
    ? snippetOf(body, highlightTerms)
    : metadataSnippet(fields, matchedIn) || snippetOf(body, highlightTerms)
  const hit = {
    path,
    name: basename(path),
    title,
    kind: fields.kind,
    snippet,
    highlights: highlightsOf(snippet, highlightTerms),
    matchedIn: [...matchedIn],
    tabId: tab.id,
  }
  if (fields.kind === 'transcript') {
    const playAt = playAtOf(body, bodyMatchIndex(body, highlightTerms))
    if (playAt !== null) hit.playAt = playAt
  }
  return hit
}

/** 取一组别名字段的值（字符串或列表都拍平成数组）。 */
function values(meta, keys) {
  for (const key of keys) {
    const value = meta[key]
    if (value === undefined || value === null || value === '') continue
    const list = Array.isArray(value) ? value : [value]
    const flat = list.map(v => String(v).trim()).filter(Boolean)
    if (flat.length) return flat
  }
  return []
}

const TAG_KEYS = ['标签', 'tags', 'tag']
const STATUS_KEYS = ['状态', 'status']
const TYPE_KEYS = ['类型', 'type']

function noteFields(path, meta, body, title) {
  const name = basename(path)
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').pop() : ''
  return {
    kind: kindOf(path),
    titleTargets: [title, folder, name.replace(/\.md$/i, '')].filter(Boolean),
    tags: tagValues(meta),
    status: values(meta, STATUS_KEYS),
    type: values(meta, TYPE_KEYS),
    body,
  }
}

/**
 * 标签属性统一成数组：`[a, b]`、缩进列表、`a, b` 都认；去掉每项开头的 `#`。
 * library.parseFrontmatter 只拆 `[a, b]` 和列表，`a, b` 这种要在这里补拆。
 */
function tagValues(meta) {
  for (const key of TAG_KEYS) {
    const value = meta[key]
    if (value === undefined || value === null || value === '') continue
    const list = Array.isArray(value) ? value : String(value).split(/[,，]/)
    const tags = []
    for (const item of list) {
      const tag = String(item).trim().replace(/^#/, '')
      if (tag && !tags.includes(tag)) tags.push(tag)
    }
    if (tags.length) return tags
  }
  return []
}

/** 按库里的约定判断条目类型，面板用它在结果里显示来源。 */
function kindOf(path) {
  const rel = path.startsWith('.trash/') ? path.slice('.trash/'.length) : path
  const segments = rel.split('/')
  if (segments[segments.length - 1] === 'transcript.md') return 'transcript'
  if (segments[0] === '内容库') {
    if (segments[1] === '文章') return 'article'
    if (segments[1] === '素材') return 'material'
    if (segments[1] === '选题简报') return 'brief'
    if (segments[1] === '规则') return 'rule'
  }
  return 'note'
}

/** 显示标题：正文一级标题 → frontmatter 标题 → 条目文件夹名 → 文件名。 */
function titleOf(path, meta, body) {
  const segments = path.split('/')
  const name = segments[segments.length - 1]
  // 文字稿的标题用条目文件夹名（「周会文字稿」这种通用标题对结果列表没帮助）。
  if (!/^transcript\.md$/i.test(name)) {
    const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)
    if (heading) return heading[1].trim()
  }
  const metaTitle = values(meta, ['标题', 'title'])[0]
  if (metaTitle) return metaTitle
  if (/^(index|transcript)\.md$/i.test(name) && segments.length > 1) return segments[segments.length - 2]
  return name.replace(/\.md$/i, '')
}

function matchTerm(term, fields) {
  const needle = term.value.toLowerCase()
  const where = []
  if (term.kind === 'tag') {
    if (fields.tags.some(tag => tag.toLowerCase() === needle)) where.push('tags')
    if (hasTag(fields.body, term.value)) where.push('body')
    return where
  }
  if (term.kind === 'status') {
    if (fields.status.some(v => v.toLowerCase() === needle)) where.push('status')
    return where
  }
  if (term.kind === 'type') {
    if (fields.type.some(v => v.toLowerCase() === needle)) where.push('type')
    return where
  }
  if (fields.titleTargets.some(t => t.toLowerCase().includes(needle))) where.push('title')
  if (fields.tags.some(tag => tag.toLowerCase().includes(needle))) where.push('tags')
  if (fields.status.some(v => v.toLowerCase().includes(needle))) where.push('status')
  if (fields.type.some(v => v.toLowerCase().includes(needle))) where.push('type')
  if (fields.body.toLowerCase().includes(needle)) where.push('body')
  return where
}

/** 正文里有没有 `#标签` 这个标签（前后不能紧挨标签字符）。 */
function hasTag(body, tag) {
  const tagChar = '[\\p{L}\\p{N}_/-]'
  const re = new RegExp('(?<!' + tagChar + ')#' + escapeRegExp(tag) + '(?!' + tagChar + ')', 'iu')
  return re.test(body)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 分页归属：分页文件夹的最长前缀；同一长度时按条目类型偏向对应分页。 */
function tabOf(tabs, path, kind) {
  let best = null
  for (const tab of tabs) {
    if (!tab.folder) continue
    if (path !== tab.folder && !path.startsWith(tab.folder + '/')) continue
    const length = tab.folder.length
    if (!best || length > best.length) best = { tab, length }
    else if (length === best.length && affinity(tab.id) === kind && affinity(best.tab.id) !== kind) {
      best = { tab, length }
    }
  }
  return best?.tab ?? tabs.find(tab => tab.folder === '内容库') ?? tabs[0]
}

function affinity(tabId) {
  return { recordings: 'transcript', materials: 'material', articles: 'article', topics: 'brief', rules: 'rule' }[tabId]
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 只在 frontmatter 字段里命中时，用一小行说明命中的标签 / 状态 / 类型。 */
function metadataSnippet(fields, matchedIn) {
  const parts = []
  if (matchedIn.has('tags')) parts.push('标签：' + fields.tags.map(tag => '#' + tag).join(' '))
  if (matchedIn.has('status')) parts.push('状态：' + fields.status.join('、'))
  if (matchedIn.has('type')) parts.push('类型：' + fields.type.join('、'))
  return parts.filter(part => !part.endsWith('：')).join(' · ')
}

/** 片段优先取正文里命中的那一行，只截命中附近的一段。 */
function snippetOf(body, terms) {
  const lines = body.split('\n')
  let lineIndex = -1
  let column = -1
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    for (const term of terms) {
      const at = lower.indexOf(term.toLowerCase())
      if (at >= 0 && (lineIndex < 0 || i < lineIndex || (i === lineIndex && at < column))) {
        lineIndex = i
        column = at
      }
    }
    if (lineIndex >= 0) break // 第一个有命中的行就够
  }
  const line = lineIndex >= 0 ? lines[lineIndex] : lines.map(s => s.trim()).find(Boolean) ?? ''
  if (!line) return ''
  if (line.length <= SNIPPET_LIMIT) return line.trim()
  const start = Math.max(0, (column < 0 ? 0 : column) - SNIPPET_LEAD)
  const end = Math.min(line.length, start + SNIPPET_LIMIT)
  return (start > 0 ? '…' : '') + line.slice(start, end).trim() + (end < line.length ? '…' : '')
}

/** 在片段里找出各个词的位置（大小写不敏感），合并重叠的区间。 */
function highlightsOf(snippet, terms) {
  const ranges = []
  for (const term of terms) {
    if (!term) continue
    const re = new RegExp(escapeRegExp(term), 'giu')
    let match
    while ((match = re.exec(snippet)) && ranges.length < MAX_HIGHLIGHTS) {
      ranges.push({ start: match.index, end: match.index + match[0].length })
      if (!match[0].length) re.lastIndex++
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  const merged = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged.slice(0, MAX_HIGHLIGHTS)
}

function compareHits(a, b) {
  const score = hit => (hit.matchedIn.includes('title') ? 2 : 1)
  return score(b) - score(a) || a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true }) || a.path.localeCompare(b.path)
}

/** 正文里第一个命中的位置（没有正文命中时 -1）。 */
function bodyMatchIndex(body, terms) {
  const lower = body.toLowerCase()
  let best = -1
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase())
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/** 时间点：`[00:12]`、`00:12`、`00:12:34`，也可以带 `- `、`>`、`**`、反引号等修饰（家里服务写的是 - `00:00:03`）。 */
const TIMESTAMP = /^\s*(?:[-*>]\s*)?(?:\*\*|__)?[[`]?(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?:[.,]\d+)?[\]`]?(?:\*\*|__)?/

/**
 * 文字稿里哪一行带时间点，就从哪一行开始播放；命中的是续行时，
 * 往上找最近一个带时间点的行（最多 40 行）。返回秒数或 null。
 */
function playAtOf(body, index) {
  if (index < 0) return null
  const lines = body.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    if (index <= offset + lines[i].length) {
      for (let j = i; j >= Math.max(0, i - 40); j--) {
        const seconds = parseTimestamp(lines[j])
        if (seconds !== null) return seconds
      }
      return null
    }
    offset += lines[i].length + 1
  }
  return null
}

function parseTimestamp(line) {
  const match = TIMESTAMP.exec(line)
  if (!match) return null
  const [, first, second, third] = match
  if (third === undefined) return Number(first) * 60 + Number(second)
  return Number(first) * 3600 + Number(second) * 60 + Number(third)
}
