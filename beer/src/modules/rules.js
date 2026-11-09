// 规则学习：从用户改过的平台版本里归纳写作规则，同一条规则观察满 3 次后由用户转正。
//   GET  /api/beer/rules/settings             → { enabled }
//   PUT  /api/beer/rules/settings { enabled } → { enabled }
//   GET  /api/beer/rules                      → { enabled, hard, soft, pending: [{ rule, count }], observations: [{ rule, count }] }
//   POST /api/beer/rules/observe { path, platform }
//        → { observed: true, added: [{ rule, evidence, count }], pending } 或
//          { observed: false, reason: 'disabled' | 'no_snapshot' | 'unchanged', added: [], pending }
//   POST /api/beer/rules/promote { rule, kind: 'hard' | 'soft' }
//        → { rule, kind, path, enabled, hard, soft, pending, observations }；不满 3 次 → 409 rule_not_ready
//
// 规则文件在内容库的 `内容库/规则/` 下：硬规则.md、软规则.md，一行一条 `- 规则文本`。
// 只把 `- ` 开头的行当规则；文件里的标题、说明等其他行原样保留，文件不存在时按需创建。
// 开关默认关闭，存在 ctx.state 的 `rules` 键里。关闭时 observe 不做任何学习、不调模型、不写规则文件；
// 生成平台版本时也不读规则、不检查、提示词里不放规则。
// 硬规则在生成平台版本之后交给模型检查（检查失败不阻塞生成）；软规则只作为生成提示。
import { HttpError } from '../http/router.js'
import { chatText } from '../llm.js'
import { PLATFORMS, bodyOf, loadVersionSnapshot } from '../platform-versions.js'
import { createNote, readNote, saveNote } from './library.js'

const STATE_KEY = 'rules'
const HARD_FILE = '内容库/规则/硬规则.md'
const SOFT_FILE = '内容库/规则/软规则.md'
const READY_COUNT = 3
const MAX_RULES = 3

/** 同一个 ctx 的规则状态修改排成一队，避免并发 observe / promote 互相覆盖计数。 */
const stateLocks = new WeakMap()

export function register(router, ctx) {
  router.get('/rules/settings', async () => ({ enabled: (await readState(ctx)).enabled }))
  router.put('/rules/settings', async req => {
    const body = (await req.json()) ?? {}
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled_invalid', 'enabled 必须是 true 或 false')
    }
    return withStateLock(ctx, async () => {
      const state = await readState(ctx)
      state.enabled = body.enabled
      await saveState(ctx, state)
      return { enabled: state.enabled }
    })
  })
  router.get('/rules', async () => listRules(ctx))
  router.post('/rules/observe', async req => {
    const body = (await req.json()) ?? {}
    return observe(ctx, body.path, body.platform)
  })
  router.post('/rules/promote', async req => {
    const body = (await req.json()) ?? {}
    return promote(ctx, body.rule, body.kind)
  })
}

// ---- 状态 ----

async function readState(ctx) {
  const raw = await ctx.state.get(STATE_KEY)
  const source = raw && typeof raw === 'object' ? raw : {}
  const observations = Array.isArray(source.observations)
    ? source.observations
      .filter(o => o && typeof o.rule === 'string' && o.rule.trim())
      .map(o => ({
        rule: o.rule.trim(),
        count: Number.isFinite(o.count) ? Math.max(0, Math.floor(o.count)) : 0,
        evidence: typeof o.evidence === 'string' ? o.evidence : '',
        updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
      }))
    : []
  return { enabled: source.enabled === true, observations }
}

async function saveState(ctx, state) {
  await ctx.state.set(STATE_KEY, {
    enabled: state.enabled === true,
    observations: state.observations,
  })
}

function withStateLock(ctx, fn) {
  const previous = stateLocks.get(ctx) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  stateLocks.set(ctx, next.then(() => {}, () => {}))
  return next
}

function pendingOf(state) {
  return state.observations
    .filter(o => o.count >= READY_COUNT)
    .map(({ rule, count }) => ({ rule, count }))
}

function observationsOf(state) {
  return state.observations.map(({ rule, count }) => ({ rule, count }))
}

// ---- 查询与转正 ----

async function listRules(ctx) {
  const [state, files] = await Promise.all([readState(ctx), readRuleFiles(ctx)])
  return {
    enabled: state.enabled,
    hard: files.hard,
    soft: files.soft,
    pending: pendingOf(state),
    observations: observationsOf(state),
  }
}

