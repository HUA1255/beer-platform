// 日程：库根目录 `日程.md` 的解析、分组、勾选完成和删除（#49），
// 以及建 / 改 / 删时的邮件提醒同步（#56，云端调用在 schedule-reminders.js）。
//
//   GET  /api/beer/schedule[?month=YYYY-MM]
//        → { path, exists, version, modifiedAt, today, weekEnd, summary,
//            items, done, groups, calendar }
//        默认 calendar 是当月；?month= 换一个月，供首页小月历（#52）翻页。
//        calendar 由导出的纯函数 calendarMonth（周一开头、说明点、逾期标红）算出。
//   POST /api/beer/schedule/items/complete { id, done, baseVersion }
//        → { path, item, version, modifiedAt, merged, autoCompleted, generated }
//        这是完成的唯一入口；AI 工具也调用 completeItem，不再自己拼 - [x]。
//   POST /api/beer/schedule/items/delete   { id, baseVersion }
//        → { path, deleted, version, modifiedAt, merged, remindersCancelled?, reminderError? }
//   POST /api/beer/schedule/items          { title, due, scheduled, time, endTime, duration,
//                                            tags, source, location, recurrence, remind, reminderId,
//                                            articlePath, subtasks }
//        → 201 { path, item, version, modifiedAt, reminders?, reminderError? }
//   POST /api/beer/schedule/quick-add      { text }
//        → 201 { path, item, version, modifiedAt, reminders?, reminderError? }
//        把一句话里的日期 / 时刻 / 预估时长解析出来（「周五前交专栏稿」「做一期讲解视频，约 6 小时」），
//        标题去掉这些短语，来源固定「快速添加」。`计划明天…` 写成计划日 ⏳。
//        快速添加和普通新建走同一条 createItem → appendItem → syncCreatedReminders 链路（#56）。
//   POST /api/beer/schedule/items/schedule { id, scheduled, baseVersion }
//   POST /api/beer/schedule/items/unschedule { id, baseVersion }
//        设置 / 清除一条（含子步骤）的 ⏳ 计划日。
//   POST /api/beer/schedule/items/subtasks { parentId, title, duration?, scheduled?, ... }
//        → 201 { path, item, parent, version, modifiedAt }
//   POST /api/beer/schedule/items/subtasks/update { id, changes, baseVersion }
//   POST /api/beer/schedule/items/subtasks/delete { id, baseVersion }
//        子步骤的增 / 改 / 删；子步骤和父事项共用同一个日程文件。
//   勾选子步骤时（complete）若父事项的所有子步骤都已完成，自动完成父事项；
//   重复子步骤的下一条先生成，再判断父事项（生成的那条不算进本次父事项判断）；
//   读取文件时不做这个推断（在 Obsidian 里手勾的不算）。
//
// 文件格式沿用 Obsidian Tasks 写法，一行一条：
//   - [ ] 14:00–15:00 某公司一面（腾讯会议 123-456） #面试 %%beer id=a1 src=对话 remind=default reminder=r1,r2%% 📅 2026-11-18
//   - [ ] 交《效率工具》专栏稿 %%beer id=b2 src=快速添加%% 📅 2026-11-13
//   - [x] 09:00 看昨天的读者留言 %%beer id=c3 src=对话%% 📅 2026-11-12 ✅ 2026-11-12
//
// 约定：
// - `%%beer ...%%` 是 Beer 自用字段（id / 来源 / 地点 / 提醒偏好 / 提醒编号 / 关联文章），放在 Tasks 字段前面，
//   因为 Tasks 插件从行尾往前认字段。Beer 只改自己认识的字段，其他字段原样保留。
// - 日程总是先保存成功，再去云端建 / 删提醒；云端失败只回 reminderError，不回滚、不排队。
// - 读不懂的行（不是 `- [ ]` / `- [x]`）原样留在文件里，任何写操作只改目标行和它的缩进子步骤。
// - 写入沿用 library.saveNote 的版本检查；版本对不上时重新读、按行合并（按 id 找到目标行再改），
//   连续几次都合并不了才回 409 schedule_merge_conflict，绝不直接覆盖。
// - 有具体时刻的事项是「event」：过了结束时间变灰（past）、不算逾期、不需要勾选。
// - 状态、分组、逾期和「还有 N 分钟」都按本机时区算。
import { createHash, randomBytes } from 'node:crypto'
import { HttpError, reply } from '../http/router.js'
import { createNote, readNote, saveNote } from './library.js'
import { localDate } from '../dates.js'
import {
  GROUP_LABELS,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  flattenItems,
} from './schedule-shared.js'
import {
  cancelItemReminders,
  createItemReminders,
  describeReminder,
  normalizeRemind,
  normalizeReminderIds,
  updateItemReminders,
} from './schedule-reminders.js'

export const SCHEDULE_PATH = '日程.md'

// 注意：这些 emoji 都是代理对，不能放进字符类（[...] 只会匹配半个代理对）。
const TASK_MARKERS = ['📅', '⏳', '✅', '🔁', '⏱', '➕', '🛫', '⏫', '🔼', '🔽', '⏬', '❌', '🏁', '⏰']
const MARKER_RE = new RegExp(`(${TASK_MARKERS.join('|')})\\s*`, 'gu')
const FIRST_MARKER_RE = new RegExp(TASK_MARKERS.join('|'), 'u')
const FIELD_BY_MARKER = {
  '📅': 'due',
  '⏳': 'scheduled',
  '✅': 'completed',
  '🔁': 'recurrence',
  '⏱': 'duration',
}
const MARKER_BY_FIELD = {
  due: '📅',
  scheduled: '⏳',
  completed: '✅',
  recurrence: '🔁',
  duration: '⏱',
}
const FIELD_ORDER = ['recurrence', 'due', 'scheduled', 'duration', 'completed']
const DONE_LIMIT = 100
const MERGE_ATTEMPTS = 3
const DEFAULT_EVENT_MINUTES = 60
const SOON_MINUTES = 120

// 🔁 重复规则（#51）：只认 Tasks 的每天 / 每周某天 / 每月某日（含最后一天）。
// 其他写法（比如 every 2 weeks）原样保留、不生成下一条，绝不改写或丢掉。
const WEEKDAY_BY_NAME = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAY_ZH_INPUT = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

export function register(router, ctx) {
  router.get('/schedule', async req => readScheduleView(ctx, req.query.get('month')))
  router.post('/schedule/items/complete', async req => {
    const body = (await req.json()) ?? {}
    return completeItem(ctx, body.id, body.done, body.baseVersion)
  })
  router.post('/schedule/items/delete', async req => {
    const body = (await req.json()) ?? {}
    return deleteItem(ctx, body.id, body.baseVersion)
  })
  router.post('/schedule/items', async req => {
    const body = (await req.json()) ?? {}
    return reply(201, await createItem(ctx, body))
  })
  router.post('/schedule/quick-add', async req => {
    const body = (await req.json()) ?? {}
    return reply(201, await quickAddItem(ctx, body))
  })
  router.post('/schedule/items/schedule', async req => {
    const body = (await req.json()) ?? {}
    return setScheduled(ctx, body.id, body.scheduled, body.baseVersion)
  })
  router.post('/schedule/items/unschedule', async req => {
    const body = (await req.json()) ?? {}
    return setScheduled(ctx, body.id, null, body.baseVersion)
  })
  router.post('/schedule/items/subtasks', async req => {
    const body = (await req.json()) ?? {}
    return reply(201, await addSubtask(ctx, body))
  })
  router.post('/schedule/items/subtasks/update', async req => {
    const body = (await req.json()) ?? {}
    return updateSubtask(ctx, body.id, body.changes, body.baseVersion)
  })
  router.post('/schedule/items/subtasks/delete', async req => {
    const body = (await req.json()) ?? {}
    return deleteSubtask(ctx, body.id, body.baseVersion)
  })
}

// ---- 读与视图 ----

/** 首页只需要数字，不解析全部记录时也走这里，保证两处口径一致。 */
export async function scheduleSummary(ctx) {
  const file = await loadSchedule(ctx)
  return {
    path: SCHEDULE_PATH,
    exists: file.exists,
    summary: file.summary,
  }
}

async function readScheduleView(ctx, monthQuery) {
  const file = await loadSchedule(ctx)
  const month = calendarMonthTarget(monthQuery, file.today)
  return {
    path: SCHEDULE_PATH,
    exists: file.exists,
    version: file.exists ? file.version : null,
    modifiedAt: file.exists ? file.modifiedAt : null,
    today: file.today,
    weekEnd: file.weekEnd,
    summary: file.summary,
    items: file.items,
    done: file.done,
    groups: file.groups,
    calendar: calendarMonth(file.items, month.year, month.month, file.today),
  }
}

/**
 * 读并解析 `日程.md`。文件不存在返回空日程（exists:false），不建文件。
 * 返回的 items / done 都已经是接口要展示的记录（不含内部 raw 行细节，但带 lineIndex/id）。
 */
export async function loadSchedule(ctx, now = ctx.now()) {
  let note
  try {
    note = await readNote(ctx, SCHEDULE_PATH)
  } catch (e) {
    if (e?.code === 'not_found') {
      const empty = parseSchedule('')
      const view = buildView(empty, now)
      return { path: SCHEDULE_PATH, exists: false, content: null, version: null, modifiedAt: null, ...view }
    }
    throw e
  }
  const parsed = parseSchedule(note.content)
  return {
    path: SCHEDULE_PATH,
    exists: true,
    content: note.content,
    version: note.version,
    modifiedAt: note.modifiedAt,
    ...buildView(parsed, now),
  }
}

function buildView(parsed, now) {
  const today = localDate(now)
  const weekEnd = localDate(sundayOf(now))
  const clock = { now, today, weekEnd }
  const active = []
  const entries = []
  const done = []
  for (const item of parsed.items) {
    const rec = describeItem(item, clock)
    if (rec.done) {
      done.push(rec)
      continue
    }
    active.push(rec)
    entries.push(rec)
    // 子步骤排了计划日 / 截止日时单独出现在对应分组（父事项仍显示进度）；
    // 没排期的子步骤只在父事项下面显示，不单独占一条。
    collectDatedSubtasks(item, clock, entries)
  }
  active.sort(compareItems)
  entries.sort(compareItems)
  done.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || compareItems(a, b))

  const groups = ['overdue', 'today', 'week', 'later', 'unscheduled'].map(key => ({
    key,
    label: GROUP_LABELS[key],
    count: 0,
    items: [],
  }))
  const byKey = Object.fromEntries(groups.map(group => [group.key, group]))
  for (const item of entries) {
    byKey[item.group].items.push(item)
    byKey[item.group].count++
  }
  for (const group of groups) group.items.sort(compareItems)

  // 「没排期」组名旁的总预估时长：只算顶层事项的 ⏱；顶层没写时退回它的子步骤合计，
  // 避免拆过步骤的事显示「共约 0 小时」而把父子时长重复相加。
  const unscheduled = byKey.unscheduled
  unscheduled.totalMinutes = unscheduled.items.reduce((sum, item) => sum + estimateMinutesOf(item), 0)
  unscheduled.subtitle = unscheduled.totalMinutes > 0
    ? `想做、但没定哪天 · 共约 ${humanMinutes(unscheduled.totalMinutes)}`
    : '想做、但没定哪天'

  const summary = {
    today: byKey.today.count,
    overdue: entries.filter(item => item.overdue).length,
    dueThisWeek: entries.filter(item => item.due && item.due > today && item.due <= weekEnd).length,
    unscheduled: unscheduled.count,
  }
  return { today, weekEnd, summary, items: active, entries, done: done.slice(0, DONE_LIMIT), groups }
}

