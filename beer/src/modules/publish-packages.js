// 知乎、小红书发布包：把平台版本正文和条目图片整理到库外的一个固定文件夹，
// 用户自己粘到平台发布页，回来后填链接写发布记录。
//   POST /api/beer/publish/package { path, platform }
//        → { platform, text, images: [{ name, source, copiedTo }], packageDir, publishUrl }
//   POST /api/beer/publish/record { path, platform, url }
//        → { path, platform, url, status, record, appended }
//
// 规则：
// - 只有「已确认」「已发布」的文章能准备发布包；平台只有 知乎、小红书。
// - 正文取条目里的 <platform>.md，去掉开头属性区；没有这个平台版本 → 409 version_missing。
// - 图片从条目 images/ 复制到 config.root/publish-packages/<安全条目名>-<platform>/，
//   目录已存在时清空重建，避免上一次的旧图混进来。Beer 数据目录在库外，内容库不写任何东西。
// - 服务端只准备文字和图片：不登录任何平台、不发任何平台请求，提交由用户自己在网页上点。
// - 发布记录复用 publish.js 的写法（`- <YYYY-MM-DD HH:mm> <平台> <链接>`），
//   同一条（平台 + 链接）重复提交不重复追加；主稿的「已确认」只在记录时改成「已发布」。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { HttpError } from '../http/router.js'
import { listFolder, locate, readNote, safeEntryName } from './library.js'
import { STATUS_CONFIRMED, STATUS_PUBLISHED } from './articles.js'
import {
  IMAGE_EXTENSIONS,
  appendRecordLine,
  formatRecordLine,
  readArticle,
  setStatus,
} from './publish.js'
import { PLATFORMS, bodyOf } from './versions.js'

const PACKAGE_STATUSES = [STATUS_CONFIRMED, STATUS_PUBLISHED]
const RECORD_PLATFORMS = [...PLATFORMS, 'Rin 博客']
const IMAGE_DIR = 'images'
const PACKAGES_DIR = 'publish-packages'
const [ZHIHU, XIAOHONGSHU] = PLATFORMS
const PUBLISH_URLS = {
  [ZHIHU]: 'https://zhuanlan.zhihu.com/write',
  [XIAOHONGSHU]: 'https://creator.xiaohongshu.com/publish/publish',
}

export function register(router, ctx) {
  router.post('/publish/package', async req => {
    const body = (await req.json()) ?? {}
    return preparePackage(ctx, body.path, body.platform)
  })
  router.post('/publish/record', async req => {
    const body = (await req.json()) ?? {}
    return recordPublish(ctx, body.path, body.platform, body.url)
  })
}

// ---- 发布包 ----

/**
 * 准备一个发布包：平台版本正文 + 条目图片的副本。
 * 只读库里的文件，所有输出都写到 Beer 数据目录。
 */
export async function preparePackage(ctx, rawPath, rawPlatform) {
  const platform = assertPlatform(rawPlatform)
  const article = await readArticle(ctx, rawPath)
  assertPackageStatus(article)
  const pkg = await packageOf(ctx, article, platform)
  if (!pkg) {
    throw new HttpError(409, 'version_missing', `这个条目还没有「${platform}」版本，先生成平台版本再准备发布包`)
  }
  return pkg
}

/**
 * 确认发布后顺手准备所有已有平台版本的包（目前是知乎、小红书），返回数组。
 * 没有对应平台版本文件的平台跳过；不向任何平台发请求。
 */
export async function preparePackages(ctx, rawPath) {
  const article = await readArticle(ctx, rawPath)
  assertPackageStatus(article)
  const packages = []
  for (const platform of PLATFORMS) {
    const pkg = await packageOf(ctx, article, platform)
    if (pkg) packages.push(pkg)
  }
  return packages
}

function assertPackageStatus(article) {
  const status = article.meta['状态'] || ''
  if (!PACKAGE_STATUSES.includes(status)) {
    throw new HttpError(409, 'status_invalid', `当前状态是「${status || '无'}」，只有「已确认」或「已发布」的文章能准备发布包`)
  }
}

