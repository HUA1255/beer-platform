// 日程文件与首页「日程与待办」接口测试（#49）。
// 只通过 /api/beer/ 验证：解析、分组、汇总、勾选写回、删除（含缩进子步骤）、
// 未知行保留、在 Obsidian 里改过之后的按行合并，以及首页汇总里的日程数字。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl } from './helpers/beer.js'

const SCHEDULE = '日程.md'

/** 固定在本机时区的 2026-11-12（周四）10:00；本周一 11-09，周日 11-15。 */
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

test('GET /schedule：解析 日程.md，按已逾期 / 今天 / 本周 / 以后分组并给出汇总', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '把旧稿改完', tags: ['文章'], beer: 'id=late src=对话', tasks: '📅 2026-11-11' }),
        line({ time: '14:00–15:00', title: '某公司一面', tags: ['面试'], beer: 'id=a1 src=对话', tasks: '📅 2026-11-12' }),
        line({ title: '交《效率工具》专栏稿', tags: ['写作'], beer: 'id=week src=快速添加', tasks: '📅 2026-11-13' }),
        line({ title: '整理本周素材，挑下周选题', beer: 'id=later src=对话', tasks: '📅 2026-11-20' }),
        line({ box: '[x]', title: '看昨天的读者留言', beer: 'id=done src=对话', tasks: '📅 2026-11-12 ✅ 2026-11-12' }),
        '这段是用户自己写的话，Beer 读不懂，要原样留着。',
        line({ title: '做一期讲解视频', beer: 'id=nodate src=对话', tasks: '⏱ 6h' }),
      ),
    },
    now: NOW,
  })

  const res = await beer.api('GET', '/schedule')

  assert.equal(res.status, 200)
  assert.equal(res.body.path, SCHEDULE)
  assert.equal(res.body.exists, true)
  assert.equal(typeof res.body.version, 'string')
  assert.equal(res.body.today, '2026-11-12')
  assert.equal(res.body.weekEnd, '2026-11-15')
  assert.deepEqual(res.body.summary, { today: 1, overdue: 1, dueThisWeek: 1, unscheduled: 1 })

  const byKey = Object.fromEntries(res.body.groups.map(group => [group.key, group]))
  assert.deepEqual(res.body.groups.map(group => group.key), ['overdue', 'today', 'week', 'later', 'unscheduled'])
  assert.equal(byKey.overdue.label, '已逾期')
  assert.deepEqual(byKey.overdue.items.map(item => item.id), ['late'])
  assert.equal(byKey.overdue.items[0].overdue, true)
  assert.equal(byKey.overdue.items[0].when.label, '昨天截止')
  assert.deepEqual(byKey.today.items.map(item => item.id), ['a1'])
  assert.equal(byKey.today.items[0].kind, 'event')
  assert.equal(byKey.today.items[0].time, '14:00')
  assert.equal(byKey.today.items[0].endTime, '15:00')
  assert.equal(byKey.today.items[0].when.label, '14:00–15:00')
  assert.equal(byKey.today.items[0].when.day, null)
  assert.deepEqual(byKey.today.items[0].tags, ['面试'])
  assert.equal(byKey.today.items[0].source, '对话')
  assert.deepEqual(byKey.week.items.map(item => item.id), ['week'])
  assert.equal(byKey.week.items[0].when.label, '周五截止')
  assert.deepEqual(byKey.later.items.map(item => item.id), ['later'])
  assert.deepEqual(byKey.unscheduled.items.map(item => item.id), ['nodate'])
  assert.equal(byKey.unscheduled.items[0].duration, '6h')
  assert.equal(byKey.unscheduled.items[0].durationMinutes, 360)

  // 已完成只在 done 列表里，不进上面的分组和汇总。
  assert.deepEqual(res.body.done.map(item => item.id), ['done'])
  assert.equal(res.body.done[0].done, true)
  assert.equal(res.body.done[0].completedAt, '2026-11-12')

  // 未知行不解析、不丢失：全部事项里也没有它。
  assert.equal(res.body.items.length, 5)
})

