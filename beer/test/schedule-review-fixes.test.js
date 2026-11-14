// 日程 / 首页代码评审修复（2026-11-13）的跨模块回归测试：
// - AI 工具完成日程走和 HTTP 勾选相同的语义（重复下一条、父事项自动完成、幂等）；
// - 月历按事件日 / 截止日分别标点（详细规则在 schedule-calendar.test.js）；
// - 云端 DELETE 失败时保留旧提醒编号，不建新提醒；
// - 待确认卡片由服务端算提醒文案、带地点；
// - 「改一下」先忽略旧识别结果，旧版本不能再被接受；
// - 复述带子步骤预估和父预估；时长统一用 schedule.js 的解析器；
// - /home 「正在写」带粗略进度。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  durationMinutesOf,
  parseDuration,
  parseQuickAdd,
  SCHEDULE_PATH,
} from '../src/modules/schedule.js'
import {
  createScheduleItems,
  updateScheduleItem,
  completeScheduleItem,
  listPendingSchedules,
} from '../src/modules/schedule-tools.js'
import { startBeer, startFake } from './helpers/beer.js'

const SCHEDULE = SCHEDULE_PATH
// 2026-11-12（周四）10:00；11-15 周日，11-18 周三。
const NOW = () => new Date('2026-11-12T10:00:00')

const lines = (...rows) => rows.join('\n') + '\n'

function line(over = {}) {
  const item = {
    box: '[ ]', time: '', title: '某件事', tags: [], beer: '', tasks: '', indent: '',
    ...over,
  }
  return `${item.indent}- ${item.box} ${item.time ? item.time + ' ' : ''}${item.title}`
    + (item.tags.length ? ' ' + item.tags.map(tag => '#' + tag).join(' ') : '')
    + (item.beer ? ` %%beer ${item.beer}%%` : '')
    + (item.tasks ? ' ' + item.tasks : '')
}

async function readSchedule(beer) {
  return readFile(join(beer.vault, SCHEDULE), 'utf8')
}

async function pendingEntries(beer) {
  const res = await beer.api('GET', '/schedule/pending')
  assert.equal(res.status, 200)
  return res.body.entries
}

// ---- 1. AI 完成日程和 HTTP 勾选同语义 ----

test('AI 完成每周重复事项：生成下一条，结果带 generated，两步确认仍然有效', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '整理本周素材', beer: 'id=weekly src=对话', tasks: '🔁 every week on Sunday 📅 2026-11-15' }),
      ),
    },
    now: NOW,
  })

  const preview = await completeScheduleItem(beer.context, { id: 'weekly' })
  assert.match(preview.text, /标记为已完成/)
  assert.match(preview.text, /确认吗/)
  assert.equal(await readSchedule(beer), lines(
    line({ title: '整理本周素材', beer: 'id=weekly src=对话', tasks: '🔁 every week on Sunday 📅 2026-11-15' }),
  ), '复述阶段不能写文件')

  const done = await completeScheduleItem(beer.context, { id: 'weekly', confirmToken: preview.confirmToken })
  assert.match(done.text, /已完成/)
  assert.match(done.text, /下一条/)
  assert.equal(done.generated.due, '2026-11-22')
  assert.equal(done.generated.title, '整理本周素材')

  const rows = (await readSchedule(beer)).split('\n').filter(Boolean)
  assert.match(rows[0], /^- \[x\] 整理本周素材 %%beer id=weekly src=对话%% 🔁 every week on Sunday 📅 2026-11-15 ✅ 2026-11-12$/)
  assert.match(rows[1], /^- \[ \] 整理本周素材 %%beer id=[0-9a-f]{10} src=对话%% 🔁 every week on Sunday 📅 2026-11-22$/)
})

test('AI 完成最后一步子步骤：父事项自动完成，结果带 autoCompleted', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '做一期讲解视频', beer: 'id=video src=对话', tasks: '⏱ 4h' }),
        line({ indent: '    ', title: '写讲解稿', box: '[x]', beer: 'id=step1 src=对话', tasks: '✅ 2026-11-11' }),
        line({ indent: '    ', title: '录制', beer: 'id=step2 src=对话' }),
      ),
    },
    now: NOW,
  })

  const preview = await completeScheduleItem(beer.context, { id: 'step2' })
  const done = await completeScheduleItem(beer.context, { id: 'step2', confirmToken: preview.confirmToken })

  assert.deepEqual(done.autoCompleted.map(item => item.id), ['video'])
  assert.match(done.text, /自动完成/)
  const content = await readSchedule(beer)
  assert.match(content, /^- \[x\] 做一期讲解视频 %%beer id=video src=对话%% ⏱ 4h ✅ 2026-11-12$/m)
  assert.match(content, /^ {4}- \[x\] 录制 %%beer id=step2 src=对话%% ✅ 2026-11-12$/m)
})

