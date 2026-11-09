// opencode go 套餐限额：顶栏显示 5 小时 / 每周 / 每月三个窗口的已用比例。
//   GET /api/beer/quota → { checkedAt, limits: [{ window, label, percent, state, resetsAt }] }
// 数据用钥匙串里的 opencode-go-api-key 向服务器查询（GET {opencodeGoBase}/zen/go/v1/usage），不做本地估算。
// 接口来自参考插件 emmmdty/opencode-usage 的源码，见 beer/README.md「opencode go 限额接口」。
import { HttpError } from '../http/router.js'

const USAGE_PATH = '/zen/go/v1/usage'
const TIMEOUT_MS = 10_000 // 与参考插件一致

const WINDOWS = [
  { key: 'rolling', window: '5h', label: '5 小时' },
  { key: 'weekly', window: 'week', label: '每周' },
  { key: 'monthly', window: 'month', label: '每月' },
]

export function register(router, ctx) {
  router.get('/quota', async () => {
    let key
    try {
      key = await ctx.secrets.get('opencode-go-api-key')
    } catch {
      throw new HttpError(503, 'quota_keychain_error', '读不出钥匙串里的 opencode go API key（钥匙串可能已锁定）')
    }
    if (!key) throw new HttpError(503, 'quota_no_key', '钥匙串里还没有 opencode go 的 API key（账号名 opencode-go-api-key）')
    const url = ctx.config.opencodeGoBase.replace(/\/+$/, '') + USAGE_PATH
    let res
    try {
      res = await ctx.fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new HttpError(502, 'quota_unreachable', '连不上 opencode go，限额查询失败')
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(502, 'quota_unauthorized', 'opencode go 不认这个 API key，请到钥匙串里更新 opencode-go-api-key')
    }
    if (!res.ok) {
      throw new HttpError(502, 'quota_upstream_error', `opencode go 返回 ${res.status}，限额查询失败`)
    }
    const body = await res.json().catch(() => undefined)
    const limits = WINDOWS.map(w => toLimit(w, body?.usage?.[w.key]))
    if (limits.includes(undefined)) {
      throw new HttpError(502, 'quota_bad_response', 'opencode go 返回的限额格式看不懂（接口可能改了），限额查询失败')
    }
    return { checkedAt: ctx.now().toISOString(), limits }
  })
}

// 状态沿用参考插件的归一：rate-limited（用完，percent=100）→ exhausted；ok / idle 原样；其他 → unknown。
function toLimit(w, raw) {
  if (!raw || typeof raw !== 'object') return undefined
  if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) return undefined
  const state = raw.status === 'rate-limited' ? 'exhausted' : ['ok', 'idle'].includes(raw.status) ? raw.status : 'unknown'
  return {
    window: w.window,
    label: w.label,
    percent: raw.percent,
    state,
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  }
}
