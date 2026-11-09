// 回收站：删除即把库内一项移到库里的 `.trash`，保留原相对路径，可恢复，只手动清理。
//   POST   /api/beer/library/trash { path } → { id, path, originalPath, trashedTo, kind, size, deletedAt }
//   GET    /api/beer/trash                  → { items: [{ id, path, originalPath, kind, size, deletedAt }] }
// 回收站里每一项的原路径和删除时间记在 `.trash/.beer-trash.json` 里，恢复要靠它。
// 目标已存在时自动加时间戳和序号，绝不覆盖；没有任何定时清理，只有 DELETE 接口才会真的删东西。
// 文件操作一律经 library.js 的 locate 定位，不在这里自己拼库内路径。
import { readFile, writeFile, mkdir, rename, rm, lstat, readdir, rmdir } from 'node:fs/promises'
import { join, dirname, extname, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { HttpError } from '../http/router.js'
import { locate } from './library.js'

const TRASH_DIR = '.trash'
const MANIFEST_NAME = '.beer-trash.json'
const MANIFEST_PATH = `${TRASH_DIR}/${MANIFEST_NAME}`

export function register(router, ctx) {
  router.post('/library/trash', async req => {
    const { path } = await req.json()
    return moveToTrash(ctx, path)
  })
  router.get('/trash', async () => listTrash(ctx))
  router.post('/trash/restore', async req => {
    const { id } = await req.json()
    return restoreFromTrash(ctx, id)
  })
  router.delete('/trash', async () => clearTrash(ctx))
}

/** 把库内一项移到 `.trash/<原路径>`，返回这一项在回收站里的记录。 */
export async function moveToTrash(ctx, path) {
  return withLock(async () => {
    if (typeof path === 'string' && isTrashPath(path)) {
      throw new HttpError(400, 'trash_path_invalid', '回收站里的东西不能再移到回收站')
    }
    const source = await locate(ctx, path)
    let info
    try {
      info = await lstat(source)
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'not_found', '库里没有这一项，无法移到回收站')
      throw e
    }
    if (!info.isFile() && !info.isDirectory()) {
      throw new HttpError(400, 'not_deletable', '只能删除文件或文件夹')
    }
    const kind = info.isDirectory() ? 'folder' : 'file'
    const size = info.isFile() ? info.size : await folderSize(source)
    const now = ctx.now()
    const deletedAt = now.toISOString()

    const trashedTo = await freeTrashPath(ctx, path, kind, now)
    const target = await locate(ctx, trashedTo)
    await mkdir(dirname(target), { recursive: true })

    const entry = { id: newId(), originalPath: path, trashedTo, kind, size, deletedAt }
    const manifest = await readManifest(ctx)
    await rename(source, target)
    try {
      manifest.items.push(entry)
      await writeManifest(ctx, manifest.items)
    } catch (e) {
      // 清单写不进去时把文件挪回去，不留「库外有文件、回收站没记录」的状态。
      await rename(target, source).catch(() => {})
      throw e
    }
    return { id: entry.id, path, originalPath: path, trashedTo, kind, size, deletedAt }
  })
}

/** 列出回收站里还在的项，最新的在前。 */
export async function listTrash(ctx) {
  const manifest = await readManifest(ctx)
  const items = []
  for (const entry of manifest.items) {
    try {
      await lstat(await locate(ctx, entry.trashedTo))
    } catch {
      continue // 用户在 Obsidian 里手动删掉了：列表里不显示，清单留着也不影响别的
    }
    items.push({
      id: entry.id,
      path: entry.trashedTo,
      originalPath: entry.originalPath,
      kind: entry.kind,
      size: entry.size,
      deletedAt: entry.deletedAt,
    })
  }
  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id))
  return { items }
}

/** 把回收站里的一项移回原路径；原位置已经被占用时不覆盖，返回 409。 */
export async function restoreFromTrash(ctx, id) {
  return withLock(async () => {
    if (typeof id !== 'string' || !id) {
      throw new HttpError(400, 'id_invalid', '要恢复哪一项？请带上回收站条目的 id')
    }
    const manifest = await readManifest(ctx)
    const index = manifest.items.findIndex(e => e.id === id)
    if (index < 0) throw new HttpError(404, 'trash_item_not_found', '回收站里没有这一项')
    const entry = manifest.items[index]

    const trashed = await locateForManifest(ctx, entry.trashedTo)
    // 原路径要是被人改坏（比如逃出库外）就当清单坏了；只是原位置现在不可用则算冲突。
    let original
    try {
      original = await locate(ctx, entry.originalPath)
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) {
        throw new HttpError(409, 'restore_conflict', '原位置现在不能写入，没有恢复')
      }
      if (e instanceof HttpError && e.status === 400) throw manifestInvalid()
      throw e
    }

    try {
      await lstat(trashed)
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'trash_item_missing', '回收站里的这一项已经不在了')
      throw e
    }
    let occupied = true
    try {
      await lstat(original)
    } catch (e) {
      if (e.code === 'ENOENT') occupied = false
      else throw e
    }
    if (occupied) throw restoreConflict()

    try {
      await mkdir(dirname(original), { recursive: true })
      await rename(trashed, original)
    } catch (e) {
      if (e instanceof HttpError) throw e
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'ENOTDIR', 'EACCES'].includes(e.code)) throw restoreConflict()
      throw e
    }
    await writeManifest(ctx, manifest.items.filter((_, i) => i !== index))
    // 回收站里这一项留下的空文件夹一并收掉（只到 .trash 为止）。
    await pruneEmptyDirs(trashed, await locate(ctx, TRASH_DIR))
    return { id, path: entry.originalPath }
  })
}

