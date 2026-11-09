// 素材：列素材条目、按类型 / 标签 / 状态筛选，读写固定标签表，新建手动素材。
//   GET  /api/beer/materials?type=&tag=&status=   → { entries, types, tags, statuses }
//   GET  /api/beer/materials/tags                 → { tags }
//   PUT  /api/beer/materials/tags { tags }        → { tags }（覆盖写回）
//   POST /api/beer/materials/tags { tag | tags }  → { tags }（追加，已在表里的不重复加）
//   POST /api/beer/materials { title, type, tags, content, status?, source? } → 201 { entry }
//   POST /api/beer/materials/init                 → 建出 标签表.md / 说明.md（已有的不动）
// 素材条目 = `内容库/素材/<日期>-<名称>/index.md`，也认直接放在 `内容库/素材/` 下的 *.md。
// `标签表.md` 是唯一的标签来源：一行一个 `- 标签名`，可以带 `#` 说明标题；Beer 只重写
// `## 标签` 标题下面那段列表，文件其余部分原样保留。文件不存在时用默认 10 个标签。
import { HttpError, reply } from '../http/router.js'
import { createEntry, createNote, listFolder, parseFrontmatter, readNote, writeNote } from './library.js'
import { localDate } from '../dates.js'

export const MATERIALS_FOLDER = '内容库/素材'
export const TAGS_PATH = '内容库/素材/标签表.md'
export const GUIDE_PATH = '内容库/素材/说明.md'

/** 库里还没有标签表时用的默认标签（工单 #11）。 */
export const DEFAULT_TAGS = ['AI 工具', 'Obsidian', '笔记方法', '写作', '效率', '自动化', '费用', '内容运营', '读书', '生活']

/** 素材类型：现有条目里的类型会和这一份合并。 */
export const DEFAULT_TYPES = ['录音', '链接', '图片', '文字', 'PDF', '手动']

/** 素材文件夹里的说明 / 配置文件，不算素材条目。 */
const RESERVED_FILES = new Set(['标签表.md', '说明.md'])

const MAX_TAGS = 100
const MAX_TAG_LENGTH = 40

export function register(router, ctx) {
  router.get('/materials', async req => {
    const [entries, tags] = await Promise.all([collectEntries(ctx), readTags(ctx)])
    const type = req.query.get('type')?.trim() ?? ''
    const tag = req.query.get('tag')?.trim() ?? ''
    const status = req.query.get('status')?.trim() ?? ''
    const selected = entries.filter(e =>
      (!type || matchesType(e, type)) && (!tag || e.tags.includes(tag)) && (!status || e.status === status))
    return {
      entries: selected,
      types: typesOf(entries),
      tags,
      statuses: statusesOf(entries),
    }
  })

  router.get('/materials/tags', async () => ({ tags: await readTags(ctx) }))

  router.put('/materials/tags', async req => {
    const body = (await req.json()) ?? {}
    const normalized = normalizeTags(body.tags)
    await writeTagTable(ctx, normalized)
    await ensureGuide(ctx)
    return { tags: normalized }
  })

  router.post('/materials/tags', async req => {
    const body = (await req.json()) ?? {}
    const added = normalizeTags(body.tags ?? (body.tag === undefined ? undefined : [body.tag]))
    const tags = await readTags(ctx)
    for (const tag of added) if (!tags.includes(tag)) tags.push(tag)
    if (tags.length > MAX_TAGS) throw new HttpError(400, 'tags_invalid', `标签表最多 ${MAX_TAGS} 个标签`)
    await writeTagTable(ctx, tags)
    await ensureGuide(ctx)
    return { tags }
  })

  // 第一次打开素材页时建出 标签表.md / 说明.md，让 AI 整理素材前有东西可读；已有的文件不动。
  router.post('/materials/init', async () => {
    const tags = await ensureMaterialsInit(ctx)
    return { folder: MATERIALS_FOLDER, tagsPath: TAGS_PATH, guidePath: GUIDE_PATH, tags }
  })

  // 手动新建一条素材（也是 #12 之后 AI 整理素材的落点）。
  router.post('/materials', async req => {
    const entry = await createMaterial(ctx, (await req.json()) ?? {})
    return reply(201, { entry })
  })
}

