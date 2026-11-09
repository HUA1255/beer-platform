// 密钥存在 macOS 钥匙串（服务名默认 beer，账号名见 SECRET_NAMES）。
// 面板的设置弹层可以填写（PUT /api/beer/settings/secrets/:name → set）；终端写法作为备用：
//   security add-generic-password -U -s beer -a home-api-key -T /usr/bin/security -w
// 测试里不碰真钥匙串：给 createBeerHandler 传 { get, set } 即可，
// 或者给 keychainStore 传 securityPath 指向一个假的 security 脚本。
import { execFile, spawn } from 'node:child_process'

/** Beer 用到的密钥（钥匙串账号名）。 */
export const SECRET_NAMES = [
  'home-api-key', // Mac mini 家里服务的访问密钥
  'rin-admin-username', // Rin 博客管理员账号（发布时自动登录换令牌）
  'rin-admin-password', // Rin 博客管理员密码
  'opencode-go-api-key', // opencode go 的 API key（查限额）
]

const NOT_FOUND_EXIT_CODE = 44

/**
 * @param {string} service 钥匙串条目的服务名
 * @param {{ securityPath?: string, timeoutMs?: number }} [options]
 * @returns {{ get(name: string): Promise<string | undefined>, set(name: string, value: string): Promise<void> }}
 */
export function keychainStore(service = 'beer', options = {}) {
  const securityPath = options.securityPath ?? '/usr/bin/security'
  const timeout = options.timeoutMs ?? 10_000
  return {
    get(name) {
      return new Promise((resolve, reject) => {
        execFile(securityPath, ['find-generic-password', '-s', service, '-a', name, '-w'], { timeout }, (err, stdout) => {
          if (!err) return resolve(stdout.replace(/\r?\n$/, ''))
          if (err.code === NOT_FOUND_EXIT_CODE) return resolve(undefined)
          // 不把 stderr 带出去，免得泄露钥匙串内容
          reject(new Error(`读取钥匙串失败（${name}）`))
        })
      })
    },
    // 用 `security -i` 从标准输入送命令，密钥不出现在进程参数里（ps 看不到）。
    // -U 覆盖已有条目；-T /usr/bin/security 和终端写法一致，以后读取不弹授权窗口。
    set(name, value) {
      if (/[\u0000-\u001f\u007f]/.test(service + name + value)) {
        return Promise.reject(new Error(`写入钥匙串失败（${name}）：不能含换行等控制字符`))
      }
      const line = ['add-generic-password', '-U', '-s', quoteArg(service), '-a', quoteArg(name),
        '-T', '/usr/bin/security', '-w', quoteArg(value)].join(' ') + '\n'
      return new Promise((resolve, reject) => {
        const fail = () => reject(new Error(`写入钥匙串失败（${name}）`))
        let child
        try {
          child = spawn(securityPath, ['-i'], { stdio: ['pipe', 'ignore', 'ignore'], timeout })
        } catch {
          return fail()
        }
        child.on('error', fail)
        // 不读 stdout / stderr：出错时里面可能回显命令（含密钥）
        child.on('close', code => (code === 0 ? resolve() : fail()))
        child.stdin.on('error', () => {})
        child.stdin.end(line)
      })
    },
  }
}

/** `security -i` 的参数写法：双引号包起来，里面的 " 和 \ 前加反斜杠；空格、单引号、$、中文原样。 */
export function quoteArg(text) {
  return '"' + String(text).replace(/["\\]/g, '\\$&') + '"'
}
