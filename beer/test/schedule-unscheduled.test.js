// #54 没排期、预估时长、子步骤、计划日。
//
// 覆盖：
// - `⏱ 6h` / `6 小时` / `30m` / `1.5h` / `90 分钟` 的解析和「约 N 小时」标签；
// - `⏳` 计划日分组：计划日过了留在「今天」、不算逾期；同时有计划日和截止日时按计划日分组，
//   截止日过了照常逾期，并单独给出截止标签；
// - 没排期分组在最后、组内数量 / 预估总时长 / 「想做、但没定哪天 · 共约 N 小时」副标题；
// - 子步骤：缩进解析、进度、每步单独排期 / 取消排期、新建 / 修改 / 删除接口、
//   在 Beer 里全部勾完时父事项自动完成（Obsidian 手改不触发）；
// - 快速添加「约 N 小时」→ 预估时长，标题去掉短语；
// - 日程 AI 工具能拆步骤、写计划和预估，仍然两步确认。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseQuickAdd, scheduleSummary, SCHEDULE_PATH } from '../src/modules/schedule.js'
import {
  createScheduleItems,
  updateScheduleItem,
  scheduleToolDefinitions,
} from '../src/modules/schedule-tools.js'
import { startBeer } from './helpers/beer.js'

/** 固定在本机时区的 2026-11-12（周四）10:00；本周一 11-09，本周日 11-15。 */
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
  return readFile(join(beer.vault, SCHEDULE_PATH), 'utf8')
}

const byId = list => Object.fromEntries(list.map(item => [item.id, item]))
const group = (body, key) => body.groups.find(entry => entry.key === key)

test('⏱ 预估时长：6h / 6 小时 / 30m / 1.5h / 90 分钟 都能解析成分钟数', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '做一期讲解视频', beer: 'id=d1 src=对话', tasks: '⏱ 6h' }),
        line({ title: '写讲解稿', beer: 'id=d2 src=对话', tasks: '⏱ 6 小时' }),
        line({ title: '给读者群发问卷', beer: 'id=d3 src=对话', tasks: '⏱ 30m' }),
        line({ title: '整理素材', beer: 'id=d4 src=对话', tasks: '⏱ 1.5h' }),
        line({ title: '剪一条短视频', beer: 'id=d5 src=对话', tasks: '⏱ 90 分钟' }),
      ),
    },
    now: NOW,
  })

  const res = await beer.api('GET', '/schedule')
  assert.equal(res.status, 200)
  const items = byId(res.body.items)

  assert.equal(items.d1.durationMinutes, 360)
  assert.equal(items.d1.when.kind, 'estimate')
  assert.equal(items.d1.when.label, '约 6 小时')
  assert.equal(items.d2.durationMinutes, 360)
  assert.equal(items.d2.when.label, '约 6 小时')
  assert.equal(items.d3.durationMinutes, 30)
  assert.equal(items.d3.when.label, '约 30 分钟')
  assert.equal(items.d4.durationMinutes, 90)
  assert.equal(items.d4.when.label, '约 1.5 小时')
  assert.equal(items.d5.durationMinutes, 90)
  assert.equal(items.d5.when.label, '约 1.5 小时')

  for (const item of res.body.items) assert.equal(item.group, 'unscheduled')

  // 没排期分组在最后，组名旁有「想做、但没定哪天 · 共约 N 小时」。
  const unscheduled = group(res.body, 'unscheduled')
  assert.equal(res.body.groups[res.body.groups.length - 1].key, 'unscheduled')
  assert.equal(unscheduled.count, 5)
  assert.equal(unscheduled.label, '没排期')
  assert.equal(unscheduled.totalMinutes, 360 + 360 + 30 + 90 + 90)
  assert.equal(unscheduled.subtitle, '想做、但没定哪天 · 共约 15.5 小时')

  // 新建接口也接受中文单位。
  const created = await beer.api('POST', '/schedule/items', { title: '口头估时', duration: '2 小时' })
  assert.equal(created.status, 201)
  assert.equal(created.body.item.durationMinutes, 120)
})

