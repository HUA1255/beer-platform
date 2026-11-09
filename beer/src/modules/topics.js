// 选题：每天生成选题简报（`内容库/选题简报/<日期>.md`），在简报里列出新素材和 AI 建议的角度；
// 选中一个角度就建出一篇状态为「选题」的文章。
//   GET  /api/beer/topics?ensure=1                → { date, briefPath, exists, content, angles, topics }
//        ensure=1 时当天简报不存在就生成（模拟「每天第一次打开」）；已存在直接返回，不调模型。
//   POST /api/beer/topics/brief/regenerate        → 同上（强制重新生成并覆盖当天文件）
//   POST /api/beer/topics/articles { title, why?, materials? } → 201 { path, title, status, materials }
//   POST /api/beer/topics/materials { path, materials }        → { path, materials }
//   GET  /api/beer/topics/discuss?angle=&why=     → { prompt }（只拼 prompt，不调模型）
//
// 简报的输入只有库里的素材（最近 30 天，最多 40 条）、笔记（最多 40 个 Markdown 文件的前 400 字）
// 和手动摘录的读者反馈（素材 `类型: 读者反馈` 优先），不抓热点、不联网。
// 模型只输出 JSON：{"angles":[{"title","why","materials"}]}，3–6 个角度。
// 不是合法 JSON 时把原文写进简报正文并标「模型输出未解析」，angles 为空，不报 500。
// 模型不可用时不写半成品：当天已有简报原样保留并回明确错误；没有文件就不建。
// 新建文章复用 articles.js 的 createArticle / readArticles；素材读写复用 materials.js 的 listMaterialEntries。
import { HttpError, reply } from '../http/router.js'
import { chatText } from '../llm.js'
import { createNote, listFolder, parseFrontmatter, readNote, saveNote } from './library.js'
import { articleIndexPath, createArticle, readArticles } from './articles.js'
import { listMaterialEntries, MATERIALS_FOLDER } from './materials.js'
import { localDate } from '../dates.js'

export const BRIEFS_DIR = '内容库/选题简报'
export const TOPIC_STATUS = '选题'
export const FEEDBACK_TYPE = '读者反馈'

const MATERIAL_DAYS = 30
const MATERIAL_LIMIT = 40
const NOTE_LIMIT = 40
const NOTE_CHARS = 400
const ANGLE_LIMIT = 6
const NOTE_SCAN_LIMIT = 2000
/**
 * 笔记扫描时整段跳过的文件夹：素材已有单独的输入，再当笔记读会重复；
 * .trash 是隐藏文件夹，listFolder 本来就不列。
 */
const NOTE_EXCLUDED_DIRS = ['.trash', MATERIALS_FOLDER, '内容库/文章', BRIEFS_DIR]
/** 素材文件夹里的说明 / 配置文件，不算素材条目。 */
const RESERVED_MATERIALS = new Set(['标签表', '说明'])

export function register(router, ctx) {
  router.get('/topics', async req => getTopics(ctx, req.query.get('ensure') === '1'))
  router.post('/topics/brief/regenerate', async () => regenerateBrief(ctx))
  router.post('/topics/articles', async req => {
    const body = (await req.json()) ?? {}
    return reply(201, await createTopicArticle(ctx, body))
  })
  router.post('/topics/materials', async req => {
    const body = (await req.json()) ?? {}
    return addMaterialsToTopic(ctx, body.path, body.materials)
  })
  router.get('/topics/discuss', async req => discuss(ctx, req.query.get('angle'), req.query.get('why')))
}

// ---- 选题简报 ----

async function getTopics(ctx, ensure) {
  const brief = ensure ? await ensureBrief(ctx) : await todayBrief(ctx)
  return {
    date: brief.date,
    briefPath: brief.path,
    exists: brief.exists,
    content: brief.content,
    angles: brief.angles,
    topics: await readArticles(ctx, { status: TOPIC_STATUS }),
  }
}

