// 库位置：用户在宿主目录选择器里选定的 Obsidian 库根目录。
//   GET /api/beer/vault → { status: 'unset' } | { status: 'ready', path } | { status: 'missing', path }
//   PUT /api/beer/vault { path } → { status: 'ready', path }
// 只记住用户确认过的已有文件夹；不建目录、不往库里写东西。用户取消选择时面板不调用 PUT，什么都不留下。
// 其他模块用 resolveVault(ctx) 拿到可用的库根目录。
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { HttpError } from '../http/router.js'

export function register(router, ctx) {
  router.get('/vault', async () => {
    const saved = await ctx.state.get('vault')
    if (!saved?.path) return { status: 'unset' }
    return { status: (await isDirectory(saved.path)) ? 'ready' : 'missing', path: saved.path }
  })

  router.put('/vault', async req => {
    const { path } = await req.json()
    if (typeof path !== 'string' || !path || !isAbsolute(path)) {
      throw new HttpError(400, 'vault_invalid', '库位置必须是绝对路径')
    }
    const normalized = resolve(path)
    if (!(await isDirectory(normalized))) {
      throw new HttpError(400, 'vault_not_found', '这个位置不存在或不是文件夹，请重新选择')
    }
    await ctx.state.set('vault', { path: normalized })
    return { status: 'ready', path: normalized }
  })
}

/** 当前可用的库根目录；没选或已不存在时抛 409，提示面板重新选库。 */
export async function resolveVault(ctx) {
  const saved = await ctx.state.get('vault')
  if (!saved?.path) throw new HttpError(409, 'vault_unset', '还没有选择 Obsidian 库')
  if (!(await isDirectory(saved.path))) throw new HttpError(409, 'vault_missing', '之前选的 Obsidian 库找不到了，请重新选择')
  return saved.path
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