test('AI 完成已经完成的日程是安全的空操作：不写文件、不重复生成下一条', async t => {
  const original = lines(
    line({
      box: '[x]', title: '每周复盘', beer: 'id=done src=对话',
      tasks: '🔁 every week on Sunday 📅 2026-11-15 ✅ 2026-11-11',
    }),
  )
  const beer = await startBeer(t, { vault: { [SCHEDULE]: original }, now: NOW })

  const first = await completeScheduleItem(beer.context, { id: 'done' })
  assert.equal(first.alreadyDone, true)
  assert.match(first.text, /已经是完成/)
  assert.equal(await readSchedule(beer), original)
  assert.equal(first.generated, null)

  const again = await completeScheduleItem(beer.context, { id: 'done' })
  assert.equal(again.alreadyDone, true)
  assert.equal(await readSchedule(beer), original, '重复调用不能追加重复事项')
})

// ---- 2. 月历按事件日 / 截止日分别标点 ----

test('月历：周五截止、计划周三 → 黄点只在周五，周三不画点', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '交稿', beer: 'id=dual src=对话', tasks: '⏳ 2026-11-11 📅 2026-11-13' }),
      ),
    },
    now: NOW,
  })

  const calendar = (await beer.api('GET', '/schedule')).body.calendar
  const weds = calendar.days.find(day => day.date === '2026-11-11')
  const friday = calendar.days.find(day => day.date === '2026-11-13')
  assert.equal(weds.event, false)
  assert.equal(weds.due, false, '只有计划日（⏳）不画黄点')
  assert.equal(friday.due, true, '截止日画黄点')
  assert.equal(friday.event, false)
})

test('月历：有时刻又有截止日的事项，截止日那天既有橘点也有黄点', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ time: '14:00–15:00', title: '某公司一面', beer: 'id=ev src=对话', tasks: '📅 2026-11-18' }),
      ),
    },
    now: NOW,
  })

  const day = (await beer.api('GET', '/schedule')).body.calendar.days.find(cell => cell.date === '2026-11-18')
  assert.equal(day.event, true)
  assert.equal(day.due, true)
})

test('月历：逾期红字落在截止日，不落在提前的计划日', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '交稿', beer: 'id=late src=对话', tasks: '⏳ 2026-11-09 📅 2026-11-10' }),
      ),
    },
    now: NOW,
  })

  const calendar = (await beer.api('GET', '/schedule')).body.calendar
  const planned = calendar.days.find(day => day.date === '2026-11-09')
  const due = calendar.days.find(day => day.date === '2026-11-10')
  assert.equal(planned.overdue, false)
  assert.equal(planned.due, false)
  assert.equal(due.overdue, true)
  assert.equal(due.due, true)
})

test('GET /schedule：同时有计划日和截止日的事项带 date 和 due，点击匹配两个日期都能用', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '交稿', beer: 'id=dual src=对话', tasks: '⏳ 2026-11-14 📅 2026-11-20' }),
      ),
    },
    now: NOW,
  })

  const item = (await beer.api('GET', '/schedule')).body.items[0]
  assert.equal(item.date, '2026-11-14', '事件 / 计划日')
  assert.equal(item.scheduled, '2026-11-14')
  assert.equal(item.due, '2026-11-20', '截止日也要在记录里，客户端按 due 匹配')
})

// ---- 3. 改期时云端 DELETE 失败：保留旧编号，不建新提醒 ----

test('改日程云端 DELETE 500：旧提醒编号保留在文件里，不 POST 新提醒，明确报「提醒没改成」', async t => {
  const key = 'reminder-key-1'
  let deleteFails = true
  const store = []
  const cloud = await startFake(t, {
    'POST /reminders': (_req, body) => {
      const reminder = { id: `r${store.length + 1}`, status: 'pending', ...body }
      store.push(reminder)
      return { status: 201, body: reminder }
    },
    'DELETE /reminders/old1': () => (deleteFails
      ? { status: 500, body: { error: { code: 'internal', message: '云端炸了' } } }
      : { id: 'old1', status: 'cancelled' }),
    'DELETE /reminders/old2': () => ({ id: 'old2', status: 'cancelled' }),
  })
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({
          time: '14:00–15:00', title: '某公司一面', beer: 'id=a1 src=对话 remind=default reminder=old1,old2',
          tasks: '📅 2026-11-18',
        }),
      ),
    },
    config: { reminderApiBase: cloud.url },
    secrets: { 'reminder-api-key': key },
    now: NOW,
  })

  const changes = { time: '10:00', endTime: '11:00' }
  const preview = await updateScheduleItem(beer.context, { id: 'a1', changes })
  const failed = await updateScheduleItem(beer.context, { id: 'a1', changes, confirmToken: preview.confirmToken })

  assert.match(failed.reminderError, /提醒没改成/)
  assert.equal(store.length, 0, '旧提醒没删掉时不能建新提醒')
  assert.deepEqual(cloud.requests.filter(r => r.method === 'POST'), [])
  const afterFailure = await readSchedule(beer)
  assert.match(afterFailure, /10:00–11:00 某公司一面/)
  assert.match(afterFailure, /remind=default reminder=old1,old2/, '旧编号还在，等下次重试取消')

  // 下一次改成功：旧编号被取消，新提醒编号写回。
  deleteFails = false
  const retryChanges = { title: '某公司终面' }
  const retryPreview = await updateScheduleItem(beer.context, { id: 'a1', changes: retryChanges })
  const retried = await updateScheduleItem(beer.context, {
    id: 'a1', changes: retryChanges, confirmToken: retryPreview.confirmToken,
  })

  assert.equal(retried.reminderError, null)
  assert.deepEqual(cloud.requests.filter(r => r.method === 'POST').length, 2)
  const afterRetry = await readSchedule(beer)
  assert.match(afterRetry, /某公司终面 .* remind=default reminder=r1,r2/)
  assert.doesNotMatch(afterRetry, /old1|old2/)
})