/** 首页复用：当天简报的路径、是否存在和正文（不生成、不调模型）。 */
export async function todayBrief(ctx) {
  const date = localDate(ctx.now())
  const path = `${BRIEFS_DIR}/${date}.md`
  const note = await readIfExists(ctx, path)
  return {
    date,
    path,
    exists: !!note,
    content: note?.content ?? null,
    angles: note ? parseAngles(note.content) : [],
  }
}

/** 同一个 ctx 的 ensure 生成排成一队：面板同时发两次请求也只调一次模型。 */
const briefLocks = new WeakMap()

/**
 * 每天第一次打开时用：当天简报不存在才生成（调模型），已存在直接返回。
 * 模型 / 密钥失败时抛错，调用方（首页）决定怎么提示。
 */
export async function ensureBrief(ctx) {
  const brief = await todayBrief(ctx)
  if (brief.exists) return brief
  const previous = briefLocks.get(ctx) ?? Promise.resolve()
  const run = previous.then(async () => {
    const again = await todayBrief(ctx)
    if (again.exists) return again
    await generateBrief(ctx, again.date)
    return todayBrief(ctx)
  }, async () => {
    const again = await todayBrief(ctx)
    if (again.exists) return again
    await generateBrief(ctx, again.date)
    return todayBrief(ctx)
  })
  briefLocks.set(ctx, run.then(() => {}, () => {}))
  return run
}

/** 重新生成当天简报并覆盖文件；首页的「重新生成」直接调用它。 */
export async function regenerateBrief(ctx) {
  const date = localDate(ctx.now())
  const generated = await generateBrief(ctx, date)
  return {
    date,
    briefPath: `${BRIEFS_DIR}/${date}.md`,
    exists: true,
    content: generated.content,
    angles: generated.angles,
    topics: await readArticles(ctx, { status: TOPIC_STATUS }),
  }
}

/** 读简报输入、调模型、拼简报并写文件；模型失败时直接抛错，什么都不写。 */
async function generateBrief(ctx, date) {
  const input = await collectInput(ctx)
  const modelText = await chatText(ctx, briefMessages(date, input), { temperature: 0.8 })
  const angles = parseAnglesJson(modelText)
  const content = briefMarkdown({
    date,
    generatedAt: ctx.now().toISOString(),
    angles,
    rawText: modelText,
    input,
  })
  await writeBrief(ctx, `${BRIEFS_DIR}/${date}.md`, content)
  return { content, angles }
}

async function writeBrief(ctx, path, content) {
  const existing = await readIfExists(ctx, path)
  if (!existing) {
    try {
      await createNote(ctx, path, content)
      return
    } catch (e) {
      if (e.code !== 'file_exists') throw e
    }
  }
  // 已有文件：带版本覆盖；生成期间被别处改过时重新读一次再写（重新生成本来就是要覆盖）。
  const current = await readIfExists(ctx, path)
  if (!current) {
    await createNote(ctx, path, content)
    return
  }
  const saved = await saveNote(ctx, path, content, current.version)
  if (saved.conflict) {
    const latest = await readIfExists(ctx, path)
    if (!latest) {
      await createNote(ctx, path, content)
      return
    }
    const retry = await saveNote(ctx, path, content, latest.version)
    if (retry.conflict) throw new HttpError(409, 'brief_conflict', '选题简报在你生成期间被别处改过，没有覆盖')
  }
}

/** 简报输入：最近 30 天素材（读者反馈优先）+ 笔记前 400 字。 */
async function collectInput(ctx) {
  const entries = await listMaterialEntries(ctx)
  const cutoff = ctx.now().getTime() - MATERIAL_DAYS * 24 * 60 * 60 * 1000
  const recent = entries
    .filter(entry => isRecent(entry, cutoff))
    .sort((a, b) => feedbackRank(a) - feedbackRank(b)
      || b.modifiedAt.localeCompare(a.modifiedAt)
      || a.path.localeCompare(b.path))
    .slice(0, MATERIAL_LIMIT)
  return { materials: recent, notes: await collectNotes(ctx) }
}

