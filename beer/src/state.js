// Beer 自己的非库数据（库位置、会话编号、分页的对话栏状态……），存在配置的数据目录里，
// 每个键一个 JSON 文件。只在写入时才建目录和文件；读不存在的键返回 undefined。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

export function createStateStore(dir) {
  const file = key => {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`非法的状态键：${key}`)
    return join(dir, `${key}.json`)
  }
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), 'utf8'))
      } catch (e) {
        if (e.code === 'ENOENT') return undefined
        throw e
      }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true })
      const target = file(key)
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
      await rename(tmp, target)
    },
  }
}
