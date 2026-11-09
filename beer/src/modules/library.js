// 库访问：在用户选定的 Obsidian 库根目录之内列文件夹、读、存 Markdown。
//   GET /api/beer/library/folder?path=<库内相对路径>  → { path, exists, entries: [{ name, path, kind, size, modifiedAt }] }
//   GET /api/beer/library/file?path=<…/x.md>          → { path, content, version, modifiedAt }
//   PUT /api/beer/library/file { path, content, baseVersion } → { path, version, modifiedAt }
//   GET /api/beer/library/asset?path=<链接里写的路径>&from=<笔记路径> → 图片字节（预览里显示图片用）
//       先按笔记所在文件夹解析相对路径，再按库根，最后（Obsidian 的 ![[文件名]]）在整个库里按文件名找。
//   POST /api/beer/library/attachment?from=<笔记路径>&name=<文件名>  请求体是图片字节 → 201 { path, link }
//       编辑器里粘贴 / 拖入的图片存到笔记旁边的 images/（发布到 Rin、发布包都只认这个文件夹），
//       link 是写进正文的相对路径（images/xx.png）。重名自动加序号，不覆盖；单张上限 20 MB。
//       文件在读取后被别处改过 / 删掉 → 409 { error: { code: 'edit_conflict' }, current: { version, modifiedAt } | null }，不写入。
// 冲突后给哪些选项（合并、覆盖、放弃、另存副本）待定，这里只检测。
// 每次冲突把 { path, detectedAt } 记到 ctx.state 的 edit-conflicts（最多 50 条，同一路径只留最新），
// 该路径之后保存成功时删掉这条记录；首页读最近几条展示。
// 回收站、搜索、文章、素材、录音等模块直接 import locate / listFolder / readNote / saveNote / createNote / writeNote / createEntry / parseFrontmatter，不要绕开这里自己拼路径。
// 新建条目（一个文件夹 + 几个文件）用 createEntry，它负责名称安全化和重名避让。
import { readFile, writeFile, rename, rm, stat, realpath, readdir, mkdir } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join, dirname, basename, isAbsolute, sep, extname } from 'node:path'
import { HttpError, reply } from '../http/router.js'
import { resolveVault } from './vault.js'

// 路径一律用 / 分隔；Windows 上反斜杠也是分隔符，按同一规则校验，免得 `..\..` 绕过段级检查。
const PATH_SEPARATORS = process.platform === 'win32' ? /[\\/]/ : '/'

export function register(router, ctx) {
  router.get('/library/folder', async req => listFolder(ctx, req.query.get('path') ?? ''))
  router.get('/library/file', async req => readNote(ctx, req.query.get('path')))
  router.post('/library/attachment', async req => {
    const saved = await saveAttachment(ctx, {
      from: req.query.get('from'),
      name: req.query.get('name'),
      contentType: req.headers['content-type'],
      body: req.req,
    })
    return reply(201, saved)
  })
  router.get('/library/asset', async req => {
    const file = await findAsset(ctx, req.query.get('path'), req.query.get('from'))
    const bytes = await readFile(file)
    req.res.writeHead(200, {
      'content-type': IMAGE_TYPES[extname(file).toLowerCase()],
      'content-length': String(bytes.length),
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      // SVG 也可能带脚本：就算被单独打开也不让它执行
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
    req.res.end(bytes)
  })
  router.put('/library/file', async req => {
    const { path, content, baseVersion } = await req.json()
    const result = await saveNote(ctx, path, content, baseVersion)
    if (result.conflict) {
      return reply(409, {
        error: { code: 'edit_conflict', message: '这个文件在你打开之后被别处改过，没有保存，原文件保持不变' },
        current: result.current,
      })
    }
    return result
  })
}

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}
const ATTACHMENT_DIR = 'images'
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
const EXT_BY_IMAGE_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/avif': '.avif' }
const NAME_SEARCH_LIMIT = 50000 // 按文件名找时最多看这么多个文件，防止超大库卡住
const NAME_INDEX_TTL_MS = 30 * 1000
const nameIndexes = new WeakMap() // ctx → { root, builtAt, byName: Map<文件名, 库内路径[]> }

/**
 * 预览里的图片链接 → 磁盘路径。target 是 Markdown 里写的路径（可带 %20、./、../），
 * from 是这篇笔记的库内路径。依次试：笔记所在文件夹、库根、整个库里同名文件（离笔记近、路径短的优先）。
 */
export async function findAsset(ctx, target, from) {
  let raw = typeof target === 'string' ? target.trim() : ''
  try { raw = decodeURIComponent(raw) } catch {}
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[a-z]+:/i.test(raw)) {
    throw new HttpError(400, 'path_invalid', '图片路径必须是库内的相对路径')
  }
  if (!IMAGE_TYPES[extname(raw).toLowerCase()]) throw new HttpError(415, 'not_image', '只能显示图片文件')

  const baseDir = typeof from === 'string' && from ? from.split('/').slice(0, -1) : []
  const candidates = []
  const relative = joinSegments(baseDir, raw)
  if (relative) candidates.push(relative)
  else if (baseDir.length) throw new HttpError(400, 'path_invalid', '图片路径跑到库外了')
  const fromRoot = joinSegments([], raw)
  if (fromRoot && fromRoot !== relative) candidates.push(fromRoot)

  for (const path of candidates) {
    const file = await locate(ctx, path)
    if (await isFile(file)) return file
  }
  if (!raw.includes('/')) {
    const hits = await filesNamed(ctx, raw)
    const prefix = baseDir.join('/')
    const near = hits.filter(p => prefix && p.startsWith(prefix + '/'))
    const pick = (near.length ? near : hits).sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
    if (pick) return locate(ctx, pick)
  }
  throw new HttpError(404, 'not_found', '库里没有这张图片')
}