test('勾选完成：写回 - [x] 和 ✅ 日期，保留 id、未知 Tasks 字段和读不懂的行；取消勾选去掉 ✅', async t => {
  const original = lines(
    line({ title: '交稿', tags: ['写作'], beer: 'id=w1 src=快速添加', tasks: '📅 2026-11-13 ⏫' }),
    '- 用户在 Obsidian 里写的一句说明，不是任务',
    line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }),
  )
  const beer = await startBeer(t, { vault: { [SCHEDULE]: original }, now: NOW })
  const first = (await beer.api('GET', '/schedule')).body

  const done = await beer.api('POST', '/schedule/items/complete', {
    id: 'w1', done: true, baseVersion: first.version,
  })

  assert.equal(done.status, 200)
  assert.equal(done.body.merged, false)
  assert.equal(done.body.item.id, 'w1')
  assert.equal(done.body.item.done, true)
  assert.equal(done.body.item.completedAt, '2026-11-12')
  const afterDone = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.equal(afterDone, lines(
    '- [x] 交稿 #写作 %%beer id=w1 src=快速添加%% 📅 2026-11-13 ⏫ ✅ 2026-11-12',
    '- 用户在 Obsidian 里写的一句说明，不是任务',
    line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }),
  ))

  const second = (await beer.api('GET', '/schedule')).body
  const undone = await beer.api('POST', '/schedule/items/complete', {
    id: 'w1', done: false, baseVersion: second.version,
  })

  assert.equal(undone.status, 200)
  assert.equal(undone.body.item.done, false)
  assert.equal(undone.body.item.completedAt, null)
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), original)
  assert.deepEqual(undone.body.item.tags, ['写作'])
  assert.equal(undone.body.item.source, '快速添加')
})

test('删除：去掉目标行和它缩进的子步骤 / 说明，其他行原样保留', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ time: '09:00', title: '看读者留言', beer: 'id=keep src=对话', tasks: '📅 2026-11-12' }),
        line({ title: '做一期讲解视频', beer: 'id=parent src=对话', tasks: '⏱ 6h' }),
        '    - [ ] 写讲解稿 %%beer id=step1 src=对话%%',
        '      这一步先列提纲，周三前写完。',
        '    - [x] 录制 %%beer id=step2 src=对话%% ✅ 2026-11-11',
        line({ title: '交专栏稿', beer: 'id=other src=快速添加', tasks: '📅 2026-11-13' }),
        '# 下面是用户自己的分区标题',
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  const res = await beer.api('POST', '/schedule/items/delete', {
    id: 'parent', baseVersion: before.version,
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.deleted.id, 'parent')
  assert.equal(res.body.deleted.title, '做一期讲解视频')
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), lines(
    line({ time: '09:00', title: '看读者留言', beer: 'id=keep src=对话', tasks: '📅 2026-11-12' }),
    line({ title: '交专栏稿', beer: 'id=other src=快速添加', tasks: '📅 2026-11-13' }),
    '# 下面是用户自己的分区标题',
  ))

  const after = (await beer.api('GET', '/schedule')).body
  assert.deepEqual(after.items.map(item => item.id), ['keep', 'other'])
})

test('并发合并：在 Obsidian 里改过之后，Beer 勾选按 id 合并，不覆盖那次修改', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '交稿', tags: ['写作'], beer: 'id=w1 src=快速添加', tasks: '📅 2026-11-13' }),
        line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  // 用户在手机 Obsidian 里改了标题、加了一条，然后 Beer 才用旧版本勾选。
  await writeFile(join(beer.vault, SCHEDULE), lines(
    line({ title: '交专栏稿（改过标题）', tags: ['写作'], beer: 'id=w1 src=快速添加', tasks: '📅 2026-11-13' }),
    line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }),
    line({ title: '新加的一条', beer: 'id=new src=对话', tasks: '📅 2026-11-15' }),
  ))

  const res = await beer.api('POST', '/schedule/items/complete', {
    id: 'w1', done: true, baseVersion: before.version,
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.merged, true)
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), lines(
    '- [x] 交专栏稿（改过标题） #写作 %%beer id=w1 src=快速添加%% 📅 2026-11-13 ✅ 2026-11-12',
    line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }),
    line({ title: '新加的一条', beer: 'id=new src=对话', tasks: '📅 2026-11-15' }),
  ))
})

