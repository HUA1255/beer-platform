// 日程邮件提醒同步（#56）：建 / 改 / 删日程时同步云端提醒。
// 不经过宿主，直接调 schedule-tools.js 的执行函数；云端提醒服务用 startFake 代替。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createScheduleItems,
  updateScheduleItem,
  deleteScheduleItem,
} from '../src/modules/schedule-tools.js'
import { startBeer, startFake, deadUrl } from './helpers/beer.js'

const SCHEDULE = '日程.md'
const KEY = 'reminder-key-1'
// 2026-11-12（周四）10:00，本机时区（Asia/Shanghai）；11-18 周三。
const NOW = () => new Date('2026-11-12T10:00:00')

const lines = (...rows) => rows.join('\n') + '\n'

function line(over = {}) {
  const item = {
    box: '[ ]', time: '', title: '某件事', tags: [], beer: '', tasks: '',
    ...over,
  }
  return `- ${item.box} ${item.time ? item.time + ' ' : ''}${item.title}`
    + (item.tags.length ? ' ' + item.tags.map(tag => '#' + tag).join(' ') : '')
    + (item.beer ? ` %%beer ${item.beer}%%` : '')
    + (item.tasks ? ' ' + item.tasks : '')
}

/** 假的云端提醒服务：POST 存进 store，GET 列出，DELETE 的路由由各测试自己补。 */
async function fakeCloud(t, routes = () => ({})) {
  const store = []
  let nextId = 1
  const cloud = await startFake(t, {
    'POST /reminders': (_req, body) => {
      const r = { id: `r${nextId++}`, status: 'pending', ...body, due_at: new Date(body.due_at).toISOString() }
      store.push(r)
      return { status: 201, body: r }
    },
    'GET /reminders': () => ({ reminders: store }),
    ...routes(store),
  })
  return { cloud, store }
}

async function setup(t, { vault = {}, now = NOW, routes } = {}) {
  const { cloud, store } = await fakeCloud(t, routes)
  const beer = await startBeer(t, {
    vault,
    config: { reminderApiBase: cloud.url },
    secrets: { 'reminder-api-key': KEY },
    now,
  })
  return { beer, cloud, store }
}

const INTERVIEW = {
  title: '某公司终面',
  due: '2026-11-18',
  time: '14:00',
  endTime: '15:00',
  tags: ['面试'],
  source: '对话',
}

test('建日程：有时刻的事项默认建两封提醒，编号写回 %%beer%% 并带 ref', async t => {
  const { beer, cloud, store } = await setup(t)

  const preview = await createScheduleItems(beer.context, { items: [INTERVIEW] })
  assert.equal(cloud.requests.length, 0, '复述阶段不能调云端')
  assert.match(preview.text, /邮件提醒/)
  assert.match(preview.text, /前一天 21:30/)

  const done = await createScheduleItems(beer.context, {
    items: [INTERVIEW], confirmToken: preview.confirmToken,
  })
  assert.equal(done.reminderError, null)
  assert.equal(store.length, 2)
  assert.deepEqual(cloud.requests.map(r => [r.method, r.body.due_at, r.body.ref, r.body.source]), [
    ['POST', '2026-11-17T21:30:00+08:00', done.created[0].id, 'beer'],
    ['POST', '2026-11-18T13:00:00+08:00', done.created[0].id, 'beer'],
  ])

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, new RegExp(
    `^- \\[ \\] 14:00–15:00 某公司终面 #面试 %%beer id=${done.created[0].id} src=对话 remind=default reminder=r1,r2%% 📅 2026-11-18$`, 'm',
  ))
})

test('提醒正文带地点：会议号 / 地址不能只留在日程注释里', async t => {
  const { beer, store } = await setup(t)
  const item = { ...INTERVIEW, endTime: '15:00', location: '腾讯会议 888-111-222' }
  const preview = await createScheduleItems(beer.context, { items: [item] })
  const done = await createScheduleItems(beer.context, { items: [item], confirmToken: preview.confirmToken })
  assert.equal(done.reminderError, null)
  assert.equal(store.length, 2)
  for (const r of store) {
    assert.equal(r.body, '时间：2026 年 11 月 18 日（周三）14:00–15:00\n地点：腾讯会议 888-111-222')
  }

  // 改时间重建的提醒同样带地点（地点来自文件里的 loc=）。
  const changes = { time: '10:00', endTime: '11:00' }
  const id = done.created[0].id
  const p2 = await updateScheduleItem(beer.context, { id, changes })
  await updateScheduleItem(beer.context, { id, changes, confirmToken: p2.confirmToken })
  const rebuilt = store.slice(2)
  assert.equal(rebuilt.length, 2)
  for (const r of rebuilt) assert.match(r.body, /\n地点：腾讯会议 888-111-222$/)

  // 只改地点：提醒也重建，正文换成新地点。
  const loc = { location: '腾讯会议 999-000-111' }
  const p3 = await updateScheduleItem(beer.context, { id, changes: loc })
  await updateScheduleItem(beer.context, { id, changes: loc, confirmToken: p3.confirmToken })
  const relocated = store.slice(4)
  assert.equal(relocated.length, 2)
  for (const r of relocated) assert.match(r.body, /\n地点：腾讯会议 999-000-111$/)
})

