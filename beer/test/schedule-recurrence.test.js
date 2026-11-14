// 周期性日程（#51）：重复规则解析、下一条日期计算、完成后追加下一条。
// 纯函数（parseRecurrence / nextOccurrence / recurrenceLabel）直接测；写回行为走 HTTP。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRecurrence, nextOccurrence, recurrenceLabel } from '../src/modules/schedule.js'
import { startBeer } from './helpers/beer.js'

const SCHEDULE = '日程.md'
/** 固定 2026-11-12（周四）10:00；11-15 是周日。 */
const NOW = () => new Date('2026-11-12T10:00:00')
const lines = (...rows) => rows.join('\n') + '\n'
const line = (box, body) => `- [${box}] ${body}`

// ---- 纯函数：解析与标签 ----

test('parseRecurrence：识别每天 / 每周某天 / 每月某日 / 每月最后一天', () => {
  assert.equal(parseRecurrence('every day').kind, 'day')
  assert.equal(parseRecurrence('every day').supported, true)

  const week = parseRecurrence('every week on Sunday')
  assert.equal(week.kind, 'week')
  assert.equal(week.weekday, 0)
  assert.equal(week.canonical, 'every week on Sunday')

  const month = parseRecurrence('every month on the 15th')
  assert.equal(month.kind, 'month')
  assert.equal(month.day, 15)
  assert.equal(month.canonical, 'every month on the 15th')

  const last = parseRecurrence('every month on the last')
  assert.equal(last.kind, 'month')
  assert.equal(last.last, true)
  assert.equal(last.canonical, 'every month on the last')

  // 也接受 Tasks / 旧 README 里不带 the / 序数后缀的写法。
  assert.equal(parseRecurrence('every month on 5').day, 5)
  assert.equal(parseRecurrence('every month on the 1st').day, 1)
  // 大小写不敏感。
  assert.equal(parseRecurrence('every week on sunday').weekday, 0)
})

test('parseRecurrence：中文输入（每周日 / 每月 15 日）转成 Tasks 写法，未知规则原样保留', () => {
  assert.equal(parseRecurrence('每天').canonical, 'every day')
  assert.equal(parseRecurrence('每周日').canonical, 'every week on Sunday')
  assert.equal(parseRecurrence('每周天').weekday, 0)
  assert.equal(parseRecurrence('每周二').weekday, 2)
  // 快速添加 / AI 也可能只给「周二」「星期日」。
  assert.equal(parseRecurrence('周日').canonical, 'every week on Sunday')
  assert.equal(parseRecurrence('星期二').weekday, 2)
  assert.equal(parseRecurrence('每月 15 日').canonical, 'every month on the 15th')
  assert.equal(parseRecurrence('每月15号').day, 15)
  assert.equal(parseRecurrence('每月最后一天').canonical, 'every month on the last')

  const unknown = parseRecurrence('every 2 weeks on Monday')
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.supported, false)
  assert.equal(unknown.text, 'every 2 weeks on Monday')
  assert.equal(unknown.canonical, 'every 2 weeks on Monday')
  assert.equal(parseRecurrence(''), null)
})

test('recurrenceLabel：列表里显示的中文小标签', () => {
  assert.equal(recurrenceLabel('every day'), '每天')
  assert.equal(recurrenceLabel('every week on Sunday'), '每周日')
  assert.equal(recurrenceLabel('every week on tuesday'), '每周二')
  assert.equal(recurrenceLabel('every month on the 15th'), '每月 15 日')
  assert.equal(recurrenceLabel('every month on the last'), '每月最后一天')
  assert.equal(recurrenceLabel('every 2 weeks on Monday'), 'every 2 weeks on Monday')
  assert.equal(recurrenceLabel(null), '')
})

// ---- 纯函数：下一条日期 ----

test('nextOccurrence：每天 / 每周某天', () => {
  assert.equal(nextOccurrence('every day', '2026-11-12'), '2026-11-13')
  assert.equal(nextOccurrence('every day', '2026-12-31'), '2027-01-01')

  // 到期日正好是周日：下一条是下周日。
  assert.equal(nextOccurrence('every week on Sunday', '2026-11-15'), '2026-11-22')
  // 到期日不是周日：下一条是之后的第一个周日（和 Tasks 一致）。
  assert.equal(nextOccurrence('every week on Sunday', '2026-11-10'), '2026-11-15')
  assert.equal(nextOccurrence('every week on Tuesday', '2026-11-12'), '2026-11-17')
})