test('并发合并：目标行在 Obsidian 里被删掉时明确报错，不写文件、不误删别的行', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '交稿', beer: 'id=w1 src=对话', tasks: '📅 2026-11-13' }),
        line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body
  const edited = lines(line({ title: '改稿', beer: 'id=w2 src=对话', tasks: '📅 2026-11-14' }))
  await writeFile(join(beer.vault, SCHEDULE), edited)

  const res = await beer.api('POST', '/schedule/items/delete', {
    id: 'w1', baseVersion: before.version,
  })

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'schedule_merge_conflict')
  assert.match(res.body.error.message, /刷新/)
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), edited)
})

test('有具体时刻的事项：过了结束时间变灰、留在今天组，不算逾期；快到时给「还有 N 分钟」', async t => {
  let now = new Date('2026-11-12T13:30:00')
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ time: '14:00–15:00', title: '某公司一面', beer: 'id=soon src=对话', tasks: '📅 2026-11-12' }),
        line({ time: '14:00–15:00', title: '昨天的一面', beer: 'id=yesterday src=对话', tasks: '📅 2026-11-11' }),
        line({ title: '交稿', beer: 'id=due src=对话', tasks: '📅 2026-11-11' }),
      ),
    },
    now: () => now,
  })

  const before = (await beer.api('GET', '/schedule')).body
  const soon = before.items.find(item => item.id === 'soon')
  assert.equal(soon.kind, 'event')
  assert.equal(soon.group, 'today')
  assert.equal(soon.past, false)
  assert.equal(soon.overdue, false)
  assert.equal(soon.startsInMinutes, 30)

  const yesterday = before.items.find(item => item.id === 'yesterday')
  assert.equal(yesterday.group, 'today')
  assert.equal(yesterday.past, true)
  assert.equal(yesterday.gray, true)
  assert.equal(yesterday.overdue, false)

  // 过了 15:00：变灰、沉到本组下面，仍不算逾期。
  now = new Date('2026-11-12T15:30:00')
  const after = (await beer.api('GET', '/schedule')).body
  const past = after.items.find(item => item.id === 'soon')
  assert.equal(past.past, true)
  assert.equal(past.gray, true)
  assert.equal(past.overdue, false)
  assert.equal(past.startsInMinutes, null)
  assert.equal(after.summary.overdue, 1, '只有截止日过期的那条算逾期')
  assert.deepEqual(after.groups.find(group => group.key === 'today').items.map(item => item.id), ['yesterday', 'soon'])
})

test('新建日程：写进库根 日程.md，Beer 字段在 Tasks 字段前面，id 稳定', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const created = await beer.api('POST', '/schedule/items', {
    title: '某公司一面',
    due: '2026-11-18',
    time: '14:00',
    endTime: '15:00',
    tags: ['面试'],
    source: '对话',
  })

  assert.equal(created.status, 201)
  assert.equal(created.body.path, SCHEDULE)
  assert.equal(created.body.item.kind, 'event')
  assert.equal(created.body.item.due, '2026-11-18')
  assert.equal(created.body.item.source, '对话')
  assert.deepEqual(created.body.item.tags, ['面试'])
  assert.match(created.body.item.id, /^[0-9a-f]{10}$/)

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.equal(content, `- [ ] 14:00–15:00 某公司一面 #面试 %%beer id=${created.body.item.id} src=对话 remind=default%% 📅 2026-11-18\n`)

  const list = (await beer.api('GET', '/schedule')).body
  const item = list.groups.find(group => group.key === 'later').items[0]
  assert.equal(item.id, created.body.item.id)
  // 不是今天的事件要带上哪天，否则「以后」分组里只看到时刻。
  assert.equal(item.when.label, '11月18日 14:00–15:00')
  assert.equal(item.when.day, '11月18日')
  assert.equal(item.when.time, '14:00–15:00')

  // 再建一条：同样带 id，追加在文件末尾，不覆盖上一条。
  const second = await beer.api('POST', '/schedule/items', {
    title: '交专栏稿', due: '2026-11-13', source: '快速添加',
  })
  assert.equal(second.status, 201)
  assert.notEqual(second.body.item.id, created.body.item.id)
  const linesAfter = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n')
  assert.equal(linesAfter.filter(Boolean).length, 2)
  assert.match(linesAfter[0], /某公司一面/)
  assert.match(linesAfter[1], /交专栏稿/)
})

