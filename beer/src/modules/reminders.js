// 邮件提醒（#44）：对话里的 AI 建 / 查 / 取消提醒，交给云端提醒服务（Cloudflare Worker，见 cloud/reminder/README.md）。
// 到点由云端发邮件给自己，和 MacBook 开不开机、家里在不在线都无关。
//
// 地址：config.reminderApiBase；密钥：钥匙串里的 reminder-api-key。
// 连不上时明确说「提醒没建成」，不排队（和家里服务「断网不排队」一致）。
//
// 建和取消都分两步：先不带 confirmToken 调用，拿到复述文本（具体日期 + 星期 + 时刻）和确认码；
// AI 把复述给用户看，用户确认后再带上同一个确认码调用才真正执行。确认码是这批内容的指纹，
// 内容改了确认码就对不上，必须重新复述。
//
// 时间一律按北京时间理解和显示，交给云端时带 +08:00。
import { createHash } from 'node:crypto'
import { HttpError } from '../http/router.js'

export const REMINDER_DOWN = '提醒服务暂时连不上'
const CALL_TIMEOUT_MS = 15_000
const MAX_BATCH = 20
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const STATUS_TEXT = { pending: '待发', sent: '已发', failed: '发送失败', cancelled: '已取消' }

// ── 时间 ────────────────────────────────────────────────────────────────

/** 「2026-11-18 14:00」（北京时间）→ Date。也接受「2026-11-18T14:00」。不合法返回 null。 */
export function parseBeijing(text) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const date = new Date(Date.UTC(y, mo - 1, d, h - 8, mi))
  // 2 月 30 日之类会被 Date 顺延，顺延了就算不合法
  const back = new Date(date.getTime() + 8 * 3600e3)
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null
  return date
}

/** 北京时间的各部分。 */
function parts(date) {
  const d = new Date(date.getTime() + 8 * 3600e3)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
}

const pad = n => String(n).padStart(2, '0')

/** 11 月 18 日（周三）13:30；不是今年时带年份。 */
export function formatBeijing(date, now) {
  const p = parts(date)
  const year = now && parts(now).y !== p.y ? `${p.y} 年 ` : ''
  return `${year}${p.mo} 月 ${p.d} 日（${WEEKDAYS[p.wd]}）${pad(p.h)}:${pad(p.mi)}`
}

