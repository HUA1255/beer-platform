// 日程邮件提醒同步（#56）：把一条日程的提醒偏好换算成云端提醒，并在日程行里记下提醒编号。
//
// 云端提醒服务（#44，见 cloud/reminder/README.md）只有 POST / GET / DELETE，没有修改接口：
// - 建日程：按偏好 POST 提醒（带 ref=日程编号），返回的编号写回 `%%beer reminder=...%%`；
// - 改日程：DELETE 旧编号（已经发出去 / 发失败的回 409，说明它已经不用管了，不算失败），再 POST 新提醒；
//   旧编号有硬失败时不 POST 新提醒，由调用方把旧编号留在日程行里，下次修改再试；
// - 删日程：DELETE 旧编号。
//
// 失败不回滚日程、不排队：调用方先把日程保存好，再调这里；错误作为 reminderError 返回，
// 面板在那条日程上显示「提醒没建成」，不写队列、不以后重试。
//
// 提醒偏好写在 `%%beer remind=...%%`（放在 Tasks 字段前面）：
//   remind=default  有具体时刻的事项默认：前一天 21:30 + 开始前 1 小时（#44 定的）
//   remind=30m      提前 30 分钟（只建一封）
//   remind=off      不提醒
// 已经过去的那封跳过（和 #44 一致）。日程时刻按本机墙钟，交给云端时写成 +08:00（和 #44 的北京时间一致）。
import { localDateTime } from '../dates.js'
import { HttpError } from '../http/router.js'
import { reminderJson } from './reminders.js'
import { WEEKDAY_NAMES } from './schedule-shared.js'

export const REMINDER_CREATE_FAILED = '提醒没建成'
export const REMINDER_UPDATE_FAILED = '提醒没改成'
export const REMINDER_CANCEL_FAILED = '提醒没取消'

/** 解析 / 校验提醒偏好；空值返回 null。default 和「提前 N 分钟」都要求有具体时刻。 */
export function normalizeRemind(value, { hasTime = false } = {}) {
  if (value == null || value === '') return null
  const text = String(value).trim().toLowerCase()
  if (text === 'default') {
    if (!hasTime) throw new HttpError(400, 'remind_invalid', '只有带具体时刻的日程才能用默认邮件提醒')
    return 'default'
  }
  if (text === 'off') return 'off'
  const match = /^(\d{1,4})m$/.exec(text)
  if (!match || Number(match[1]) <= 0) {
    throw new HttpError(400, 'remind_invalid', '邮件提醒要写成 default、off 或 30m（提前 N 分钟）')
  }
  if (!hasTime) throw new HttpError(400, 'remind_invalid', '只有带具体时刻的日程才能设「提前 N 分钟」提醒')
  return `${Number(match[1])}m`
}