function assertPlatform(raw) {
  if (typeof raw !== 'string' || !PLATFORMS.includes(raw)) {
    throw new HttpError(400, 'platform_invalid', '平台只能选 知乎 或 小红书')
  }
  return raw
}

/** 一个平台的发布包；没有这个平台版本文件时返回 null（批量准备时跳过）。 */
async function packageOf(ctx, article, platform) {
  const text = await platformTextIfExists(ctx, article, platform)
  if (text === null) return null
  const { packageDir, images } = await copyImages(ctx, article, platform)
  return { platform, text, images, packageDir, publishUrl: PUBLISH_URLS[platform] }
}

async function platformTextIfExists(ctx, article, platform) {
  try {
    return await platformText(ctx, article, platform)
  } catch (e) {
    if (e instanceof HttpError && e.code === 'version_missing') return null
    throw e
  }
}

/** 读平台版本的正文（去掉 frontmatter）；没有这个版本时 409，提示先生成。 */
async function platformText(ctx, article, platform) {
  const path = article.folder + '/' + platform + '.md'
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new HttpError(409, 'version_missing', `这个条目还没有「${platform}」版本，先生成平台版本再准备发布包`)
    }
    throw e
  }
  return bodyOf(note.content)
}

/**
 * 把条目 images/ 下的图片复制到库外的发布包目录。
 * 目录固定按「条目名-平台」命名，每次先清空再建，旧图片不会混进来。
 * 图片名用原文件名；source 是库内相对路径，copiedTo 是复制后的绝对路径。
 */
async function copyImages(ctx, article, platform) {
  const entryName = safeEntryName(article.folder.split('/').pop() || '未命名')
  const packageDir = join(ctx.config.root, PACKAGES_DIR, `${entryName}-${platform}`)
  await rm(packageDir, { recursive: true, force: true })
  await mkdir(packageDir, { recursive: true })

  const listing = await listFolder(ctx, article.folder + '/' + IMAGE_DIR)
  if (!listing.exists) return { packageDir, images: [] }

  const images = []
  for (const entry of listing.entries) {
    if (entry.kind !== 'file') continue
    if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    const bytes = await readFile(await locate(ctx, entry.path))
    const copiedTo = join(packageDir, entry.name)
    await writeFile(copiedTo, bytes)
    images.push({ name: entry.name, source: entry.path, copiedTo })
  }
  return { packageDir, images }
}

// ---- 发布记录 ----

/**
 * 用户确认已发布后填链接：追加发布记录，主稿是「已确认」时改成「已发布」。
 * 同一平台同一链接重复提交不追加第二行；已是「已发布」不再改状态。
 */
async function recordPublish(ctx, rawPath, rawPlatform, rawUrl) {
  const platform = recordPlatform(rawPlatform)
  const url = httpUrl(rawUrl)
  const article = await readArticle(ctx, rawPath)
  const { path: recordPath, appended } = await appendRecordLine(
    ctx,
    article.folder,
    formatRecordLine(ctx.now(), platform, url),
    { skipIf: content => hasRecord(content, platform, url) },
  )

  let status = article.meta['状态'] || ''
  if (status === STATUS_CONFIRMED) {
    await setStatus(ctx, article, STATUS_PUBLISHED)
    status = STATUS_PUBLISHED
  }
  return { path: article.path, platform, url, status, record: recordPath, appended }
}

function recordPlatform(raw) {
  if (typeof raw !== 'string' || !RECORD_PLATFORMS.includes(raw)) {
    throw new HttpError(400, 'platform_invalid', '平台只能选 知乎、小红书 或 Rin 博客')
  }
  return raw
}

/** 只收完整的 http(s) 链接，去掉首尾空白；其他形式一律 400。 */
function httpUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  let parsed = null
  try {
    parsed = new URL(value)
  } catch {}
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new HttpError(400, 'url_invalid', '发布链接必须是 http 或 https 开头的完整地址')
  }
  return value
}

/** 记录里是否已经有这个平台的这个链接（不看时间；Rin 博客中间有空格，按行尾匹配）。 */
function hasRecord(content, platform, url) {
  return String(content)
    .split(/\r?\n/)
    .some(line => {
      const text = line.trim()
      return text.startsWith('- ') && text.endsWith(` ${platform} ${url}`)
    })
}