test('提醒偏好：提前 30 分钟只建一封，off 不建；编号照样写回', async t => {
  const { beer, store } = await setup(t)
  const items = [
    { title: '默认提醒', due: '2026-11-18', time: '14:00' },
    { title: '提前提醒', due: '2026-11-18', time: '14:00', remind: '30m' },
    { title: '不提醒', due: '2026-11-18', time: '14:00', remind: 'off' },
  ]

  const preview = await createScheduleItems(beer.context, { items })
  assert.match(preview.text, /提前 30 分钟/)
  assert.match(preview.text, /不提醒/)
  const done = await createScheduleItems(beer.context, { items, confirmToken: preview.confirmToken })
  assert.equal(done.reminderError, null)

  assert.equal(store.length, 3, '默认两封 + 提前 30 分钟一封 + off 零封')
  assert.equal(store[2].due_at, '2026-11-18T05:30:00.000Z', '提前 30 分钟：13:30 +08:00')

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /默认提醒 %%beer id=[0-9a-f]{10} src=对话 remind=default reminder=r1,r2%% 📅 2026-11-18/)
  assert.match(content, /提前提醒 %%beer id=[0-9a-f]{10} src=对话 remind=30m reminder=r3%% 📅 2026-11-18/)
  assert.match(content, /不提醒 %%beer id=[0-9a-f]{10} src=对话 remind=off%% 📅 2026-11-18/)
  assert.doesNotMatch(content, /不提醒[^\n]*reminder=/)
})

test('改时间：先删旧提醒再建新提醒，编号更新（云端没有修改接口）', async t => {
  const original = lines(
    line({
      time: '14:00–15:00', title: '某公司一面', tags: ['面试'],
      beer: 'id=a1 src=对话 remind=default reminder=old1,old2',
      tasks: '📅 2026-11-18',
    }),
  )
  const { beer, cloud, store } = await setup(t, {
    vault: { [SCHEDULE]: original },
    routes: () => ({
      'DELETE /reminders/old1': () => ({ id: 'old1', status: 'cancelled' }),
      'DELETE /reminders/old2': () => ({ id: 'old2', status: 'cancelled' }),
    }),
  })

  const changes = { time: '10:00', endTime: '11:00' }
  const preview = await updateScheduleItem(beer.context, { id: 'a1', changes })
  assert.equal(cloud.requests.length, 0, '复述阶段不能调云端')

  const done = await updateScheduleItem(beer.context, {
    id: 'a1', changes, confirmToken: preview.confirmToken,
  })
  assert.equal(done.reminderError, null)
  assert.deepEqual(cloud.requests.map(r => r.method), ['DELETE', 'DELETE', 'POST', 'POST'])
  assert.deepEqual(cloud.requests.filter(r => r.method === 'DELETE').map(r => r.path), [
    '/reminders/old1', '/reminders/old2',
  ])
  assert.deepEqual(store.map(r => r.due_at), [
    '2026-11-17T13:30:00.000Z', '2026-11-18T01:00:00.000Z',
  ], '新时间 10:00：前一天 21:30、当天 09:00（+08:00）')

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.equal(content, lines(
    line({
      time: '10:00–11:00', title: '某公司一面', tags: ['面试'],
      beer: 'id=a1 src=对话 remind=default reminder=r1,r2',
      tasks: '📅 2026-11-18',
    }),
  ))
})