test('nextOccurrence：每月某日，跨月、月末和短月按规则日回补', () => {
  assert.equal(nextOccurrence('every month on the 15th', '2026-11-15'), '2026-12-15')
  // 到期日不在规则日：先补到本月规则日（和 Tasks 一致）。
  assert.equal(nextOccurrence('every month on the 15th', '2026-11-10'), '2026-11-15')

  // 31 日在短月夹到当月最后一天；下个月恢复规则里的 31 日。
  assert.equal(nextOccurrence('every month on the 31st', '2026-01-31'), '2026-02-28')
  assert.equal(nextOccurrence('every month on the 31st', '2026-02-28'), '2026-03-31')
  assert.equal(nextOccurrence('every month on the 31st', '2028-01-31'), '2028-02-29')

  // 每月最后一天：短月 / 闰年都取当月最后一天。
  assert.equal(nextOccurrence('every month on the last', '2026-01-31'), '2026-02-28')
  assert.equal(nextOccurrence('every month on the last', '2026-02-28'), '2026-03-31')
  assert.equal(nextOccurrence('every month on the last', '2028-02-10'), '2028-02-29')
})

// ---- HTTP：完成时生成下一条 ----

test('验收场景：新建「每周日整理素材」，完成后自动出现下周日那一条', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const created = await beer.api('POST', '/schedule/items', {
    title: '整理素材', due: '2026-11-15', recurrence: '每周日', source: '快速添加',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.item.recurrence, 'every week on Sunday')

  const list = (await beer.api('GET', '/schedule')).body
  const done = await beer.api('POST', '/schedule/items/complete', {
    id: created.body.item.id, done: true, baseVersion: list.version,
  })
  assert.equal(done.status, 200)

  const after = (await beer.api('GET', '/schedule')).body
  assert.equal(after.done.length, 1)
  assert.equal(after.done[0].due, '2026-11-15')
  assert.equal(after.done[0].completedAt, '2026-11-12')
  const next = after.items.find(item => item.recurrence === 'every week on Sunday')
  assert.equal(next.due, '2026-11-22')
  assert.equal(next.recurrenceLabel, '每周日')
  assert.notEqual(next.id, created.body.item.id)
})

test('完成重复事项：保留已完成行和 ✅，紧跟其后追加下一条（每天）', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '09:00 看昨天的读者留言 #读者 %%beer id=daily src=对话%% 🔁 every day 📅 2026-11-12 ⏱ 20m'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  const res = await beer.api('POST', '/schedule/items/complete', {
    id: 'daily', done: true, baseVersion: before.version,
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.item.done, true)
  assert.equal(res.body.item.completedAt, '2026-11-12')
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  const rows = content.split('\n')
  assert.equal(rows[0], '- [x] 09:00 看昨天的读者留言 #读者 %%beer id=daily src=对话%% 🔁 every day 📅 2026-11-12 ⏱ 20m ✅ 2026-11-12')
  assert.match(rows[1], /^- \[ \] 09:00 看昨天的读者留言 #读者 %%beer id=[0-9a-f]{10} src=对话%% 🔁 every day 📅 2026-11-13 ⏱ 20m$/)
  assert.notEqual(rows[1].match(/id=([0-9a-f]{10})/)[1], 'daily')
  assert.equal(rows.filter(Boolean).length, 2)
})

test('完成每周重复事项：按原到期日算下周日，不按完成日算', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '整理本周素材，挑下周选题 %%beer id=weekly src=对话%% 🔁 every week on Sunday 📅 2026-11-15'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  // 11-12 周四提前完成 11-15 周日那条：下一条仍是 11-22，不是 11-15。
  await beer.api('POST', '/schedule/items/complete', { id: 'weekly', done: true, baseVersion: before.version })

  const rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[0], /^- \[x\] .* 📅 2026-11-15 ✅ 2026-11-12$/)
  assert.match(rows[1], /^- \[ \] .* 🔁 every week on Sunday 📅 2026-11-22$/)
})

