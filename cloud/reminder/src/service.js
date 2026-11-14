// 提醒服务的业务逻辑：HTTP 接口和每分钟的到点检查。不直接依赖 Workers 运行时，
// 测试里用 node:sqlite 包一层假的 D1、用假的发信函数就能跑（见 test/helpers.js）。
//
//   POST   /reminders        建一条提醒 { due_at, title, body?, source?, ref? } → 201 提醒
//   GET    /reminders        列出提醒 ?status=pending|sent|failed|cancelled&ref=…&limit=…
//   GET    /reminders/{id}   查一条
//   DELETE /reminders/{id}   取消还没发的 → 200 提醒（状态 cancelled）；已发 / 已失败 409
//   GET    /health           { ok: true }
//
// 所有接口都要带 Authorization: Bearer <REMINDER_TOKEN>。收件人固定是 MAIL_TO，接口不收收件人字段。
// 错误统一 { error: { code, message } }，message 是中文，Beer 直接转给用户看。

export const MAX_ATTEMPTS = 6
/** 第 n 次失败后隔多久再试（分钟）：1、2、4、8、16。第 6 次还失败就记为 failed。 */
export const RETRY_MINUTES = [1, 2, 4, 8, 16]
/** 认领一条提醒后，这段时间内别的触发不会再碰它（发信最慢也就十几秒）。 */
const CLAIM_MINUTES = 5
/** 晚发超过这么久，邮件里注明原定时间。 */
const LATE_NOTE_MINUTES = 5
/** 到点时间可以比现在早这么久（AI 算时间、网络慢都会有几十秒误差）；再早就拒绝。 */
const PAST_GRACE_MINUTES = 2
const BATCH = 20
const TITLE_MAX = 200
const BODY_MAX = 5000
const SHORT_MAX = 200
const STATUSES = ['pending', 'sent', 'failed', 'cancelled']

/**
 * @param {object} deps
 * @param {D1Database} deps.db
 * @param {{ send(msg: object): Promise<{ messageId: string }> }} deps.email  send_email 绑定
 * @param {{ REMINDER_TOKEN?: string, MAIL_FROM?: string, MAIL_TO?: string }} deps.env
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.newId]
 * @param {(line: string) => void} [deps.log]
 */