test('⏳ 计划日：按计划日分组；计划日过了留在「今天」，不算逾期、不标红', async t => {
  let now = new Date('2026-11-12T10:00:00')
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '计划今天的事', beer: 'id=today src=对话', tasks: '⏳ 2026-11-12' }),
        line({ title: '计划周五的事', beer: 'id=week src=对话', tasks: '⏳ 2026-11-13' }),
        line({ title: '昨天计划做的事', beer: 'id=past src=对话', tasks: '⏳ 2026-11-11' }),
        line({ title: '昨天截止的事', beer: 'id=late src=对话', tasks: '📅 2026-11-11' }),
      ),
    },
    now: () => now,
  })

  let body = (await beer.api('GET', '/schedule')).body
  let items = byId(body.items)

  assert.deepEqual(group(body, 'today').items.map(item => item.id), ['past', 'today'])
  assert.deepEqual(group(body, 'overdue').items.map(item => item.id), ['late'])
  assert.deepEqual(group(body, 'week').items.map(item => item.id), ['week'])
  assert.equal(body.summary.today, 2)
  assert.equal(body.summary.overdue, 1)

  assert.equal(items.today.when.kind, 'plan')
  assert.equal(items.today.when.label, '计划今天')
  assert.equal(items.today.overdue, false)
  assert.equal(items.week.when.label, '计划周五')
  assert.equal(items.past.overdue, false, '计划日过了不算逾期')
  assert.equal(items.past.when.kind, 'plan')
  assert.equal(group(body, 'overdue').items.some(item => item.id === 'past'), false)

  // 第二天再看：昨天计划做的事仍然在「今天」，不标红、不进「已逾期」。
  now = new Date('2026-11-13T10:00:00')
  body = (await beer.api('GET', '/schedule')).body
  items = byId(body.items)
  assert.equal(items.past.group, 'today')
  assert.equal(items.past.overdue, false)
  assert.equal(items.past.when.label, '计划周三')
  assert.equal(group(body, 'overdue').items.some(item => item.id === 'past'), false)
  assert.equal(body.summary.overdue, 1, '另一条截止日过期的照常算逾期')
})

test('同时有计划日和截止日：按计划日分组，截止日过了照常算逾期，并单独给出截止标签', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '计划今天、昨天截止', beer: 'id=both-late src=对话', tasks: '⏳ 2026-11-12 📅 2026-11-11' }),
        line({ title: '计划周五、下周截止', beer: 'id=both-ok src=对话', tasks: '⏳ 2026-11-13 📅 2026-11-20' }),
      ),
    },
    now: NOW,
  })

  const body = (await beer.api('GET', '/schedule')).body
  const items = byId(body.items)

  assert.equal(items['both-late'].group, 'today', '按计划日分组')
  assert.equal(items['both-late'].when.label, '计划今天')
  assert.equal(items['both-late'].overdue, true, '截止日过了照常逾期')
  assert.deepEqual(items['both-late'].deadline, { label: '昨天截止', overdue: true })

  assert.equal(items['both-ok'].group, 'week')
  assert.equal(items['both-ok'].when.label, '计划周五')
  assert.equal(items['both-ok'].overdue, false)
  assert.deepEqual(items['both-ok'].deadline, { label: '11月20日截止', overdue: false })

  assert.equal(group(body, 'overdue').items.some(item => item.id === 'both-late'), false, '按计划日分组，不在已逾期里')
  assert.equal(body.summary.overdue, 1)
})