function feedbackRank(entry) {
  return entry.type === FEEDBACK_TYPE ? 0 : 1
}

/**
 * 「最近 30 天」优先看条目路径里的日期（素材条目按创建日期命名）；
 * 没有日期前缀的手动条目无法判断，按最近处理（后面仍按改动时间排序、最多 40 条）。
 */
function isRecent(entry, cutoff) {
  const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})-/.exec(entry.path)
  if (!m) return true
  const ts = new Date(`${m[1]}T00:00:00`).getTime()
  return Number.isFinite(ts) && ts >= cutoff
}

/** 扫库里除 .trash、文章、选题简报之外的 Markdown，取最近 40 个文件的前 400 字。 */
async function collectNotes(ctx) {
  const files = []
  await walkNotes(ctx, '', files)
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path))
  const notes = []
  for (const file of files.slice(0, NOTE_LIMIT)) {
    try {
      const note = await readNote(ctx, file.path)
      notes.push({ path: file.path, excerpt: note.content.replace(/\r\n?/g, '\n').trim().slice(0, NOTE_CHARS) })
    } catch (e) {
      if (e.code !== 'not_found') throw e // 扫描期间被删掉的文件跳过
    }
  }
  return notes
}

async function walkNotes(ctx, dir, files) {
  if (files.length >= NOTE_SCAN_LIMIT) return
  const listing = await listFolder(ctx, dir)
  if (!listing.exists) return
  for (const entry of listing.entries) {
    if (files.length >= NOTE_SCAN_LIMIT) return
    if (entry.kind === 'folder') {
      if (NOTE_EXCLUDED_DIRS.includes(entry.path)) continue
      await walkNotes(ctx, entry.path, files)
    } else if (/\.md$/i.test(entry.name)) {
      files.push({ path: entry.path, modifiedAt: entry.modifiedAt })
    }
  }
}

function briefMessages(date, input) {
  const feedback = input.materials.filter(entry => entry.type === FEEDBACK_TYPE)
  const others = input.materials.filter(entry => entry.type !== FEEDBACK_TYPE)
  const system = [
    '你是中文内容编辑，负责从作者自己的素材和笔记里挑出值得写的角度。',
    '只输出一个 JSON 对象，不要输出解释、前后缀或代码块，格式：',
    '{"angles":[{"title":"角度标题","why":"为什么值得写","materials":["素材路径或标题"]}]}',
    `angles 给 3 到 6 个；materials 只填下面给出的素材路径或标题，找不到对应素材就填空数组。`,
    '不要使用热点、新闻或任何联网信息，只依据下面给出的内容。',
  ].join('\n')

  const parts = [`日期：${date}`, '']
  parts.push('## 读者反馈（优先）')
  if (feedback.length) parts.push(...feedback.map(entry => materialBlock(entry)))
  else parts.push('（最近 30 天没有读者反馈素材）')
  parts.push('')
  parts.push('## 其他素材')
  if (others.length) parts.push(...others.map(entry => materialBlock(entry)))
  else parts.push('（最近 30 天没有其他素材）')
  parts.push('')
  parts.push('## 笔记（每个只给前 400 字）')
  if (input.notes.length) {
    for (const note of input.notes) parts.push(`- 路径：${note.path}`, `  摘录：${note.excerpt}`)
  } else {
    parts.push('（库里还没有笔记）')
  }
  parts.push('', '请从上面这些内容里挑 3 到 6 个可以写成文章的角度，按 JSON 格式回复。')

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}

function materialBlock(entry) {
  const meta = [
    entry.type ? `类型：${entry.type}` : '',
    entry.tags?.length ? `标签：${entry.tags.join('、')}` : '',
    `路径：${targetOf(entry.path)}`,
  ].filter(Boolean).join('；')
  return `- 标题：${entry.title}\n  ${meta}${entry.summary ? `\n  摘要：${entry.summary}` : ''}`
}

