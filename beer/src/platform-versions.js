// 平台版本共用的平台列表和生成快照。
// 快照存在 Beer 数据目录（config.root/versions/）里，不进内容库：
// 主稿全文用来做过期对比和逐行 diff，生成的正文用来在规则学习时和用户改后的版本对比。
// versions.js 生成时写入，rules.js 观察改稿时读取。
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { versionOf } from './modules/library.js'

export const PLATFORMS = ['知乎', '小红书']
export const PLATFORM_SLUGS = { 知乎: 'zhihu', 小红书: 'xiaohongshu' }

/** 一个文章条目 + 一个平台对应一个快照文件。 */
export function versionSnapshotFile(ctx, articleFolder, platform) {
  const slug = PLATFORM_SLUGS[platform]
  if (!slug) throw new Error(`未知平台：${platform}`)
  const key = createHash('sha256').update(articleFolder, 'utf8').digest('hex')
  return join(ctx.config.root, 'versions', `${key}-${slug}.json`)
}

export async function saveVersionSnapshot(ctx, snapshot) {
  const file = versionSnapshotFile(ctx, snapshot.article, snapshot.platform)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify({
    article: snapshot.article,
    platform: snapshot.platform,
    mainDraftVersion: snapshot.mainDraftVersion,
    generatedAt: snapshot.generatedAt,
    mainDraft: snapshot.mainDraft,
    generatedBody: snapshot.generatedBody,
  }, null, 2) + '\n')
  await rename(tmp, file)
}

/** 读快照；文件不存在或内容坏了都返回 null（调用方按「没有快照」处理）。 */
export async function loadVersionSnapshot(ctx, articleFolder, platform) {
  try {
    return JSON.parse(await readFile(versionSnapshotFile(ctx, articleFolder, platform), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 平台版本的正文是否被用户改过：把正文按 LF 归一后和生成时记录的 `生成内容版本` 比。
 * 没有记录（老文件 / 用户自己写的）也算改过，绝不当成可覆盖的生成版本。
 */
export function versionEdited(contentBody, recordedVersion) {
  const body = String(contentBody ?? '').replace(/\r\n?/g, '\n')
  return !recordedVersion || versionOf(Buffer.from(body, 'utf8')) !== recordedVersion
}

/** 去掉 Markdown 文件开头的 frontmatter，只留正文。 */
export function bodyOf(content) {
  const text = String(content).replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  if (lines[0] !== '---') return text
  const end = lines.indexOf('---', 1)
  if (end < 0) return text
  let body = lines.slice(end + 1).join('\n')
  if (body.startsWith('\n')) body = body.slice(1)
  return body
}