// ---- 4. 待确认卡片的提醒文案由服务端算 ----

test('待确认卡片：默认提醒显示下一次提醒时刻，30m 带具体时刻，off 不显示', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const items = [
    { title: '默认提醒', due: '2026-11-18', time: '14:00' },
    { title: '提前提醒', due: '2026-11-18', time: '14:00', remind: '30m' },
    { title: '不提醒', due: '2026-11-18', time: '14:00', remind: 'off' },
    { title: '没有时刻', due: '2026-11-20' },
  ]
  await createScheduleItems(beer.context, { items })

  const entries = await pendingEntries(beer)
  const byTitle = Object.fromEntries(entries[0].items.map(item => [item.title, item]))
  // 现在 11-12 10:00：下一封默认提醒是 11-17 21:30（前一天晚上）。
  assert.equal(byTitle['默认提醒'].reminderLabel, '21:30 邮件提醒')
  assert.equal(byTitle['提前提醒'].reminderLabel, '提前 30 分钟（13:30）')
  assert.equal(byTitle['不提醒'].reminderLabel, null)
  assert.equal(byTitle['没有时刻'].reminderLabel, null)
})

// ---- 5. 待确认地点：schema、文件 loc=、卡片和复述 ----

test('地点：接受 AI 工具的 location，写进 percent-encoded loc=，读回并出现在复述和待确认数据里', async t => {
  const location = '上海市浦东新区张江 1 号楼（3 层会议室）'
  const items = [{
    title: '某公司终面', due: '2026-11-18', time: '14:00', endTime: '15:00',
    location, tags: ['面试'],
  }]
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const preview = await createScheduleItems(beer.context, { items })
  assert.match(preview.text, new RegExp('地点 ' + location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const entries = await pendingEntries(beer)
  assert.equal(entries[0].items[0].location, location, '待确认卡片数据带 location')

  const done = await createScheduleItems(beer.context, { items, confirmToken: preview.confirmToken })
  const content = await readSchedule(beer)
  assert.match(content, / loc=%E4%B8%8A%E6%B5%B7/, '地点写成 percent-encoded 的 loc=')
  assert.doesNotMatch(content, /loc=上海市/, 'loc= 里不能有原始空格 / 中文')

  const view = (await beer.api('GET', '/schedule')).body
  assert.equal(view.items[0].location, location, '读回时解码')
  assert.equal(view.items[0].id, done.created[0].id)

  // update 也能改地点（location 不触发提醒重建），文件里替换成新的 loc=。
  const nextLocation = '线上（腾讯会议 123-456）'
  const updatePreview = await updateScheduleItem(beer.context, {
    id: done.created[0].id, changes: { location: nextLocation },
  })
  assert.match(updatePreview.text, /地点 线上/)
  await updateScheduleItem(beer.context, {
    id: done.created[0].id, changes: { location: nextLocation }, confirmToken: updatePreview.confirmToken,
  })
  assert.equal((await beer.api('GET', '/schedule')).body.items[0].location, nextLocation)
  const updated = await readSchedule(beer)
  assert.match(updated, /loc=%E7%BA%BF%E4%B8%8A/)
  assert.doesNotMatch(updated, /loc=%E4%B8%8A%E6%B5%B7/, '替换而不是追加第二个 loc')
})

test('地点：AI 工具 create / update 的 schema 都接受 location，嵌套对象仍然 additionalProperties:false', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const { scheduleToolDefinitions } = await import('../src/modules/schedule-tools.js')
  const definitions = scheduleToolDefinitions(beer.context)
  const create = definitions.find(definition => definition.name === 'beer_schedule_create')
  const update = definitions.find(definition => definition.name === 'beer_schedule_update')

  assert.equal(create.parameters.items.items.properties.location.type, 'string')
  assert.equal(update.parameters.changes.properties.location.type, 'string')
  assert.equal(create.parameters.items.items.additionalProperties, false)
  assert.equal(update.parameters.changes.additionalProperties, false)
})

// ---- 6. 「改一下」先忽略旧待确认，旧版本不能再被接受 ----

test('改一下：忽略旧识别结果后重新预览，旧版本不能被接受，新版本是全新条目', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  await createScheduleItems(beer.context, { items: [{ title: '旧版本', due: '2026-11-18', time: '14:00' }] })
  const [oldEntry] = await pendingEntries(beer)
  assert.ok(oldEntry)

  const dismissed = await beer.api('POST', '/schedule/pending/dismiss', { id: oldEntry.id })
  assert.equal(dismissed.status, 200)
  assert.deepEqual(await pendingEntries(beer), [], '改一下先把旧条目从待确认状态移除')

  await createScheduleItems(beer.context, { items: [{ title: '新版本', due: '2026-11-19', time: '10:00' }] })
  const [newEntry] = await pendingEntries(beer)
  assert.ok(newEntry)
  assert.notEqual(newEntry.id, oldEntry.id)
  assert.equal(newEntry.items[0].title, '新版本')

  const staleAccept = await beer.api('POST', '/schedule/pending/accept', { id: oldEntry.id })
  assert.equal(staleAccept.status, 404, '旧版本已经删除，不能再被接受')
  assert.equal((await pendingEntries(beer)).length, 1, '旧版本没有复活')
})

