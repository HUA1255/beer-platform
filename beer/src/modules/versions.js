// 平台版本：为成稿按平台改写，生成 `知乎.md` / `小红书.md`，放在同一个文章条目里。
//   POST /api/beer/articles/versions/generate { path, platforms? }
//        → { versions: [...], hardRuleWarnings: [{ platform, rule, reason }], hardRuleCheckError? }
//   GET  /api/beer/articles/versions?path= → { versions: [{ platform, path, generatedAt, mainDraftVersion, stale, userEdited, action }] }
//   POST /api/beer/articles/versions/regenerate { path, platform } → { versions: [...], hardRuleWarnings: [...], hardRuleCheckError? }
//
// 规则：
// - 主稿 index.md 只读，本模块绝不改它的任何一个字节。
// - 生成时把主稿版本、生成时间、生成内容版本写进平台文件的 frontmatter。
// - 用户改过的平台文件永远不覆盖：generate / regenerate 检查出 userEdited 就回 409，
//   并用生成时存下的主稿快照和当前主稿做逐行 diff，告诉面板主稿改了哪里。
// - 主稿快照和生成的正文都存在 Beer 数据目录（config.root/versions/），不进内容库。
// - 规则开关打开时：软规则附在改写提示词里；版本文件写完后用硬规则检查生成正文，
//   检查失败只回 hardRuleWarnings: [] + hardRuleCheckError，不影响已经生成的版本。
import { HttpError, reply } from '../http/router.js'
import { chatText } from '../llm.js'
import { PLATFORMS, bodyOf, loadVersionSnapshot, saveVersionSnapshot, versionEdited } from '../platform-versions.js'
import { articleIndexPath, parseFrontmatter } from './articles.js'
import { createNote, readNote, saveNote, versionOf } from './library.js'
import { checkHardRules, enabledRules } from './rules.js'

export { PLATFORMS, bodyOf }

const PLATFORM_GUIDES = {
  知乎: '保留完整观点和论证，开头先给结论或问题，正文分 3–5 个小节，可以加 Markdown 小标题；语气客观、克制，面向愿意读长文的读者。',
  小红书: '口语化、第一人称，短段落短句子；开头一句要抓人，正文分 3–6 个小段，每段 1–3 句；结尾给一句总结或提问，最后附 3–5 个话题标签（#开头）。',
}

export function register(router, ctx) {
  router.post('/articles/versions/generate', async req => {
    const body = (await req.json()) ?? {}
    return generateVersions(ctx, body.path, body.platforms)
  })
  router.get('/articles/versions', async req => listVersions(ctx, req.query.get('path')))
  router.post('/articles/versions/regenerate', async req => {
    const body = (await req.json()) ?? {}
    return regenerateVersion(ctx, body.path, body.platform)
  })
}

async function listVersions(ctx, rawPath) {
  const article = await readArticle(ctx, rawPath)
  const versions = await existingVersions(ctx, article, PLATFORMS)
  return {
    versions: versions.map(v => describeVersion(v, article.note.version)),
  }
}

// ---- 重新生成 ----

async function regenerateVersion(ctx, rawPath, rawPlatform) {
  const platform = singlePlatform(rawPlatform)
  const article = await readArticle(ctx, rawPath)
  const existing = await inspectVersion(ctx, article, platform)
  if (!existing) throw new HttpError(404, 'version_missing', '这个平台版本还没有生成过，先生成再重新生成')
  if (existing.userEdited) return userEditedReply(ctx, article, existing)

  // 规则开关打开时，软规则只作为改写提示带进提示词；关闭时连规则文件都不读。
  const rules = await enabledRules(ctx)
  const text = await chatText(ctx, platformMessages(article, platform, rules?.soft))
  const generated = cleanGeneratedBody(text)
  if (!generated) throw new HttpError(502, 'model_bad_response', '模型没有返回正文，没有重新生成平台版本')
  const version = await writeVersion(ctx, article, platform, generated)
  return { versions: [version], ...(await hardRuleCheck(ctx, rules, [{ platform, body: generated }])) }
}

function singlePlatform(raw) {
  if (typeof raw !== 'string' || !PLATFORMS.includes(raw)) {
    throw new HttpError(400, 'platform_invalid', '平台只能选 知乎 或 小红书')
  }
  return raw
}

// ---- 生成 ----

async function generateVersions(ctx, rawPath, rawPlatforms) {
  const platforms = normalizePlatforms(rawPlatforms)
  const article = await readArticle(ctx, rawPath)

  // 先看一遍已有版本：有用户改过的就不调模型、不写任何文件。
  const existing = await existingVersions(ctx, article, platforms)
  const blocked = existing.find(v => v.userEdited)
  if (blocked) return userEditedReply(ctx, article, blocked)

  // 规则开关打开时，软规则只作为改写提示带进提示词；关闭时连规则文件都不读。
  const rules = await enabledRules(ctx)

  // 先逐平台调模型，全部成功后再写文件：中途失败不会留下半套平台版本。
  const drafts = []
  for (const platform of platforms) {
    const text = await chatText(ctx, platformMessages(article, platform, rules?.soft))
    const generated = cleanGeneratedBody(text)
    if (!generated) throw new HttpError(502, 'model_bad_response', '模型没有返回正文，没有生成平台版本')
    drafts.push({ platform, body: generated })
  }
  const versions = []
  for (const draft of drafts) {
    versions.push(await writeVersion(ctx, article, draft.platform, draft.body))
  }
  // 硬规则检查在平台版本文件写完之后做；检查失败不影响已经生成的版本。
  return { versions, ...(await hardRuleCheck(ctx, rules, drafts)) }
}