test('子步骤：进度、缩进解析、单独排到今天后出现在今天分组并带「属于 X 第 N 步」', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话', tasks: '⏱ 6h' }),
        line({ indent: '    ', title: '写讲解稿', beer: 'id=step1 src=对话', tasks: '⏱ 2h' }),
        '      这一步先列提纲，周三前写完。',
        line({ indent: '    ', title: '录制', beer: 'id=step2 src=对话', tasks: '⏱ 1h' }),
        line({ indent: '    ', title: '剪辑、配字幕', beer: 'id=step3 src=对话', tasks: '⏱ 3h' }),
      ),
    },
    now: NOW,
  })

  let body = (await beer.api('GET', '/schedule')).body
  let video = byId(body.items).video
  assert.equal(video.subtaskCount, 3)
  assert.equal(video.subtaskDone, 0)
  assert.deepEqual(video.subtasks.map(step => step.title), ['写讲解稿', '录制', '剪辑、配字幕'])
  assert.equal(video.subtasks[0].parentTitle, '做一期 Beer 讲解视频')
  assert.equal(video.subtasks[0].stepIndex, 1)
  assert.equal(video.subtasks[0].stepCount, 3)
  assert.equal(video.subtasks[1].stepIndex, 2)
  // 没排期的子步骤不单独出现在分组里，只在父事项下面显示进度。
  assert.equal(group(body, 'unscheduled').items.length, 1)
  assert.equal(group(body, 'unscheduled').count, 1)

  const scheduled = await beer.api('POST', '/schedule/items/schedule', {
    id: 'step1', scheduled: '2026-11-12', baseVersion: body.version,
  })
  assert.equal(scheduled.status, 200)
  assert.equal(scheduled.body.item.scheduled, '2026-11-12')
  assert.equal(scheduled.body.item.parentTitle, '做一期 Beer 讲解视频')
  assert.equal(scheduled.body.item.stepIndex, 1)

  const content = await readSchedule(beer)
  assert.match(content, /^ {4}- \[ \] 写讲解稿 %%beer id=step1 src=对话%% ⏱ 2h ⏳ 2026-11-12$/m)
  assert.match(content, /这一步先列提纲，周三前写完。/, '读不懂的说明行原样保留')

  body = (await beer.api('GET', '/schedule')).body
  video = byId(body.items).video
  assert.equal(video.subtasks[0].scheduled, '2026-11-12')
  assert.equal(video.subtasks[0].when.label, '计划今天')
  const today = group(body, 'today')
  assert.deepEqual(today.items.map(item => item.id), ['step1'])
  assert.equal(today.items[0].parentTitle, '做一期 Beer 讲解视频')
  assert.equal(today.items[0].stepIndex, 1)
  assert.equal(today.items[0].group, 'today')
  assert.equal(body.summary.today, 1)

  // 取消排期：step 回到父事项下面，不再单独出现在今天组。
  const cleared = await beer.api('POST', '/schedule/items/unschedule', {
    id: 'step1', baseVersion: body.version,
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.item.scheduled, null)
  assert.doesNotMatch(await readSchedule(beer), /⏳/)
  body = (await beer.api('GET', '/schedule')).body
  assert.deepEqual(group(body, 'today').items, [])
  assert.equal(body.summary.today, 0)
})

test('子步骤在 Beer 里全部勾完时父事项自动完成；Obsidian 里手改不自动完成', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话', tasks: '⏱ 4h' }),
        line({ indent: '    ', title: '写讲解稿', beer: 'id=step1 src=对话', tasks: '⏱ 1h' }),
        line({ indent: '    ', title: '录制', beer: 'id=step2 src=对话', tasks: '⏱ 1h' }),
        '      这两步都做完才算完成。',
      ),
    },
    now: NOW,
  })

  let body = (await beer.api('GET', '/schedule')).body
  const first = await beer.api('POST', '/schedule/items/complete', {
    id: 'step1', done: true, baseVersion: body.version,
  })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.autoCompleted ?? [], [], '还有一步没做完，父事项不完成')

  body = (await beer.api('GET', '/schedule')).body
  assert.equal(byId(body.items).video.done, false)
  assert.equal(byId(body.items).video.subtaskDone, 1)

  const second = await beer.api('POST', '/schedule/items/complete', {
    id: 'step2', done: true, baseVersion: body.version,
  })
  assert.equal(second.status, 200)
  assert.deepEqual((second.body.autoCompleted ?? []).map(item => item.id), ['video'])

  const content = await readSchedule(beer)
  assert.match(content, /^- \[x\] 做一期 Beer 讲解视频 %%beer id=video src=对话%% ⏱ 4h ✅ 2026-11-12$/m)
  assert.match(content, /这两步都做完才算完成。/, '父事项下面的说明行原样保留')

  body = (await beer.api('GET', '/schedule')).body
  assert.equal(byId(body.done).video.done, true)
  assert.equal(body.items.some(item => item.id === 'video'), false)

  // 在 Obsidian 里手动把两步勾完、父事项没勾：Beer 读取时不替用户完成父事项。
  const manual = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '手动勾完子步骤', beer: 'id=manual src=对话' }),
        line({ indent: '    ', box: '[x]', title: '第一步', beer: 'id=m1 src=对话', tasks: '✅ 2026-11-11' }),
        line({ indent: '    ', box: '[x]', title: '第二步', beer: 'id=m2 src=对话', tasks: '✅ 2026-11-11' }),
      ),
    },
    now: NOW,
  })
  const manualBody = (await manual.api('GET', '/schedule')).body
  assert.equal(byId(manualBody.items).manual.done, false)
  assert.equal(byId(manualBody.items).manual.subtaskDone, 2)
  assert.equal(group(manualBody, 'unscheduled').count, 1)
})