/** 收集排了计划日 / 截止日的未完成子步骤（含更深层的子步骤），放进分组列表。 */
function collectDatedSubtasks(item, clock, out) {
  for (let index = 0; index < item.subtasks.length; index++) {
    const child = item.subtasks[index]
    if (child.done) continue
    if (child.scheduled || child.due) {
      out.push(describeItem(child, clock, { parent: item, index, count: item.subtasks.length }))
    }
    collectDatedSubtasks(child, clock, out)
  }
}

function estimateMinutesOf(item) {
  if (item.durationMinutes != null) return item.durationMinutes
  return (item.subtasks ?? []).reduce((sum, child) => sum + (child.durationMinutes ?? 0), 0)
}

// ---- 月历（#52） ----

/**
 * 月历网格，纯函数，客户端只负责渲染。items 用 GET /schedule 的 items 形状；
 * 子步骤递归计入，已完成的事项不画点。
 *
 * 返回 { year, month, today, days }，days 按周一开头、补齐整周（4-6 行）：
 *   { date, day, inMonth, today, event, due, overdue }
 * 每个日期只看它自己的标记，不再把一个事项的所有标记都堆到同一个日期：
 * - event：这天是带具体时刻事项的事件 / 计划日（`date` = scheduled ?? due）→ 橘点；
 * - due：这天是任一事项的截止日（`due`）→ 黄点，即使它同时有具体时刻或另有计划日；
 * - overdue：这天是截止日、已过且未完成（有具体时刻的 event 只变灰，不算逾期）→ 红字；
 * - 只有计划日（⏳）、没有截止日的事项不画黄点。
 * - 前后月补位格也带真实日期和说明点，但 inMonth 为 false。
 */
export function calendarMonth(items, year, month, today) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('calendarMonth 需要真实的年份和 1-12 的月份')
  }
  const todayText = today instanceof Date ? localDate(today) : today == null ? '' : String(today)

  const marks = new Map()
  const markAt = date => {
    let mark = marks.get(date)
    if (!mark) {
      mark = { event: false, due: false, overdue: false }
      marks.set(date, mark)
    }
    return mark
  }
  eachItem(items, item => {
    if (item.done) return
    // 有时刻的事项在事件 / 计划日画橘点（原来的「事件日」口径）。
    const eventDate = item.date ?? item.scheduled ?? item.due
    if (item.time && eventDate) markAt(eventDate).event = true
    // 截止日单独画黄点，不管它是不是同时有时刻或计划日。
    if (item.due) {
      const mark = markAt(item.due)
      mark.due = true
      if (isOverdueItem(item, todayText)) mark.overdue = true
    }
  })

  const first = new Date(year, month - 1, 1)
  const leading = (first.getDay() + 6) % 7 // 周一 = 0
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7
  const days = []
  for (let i = 0; i < cells; i++) {
    const cell = new Date(year, month - 1, i - leading + 1)
    const date = `${cell.getFullYear()}-${pad(cell.getMonth() + 1)}-${pad(cell.getDate())}`
    const mark = marks.get(date) ?? EMPTY_MARK
    days.push({
      date,
      day: cell.getDate(),
      inMonth: cell.getFullYear() === year && cell.getMonth() === month - 1,
      today: date === todayText,
      event: mark.event,
      due: mark.due,
      overdue: mark.overdue,
    })
  }
  return { year, month, today: todayText, days }
}

const EMPTY_MARK = { event: false, due: false, overdue: false }

function eachItem(items, visit) {
  for (const item of items ?? []) {
    if (!item) continue
    visit(item)
    eachItem(item.subtasks, visit)
  }
}

/** 只有截止日过了才算逾期；有具体时刻的 event 过了时间只是变灰。 */
function isOverdueItem(item, today) {
  return !item.done && !item.time && Boolean(item.due) && item.due < today
}

/** ?month=YYYY-MM；没给时用今天所在的月份。 */
function calendarMonthTarget(monthQuery, today) {
  if (monthQuery == null || monthQuery === '') {
    const [year, month] = today.split('-').map(Number)
    return { year, month }
  }
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthQuery))
  const year = match ? Number(match[1]) : NaN
  const month = match ? Number(match[2]) : NaN
  if (!match || year < 1970 || year > 9999 || month < 1 || month > 12) {
    throw new HttpError(400, 'month_invalid', 'month 要写成 YYYY-MM，比如 2026-11')
  }
  return { year, month }
}

// ---- 解析 ----

/**
 * 把整份文件拆成顶层事项 + 未知行。eol / lines 保留原始换行，写回时只替换目标行。
 * 结构供后续工单复用：标准事项记录见 parseItem；子步骤在 item.subtasks 里。
 */
export function parseSchedule(content) {
  const source = String(content ?? '')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const items = []
  const unknownLines = []
  const stack = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex]
    const item = parseItem(raw, lineIndex)
    if (!item) {
      if (!raw.trim()) {
        stack.length = 0
        continue
      }
      const indent = (/^[ \t]*/.exec(raw) ?? [''])[0].length
      if (stack.length && indent > stack[stack.length - 1].indent) {
        // 缩进的说明 / 注释挂在最近的事项上，但删除父项时一并删掉。
        stack[stack.length - 1].unknownLines.push({ lineIndex, raw })
      } else {
        unknownLines.push({ lineIndex, raw })
      }
      continue
    }

    while (stack.length && stack[stack.length - 1].indent >= item.indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) {
      item.parentId = parent.id
      parent.subtasks.push(item)
    } else {
      items.push(item)
    }
    stack.push(item)
  }

  return { content: source, eol, lines, items, unknownLines }
}

/**
 * 解析一行；不是 `- [ ]` / `- [x]` 事项时返回 null。
 * 记录形状（#50-#56 在此基础上加字段，不重写解析）：
 * { id, title, done, completedAt, due, scheduled, time, endTime, duration, durationMinutes,
 *   tags, source, recurrence, reminderId, articlePath, parentId, indent, lineIndex,
 *   raw, rawLines, unknownLines, subtasks, beerFields, fields, timeSeparator, explicitEnd }
 */
export function parseItem(raw, lineIndex = 0) {
  const line = String(raw ?? '')
  const match = /^([ \t]*)- \[([ xX])\](?:[ \t]+(.*))?$/.exec(line)
  if (!match) return null
  const indentText = match[1]
  const body = (match[3] ?? '').trimEnd()

  let rest = body
  const beerFields = []
  const beerMatch = /%%beer\b\s*([\s\S]*?)%%/.exec(rest)
  if (beerMatch) {
    beerFields.push(...parseBeerFields(beerMatch[1]))
    rest = (rest.slice(0, beerMatch.index) + ' ' + rest.slice(beerMatch.index + beerMatch[0].length)).trim()
  }

  const firstMarker = FIRST_MARKER_RE.exec(rest)
  const description = firstMarker ? rest.slice(0, firstMarker.index).trimEnd() : rest
  const fields = firstMarker ? parseFields(rest.slice(firstMarker.index)) : []

  let descriptionRest = description
  let time = null
  let endTime = null
  let timeSeparator = '–'
  let explicitEnd = false
  const timeMatch = /^(\d{1,2}):(\d{2})(?:\s*([–—~-])\s*(\d{1,2}):(\d{2}))?(?=\s|$)/.exec(descriptionRest)
  if (timeMatch && validClock(timeMatch[1], timeMatch[2])) {
    time = `${pad(timeMatch[1])}:${timeMatch[2]}`
    if (timeMatch[4]) {
      if (validClock(timeMatch[4], timeMatch[5])) {
        endTime = `${pad(timeMatch[4])}:${timeMatch[5]}`
        timeSeparator = timeMatch[3]
        explicitEnd = true
      }
    }
    descriptionRest = descriptionRest.slice(timeMatch[0].length).trimStart()
  }

  const tags = []
  descriptionRest = descriptionRest.replace(/(?:^|\s)#([^\s#]+)/g, (whole, tag) => {
    tags.push(tag)
    return ''
  }).trim()

  const duration = parseFieldsValue(fields, 'duration')
  const durationMinutes = durationMinutesOf(duration)
  const record = {
    id: '',
    title: descriptionRest,
    done: match[2].toLowerCase() === 'x',
    completedAt: null,
    due: null,
    scheduled: null,
    time,
    // 只写开始时刻时不在行里补结束时间；展示 / 判断「过了没有」时按预估时长或默认 1 小时算。
    endTime: endTime ?? (time && durationMinutes != null ? addMinutesToClock(time, durationMinutes) : null),
    explicitEnd,
    timeSeparator,
    duration,
    durationMinutes,
    tags,
    source: null,
    location: null,
    recurrence: parseFieldsValue(fields, 'recurrence'),
    remind: null,
    reminderIds: [],
    reminderId: null,
    articlePath: null,
    parentId: null,
    indent: indentText.length,
    indentText,
    lineIndex,
    raw: line,
    rawLines: [line],
    unknownLines: [],
    subtasks: [],
    beerFields,
    fields,
  }

  for (const field of beerFields) {
    if (field.key === 'id') record.id = field.value
    else if (field.key === 'src') record.source = field.value
    else if (field.key === 'loc') record.location = decodeBeerText(field.value)
    else if (field.key === 'remind') record.remind = field.value
    else if (field.key === 'reminder') {
      record.reminderIds = normalizeReminderIds(field.value)
      record.reminderId = record.reminderIds.join(',') || null
    } else if (field.key === 'article') record.articlePath = field.value
  }
  // 手动写的行没有 Beer id：给一个只在这一行内容不变时稳定的临时 id。
  if (!record.id) record.id = syntheticId(line)

  for (const field of fields) {
    if (!field.valid) continue
    if (field.key === 'due') record.due = field.value
    else if (field.key === 'scheduled') record.scheduled = field.value
    else if (field.key === 'completed') record.completedAt = field.value
  }
  if (record.done && !record.completedAt) record.completedAt = null
  return record
}