/** 拼简报正文：角度列表 + 素材清单，在 Obsidian 里直接可读。 */
function briefMarkdown({ date, generatedAt, angles, rawText, input }) {
  const lines = [
    '---',
    `日期: ${date}`,
    `类型: 选题简报`,
    '状态: 已生成',
    `生成时间: ${generatedAt}`,
    '---',
    '',
    `# ${date} 选题简报`,
    '',
  ]

  if (angles.length) {
    lines.push('## 角度', '')
    angles.forEach((angle, index) => {
      lines.push(`### ${index + 1}. ${angle.title}`)
      lines.push(`**为什么值得写：** ${angle.why || '（模型没有给出理由）'}`)
      lines.push(`**素材：** ${angle.materials.length ? angle.materials.join('、') : '（没有指定素材）'}`)
      lines.push('')
    })
  } else {
    // 模型没按约定回 JSON：原文照录，别丢内容，也别让接口报 500。
    lines.push('## 模型输出未解析', '', '模型没有按约定的 JSON 格式回复，下面是原文：', '')
    for (const line of String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n')) lines.push(`    ${line}`)
    lines.push('')
  }

  lines.push('## 素材清单', '')
  if (input.materials.length) {
    for (const entry of input.materials) {
      const meta = [entry.type, entry.tags?.length ? entry.tags.join('、') : ''].filter(Boolean).join(' · ')
      lines.push(`- [[${targetOf(entry.path)}]] · ${entry.title}${meta ? ` · ${meta}` : ''}${entry.summary ? ` — ${entry.summary}` : ''}`)
    }
  } else {
    lines.push('- （最近 30 天没有素材）')
  }
  if (input.notes.length) {
    lines.push('', '## 参考笔记', '')
    for (const note of input.notes) lines.push(`- [[${note.path.replace(/\.md$/i, '')}]]`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 从简报正文里读回角度（读不懂就返回空数组，不报错）。 */
export function parseAngles(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(line => /^##\s+角度\s*$/.test(line))
  if (start < 0) return []
  const angles = []
  let current = null
  const flush = () => {
    if (current && current.title) angles.push(current)
    current = null
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line)) break
    const heading = /^###\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      current = { title: heading[1].replace(/^\d+[.、]\s*/, '').trim(), why: '', materials: [] }
      continue
    }
    if (!current) continue
    const why = /^\*\*为什么值得写：\*\*\s*(.*)$/.exec(line)
    if (why) { current.why = why[1].trim(); continue }
    const materials = /^\*\*素材：\*\*\s*(.*)$/.exec(line)
    if (materials) current.materials = parseMaterialRefs(materials[1])
  }
  flush()
  return angles
}

function parseMaterialRefs(text) {
  const wiki = [...String(text).matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim())
  if (wiki.length) return uniqueTargets(wiki)
  if (/没有指定素材/.test(text)) return []
  return uniqueTargets(String(text).split(/[、,，]/).map(item => item.trim()))
}

/** 解析模型回复里的角度 JSON；不是合法 JSON、没有 angles、每条都不合格时返回空数组。 */
export function parseAnglesJson(text) {
  const raw = String(text ?? '').trim()
  const unfenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(raw)
  const value = tryJson(unfenced ? unfenced[1].trim() : raw)
    ?? tryJson(extractObject(unfenced ? unfenced[1].trim() : raw))
  if (!value || !Array.isArray(value.angles)) return []
  const angles = []
  for (const item of value.angles) {
    if (!item || typeof item !== 'object') continue
    const title = oneLine(item.title).slice(0, 100)
    if (!title) continue
    angles.push({
      title,
      why: oneLine(item.why).slice(0, 500),
      materials: stringList(item.materials).slice(0, 10),
    })
    if (angles.length >= ANGLE_LIMIT) break
  }
  return angles
}

function tryJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function extractObject(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : ''
}

function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = oneLine(item)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

// ---- 建选题与放素材 ----

/** 选中一个角度：新建「选题」文章，正文只有 `# 标题`，frontmatter 写素材链接。 */
async function createTopicArticle(ctx, body) {
  const materials = await resolveMaterials(ctx, body.materials)
  const created = await createArticle(ctx, body.title)
  if (materials.length) await writeArticleMaterials(ctx, created.path, materials)
  return {
    path: created.path,
    title: created.title,
    status: created.status,
    materials: materials.length ? materials : [],
  }
}

/** 把多选素材合并进已有「选题」文章；正文和其余 frontmatter 逐字不变。 */
async function addMaterialsToTopic(ctx, rawPath, rawMaterials) {
  const path = articleIndexPath(rawPath)
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e.code === 'not_found') throw new HttpError(404, 'not_found', '库里没有这篇文章')
    throw e
  }
  const status = parseFrontmatter(note.content).attributes['状态'] ?? ''
  if (status !== TOPIC_STATUS) {
    throw new HttpError(409, 'article_not_topic', '只有状态为「选题」的文章才能放素材')
  }
  const materials = await resolveMaterials(ctx, rawMaterials)
  if (!materials.length) throw new HttpError(400, 'materials_invalid', 'materials 至少要有一条素材')
  return { path, materials: await writeArticleMaterials(ctx, path, materials, note) }
}