test('删日程：日程先删，云端提醒随后取消；已发 / 已失败（409）不挡删除', async t => {
  const original = lines(
    line({
      time: '14:00–15:00', title: '某公司一面', tags: ['面试'],
      beer: 'id=a1 src=对话 remind=default reminder=old1,old2',
      tasks: '📅 2026-11-18',
    }),
  )
  const { beer, cloud } = await setup(t, {
    vault: { [SCHEDULE]: original },
    routes: () => ({
      // 已经发出去 / 发失败的提醒，云端回 409；对删除日程来说不算失败。
      'DELETE /reminders/old1': () => ({
        status: 409,
        body: { error: { code: 'not_pending', message: '已发，不能取消' } },
      }),
      'DELETE /reminders/old2': () => ({ id: 'old2', status: 'cancelled' }),
    }),
  })

  const preview = await deleteScheduleItem(beer.context, { id: 'a1' })
  assert.equal(cloud.requests.length, 0, '复述阶段不能调云端')

  const done = await deleteScheduleItem(beer.context, { id: 'a1', confirmToken: preview.confirmToken })
  assert.equal(done.deleted.id, 'a1')
  assert.equal(done.reminderError, null)
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), '')
  assert.deepEqual(cloud.requests.map(r => [r.method, r.path]), [
    ['DELETE', '/reminders/old1'],
    ['DELETE', '/reminders/old2'],
  ])
})

test('云端连不上：日程照常保存，明确提示提醒没建成，不排队', async t => {
  const beer = await startBeer(t, {
    vault: {},
    config: { reminderApiBase: await deadUrl(t) },
    secrets: { 'reminder-api-key': KEY },
    now: NOW,
  })

  const preview = await createScheduleItems(beer.context, { items: [INTERVIEW] })
  const done = await createScheduleItems(beer.context, {
    items: [INTERVIEW], confirmToken: preview.confirmToken,
  })

  assert.equal(done.created.length, 1, '日程不能回滚')
  assert.match(done.reminderError, /提醒没建成/)
  assert.match(done.text, /提醒没建成/)
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /14:00–15:00 某公司终面/)
  assert.match(content, /remind=default%%/)
  assert.doesNotMatch(content, /reminder=/)

  const view = (await beer.api('GET', '/schedule')).body
  assert.equal(view.items[0].reminderError, '提醒没建成')
  assert.deepEqual(view.items[0].reminderIds, [])
  assert.equal(view.items[0].reminderLabel, null)

  const stateFiles = await readdir(beer.dataDir).catch(() => [])
  assert.equal(stateFiles.filter(name => /reminder/i.test(name)).length, 0, '不排队补建')
})

test('改日程连不上云端：日程先保存，旧提醒编号保留在文件里，不假装清掉', async t => {
  const original = lines(
    line({
      time: '14:00–15:00', title: '某公司一面',
      beer: 'id=a1 src=对话 remind=default reminder=old1,old2',
      tasks: '📅 2026-11-18',
    }),
  )
  const beer = await startBeer(t, {
    vault: { [SCHEDULE]: original },
    config: { reminderApiBase: await deadUrl(t) },
    secrets: { 'reminder-api-key': KEY },
    now: NOW,
  })

  const changes = { time: '10:00', endTime: '11:00' }
  const preview = await updateScheduleItem(beer.context, { id: 'a1', changes })
  const done = await updateScheduleItem(beer.context, {
    id: 'a1', changes, confirmToken: preview.confirmToken,
  })

  assert.match(done.reminderError, /提醒没改成/)
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /10:00–11:00 某公司一面/)
  // 旧提醒没删掉：文件里保留旧编号，等下次修改再取消；这样不会出现「旧提醒还在、新编号又没写回」。
  assert.match(content, /remind=default reminder=old1,old2/)
  const view = (await beer.api('GET', '/schedule')).body
  assert.deepEqual(view.items[0].reminderIds, ['old1', 'old2'])
})

test('改日程：旧提醒已经发过（409）时照常继续建新提醒', async t => {
  const original = lines(
    line({
      time: '14:00–15:00', title: '某公司一面',
      beer: 'id=a1 src=对话 remind=30m reminder=old1',
      tasks: '📅 2026-11-18',
    }),
  )
  const { beer, cloud, store } = await setup(t, {
    vault: { [SCHEDULE]: original },
    routes: () => ({
      'DELETE /reminders/old1': () => ({
        status: 409,
        body: { error: { code: 'not_pending', message: '已经发过了' } },
      }),
    }),
  })

  const changes = { time: '10:00', endTime: '11:00' }
  const preview = await updateScheduleItem(beer.context, { id: 'a1', changes })
  const done = await updateScheduleItem(beer.context, {
    id: 'a1', changes, confirmToken: preview.confirmToken,
  })

  assert.equal(done.reminderError, null, '409 是已经做完，不算失败')
  assert.deepEqual(cloud.requests.map(r => r.method), ['DELETE', 'POST'])
  assert.equal(store.length, 1)
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /10:00–11:00 某公司一面 %%beer id=a1 src=对话 remind=30m reminder=r1%% 📅 2026-11-18/)
})