function parseFields(text) {
  const fields = []
  const matches = [...text.matchAll(MARKER_RE)]
  for (let i = 0; i < matches.length; i++) {
    const marker = matches[i][1]
    const start = matches[i].index
    const valueStart = start + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const raw = text.slice(start, end).trimEnd()
    const value = text.slice(valueStart, end).trim()
    const key = FIELD_BY_MARKER[marker] ?? null
    fields.push(describeField(marker, key, value, raw))
  }
  return fields
}

function describeField(marker, key, value, raw) {
  if (!key) return { marker, key: null, value, raw, valid: false }
  if (key === 'recurrence') return { marker, key, value, raw, valid: value !== '', parsed: value }
  if (key === 'duration') return { marker, key, value, raw, valid: durationMinutesOf(value) != null, parsed: value }
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (!date) return { marker, key, value, raw, valid: false }
  return { marker, key, value: date[1], raw, valid: true, parsed: date[1] }
}

function parseBeerFields(text) {
  const fields = []
  const re = /([A-Za-z][\w-]*)=("([^"]*)"|(\S+))/g
  for (const match of text.matchAll(re)) {
    const value = match[3] !== undefined ? match[3].replaceAll('\\"', '"') : match[4]
    fields.push({ key: match[1], value, quoted: match[3] !== undefined })
  }
  return fields
}

function parseFieldsValue(fields, key) {
  const field = fields.find(item => item.key === key && item.valid)
  return field ? field.parsed : null
}

// ---- 重复规则（#51） ----

/**
 * 解析 `🔁` 后面的重复规则。除 Tasks 的英文写法外，也接受新建时用户说的中文
 * （每周日 / 每月 15 日 / 每月最后一天），统一给出 Tasks 写法的 canonical。
 * 返回 null 表示没有规则；读不懂的非空规则返回 { kind: 'unknown', supported: false }，
 * 调用方要原样保留文本、不要生成下一条。
 *
 * 规则形状：
 *   { kind: 'day'|'week'|'month'|'unknown', supported, text, canonical,
 *     weekday?, day?, last? }
 */
export function parseRecurrence(text) {
  if (text && typeof text === 'object') return text.kind ? text : null
  const original = String(text ?? '').trim()
  if (!original) return null
  // 匹配时忽略多余空白；未知规则返回原文本，保持逐字不变。
  const trimmed = original.replace(/\s+/g, ' ')

  if (/^every day$/i.test(trimmed)) return knownRecurrence('day', original, 'every day')

  const week = /^every week on ([a-z]+)$/i.exec(trimmed)
  if (week) {
    const weekday = WEEKDAY_BY_NAME[week[1].toLowerCase()]
    if (weekday == null) return unknownRecurrence(original)
    return knownRecurrence('week', original, `every week on ${WEEKDAY_EN[weekday]}`, { weekday })
  }

  const month = /^every month on (?:the )?(\d{1,2})(?:st|nd|rd|th)?$/i.exec(trimmed)
  if (month) {
    const day = Number(month[1])
    if (!Number.isInteger(day) || day < 1 || day > 31) return unknownRecurrence(original)
    return knownRecurrence('month', original, `every month on the ${ordinal(day)}`, { day })
  }

  if (/^every month on (?:the )?last(?: day)?$/i.test(trimmed)) {
    return knownRecurrence('month', original, 'every month on the last', { last: true })
  }

  if (/^(?:每天|每日)$/.test(trimmed)) return knownRecurrence('day', original, 'every day')

  const zhWeek = /^(?:每)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(trimmed)
  if (zhWeek) {
    const weekday = WEEKDAY_ZH_INPUT[zhWeek[1]]
    return knownRecurrence('week', original, `every week on ${WEEKDAY_EN[weekday]}`, { weekday })
  }

  const zhMonth = /^每(?:个)?月(?:的)?\s*(\d{1,2})\s*(?:日|号)$/.exec(trimmed)
  if (zhMonth) {
    const day = Number(zhMonth[1])
    if (!Number.isInteger(day) || day < 1 || day > 31) return unknownRecurrence(original)
    return knownRecurrence('month', original, `every month on the ${ordinal(day)}`, { day })
  }

  if (/^每(?:个)?月(?:的)?\s*最后一天$/.test(trimmed)) {
    return knownRecurrence('month', original, 'every month on the last', { last: true })
  }

  return unknownRecurrence(original)
}

function knownRecurrence(kind, text, canonical, extra = {}) {
  return { kind, supported: true, text, canonical, ...extra }
}

function unknownRecurrence(text) {
  return { kind: 'unknown', supported: false, text, canonical: text }
}

/** 列表里的小标签：#55/#56 和客户端共用同一套中文，未知规则显示原文。 */
export function recurrenceLabel(rule) {
  const parsed = typeof rule === 'string' ? parseRecurrence(rule) : rule
  if (!parsed) return ''
  if (!parsed.supported) return parsed.text
  if (parsed.kind === 'day') return '每天'
  if (parsed.kind === 'week') return '每周' + WEEKDAY_SHORT[parsed.weekday]
  if (parsed.day != null) return `每月 ${parsed.day} 日`
  if (parsed.last) return '每月最后一天'
  return parsed.text
}

/**
 * 从 `date`（YYYY-MM-DD）算下一次同类日期：
 * - 每天：+1 天；
 * - 每周某天：之后的第一个该星期几（到期日正好是那天时 +7 天）；
 * - 每月某日：之后的第一个该日；短月夹到当月最后一天，下个月仍按规则里的日回补
 *   （例如 1 月 31 日 → 2 月 28 日 → 3 月 31 日）；
 * - 每月最后一天：之后那个月的最后一天。
 * 规则读不懂、日期非法时返回 null。
 */
export function nextOccurrence(rule, date) {
  const parsed = typeof rule === 'string' ? parseRecurrence(rule) : rule
  if (!parsed || !parsed.supported) return null
  const start = parseDateText(date)
  if (!start) return null

  if (parsed.kind === 'day') return localDate(addDays(start, 1))

  if (parsed.kind === 'week') {
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    do next.setDate(next.getDate() + 1)
    while (next.getDay() !== parsed.weekday)
    return localDate(next)
  }

  if (parsed.kind === 'month') {
    let year = start.getFullYear()
    let month = start.getMonth()
    for (;;) {
      const monthDays = daysInMonth(year, month)
      const day = parsed.last ? monthDays : Math.min(parsed.day, monthDays)
      const candidate = new Date(year, month, day)
      if (candidate.getTime() > start.getTime()) return localDate(candidate)
      month++
      if (month > 11) {
        month = 0
        year++
      }
    }
  }

  return null
}