test('完成每月重复事项：下一条是下月规则日；⏳ 计划日按同样的间隔平移', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '月度复盘 %%beer id=monthly src=对话%% 🔁 every month on the 15th 📅 2026-11-15 ⏳ 2026-11-13'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  await beer.api('POST', '/schedule/items/complete', { id: 'monthly', done: true, baseVersion: before.version })

  const rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[0], /^- \[x\] .* 📅 2026-11-15 ⏳ 2026-11-13 ✅ 2026-11-12$/)
  // 到期日 +30 天，计划日也 +30 天，保持相对位置。
  assert.match(rows[1], /^- \[ \] .* 🔁 every month on the 15th 📅 2026-12-15 ⏳ 2026-12-13$/)
})

test('完成每月 31 日的重复事项：短月夹到月末，再下个月恢复 31 日', async t => {
  let now = new Date('2026-01-31T10:00:00')
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '月末对账 %%beer id=end src=对话%% 🔁 every month on the 31st 📅 2026-01-31'),
      ),
    },
    now: () => now,
  })

  const first = (await beer.api('GET', '/schedule')).body
  await beer.api('POST', '/schedule/items/complete', { id: 'end', done: true, baseVersion: first.version })
  let rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[1], /📅 2026-02-28$/)

  // 2 月 28 日再完成一次 → 3 月 31 日（规则里的 31 日，不是 28 日）。
  now = new Date('2026-02-28T10:00:00')
  const second = (await beer.api('GET', '/schedule')).body
  const next = second.items.find(item => item.recurrence === 'every month on the 31st')
  await beer.api('POST', '/schedule/items/complete', { id: next.id, done: true, baseVersion: second.version })
  rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[2], /📅 2026-03-31$/)
})

test('完成只有计划日（⏳）的重复事项：只平移计划日，不凭空加截止日', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '每周整理收件箱 %%beer id=planned src=对话%% 🔁 every week on Monday ⏳ 2026-11-16'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  await beer.api('POST', '/schedule/items/complete', { id: 'planned', done: true, baseVersion: before.version })

  const rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[0], /^- \[x\] .* ⏳ 2026-11-16 ✅ 2026-11-12$/)
  assert.match(rows[1], /^- \[ \] .* 🔁 every week on Monday ⏳ 2026-11-23$/)
  assert.doesNotMatch(rows[1], /📅/)
})

test('未知重复规则：完成后原样保留规则，不生成下一条，也不改其他内容', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '每两周交一次周报 %%beer id=custom src=对话%% 🔁 every 2 weeks on Monday 📅 2026-11-16'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  const res = await beer.api('POST', '/schedule/items/complete', {
    id: 'custom', done: true, baseVersion: before.version,
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.item.recurrence, 'every 2 weeks on Monday')
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), lines(
    '- [x] 每两周交一次周报 %%beer id=custom src=对话%% 🔁 every 2 weeks on Monday 📅 2026-11-16 ✅ 2026-11-12',
  ))
})

test('没有 📅 / ⏳ 的重复事项：只勾完成，不生成下一条（无法确定下一次日期）', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '想到就做 %%beer id=nodate src=对话%% 🔁 every day ⏱ 1h'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  await beer.api('POST', '/schedule/items/complete', { id: 'nodate', done: true, baseVersion: before.version })

  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), lines(
    '- [x] 想到就做 %%beer id=nodate src=对话%% 🔁 every day ⏱ 1h ✅ 2026-11-12',
  ))
})

test('新的一条 id 稳定且不重复；提醒编号不复制，来源 / 标签 / 时长 / 关联文章保留', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '15:00–16:00 选题会 #会议 %%beer id=meet src=QQ邮箱 reminder=r-9 article="内容库/文章/选题会"%% '
          + '🔁 every week on Thursday 📅 2026-11-12 ⏱ 1h'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  await beer.api('POST', '/schedule/items/complete', { id: 'meet', done: true, baseVersion: before.version })

  const rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[0], /^- \[x\] .* reminder=r-9 .* ✅ 2026-11-12$/)
  const nextId = rows[1].match(/%%beer id=([0-9a-f]{10}) src=QQ邮箱 article="内容库\/文章\/选题会"%%/)
  assert.ok(nextId, rows[1])
  assert.notEqual(nextId[1], 'meet')
  assert.doesNotMatch(rows[1], /reminder=/)
  assert.match(rows[1], /^- \[ \] 15:00–16:00 选题会 #会议 /)
  assert.match(rows[1], /🔁 every week on Thursday 📅 2026-11-19 ⏱ 1h$/)

  // 再完成新生成的那条：id 仍然唯一，不会撞上原来那条。
  const list = (await beer.api('GET', '/schedule')).body
  const fresh = list.items.find(item => item.id === nextId[1])
  await beer.api('POST', '/schedule/items/complete', { id: fresh.id, done: true, baseVersion: list.version })
  const after = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  const ids = after.map(row => row.match(/id=([0-9a-f]{10})/)?.[1]).filter(Boolean)
  assert.equal(new Set(ids).size, ids.length)
})