/** 家里转录来的录音，类型是 AI 判的（会议、访谈……），来源统一写「录音」；筛「录音」时一起算进来。 */
function matchesType(entry, type) {
  return entry.type === type || (type === '录音' && entry.source === '录音')
}

/** 汇总现有条目的类型，再并上默认集合（默认集合在前，其余按名称排）。 */
function typesOf(entries) {
  const seen = new Set(DEFAULT_TYPES)
  const extra = new Set()
  for (const e of entries) {
    if (e.type && !seen.has(e.type)) extra.add(e.type)
  }
  return [...DEFAULT_TYPES, ...[...extra].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))]
}

function statusesOf(entries) {
  return [...new Set(entries.map(e => e.status).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/**
 * 当前素材条目（按最近改动排）；选题简报等模块直接用它读素材，不要另写一遍扫描。
 * 每条是 entryFrom 的结构：{ path, folder, title, type, tags, status, source, modifiedAt, summary? }。
 */
export async function listMaterialEntries(ctx) {
  return collectEntries(ctx)
}

async function collectEntries(ctx) {
  const listing = await listFolder(ctx, MATERIALS_FOLDER)
  if (!listing.exists) return []
  const entries = []
  for (const item of listing.entries) {
    let notePath
    let folder
    if (item.kind === 'folder') {
      notePath = `${item.path}/index.md`
      folder = item.path
    } else if (/\.md$/i.test(item.name) && !RESERVED_FILES.has(item.name)) {
      notePath = item.path
      folder = MATERIALS_FOLDER
    } else continue

    let note
    try {
      note = await readNote(ctx, notePath)
    } catch (e) {
      if (e.code === 'not_found') continue // 没有 index.md 的文件夹不算素材条目
      throw e
    }
    entries.push(entryFrom(notePath, folder, note))
  }
  // 最近改过的在前；同一时间按路径排，结果稳定。
  entries.sort((a, b) => (a.modifiedAt === b.modifiedAt ? a.path.localeCompare(b.path) : b.modifiedAt.localeCompare(a.modifiedAt)))
  return entries
}

/** 一个素材条目：开头属性 + 正文标题 + 摘要片段。 */
function entryFrom(path, folder, note) {
  const { attributes, body } = parseFrontmatter(note.content)
  const entry = {
    path,
    folder,
    title: textOf(attributes, ['标题', 'title']) || firstBodyHeading(body) || folder.split('/').pop(),
    type: textOf(attributes, ['类型', 'type']),
    tags: tagListOf(attributes['标签'] ?? attributes.tags),
    status: textOf(attributes, ['状态', 'status']),
    source: textOf(attributes, ['来源', 'source']),
    modifiedAt: note.modifiedAt,
  }
  const summary = textOf(attributes, ['摘要', 'summary']) || bodySummary(body)
  if (summary) entry.summary = summary
  return entry
}

function textOf(attributes, names) {
  for (const name of names) {
    const value = attributes[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value) && value.length) return String(value[0]).trim()
  }
  return ''
}

/** 标签属性：数组、`[a, b]`、`a, b` 都认；去空白、去重，不改大小写。 */
function tagListOf(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，]/) : []
  const tags = []
  for (const item of list) {
    const tag = String(item).trim()
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

function firstBodyHeading(body) {
  const m = /^#\s+(.+?)\s*$/.exec(body.split('\n').find(line => /^#\s+/.test(line)) ?? '')
  return m ? m[1].trim() : ''
}

/** 摘要片段：正文去掉第一个标题和 Markdown 标记（小标题 #、加粗、列表、引用），压成一行，取前 120 个字。 */
function bodySummary(body) {
  const text = body
    .replace(/^#\s+.*$/m, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

/** 当前标签表：文件不存在时返回默认标签（文件存在但列表为空时如实返回空表）。 */
export async function readTags(ctx) {
  try {
    const note = await readNote(ctx, TAGS_PATH)
    return parseTagTable(note.content)
  } catch (e) {
    if (e.code === 'not_found') return DEFAULT_TAGS.slice()
    throw e
  }
}

/** 规范化标签：去首尾空白、去重；空标签、控制字符、方括号、逗号和超长名字都拒绝。 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new HttpError(400, 'tags_invalid', 'tags 必须是标签名数组')
  const out = []
  for (const raw of tags) {
    if (typeof raw !== 'string') throw new HttpError(400, 'tag_invalid', '标签必须是字符串')
    const tag = raw.trim()
    if (!tag) throw new HttpError(400, 'tag_invalid', '标签不能为空')
    if (/[\u0000-\u001f\u007f]/.test(tag)) throw new HttpError(400, 'tag_invalid', `标签「${tag}」里不能有换行等控制字符`)
    if (/[\[\],，]/.test(tag)) throw new HttpError(400, 'tag_invalid', `标签「${tag}」里不能有方括号或逗号`)
    if (tag.length > MAX_TAG_LENGTH) throw new HttpError(400, 'tag_invalid', `标签名最多 ${MAX_TAG_LENGTH} 个字`)
    if (!out.includes(tag)) out.push(tag)
  }
  if (out.length > MAX_TAGS) throw new HttpError(400, 'tags_invalid', `标签表最多 ${MAX_TAGS} 个标签`)
  return out
}

/**
 * 校验一组标签都在标签表里（供后续工单新建 / 修改素材时调用）。
 * 返回规范化后的标签；有不认识的标签 → 400 tag_unknown。
 */
export async function assertKnownTags(ctx, tags) {
  const normalized = normalizeTags(tags)
  const known = await readTags(ctx)
  for (const tag of normalized) {
    if (!known.includes(tag)) throw new HttpError(400, 'tag_unknown', `标签「${tag}」不在标签表里，请先从标签表里选`)
  }
  return normalized
}

async function writeTagTable(ctx, tags) {
  let existing = null
  try {
    existing = (await readNote(ctx, TAGS_PATH)).content
  } catch (e) {
    if (e.code !== 'not_found') throw e
  }
  await writeNote(ctx, TAGS_PATH, existing === null ? tagTableTemplate(tags) : rewriteTagTable(existing, tags))
}

async function writeTagTableIfMissing(ctx, tags) {
  try {
    await createNote(ctx, TAGS_PATH, tagTableTemplate(tags))
  } catch (e) {
    if (e.code !== 'file_exists') throw e
  }
}

/** 新建手动素材：`内容库/素材/<YYYY-MM-DD>-<安全名称>/index.md`。 */
export async function createMaterial(ctx, body) {
  const title = requireTitle(body.title)
  const type = optionalField(body.type, '类型', '手动', 20)
  const status = optionalField(body.status, '状态', '待整理', 20)
  const source = optionalField(body.source, '来源', '手动录入', 100)
  const content = body.content ?? ''
  if (typeof content !== 'string') throw new HttpError(400, 'content_invalid', 'content 必须是字符串')
  const tags = await assertKnownTags(ctx, body.tags ?? [])

  const note = materialNote({ title, type, tags, status, source, content })
  // 名称安全化和重名避让交给 createEntry（同名加 -2、-3，绝不覆盖）。
  const created = await createEntry(ctx, MATERIALS_FOLDER, `${localDate(ctx.now())}-${safeFolderName(title)}`, {
    'index.md': note,
  })
  const path = `${created.path}/index.md`
  const saved = await readNote(ctx, path)

  // 顺手建出说明和标签表，AI 下次整理素材时有东西可读。
  await ensureMaterialsInit(ctx)

  return entryFrom(path, created.path, saved)
}

/** 读回一个素材条目文件夹的 `index.md`，返回和 `GET /materials` 一样的条目结构。 */
export async function readMaterialEntry(ctx, folder) {
  const path = `${folder}/index.md`
  const note = await readNote(ctx, path)
  return entryFrom(path, folder, note)
}

function materialNote({ title, type, tags, status, source, content }) {
  const head = [
    '---',
    `类型: ${type}`,
    `标签: [${tags.join(', ')}]`,
    `状态: ${status}`,
    `来源: ${source}`,
    '---',
    `# ${title}`,
    '',
  ].join('\n')
  const text = content.trim()
  return head + '\n' + (text ? text + '\n' : '')
}

export function requireTitle(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'title_invalid', '标题必须是字符串')
  const title = value.trim()
  if (!title) throw new HttpError(400, 'title_invalid', '标题不能为空')
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new HttpError(400, 'title_invalid', '标题里不能有换行等控制字符')
  if (title.length > 100) throw new HttpError(400, 'title_invalid', '标题最多 100 个字')
  return title
}

function optionalField(value, label, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new HttpError(400, 'material_invalid', `${label}必须是字符串`)
  const text = value.trim()
  if (!text) return fallback
  if (/[\u0000-\u001f\u007f]/.test(text) || text.length > max) {
    throw new HttpError(400, 'material_invalid', `${label}最多 ${max} 个字，不能有换行等控制字符`)
  }
  return text
}

/** 文件夹名：去掉 Windows / Obsidian 不认的字符，压掉多余空白，限长。 */
function safeFolderName(title) {
  const name = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (!name) return '未命名'
  return name.slice(0, 40).replace(/[. ]+$/, '') || '未命名'
}

/**
 * 素材文件夹的初始化：标签表、说明文件不存在时建出来，已有的不覆盖。
 * 返回当前标签表。新建素材前调用，保证 AI 整理素材时有说明可读。
 */
export async function ensureMaterialsInit(ctx) {
  const tags = await readTags(ctx)
  await writeTagTableIfMissing(ctx, tags)
  await ensureGuide(ctx)
  return tags
}

/** 给 AI 看的素材说明：条目结构、类型、状态，以及标签表的用法。 */
async function ensureGuide(ctx) {
  try {
    await createNote(ctx, GUIDE_PATH, GUIDE_TEXT)
  } catch (e) {
    if (e.code !== 'file_exists') throw e
  }
}

function tagTableTemplate(tags) {
  return [
    '# 素材标签表',
    '',
    '素材的标签只能从这张表里选。每行一个标签，写成 `- 标签名`；在 Obsidian 里直接改这个文件也可以。',
    'Beer 的素材页只重写 `## 标签` 标题下面的列表，文件其余内容不动。',
    '',
    '## 标签',
    '',
    ...tags.map(tag => `- ${tag}`),
    '',
  ].join('\n')
}

// 标签表里认的标题和列表行：`## 标签` 下面是标签列表，一行一个 `- 标签名`。
const TAG_HEADING = /^\s*#{1,6}\s*标签\s*$/
const ANY_HEADING = /^\s*#{1,6}\s/
const LIST_ITEM = /^\s*-\s+(.*\S)\s*$/
const TOP_LIST_ITEM = /^-\s+(.*\S)\s*$/

/** 从标签表文件里解析标签：`## 标签` 标题下那段列表，没有标题时读全文的顶层 `- 标签名`。 */
export function parseTagTable(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const heading = lines.findIndex(line => TAG_HEADING.test(line))
  const tags = []
  if (heading >= 0) {
    let started = false
    for (let i = heading + 1; i < lines.length; i++) {
      const line = lines[i]
      if (ANY_HEADING.test(line)) break
      const m = LIST_ITEM.exec(line)
      if (m) { started = true; addTag(tags, m[1]); continue }
      if (line.trim() === '') continue
      if (!started) continue // 标题和列表之间的说明文字
      break
    }
    return tags
  }
  // 没有标题：读全文的顶层列表（跳过代码块）。
  let fenced = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const m = TOP_LIST_ITEM.exec(line)
    if (m) addTag(tags, m[1])
  }
  return tags
}

function addTag(tags, value) {
  const tag = value.trim()
  if (tag && !tags.includes(tag)) tags.push(tag)
}

/** 只替换标签列表区，保留文件其余部分（自定义说明、其他标题和列表）。 */
export function rewriteTagTable(text, tags) {
  const raw = String(text)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n' // 文件原来用 CRLF 就继续用 CRLF
  const source = raw.replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const bullets = tags.map(tag => `- ${tag}`)
  const heading = lines.findIndex(line => TAG_HEADING.test(line))
  const done = out => out.join('\n').replace(/\n*$/, '\n').replace(/\n/g, eol)

  if (heading >= 0) {
    // 找标题下面的第一段列表（允许标题和列表之间有一段说明文字，那段要保留）。
    let start = heading + 1
    while (start < lines.length && !LIST_ITEM.test(lines[start]) && !ANY_HEADING.test(lines[start])) start++
    if (start < lines.length && LIST_ITEM.test(lines[start])) {
      let end = start
      while (end < lines.length && (LIST_ITEM.test(lines[end]) || lines[end].trim() === '')) end++
      while (end > start && lines[end - 1].trim() === '') end--
      const before = lines.slice(0, start)
      if (before[before.length - 1].trim() !== '') before.push('')
      const after = lines.slice(end)
      while (after.length && after[0].trim() === '') after.shift()
      const out = [...before, ...bullets]
      if (after.length) out.push('', ...after)
      return done(out)
    }
    // 标题下还没有列表：插在标题后面，原有说明留在新列表下面。
    const after = lines.slice(heading + 1)
    while (after.length && after[0].trim() === '') after.shift()
    const out = [...lines.slice(0, heading + 1), '', ...bullets]
    if (after.length) out.push('', ...after)
    return done(out)
  }

  // 没有 `## 标签` 标题：原地替换第一段顶层列表；完全没有列表时在文件末尾追加一节。
  const start = lines.findIndex(line => TOP_LIST_ITEM.test(line))
  if (start >= 0) {
    let end = start
    while (end < lines.length && (TOP_LIST_ITEM.test(lines[end]) || lines[end].trim() === '')) end++
    while (end > start && lines[end - 1].trim() === '') end--
    return done([...lines.slice(0, start), ...bullets, '', ...lines.slice(end)])
  }
  const base = source.trimEnd()
  return done([...(base ? [...base.split('\n'), ''] : []), '## 标签', '', ...bullets])
}

const GUIDE_TEXT = [
  '# 素材说明',
  '',
  '这是 Beer 素材页的说明文件。**整理素材前必须先读这个文件**，再按下面的格式写条目。',
  '',
  '## 条目结构',
  '',
  '每条素材是一个文件夹 `素材/<日期>-<名称>/`，里面的 `index.md` 开头写属性，正文是摘要或摘录。',
  '也可以直接放在 `素材/` 下，写成一个 `*.md` 文件。',
  '录音条目还会有 `transcript.md`（文字稿）和字幕文件；图片、PDF 的原件和 `index.md` 放在同一个文件夹，',
  '并在属性里用 `原件:` 写原文件名。',
  '',
  '## 开头属性',
  '',
  '```',
  '---',
  '标题: 条目标题',
  '类型: 录音',
  '标签: [AI 工具, 写作]',
  '状态: 待整理',
  '来源: 2026-11-04 周会录音',
  '原件: 扫描件.pdf',
  '日期: 2026-11-06',
  '---',
  '# 条目标题',
  '',
  '正文（通常是摘要）',
  '```',
  '',
  '- 标题：一条素材一个标题，正文第一行再写同样的 `# 标题`',
  '- 类型：录音、链接、图片、文字、PDF、手动',
  '- 状态：自己写，例如 待整理、可用、已用',
  '- 来源：链接写原网址；本地图片、PDF 写「本地文件」；文字写「手动录入」',
  '- 原件：只有图片、PDF 这类带原文件的条目才写，填同文件夹里的原文件名',
  '- 日期：写条目整理当天的日期 `YYYY-MM-DD`',
  '',
  '## 支持的来源',
  '',
  '- 链接：文章抓正文；视频站（YouTube、B 站、Vimeo、抖音等）只保存页面标题和简介，不抓正文',
  '- 图片：原文件放进条目文件夹，正文写文字识别结果或摘要；识别不出文字的扫描件只存原文件',
  '- PDF：同图片，原文件和 `index.md` 放在一起',
  '- 文字：把粘贴或口述的文字直接写进正文',
  '- 录音：由录音分页转写后写成条目，带 `transcript.md`',
  '',
  '## 标签表',
  '',
  '见同目录的 `标签表.md`，每行一个 `- 标签名`。整理素材时先读它，**标签只能从表里选**；',
  '表里没有的标签会被拒绝，需要新标签就先改标签表。',
  '',
].join('\n')