function ordinal(value) {
  const mod100 = value % 100
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`
  if (value % 10 === 1) return `${value}st`
  if (value % 10 === 2) return `${value}nd`
  if (value % 10 === 3) return `${value}rd`
  return `${value}th`
}

function syntheticId(raw) {
  return 'auto-' + createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

// ---- 序列化 ----

/** 把一条记录写回一行（缩进保留，子步骤不在这里处理）。 */
export function serializeItem(item) {
  const box = item.done ? 'x' : ' '
  const parts = []
  if (item.time) {
    const end = item.explicitEnd && item.endTime ? `${item.timeSeparator ?? '–'}${item.endTime}` : ''
    parts.push(item.time + end)
  }
  if (item.title) parts.push(item.title)
  for (const tag of item.tags ?? []) parts.push('#' + tag)

  const beer = serializeBeerFields(item)
  if (beer) parts.push(beer)

  const fields = serializeFields(item)
  if (fields) parts.push(fields)
  return `${item.indentText ?? ''}- [${box}]${parts.length ? ' ' + parts.join(' ') : ''}`
}

const BEER_FIELD_ORDER = ['id', 'src', 'loc', 'remind', 'reminder', 'article']

/**
 * 已有的字段保持原顺序，只替换 Beer 认识的值；新出现的字段按 `id src loc remind reminder article`
 * 追加在注释块末尾，未知的 `key=value` 原样保留。整个块仍然放在 Tasks 字段前面。
 * `loc` 的值统一 percent-encode（decode 在读取时做），所以不需要再加引号。
 */
function serializeBeerFields(item) {
  const ids = normalizeReminderIds(item.reminderIds ?? item.reminderId)
  const values = {
    id: item.id && !item.id.startsWith('auto-') ? item.id : null,
    src: item.source,
    loc: item.location ? encodeBeerText(item.location) : null,
    remind: item.remind,
    reminder: ids.length ? ids.join(',') : null,
    article: item.articlePath,
  }
  const parts = []
  const emitted = new Set()
  for (const field of item.beerFields ?? []) {
    if (BEER_FIELD_ORDER.includes(field.key)) {
      emitted.add(field.key)
      const value = values[field.key]
      if (value == null || value === '') continue
      parts.push(beerFieldText(field.key, value, field.quoted))
    } else {
      parts.push(`${field.key}=${quoteBeerValue(field.value, field.quoted)}`)
    }
  }
  for (const key of BEER_FIELD_ORDER) {
    if (emitted.has(key)) continue
    const value = values[key]
    if (value == null || value === '') continue
    parts.push(beerFieldText(key, value, needsBeerQuote(value)))
  }
  return parts.length ? `%%beer ${parts.join(' ')}%%` : ''
}

function beerFieldText(key, value, quoted) {
  if (key === 'loc') return `loc=${value}`
  return `${key}=${quoteBeerValue(value, quoted)}`
}

function encodeBeerText(value) {
  return encodeURIComponent(String(value))
}

function decodeBeerText(value) {
  try {
    return decodeURIComponent(String(value))
  } catch {
    return String(value)
  }
}

function quoteBeerValue(value, wasQuoted) {
  const text = String(value)
  return wasQuoted || /[\s"%]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text
}

function serializeFields(item) {
  const emitted = new Set()
  const parts = []
  for (const field of item.fields ?? []) {
    if (!field.key || !field.valid) {
      if (field.raw) parts.push(field.raw)
      continue
    }
    const value = currentFieldValue(item, field.key)
    if (value == null) continue // 被取消的字段（比如取消完成时的 ✅）整段去掉
    emitted.add(field.key)
    if (field.valid && field.parsed === value && field.raw) parts.push(field.raw)
    else parts.push(`${field.marker} ${value}`)
  }
  for (const key of FIELD_ORDER) {
    const value = currentFieldValue(item, key)
    if (value == null || emitted.has(key)) continue
    parts.push(`${MARKER_BY_FIELD[key]} ${value}`)
  }
  return parts.join(' ')
}

function currentFieldValue(item, key) {
  if (key === 'due') return item.due ?? null
  if (key === 'scheduled') return item.scheduled ?? null
  if (key === 'completed') return item.done ? (item.completedAt ?? null) : null
  if (key === 'recurrence') return item.recurrence ?? null
  if (key === 'duration') return item.duration ?? null
  return null
}

/** 新建一条：固定 id / 来源 / 提醒偏好在最前，Beer 字段放在所有 Tasks 字段之前。 */
export function newItemContent(item) {
  return serializeItem({
    indentText: '',
    done: false,
    timeSeparator: '–',
    explicitEnd: Boolean(item.time && item.endTime),
    tags: [],
    beerFields: [],
    fields: [],
    ...item,
    beerFields: [],
  })
}

function needsBeerQuote(value) {
  return /[\s"%]/.test(String(value))
}

// ---- 描述记录（接口 / 首页用） ----

function describeItem(item, { now, today, weekEnd }, context = null) {
  const event = Boolean(item.time)
  const { start, end } = eventTimes(item)
  const past = event && end != null && end.getTime() < now.getTime()
  const overdue = isOverdueItem(item, today)
  const group = item.done ? null : groupOf(item, { today, weekEnd, event, past })
  const startsInMinutes = event && !past && start && start.getTime() > now.getTime()
    ? Math.ceil((start.getTime() - now.getTime()) / 60000)
    : null
  const when = whenOf(item, { today, weekEnd, overdue, event })
  const reminder = describeReminder(item, now)
  // 同时有计划日和截止日时，左边写「计划今天」，截止日另外给一个标签；
  // 截止日过了照常算逾期（overdue 仍然按 due 算）。
  const deadline = item.scheduled && item.due
    ? { label: dueLabel(item.due, { today, weekEnd }), overdue }
    : null
  return {
    id: item.id,
    kind: event ? 'event' : 'task',
    title: item.title,
    done: item.done,
    completedAt: item.completedAt,
    due: item.due,
    scheduled: item.scheduled,
    date: item.scheduled ?? item.due,
    time: item.time,
    endTime: item.endTime,
    duration: item.duration,
    durationMinutes: item.durationMinutes,
    tags: item.tags,
    source: item.source,
    location: item.location ?? null,
    recurrence: item.recurrence,
    recurrenceLabel: item.recurrence ? recurrenceLabel(item.recurrence) : null,
    remind: item.remind,
    reminderIds: [...(item.reminderIds ?? [])],
    reminderId: item.reminderId,
    reminderLabel: reminder.label,
    reminderError: reminder.error,
    articlePath: item.articlePath,
    parentId: item.parentId,
    parentTitle: context?.parent?.title ?? null,
    stepIndex: context ? context.index + 1 : null,
    stepCount: context?.count ?? null,
    lineIndex: item.lineIndex,
    group,
    overdue,
    past,
    gray: past,
    startsInMinutes: startsInMinutes != null && startsInMinutes <= SOON_MINUTES ? startsInMinutes : null,
    when,
    deadline,
    subtaskCount: item.subtasks.length,
    subtaskDone: item.subtasks.filter(child => child.done).length,
    subtasks: item.subtasks.map((child, index) => describeItem(child, { now, today, weekEnd }, {
      parent: item,
      index,
      count: item.subtasks.length,
    })),
  }
}

function groupOf(item, { today, weekEnd, event, past }) {
  const planned = item.scheduled ?? item.due
  if (!planned) return 'unscheduled'
  // 有具体时刻的事：过去的不算逾期，留在「今天」最下面变灰。
  if (event && past) return 'today'
  if (item.scheduled) {
    if (item.scheduled <= today) return 'today' // 计划日过了没做完，仍在「今天」，不算逾期
    return item.scheduled <= weekEnd ? 'week' : 'later'
  }
  if (item.due < today) return event ? 'today' : 'overdue'
  if (item.due === today) return 'today'
  return item.due <= weekEnd ? 'week' : 'later'
}

function whenOf(item, { today, weekEnd, overdue, event }) {
  if (event) {
    // 不是今天的事件带上哪天：「本周」「以后」分组里只写时刻会看不出是哪天。
    const time = item.endTime ? `${item.time}–${item.endTime}` : item.time
    const date = item.scheduled ?? item.due
    const day = !date || date === today ? null : (date > today && date <= weekEnd ? weekdayLabel(date) : monthDay(date))
    return { kind: 'time', label: day ? `${day} ${time}` : time, day, time, overdue: false }
  }
  if (item.scheduled) {
    return {
      kind: 'plan',
      label: item.scheduled === today ? '计划今天' : `计划${weekdayLabel(item.scheduled)}`,
      overdue,
    }
  }
  if (item.due) return { kind: 'due', label: dueLabel(item.due, { today, weekEnd }), overdue }
  if (item.duration) return { kind: 'estimate', label: humanDuration(item.duration), overdue: false }
  return { kind: 'none', label: '没排期', overdue: false }
}

function dueLabel(due, { today, weekEnd }) {
  if (due === today) return '今天截止'
  if (due < today) {
    const diff = daysBetween(due, today)
    if (diff === 1) return '昨天截止'
    return `${monthDay(due)}截止`
  }
  if (due <= weekEnd) return `${weekdayLabel(due)}截止`
  return `${monthDay(due)}截止`
}

function compareItems(a, b) {
  // 过了时间的 event 沉到本组（以及「全部」列表）下面，不管它是哪一天的。
  if (a.past !== b.past) return a.past ? 1 : -1
  const dayA = a.scheduled ?? a.due ?? '9999-99-99'
  const dayB = b.scheduled ?? b.due ?? '9999-99-99'
  if (dayA !== dayB) return dayA < dayB ? -1 : 1
  const timeA = clockMinutes(a.time)
  const timeB = clockMinutes(b.time)
  if (timeA !== timeB) return timeA - timeB
  return a.title.localeCompare(b.title, 'zh-Hans-CN')
}

// ---- 写：勾选、删除、新建（都按行合并） ----

/**
 * 供本模块和后续工单（#51 重复事项、#53 AI 工具、#56 提醒同步）复用的按行合并写入：
 * 1. 重新读当前 `日程.md`（不用调用方手里的旧快照）；
 * 2. 交给 mutate(file, { stale }) 在当前行数组上修改，返回 { content, value }；
 * 3. 用刚读到的 version 调 saveNote；被第三方抢先改了就把 1-3 再来一遍，最多 MERGE_ATTEMPTS 次。
 * 合并不了（比如目标行已不在）由 mutate 抛出明确错误；多次被抢先则抛 409 schedule_merge_conflict。
 * 这样任何时候都不会把 Obsidian 里的修改整文件覆盖掉。
 *
 * createIfMissing：新建条目时文件可能还不存在。为 true 时允许 mutate 在空文件上返回
 * 第一行内容，用 createNote 建文件；创建期间别人刚好建出了文件则重新读、按追加处理。
 */
export async function mergeIntoLatest(ctx, baseVersion, mutate, { action = '修改', createIfMissing = false } = {}) {
  return withScheduleLock(ctx, async () => {
    let stale = false
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
      const file = await loadRawSchedule(ctx)
      if (!file.exists && !createIfMissing) {
        throw new HttpError(404, 'schedule_missing', '还没有日程文件，先在 Obsidian 里建一条或从首页添加')
      }
      if (baseVersion && file.version !== baseVersion) stale = true
      const outcome = await mutate(file, { stale, attempt })
      if (!outcome) continue
      if (!file.exists) {
        try {
          const saved = await createNote(ctx, SCHEDULE_PATH, outcome.content)
          return { ...outcome.value, version: saved.version, modifiedAt: saved.modifiedAt, merged: false }
        } catch (e) {
          // 别的程序刚好在这一刻建出了文件：下一轮重新读，按追加处理。
          if (e?.code === 'file_exists') continue
          throw e
        }
      }
      const saved = await saveNote(ctx, SCHEDULE_PATH, outcome.content, file.version)
      if (saved.conflict) continue
      return { ...outcome.value, version: saved.version, modifiedAt: saved.modifiedAt, merged: stale }
    }
    throw mergeConflict(`日程文件正在被反复修改，这次没有${action}；请刷新后再试`)
  })
}

/**
 * 勾选 / 取消勾选：按 id 找到最新那一行，只改勾选框和 ✅ 日期。重复事项完成时生成下一条。
 * HTTP 接口带 baseVersion；AI 工具没有版本号，用 { requireVersion: false } 仍按 id 合并写入。
 * 这是日程完成的唯一入口，AI 工具不能自己拼 `- [x]`（否则会漏掉重复下一条和父事项自动完成）。
 */
export async function completeItem(ctx, id, done, baseVersion, { requireVersion = true } = {}) {
  requireId(id)
  if (typeof done !== 'boolean') throw new HttpError(400, 'done_invalid', 'done 必须是 true 或 false')
  if (requireVersion) requireBaseVersion(baseVersion)

  return mergeIntoLatest(ctx, baseVersion, (file) => {
    const found = findWithContext(file.parsed, id)
    if (!found) throw missingTarget(file.version === baseVersion, '勾选')

    const target = found.item
    const today = localDate(ctx.now())
    const next = cloneItem(target)
    next.done = done
    next.completedAt = done ? today : null
    const lines = [...file.parsed.lines]
    lines[target.lineIndex] = serializeItem(next)

    // 顺序固定：先写完成状态 → 再生成重复事项的下一条 → 最后判断父事项自动完成。
    // 只在「未完成 → 完成」时生成下一条；取消勾选不动已经生成的那条。
    // 下一条插在目标整个缩进块之后（有子步骤 / 说明行时不插到它们中间），保持层级不乱。
    let generated = null
    if (done && !target.done) {
      const following = nextRecurringItem(target, file.parsed)
      if (following) {
        lines.splice(deleteEnd(lines, target), 0, serializeItem(following))
        generated = {
          id: following.id,
          title: following.title,
          due: following.due,
          scheduled: following.scheduled,
          time: following.time,
          endTime: following.endTime,
        }
      }
    }

    // 同一次操作里父事项的判断要用最新的完成状态。生成的下一条还没进解析树，
    // 因此不会挡住（也不会误触发）本次父事项自动完成；判断只看这次勾选前的子步骤。
    target.done = next.done
    target.completedAt = next.completedAt

    // 子步骤在 Beer 里全部勾完 → 自动完成父事项（写 - [x] 和 ✅）。
    // 只在调用这个接口时发生；在 Obsidian 里手动勾完不会触发。
    const autoCompleted = []
    if (done) {
      for (let i = found.ancestors.length - 1; i >= 0; i--) {
        const parent = found.ancestors[i]
        if (parent.done || parent.subtasks.length === 0) break
        if (!parent.subtasks.every(step => step.done)) break
        parent.done = true
        parent.completedAt = today
        lines[parent.lineIndex] = serializeItem(parent)
        autoCompleted.unshift({ id: parent.id, title: parent.title })
      }
    }

    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: {
        path: SCHEDULE_PATH,
        item: describeContentItem(content, id, ctx),
        autoCompleted,
        generated,
      },
    }
  }, { action: '勾选' })
}

/** 排到某天 / 取消排期：只改这一行的 ⏳，其余字节不动。 */
async function setScheduled(ctx, id, value, baseVersion) {
  requireId(id)
  requireBaseVersion(baseVersion)
  const scheduled = value == null || value === '' ? null : optionalDate(value, 'scheduled_invalid', '计划日')
  const action = scheduled ? '排期' : '取消排期'

  return mergeIntoLatest(ctx, baseVersion, file => {
    const found = findWithContext(file.parsed, id)
    if (!found) throw missingTarget(file.version === baseVersion, action)

    const next = cloneItem(found.item)
    next.scheduled = scheduled
    const lines = [...file.parsed.lines]
    lines[found.item.lineIndex] = serializeItem(next)
    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: { path: SCHEDULE_PATH, item: describeContentItem(content, id, ctx) },
    }
  }, { action })
}

/**
 * 给一条日程加一个子步骤。插在父事项最后一行缩进内容之后（原有子步骤 / 说明行都不动），
 * 新行缩进比父事项深 4 格。
 */
async function addSubtask(ctx, body) {
  const parentId = body?.parentId
  requireId(parentId)
  if (body?.baseVersion != null) requireBaseVersion(body.baseVersion)
  const source = optionalSource(body.source) ?? '对话'
  const child = normalizeNewItem(ctx, { ...body, source, subtasks: [] })

  return mergeIntoLatest(ctx, body.baseVersion ?? null, file => {
    const parent = findItemForWrite(file.parsed, parentId)
    if (!parent) throw missingTarget(body.baseVersion == null || file.version === body.baseVersion, '添加子步骤')

    const used = usedIds(file.parsed)
    const withId = allocateIds(child, used)
    const block = newItemLines(withId, 1, parent.indentText ?? '')
    const lines = [...file.parsed.lines]
    const end = deleteEnd(lines, parent)
    lines.splice(end, 0, ...block)
    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: {
        path: SCHEDULE_PATH,
        item: describeContentItem(content, withId.id, ctx),
        parent: describeContentItem(content, parentId, ctx),
      },
    }
  }, { action: '添加子步骤' })
}

/** 改一个子步骤（标题 / 预估时长 / 计划日等）：先复述靠调用方，这里只写文件。 */
async function updateSubtask(ctx, id, changes, baseVersion) {
  requireId(id)
  requireBaseVersion(baseVersion)
  if (changes && typeof changes === 'object' && !Array.isArray(changes) && 'subtasks' in changes) {
    throw new HttpError(400, 'subtasks_invalid', '子步骤下面不能再改子步骤')
  }

  return mergeIntoLatest(ctx, baseVersion, file => {
    const found = findWithContext(file.parsed, id)
    if (!found) throw missingTarget(file.version === baseVersion, '修改子步骤')
    if (!found.ancestors.length) throw new HttpError(400, 'not_subtask', '这条不是子步骤，请用 AI 工具或整条日程接口修改')

    const latest = applyItemChanges(found.item, changes)
    const lines = [...file.parsed.lines]
    lines[found.item.lineIndex] = serializeItem(latest)
    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: { path: SCHEDULE_PATH, item: describeContentItem(content, id, ctx) },
    }
  }, { action: '修改子步骤' })
}

/** 删除一个子步骤和它下面缩进更深的行，父事项和其他子步骤保留。 */
async function deleteSubtask(ctx, id, baseVersion) {
  requireId(id)
  requireBaseVersion(baseVersion)

  return mergeIntoLatest(ctx, baseVersion, file => {
    const found = findWithContext(file.parsed, id)
    if (!found) throw missingTarget(file.version === baseVersion, '删除子步骤')
    if (!found.ancestors.length) throw new HttpError(400, 'not_subtask', '这条不是子步骤，请用删除整条日程接口')

    const lines = [...file.parsed.lines]
    const end = deleteEnd(lines, found.item)
    lines.splice(found.item.lineIndex, end - found.item.lineIndex)
    const content = lines.join(file.parsed.eol)
    const parent = found.ancestors[found.ancestors.length - 1]
    return {
      content,
      value: {
        path: SCHEDULE_PATH,
        deleted: { id: found.item.id, title: found.item.title },
        parent: describeContentItem(content, parent.id, ctx),
      },
    }
  }, { action: '删除子步骤' })
}

/**
 * 生成重复事项的下一条（不写文件）：
 * - 参考日期取 📅 到期日，没有就取 ⏳ 计划日；按规则算出下一次同类日期；
 * - ⏳ 和参考日保持原来的相对天数（和 Tasks 一致），所以两个日期一起平移；
 * - 时间 / 时间段、标签、时长、来源、关联文章和未知 Beer 字段原样保留；
 * - 换一个新 id；不复制提醒编号（#56 再决定新一条要不要提醒）；
 * - 规则读不懂或没有任何日期时不生成。
 */
function nextRecurringItem(item, parsed) {
  const rule = parseRecurrence(item.recurrence)
  if (!rule?.supported) return null
  const reference = item.due ?? item.scheduled
  if (!reference) return null
  const nextReference = nextOccurrence(rule, reference)
  if (!nextReference) return null

  const offsetDays = daysBetween(reference, nextReference)
  const next = cloneItem(item)
  next.id = takeId(usedIds(parsed), null)
  next.done = false
  next.completedAt = null
  next.due = item.due ? nextReference : null
  next.scheduled = shiftedDate(item.scheduled, offsetDays)
  // #51：新一条不复制提醒编号；#56 加入 reminderIds 后，cloneItem 会连它一起带上，
  // 否则 serializeBeerFields 会把旧编号写回去。提醒偏好一起清掉，避免新一条
  // 因为「有偏好、没编号」被显示成「提醒没建成」——生成的事项要提醒需再手动设置。
  next.remind = null
  next.reminderIds = []
  next.reminderId = null
  next.beerFields = recurrenceBeerFields(item, next.id)
  next.subtasks = []
  next.unknownLines = []
  return next
}

function shiftedDate(dateText, days) {
  if (!dateText) return null
  const date = parseDateText(dateText)
  // 手写的非法日期（比如 2026-02-31）保持原样，不猜测。
  return date ? localDate(addDays(date, days)) : dateText
}

/** 新一条的 Beer 字段：换新 id、去掉提醒编号，其余（来源 / 关联文章 / 未知字段）原样保留。 */
function recurrenceBeerFields(item, id) {
  const fields = []
  let hasId = false
  for (const field of item.beerFields ?? []) {
    if (field.key === 'reminder') continue
    if (field.key === 'id') {
      fields.push({ key: 'id', value: id, quoted: false })
      hasId = true
    } else {
      fields.push({ ...field })
    }
  }
  if (!hasId) fields.unshift({ key: 'id', value: id, quoted: false })
  return fields
}

/**
 * 删除一条和它缩进的子步骤。子步骤包括缩进更深的说明行；遇到空行或缩进不更深的行为止。
 * 同样按 id 重新定位目标行后再删，不做整文件覆盖。
 * 日程先删成功，再去云端取消提醒；取消失败只作为 reminderError 返回，不回滚日程。
 * AI 工具（#53）没有 baseVersion，用 { requireVersion: false } 跳过版本检查，仍按 id 合并。
 */
export async function deleteItem(ctx, id, baseVersion, { requireVersion = true } = {}) {
  requireId(id)
  if (requireVersion) requireBaseVersion(baseVersion)

  const result = await mergeIntoLatest(ctx, baseVersion, (file) => {
    const target = findItemForWrite(file.parsed, id)
    if (!target) throw missingTarget(file.version === baseVersion, '删除')

    const lines = [...file.parsed.lines]
    const end = deleteEnd(lines, target)
    lines.splice(target.lineIndex, end - target.lineIndex)
    return {
      content: lines.join(file.parsed.eol),
      value: {
        path: SCHEDULE_PATH,
        deleted: { id: target.id, title: target.title },
        reminderIds: [...(target.reminderIds ?? [])],
      },
    }
  }, { action: '删除' })
  const { reminderIds = [], ...saved } = result
  if (!reminderIds.length) return { ...saved, reminderError: null }
  const cancelled = await cancelItemReminders(ctx, reminderIds)
  return { ...saved, remindersCancelled: cancelled.cancelled.length, reminderError: cancelled.error }
}

/**
 * 新建一条（#50 快速添加 / #53 AI 工具 / #56 提醒同步的底层写入）。文件不存在时直接建出来。
 * 新建的行固定带 `id` 和 `src`，保证后续勾选 / 删除可以稳定找到它。
 * 和勾选 / 删除一样走 mergeIntoLatest：重新读当前文件、在最新行数组上追加，不整文件覆盖。
 */
export async function createItem(ctx, body) {
  const item = normalizeNewItem(ctx, body)
  const saved = await appendItem(ctx, item)
  // 日程已经写成功；提醒建不成只回报警告，不回滚、不排队。
  return syncCreatedReminders(ctx, saved, item)
}

/** 快速添加（#50）：解析一句话，再走和 POST /schedule/items 相同的校验与写入。 */
async function quickAddItem(ctx, body) {
  const parsed = parseQuickAdd(body?.text, ctx.now())
  if (!parsed.title) throw new HttpError(400, 'text_invalid', '要写点内容，比如「周五前交专栏稿」')
  const item = normalizeNewItem(ctx, parsed)
  const saved = await appendItem(ctx, item)
  // 和普通新建一样：识别出时刻时默认带提醒，云端失败只回报 reminderError。
  return syncCreatedReminders(ctx, saved, item)
}

/**
 * 追加一条到 `日程.md`：和勾选 / 删除一样走 mergeIntoLatest（重新读 → 在当前行数组上
 * 追加 → 用当前版本保存），文件不存在时用 createNote 建出来。返回形状与旧的新建接口一致。
 * 带子步骤时一次写入父事项和缩进的子步骤（每步都有自己的 id）。
 */
async function appendItem(ctx, item) {
  return mergeIntoLatest(ctx, null, file => {
    const used = usedIds(file.parsed)
    const withIds = allocateIds(item, used)
    const block = newItemLines(withIds)
    if (!file.exists) {
      const content = block.join('\n') + '\n'
      return {
        content,
        value: { path: SCHEDULE_PATH, item: describeContentItem(content, withIds.id, ctx) },
      }
    }
    const lines = [...file.parsed.lines]
    // 追加在最后一条之后、文件末尾换行之前，不在中间多插空行。
    if (lines.length && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, ...block)
    } else {
      lines.push(...block, '')
    }
    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: { path: SCHEDULE_PATH, item: describeContentItem(content, withIds.id, ctx) },
    }
  }, { action: '添加', createIfMissing: true })
}

/** 建日程后建云端提醒，并把返回的编号按行合并写回这条日程。 */
async function syncCreatedReminders(ctx, saved, item) {
  if (!item.time || !item.remind || item.remind === 'off') return { ...saved, reminderError: null }
  const sync = await createItemReminders(ctx, { ...item, id: saved.item.id })
  if (!sync.ids.length) return { ...saved, reminders: sync.created, reminderError: sync.error ?? null }
  try {
    const persisted = await persistReminderIds(ctx, saved.item.id, sync.ids)
    return {
      ...saved,
      item: persisted.item,
      version: persisted.version,
      modifiedAt: persisted.modifiedAt,
      reminders: sync.created,
      reminderError: sync.error ?? null,
    }
  } catch (e) {
    return {
      ...saved,
      reminders: sync.created,
      reminderError: `提醒建好了，但编号没写回日程：${e?.message ?? e}`,
    }
  }
}

function usedIds(parsed) {
  return new Set(flattenItems(parsed.items ?? []).map(item => item.id))
}

/** 新建时给父事项和每步子步骤分一个文件里唯一的 id。 */
function allocateIds(item, used) {
  const id = takeId(used, item.id)
  return {
    ...item,
    id,
    subtasks: (item.subtasks ?? []).map(child => allocateIds(child, used)),
  }
}

function takeId(used, wanted) {
  if (wanted && !used.has(wanted)) {
    used.add(wanted)
    return wanted
  }
  for (;;) {
    const id = randomId()
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
}

/** 只改提醒编号字段；重新读最新文件、按 id 定位，避免覆盖 Obsidian 同时做的修改。 */
async function persistReminderIds(ctx, id, ids) {
  return mergeIntoLatest(ctx, null, (file) => {
    const target = findItemForWrite(file.parsed, id)
    if (!target) throw mergeConflict('日程文件在你操作期间被改过，提醒编号没写回去；请刷新后再看')
    const next = cloneItem(target)
    next.reminderIds = normalizeReminderIds(ids)
    next.reminderId = next.reminderIds.join(',') || null
    const lines = [...file.parsed.lines]
    lines[target.lineIndex] = serializeItem(next)
    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: { path: SCHEDULE_PATH, item: describeContentItem(content, id, ctx) },
    }
  }, { action: '写回提醒编号' })
}

/** 这次修改会不会让云端提醒跟着变：时间、日期、标题或提醒偏好。 */
export function reminderFieldsChanged(changes) {
  if (!changes || typeof changes !== 'object') return false
  // location 也算：提醒正文带地点，改了会议号 / 地址要重建提醒。
  return ['title', 'due', 'scheduled', 'time', 'endTime', 'location', 'remind', 'reminderId']
    .some(key => key in changes)
}

/**
 * 修改一条日程（AI 工具的 #53 确认流程在调用前自己处理）。
 * 先把改好的日程写进文件，再同步提醒。文件里的旧提醒编号在云端 DELETE 成功之前
 * 不能清掉：删失败时保留旧编号、跳过建新提醒，避免「旧提醒还在、新编号又没写回」；
 * 下次修改会再次尝试取消。云端失败只返回 reminderError，日程本身保持已保存。
 * changes.subtasks 会整体替换父事项下面的子步骤行（用户写的说明行保留）。
 */
export async function updateItem(ctx, id, changes) {
  requireId(id)
  const reminderChanged = reminderFieldsChanged(changes)
  const subtasksChanged = Boolean(changes && typeof changes === 'object' && 'subtasks' in changes)

  const result = await mergeIntoLatest(ctx, null, (file) => {
    const target = findItemForWrite(file.parsed, id)
    if (!target) {
      throw new HttpError(409, 'schedule_merge_conflict',
        `日程文件在你确认期间被改过，找不到编号 ${id} 的这一条（可能被删了），这次没有写入；请刷新后再试`)
    }
    const latest = applyItemChanges(target, changes)
    // 手动写的旧行可能没有 remind 字段；改过时间 / 标题后按默认提醒处理。
    if (reminderChanged && latest.time && !latest.remind) latest.remind = 'default'
    const next = cloneItem(latest)
    const oldIds = [...(target.reminderIds ?? [])]
    if (reminderChanged) {
      // 先保留旧编号：云端 DELETE 成功之后才清掉 / 换成新编号（见下面的同步逻辑）。
      next.reminderIds = oldIds
      next.reminderId = oldIds.join(',') || null
    }
    const lines = [...file.parsed.lines]
    lines[target.lineIndex] = serializeItem(next)
    if (subtasksChanged) replaceSubtaskLines(lines, target, next.subtasks)
    const content = lines.join(file.parsed.eol)
    return {
      content,
      value: {
        path: SCHEDULE_PATH,
        item: describeContentItem(content, id, ctx),
        reminderIds: oldIds,
      },
    }
  }, { action: '修改' })

  const { reminderIds = [], ...saved } = result
  if (!reminderChanged) return { ...saved, reminderError: null }
  const sync = await updateItemReminders(ctx, saved.item, reminderIds)
  // updateItemReminders 在旧提醒没删干净时不会 POST 新提醒。这时文件里的旧编号
  // 保持原样（上面写入时没有清掉），用户下次修改会再次尝试取消。
  if (sync.error && sync.cancelled.length < reminderIds.length) {
    return {
      ...saved,
      reminders: [],
      remindersCancelled: sync.cancelled.length,
      reminderIdsKept: true,
      reminderError: `${sync.error}（旧提醒编号保留在 日程.md 里，没有新建提醒；下次修改会再试）`,
    }
  }
  try {
    // 旧提醒都删掉了（或本来就没有）：清掉旧编号 / 写入新编号。
    // 即使新提醒没建成（sync.ids 为空）也要把文件里的旧编号清掉。
    const persisted = await persistReminderIds(ctx, saved.item.id, sync.ids)
    return {
      ...saved,
      item: persisted.item,
      version: persisted.version,
      modifiedAt: persisted.modifiedAt,
      reminders: sync.created,
      remindersCancelled: sync.cancelled.length,
      reminderError: sync.error ?? null,
    }
  } catch (e) {
    return {
      ...saved,
      reminders: sync.created,
      remindersCancelled: sync.cancelled.length,
      reminderError: `提醒改好了，但编号没写回日程：${e?.message ?? e}`,
    }
  }
}

/** 父事项一行，子步骤每深一层多缩进 4 格。 */
export function newItemLines(item, depth = 0, baseIndent = '') {
  const indentText = baseIndent + '    '.repeat(depth)
  return [
    newItemContent({ ...item, indentText }),
    ...(item.subtasks ?? []).flatMap(child => newItemLines(child, depth + 1, baseIndent)),
  ]
}

/**
 * 整体替换子步骤行：只移除能被解析成 `- [ ]` 事项的子步骤行，
 * 用户写在父事项下面的说明 / 注释行原样保留（排在新步骤后面）。
 */
function replaceSubtaskLines(lines, target, subtasks) {
  const end = deleteEnd(lines, target)
  const kept = lines.slice(target.lineIndex + 1, end).filter(line => !parseItem(line, 0))
  const generated = subtaskLines(subtasks, (target.indentText ?? '') + '    ')
  lines.splice(target.lineIndex + 1, end - target.lineIndex - 1, ...generated, ...kept)
}

function subtaskLines(items, indentText) {
  return (items ?? []).flatMap(item => [
    newItemContent({ ...item, indentText }),
    ...subtaskLines(item.subtasks, indentText + '    '),
  ])
}

/** 整份内容里按 id 找到那条并描述（子步骤带父事项标题和序号）。 */
function describeContentItem(content, id, ctx) {
  const parsed = parseSchedule(content)
  const found = findWithContext(parsed, id)
  if (!found) return null
  const parent = found.ancestors[found.ancestors.length - 1] ?? null
  const context = parent
    ? { parent, index: parent.subtasks.indexOf(found.item), count: parent.subtasks.length }
    : null
  return describeItem(found.item, viewClock(ctx), context)
}

export function normalizeNewItem(ctx, body) {
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : ''
  if (!title) throw new HttpError(400, 'title_invalid', '日程标题不能为空')

  const due = optionalDate(body.due, 'due_invalid', '截止日')
  const scheduled = optionalDate(body.scheduled, 'scheduled_invalid', '计划日')
  const time = optionalClock(body.time, 'time_invalid', '时刻')
  let endTime = optionalClock(body.endTime, 'end_time_invalid', '结束时刻')
  if (!time && endTime) throw new HttpError(400, 'time_invalid', '只写结束时刻时也要写开始时刻')
  if (time && endTime && clockMinutes(endTime) <= clockMinutes(time)) {
    throw new HttpError(400, 'time_invalid', '结束时刻必须晚于开始时刻')
  }
  const duration = optionalDuration(body.duration)
  // 有具体时刻的事默认带提醒（#44：前一天 21:30 + 开始前 1 小时）；没写偏好时也不强制。
  const remind = normalizeRemind(body.remind, { hasTime: Boolean(time) }) ?? (time ? 'default' : null)
  const reminderIds = normalizeReminderIds(body.reminderIds ?? body.reminderId)

  const tags = normalizeTags(body.tags)
  const source = optionalSource(body.source) ?? '快速添加'
  return {
    id: typeof body.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : randomId(),
    title,
    due,
    scheduled,
    time,
    endTime,
    explicitEnd: Boolean(endTime),
    timeSeparator: '–',
    duration,
    durationMinutes: durationMinutesOf(duration),
    tags,
    source,
    location: optionalText(body.location),
    recurrence: normalizeRecurrence(body.recurrence),
    remind,
    reminderIds,
    reminderId: reminderIds.join(',') || null,
    articlePath: optionalText(body.articlePath),
    completedAt: null,
    done: false,
    indent: 0,
    indentText: '',
    fields: [],
    beerFields: [],
    subtasks: normalizeNewSubtasks(body.subtasks, source),
    unknownLines: [],
  }
}

const MAX_SUBTASKS = 50

/** 新建事项时一起写的子步骤；字段校验和顶层一样，来源默认跟父事项一致。 */
function normalizeNewSubtasks(raw, source) {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new HttpError(400, 'subtasks_invalid', 'subtasks 必须是数组')
  if (raw.length > MAX_SUBTASKS) {
    throw new HttpError(400, 'subtasks_invalid', `一条日程最多拆 ${MAX_SUBTASKS} 步`)
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, 'subtasks_invalid', `第 ${index + 1} 步必须是对象`)
    }
    try {
      return normalizeNewItem(null, {
        ...entry,
        source: entry.source ?? source,
        subtasks: entry.subtasks ?? [],
      })
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status, e.code, `第 ${index + 1} 步：${e.message}`)
      throw e
    }
  })
}

/**
 * 把一组修改应用到已解析的一条记录上，返回新记录（不写文件）。
 * 预览（#53 复述）和执行共用这一套校验，保证「看到的」和「写进去的」一致。
 * 传入 null / '' 表示清掉这个字段；没传的字段保持原样。
 */
export function applyItemChanges(current, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new HttpError(400, 'invalid', 'changes 必须是对象')
  }
  const keys = Object.keys(changes)
  if (!keys.length) throw new HttpError(400, 'invalid', '没有要修改的内容')
  const allowed = new Set([
    'title', 'due', 'scheduled', 'time', 'endTime', 'duration',
    'tags', 'source', 'location', 'recurrence', 'remind', 'reminderId', 'reminderIds',
    'articlePath', 'subtasks',
  ])
  const unknown = keys.filter(key => !allowed.has(key))
  if (unknown.length) throw new HttpError(400, 'invalid', `不认识的字段：${unknown.join('、')}`)

  const next = cloneItem(current)
  if ('title' in changes) {
    const title = typeof changes.title === 'string' ? changes.title.replace(/\s+/g, ' ').trim() : ''
    if (!title) throw new HttpError(400, 'title_invalid', '日程标题不能为空')
    next.title = title
  }
  if ('due' in changes) next.due = optionalDate(changes.due, 'due_invalid', '截止日')
  if ('scheduled' in changes) next.scheduled = optionalDate(changes.scheduled, 'scheduled_invalid', '计划日')
  const timeChanged = 'time' in changes
  const endChanged = 'endTime' in changes
  if (timeChanged) next.time = optionalClock(changes.time, 'time_invalid', '时刻')
  if (endChanged) next.endTime = optionalClock(changes.endTime, 'end_time_invalid', '结束时刻')
  // 原来只写了开始时刻（结束时间是按预估时长算出来的）时，改开始时刻不要顺手补一个结束时刻。
  if (timeChanged && !endChanged && !current.explicitEnd) next.endTime = null
  if (timeChanged && !endChanged && !next.time) next.endTime = null
  if (!next.time && next.endTime) throw new HttpError(400, 'time_invalid', '只写结束时刻时也要写开始时刻')
  if (next.time && next.endTime && clockMinutes(next.endTime) <= clockMinutes(next.time)) {
    throw new HttpError(400, 'time_invalid', '结束时刻必须晚于开始时刻')
  }
  if (timeChanged || endChanged) next.explicitEnd = Boolean(next.time && next.endTime)
  if ('duration' in changes) {
    next.duration = optionalDuration(changes.duration)
    next.durationMinutes = durationMinutesOf(next.duration)
  }
  if ('tags' in changes) next.tags = normalizeTags(changes.tags)
  if ('source' in changes) next.source = optionalSource(changes.source)
  if ('location' in changes) next.location = optionalText(changes.location)
  if ('recurrence' in changes) next.recurrence = optionalText(changes.recurrence)
  if ('remind' in changes) {
    next.remind = normalizeRemind(changes.remind, { hasTime: Boolean(next.time) }) ?? (next.time ? 'default' : null)
  } else if (timeChanged) {
    // 有时刻的事项改时间后默认带提醒；时刻被清掉时一起清掉偏好和编号。
    if (!next.time) {
      next.remind = null
      next.reminderIds = []
      next.reminderId = null
    } else if (!next.remind) {
      next.remind = 'default'
    }
  }
  if ('reminderIds' in changes || 'reminderId' in changes) {
    next.reminderIds = normalizeReminderIds('reminderIds' in changes ? changes.reminderIds : changes.reminderId)
    next.reminderId = next.reminderIds.join(',') || null
  }
  if ('articlePath' in changes) next.articlePath = optionalText(changes.articlePath)
  if ('subtasks' in changes) next.subtasks = normalizeChangedSubtasks(current, changes.subtasks)
  return next
}

/**
 * 修改时整体替换子步骤。id 用「父 id + 序号 + 标题」算出来：
 * 复述和确认是两次独立调用，随机 id 会让确认码对不上。
 */
function normalizeChangedSubtasks(current, raw) {
  if (raw == null) raw = []
  if (!Array.isArray(raw)) throw new HttpError(400, 'subtasks_invalid', 'subtasks 必须是数组')
  if (raw.length > MAX_SUBTASKS) {
    throw new HttpError(400, 'subtasks_invalid', `一条日程最多拆 ${MAX_SUBTASKS} 步`)
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, 'subtasks_invalid', `第 ${index + 1} 步必须是对象`)
    }
    const title = typeof entry.title === 'string' ? entry.title.replace(/\s+/g, ' ').trim() : ''
    const id = createHash('sha1')
      .update(`sub:${current.id}:${index}:${title}`)
      .digest('hex')
      .slice(0, 10)
    try {
      return normalizeNewItem(null, {
        ...entry,
        id,
        source: entry.source ?? current.source ?? '对话',
        subtasks: entry.subtasks ?? [],
      })
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status, e.code, `第 ${index + 1} 步：${e.message}`)
      throw e
    }
  })
}

function optionalDate(value, code, label) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, code, `${label}要用 YYYY-MM-DD 写法`)
  }
  // 拒绝 2026-02-31 这种写法：转回日期再比一次。
  if (localDate(dateFromText(value)) !== value) {
    throw new HttpError(400, code, `${label}不是一个真实存在的日期`)
  }
  return value
}

function optionalClock(value, code, label) {
  if (value == null || value === '') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value))
  if (!match || !validClock(match[1], match[2])) throw new HttpError(400, code, `${label}要用 HH:mm 写法`)
  return `${pad(match[1])}:${match[2]}`
}

function optionalDuration(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || durationMinutesOf(value) == null) {
    throw new HttpError(400, 'duration_invalid', '预估时长要写成 6h、90m、1h30m、6 小时或 90 分钟')
  }
  return value
}

function optionalText(value) {
  if (value == null) return null
  // 这些字段直接写进行尾，不能把换行带进去（会把一条日程拆成两行）。
  const text = String(value).replace(/[\r\n]+/g, ' ').trim()
  return text || null
}

/** 新建时把中文重复规则转成 Tasks 写法；读不懂的文本原样写入。 */
function normalizeRecurrence(value) {
  const text = optionalText(value)
  if (!text) return null
  const rule = parseRecurrence(text)
  return rule?.supported ? rule.canonical : text
}

function optionalSource(value) {
  if (value == null || value === '') return null
  const text = String(value).replace(/[\r\n]+/g, ' ').trim()
  return text || null
}

function normalizeTags(raw) {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new HttpError(400, 'tags_invalid', 'tags 必须是数组')
  const tags = []
  for (const entry of raw) {
    const tag = String(entry ?? '').trim().replace(/^#/, '')
    if (!tag) continue
    if (/\s/.test(tag)) throw new HttpError(400, 'tags_invalid', '标签里不能有空格')
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

// ---- 快速添加：一句话 → 一条日程（#50） ----
//
// 只做「日期 / 时刻 / 预估时长识别 + 去掉这些短语」，返回和 POST /schedule/items 相同的字段形状：
//   { title, due, scheduled, time, endTime, duration, source, matched }
// 日期默认当截止日（📅）；`计划 / 排到 + 日期` 当计划日（⏳）；`约 6 小时` 之类当预估时长。
// 只写时刻时按今天算，直接记今天这个时刻的事。
//
// 支持的日期短语（从 ctx.now() 的本机时区算）：
//   今天 / 明天 / 后天、周X / 星期X / 礼拜X（下一个，含今天）、本周X / 这周X、下周X，
//   YYYY-MM-DD、YYYY年M月D日、M月D日、MM-DD。没写年份且已经过去的日期按明年算。
// 时刻：HH:mm（也认全角冒号）。「周五前」里的「前 / 之前 / 以前」一起去掉。

const QUICK_ADD_SOURCE = '快速添加'
const WEEKDAY_CHARS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
const DATE_SUFFIX = '(?:之前|以前|前)?'
const FULL_DATE_RE = new RegExp(`(\\d{4})-(\\d{1,2})-(\\d{1,2})${DATE_SUFFIX}`)
const CN_FULL_DATE_RE = new RegExp(`(\\d{4})年(\\d{1,2})月(\\d{1,2})日?${DATE_SUFFIX}`)
const MONTH_DAY_RE = new RegExp(`(\\d{1,2})月(\\d{1,2})日${DATE_SUFFIX}`)
const DASH_MONTH_DAY_RE = new RegExp(`(?<![\\d-])(\\d{1,2})-(\\d{1,2})(?![\\d-])${DATE_SUFFIX}`)
const NAMED_WEEK_RE = new RegExp(`(本|这|下)周([一二三四五六日天])${DATE_SUFFIX}`)
const RELATIVE_DAY_RE = new RegExp(`(今天|明天|后天)${DATE_SUFFIX}`)
const WEEKDAY_RE = new RegExp(`(?:周|星期|礼拜)([一二三四五六日天])${DATE_SUFFIX}`)
const CLOCK_RE = /(?<!\d)(\d{1,2})[:：](\d{2})(?!\d)/

/**
 * 解析一句快速添加。无效输入抛 400 text_invalid / date_invalid。
 * @param {string} text 用户输入的一句话
 * @param {Date} now 本机时区的「现在」（必填；调用方一律传 ctx.now()，不用墙上时钟兜底）
 */
export function parseQuickAdd(text, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('parseQuickAdd 需要传入 now（用 ctx.now()），不再用墙上时钟兜底')
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(400, 'text_invalid', '要输入一句话，比如「周五前交专栏稿」')
  }

  const matched = { date: null, time: null, duration: null }
  let rest = text
  let date = null
  let planned = false

  const takeDate = (regex, resolve) => {
    if (date) return
    const match = regex.exec(rest)
    if (!match) return
    // 「计划 / 排到 / 安排到」紧挨在日期前面时，这个日期是计划日（⏳），不是截止日。
    const before = rest.slice(0, match.index)
    const planMatch = /(?:计划|安排到|排到)\s*$/.exec(before)
    const start = planMatch ? planMatch.index : match.index
    date = resolve(match)
    if (planMatch) planned = true
    matched.date = rest.slice(start, match.index + match[0].length).trim()
    rest = rest.slice(0, start) + ' ' + rest.slice(match.index + match[0].length)
  }

  takeDate(FULL_DATE_RE, match => explicitDate(Number(match[1]), Number(match[2]), Number(match[3])))
  takeDate(CN_FULL_DATE_RE, match => explicitDate(Number(match[1]), Number(match[2]), Number(match[3])))
  takeDate(MONTH_DAY_RE, match => monthDayDate(Number(match[1]), Number(match[2]), now))
  takeDate(DASH_MONTH_DAY_RE, match => monthDayDate(Number(match[1]), Number(match[2]), now))
  takeDate(NAMED_WEEK_RE, match => namedWeekDate(match[1], match[2], now))
  takeDate(RELATIVE_DAY_RE, match => relativeDayDate(match[1], now))
  takeDate(WEEKDAY_RE, match => nextWeekdayDate(match[1], now))

  let time = null
  const clock = CLOCK_RE.exec(rest)
  if (clock && validClock(clock[1], clock[2])) {
    time = `${pad(clock[1])}:${clock[2]}`
    matched.time = clock[0]
    rest = cutMatch(rest, clock)
  }
  // 没写日期但写了时刻：按今天算。
  if (time && !date) date = startOfDay(now)

  // 预估时长：「约 6 小时」「90 分钟」「1.5h」。整句里只认一处。
  let duration = null
  const estimate = ESTIMATE_HOURS_RE.exec(rest) ?? ESTIMATE_MINUTES_RE.exec(rest)
  if (estimate) {
    // 识别短语仍由这里的正则负责，解释成分钟数统一交给 parseDuration。
    const parsed = parseDuration(estimate[0])
    if (parsed) {
      duration = quickDuration(parsed)
      matched.duration = estimate[0].trim()
      rest = cutMatch(rest, estimate)
    }
  }

  // 只剩日期 / 时刻 / 时长、没有标题时照样返回（解析器只负责识别，方便复用）；
  // 快速添加接口会拒绝这种句子，避免写进一条没有标题的日程。
  const title = cleanQuickTitle(rest)

  return {
    title,
    due: date && !planned ? localDate(date) : null,
    scheduled: date && planned ? localDate(date) : null,
    time,
    endTime: null,
    duration,
    source: QUICK_ADD_SOURCE,
    matched,
  }
}

// 时长短语：优先认带小时的写法，再认只有分钟的。放在日期 / 时刻正则之后，避免抢走 14:00。
const ESTIMATE_HOURS_RE = /(?:约|大约|大概|差不多)?\s*(?<hours>\d+(?:\.\d+)?)\s*(?:个?小时|hours?|h)(?:\s*(?<minutes>\d+)\s*(?:分钟|分|mins?|m))?/i
const ESTIMATE_MINUTES_RE = /(?:约|大约|大概|差不多)?\s*(?<minutes>\d+)\s*(?:分钟|分|mins?|m)(?![\w:])/i

function quickDuration({ hours, minutes }) {
  if (!hours && !minutes) return null
  if (hours && minutes) return `${hours}h${minutes}m`
  if (hours) return `${hours}h`
  return `${minutes}m`
}

function cutMatch(text, match) {
  return text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length)
}

function cleanQuickTitle(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,，。;；:：、·\-—]+/, '')
    .replace(/[\s,，。;；:：、·\-—]+$/, '')
    .trim()
}

function explicitDate(year, month, day) {
  const date = makeLocalDate(year, month, day)
  if (!date) throw new HttpError(400, 'date_invalid', '日期不是一个真实存在的日期')
  return date
}

/** 没写年份的日期：先按今年算；已经过去就按明年同一天算（12 月写「01-05」很常见）。 */
function monthDayDate(month, day, now) {
  if (month < 1 || month > 12) throw new HttpError(400, 'date_invalid', '月份要在 1–12 之间')
  let date = makeLocalDate(now.getFullYear(), month, day)
  if (!date) throw new HttpError(400, 'date_invalid', '日期不是一个真实存在的日期')
  if (date.getTime() < startOfDay(now).getTime()) {
    date = makeLocalDate(now.getFullYear() + 1, month, day)
    if (!date) throw new HttpError(400, 'date_invalid', '日期不是一个真实存在的日期')
  }
  return date
}

/** 本周一算第 0 天；「本周X」按本机时区的本周算（周一为一周开始）。 */
function namedWeekDate(which, char, now) {
  const offset = (WEEKDAY_CHARS[char] + 6) % 7
  const weekStart = addDays(startOfDay(now), -((now.getDay() + 6) % 7))
  return addDays(weekStart, offset + (which === '下' ? 7 : 0))
}

function relativeDayDate(word, now) {
  return addDays(startOfDay(now), { 今天: 0, 明天: 1, 后天: 2 }[word])
}

/** 单独的「周X」：下一个 X，含今天。 */
function nextWeekdayDate(char, now) {
  const today = startOfDay(now)
  return addDays(today, (WEEKDAY_CHARS[char] - today.getDay() + 7) % 7)
}

function requireId(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'id_invalid', '要说明是哪一条日程')
}

function requireBaseVersion(baseVersion) {
  if (typeof baseVersion !== 'string' || !baseVersion) {
    throw new HttpError(400, 'base_version_invalid', '保存时要带上读取时的版本标记 baseVersion')
  }
}

function findItemForWrite(parsed, id) {
  const all = flattenItems(parsed.items)
  const exact = all.filter(item => item.id === id)
  if (exact.length) return exact[0]
  // 手动写的行没有 Beer id，临时 id 跟着行内容变。内容被改过就对不上，
  // 这时宁可让用户刷新，也不按猜测的行号去删改别的条目。
  return null
}

/** 按 id 找到那条和它的所有祖先（最近的在最后），子步骤操作和自动完成父事项都要用。 */
function findWithContext(parsed, id) {
  const search = (items, ancestors) => {
    for (const item of items ?? []) {
      if (item.id === id) return { item, ancestors }
      const nested = search(item.subtasks, [...ancestors, item])
      if (nested) return nested
    }
    return null
  }
  return search(parsed.items, [])
}

/** 删除范围：目标行 + 紧跟其后、缩进更深的所有行；空行和缩进不更深的行为止。 */
function deleteEnd(lines, target) {
  let end = target.lineIndex + 1
  while (end < lines.length) {
    const line = lines[end]
    if (!line.trim()) break
    const indent = (/^[ \t]*/.exec(line) ?? [''])[0].length
    if (indent <= target.indent) break
    end++
  }
  return end
}

function cloneItem(item) {
  return {
    ...item,
    tags: [...item.tags],
    reminderIds: [...(item.reminderIds ?? [])],
    rawLines: [...item.rawLines],
    unknownLines: [...item.unknownLines],
    subtasks: [...item.subtasks],
  }
}

async function loadRawSchedule(ctx) {
  try {
    const note = await readNote(ctx, SCHEDULE_PATH)
    return { exists: true, version: note.version, modifiedAt: note.modifiedAt, parsed: parseSchedule(note.content) }
  } catch (e) {
    if (e?.code === 'not_found') return { exists: false, version: null, modifiedAt: null, parsed: parseSchedule('') }
    throw e
  }
}

function mergeConflict(message) {
  return new HttpError(409, 'schedule_merge_conflict', message)
}

/** 找不到目标：版本没变 → 只是这一条已经不在了；版本变了 → 合并失败，提示刷新。 */
function missingTarget(versionUnchanged, action) {
  if (versionUnchanged) {
    return new HttpError(404, 'schedule_item_missing', `日程里已经没有要${action}的这一条，可能刚被删掉，刷新后再看`)
  }
  return mergeConflict(`日程文件在你操作期间被改过，找不到要${action}的这一条（可能被删了或改了 id），这次没有写入；请刷新后再试`)
}

function viewClock(ctx) {
  const now = ctx.now()
  return { now, today: localDate(now), weekEnd: localDate(sundayOf(now)) }
}

function randomId() {
  return randomBytes(5).toString('hex')
}

// 同一个进程里的写操作排队，避免并发勾选时互相把版本撞掉。
const scheduleLocks = new WeakMap()

function withScheduleLock(ctx, fn) {
  const previous = scheduleLocks.get(ctx) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  scheduleLocks.set(ctx, next.then(() => {}, () => {}))
  return next
}

// ---- 日期 / 时刻小工具 ----

function sundayOf(date) {
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  sunday.setDate(sunday.getDate() + (7 - ((sunday.getDay() + 6) % 7)) - 1)
  return sunday
}

function weekdayLabel(dateText) {
  return WEEKDAY_NAMES[dateFromText(dateText).getDay()]
}

function monthDay(dateText) {
  const [, month, day] = dateText.split('-')
  return `${Number(month)}月${Number(day)}日`
}

function daysBetween(fromText, toText) {
  const from = dateFromText(fromText)
  const to = dateFromText(toText)
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

function dateFromText(text) {
  const [year, month, day] = text.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 严格解析 YYYY-MM-DD；2026-02-31 这类不存在的日期返回 null。 */
function parseDateText(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

/** 只接受真实存在的本机日期：2026-02-31 会滚到 3 月，这里返回 null。 */
function makeLocalDate(year, month, day) {
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

function eventTimes(item) {
  if (!item.time || (!item.due && !item.scheduled)) return { start: null, end: null }
  const day = item.scheduled ?? item.due
  const date = dateFromText(day)
  const [hour, minute] = item.time.split(':').map(Number)
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute)
  const endClock = item.endTime ?? addMinutesToClock(item.time, item.durationMinutes ?? DEFAULT_EVENT_MINUTES)
  const [endHour, endMinute] = endClock.split(':').map(Number)
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), endHour, endMinute)
  if (end <= start) end.setDate(end.getDate() + 1) // 跨零点的时间段
  return { start, end }
}

function addMinutesToClock(clock, minutes) {
  const total = clockMinutes(clock) + (minutes ?? 0)
  const wrapped = ((total % 1440) + 1440) % 1440
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`
}