test('新建带子步骤的日程：写缩进行、每步带 id，进度 0 / 3 步；接口也支持中文单位', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/schedule/items', {
    title: '做一期 Beer 讲解视频',
    duration: '6 小时',
    subtasks: [
      { title: '写讲解稿', duration: '2h' },
      { title: '录制', duration: '1h' },
      { title: '剪辑、配字幕', duration: '3h' },
    ],
  })

  assert.equal(res.status, 201)
  assert.equal(res.body.item.duration, '6 小时')
  assert.equal(res.body.item.durationMinutes, 360)
  assert.equal(res.body.item.subtaskCount, 3)
  assert.equal(res.body.item.subtaskDone, 0)
  assert.deepEqual(res.body.item.subtasks.map(step => step.title), ['写讲解稿', '录制', '剪辑、配字幕'])
  assert.equal(res.body.item.subtasks[0].stepIndex, 1)

  const rows = (await readSchedule(beer)).trimEnd().split('\n')
  assert.equal(rows.length, 4)
  assert.match(rows[0], /^- \[ \] 做一期 Beer 讲解视频 %%beer id=[0-9a-f]{10} src=快速添加%% ⏱ 6 小时$/)
  assert.match(rows[1], /^ {4}- \[ \] 写讲解稿 %%beer id=[0-9a-f]{10} src=快速添加%% ⏱ 2h$/)
  assert.match(rows[2], /^ {4}- \[ \] 录制 %%beer id=[0-9a-f]{10} src=快速添加%% ⏱ 1h$/)
  assert.match(rows[3], /^ {4}- \[ \] 剪辑、配字幕 %%beer id=[0-9a-f]{10} src=快速添加%% ⏱ 3h$/)

  const body = (await beer.api('GET', '/schedule')).body
  assert.equal(group(body, 'unscheduled').count, 1)
  assert.equal(byId(body.items)[res.body.item.id].subtaskCount, 3)
})