async function promote(ctx, rawRule, rawKind) {
  const rule = typeof rawRule === 'string' ? rawRule.trim() : ''
  if (!rule) throw new HttpError(400, 'rule_invalid', '规则文本不能为空')
  if (rawKind !== 'hard' && rawKind !== 'soft') {
    throw new HttpError(400, 'kind_invalid', 'kind 只能是 hard（硬规则）或 soft（软规则）')
  }
  const kind = rawKind
  return withStateLock(ctx, async () => {
    const state = await readState(ctx)
    const entry = state.observations.find(o => o.rule === rule)
    if (!entry || entry.count < READY_COUNT) {
      throw new HttpError(409, 'rule_not_ready', `这条规则还没观察满 ${READY_COUNT} 次，不能转正`)
    }
    const path = kind === 'hard' ? HARD_FILE : SOFT_FILE
    await appendRuleLine(ctx, path, rule)
    state.observations = state.observations.filter(o => o.rule !== rule)
    await saveState(ctx, state)
    const files = await readRuleFiles(ctx)
    return {
      rule,
      kind,
      path,
      enabled: state.enabled,
      hard: files.hard,
      soft: files.soft,
      pending: pendingOf(state),
      observations: observationsOf(state),
    }
  })
}

// ---- 观察改稿 ----

async function observe(ctx, rawPath, rawPlatform) {
  const platform = platformOf(rawPlatform)
  const path = platformPathOf(rawPath, platform)

  const before = await readState(ctx)
  if (!before.enabled) {
    return { observed: false, reason: 'disabled', added: [], pending: pendingOf(before) }
  }

  const note = await readNote(ctx, path)
  const folder = path.slice(0, -(`/${platform}.md`.length))
  const snapshot = await loadVersionSnapshot(ctx, folder, platform)
  if (!snapshot || typeof snapshot.generatedBody !== 'string') {
    return { observed: false, reason: 'no_snapshot', added: [], pending: pendingOf(before) }
  }

  const currentBody = bodyOf(note.content)
  if (sameBody(snapshot.generatedBody, currentBody)) {
    return { observed: false, reason: 'unchanged', added: [], pending: pendingOf(before) }
  }

  // 归纳要调模型，先不占状态锁；回来后再确认开关没被关掉。
  const knownRules = before.observations.map(o => o.rule)
  const text = await chatText(ctx, observeMessages(platform, snapshot.generatedBody, currentBody, knownRules), { temperature: 0.2 })
  const learned = parseRules(text)

  return withStateLock(ctx, async () => {
    const state = await readState(ctx)
    if (!state.enabled) {
      return { observed: false, reason: 'disabled', added: [], pending: pendingOf(state) }
    }
    const current = await readRuleFiles(ctx)
    const known = new Set([...current.hard, ...current.soft])
    const now = ctx.now().toISOString()
    const added = []
    for (const item of learned) {
      if (known.has(item.rule)) continue
      const existing = state.observations.find(o => o.rule === item.rule)
      if (existing) {
        existing.count += 1
        if (item.evidence) existing.evidence = item.evidence
        existing.updatedAt = now
        added.push({ ...item, count: existing.count })
      } else {
        state.observations.push({ rule: item.rule, count: 1, evidence: item.evidence, updatedAt: now })
        added.push({ ...item, count: 1 })
      }
    }
    if (added.length) await saveState(ctx, state)
    return { observed: true, added, pending: pendingOf(state) }
  })
}

function platformOf(raw) {
  if (typeof raw !== 'string' || !PLATFORMS.includes(raw)) {
    throw new HttpError(400, 'platform_invalid', '平台只能选 知乎 或 小红书')
  }
  return raw
}

function platformPathOf(raw, platform) {
  const suffix = `/${platform}.md`
  if (typeof raw !== 'string' || raw.includes('\0') || !raw.endsWith(suffix) || raw.length === suffix.length) {
    throw new HttpError(400, 'path_invalid', `path 必须是 ${platform} 平台版本文件的库内路径（…${suffix}）`)
  }
  return raw
}

function sameBody(a, b) {
  const normalize = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  return normalize(a) === normalize(b)
}

// ---- 规则文件 ----

/** 读硬规则、软规则列表；文件不存在时是空数组，不创建文件。 */
export async function readRuleFiles(ctx) {
  const [hard, soft] = await Promise.all([
    readRuleLines(ctx, HARD_FILE),
    readRuleLines(ctx, SOFT_FILE),
  ])
  return { hard, soft }
}

async function readRuleLines(ctx, path) {
  const note = await readRuleFile(ctx, path)
  return note ? parseRuleLines(note.content) : []
}

async function readRuleFile(ctx, path) {
  try {
    const note = await readNote(ctx, path)
    return { content: note.content, version: note.version }
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  }
}

/** 只认 `- 规则文本` 的行；其他行（标题、说明）留给用户自己写。 */
function parseRuleLines(content) {
  const rules = []
  for (const line of String(content).replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^\s*-\s+(.*)$/.exec(line)
    if (!match) continue
    const rule = match[1].trim()
    if (rule && !rules.includes(rule)) rules.push(rule)
  }
  return rules
}