export function createService({ db, email, env, now = () => new Date(), newId = () => crypto.randomUUID(), log = console.log }) {
  async function fetch(request) {
    try {
      if (!env.REMINDER_TOKEN) throw new ApiError(503, 'not_configured', '提醒服务还没设访问密钥（REMINDER_TOKEN）')
      if (!(await sameSecret(request.headers.get('authorization') ?? '', `Bearer ${env.REMINDER_TOKEN}`))) {
        throw new ApiError(401, 'unauthorized', '访问密钥不对')
      }
      const url = new URL(request.url)
      const parts = url.pathname.split('/').filter(Boolean)
      const method = request.method

      if (parts.length === 1 && parts[0] === 'health' && method === 'GET') return json({ ok: true })
      if (parts[0] !== 'reminders' || parts.length > 2) throw new ApiError(404, 'not_found', '没有这个接口')

      if (parts.length === 1) {
        if (method === 'POST') return json(await create(await readJson(request)), 201)
        if (method === 'GET') return json({ reminders: await list(url.searchParams) })
      } else {
        const id = decodeURIComponent(parts[1])
        if (method === 'GET') return json(view(await mustGet(id)))
        if (method === 'DELETE') return json(await cancel(id))
      }
      throw new ApiError(405, 'method_not_allowed', '不支持这个请求方法')
    } catch (e) {
      if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status)
      log(JSON.stringify({ error: String(e?.stack ?? e) }))
      return json({ error: { code: 'internal', message: '提醒服务内部出错' } }, 500)
    }
  }

  async function create(body) {
    if (!env.MAIL_FROM || !env.MAIL_TO) {
      // 没配好发信就不让建，免得建了发不出去
      throw new ApiError(503, 'mail_not_configured', '提醒服务还没配好发信地址（MAIL_FROM / MAIL_TO），提醒没建成')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid', '请求体要是 JSON 对象')
    const due = parseDue(body.due_at)
    const current = now()
    if (due.getTime() < current.getTime() - PAST_GRACE_MINUTES * 60e3) {
      throw new ApiError(400, 'due_in_past', `到点时间 ${beijing(due)} 已经过了，提醒没建成`)
    }
    const title = text(body.title, 'title', TITLE_MAX, true)
    const reminder = {
      id: newId(),
      due_at: due.toISOString(),
      title,
      body: text(body.body, 'body', BODY_MAX),
      source: text(body.source, 'source', SHORT_MAX),
      ref: text(body.ref, 'ref', SHORT_MAX),
      status: 'pending',
      attempts: 0,
      next_try_at: due.toISOString(),
      last_error: null,
      sent_at: null,
      created_at: current.toISOString(),
      updated_at: current.toISOString(),
    }
    await db.prepare(
      `INSERT INTO reminders (id, due_at, title, body, source, ref, status, attempts, next_try_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).bind(reminder.id, reminder.due_at, reminder.title, reminder.body, reminder.source, reminder.ref,
      reminder.next_try_at, reminder.created_at, reminder.updated_at).run()
    return view(reminder)
  }

  async function list(params) {
    const where = []
    const args = []
    const status = params.get('status')
    if (status) {
      if (!STATUSES.includes(status)) throw new ApiError(400, 'invalid', `status 只能是 ${STATUSES.join(' / ')}`)
      where.push('status = ?')
      args.push(status)
    }
    const ref = params.get('ref')
    if (ref) {
      where.push('ref = ?')
      args.push(ref)
    }
    const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '100', 10) || 100, 1), 500)
    const sql = `SELECT * FROM reminders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY due_at ASC LIMIT ${limit}`
    const { results } = await db.prepare(sql).bind(...args).all()
    return results.map(view)
  }

  async function mustGet(id) {
    const row = await db.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first()
    if (!row) throw new ApiError(404, 'not_found', '没有这条提醒')
    return row
  }

  async function cancel(id) {
    const at = now().toISOString()
    const { meta } = await db.prepare(
      `UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`,
    ).bind(at, id).run()
    const row = await mustGet(id)
    if (meta.changes === 0 && row.status !== 'cancelled') {
      const what = row.status === 'sent' ? '已经发出去了' : '已经发送失败'
      throw new ApiError(409, 'not_pending', `这条提醒${what}，不能取消`)
    }
    return view(row)
  }

  /** 每分钟一次：把到点的提醒发出去。发信失败按 RETRY_MINUTES 重试。 */
  async function tick() {
    const current = now()
    const at = current.toISOString()
    const { results } = await db.prepare(
      `SELECT * FROM reminders WHERE status = 'pending' AND next_try_at <= ? ORDER BY due_at ASC LIMIT ${BATCH}`,
    ).bind(at).all()
    const outcome = { sent: 0, retry: 0, failed: 0 }
    for (const row of results) {
      // 认领：只有把 next_try_at 推后成功的那一次触发才去发，防止两次触发重叠时重复发
      const claimUntil = new Date(current.getTime() + CLAIM_MINUTES * 60e3).toISOString()
      const claim = await db.prepare(
        `UPDATE reminders SET next_try_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND next_try_at = ?`,
      ).bind(claimUntil, at, row.id, row.next_try_at).run()
      if (claim.meta.changes !== 1) continue

      try {
        await email.send(message(row, current))
        await db.prepare(
          `UPDATE reminders SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        ).bind(at, at, row.id).run()
        outcome.sent++
      } catch (e) {
        const attempts = row.attempts + 1
        const error = describeSendError(e)
        if (attempts >= MAX_ATTEMPTS) {
          await db.prepare(
            `UPDATE reminders SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
          ).bind(attempts, error, at, row.id).run()
          outcome.failed++
        } else {
          const next = new Date(current.getTime() + RETRY_MINUTES[attempts - 1] * 60e3).toISOString()
          await db.prepare(
            `UPDATE reminders SET attempts = ?, last_error = ?, next_try_at = ?, updated_at = ? WHERE id = ?`,
          ).bind(attempts, error, next, at, row.id).run()
          outcome.retry++
        }
        log(JSON.stringify({ id: row.id, attempts, error }))
      }
    }
    if (results.length) log(JSON.stringify({ tick: at, ...outcome }))
    return outcome
  }

  function message(row, current) {
    const due = new Date(row.due_at)
    const lateMinutes = Math.floor((current.getTime() - due.getTime()) / 60e3)
    const lines = [row.title, '', `提醒时间：${beijing(due)}`]
    if (lateMinutes >= LATE_NOTE_MINUTES) {
      lines.push(`（原定 ${beijing(due)}，晚发了 ${formatMinutes(lateMinutes)}）`)
    }
    if (row.body) lines.push('', row.body)
    lines.push('', '—— Beer 提醒')
    return {
      to: env.MAIL_TO,
      from: { email: env.MAIL_FROM, name: 'Beer 提醒' },
      subject: `提醒：${row.title}`,
      text: lines.join('\n'),
    }
  }

  return { fetch, tick, create, list, cancel }
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 接口返回给调用方的形状：和表的列一致，next_try_at 只在待发时有意义。 */
export function view(row) {
  return {
    id: row.id,
    due_at: row.due_at,
    due_at_beijing: beijing(new Date(row.due_at)),
    title: row.title,
    body: row.body,
    source: row.source,
    ref: row.ref,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error ?? null,
    sent_at: row.sent_at ?? null,
    created_at: row.created_at,
  }
}

/** 到点时间必须带时区（Z 或 +08:00），不认没时区的写法，免得按 UTC 理解成晚 8 小时。 */
function parseDue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ApiError(400, 'invalid_due', 'due_at 要写成带时区的时间，例如 2026-11-18T13:30:00+08:00')
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'invalid_due', `due_at 不是有效时间：${value}`)
  return date
}

function text(value, field, max, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, 'invalid', `${field} 必填`)
    return ''
  }
  if (typeof value !== 'string') throw new ApiError(400, 'invalid', `${field} 要是文字`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new ApiError(400, 'invalid', `${field} 不能为空`)
  if (trimmed.length > max) throw new ApiError(400, 'invalid', `${field} 太长（最多 ${max} 字）`)
  return trimmed
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    throw new ApiError(400, 'invalid', '请求体不是合法的 JSON')
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** 比较密钥时不因长度或前缀提前返回（先各自做哈希再逐字节比）。 */
async function sameSecret(a, b) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))))
  const x = new Uint8Array(ha)
  const y = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

function describeSendError(e) {
  const code = e?.code ? `${e.code}: ` : ''
  return (code + String(e?.message ?? e)).slice(0, 500)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 北京时间：2026 年 11 月 18 日（周三）13:30。北京不用夏令时，直接加 8 小时。 */
export function beijing(date) {
  const d = new Date(date.getTime() + 8 * 3600e3)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日（${WEEKDAYS[d.getUTCDay()]}）${hh}:${mm}`
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}