test('子步骤接口：新增 / 修改 / 删除，保留父事项下面的说明行', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话', tasks: '⏱ 6h' }),
        '    这是父事项的备注，不属于任何子步骤。',
      ),
    },
    now: NOW,
  })

  let body = (await beer.api('GET', '/schedule')).body
  const added = await beer.api('POST', '/schedule/items/subtasks', {
    parentId: 'video', title: '写讲解稿', duration: '2h', scheduled: '2026-11-13', baseVersion: body.version,
  })
  assert.equal(added.status, 201)
  assert.equal(added.body.item.parentTitle, '做一期 Beer 讲解视频')
  assert.equal(added.body.item.stepIndex, 1)
  assert.equal(added.body.parent.subtaskCount, 1)

  const step1 = added.body.item.id
  const contentAfterAdd = await readSchedule(beer)
  assert.match(contentAfterAdd, /^ {4}- \[ \] 写讲解稿 %%beer id=[0-9a-f]{10} src=对话%% ⏳ 2026-11-13 ⏱ 2h$/m)
  assert.match(contentAfterAdd, /这是父事项的备注/)

  body = (await beer.api('GET', '/schedule')).body
  const added2 = await beer.api('POST', '/schedule/items/subtasks', {
    parentId: 'video', title: '录制', duration: '1 小时', baseVersion: body.version,
  })
  assert.equal(added2.status, 201)
  assert.equal(added2.body.item.stepIndex, 2)
  assert.equal(added2.body.parent.subtaskCount, 2)
  const step2 = added2.body.item.id

  body = (await beer.api('GET', '/schedule')).body
  const updated = await beer.api('POST', '/schedule/items/subtasks/update', {
    id: step2, changes: { title: '录制旁白', duration: '90 分钟', scheduled: '2026-11-12' }, baseVersion: body.version,
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.item.title, '录制旁白')
  assert.equal(updated.body.item.durationMinutes, 90)
  assert.equal(updated.body.item.scheduled, '2026-11-12')
  const contentAfterUpdate = await readSchedule(beer)
  assert.match(contentAfterUpdate, /^ {4}- \[ \] 录制旁白 %%beer id=[0-9a-f]{10} src=对话%% ⏱ 90 分钟 ⏳ 2026-11-12$/m)

  body = (await beer.api('GET', '/schedule')).body
  const deleted = await beer.api('POST', '/schedule/items/subtasks/delete', {
    id: step1, baseVersion: body.version,
  })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.parent.subtaskCount, 1)
  const contentAfterDelete = await readSchedule(beer)
  assert.doesNotMatch(contentAfterDelete, /写讲解稿/)
  assert.match(contentAfterDelete, /录制旁白/)
  assert.match(contentAfterDelete, /这是父事项的备注/, '删除子步骤不碰说明行')
})

test('快速添加：没提日期 + 「约 6 小时」→ 没排期、显示约 6 小时、标题去掉短语', async t => {
  const direct = parseQuickAdd('做一期讲解视频，约 6 小时', NOW())
  assert.equal(direct.title, '做一期讲解视频')
  assert.equal(direct.due, null)
  assert.equal(direct.scheduled, null)
  assert.equal(direct.duration, '6h')
  assert.equal(direct.matched.duration, '约 6 小时')

  assert.equal(parseQuickAdd('写稿 90 分钟', NOW()).duration, '90m')
  assert.equal(parseQuickAdd('录制 1.5h', NOW()).duration, '1.5h')
  assert.equal(parseQuickAdd('剪辑，30m', NOW()).duration, '30m')
  assert.equal(parseQuickAdd('配字幕 2 小时 30 分钟', NOW()).duration, '2h30m')
  // 「计划 / 排到 + 日期」是计划日，不是截止日。
  const planned = parseQuickAdd('计划明天写讲解稿', NOW())
  assert.equal(planned.title, '写讲解稿')
  assert.equal(planned.due, null)
  assert.equal(planned.scheduled, '2026-11-13')

  const beer = await startBeer(t, { vault: {}, now: NOW })
  const res = await beer.api('POST', '/schedule/quick-add', { text: '做一期讲解视频，约 6 小时' })
  assert.equal(res.status, 201)
  assert.equal(res.body.item.title, '做一期讲解视频')
  assert.equal(res.body.item.due, null)
  assert.equal(res.body.item.duration, '6h')
  assert.equal(res.body.item.durationMinutes, 360)

  const content = await readSchedule(beer)
  assert.equal(content, `- [ ] 做一期讲解视频 %%beer id=${res.body.item.id} src=快速添加%% ⏱ 6h\n`)

  const body = (await beer.api('GET', '/schedule')).body
  const unscheduled = group(body, 'unscheduled')
  assert.deepEqual(unscheduled.items.map(item => item.id), [res.body.item.id])
  assert.equal(unscheduled.items[0].when.kind, 'estimate')
  assert.equal(unscheduled.items[0].when.label, '约 6 小时')
  assert.equal(unscheduled.subtitle, '想做、但没定哪天 · 共约 6 小时')
})