/**
 * 把粘贴 / 拖入的图片存到笔记旁边的 images/。from 是笔记的库内路径（.md），
 * name 是原文件名（可空，空时按时间起名），body 是请求流。返回 { path, link }。
 */
export async function saveAttachment(ctx, { from, name, contentType, body }) {
  if (typeof from !== 'string' || !/\.md$/i.test(from)) throw new HttpError(400, 'from_invalid', '要说明图片贴在哪篇笔记里')
  const noteDir = from.split('/').slice(0, -1)
  await locate(ctx, from) // 校验笔记路径在库内

  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  let fileName = typeof name === 'string' ? name.split(/[\\/]/).pop().trim() : ''
  let ext = extname(fileName).toLowerCase()
  if (!IMAGE_TYPES[ext]) {
    if (fileName || !EXT_BY_IMAGE_TYPE[type]) throw new HttpError(415, 'not_image', '只能贴图片文件')
    ext = EXT_BY_IMAGE_TYPE[type]
  }
  let stem = fileName ? fileName.slice(0, fileName.length - extname(fileName).length) : ''
  stem = stem.replace(/[\s#%?\[\]|^:*"<>]+/g, '-').replace(/^[-.]+|-+$/g, '')
  if (!stem) stem = '粘贴图片-' + stampOf(ctx.now())

  // 读完整个请求体：超过上限也要读完再回 413，不然对方还在发就被断开
  const chunks = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.length
    if (size <= ATTACHMENT_MAX_BYTES) chunks.push(chunk)
  }
  if (size > ATTACHMENT_MAX_BYTES) throw new HttpError(413, 'too_large', '图片太大了（单张最多 20 MB）')
  if (!size) throw new HttpError(400, 'empty', '图片是空的')
  const bytes = Buffer.concat(chunks)

  const dirPath = [...noteDir, ATTACHMENT_DIR].join('/')
  const dir = await locate(ctx, dirPath)
  await mkdir(dir, { recursive: true })
  for (let n = 0; n < 1000; n++) {
    const finalName = (n ? `${stem}-${n}` : stem) + ext
    try {
      await writeFile(join(dir, finalName), bytes, { flag: 'wx' })
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    nameIndexes.delete(ctx) // 新图片马上能按文件名找到
    return { path: `${dirPath}/${finalName}`, link: `${ATTACHMENT_DIR}/${finalName}` }
  }
  throw new HttpError(409, 'name_taken', '同名图片太多了，换个文件名再试')
}

function stampOf(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 把相对路径接到 base 后面并处理 . / ..；跑出库根返回 null。 */
function joinSegments(base, rel) {
  const out = [...base]
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length ? out.join('/') : null
}

async function isFile(file) {
  try { return (await stat(file)).isFile() } catch { return false }
}

/** 库里所有叫这个名字的文件（库内路径）。整个库的文件名索引缓存 30 秒。 */
async function filesNamed(ctx, name) {
  const root = await resolveVault(ctx)
  let index = nameIndexes.get(ctx)
  if (!index || index.root !== root || Date.now() - index.builtAt > NAME_INDEX_TTL_MS) {
    const byName = new Map()
    let seen = 0
    const walk = async (dir, rel) => {
      let items
      try { items = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const item of items) {
        if (item.name.startsWith('.') || seen >= NAME_SEARCH_LIMIT) continue
        const path = rel ? `${rel}/${item.name}` : item.name
        if (item.isDirectory()) await walk(join(dir, item.name), path)
        else if (item.isFile()) {
          seen++
          const list = byName.get(item.name)
          if (list) list.push(path)
          else byName.set(item.name, [path])
        }
      }
    }
    await walk(root, '')
    index = { root, builtAt: Date.now(), byName }
    nameIndexes.set(ctx, index)
  }
  return [...(index.byName.get(name) ?? [])]
}

/**
 * 列出库内一个文件夹的直接内容（子文件夹在前，再按名称排；不列 `.` 开头的隐藏项）。
 * 文件夹还不存在时返回 exists: false 和空列表，不建目录。
 */
export async function listFolder(ctx, path) {
  const dir = await locate(ctx, path, { allowRoot: true })
  let names
  try {
    names = await readdir(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return { path, exists: false, entries: [] }
    if (e.code === 'ENOTDIR') throw new HttpError(400, 'not_folder', '这不是文件夹')
    throw e
  }
  const entries = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    let info
    try { info = await stat(join(dir, name)) } catch { continue } // 失效的符号链接等：跳过
    if (!info.isFile() && !info.isDirectory()) continue
    entries.push({
      name,
      path: path ? `${path}/${name}` : name,
      kind: info.isDirectory() ? 'folder' : 'file',
      size: info.isFile() ? info.size : undefined,
      modifiedAt: info.mtime.toISOString(),
    })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) : a.kind === 'folder' ? -1 : 1))
  return { path, exists: true, entries }
}

export async function readNote(ctx, path) {
  const file = await locateNote(ctx, path)
  const current = await snapshot(file)
  if (!current) throw new HttpError(404, 'not_found', '库里没有这个文件')
  return { path, content: current.bytes.toString('utf8'), version: current.version, modifiedAt: current.modifiedAt }
}

/**
 * 新建 Markdown 文件：父文件夹不存在时一并建出来。目标已存在时不覆盖，抛 409 `file_exists`。
 * 返回新文件的 { path, version, modifiedAt }。
 */
export async function createNote(ctx, path, content) {
  if (typeof content !== 'string') throw new HttpError(400, 'content_invalid', 'content 必须是字符串')
  const file = await locateNote(ctx, path)
  await mkdir(dirname(file), { recursive: true })
  const bytes = Buffer.from(content, 'utf8')
  try {
    await writeFile(file, bytes, { flag: 'wx' })
  } catch (e) {
    if (e.code === 'EEXIST') throw new HttpError(409, 'file_exists', '这个文件已经存在，没有覆盖')
    throw e
  }
  const info = await stat(file)
  return { path, version: versionOf(bytes), modifiedAt: info.mtime.toISOString() }
}

/**
 * 保存 Markdown。baseVersion 是读取时拿到的版本标记；文件此刻的版本对不上（被别处改过或删掉）时
 * 不写入，返回 { conflict: true, current: { version, modifiedAt } | null }。
 */
export async function saveNote(ctx, path, content, baseVersion) {
  if (typeof content !== 'string') throw new HttpError(400, 'content_invalid', 'content 必须是字符串')
  if (typeof baseVersion !== 'string' || !baseVersion) {
    throw new HttpError(400, 'base_version_invalid', '保存时要带上读取时的版本标记 baseVersion')
  }
  const file = await locateNote(ctx, path)
  const before = await snapshot(file)
  if (!before || before.version !== baseVersion) {
    await recordEditConflict(ctx, path)
    return conflict(before)
  }

  // 先写到同目录的临时文件，再核对一次版本后改名覆盖：别的程序永远看不到写了一半的文件。
  const tmp = join(dirname(file), `.${basename(file)}.beer-${randomBytes(6).toString('hex')}.tmp`)
  const bytes = Buffer.from(content, 'utf8')
  await writeFile(tmp, bytes)
  try {
    const now = await snapshot(file)
    if (!now || now.version !== baseVersion) {
      await rm(tmp, { force: true })
      await recordEditConflict(ctx, path)
      return conflict(now)
    }
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  await clearEditConflict(ctx, path)
  const info = await stat(file)
  return { path, version: versionOf(bytes), modifiedAt: info.mtime.toISOString() }
}

/**
 * 直接写 Markdown（不做冲突检测，父文件夹不存在时一起建）。给配置文件用：
 * 标签表这类文件允许覆盖，但调用方要自己保证只重写该改的部分。
 */
export async function writeNote(ctx, path, content) {
  if (typeof content !== 'string') throw new HttpError(400, 'content_invalid', 'content 必须是字符串')
  const file = await locateNote(ctx, path)
  return writeNewNote(file, path, content)
}

async function writeNewNote(file, path, content) {
  const bytes = Buffer.from(content, 'utf8')
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.beer-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tmp, bytes)
  try {
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  const info = await stat(file)
  return { path, version: versionOf(bytes), modifiedAt: info.mtime.toISOString() }
}

/**
 * 在库内一个文件夹下新建条目文件夹，写进去几个文件。
 * - 名称里的 `\\ / : * ? " < > |` 和控制字符去掉；去完为空时用 fallbackName。
 * - 已经有同名文件夹时依次试 `-2`、`-3`……，绝不覆盖已有条目。
 * - 任何一个文件写失败就把这次新建的文件夹整个删掉，不留下半成品。
 * @returns {Promise<{ path: string, name: string, files: string[] }>} path 是库内相对路径
 */
export async function createEntry(ctx, folder, name, files, { fallbackName = '未命名' } = {}) {
  const base = safeEntryName(name, fallbackName)
  const parent = await locate(ctx, folder, { allowRoot: true })
  await mkdir(parent, { recursive: true })

  let dir
  let folderName
  for (let n = 1; ; n++) {
    folderName = n === 1 ? base : `${base}-${n}`
    try {
      dir = join(parent, folderName)
      await mkdir(dir)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }

  try {
    for (const [file, content] of Object.entries(files)) {
      if (!isPlainFileName(file)) throw new Error(`条目里的文件名不合法：${file}`)
      await writeFile(join(dir, file), content)
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
  return { path: folder ? `${folder}/${folderName}` : folderName, name: folderName, files: Object.keys(files) }
}

/**
 * 条目名安全化：去掉文件名里不能用的字符和首尾空白（Windows 上结尾的点和空格也去掉），
 * 空名用 fallback；按字符截到 100 个，避免超出文件系统上限。
 */
export function safeEntryName(name, fallback = '未命名') {
  const trimmed = String(name ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim()
  const capped = [...trimmed].slice(0, 100).join('').replace(/[. ]+$/, '')
  return capped || fallback
}

function isPlainFileName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/\x00]/.test(name)
}

/**
 * 把库内相对路径（用 / 分隔，如 `内容库/文章/a/index.md`）换成磁盘上的绝对路径。
 * 拒绝：空路径、绝对路径、`..` / `.` / 空段、NUL（400 path_invalid）；
 * 经符号链接落到库外（403 outside_vault）。库根目录本身用空字符串表示（allowRoot）。
 */
export async function locate(ctx, path, { allowRoot = false } = {}) {
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path) || (!path && !allowRoot)) {
    throw new HttpError(400, 'path_invalid', '路径必须是库内的相对路径')
  }
  const segments = path ? path.split(PATH_SEPARATORS) : []
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    throw new HttpError(400, 'path_invalid', '路径必须是库内的相对路径')
  }
  const root = await resolveVault(ctx)
  const target = join(root, ...segments)
  const rootReal = await realpath(root)
  const real = await realpathOfExisting(target)
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new HttpError(403, 'outside_vault', '只能读写所选 Obsidian 库之内的文件')
  }
  return target
}