/** 读出文章、合并 素材: 块并保存；返回合并后的素材目标列表。 */
async function writeArticleMaterials(ctx, path, materials, prefetched = null) {
  const note = prefetched ?? await readNote(ctx, path)
  const content = withMaterials(note.content, materials)
  if (content !== note.content) {
    const saved = await saveNote(ctx, path, content, note.version)
    if (saved.conflict) throw new HttpError(409, 'edit_conflict', '这篇文章在你打开之后被别处改过，没有保存素材')
  }
  return readMaterialTargets(content)
}

/**
 * 合并 素材: 字段：只替换这一个块（没有就插在 frontmatter 结尾前），
 * 正文和其他属性逐字不动；保留文件原来的换行风格。
 */
export function withMaterials(content, materials) {
  const raw = String(content)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== '---') throw new HttpError(409, 'frontmatter_missing', '这篇文章开头没有属性区（frontmatter），没有写入素材')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new HttpError(409, 'frontmatter_missing', '这篇文章开头没有属性区（frontmatter），没有写入素材')

  const block = materialBlockOf(lines, end)
  const merged = uniqueTargets([...block.targets, ...materials])
  const replacement = ['素材:', ...merged.map(target => `  - "[[${target}]]"`)]
  if (block.index < 0) lines.splice(end, 0, ...replacement)
  else lines.splice(block.index, block.count, ...replacement)
  return lines.join(eol)
}

function materialBlockOf(lines, end) {
  for (let i = 1; i < end; i++) {
    const m = /^素材\s*:(.*)$/.exec(lines[i])
    if (!m) continue
    const inline = m[1].trim()
    if (inline) return { index: i, count: 1, targets: parseInlineMaterials(inline) }
    const targets = []
    let count = 1
    for (let j = i + 1; j < end && /^\s*-\s+/.test(lines[j]); j++) {
      targets.push(...parseInlineMaterials(lines[j].replace(/^\s*-\s+/, '')))
      count++
    }
    return { index: i, count, targets: uniqueTargets(targets) }
  }
  return { index: -1, count: 0, targets: [] }
}

function parseInlineMaterials(text) {
  const value = String(text).trim()
  if (!value) return []
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(item => targetOf(stripQuotes(item))).filter(Boolean)
  }
  const wiki = [...value.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim())
  if (wiki.length) return wiki
  return value.split(/[、,，]/).map(item => targetOf(stripQuotes(item))).filter(Boolean)
}

function stripQuotes(value) {
  const text = String(value).trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

function readMaterialTargets(content) {
  const raw = String(content)
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== '---') return []
  const end = lines.indexOf('---', 1)
  if (end < 0) return []
  return materialBlockOf(lines, end).targets
}

