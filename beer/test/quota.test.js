import test from 'node:test'
import assert from 'node:assert/strict'
import { startBeer, startFake, deadUrl } from './helpers/beer.js'

const USAGE_PATH = 'GET /zen/go/v1/usage'

function goUsage(usage) {
  return () => ({ usage })
}

test('限额：用钥匙串里的 API key 向 opencode go 查询，返回 5 小时 / 每周 / 每月三个限额', async t => {
  const go = await startFake(t, {
    [USAGE_PATH]: goUsage({
      rolling: { status: 'ok', percent: 32, resetsAt: '2026-11-06T15:00:00Z' },
      weekly: { status: 'ok', percent: 18, resetsAt: '2026-11-10T00:00:00Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-12-01T00:00:00Z' },
    }),
  })
  const beer = await startBeer(t, {
    config: { opencodeGoBase: go.url },
    secrets: { 'opencode-go-api-key': 'go-key-123' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })

  const res = await beer.api('GET', '/quota')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    checkedAt: '2026-11-06T10:00:00.000Z',
    limits: [
      { window: '5h', label: '5 小时', percent: 32, state: 'ok', resetsAt: '2026-11-06T15:00:00Z' },
      { window: 'week', label: '每周', percent: 18, state: 'ok', resetsAt: '2026-11-10T00:00:00Z' },
      { window: 'month', label: '每月', percent: 100, state: 'exhausted', resetsAt: '2026-12-01T00:00:00Z' },
    ],
  })
  assert.equal(go.requests.length, 1)
  assert.equal(go.requests[0].headers.authorization, 'Bearer go-key-123')
  assert.doesNotMatch(JSON.stringify(res.body), /go-key-123/)
})

test('限额：窗口状态 idle 原样返回，不认识的状态标为 unknown，没给重置时间时为 null', async t => {
  const go = await startFake(t, {
    [USAGE_PATH]: goUsage({
      rolling: { status: 'idle', percent: 0 },
      weekly: { status: 'throttled-new', percent: 40, resetsAt: '2026-11-10T00:00:00Z' },
      monthly: { status: 'ok', percent: 9, resetsAt: '2026-12-01T00:00:00Z' },
    }),
  })
  const beer = await startBeer(t, { config: { opencodeGoBase: go.url }, secrets: { 'opencode-go-api-key': 'k' } })

  const res = await beer.api('GET', '/quota')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.limits.map(l => [l.window, l.state, l.percent, l.resetsAt]), [
    ['5h', 'idle', 0, null],
    ['week', 'unknown', 40, '2026-11-10T00:00:00Z'],
    ['month', 'ok', 9, '2026-12-01T00:00:00Z'],
  ])
})

test('限额：读钥匙串出错时明确报失败', async t => {
  const go = await startFake(t, { [USAGE_PATH]: goUsage({}) })
  const beer = await startBeer(t, {
    config: { opencodeGoBase: go.url },
    secrets: { get: async () => { throw new Error('读取钥匙串失败（opencode-go-api-key）') } },
  })

  const res = await beer.api('GET', '/quota')

  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'quota_keychain_error')
  assert.match(res.body.error.message, /钥匙串/)
  assert.equal(go.requests.length, 0)
})

test('限额：钥匙串里没有 API key 时明确报失败，不向 opencode go 发请求', async t => {
  const go = await startFake(t, { [USAGE_PATH]: goUsage({}) })
  const beer = await startBeer(t, { config: { opencodeGoBase: go.url } })

  const res = await beer.api('GET', '/quota')

  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'quota_no_key')
  assert.match(res.body.error.message, /钥匙串/)
  assert.equal(go.requests.length, 0)
})

test('限额：opencode go 不认这个 API key 时报「key 无效」', async t => {
  const go = await startFake(t, {
    [USAGE_PATH]: () => ({ status: 401, body: { type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } } }),
  })
  const beer = await startBeer(t, { config: { opencodeGoBase: go.url }, secrets: { 'opencode-go-api-key': 'wrong' } })

  const res = await beer.api('GET', '/quota')

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'quota_unauthorized')
  assert.match(res.body.error.message, /API key/)
})

test('限额：连不上 opencode go 时报「查询失败」', async t => {
  const beer = await startBeer(t, { config: { opencodeGoBase: await deadUrl(t) }, secrets: { 'opencode-go-api-key': 'k' } })

  const res = await beer.api('GET', '/quota')

  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'quota_unreachable')
  assert.match(res.body.error.message, /连不上/)
})

test('限额：opencode go 返回错误状态（如 429、500）时报「查询失败」并带上状态码', async t => {
  for (const status of [429, 500]) {
    const go = await startFake(t, { [USAGE_PATH]: () => ({ status, body: { error: 'nope' } }) })
    const beer = await startBeer(t, { config: { opencodeGoBase: go.url }, secrets: { 'opencode-go-api-key': 'k' } })

    const res = await beer.api('GET', '/quota')

    assert.equal(res.status, 502)
    assert.equal(res.body.error.code, 'quota_upstream_error')
    assert.match(res.body.error.message, new RegExp(String(status)))
  }
})

test('限额：opencode go 返回的内容看不懂时报「查询失败」，不显示错的数字', async t => {
  const bodies = [
    { usage: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 'x' } } },
    { something: 'else' },
    'not json',
  ]
  for (const body of bodies) {
    const go = await startFake(t, { [USAGE_PATH]: () => body })
    const beer = await startBeer(t, { config: { opencodeGoBase: go.url }, secrets: { 'opencode-go-api-key': 'k' } })

    const res = await beer.api('GET', '/quota')

    assert.equal(res.status, 502, JSON.stringify(body))
    assert.equal(res.body.error.code, 'quota_bad_response')
  }
})