async function locateNote(ctx, path) {
  const file = await locate(ctx, path)
  if (extname(file).toLowerCase() !== '.md') throw new HttpError(415, 'not_markdown', '只能打开和编辑 Markdown（.md）文件')
  return file
}

/** 目标或它最近的已存在上级目录的真实路径（不存在的部分原样接上）。 */
async function realpathOfExisting(target) {
  let rest = ''
  let cur = target
  for (;;) {
    try {
      return join(await realpath(cur), rest)
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const parent = dirname(cur)
      if (parent === cur) throw e
      rest = rest ? join(basename(cur), rest) : basename(cur)
      cur = parent
    }
  }
}

/**
 * 读条目开头 `---` 之间的简单 YAML 子集：`键: 值`、`键: [a, b]`、`键:` 下面缩进的 `- 值`。
 * 只用于读素材属性，不追求完整 YAML；认不出的行忽略，正文原样返回。
 * 没有开头属性、或者 `---` 没闭合时，整篇都当正文（属性为空）。
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  const lines = source.split('\n')
  if (lines[0]?.replace(/\r$/, '').trim() !== '---') return { attributes: {}, body: source }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '').trim() === '---') { end = i; break }
  }
  if (end < 0) return { attributes: {}, body: source }

  const attributes = {}
  let lastKey = null
  for (let i = 1; i < end; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!line.trim()) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && lastKey) {
      if (!Array.isArray(attributes[lastKey])) attributes[lastKey] = []
      const value = unquote(item[1].trim())
      if (value) attributes[lastKey].push(value)
      continue
    }
    const pair = /^([^:#][^:]*):(.*)$/.exec(line)
    if (!pair) { lastKey = null; continue }
    lastKey = pair[1].trim()
    attributes[lastKey] = parseAttributeValue(pair[2].trim())
  }
  return { attributes, body: lines.slice(end + 1).join('\n') }
}

function parseAttributeValue(raw) {
  if (!raw) return ''
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean)
  }
  return unquote(raw)
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function conflict(current) {
  return { conflict: true, current: current ? { version: current.version, modifiedAt: current.modifiedAt } : null }
}

// ---- 编辑冲突记录：首页展示「哪些文件需要处理」，只是提示，不影响保存本身 ----

const EDIT_CONFLICTS_KEY = 'edit-conflicts'
const EDIT_CONFLICTS_LIMIT = 50

/** 同一个 ctx 的冲突记录修改排成一队，避免并发保存时互相覆盖。 */
const conflictLocks = new WeakMap()

