// 宿主接线：apply() 在 /api/beer 前缀上挂一个路由，并先过宿主的连接鉴权。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../src/index.js'
import { listen, call, makeTempDir } from './helpers/beer.js'

async function applyWithFakeHost(t, { requestRejection } = {}) {
  const routes = []
  const disposers = []
  const injected = []
  const ctx = {
    effect: fn => { disposers.push(fn()) },
    inject: (deps, callback) => { injected.push({ deps, callback }) },
    webServer: { register: route => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    connection: requestRejection === null ? undefined : { requestRejection: requestRejection ?? (() => undefined) },
  }
  const root = await makeTempDir(t, 'beer-host-')
  plugin.apply(ctx, plugin.Config({ root }))
  assert.equal(routes.length, 1)
  const route = routes[0]
  const server = await listen(t, (req, res) => route.handler(req, res))
  return { route, server, disposers, routes, injected }
}

test('插件声明：名字、必需服务、Schemastery 配置', () => {
  assert.equal(plugin.name, 'beer')
  assert.deepEqual(plugin.inject, ['webServer', 'connection'])
  assert.equal(typeof plugin.Config, 'function')
  assert.throws(() => plugin.Config({}), '缺少 root 时配置不合法')
})

test('宿主接线：/api/beer 前缀一条路由接住全部接口', async t => {
  const { route, server } = await applyWithFakeHost(t)

  assert.deepEqual({ kind: route.kind, path: route.path }, { kind: 'prefix', path: '/api/beer' })
  const res = await call(server.url, 'GET', '/api/beer/vault')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'unset' })
})

test('宿主接线：连接鉴权不通过时一律拒绝（401 / 403），不进业务接口', async t => {
  for (const [rejection, expected] of [[401, 401], [403, 403]]) {
    const { server } = await applyWithFakeHost(t, { requestRejection: () => rejection })
    const res = await call(server.url, 'PUT', '/api/beer/vault', { path: '/' })
    assert.equal(res.status, expected)
  }
  const { server } = await applyWithFakeHost(t, { requestRejection: null })
  assert.equal((await call(server.url, 'GET', '/api/beer/vault')).status, 403, '没有连接服务时拒绝')
})

test('宿主接线：卸载时注销路由', async t => {
  const { disposers, routes } = await applyWithFakeHost(t)
  for (const dispose of disposers) dispose?.()
  assert.equal(routes.length, 0)
})

test('宿主接线：用 ctx.inject 把 AI 工具登记到可选的 tools 服务', async t => {
  const { injected } = await applyWithFakeHost(t)

  // 素材导入（#12）、转录三件套（#22）、邮件提醒三件套（#44）、日程五件套（#53）各一次，
  // 都是可选的 tools 服务。
  assert.deepEqual(injected.map(item => item.deps), [['tools'], ['tools'], ['tools'], ['tools']])
  assert.ok(injected.every(item => typeof item.callback === 'function'))
})

test('未知接口返回 404 JSON', async t => {
  const { server } = await applyWithFakeHost(t)
  const res = await call(server.url, 'GET', '/api/beer/nope')
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'not_found')
})

test('宿主接线：按方法调用宿主的 requestRejection（宿主实现里用到 this，拆下来单独调用会抛错）', async t => {
  // 仿真实宿主（dsh-client-connection）：requestRejection 读 this 上的准入状态。
  class FakeConnection {
    constructor() { this.admission = { admit: () => undefined } }
    requestRejection(req) { return this.admission.admit(req) }
  }
  const routes = []
  const ctx = {
    effect: fn => { fn() },
    inject: () => {},
    webServer: { register: route => { routes.push(route); return () => {} } },
    connection: new FakeConnection(),
  }
  plugin.apply(ctx, plugin.Config({ root: await makeTempDir(t, 'beer-host-') }))
  const server = await listen(t, (req, res) => routes[0].handler(req, res))

  const res = await call(server.url, 'GET', '/api/beer/vault')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'unset' })
})
