// 邮件提醒工具（#44）：不经过宿主，直接调 reminders.js 的执行函数；云端提醒服务用 startFake 代替。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createReminders, listReminders, cancelReminders, planReminders, parseBeijing, formatBeijing,
  registerReminderTools, REMINDER_DOWN,
} from '../src/modules/reminders.js'
import { startBeer, startFake, deadUrl } from './helpers/beer.js'

const KEY = 'reminder-key-1'
// 2026-11-16（周一）10:00 北京时间
const NOW = new Date('2026-11-16T02:00:00Z')

/** 假的云端：POST 存进 store，GET / DELETE 按 store 回。 */
async function fakeCloud(t) {
  const store = []
  const cloud = await startFake(t, {
    'POST /reminders': (_req, body) => {
      const r = { id: `r${store.length + 1}`, status: 'pending', ...body, due_at: new Date(body.due_at).toISOString() }
      store.push(r)
      return { status: 201, body: r }
    },
    'GET /reminders': () => ({ reminders: store }),
    'GET /reminders/r1': () => store[0],
    'GET /reminders/r2': () => store[1],
    'DELETE /reminders/r1': () => {
      store[0].status = 'cancelled'
      return store[0]
    },
  })
  return { cloud, store }
}

async function setup(t, { secrets = { 'reminder-api-key': KEY } } = {}) {
  const { cloud, store } = await fakeCloud(t)
  const beer = await startBeer(t, { config: { reminderApiBase: cloud.url }, secrets, now: () => NOW })
  return { ctx: beer.context, cloud, store }
}

const TWO_INTERVIEWS = [
  { title: '某公司一面（腾讯会议 123-456）', eventAt: '2026-11-18 14:00', details: '腾讯会议 123-456' },
  { title: '某公司二面', eventAt: '2026-11-20 10:00' },
]

test('北京时间：解析和显示', () => {
  assert.equal(parseBeijing('2026-11-18 14:00').toISOString(), '2026-11-18T06:00:00.000Z')
  assert.equal(parseBeijing('2026-11-18T00:30').toISOString(), '2026-11-17T16:30:00.000Z')
  assert.equal(parseBeijing('2026-02-30 10:00'), null)
  assert.equal(parseBeijing('明天下午'), null)
  assert.equal(formatBeijing(parseBeijing('2026-11-18 14:00'), NOW), '11 月 18 日（周三）14:00')
  assert.equal(formatBeijing(parseBeijing('2027-01-01 08:00'), NOW), '2027 年 1 月 1 日（周五）08:00')
})

test('只给事情时间：默认两封，前一天 21:30 和提前 1 小时', () => {
  const { plan } = planReminders(TWO_INTERVIEWS, NOW)
  assert.deepEqual(plan.map(p => [formatBeijing(p.dueAt, NOW), p.label, p.title]), [
    ['11 月 17 日（周二）21:30', '前一天晚上', '某公司一面（腾讯会议 123-456）'],
    ['11 月 18 日（周三）13:00', '提前 1 小时', '某公司一面（腾讯会议 123-456）'],
    ['11 月 19 日（周四）21:30', '前一天晚上', '某公司二面'],
    ['11 月 20 日（周五）09:00', '提前 1 小时', '某公司二面'],
  ])
  assert.equal(plan[0].body, '时间：11 月 18 日（周三）14:00\n腾讯会议 123-456')
})

test('已经过了的那封跳过；全过了就报错', () => {
  // 今天 11:30 的会：前一天 21:30 已过，只剩 10:30 那封
  const { plan, skipped } = planReminders([{ title: '周会', eventAt: '2026-11-16 11:30' }], NOW)
  assert.equal(plan.length, 1)
  assert.equal(formatBeijing(plan[0].dueAt, NOW), '11 月 16 日（周一）10:30')
  assert.match(skipped[0], /前一天晚上的提醒.*已经过了/)
  assert.throws(() => planReminders([{ title: '早会', eventAt: '2026-11-16 10:30' }], NOW), /都已经过了/)
})

test('指定了提醒时间就只建那一封', () => {
  const { plan } = planReminders([{ title: '交稿', remindAt: '2026-11-20 15:00' }], NOW)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].label, '')
  assert.equal(plan[0].body, '')
})

test('参数不对给中文错误', () => {
  assert.throws(() => planReminders([], NOW), /至少要有一条/)
  assert.throws(() => planReminders([{ eventAt: '2026-11-18 14:00' }], NOW), /缺标题/)
  assert.throws(() => planReminders([{ title: 'x' }], NOW), /eventAt.*remindAt/)
  assert.throws(() => planReminders([{ title: 'x', eventAt: '周三下午' }], NOW), /写法不对/)
})

test('建：第一次只复述（日期 + 星期 + 时刻）不调云端；带确认码才建', async t => {
  const { ctx, cloud, store } = await setup(t)

  const preview = await createReminders(ctx, { reminders: TWO_INTERVIEWS })
  assert.equal(cloud.requests.length, 0, '复述阶段不能调云端')
  assert.match(preview.text, /要建 4 封邮件提醒/)
  assert.match(preview.text, /11 月 17 日（周二）21:30 \[前一天晚上\] —— 某公司一面（腾讯会议 123-456）（11 月 18 日（周三）14:00）/)
  assert.match(preview.text, /确认吗/)
  assert.ok(preview.confirmToken)

  const done = await createReminders(ctx, { reminders: TWO_INTERVIEWS, confirmToken: preview.confirmToken })
  assert.equal(store.length, 4)
  assert.equal(cloud.requests[0].headers.authorization, `Bearer ${KEY}`)
  assert.equal(cloud.requests[0].body.due_at, '2026-11-17T21:30:00+08:00')
  assert.equal(cloud.requests[0].body.source, 'beer')
  assert.equal(cloud.requests[0].body.to, undefined, '不传收件人')
  assert.match(done.text, /已建好 4 封/)
  assert.equal(done.created.length, 4)
})