test('汇总：/home 和 /schedule 的没排期数量、组内数量和预估总时长口径一致', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话', tasks: '⏱ 6h' }),
        line({ indent: '    ', title: '写讲解稿', beer: 'id=step1 src=对话', tasks: '⏱ 2h ⏳ 2026-11-12' }),
        line({ indent: '    ', title: '录制', beer: 'id=step2 src=对话', tasks: '⏱ 1h' }),
        line({ indent: '    ', title: '剪辑', beer: 'id=step3 src=对话', tasks: '⏱ 3h' }),
        line({ title: '给读者群做一次问卷', beer: 'id=note src=对话', tasks: '⏱ 1h' }),
        line({ title: '昨天截止的稿子', beer: 'id=late src=对话', tasks: '📅 2026-11-11' }),
      ),
    },
    now: NOW,
  })

  const list = (await beer.api('GET', '/schedule')).body
  assert.deepEqual(list.summary, { today: 1, overdue: 1, dueThisWeek: 0, unscheduled: 2 })
  assert.deepEqual(list.groups.map(entry => [entry.key, entry.count]), [
    ['overdue', 1], ['today', 1], ['week', 0], ['later', 0], ['unscheduled', 2],
  ])
  // 预估总时长只算顶层没排期事项（父事项 6h + 问卷 1h），不重复累加子步骤的 2+1+3h。
  assert.equal(group(list, 'unscheduled').totalMinutes, 420)
  assert.equal(group(list, 'unscheduled').subtitle, '想做、但没定哪天 · 共约 7 小时')
  assert.deepEqual(group(list, 'today').items.map(item => item.id), ['step1'])

  const home = (await beer.api('GET', '/home')).body
  assert.deepEqual(home.schedule.summary, list.summary)
  const summaryOnly = await scheduleSummary(beer.context)
  assert.deepEqual(summaryOnly.summary, list.summary)
})

test('AI 工具建日程：items 里带 subtasks，第一次只复述，确认后写出缩进步骤', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const items = [{
    title: '做一期 Beer 讲解视频',
    duration: '6h',
    subtasks: [
      { title: '写讲解稿', duration: '2h', scheduled: '2026-11-12' },
      { title: '录制', duration: '1h' },
      { title: '剪辑、配字幕', duration: '3h' },
    ],
  }]

  const preview = await createScheduleItems(beer.context, { items })
  assert.match(preview.text, /共 3 步/)
  assert.match(preview.text, /写讲解稿/)
  assert.match(preview.text, /确认吗/)
  // 复述阶段不写文件。
  await assert.rejects(readFile(join(beer.vault, SCHEDULE_PATH)), error => error.code === 'ENOENT')

  const done = await createScheduleItems(beer.context, { items, confirmToken: preview.confirmToken })
  assert.match(done.text, /已建好 1 条日程/)
  const rows = (await readSchedule(beer)).trimEnd().split('\n')
  assert.equal(rows.length, 4)
  assert.match(rows[0], /^- \[ \] 做一期 Beer 讲解视频 %%beer id=[0-9a-f]{10} src=对话%% ⏱ 6h$/)
  assert.match(rows[1], /^ {4}- \[ \] 写讲解稿 %%beer id=[0-9a-f]{10} src=对话%% ⏳ 2026-11-12 ⏱ 2h$/)
  assert.match(rows[2], /^ {4}- \[ \] 录制 %%beer id=[0-9a-f]{10} src=对话%% ⏱ 1h$/)
  assert.match(rows[3], /^ {4}- \[ \] 剪辑、配字幕 %%beer id=[0-9a-f]{10} src=对话%% ⏱ 3h$/)

  const body = (await beer.api('GET', '/schedule')).body
  const video = body.items.find(item => item.title === '做一期 Beer 讲解视频')
  assert.equal(video.subtaskCount, 3)
  assert.equal(video.subtasks[0].when.label, '计划今天')
})