/** 交给云端的写法：2026-11-18T13:30:00+08:00。 */
function isoBeijing(date) {
  const p = parts(date)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00+08:00`
}

/**
 * 有具体时刻的事（面试、会议）默认建两封提醒：前一天晚上 21:30、开始前 1 小时（2026-11-12 定）。
 * 已经过了的那封跳过。
 */
export function defaultRemindTimes(eventAt) {
  const p = parts(eventAt)
  const dayBefore = new Date(Date.UTC(p.y, p.mo - 1, p.d - 1, 21 - 8, 30))
  const hourBefore = new Date(eventAt.getTime() - 3600e3)
  return [
    { at: dayBefore, label: '前一天晚上' },
    { at: hourBefore, label: '提前 1 小时' },
  ]
}

// ── 规划：把 AI 给的条目展开成具体的提醒 ─────────────────────────────────

/**
 * @param {Array<{ title: string, eventAt?: string, remindAt?: string, details?: string }>} items
 * @param {Date} now
 * @returns {{ plan: Array<{ dueAt: Date, title: string, body: string, label: string, eventAt?: Date }>, skipped: string[] }}
 */
export function planReminders(items, now) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'invalid', 'reminders 至少要有一条')
  if (items.length > MAX_BATCH) throw new HttpError(400, 'invalid', `一次最多建 ${MAX_BATCH} 件事的提醒`)
  const plan = []
  const skipped = []
  items.forEach((item, i) => {
    const n = `第 ${i + 1} 条`
    const title = typeof item?.title === 'string' ? item.title.trim() : ''
    if (!title) throw new HttpError(400, 'invalid', `${n}缺标题`)
    const details = typeof item.details === 'string' ? item.details.trim() : ''
    const eventAt = item.eventAt ? parseBeijing(item.eventAt) : null
    if (item.eventAt && !eventAt) throw new HttpError(400, 'invalid', `${n}的 eventAt 写法不对，要写成 2026-11-18 14:00（北京时间）`)
    const remindAt = item.remindAt ? parseBeijing(item.remindAt) : null
    if (item.remindAt && !remindAt) throw new HttpError(400, 'invalid', `${n}的 remindAt 写法不对，要写成 2026-11-18 13:30（北京时间）`)
    if (!eventAt && !remindAt) throw new HttpError(400, 'invalid', `${n}要给 eventAt（事情本身的时间）或 remindAt（发提醒的时间）`)

    const body = [eventAt ? `时间：${formatBeijing(eventAt, now)}` : '', details].filter(Boolean).join('\n')
    const times = remindAt ? [{ at: remindAt, label: '' }] : defaultRemindTimes(eventAt)
    for (const t of times) {
      if (t.at.getTime() <= now.getTime()) {
        skipped.push(`「${title}」${t.label || ''}的提醒（${formatBeijing(t.at, now)}）已经过了，不建`)
        continue
      }
      plan.push({ dueAt: t.at, title, body, label: t.label, eventAt: eventAt ?? undefined })
    }
  })
  if (plan.length === 0) throw new HttpError(400, 'due_in_past', ['要建的提醒时间都已经过了，一条也没建。', ...skipped].join('\n'))
  plan.sort((a, b) => a.dueAt - b.dueAt)
  return { plan, skipped }
}

/** 一批操作的指纹：内容一样才算同一次确认。 */
function fingerprint(kind, data) {
  return createHash('sha256').update(kind + '\n' + JSON.stringify(data)).digest('hex').slice(0, 12)
}

function planFingerprint(plan) {
  return fingerprint('create', plan.map(p => [p.dueAt.toISOString(), p.title, p.body]))
}

// ── 调云端 ──────────────────────────────────────────────────────────────

async function reminderKey(ctx) {
  let key
  try {
    key = await ctx.secrets.get('reminder-api-key')
  } catch {
    throw new HttpError(503, 'reminder_keychain_error', '读不出钥匙串里的提醒服务访问密钥（钥匙串可能已锁定），提醒没建成')
  }
  if (!key) throw new HttpError(503, 'reminder_no_key', '钥匙串里还没有提醒服务的访问密钥（账号名 reminder-api-key），可以在 Beer 设置里填')
  return key
}

/** 调云端提醒服务，返回 JSON；连不上抛 502 reminder_unreachable，云端报错原样带中文消息。 */
export async function reminderJson(ctx, method, path, body) {
  const key = await reminderKey(ctx)
  const base = String(ctx.config.reminderApiBase ?? '').replace(/\/+$/, '')
  if (!base) throw new HttpError(503, 'reminder_not_configured', '还没配置提醒服务地址（reminderApiBase）')
  let res
  try {
    res = await ctx.fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch {
    throw new HttpError(502, 'reminder_unreachable', REMINDER_DOWN)
  }
  let data
  try {
    data = await res.json()
  } catch {
    throw new HttpError(502, 'reminder_bad_response', '提醒服务返回的内容看不懂')
  }
  if (!res.ok) {
    throw new HttpError(res.status, data?.error?.code ?? 'reminder_error', data?.error?.message ?? `提醒服务返回 ${res.status}`)
  }
  return data
}

// ── 工具执行函数 ────────────────────────────────────────────────────────

/**
 * 建提醒。不带 confirmToken：只复述，不建。带上复述时给的 confirmToken：真正建。
 * @returns {{ text: string, confirmToken?: string, created?: object[] }}
 */
export async function createReminders(ctx, { reminders, confirmToken } = {}) {
  const now = ctx.now()
  const { plan, skipped } = planReminders(reminders, now)
  const token = planFingerprint(plan)
  const lines = plan.map(p => {
    const what = p.eventAt ? `${p.title}（${formatBeijing(p.eventAt, now)}）` : p.title
    return `· ${formatBeijing(p.dueAt, now)}${p.label ? ` [${p.label}]` : ''} —— ${what}`
  })

  if (!confirmToken) {
    return {
      confirmToken: token,
      text: [
        `要建 ${plan.length} 封邮件提醒（北京时间，发到你自己的邮箱）：`,
        ...lines,
        ...(skipped.length ? ['', ...skipped] : []),
        '',
        `还没建。请把上面的列表原样复述给用户并问「确认吗？」；用户确认后，用同样的 reminders 和 confirmToken: "${token}" 再调用一次才会真正建。用户要改就改完重新调用（不带 confirmToken）。`,
      ].join('\n'),
    }
  }
  if (confirmToken !== token) {
    throw new HttpError(409, 'confirm_mismatch', '确认码和这批提醒对不上（内容改过或时间已变），还没建。请不带 confirmToken 重新调用，拿到新的复述给用户确认')
  }

  const created = []
  for (const p of plan) {
    try {
      const r = await reminderJson(ctx, 'POST', '/reminders', {
        due_at: isoBeijing(p.dueAt),
        title: p.title,
        body: p.body,
        source: 'beer',
      })
      created.push({ ...r, label: p.label })
    } catch (e) {
      const done = created.length
        ? `已经建好的 ${created.length} 封：\n${created.map(r => `· ${formatBeijing(new Date(r.due_at), now)} —— ${r.title}（编号 ${r.id}）`).join('\n')}\n`
        : ''
      const reason = e?.code === 'reminder_unreachable' ? `${REMINDER_DOWN}（检查网络后再试）` : e.message
      throw new HttpError(e?.status ?? 502, e?.code ?? 'reminder_error',
        `${done}从「${p.title}」${formatBeijing(p.dueAt, now)} 这封开始没建成：${reason}。没建成的不会排队补建。`)
    }
  }
  return {
    created: created.map(r => ({ id: r.id, due_at: r.due_at, title: r.title })),
    text: [
      `已建好 ${created.length} 封邮件提醒：`,
      ...created.map(r => `· ${formatBeijing(new Date(r.due_at), now)}${r.label ? ` [${r.label}]` : ''} —— ${r.title}（编号 ${r.id}）`),
    ].join('\n'),
  }
}

/** 查提醒。默认只看待发的；status 为 all 时全部列出。 */
export async function listReminders(ctx, { status = 'pending' } = {}) {
  const now = ctx.now()
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''
  const { reminders } = await reminderJson(ctx, 'GET', '/reminders' + query)
  const scope = status === 'all' ? '' : (STATUS_TEXT[status] ?? status)
  if (!reminders.length) return { reminders: [], text: `没有${scope}的提醒。` }
  return {
    reminders,
    text: [
      `${scope ? scope + '的' : '全部'}提醒共 ${reminders.length} 封（北京时间）：`,
      ...reminders.map(r => {
        const extra = r.status === 'failed' && r.last_error ? `，原因：${r.last_error}` : ''
        return `· ${formatBeijing(new Date(r.due_at), now)} —— ${r.title}（${STATUS_TEXT[r.status] ?? r.status}${extra}，编号 ${r.id}）`
      }),
    ].join('\n'),
  }
}

/** 取消提醒。和建一样两步：先复述，用户确认后带 confirmToken 才取消。 */
export async function cancelReminders(ctx, { ids, confirmToken } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'invalid', 'ids 至少要有一个提醒编号')
  if (ids.length > MAX_BATCH) throw new HttpError(400, 'invalid', `一次最多取消 ${MAX_BATCH} 封`)
  const now = ctx.now()
  const found = []
  for (const id of ids) found.push(await reminderJson(ctx, 'GET', '/reminders/' + encodeURIComponent(String(id))))
  const notPending = found.filter(r => r.status !== 'pending')
  if (notPending.length) {
    throw new HttpError(409, 'not_pending', notPending.map(r => `「${r.title}」${STATUS_TEXT[r.status] ?? r.status}，不能取消`).join('；'))
  }
  const token = fingerprint('cancel', found.map(r => r.id).sort())
  const lines = found.map(r => `· ${formatBeijing(new Date(r.due_at), now)} —— ${r.title}（编号 ${r.id}）`)
  if (!confirmToken) {
    return {
      confirmToken: token,
      text: [`要取消 ${found.length} 封邮件提醒：`, ...lines, '',
        `还没取消。请复述给用户并问「确认取消吗？」；用户确认后，用同样的 ids 和 confirmToken: "${token}" 再调用一次。`].join('\n'),
    }
  }
  if (confirmToken !== token) throw new HttpError(409, 'confirm_mismatch', '确认码和要取消的提醒对不上，还没取消。请不带 confirmToken 重新调用')
  for (const r of found) await reminderJson(ctx, 'DELETE', '/reminders/' + encodeURIComponent(r.id))
  return { text: [`已取消 ${found.length} 封邮件提醒：`, ...lines].join('\n') }
}

// ── AI 工具定义 ─────────────────────────────────────────────────────────

/** 工具里抛的错误统一变成对话 AI 看得懂的中文。 */
function toolError(e) {
  if (e?.code === 'reminder_unreachable') return new Error(`${REMINDER_DOWN}，没有操作成功（不会排队补做）。确认 MacBook 能上网后再试`)
  return new Error(e?.message ?? String(e))
}

function renderText(_args, value) {
  return [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : JSON.stringify(value) }]
}

function present(title) {
  return args => ({ card: 'generic', kind: 'other', title, rawInput: args })
}

async function run(fn) {
  try {
    return await fn()
  } catch (e) {
    throw toolError(e)
  }
}

export function reminderToolDefinitions(ctx) {
  return [
    {
      name: 'beer_reminder_create',
      description: [
        '建一次性的邮件提醒，到点由云端给用户自己的邮箱发邮件（和 MacBook 是否开机、家里是否在线无关）。',
        '用户说「提醒我…」、贴来面试/会议日程要提醒时调用。一份日程里有几件事就放几条。',
        '时间一律按北京时间写成「2026-11-18 14:00」。有具体时刻的事（面试、会议）只给 eventAt，Beer 默认建两封：前一天晚上 21:30、开始前 1 小时；',
        '用户指定了提醒时间（如「提前半小时」「周五下午三点提醒我交稿」）才给 remindAt。',
        '必须分两步：第一次不带 confirmToken，只返回复述文本和确认码，不会建；把复述原样给用户确认，用户说对之后再带 confirmToken 调用才真正建。',
        '不要在用户确认前带 confirmToken。',
      ].join(''),
      parameters: {
        reminders: {
          type: 'array',
          required: true,
          description: '要提醒的事，一件一条。',
          items: {
            type: 'object',
            additionalProperties: false, // 宿主要求嵌套对象明确写出，不写整个工具注册失败
            properties: {
              title: { type: 'string', required: true, description: '邮件标题里的事情，例如「某公司一面（腾讯会议 123-456）」' },
              eventAt: { type: 'string', description: '事情本身的时间（北京时间），例如 2026-11-18 14:00。给了它、没给 remindAt 时按默认建两封' },
              remindAt: { type: 'string', description: '指定发提醒的时间（北京时间），例如 2026-11-18 13:30。给了就只建这一封' },
              details: { type: 'string', description: '邮件正文里的补充：地点、会议号、要带的东西等' },
            },
          },
        },
        confirmToken: { type: 'string', description: '上一次调用返回的确认码。只有用户已经确认了复述内容才带上' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('建邮件提醒'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => createReminders(ctx, args))
      },
    },
    {
      name: 'beer_reminder_list',
      description: '查云端的邮件提醒：默认列出待发的；status 可以是 pending（待发）、sent（已发）、failed（发送失败）、cancelled（已取消）、all（全部）。用户问「我有哪些提醒」或要取消提醒前先查编号时调用。',
      parameters: {
        status: { type: 'string', description: 'pending / sent / failed / cancelled / all，默认 pending' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('查邮件提醒'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => listReminders(ctx, args))
      },
    },
    {
      name: 'beer_reminder_cancel',
      description: '取消还没发的邮件提醒。编号用 beer_reminder_list 查。必须分两步：第一次不带 confirmToken，只返回复述；用户确认后再带 confirmToken 调用才真正取消。',
      parameters: {
        ids: { type: 'array', required: true, items: { type: 'string' }, description: '要取消的提醒编号' },
        confirmToken: { type: 'string', description: '上一次调用返回的确认码。只有用户已经确认了才带上' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('取消邮件提醒'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => cancelReminders(ctx, args))
      },
    },
  ]
}

/**
 * 注册三个提醒工具；defineTool 测试里可以传假的。返回注销函数。
 * 每个工具单独注册：一个定义被宿主拒绝（参数格式不合规会在 defineTool 里抛错），
 * 不连累另外两个，错误打到宿主日志里，不会悄悄一个都没注册。
 */
export async function registerReminderTools(toolsCtx, ctx, defineTool, log = console.error) {
  const define = defineTool ?? (await import('@deepseek-ai/dsh-tools')).defineTool
  const disposers = []
  for (const d of reminderToolDefinitions(ctx)) {
    try {
      disposers.push(toolsCtx.tools.register(define(d)))
    } catch (e) {
      log(`[beer] 注册工具 ${d.name} 失败：${e?.message ?? e}`)
    }
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}