test('未知 %%beer%% 字段原样保留，提醒编号更新不丢字段', async t => {
  const original = lines(
    line({
      time: '14:00–15:00', title: '某公司一面',
      beer: 'id=a1 src=对话 foo="bar baz" remind=default reminder=old1',
      tasks: '📅 2026-11-18',
    }),
  )
  const { beer } = await setup(t, {
    vault: { [SCHEDULE]: original },
    routes: () => ({
      'DELETE /reminders/old1': () => ({ id: 'old1', status: 'cancelled' }),
    }),
  })

  const changes = { title: '某公司终面' }
  const preview = await updateScheduleItem(beer.context, { id: 'a1', changes })
  await updateScheduleItem(beer.context, { id: 'a1', changes, confirmToken: preview.confirmToken })

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /foo="bar baz"/)
  assert.match(content, /remind=default reminder=r1,r2/)
  assert.match(content, /src=对话/)
})

test('列表小标签：默认显示下一次提醒时刻，提前 N 分钟显示 N，off 不显示；没建成显示错误', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ time: '14:00–15:00', title: '默认', beer: 'id=default src=对话 remind=default reminder=r1,r2', tasks: '📅 2026-11-18' }),
        line({ time: '14:00–15:00', title: '提前', beer: 'id=offset src=对话 remind=30m reminder=r3', tasks: '📅 2026-11-18' }),
        line({ time: '14:00–15:00', title: '不提醒', beer: 'id=off src=对话 remind=off', tasks: '📅 2026-11-18' }),
        line({ time: '14:00–15:00', title: '没建成', beer: 'id=broken src=对话 remind=default', tasks: '📅 2026-11-18' }),
      ),
    },
    now: NOW,
  })

  const view = (await beer.api('GET', '/schedule')).body
  const byId = Object.fromEntries(view.items.map(item => [item.id, item]))

  assert.equal(byId.default.reminderLabel, '21:30 邮件提醒')
  assert.equal(byId.default.reminderError, null)
  assert.deepEqual(byId.default.reminderIds, ['r1', 'r2'])

  assert.equal(byId.offset.reminderLabel, '提前 30 分钟')
  assert.equal(byId.offset.reminderError, null)

  assert.equal(byId.off.reminderLabel, null)
  assert.equal(byId.off.reminderError, null)

  assert.equal(byId.broken.reminderLabel, null)
  assert.equal(byId.broken.reminderError, '提醒没建成')
})

test('HTTP 新建日程也同步提醒（快速添加等非 AI 写入路径）', async t => {
  const { beer, store } = await setup(t)

  const res = await beer.api('POST', '/schedule/items', {
    title: '周一选题会', due: '2026-11-16', time: '10:00', endTime: '11:00', source: '快速添加',
  })

  assert.equal(res.status, 201)
  assert.equal(store.length, 2)
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /周一选题会 %%beer id=[0-9a-f]{10} src=快速添加 remind=default reminder=r1,r2%% 📅 2026-11-16/)
})

test('写回提醒编号时按行合并，不覆盖 Obsidian 同时加的条目', async t => {
  const store = []
  let nextId = 1
  let vaultPath = ''
  const cloud = await startFake(t, {
    'POST /reminders': async (_req, body) => {
      // 云端返回之前，模拟用户在 Obsidian 里往同一个文件加了一条。
      const current = await readFile(join(vaultPath, SCHEDULE), 'utf8')
      await writeFile(join(vaultPath, SCHEDULE), current + line({
        title: 'Obsidian 新加的一条', beer: 'id=new src=对话', tasks: '📅 2026-11-15',
      }) + '\n')
      const r = { id: `r${nextId++}`, status: 'pending', ...body, due_at: new Date(body.due_at).toISOString() }
      store.push(r)
      return { status: 201, body: r }
    },
    'GET /reminders': () => ({ reminders: store }),
  })
  const beer = await startBeer(t, {
    config: { reminderApiBase: cloud.url },
    secrets: { 'reminder-api-key': KEY },
    now: NOW,
  })
  vaultPath = beer.vault

  const preview = await createScheduleItems(beer.context, { items: [INTERVIEW] })
  await createScheduleItems(beer.context, { items: [INTERVIEW], confirmToken: preview.confirmToken })

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /某公司终面[^\n]*remind=default reminder=r1,r2/)
  assert.equal((content.match(/Obsidian 新加的一条/g) ?? []).length, 2, '两封提醒返回期间的编辑都保留')
})
