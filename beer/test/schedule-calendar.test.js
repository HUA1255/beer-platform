// 首页小月历（#52）：`calendarMonth(items, year, month, today)` 纯函数与 GET /schedule 接线。
// 只验证行为：周一开头、前后月补位、说明点（有时刻 / 只有截止日）、逾期红字、月份切换。
import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarMonth } from '../src/modules/schedule.js'
import { startBeer } from './helpers/beer.js'

/** 描述记录的最小形状：字段和 GET /schedule 的 items 一致。 */
function item(over = {}) {
  return {
    id: over.id ?? over.date ?? 'x',
    title: '某件事',
    done: false,
    time: null,
    due: null,
    scheduled: null,
    date: over.date ?? null,
    subtasks: [],
    ...over,
  }
}

function dayOf(calendar, date) {
  return calendar.days.find(day => day.date === date)
}

test('calendarMonth：周一开头，补齐前后月份，只有一天是今天', () => {
  const calendar = calendarMonth([], 2026, 11, '2026-11-12')

  assert.equal(calendar.year, 2026)
  assert.equal(calendar.month, 11)
  assert.equal(calendar.today, '2026-11-12')
  // 2026-11-01 是周日；周一开头要补 6 天（10-26 起），最后补到 12-06。
  assert.equal(calendar.days.length, 42)
  assert.equal(calendar.days[0].date, '2026-10-26')
  assert.equal(calendar.days[0].inMonth, false)
  assert.equal(calendar.days[6].date, '2026-11-01')
  assert.equal(calendar.days[6].inMonth, true)
  assert.equal(calendar.days[35].date, '2026-11-30')
  assert.equal(calendar.days[41].date, '2026-12-06')
  assert.equal(calendar.days.filter(day => day.inMonth).length, 30)
  assert.deepEqual(calendar.days.filter(day => day.today).map(day => day.date), ['2026-11-12'])
  // 每行第一格都是周一。
  for (let i = 0; i < calendar.days.length; i += 7) {
    const [year, month, day] = calendar.days[i].date.split('-').map(Number)
    assert.equal(new Date(year, month - 1, day).getDay(), 1)
  }
})

test('calendarMonth：二月跨年，闰年 29 天，今天不在这个月时没有高亮', () => {
  const february = calendarMonth([], 2026, 2, '2026-01-01')

  assert.equal(february.days[0].date, '2026-01-26')
  assert.equal(february.days.filter(day => day.inMonth).length, 28)
  assert.equal(february.days.at(-1).date, '2026-03-01')
  assert.deepEqual(february.days.filter(day => day.today), [])

  const leap = calendarMonth([], 2028, 2, '2028-02-10')

  assert.equal(leap.days.filter(day => day.inMonth).length, 29)
  assert.equal(dayOf(leap, '2028-02-29').inMonth, true)
  assert.deepEqual(leap.days.filter(day => day.today).map(day => day.date), ['2028-02-10'])
})

test('calendarMonth：有时刻是橘点，只有截止日是黄点，同一天可以两种都有', () => {
  const calendar = calendarMonth([
    item({ date: '2026-11-13', due: '2026-11-13', time: '14:00' }),
    item({ date: '2026-11-13', due: '2026-11-13' }),
    item({ date: '2026-11-15', due: '2026-11-15' }),
    item({ date: '2026-11-16', scheduled: '2026-11-16' }),
    item({ date: '2026-11-17', due: '2026-11-17', done: true }),
    item({ date: '2026-12-01', due: '2026-12-01' }),
  ], 2026, 11, '2026-11-12')

  const both = dayOf(calendar, '2026-11-13')
  assert.equal(both.event, true)
  assert.equal(both.due, true)
  assert.equal(both.overdue, false)

  const dueOnly = dayOf(calendar, '2026-11-15')
  assert.equal(dueOnly.event, false)
  assert.equal(dueOnly.due, true)

  // 只有计划日（⏳）没有截止日：月历上不画点。
  const plannedOnly = dayOf(calendar, '2026-11-16')
  assert.equal(plannedOnly.event, false)
  assert.equal(plannedOnly.due, false)

  // 已完成的事项不画点。
  const done = dayOf(calendar, '2026-11-17')
  assert.equal(done.event, false)
  assert.equal(done.due, false)

  // 前后月补位格子也是真实日期，有事项时照实显示（但仍标记为当月以外）。
  const nextMonth = dayOf(calendar, '2026-12-01')
  assert.equal(nextMonth.inMonth, false)
  assert.equal(nextMonth.due, true)
})

test('calendarMonth：截止日过了标红；有时刻的过期不标红；子步骤的逾期也算', () => {
  const calendar = calendarMonth([
    item({ date: '2026-11-10', due: '2026-11-10' }),
    item({ date: '2026-11-11', due: '2026-11-11', time: '09:00–10:00' }),
    item({ date: '2026-11-09', due: '2026-11-09', done: true }),
    item({
      date: null,
      subtasks: [item({ date: '2026-11-08', due: '2026-11-08' })],
    }),
    item({ date: null }),
  ], 2026, 11, '2026-11-12')

  const overdue = dayOf(calendar, '2026-11-10')
  assert.equal(overdue.overdue, true)
  assert.equal(overdue.due, true)

  const event = dayOf(calendar, '2026-11-11')
  assert.equal(event.event, true)
  assert.equal(event.overdue, false)

  const done = dayOf(calendar, '2026-11-09')
  assert.equal(done.overdue, false)
  assert.equal(done.due, false)

  assert.equal(dayOf(calendar, '2026-11-08').overdue, true)
})

test('calendarMonth：不修改传入的事项', () => {
  const items = [item({ date: '2026-11-13', due: '2026-11-13' })]
  const before = JSON.stringify(items)

  calendarMonth(items, 2026, 11, '2026-11-12')

  assert.equal(JSON.stringify(items), before)
})

test('GET /schedule：默认带当月 calendar，?month= 换月，非法 month 返回 400', async t => {
  const beer = await startBeer(t, {
    vault: {
      '日程.md': [
        '- [ ] 14:00–15:00 某公司一面 %%beer id=a1 src=对话%% 📅 2026-11-12',
        '- [ ] 交稿 %%beer id=b1 src=对话%% 📅 2026-11-13',
        '- [ ] 逾期的一条 %%beer id=c1 src=对话%% 📅 2026-11-10',
        '',
      ].join('\n'),
    },
    now: () => new Date('2026-11-12T10:00:00'),
  })

  const current = await beer.api('GET', '/schedule')

  assert.equal(current.status, 200)
  assert.equal(current.body.calendar.year, 2026)
  assert.equal(current.body.calendar.month, 11)
  assert.equal(current.body.calendar.today, '2026-11-12')
  assert.equal(dayOf(current.body.calendar, '2026-11-12').today, true)
  assert.equal(dayOf(current.body.calendar, '2026-11-12').event, true)
  assert.equal(dayOf(current.body.calendar, '2026-11-13').due, true)
  assert.equal(dayOf(current.body.calendar, '2026-11-10').overdue, true)

  const october = await beer.api('GET', '/schedule?month=2026-10')

  assert.equal(october.status, 200)
  assert.equal(october.body.calendar.year, 2026)
  assert.equal(october.body.calendar.month, 10)
  assert.equal(october.body.calendar.days.filter(day => day.today).length, 0)
  assert.equal(dayOf(october.body.calendar, '2026-10-01').inMonth, true)

  const bad = await beer.api('GET', '/schedule?month=2026-13')

  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'month_invalid')
})