/**
 * 生成后检查硬规则。开关关闭、没有硬规则、或模型检查失败都不阻止版本生成：
 * 前两种回空数组，模型失败回空数组 + hardRuleCheckError。
 */
async function hardRuleCheck(ctx, rules, drafts) {
  if (!rules || rules.hard.length === 0) return { hardRuleWarnings: [] }
  const warnings = []
  const errors = []
  for (const draft of drafts) {
    try {
      for (const violation of await checkHardRules(ctx, rules.hard, draft.body)) {
        warnings.push({ platform: draft.platform, ...violation })
      }
    } catch (e) {
      errors.push(e?.message || String(e))
    }
  }
  // 检查本身失败时按工单约定只回空提醒 + 错误说明，不把部分结果混在里面。
  return errors.length
    ? { hardRuleWarnings: [], hardRuleCheckError: errors.join('；') }
    : { hardRuleWarnings: warnings }
}

function normalizePlatforms(raw) {
  if (raw === undefined) return [...PLATFORMS]
  if (!Array.isArray(raw) || !raw.length) {
    throw new HttpError(400, 'platform_invalid', 'platforms 必须是 知乎、小红书 组成的非空数组')
  }
  const platforms = []
  for (const value of raw) {
    if (typeof value !== 'string' || !PLATFORMS.includes(value)) {
      throw new HttpError(400, 'platform_invalid', '平台只能选 知乎 或 小红书')
    }
    if (!platforms.includes(value)) platforms.push(value)
  }
  return platforms
}

/** 只输出正文的改写提示：按平台要求重写，不照抄主稿，不带 frontmatter；软规则只作提示。 */
function platformMessages(article, platform, softRules = []) {
  const title = article.meta['标题'] || '（无标题）'
  const userLines = [
    `平台：${platform}`,
    `文章标题：${title}`,
    `改写要求：${PLATFORM_GUIDES[platform]}`,
  ]
  if (softRules.length) {
    userLines.push('', '写作软规则（尽量遵守，不必逐条说明）：', ...softRules.map(rule => `- ${rule}`))
  }
  userLines.push('', '主稿全文：', article.note.content)
  return [
    {
      role: 'system',
      content: '你是中文写作编辑，负责把作者的主稿改写成指定平台的版本。要求：完全重写表达和结构，不要整段照抄主稿；只用主稿里已有的观点、事实和例子，不要编造或补充主稿没有的内容；主稿很短时改写版也要短，不要为了凑小节或段数而扩写；只输出改写后的正文（Markdown），不要输出 frontmatter、解释、前后缀或代码块。',
    },
    { role: 'user', content: userLines.join('\n') },
  ]
}

/** 模型偶尔会包代码块或带 frontmatter；这里清理成纯正文，并统一成末尾一个换行。 */
function cleanGeneratedBody(text) {
  let body = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(body)
  if (fenced) body = fenced[1].trim()
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(end + 4).replace(/^\n/, '').trim()
  }
  return body ? body.replace(/\s+$/, '') + '\n' : ''
}

// ---- 平台文件与元数据 ----

/**
 * 写一个平台版本：先写文件（元数据一起写入），成功后再更新主稿快照（供之后做 diff）。
 * 已存在且用户没改过时覆盖；文件在生成期间被改过则 409，不覆盖。
 */
async function writeVersion(ctx, article, platform, body) {
  const generatedAt = ctx.now().toISOString()
  const path = article.folder + '/' + platform + '.md'
  const content = platformFile({
    platform,
    mainDraftVersion: article.note.version,
    generatedAt,
    body,
  })

  const existing = await inspectVersion(ctx, article, platform)
  if (!existing) {
    try {
      await createNote(ctx, path, content)
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'file_exists')) throw e
      // 检查之后才冒出来的文件：按「被改过」处理，绝不覆盖。
      throw new HttpError(409, 'version_user_edited', '这个平台版本在生成过程中被改过，没有覆盖')
    }
  } else {
    if (existing.userEdited) {
      throw new HttpError(409, 'version_user_edited', `「${platform}」版本在生成过程中被改过，没有覆盖`)
    }
    const saved = await saveNote(ctx, path, content, existing.note.version)
    if (saved.conflict) {
      throw new HttpError(409, 'version_user_edited', `「${platform}」版本在生成过程中被改过，没有覆盖`)
    }
  }
  await saveVersionSnapshot(ctx, {
    article: article.folder,
    platform,
    mainDraftVersion: article.note.version,
    generatedAt,
    mainDraft: article.note.content,
    generatedBody: body,
  })
  return describeVersion({
    platform,
    path,
    generatedAt,
    mainDraftVersion: article.note.version,
    userEdited: false,
  }, article.note.version)
}