/** 云端提醒编号列表：接受数组或 `r1,r2` 字符串。 */
export function normalizeReminderIds(value) {
  if (value == null || value === '') return []
  const entries = Array.isArray(value) ? value : String(value).split(',')
  const ids = []
  for (const entry of entries) {
    const id = String(entry ?? '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 一条日程实际的提醒偏好：没写 remind 时有具体时刻就按默认。 */
export function effectiveRemind(item) {
  if (item?.remind) return item.remind
  return item?.time ? 'default' : null
}

function offsetMinutes(pref) {
  const match = /^(\d{1,4})m$/.exec(String(pref ?? ''))
  return match ? Number(match[1]) : null
}

/** 30 分钟 / 2 小时。 */
export function humanRemindOffset(minutes) {
  if (minutes != null && minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

/** 日期 + 星期 + 时刻，给确认复述和提醒正文用。 */
function eventStart(item) {
  if (!item?.time) return null
  const day = item.scheduled ?? item.due
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = String(item.time).split(':').map(Number)
  if (![year, month, date, hour, minute].every(Number.isInteger)) return null
  return new Date(year, month - 1, date, hour, minute)
}

function defaultTimes(start) {
  return [
    { at: new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 21, 30), label: '前一天晚上' },
    { at: new Date(start.getTime() - 3600e3), label: '提前 1 小时' },
  ].sort((a, b) => a.at - b.at)
}

/**
 * 一条日程要建的提醒（已经过去的跳过）。没有具体时刻、没定哪天、off 都返回空数组。
 * @returns {Array<{ at: Date, label: string }>}
 */
export function reminderPlan(item, now) {
  const start = eventStart(item)
  const pref = effectiveRemind(item)
  if (!start || !pref || pref === 'off') return []
  let times
  if (pref === 'default') {
    times = defaultTimes(start)
  } else {
    const minutes = offsetMinutes(pref)
    if (minutes == null || minutes <= 0) return []
    times = [{ at: new Date(start.getTime() - minutes * 60000), label: `提前 ${humanRemindOffset(minutes)}` }]
  }
  return times.filter(entry => entry.at.getTime() > now.getTime())
}

/**
 * 列表小标签：默认取下一次提醒时刻；提前 N 分钟直接写 N；off / 没时刻不显示。
 * 只认行里明确写了的 remind 字段：手动写的旧行没有提醒偏好，不能凭空显示「提醒没建成」。
 */
export function reminderLabel(item, now) {
  const pref = item?.remind
  if (!item?.time || !pref || pref === 'off') return null
  if (pref === 'default') {
    const next = reminderPlan(item, now)[0]
    return next ? `${clock(next.at)} 邮件提醒` : null
  }
  const minutes = offsetMinutes(pref)
  return minutes ? `提前 ${humanRemindOffset(minutes)}` : null
}

/**
 * 待确认卡片（#55）用：服务端把「这次识别结果将来会建什么提醒」算成一句人话，
 * 客户端不再硬编码「提前 30 分钟 / 当天 9:00」。
 * - default：下一次默认提醒（前一天 21:30 / 开始前 1 小时）的时刻，如「21:30 邮件提醒」；
 * - 30m / 60m：`提前 30 分钟（13:30）`；
 * - off / 没有时刻 / 时间已过：null（不显示提醒一行）。
 */
export function pendingReminderLabel(item, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('pendingReminderLabel 需要传入 now（用 ctx.now()）')
  }
  if (!item?.time) return null
  const pref = effectiveRemind(item)
  if (!pref || pref === 'off') return null
  if (pref === 'default') {
    const next = reminderPlan(item, now)[0]
    return next ? `${clock(next.at)} 邮件提醒` : null
  }
  const minutes = offsetMinutes(pref)
  const start = eventStart(item)
  if (minutes == null || minutes <= 0 || !start) return null
  return `提前 ${humanRemindOffset(minutes)}（${clock(new Date(start.getTime() - minutes * 60000))}）`
}

/** 有提醒偏好、却少了云端编号（没建成 / 只建成一部分）时返回给面板的错误。 */
export function reminderError(item, now) {
  const pref = item?.remind
  if (!item?.time || !pref || pref === 'off') return null
  const expected = reminderPlan(item, now)
  if (!expected.length) return null
  const ids = normalizeReminderIds(item.reminderIds)
  return ids.length >= expected.length ? null : REMINDER_CREATE_FAILED
}

/** describeItem 用：一次算好标签和错误；没建成时只显示错误，不再显示提醒时刻。 */
export function describeReminder(item, now) {
  const error = reminderError(item, now)
  return { label: error ? null : reminderLabel(item, now), error }
}

/** 确认复述里的一句话；没有时刻 / 没偏好时返回 null。 */
export function remindSummary(item) {
  const pref = effectiveRemind(item)
  if (!item?.time || !pref) return null
  if (pref === 'off') return '不提醒'
  if (pref === 'default') return '邮件提醒：前一天 21:30 + 开始前 1 小时'
  const minutes = offsetMinutes(pref)
  return minutes ? `邮件提醒：提前 ${humanRemindOffset(minutes)}` : null
}

// ---- 云端调用 ----

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 云端要带时区：日程时刻按本机墙钟理解，写成 +08:00（和 #44 一致，都是北京时间）。 */
function dueAtText(date) {
  return localDateTime(date).replace(' ', 'T') + ':00+08:00'
}

function eventText(start) {
  return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日（${WEEKDAY_NAMES[start.getDay()]}）${clock(start)}`
}

function reminderBody(item, start) {
  const end = item.endTime ? `–${item.endTime}` : ''
  const location = typeof item.location === 'string' ? item.location.trim() : ''
  return `时间：${eventText(start)}${end}` + (location ? `\n地点：${location}` : '')
}

function failureText(prefix, error, built, total) {
  const done = built ? `（已建好 ${built} / ${total} 封）` : ''
  return `${prefix}：${error?.message ?? error}${done}（日程已保存，不会排队补建）`
}

async function postReminder(ctx, item, entry, start) {
  const response = await reminderJson(ctx, 'POST', '/reminders', {
    due_at: dueAtText(entry.at),
    title: item.title,
    body: reminderBody(item, start),
    source: 'beer',
    ref: item.id,
  })
  if (!response?.id) throw new HttpError(502, 'reminder_bad_response', '提醒服务没有返回提醒编号')
  return String(response.id)
}

/** 建日程后建提醒；返回已建编号和明确错误。部分失败时保留已经建好的编号。 */
export async function createItemReminders(ctx, item) {
  const start = eventStart(item)
  const plan = reminderPlan(item, ctx.now())
  const result = { ids: [], created: [], error: null }
  if (!start || !plan.length) return result
  for (const entry of plan) {
    try {
      const id = await postReminder(ctx, item, entry, start)
      result.ids.push(id)
      result.created.push({ id, due_at: entry.at.toISOString(), label: entry.label })
    } catch (error) {
      result.error = failureText(REMINDER_CREATE_FAILED, error, result.created.length, plan.length)
      break
    }
  }
  return result
}

/** 取消一组提醒；已经发出去 / 发失败（409）或已经不存在（404）都算完成，不挡日程写入。 */
async function deleteReminders(ctx, ids, prefix = REMINDER_CANCEL_FAILED) {
  const result = { cancelled: [], error: null }
  const failures = []
  for (const id of normalizeReminderIds(ids)) {
    try {
      await reminderJson(ctx, 'DELETE', '/reminders/' + encodeURIComponent(id))
      result.cancelled.push(id)
    } catch (error) {
      if (error?.status === 409 || error?.status === 404) {
        result.cancelled.push(id)
        continue
      }
      failures.push(`${id}：${error?.message ?? error}`)
    }
  }
  if (failures.length) {
    result.error = `${prefix}：${failures.join('；')}（日程已保存，不会排队补做）`
  }
  return result
}

/**
 * 改日程后同步提醒：先删旧提醒，再按新时间 / 偏好建新提醒。
 * 旧提醒有一封没删掉（不是 409 / 404）就不建新的，避免同一条日程出现重复提醒。
 */
export async function updateItemReminders(ctx, item, oldIds = []) {
  const cancelled = await deleteReminders(ctx, oldIds, REMINDER_UPDATE_FAILED)
  const result = { ids: [], created: [], cancelled: cancelled.cancelled, error: cancelled.error }
  if (cancelled.error) return result
  const start = eventStart(item)
  const plan = reminderPlan(item, ctx.now())
  if (!start || !plan.length) return result
  for (const entry of plan) {
    try {
      const id = await postReminder(ctx, item, entry, start)
      result.ids.push(id)
      result.created.push({ id, due_at: entry.at.toISOString(), label: entry.label })
    } catch (error) {
      result.error = failureText(REMINDER_UPDATE_FAILED, error, result.created.length, plan.length)
      break
    }
  }
  return result
}

/** 删日程后取消提醒；日程已经删掉，这里只回报错误，不回滚。 */
export async function cancelItemReminders(ctx, ids) {
  const result = await deleteReminders(ctx, ids)
  return { cancelled: result.cancelled, error: result.error }
}