/** 在规则文件末尾追加一行；文件不存在时新建，已有相同规则时不动。 */
async function appendRuleLine(ctx, path, rule) {
  const line = `- ${rule}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readRuleFile(ctx, path)
    if (current) {
      if (parseRuleLines(current.content).includes(rule)) return
      const content = current.content === '' || current.content.endsWith('\n')
        ? current.content + line + '\n'
        : current.content + '\n' + line + '\n'
      const saved = await saveNote(ctx, path, content, current.version)
      if (!saved.conflict) return
      continue
    }
    try {
      await createNote(ctx, path, line + '\n')
      return
    } catch (e) {
      // 读的时候还没有，写的时候被别处建出来了：重读一遍，按已有文件追加。
      if (!(e instanceof HttpError && e.code === 'file_exists')) throw e
    }
  }
  throw new HttpError(409, 'rule_file_conflict', '规则文件正在被别处修改，请稍后再试')
}

// ---- 规则开关与模型提示 ----

/** 首页汇总用：开关、硬规则数、软规则数、待转正数（只给数字，不返回规则原文）。 */
export async function ruleSummary(ctx) {
  const [state, files] = await Promise.all([readState(ctx), readRuleFiles(ctx)])
  return {
    enabled: state.enabled,
    hard: files.hard.length,
    soft: files.soft.length,
    pending: pendingOf(state).length,
  }
}

/** 开关打开时读出硬规则和软规则；关闭时返回 null，调用方连规则文件都不读。 */
export async function enabledRules(ctx) {
  const state = await readState(ctx)
  if (!state.enabled) return null
  return readRuleFiles(ctx)
}

/**
 * 观察改稿时让模型归纳 0–3 条规则；只输出 JSON。
 * 计数按规则原文累加，所以把已经记下的规则一起给模型，意思相同时要它原样沿用那条的文字。
 */
function observeMessages(platform, generatedBody, currentBody, knownRules = []) {
  const known = knownRules.length
    ? ['', '已经记下的规则（新归纳的规则和其中某条意思相同时，必须原样输出那条的文字，一个字都不要改）：', ...knownRules.map(rule => `- ${rule}`)]
    : []
  return [
    {
      role: 'system',
      content: '你是写作规则归纳助手。对比作者生成时和改后的平台版本，归纳出可复用的写作规则。只输出 JSON：{"rules":[{"rule":"一句话写作要求","evidence":"对应改动"}]}。规则用祈使句，一条只说一件事，最多 3 条；没有可归纳的规则就输出 {"rules":[]}。不要输出解释或代码块。',
    },
    {
      role: 'user',
      content: [
        `平台：${platform}`,
        '',
        '生成时的正文：',
        generatedBody,
        '',
        '作者改后的正文：',
        currentBody,
        ...known,
      ].join('\n'),
    },
  ]
}

/**
 * 拿生成的正文去对硬规则。模型只回 JSON：{"violations":[{"rule":"...","reason":"..."}]}。
 * 返回 { rule, reason } 数组；调用方决定检查失败时怎么处理（这里直接抛错）。
 */
export async function checkHardRules(ctx, hardRules, text) {
  const content = await chatText(ctx, [
    {
      role: 'system',
      content: '你是硬规则检查助手，负责检查一段平台版本正文是否违反硬规则。只输出 JSON：{"violations":[{"rule":"违反的硬规则","reason":"正文里对应的具体问题"}]}。没有违规就输出 {"violations":[]}。不要输出解释或代码块。',
    },
    {
      role: 'user',
      content: [
        '硬规则：',
        ...hardRules.map(rule => `- ${rule}`),
        '',
        '正文：',
        text,
      ].join('\n'),
    },
  ], { temperature: 0.1 })
  const data = parseModelJson(content)
  if (!data || !Array.isArray(data.violations)) {
    throw new HttpError(502, 'model_bad_response', '模型没有按格式返回硬规则检查结果')
  }
  const violations = []
  for (const item of data.violations) {
    const rule = typeof item?.rule === 'string' ? item.rule.trim() : ''
    if (!rule) continue
    violations.push({
      rule,
      reason: typeof item?.reason === 'string' ? item.reason.trim() : '',
    })
  }
  return violations
}

function parseRules(text) {
  const data = parseModelJson(text)
  if (!data || !Array.isArray(data.rules)) {
    throw new HttpError(502, 'model_bad_response', '模型没有按格式返回规则，这次没有学习')
  }
  const rules = []
  const seen = new Set()
  for (const item of data.rules) {
    const raw = typeof item === 'string' ? item : item?.rule
    const rule = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
    if (!rule || seen.has(rule)) continue
    seen.add(rule)
    rules.push({
      rule,
      evidence: typeof item?.evidence === 'string' ? item.evidence.trim() : '',
    })
    if (rules.length >= MAX_RULES) break
  }
  return rules
}

/** 模型偶尔包代码块或前后带说明；取出第一个完整 JSON 对象。 */
function parseModelJson(text) {
  let body = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fenced) body = fenced[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}