test('完成带邮件提醒的重复事项：新一条不带 remind / reminder，也不显示「提醒没建成」', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '15:00–16:00 选题会 %%beer id=meet2 src=对话 remind=default reminder=r-9%% '
          + '🔁 every week on Thursday 📅 2026-11-12 ⏱ 1h'),
      ),
    },
    now: NOW,
  })
  const before = (await beer.api('GET', '/schedule')).body

  await beer.api('POST', '/schedule/items/complete', { id: 'meet2', done: true, baseVersion: before.version })

  const rows = (await readFile(join(beer.vault, SCHEDULE), 'utf8')).split('\n').filter(Boolean)
  assert.match(rows[0], /remind=default reminder=r-9/)
  assert.doesNotMatch(rows[1], /remind=|reminder=/)
  assert.match(rows[1], /^- \[ \] 15:00–16:00 选题会 %%beer id=[0-9a-f]{10} src=对话%% /)

  // #51 生成下一条时不复制提醒；#56 的提醒同步也不在完成路径上，所以不报「提醒没建成」。
  const list = (await beer.api('GET', '/schedule')).body
  const fresh = list.items.find(item => item.title === '选题会')
  assert.equal(fresh.reminderLabel, null)
  assert.equal(fresh.reminderError, null)
})

test('新建日程：中文重复规则（每周日 / 每月 15 日 / 每月最后一天）写成 Tasks 写法，未知规则原样保留', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const created = await beer.api('POST', '/schedule/items', {
    title: '整理素材', due: '2026-11-15', recurrence: '每周日', source: '快速添加',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.item.recurrence, 'every week on Sunday')
  assert.equal(created.body.item.recurrenceLabel, '每周日')

  const monthly = await beer.api('POST', '/schedule/items', {
    title: '月度复盘', due: '2026-11-15', recurrence: '每月 15 日', source: '快速添加',
  })
  assert.equal(monthly.body.item.recurrence, 'every month on the 15th')

  const last = await beer.api('POST', '/schedule/items', {
    title: '月末结算', due: '2026-11-30', recurrence: '每月最后一天', source: '快速添加',
  })
  assert.equal(last.body.item.recurrence, 'every month on the last')

  const custom = await beer.api('POST', '/schedule/items', {
    title: '每两周', due: '2026-11-16', recurrence: '每两周一次', source: '快速添加',
  })
  assert.equal(custom.body.item.recurrence, '每两周一次')

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.match(content, /整理素材 .* 🔁 every week on Sunday 📅 2026-11-15/)
  assert.match(content, /月度复盘 .* 🔁 every month on the 15th 📅 2026-11-15/)
  assert.match(content, /月末结算 .* 🔁 every month on the last 📅 2026-11-30/)
  assert.match(content, /每两周 .* 🔁 每两周一次 📅 2026-11-16/)
})

test('列表中每条重复事项带 recurrenceLabel；未知规则显示原文', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        line(' ', '每天留言 %%beer id=a src=对话%% 🔁 every day 📅 2026-11-12'),
        line(' ', '每周日素材 %%beer id=b src=对话%% 🔁 every week on Sunday 📅 2026-11-15'),
        line(' ', '每月复盘 %%beer id=c src=对话%% 🔁 every month on the 15th 📅 2026-11-15'),
        line(' ', '自定义 %%beer id=d src=对话%% 🔁 every 2 weeks on Monday 📅 2026-11-16'),
      ),
    },
    now: NOW,
  })

  const list = (await beer.api('GET', '/schedule')).body
  const labels = Object.fromEntries(list.items.map(item => [item.id, item.recurrenceLabel]))
  assert.deepEqual(labels, {
    a: '每天',
    b: '每周日',
    c: '每月 15 日',
    d: 'every 2 weeks on Monday',
  })
})
