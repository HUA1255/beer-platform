// 设置弹层：查看当前配置项和钥匙串里各密钥是否已存，填写密钥。
//   GET /api/beer/settings → { config: {...}, secrets: { [name]: 'present' | 'missing' | 'error' } }
//   PUT /api/beer/settings/secrets/:name { value } → { name, status: 'present' }
// 只报状态，永远不返回密钥本身。配置项（服务地址等）在宿主 profile 的 cordis.patch.yml 里，这里只读。
// 其他模块每次请求都现读钥匙串，保存后立即生效；只有 Rin 令牌缓存在内存里，改账号密码时清掉。
import { HttpError } from '../http/router.js'
import { PUBLIC_CONFIG_KEYS } from '../config.js'
import { SECRET_NAMES } from '../secrets.js'
import { RIN_SECRET_NAMES, forgetRinSession } from './publish.js'

export function register(router, ctx) {
  router.get('/settings', async () => {
    const config = {}
    for (const key of PUBLIC_CONFIG_KEYS) config[key] = ctx.config[key]
    const secrets = {}
    await Promise.all(SECRET_NAMES.map(async name => {
      try {
        secrets[name] = (await ctx.secrets.get(name)) ? 'present' : 'missing'
      } catch {
        secrets[name] = 'error'
      }
    }))
    return { config, secrets: Object.fromEntries(SECRET_NAMES.map(n => [n, secrets[n]])) }
  })

  router.put('/settings/secrets/:name', async req => {
    const name = req.params.name
    if (!SECRET_NAMES.includes(name)) throw new HttpError(404, 'secret_unknown', `没有这个密钥：${name}`)
    const body = (await req.json()) ?? {}
    const value = validSecret(body.value)
    try {
      if (typeof ctx.secrets.set !== 'function') throw new Error('不支持写入')
      await ctx.secrets.set(name, value)
    } catch {
      // 不带原始错误信息，免得泄露内容
      throw new HttpError(500, 'keychain_write_failed', `写入钥匙串失败（${name}），请稍后重试，或用终端命令写入`)
    }
    if (RIN_SECRET_NAMES.includes(name)) forgetRinSession(ctx)
    return { name, status: 'present' }
  })
}

/** 密钥值：必须是字符串，去掉首尾空白后不能为空，不能含换行等控制字符。存去掉首尾空白后的值。 */
function validSecret(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'secret_invalid', '密钥要填一段文字')
  const trimmed = value.trim()
  if (!trimmed) throw new HttpError(400, 'secret_invalid', '密钥不能为空')
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new HttpError(400, 'secret_invalid', '密钥不能含换行、制表符等控制字符')
  return trimmed
}
