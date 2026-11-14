// 提醒服务测试：建、列、取消、到点发、失败重试、重启（新建服务实例）后照常发、晚发注明原定时间。
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, ENV } from './helpers.js'
import { MAX_ATTEMPTS, beijing } from '../src/service.js'

const INTERVIEW = { due_at: '2026-11-18T13:30:00+08:00', title: '某公司一面（14:00，腾讯会议 123-456）', body: '记得提前进会议室', source: 'beer', ref: 'sch-1' }

test('建提醒：带时区的时间存成 UTC，返回北京时间写法', async () => {
  const { api } = setup()
  const res = await api('POST', '/reminders', INTERVIEW)
  assert.equal(res.status, 201)
  assert.equal(res.body.id, 'r1')
  assert.equal(res.body.due_at, '2026-11-18T05:30:00.000Z')
  assert.equal(res.body.due_at_beijing, '2026 年 11 月 18 日（周三）13:30')
  assert.equal(res.body.status, 'pending')
  assert.equal(res.body.source, 'beer')
  assert.equal(res.body.ref, 'sch-1')
})

test('建提醒：没带时区、已经过了、缺标题都拒绝', async () => {
  const { api } = setup({ start: '2026-11-18T06:00:00Z' })
  let res = await api('POST', '/reminders', { ...INTERVIEW, due_at: '2026-11-18T15:00:00' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_due')
  res = await api('POST', '/reminders', INTERVIEW) // 13:30 北京 = 05:30Z，现在 06:00Z
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'due_in_past')
  assert.match(res.body.error.message, /已经过了/)
  res = await api('POST', '/reminders', { due_at: '2026-11-19T10:00:00+08:00', title: '  ' })
  assert.equal(res.status, 400)
  res = await api('POST', '/reminders', '不是 JSON')
  assert.equal(res.status, 400)
})

test('建提醒：请求里带收件人也不理，只发给 MAIL_TO', async () => {
  const { api, service, clock, sent } = setup()
  await api('POST', '/reminders', { ...INTERVIEW, to: 'someone@else.com' })
  clock.set('2026-11-18T05:30:00Z')
  await service.tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, ENV.MAIL_TO)
})

test('没配发信地址时不让建', async () => {
  const { api } = setup({ env: { REMINDER_TOKEN: 'test-token' } })
  const res = await api('POST', '/reminders', INTERVIEW)
  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'mail_not_configured')
  assert.match(res.body.error.message, /没建成/)
})

test('访问密钥不对一律 401', async () => {
  const { api } = setup()
  for (const [method, path] of [['GET', '/health'], ['GET', '/reminders'], ['POST', '/reminders']]) {
    const res = await api(method, path, method === 'POST' ? INTERVIEW : undefined, 'wrong')
    assert.equal(res.status, 401)
  }
  assert.equal((await api('GET', '/health')).status, 200)
})

test('列出：按到点时间排序，可以按状态和 ref 筛', async () => {
  const { api } = setup()
  await api('POST', '/reminders', { ...INTERVIEW, due_at: '2026-11-20T09:00:00+08:00', ref: 'sch-2', title: '二面' })
  await api('POST', '/reminders', INTERVIEW)
  await api('DELETE', '/reminders/r1')
  let res = await api('GET', '/reminders')
  assert.deepEqual(res.body.reminders.map(r => r.id), ['r2', 'r1'])
  res = await api('GET', '/reminders?status=pending')
  assert.deepEqual(res.body.reminders.map(r => r.id), ['r2'])
  res = await api('GET', '/reminders?ref=sch-2')
  assert.deepEqual(res.body.reminders.map(r => r.title), ['二面'])
  res = await api('GET', '/reminders?status=oops')
  assert.equal(res.status, 400)
})

test('到点发：没到不发，到了发一封，再触发不重复发', async () => {
  const { api, service, clock, sent } = setup()
  await api('POST', '/reminders', INTERVIEW)
  clock.set('2026-11-18T05:29:00Z')
  await service.tick()
  assert.equal(sent.length, 0)
  clock.advance(1)
  await service.tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].subject, '提醒：某公司一面（14:00，腾讯会议 123-456）')
  assert.equal(sent[0].from.email, ENV.MAIL_FROM)
  assert.match(sent[0].text, /腾讯会议 123-456/)
  assert.match(sent[0].text, /记得提前进会议室/)
  assert.doesNotMatch(sent[0].text, /原定/)
  clock.advance(1)
  await service.tick()
  assert.equal(sent.length, 1)
  const res = await api('GET', '/reminders/r1')
  assert.equal(res.body.status, 'sent')
  assert.equal(res.body.sent_at, '2026-11-18T05:30:00.000Z')
})