test('建：内容改了、确认码对不上就不建', async t => {
  const { ctx, cloud } = await setup(t)
  const preview = await createReminders(ctx, { reminders: TWO_INTERVIEWS })
  const changed = [{ ...TWO_INTERVIEWS[0], eventAt: '2026-11-18 15:00' }, TWO_INTERVIEWS[1]]
  await assert.rejects(createReminders(ctx, { reminders: changed, confirmToken: preview.confirmToken }), /对不上/)
  await assert.rejects(createReminders(ctx, { reminders: TWO_INTERVIEWS, confirmToken: 'made-up' }), /对不上/)
  assert.equal(cloud.requests.length, 0)
})

test('建：连不上云端时明确说没建成，不排队', async t => {
  const beer = await startBeer(t, { config: { reminderApiBase: await deadUrl(t) }, secrets: { 'reminder-api-key': KEY }, now: () => NOW })
  const preview = await createReminders(beer.context, { reminders: TWO_INTERVIEWS })
  await assert.rejects(
    createReminders(beer.context, { reminders: TWO_INTERVIEWS, confirmToken: preview.confirmToken }),
    e => /没建成/.test(e.message) && e.message.includes(REMINDER_DOWN) && /不会排队/.test(e.message),
  )
})

test('建：没存密钥时提示去设置里填', async t => {
  const { ctx } = await setup(t, { secrets: {} })
  const preview = await createReminders(ctx, { reminders: TWO_INTERVIEWS })
  await assert.rejects(createReminders(ctx, { reminders: TWO_INTERVIEWS, confirmToken: preview.confirmToken }), /reminder-api-key/)
})

test('查：列出状态和编号', async t => {
  const { ctx, store } = await setup(t)
  store.push({ id: 'r1', title: '一面', due_at: '2026-11-18T05:00:00.000Z', status: 'pending' })
  store.push({ id: 'r2', title: '交稿', due_at: '2026-11-20T07:00:00.000Z', status: 'failed', last_error: 'E_DELIVERY_FAILED: x' })
  const res = await listReminders(ctx, { status: 'all' })
  assert.match(res.text, /11 月 18 日（周三）13:00 —— 一面（待发，编号 r1）/)
  assert.match(res.text, /发送失败，原因：E_DELIVERY_FAILED/)
})

test('取消：先复述，确认后才删；已发的不能取消', async t => {
  const { ctx, cloud, store } = await setup(t)
  store.push({ id: 'r1', title: '一面', due_at: '2026-11-18T05:00:00.000Z', status: 'pending' })
  store.push({ id: 'r2', title: '交稿', due_at: '2026-11-20T07:00:00.000Z', status: 'sent' })

  const preview = await cancelReminders(ctx, { ids: ['r1'] })
  assert.match(preview.text, /要取消 1 封/)
  assert.ok(!cloud.requests.some(r => r.method === 'DELETE'))
  await cancelReminders(ctx, { ids: ['r1'], confirmToken: preview.confirmToken })
  assert.equal(store[0].status, 'cancelled')

  await assert.rejects(cancelReminders(ctx, { ids: ['r2'] }), /已发，不能取消/)
})

test('注册三个工具；连不上时工具报中文错误', async t => {
  const beer = await startBeer(t, { config: { reminderApiBase: await deadUrl(t) }, secrets: { 'reminder-api-key': KEY }, now: () => NOW })
  const registered = []
  const toolsCtx = { tools: { register: d => (registered.push(d), () => {}) } }
  await registerReminderTools(toolsCtx, beer.context, d => d)
  assert.deepEqual(registered.map(d => d.name), ['beer_reminder_create', 'beer_reminder_list', 'beer_reminder_cancel'])
  const [create, list] = registered
  assert.equal(create.parameters.reminders.type, 'array')
  assert.equal(create.parameters.reminders.items.properties.title.required, true)
  // 宿主的 defineTool 要求嵌套对象明确写 additionalProperties，不写会整个工具注册失败（0.1.18 踩过）
  assert.equal(create.parameters.reminders.items.additionalProperties, false)
  assert.match(create.description, /两步/)
  assert.match(create.description, /21:30/)
  await assert.rejects(list.execute({}), e => e.message.startsWith(REMINDER_DOWN))
})

test('注册：一个工具被宿主拒绝时，另外两个照常注册，并记日志', async t => {
  const beer = await startBeer(t, { config: { reminderApiBase: 'http://x' }, secrets: {} })
  const registered = []
  const logs = []
  const toolsCtx = { tools: { register: d => (registered.push(d.name), () => {}) } }
  const strict = d => {
    if (d.name === 'beer_reminder_create') throw new Error('unsupported JSON schema')
    return d
  }
  await registerReminderTools(toolsCtx, beer.context, strict, line => logs.push(line))
  assert.deepEqual(registered, ['beer_reminder_list', 'beer_reminder_cancel'])
  assert.match(logs[0], /beer_reminder_create.*unsupported/)
})