test('重复规则和子步骤：解析 🔁 / ⏱ / ⏳，子步骤不下沉成顶层事项，勾选时保留重复规则', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ title: '整理本周素材，挑下周选题', beer: 'id=rec src=对话', tasks: '🔁 every week on Sunday 📅 2026-11-15' }),
        line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话', tasks: '⏱ 6h' }),
        '    - [ ] 写讲解稿 %%beer id=step1 src=对话%% ⏱ 2h ⏳ 2026-11-13',
        '    - [ ] 录制 %%beer id=step2 src=对话%% ⏱ 1h',
      ),
    },
    now: NOW,
  })

  const list = (await beer.api('GET', '/schedule')).body
  const rec = list.items.find(item => item.id === 'rec')
  assert.equal(rec.recurrence, 'every week on Sunday')
  assert.equal(rec.group, 'week')
  assert.equal(rec.when.label, '周日截止')

  const video = list.items.find(item => item.id === 'video')
  assert.equal(video.group, 'unscheduled')
  assert.equal(video.duration, '6h')
  assert.equal(video.subtaskCount, 2)
  assert.equal(video.subtaskDone, 0)
  assert.deepEqual(video.subtasks.map(step => step.title), ['写讲解稿', '录制'])
  assert.equal(video.subtasks[0].scheduled, '2026-11-13')
  assert.equal(video.subtasks[0].when.label, '计划周五')
  assert.equal(video.subtasks[0].durationMinutes, 120)
  // 子步骤不是独立的分组事项。
  assert.equal(list.items.length, 2)

  const done = await beer.api('POST', '/schedule/items/complete', {
    id: 'rec', done: true, baseVersion: list.version,
  })
  assert.equal(done.status, 200)
  // #51：完成重复事项会紧跟其后生成下一条；子步骤仍挂在原来的父事项下面。
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  const rows = content.split('\n')
  assert.equal(rows[0], '- [x] 整理本周素材，挑下周选题 %%beer id=rec src=对话%% 🔁 every week on Sunday 📅 2026-11-15 ✅ 2026-11-12')
  assert.match(rows[1], /^- \[ \] 整理本周素材，挑下周选题 %%beer id=[0-9a-f]{10} src=对话%% 🔁 every week on Sunday 📅 2026-11-22$/)
  assert.equal(rows.slice(2).join('\n'), lines(
    line({ title: '做一期 Beer 讲解视频', beer: 'id=video src=对话', tasks: '⏱ 6h' }),
    '    - [ ] 写讲解稿 %%beer id=step1 src=对话%% ⏱ 2h ⏳ 2026-11-13',
    '    - [ ] 录制 %%beer id=step2 src=对话%% ⏱ 1h',
  ))
})

test('只写开始时刻的事项按 1 小时算结束：10:30 时 09:00 的那条已变灰、不算逾期', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line({ time: '09:00', title: '看昨天的读者留言', beer: 'id=read src=对话', tasks: '📅 2026-11-12' }),
      ),
    },
    now: () => new Date('2026-11-12T10:30:00'),
  })

  const item = (await beer.api('GET', '/schedule')).body.items[0]

  assert.equal(item.kind, 'event')
  assert.equal(item.endTime, null)
  assert.equal(item.past, true)
  assert.equal(item.gray, true)
  assert.equal(item.overdue, false)
  assert.equal(item.group, 'today')
  assert.equal(item.when.label, '09:00')
})

test('GET /schedule：还没有 日程.md 时返回空日程，不建文件', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('GET', '/schedule')

  assert.equal(res.status, 200)
  assert.equal(res.body.exists, false)
  assert.equal(res.body.version, null)
  assert.equal(res.body.modifiedAt, null)
  assert.deepEqual(res.body.summary, { today: 0, overdue: 0, dueThisWeek: 0, unscheduled: 0 })
  assert.deepEqual(res.body.items, [])
  assert.deepEqual(res.body.done, [])
  assert.deepEqual(res.body.groups.map(group => [group.key, group.count]), [
    ['overdue', 0], ['today', 0], ['week', 0], ['later', 0], ['unscheduled', 0],
  ])
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(beer.vault), [])
})
