// 测试骨架自检：假外部服务和「连不上」地址能按后续工单的用法工作。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startFake, deadUrl, startBeer } from './helpers/beer.js'

test('假外部服务：按路由回应并记下收到的请求；配置可指向它', async t => {
  const home = await startFake(t, {
    'GET /health': () => ({ ok: true }),
    'POST /uploads': (_req, body) => ({ status: 201, body: { id: 'r1', echo: body } }),
  })
  const beer = await startBeer(t, { config: { homeApiBase: home.url } })

  assert.deepEqual(await (await fetch(home.url + '/health')).json(), { ok: true })
  const created = await fetch(home.url + '/uploads', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { authorization: 'Bearer k' } })
  assert.equal(created.status, 201)
  assert.equal((await fetch(home.url + '/missing')).status, 404)
  assert.deepEqual(home.requests.map(r => `${r.method} ${r.path}`), ['GET /health', 'POST /uploads', 'GET /missing'])
  assert.equal(home.requests[1].headers.authorization, 'Bearer k')
  assert.deepEqual(home.requests[1].body, { a: 1 })
  assert.equal((await beer.api('GET', '/settings')).body.config.homeApiBase, home.url)
})

test('连不上的地址：请求直接失败', async t => {
  const url = await deadUrl(t)
  await assert.rejects(fetch(url + '/health'))
})