function platformFile({ platform, mainDraftVersion, generatedAt, body }) {
  const contentVersion = versionOf(Buffer.from(body, 'utf8'))
  return [
    '---',
    `平台: ${platform}`,
    `主稿版本: ${mainDraftVersion}`,
    `生成时间: ${generatedAt}`,
    `生成内容版本: ${contentVersion}`,
    '---',
    '',
    body,
  ].join('\n')
}

/** 读一个平台版本（不存在返回 null），判断它是否被用户改过。 */
async function inspectVersion(ctx, article, platform) {
  const path = article.folder + '/' + platform + '.md'
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  }
  const meta = parseFrontmatter(note.content)
  const recorded = meta['生成内容版本'] || null
  return {
    platform,
    path,
    note,
    meta,
    generatedAt: meta['生成时间'] || null,
    mainDraftVersion: meta['主稿版本'] || null,
    // 没有生成元数据的平台文件视为用户自己写的，绝不当成可覆盖的版本。
    userEdited: versionEdited(bodyOf(note.content), recorded),
  }
}

async function existingVersions(ctx, article, platforms) {
  const versions = []
  for (const platform of platforms) {
    const version = await inspectVersion(ctx, article, platform)
    if (version) versions.push(version)
  }
  return versions
}

/** 去掉开头 `---` 属性区由 platform-versions.bodyOf 统一处理；发布分页对照时也用正文。 */


// ---- 主稿 ----

/** 读出文章的 index.md（也接受条目文件夹路径）；主稿内容只读。 */
async function readArticle(ctx, rawPath) {
  const path = articleIndexPath(rawPath)
  let note
  try {
    note = await readNote(ctx, path)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, 'not_found', '库里没有这篇文章')
    throw e
  }
  return { path, folder: path.slice(0, -'/index.md'.length), note, meta: parseFrontmatter(note.content) }
}

// ---- 主稿快照与逐行 diff ----

/** 用户改过时的 409：带生成时主稿快照与当前主稿的逐行差异，绝不覆盖文件。 */
async function userEditedReply(ctx, article, version) {
  const snapshot = await loadVersionSnapshot(ctx, article.folder, version.platform)
  const changes = snapshot && typeof snapshot.mainDraft === 'string'
    ? diffLines(snapshot.mainDraft, article.note.content)
    : { added: [], removed: [] }
  return reply(409, {
    error: {
      code: 'version_user_edited',
      message: `「${version.platform}」版本你改过，不会覆盖；主稿改了哪里见 mainDraftChanges`,
    },
    platform: version.platform,
    mainDraftChanges: changes,
  })
}

/** 逐行 diff（LCS）：返回当前主稿相对生成时快照新增、删除的行。 */
export function diffLines(before, after) {
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length * b.length > 4_000_000) return bagDiff(a, b)
  const added = []
  const removed = []
  for (const line of diffLineList(before, after)) {
    if (line.type === 'added') added.push(line.text)
    else if (line.type === 'removed') removed.push(line.text)
  }
  return { added, removed }
}

/**
 * 逐行 diff（LCS），保留行序：每行是 { type: 'same' | 'added' | 'removed', text }。
 * 发布分页用它把主稿和平台版本并排对照；`before` 是基准（主稿），`added` 是基准里没有的行。
 */
export function diffLineList(before, after) {
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length * b.length > 4_000_000) {
    // 太长不做 LCS，直接当成整篇换掉，至少还能看出新增和删除的行。
    return [
      ...a.map(text => ({ type: 'removed', text })),
      ...b.map(text => ({ type: 'added', text })),
    ]
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const diff = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      diff.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: 'removed', text: a[i++] })
    } else {
      diff.push({ type: 'added', text: b[j++] })
    }
  }
  while (i < a.length) diff.push({ type: 'removed', text: a[i++] })
  while (j < b.length) diff.push({ type: 'added', text: b[j++] })
  return diff
}

function linesOf(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 主稿特别长时退回按行计数比较，避免 O(n×m) 的表格太大。 */
function bagDiff(a, b) {
  const remaining = new Map()
  for (const line of a) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  const added = []
  for (const line of b) {
    const left = remaining.get(line) ?? 0
    if (left > 0) remaining.set(line, left - 1)
    else added.push(line)
  }
  const all = new Map()
  for (const line of b) all.set(line, (all.get(line) ?? 0) + 1)
  const removed = []
  for (const line of a) {
    const left = all.get(line) ?? 0
    if (left > 0) all.set(line, left - 1)
    else removed.push(line)
  }
  return { added, removed }
}

function describeVersion(version, currentMainVersion) {
  const stale = version.mainDraftVersion === null || version.mainDraftVersion !== currentMainVersion
  const action = stale ? (version.userEdited ? 'prompt_only' : 'regenerate') : 'ok'
  return {
    platform: version.platform,
    path: version.path,
    generatedAt: version.generatedAt,
    mainDraftVersion: version.mainDraftVersion,
    stale,
    userEdited: version.userEdited,
    action,
  }
}