// ---- 7. 复述包含子步骤预估和父预估 ----

test('复述：每个子步骤带预估，父事项的预估也保留', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const items = [{
    title: '做一期 Beer 讲解视频',
    duration: '2 小时 30 分钟',
    subtasks: [
      { title: '写讲解稿', duration: '2 小时' },
      { title: '录制', duration: '90 分钟' },
    ],
  }]

  const preview = await createScheduleItems(beer.context, { items })
  assert.match(preview.text, /写讲解稿（约 2 小时）/)
  assert.match(preview.text, /录制（约 1.5 小时）/)
  assert.match(preview.text, /约 2.5 小时/)
})

// ---- 8. 时长统一解析器 ----

test('时长：同一个解析器接受 6h / 6 小时 / 90 分钟 / 1h30m / 2 小时 30 分钟', () => {
  assert.deepEqual(parseDuration('6h'), { hours: 6, minutes: 0, totalMinutes: 360, hasHours: true })
  assert.deepEqual(parseDuration('6 小时'), { hours: 6, minutes: 0, totalMinutes: 360, hasHours: true })
  assert.equal(durationMinutesOf('90 分钟'), 90)
  assert.equal(durationMinutesOf('1h30m'), 90)
  assert.equal(durationMinutesOf('2 小时 30 分钟'), 150)
  assert.equal(durationMinutesOf('约 6 小时'), 360)
  assert.equal(durationMinutesOf('随便'), null)

  // 快速添加保留原来的规范化写法，但识别走同一个解析器。
  assert.equal(parseQuickAdd('写稿 90 分钟', NOW()).duration, '90m')
  assert.equal(parseQuickAdd('写稿 1h30m', NOW()).duration, '1h30m')
  assert.equal(parseQuickAdd('写稿 2 小时 30 分钟', NOW()).duration, '2h30m')
})

test('parseQuickAdd：now 是必填参数，不再用墙上时钟兜底', () => {
  assert.throws(() => parseQuickAdd('明天交稿'), TypeError)
  assert.throws(() => parseQuickAdd('明天交稿', null), TypeError)
  assert.equal(parseQuickAdd('明天交稿', NOW()).due, '2026-11-13')
})

// ---- 9. /home「正在写」粗略进度 ----

test('GET /home：正在写按状态带粗略进度（选题 15、草稿 50）', async t => {
  const TOPIC = '内容库/文章/2026-11-01-选题/index.md'
  const DRAFT = '内容库/文章/2026-11-02-草稿/index.md'
  const beer = await startBeer(t, {
    vault: {
      [TOPIC]: '---\n标题: 选题\n状态: 选题\n日期: 2026-11-01\n---\n\n# 选题\n',
      [DRAFT]: '---\n标题: 草稿\n状态: 草稿\n日期: 2026-11-02\n---\n\n# 草稿\n',
    },
    now: NOW,
  })

  const res = await beer.api('GET', '/home')
  assert.equal(res.status, 200)
  const byStatus = Object.fromEntries(res.body.tasks.writing.map(item => [item.status, item.progress]))
  assert.deepEqual(byStatus, { 选题: 15, 草稿: 50 })
})
