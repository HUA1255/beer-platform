// Beer 服务端：与宿主无关的 Node handler 工厂。宿主在 index.js 的 apply() 里接线，
// 测试里直接用 http.createServer(createBeerHandler(...)) 起真服务。
import { createRouter } from './http/router.js'
import { createStateStore } from './state.js'
import { Config } from './config.js'
import { modules } from './modules/index.js'

export const API_PREFIX = '/api/beer'

/**
 * 一个请求之外也要用的业务上下文（AI 工具直接调模块函数时用）。
 * @param {object} deps
 * @param {object} deps.config   插件配置项（Schemastery 解析后的值），root 为业务数据目录
 * @param {{ get(name: string): Promise<string | undefined> }} deps.secrets  钥匙串
 * @param {() => Date} [deps.now]
 * @param {typeof fetch} [deps.fetch]  调用外部 HTTP（家里 API、opencode go、Rin）用
 */
export function createBeerContext(deps) {
  const config = Config(deps?.config ?? {}) // 补默认值，不合法时直接抛错
  if (!deps.secrets) throw new Error('Beer 缺少钥匙串（secrets）')
  return {
    config,
    secrets: deps.secrets,
    now: deps.now ?? (() => new Date()),
    fetch: deps.fetch ?? globalThis.fetch,
    state: createStateStore(config.root),
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.context]  已经建好的业务上下文（和工具共用一份）
 * @param {object} [deps.config]   没有 context 时按它建
 * @param {{ get(name: string): Promise<string | undefined> }} [deps.secrets]
 * @param {() => Date} [deps.now]
 * @param {typeof fetch} [deps.fetch]
 */
export function createBeerHandler(deps) {
  const context = deps.context ?? createBeerContext(deps)
  const router = createRouter(API_PREFIX)
  for (const register of modules) register(router, context)
  return router.handle
}