function clockMinutes(clock) {
  if (!clock) return 24 * 60
  const [hour, minute] = clock.split(':').map(Number)
  return hour * 60 + minute
}

function validClock(hour, minute) {
  const h = Number(hour)
  const m = Number(minute)
  return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * 日程里唯一的预估时长解析器（快速添加 / AI 工具复述 / pending 共用）。
 * 支持 6h / 6 小时 / 1.5h / 30m / 90 分钟 / 1h30m / 2 小时 30 分钟，前面可带「约」。
 * 返回 { hours, minutes, totalMinutes, hasHours }；读不懂返回 null。
 */
export function parseDuration(value) {
  if (value == null || value === '') return null
  const text = String(value).trim().replace(/^(?:约|大约|大概)\s*/, '')
  const match = /^(?:(\d+(?:\.\d+)?)\s*(?:个?小时|h|hours?))?\s*(?:(\d+(?:\.\d+)?)\s*(?:分钟|分|m|mins?))?$/i.exec(text)
  if (!match || (!match[1] && !match[2])) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  return {
    hours,
    minutes,
    totalMinutes: Math.round(hours * 60) + Math.round(minutes),
    hasHours: match[1] != null,
  }
}

/** 只取总分钟数；其他模块只关心「多久」时用这个，不要各写一套正则。 */
export function durationMinutesOf(value) {
  return parseDuration(value)?.totalMinutes ?? null
}

/** 「2.5 小时」/「90 分钟」，复述和列表共用。 */
export function humanMinutes(minutes) {
  if (minutes >= 60) {
    const hours = minutes / 60
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
  }
  return `${minutes} 分钟`
}

function humanDuration(value) {
  const minutes = durationMinutesOf(value)
  if (minutes == null) return '约 ' + value
  return '约 ' + humanMinutes(minutes)
}
