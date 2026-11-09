// 面板按需加载的前端文件（不经宿主的插件合并包）：
//   GET /api/beer/client/editor.js → Markdown 实时预览编辑器（editor/live-editor.js 打包出来的 ES 模块）
// 面板进入编辑时 import() 它；文件随插件包一起发布，路径相对本文件找。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { HttpError } from '../http/router.js'

const EDITOR_FILE = fileURLToPath(new URL('../../client/editor.js', import.meta.url))

export function register(router) {
  router.get('/client/editor.js', async req => {
    let bytes
    try {
      bytes = await readFile(EDITOR_FILE)
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'not_found', '插件包里缺编辑器文件，需要重新打包（npm run build:editor）')
      throw e
    }
    req.res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    req.res.end(bytes)
  })
}