/** 手动清空回收站：删掉 `.trash` 里的全部内容（清单除外）并清空清单；不删 `.trash` 文件夹本身。 */
export async function clearTrash(ctx) {
  return withLock(async () => {
    let removed = 0
    try {
      removed = (await readManifest(ctx)).items.length
    } catch (e) {
      // 清单坏了也不该挡住「清空回收站」这个最后的清理办法。
      if (!(e instanceof HttpError && e.code === 'trash_manifest_invalid')) throw e
    }
    const trashDir = await locate(ctx, TRASH_DIR)
    let names
    try {
      names = await readdir(trashDir)
    } catch (e) {
      if (e.code === 'ENOENT') return { removed: 0 }
      throw e
    }
    for (const name of names) {
      if (name === MANIFEST_NAME) continue
      await rm(join(trashDir, name), { recursive: true, force: true })
    }
    await writeManifest(ctx, [])
    return { removed }
  })
}

function restoreConflict() {
  return new HttpError(409, 'restore_conflict', '原位置已经有同名文件或文件夹，没有恢复，也没有覆盖')
}

function manifestInvalid() {
  return new HttpError(500, 'trash_manifest_invalid', '回收站清单里的路径不合法，无法恢复')
}

async function locateForManifest(ctx, path) {
  try {
    return await locate(ctx, path)
  } catch (e) {
    if (e instanceof HttpError) throw manifestInvalid()
    throw e
  }
}

/** 从 start 的上级开始向上删空文件夹，到 stopAt（不含）为止。 */
async function pruneEmptyDirs(start, stopAt) {
  let dir = dirname(start)
  while (dir !== stopAt && dir.startsWith(stopAt + sep)) {
    try {
      await rmdir(dir)
    } catch {
      break
    }
    dir = dirname(dir)
  }
}

// ---- 清单 ----

async function readManifest(ctx) {
  const file = await locate(ctx, MANIFEST_PATH)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { items: [] }
    throw e
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(500, 'trash_manifest_invalid', '回收站清单损坏了（.trash/.beer-trash.json 不是合法 JSON）')
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new HttpError(500, 'trash_manifest_invalid', '回收站清单损坏了（.trash/.beer-trash.json 结构不对）')
  }
  const items = parsed.items.filter(isEntry)
  // 清单里可能有人手改的越界路径：这里先做结构过滤，真正移动 / 删除前还会用 locate 校验。
  return { items: items.filter(e => !isTrashPath(e.originalPath)) }
}

function isEntry(e) {
  return e && typeof e === 'object' &&
    typeof e.id === 'string' && e.id &&
    typeof e.originalPath === 'string' && e.originalPath &&
    typeof e.trashedTo === 'string' && e.trashedTo.startsWith(TRASH_DIR + '/') &&
    (e.kind === 'file' || e.kind === 'folder') &&
    typeof e.size === 'number' && typeof e.deletedAt === 'string'
}

async function writeManifest(ctx, items) {
  const file = await locate(ctx, MANIFEST_PATH)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2) + '\n')
  await rename(tmp, file)
}

// ---- 路径 ----

/** `.trash/<原路径>`；已存在时在文件名后加时间戳，再撞就加 -2、-3…… 绝不覆盖。 */
async function freeTrashPath(ctx, path, kind, now) {
  const base = `${TRASH_DIR}/${path}`
  if (!(await exists(ctx, base))) return base
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const name = path.slice(dir.length)
  const ext = kind === 'file' ? extname(name) : ''
  const stem = ext ? name.slice(0, -ext.length) : name
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  for (let i = 1; i < 1000; i++) {
    const candidate = `${TRASH_DIR}/${dir}${stem}-${stamp}${i > 1 ? `-${i}` : ''}${ext}`
    if (!(await exists(ctx, candidate))) return candidate
  }
  throw new HttpError(409, 'trash_name_exhausted', '回收站里同名项太多，换一个名字再试')
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

/** 路径的第一段是不是回收站目录（Windows / macOS 的默认文件系统不区分大小写，按小写比）。 */
function isTrashPath(path) {
  return path.split(/[\\/]/)[0].toLowerCase() === TRASH_DIR
}

async function folderSize(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await folderSize(child)
      else if (entry.isFile()) total += (await lstat(child)).size
    } catch {
      // 统计大小时文件刚好被移走：忽略，不在删除时因此失败
    }
  }
  return total
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function newId() {
  return `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

// 同一进程里的删除 / 恢复 / 清空排队执行，免得同时改回收站清单互相覆盖。
let lock = Promise.resolve()
function withLock(fn) {
  const run = lock.then(fn, fn)
  lock = run.then(() => {}, () => {})
  return run
}