/** 最近留下过编辑冲突的文件（最新的在前）。 */
/**
 * 当前库的编辑冲突记录（首页用）。每条记着是哪个库；换了库，旧库的记录就不显示（换回来还在）。
 * 早期没记库的记录：文件在当前库里还在才显示。
 */
export async function readEditConflicts(ctx) {
  let root
  try { root = await resolveVault(ctx) } catch { return [] }
  const shown = []
  for (const item of await readAllEditConflicts(ctx)) {
    if (item.vault ? item.vault !== root : !(await isFile(join(root, ...item.path.split('/'))))) continue
    shown.push({ path: item.path, detectedAt: item.detectedAt })
  }
  return shown
}

async function readAllEditConflicts(ctx) {
  const raw = await ctx.state.get(EDIT_CONFLICTS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (!item || typeof item.path !== 'string' || !item.path) return []
    return [{
      path: item.path,
      detectedAt: typeof item.detectedAt === 'string' ? item.detectedAt : '',
      ...(typeof item.vault === 'string' && item.vault ? { vault: item.vault } : {}),
    }]
  })
}

const sameConflict = (item, path, vault) => item.path === path && (!item.vault || item.vault === vault)

async function recordEditConflict(ctx, path) {
  await withConflictLock(ctx, async () => {
    const vault = await resolveVault(ctx)
    const rest = (await readAllEditConflicts(ctx)).filter(item => !sameConflict(item, path, vault))
    rest.unshift({ path, detectedAt: ctx.now().toISOString(), vault })
    await ctx.state.set(EDIT_CONFLICTS_KEY, rest.slice(0, EDIT_CONFLICTS_LIMIT))
  }).catch(() => {}) // 记录失败只是首页少一条提示，不能让这次保存 / 409 变成 500
}

async function clearEditConflict(ctx, path) {
  await withConflictLock(ctx, async () => {
    const vault = await resolveVault(ctx)
    const list = await readAllEditConflicts(ctx)
    const rest = list.filter(item => !sameConflict(item, path, vault))
    if (rest.length !== list.length) await ctx.state.set(EDIT_CONFLICTS_KEY, rest)
  }).catch(() => {})
}

function withConflictLock(ctx, fn) {
  const previous = conflictLocks.get(ctx) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  conflictLocks.set(ctx, next.then(() => {}, () => {}))
  return next
}

async function snapshot(file) {
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new HttpError(415, 'not_markdown', '只能打开和编辑 Markdown（.md）文件')
    const bytes = await readFile(file)
    return { bytes, version: versionOf(bytes), modifiedAt: info.mtime.toISOString() }
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

/** 内容版本标记（读取接口的 `version` 字段格式）：sha256-<十六进制>。 */
export function versionOf(bytes) {
  return 'sha256-' + createHash('sha256').update(bytes).digest('hex')
}