test('两次触发重叠时只发一封', async () => {
  const { api, service, clock, sent, restart } = setup()
  await api('POST', '/reminders', INTERVIEW)
  clock.set('2026-11-18T05:30:00Z')
  await Promise.all([service.tick(), restart().tick()])
  assert.equal(sent.length, 1)
})

test('取消：待发的变成已取消且到点不发；已发的不能取消；不存在的 404', async () => {
  const { api, service, clock, sent } = setup()
  await api('POST', '/reminders', INTERVIEW)
  await api('POST', '/reminders', { ...INTERVIEW, due_at: '2026-11-18T13:00:00+08:00' })
  let res = await api('DELETE', '/reminders/r1')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'cancelled')
  assert.equal((await api('DELETE', '/reminders/r1')).status, 200, '重复取消照样成功')
  clock.set('2026-11-18T06:00:00Z')
  await service.tick()
  assert.equal(sent.length, 1, '只发了没取消的 r2')
  res = await api('DELETE', '/reminders/r2')
  assert.equal(res.status, 409)
  assert.match(res.body.error.message, /已经发出去了/)
  assert.equal((await api('DELETE', '/reminders/nope')).status, 404)
})

test('发信失败按 1、2、4、8、16 分钟重试，成功后记为已发', async () => {
  const { api, service, clock, sent } = setup({ failTimes: 2 })
  await api('POST', '/reminders', INTERVIEW)
  clock.set('2026-11-18T05:30:00Z')
  await service.tick() // 第 1 次失败，1 分钟后再试
  let r = (await api('GET', '/reminders/r1')).body
  assert.equal(r.status, 'pending')
  assert.equal(r.attempts, 1)
  assert.match(r.last_error, /E_DELIVERY_FAILED/)
  clock.advance(1)
  await service.tick() // 第 2 次失败，2 分钟后再试
  clock.advance(1)
  await service.tick() // 还没到 2 分钟，不试
  assert.equal((await api('GET', '/reminders/r1')).body.attempts, 2)
  clock.advance(1)
  await service.tick() // 成功
  r = (await api('GET', '/reminders/r1')).body
  assert.equal(r.status, 'sent')
  assert.equal(r.attempts, 3)
  assert.equal(r.last_error, null)
  assert.equal(sent.length, 1)
})

test(`连续失败 ${MAX_ATTEMPTS} 次记为失败，不再试`, async () => {
  const { api, service, clock } = setup({ failTimes: 100 })
  await api('POST', '/reminders', INTERVIEW)
  clock.set('2026-11-18T05:30:00Z')
  for (let i = 0; i < 40; i++) {
    await service.tick()
    clock.advance(1)
  }
  const r = (await api('GET', '/reminders/r1')).body
  assert.equal(r.status, 'failed')
  assert.equal(r.attempts, MAX_ATTEMPTS)
  const res = await api('DELETE', '/reminders/r1')
  assert.equal(res.status, 409)
  assert.match(res.body.error.message, /发送失败/)
})

test('重启后（新的服务实例）待发的提醒还在，到点照常发；晚发超过 5 分钟注明原定时间', async () => {
  const { api, clock, sent, restart } = setup()
  await api('POST', '/reminders', INTERVIEW)
  clock.set('2026-11-18T07:45:00Z') // 晚了 2 小时 15 分钟
  await restart().tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /原定 2026 年 11 月 18 日（周三）13:30，晚发了 2 小时 15 分钟/)
})

test('北京时间写法跨日正确', () => {
  assert.equal(beijing(new Date('2026-11-17T16:30:00Z')), '2026 年 11 月 18 日（周三）00:30')
  assert.equal(beijing(new Date('2026-12-31T23:59:00Z')), '2027 年 1 月 1 日（周五）07:59')
})