/**
 * 校验并规范化一组素材：接受素材条目路径（`内容库/素材/<条目>`、`<条目>/index.md`、
 * `<条目>.md` 或 `[[…]]` 链接），也接受素材标题（模型给的是「路径或标题」）。
 * 不认识的素材 → 400 material_missing；返回去重后的库内条目路径（不带 .md）。
 */
async function resolveMaterials(ctx, raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new HttpError(400, 'materials_invalid', 'materials 必须是素材路径或标题组成的数组')
  if (raw.length > 50) throw new HttpError(400, 'materials_invalid', '一次最多放 50 条素材')
  let entries = null
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) throw new HttpError(400, 'materials_invalid', 'materials 里每项都必须是素材路径或标题')
    const text = item.trim()
    if (text.includes('/')) {
      const target = await materialEntryTarget(ctx, text)
      if (!target) throw new HttpError(400, 'material_missing', `素材「${text}」不在库里，没有写入`)
      addTarget(out, target)
      continue
    }
    entries ??= await listMaterialEntries(ctx)
    const match = entries.find(entry => entry.title === text)
      ?? entries.find(entry => entry.title.includes(text) || text.includes(entry.title))
    if (!match) throw new HttpError(400, 'material_missing', `没有标题是「${text}」的素材，没有写入`)
    addTarget(out, targetOf(match.path))
  }
  return out
}

/** 把输入换成真实存在的素材条目路径；不是素材文件夹里的、找不到的都返回 null。 */
async function materialEntryTarget(ctx, raw) {
  const target = targetOf(raw)
  if (!target.startsWith(MATERIALS_FOLDER + '/')) return null
  if (target.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null
  const name = target.slice(MATERIALS_FOLDER.length + 1)
  if (!name || RESERVED_MATERIALS.has(name)) return null
  if (await noteExists(ctx, `${target}/index.md`) || await noteExists(ctx, `${target}.md`)) return target
  return null
}

async function noteExists(ctx, path) {
  try {
    await readNote(ctx, path)
    return true
  } catch (e) {
    if (e.code === 'not_found') return false
    throw e
  }
}

/** 库内路径 → `[[链接]]` 里的目标：去掉 `/index.md` 和 `.md`，统一用库根相对路径。 */
function targetOf(raw) {
  let text = String(raw ?? '').trim()
  const wiki = /^\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]$/.exec(text)
  if (wiki) text = wiki[1].trim()
  return text.replace(/\/+$/, '').replace(/\/index\.md$/i, '').replace(/\.md$/i, '')
}

function uniqueTargets(targets) {
  const out = []
  for (const target of targets) addTarget(out, target)
  return out
}

function addTarget(out, target) {
  const value = targetOf(target)
  if (value && !out.includes(value)) out.push(value)
}

// ---- 和 AI 讨论角度 ----

async function discuss(ctx, rawAngle, rawWhy) {
  const angle = typeof rawAngle === 'string' ? rawAngle.trim() : ''
  if (!angle) throw new HttpError(400, 'angle_missing', '要讨论的角度不能为空')
  const why = typeof rawWhy === 'string' ? rawWhy.trim() : ''
  const date = localDate(ctx.now())
  const note = await readIfExists(ctx, `${BRIEFS_DIR}/${date}.md`)

  const lines = [
    '你是我的写作搭档。我们来讨论一个选题角度，帮我看清它值不值得写、怎么写。',
    '',
    `角度：${angle}`,
  ]
  if (why) lines.push(`为什么值得写：${why}`)
  lines.push('', '今天的选题简报：', note ? note.content : '（今天还没有生成选题简报）')
  lines.push(
    '',
    '请围绕这个角度给出：1）它真正想说的是什么；2）适合的读者和平台；3）可以从哪些素材切入；4）可能的反对意见或风险；5）先写哪一段。不要替我写正文。',
  )
  return { prompt: lines.join('\n') }
}

// ---- 小工具 ----

async function readIfExists(ctx, path) {
  try {
    return await readNote(ctx, path)
  } catch (e) {
    if (e.code === 'not_found') return null
    throw e
  }
}