test('AI 工具改日程：changes.subtasks 拆步骤 / 改预估 / 计划日，复述确认码稳定', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE_PATH]: lines(
        line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话' }),
        '    原来的备注，拆步骤时不能丢。',
      ),
    },
    now: NOW,
  })

  const changes = {
    duration: '6 小时',
    subtasks: [
      { title: '写讲解稿', duration: '2h', scheduled: '2026-11-12' },
      { title: '录制', duration: '1h' },
      { title: '剪辑、配字幕', duration: '3h' },
    ],
  }

  const preview = await updateScheduleItem(beer.context, { id: 'video', changes })
  assert.match(preview.text, /原来是/)
  assert.match(preview.text, /改成/)
  assert.match(preview.text, /共 3 步/)
  assert.match(preview.text, /写讲解稿/)
  // 预览不写文件。
  assert.doesNotMatch(await readSchedule(beer), /写讲解稿/)

  // 用同一份 changes 再次预览：确认码必须一样，否则用户确认后永远对不上。
  const again = await updateScheduleItem(beer.context, { id: 'video', changes })
  assert.equal(again.confirmToken, preview.confirmToken)

  const done = await updateScheduleItem(beer.context, {
    id: 'video', changes, confirmToken: preview.confirmToken,
  })
  assert.match(done.text, /已把编号 video 的日程改成/)

  const content = await readSchedule(beer)
  assert.match(content, /^- \[ \] 做一期 Beer 讲解视频 %%beer id=video src=对话%% ⏱ 6 小时$/m)
  assert.match(content, /^ {4}- \[ \] 写讲解稿 %%beer id=[0-9a-f]{10} src=对话%% ⏳ 2026-11-12 ⏱ 2h$/m)
  assert.match(content, /^ {4}- \[ \] 录制 %%beer id=[0-9a-f]{10} src=对话%% ⏱ 1h$/m)
  assert.match(content, /^ {4}- \[ \] 剪辑、配字幕 %%beer id=[0-9a-f]{10} src=对话%% ⏱ 3h$/m)
  assert.match(content, /原来的备注，拆步骤时不能丢。/, '未知说明行要保留')

  const body = (await beer.api('GET', '/schedule')).body
  const video = body.items.find(item => item.id === 'video')
  assert.equal(video.subtaskCount, 3)
  assert.equal(video.durationMinutes, 360)
  assert.equal(video.subtasks[0].scheduled, '2026-11-12')
  assert.deepEqual(group(body, 'today').items.map(item => item.id), [video.subtasks[0].id])
})

test('AI 工具定义：create / update 接受 subtasks，嵌套对象满足宿主 schema', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const definitions = scheduleToolDefinitions(beer.context)
  const create = definitions.find(definition => definition.name === 'beer_schedule_create')
  const update = definitions.find(definition => definition.name === 'beer_schedule_update')

  const createItems = create.parameters.items
  assert.equal(createItems.type, 'array')
  assert.equal(createItems.items.additionalProperties, false)
  const subtasks = createItems.items.properties.subtasks
  assert.equal(subtasks.type, 'array')
  assert.equal(subtasks.items.type, 'object')
  assert.equal(subtasks.items.additionalProperties, false)
  assert.equal(subtasks.items.properties.title.required, true)
  assert.equal(subtasks.items.properties.duration.type, 'string')
  assert.equal(subtasks.items.properties.scheduled.type, 'string')

  const changeSubtasks = update.parameters.changes.properties.subtasks
  assert.equal(changeSubtasks.type, 'array')
  assert.equal(changeSubtasks.items.additionalProperties, false)
  assert.equal(changeSubtasks.items.properties.title.required, true)

  // registerScheduleTools 用假宿主也能注册，不因为嵌套 schema 报错。
  const registered = []
  const { registerScheduleTools } = await import('../src/modules/schedule-tools.js')
  const dispose = await registerScheduleTools(
    { tools: { register: definition => { registered.push(definition); return () => {} } } },
    beer.context,
    definition => definition,
    () => {},
  )
  assert.equal(registered.length, 5)
  assert.equal(typeof dispose, 'function')
})
