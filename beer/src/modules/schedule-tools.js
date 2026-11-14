// 日程 AI 工具（#53）：对话里建 / 查 / 改 / 完成 / 删除日程。
//
// 建、改、完成、删除都分两步（和邮件提醒 #44 一样是无状态的）：
//   1. 不带 confirmToken 调用 → 只做校验、返回复述文本（具体日期 + 星期 + 时刻）和确认码，不写 `日程.md`；
//      建日程还会把这次识别结果写进数据目录的 `schedule-pending` 状态，供首页「识别到日程」卡片（#55）显示。
//   2. 用户确认后带同一个 confirmToken 再调用 → 才真正写文件；确认码是 kind + 全部可改内容的指纹，
//      内容改了就对不上（409 confirm_mismatch），必须重新复述。
//
// 改、删、完成执行时都重新读一遍 `日程.md`，用 mergeIntoLatest 按 id 找到最新那一行再改，
// 所以确认前后用户在 Obsidian 里的修改不会被整文件覆盖。
//
// 面试邮件由对话里的模型解析成结构化条目（一轮面试一条），工具只负责校验、复述和写入；
// 没写来源时默认「对话」。
import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from '../http/router.js'
import {
  SCHEDULE_PATH,
  applyItemChanges,
  completeItem,
  createItem,
  deleteItem,
  durationMinutesOf,
  humanMinutes,
  loadSchedule,
  normalizeNewItem,
  parseSchedule,
  updateItem,
} from './schedule.js'
import { pendingReminderLabel, remindSummary } from './schedule-reminders.js'
import { GROUP_LABELS, WEEKDAY_NAMES, flattenItems } from './schedule-shared.js'
import { resolveVault } from './vault.js'

export const SCHEDULE_PENDING_KEY = 'schedule-pending'
const MAX_BATCH = 20
const GROUPS = ['all', 'overdue', 'today', 'week', 'later', 'unscheduled', 'done']
const ITEM_FIELDS = [
  'title', 'due', 'scheduled', 'time', 'endTime', 'duration',
  'tags', 'source', 'location', 'recurrence', 'remind', 'reminderId', 'articlePath', 'subtasks',
]

// ---- 指纹与规范化 ----

/** 稳定 JSON：对象键排序，保证同一批内容每次算出的确认码一样。 */
function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') + '}'
  }
  return JSON.stringify(value)
}

/** 一批操作的指纹：kind 不同、内容不同都对不上。 */
function fingerprint(kind, data) {
  return createHash('sha256').update(kind + '\n' + canonicalJson(data)).digest('hex').slice(0, 12)
}

/** 只保留 AI / 首页卡片需要的外部字段，不带解析用的内部结构。 */
function publicItem(item) {
  const out = {}
  for (const key of ITEM_FIELDS) {
    const value = item?.[key]
    if (value == null) continue
    if (key === 'tags' && (!Array.isArray(value) || value.length === 0)) continue
    if (key === 'subtasks') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.subtasks = value.map(publicItem)
      continue
    }
    out[key] = key === 'tags' ? [...value] : value
  }
  if (!out.title && item?.title) out.title = item.title
  return out
}

function normalizeNewItems(ctx, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'items_invalid', 'items 至少要有一条日程')
  }
  if (items.length > MAX_BATCH) {
    throw new HttpError(400, 'items_invalid', `一次最多建 ${MAX_BATCH} 条日程`)
  }
  return items.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'items_invalid', `第 ${index + 1} 条日程必须是对象`)
    }
    try {
      const trimmedSource = typeof raw.source === 'string' ? raw.source.trim() : raw.source
      const source = trimmedSource == null || trimmedSource === '' ? '对话' : trimmedSource
      return normalizeNewItem(ctx, { ...raw, source })
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status, e.code, `第 ${index + 1} 条：${e.message}`)
      throw e
    }
  })
}

/** 修改后的字段集合：确认码只覆盖用户这次要改的内容，和文件当前内容无关。 */
function changedValues(next, changes) {
  const out = {}
  for (const key of Object.keys(changes)) out[key] = next[key]
  return out
}

// ---- 复述文本 ----

function dateFromText(text) {
  const [year, month, day] = text.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatDate(dateText, now) {
  const date = dateFromText(dateText)
  const year = now && now.getFullYear() !== date.getFullYear() ? `${date.getFullYear()} 年 ` : ''
  return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日（${WEEKDAY_NAMES[date.getDay()]}）`
}

/** 估时文案统一走 schedule.js 的解析器，AI 工具不再只认 h/m。 */
function humanDuration(duration) {
  const minutes = durationMinutesOf(duration)
  if (minutes == null) return `约 ${duration}`
  return `约 ${humanMinutes(minutes)}`
}

/**
 * 一条日程的复述：`11 月 20 日（周五）10:00–11:00 —— 某公司终面（#面试 · 来源 对话）`。
 * 时间必须写成具体日期 + 星期 + 时刻，让用户确认时看得到真正会写进文件的内容。
 */
function describeLine(item, now) {
  const day = item.scheduled ?? item.due
  const clock = item.time ? item.time + (item.endTime ? `–${item.endTime}` : '') : ''
  let when
  if (clock && day) {
    when = `${formatDate(day, now)}${clock}`
  } else if (clock) {
    when = `${clock}（还没定哪天）`
  } else if (item.scheduled && item.due && item.scheduled !== item.due) {
    when = `计划 ${formatDate(item.scheduled, now)}，${formatDate(item.due, now)} 截止`
  } else if (item.scheduled) {
    when = `计划 ${formatDate(item.scheduled, now)}`
  } else if (item.due) {
    when = `${formatDate(item.due, now)} 截止`
  } else if (item.duration) {
    when = `没排期（${humanDuration(item.duration)}）`
  } else {
    when = '没排期'
  }
  const meta = []
  if (Array.isArray(item.tags) && item.tags.length) meta.push(item.tags.map(tag => `#${tag}`).join(' '))
  if (item.source) meta.push(`来源 ${item.source}`)
  if (item.location) meta.push(`地点 ${item.location}`)
  if (item.recurrence) meta.push(`🔁 ${item.recurrence}`)
  // 有日期 / 时刻时把父事项的预估放在括号里；没排期时 `when` 里已经写了，不重复。
  if (item.duration && (clock || item.scheduled || item.due)) meta.push(humanDuration(item.duration))
  const reminder = remindSummary(item)
  if (reminder) meta.push(reminder)
  if (Array.isArray(item.subtasks) && item.subtasks.length) {
    // 每一步带自己的预估，用户确认时能看到「写讲解稿（约 2 小时）」这样的拆分。
    const steps = item.subtasks.map(step => (step.duration
      ? `${step.title}（${humanDuration(step.duration)}）`
      : step.title))
    meta.push(`共 ${item.subtasks.length} 步：${steps.join('、')}`)
  }
  const suffix = meta.length ? `（${meta.join(' · ')}）` : ''
  return `${when} —— ${item.title || '(无标题)'}${suffix}`
}

// ---- 待确认状态（首页「识别到日程」#55 用） ----
async function readPendingEntries(ctx) {
  const value = await ctx.state.get(SCHEDULE_PENDING_KEY)
  return Array.isArray(value?.entries) ? value.entries : []
}

async function writePendingEntries(ctx, entries) {
  await ctx.state.set(SCHEDULE_PENDING_KEY, { entries })
}

function entryToken(entry) {
  return fingerprint('create', Array.isArray(entry?.items) ? entry.items : [])
}

async function currentVaultOrNull(ctx) {
  try {
    return await resolveVault(ctx)
  } catch (e) {
    if (e?.code === 'vault_unset' || e?.code === 'vault_missing') return null
    throw e
  }
}

/** 某次建日程复述后记下待确认结果；同一批内容重复复述只更新，不堆多条。 */
async function addPending(ctx, { items, source, token }) {
  const vault = await resolveVault(ctx)
  return withPendingLock(ctx, async () => {
    const entries = await readPendingEntries(ctx)
    const kept = entries.filter(entry => entry?.vault !== vault || entryToken(entry) !== token)
    const entry = {
      id: `sp-${randomBytes(4).toString('hex')}`,
      items: items.map(publicItem),
      source,
      createdAt: ctx.now().toISOString(),
      vault,
    }
    await writePendingEntries(ctx, [...kept, entry])
    return entry
  })
}

/** 执行成功后清掉和这次内容对应的待确认条目（其他批次 / 其他库不动）。 */
async function clearPending(ctx, token) {
  const vault = await currentVaultOrNull(ctx)
  if (!vault) return
  await withPendingLock(ctx, async () => {
    const entries = await readPendingEntries(ctx)
    const kept = entries.filter(entry => entry?.vault !== vault || entryToken(entry) !== token)
    if (kept.length !== entries.length) await writePendingEntries(ctx, kept)
  })
}

/**
 * 列出当前库的待确认日程（#55 卡片用）。别的库的条目不会串过来。
 * 提醒文案和预估分钟数在返回时按 ctx.now() 现算，卡片不再自己硬编码提醒时刻。
 */
export async function listPendingSchedules(ctx) {
  const vault = await currentVaultOrNull(ctx)
  if (!vault) return []
  const now = ctx.now()
  return withPendingLock(ctx, async () => {
    const entries = await readPendingEntries(ctx)
    return entries
      .filter(entry => entry?.vault === vault)
      .map(entry => ({
        ...entry,
        items: (Array.isArray(entry.items) ? entry.items : []).map(item => pendingItemView(item, now)),
      }))
  })
}

function pendingItemView(item, now) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const view = { ...item, reminderLabel: pendingReminderLabel(item, now) }
  const minutes = durationMinutesOf(item.duration)
  if (minutes != null) view.durationMinutes = minutes
  return view
}

/** 移除一条待确认日程（用户点「忽略」或卡片接受后调用）。 */
export async function removePendingSchedule(ctx, id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'id_invalid', '要说明移除哪一条待确认日程')
  const vault = await currentVaultOrNull(ctx)
  if (!vault) return { removed: false }
  return withPendingLock(ctx, async () => {
    const entries = await readPendingEntries(ctx)
    const index = entries.findIndex(entry => entry?.id === id && entry?.vault === vault)
    if (index < 0) return { removed: false }
    const [entry] = entries.splice(index, 1)
    await writePendingEntries(ctx, entries)
    return { removed: true, entry }
  })
}

const pendingLocks = new WeakMap()

function withPendingLock(ctx, fn) {
  const previous = pendingLocks.get(ctx) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  pendingLocks.set(ctx, next.then(() => {}, () => {}))
  return next
}

function requirePendingId(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'id_invalid', '要说明接受或忽略哪一条识别结果')
}

/** 接受失败时把还没写进去的条目放回待确认状态（已经写好的不重复建）。 */
async function restorePending(ctx, entry) {
  await withPendingLock(ctx, async () => {
    const entries = await readPendingEntries(ctx)
    if (entries.some(item => item?.id === entry.id)) return
    await writePendingEntries(ctx, [...entries, entry])
  })
}

/**
 * 首页卡片「加入日程」（#55）：把这条识别结果里的所有条目写进 `日程.md`。
 * 先从待确认状态里原子地取走条目，再逐条走 schedule.createItem 写入：
 * - 并发 / 连点两次时只有一次能取到条目，另一次回 404，不会重复写；
 * - 写到一半失败时把剩下的条目放回状态，已经建好的不会在重试时再建一遍。
 * 来源沿用这批识别的来源（现在都是「对话」，以后 QQ 邮箱识别也是同一条链路）。
 */
export async function acceptPendingSchedule(ctx, id) {
  requirePendingId(id)
  const vault = await currentVaultOrNull(ctx)
  if (!vault) throw new HttpError(409, 'vault_unset', '还没选 Obsidian 库，先选库再加入日程')

  const claimed = await removePendingSchedule(ctx, id)
  if (!claimed.removed) {
    throw new HttpError(404, 'schedule_pending_missing', '这条识别结果已经加入过或不存在，刷新后再看')
  }
  const entry = claimed.entry
  const source = entry.source || '对话'
  const items = Array.isArray(entry.items) ? entry.items : []
  const created = []
  let index = 0
  try {
    for (index = 0; index < items.length; index++) {
      const raw = items[index] && typeof items[index] === 'object' ? items[index] : {}
      const result = await createItem(ctx, { ...raw, source })
      created.push(result.item)
    }
  } catch (e) {
    if (index < items.length) {
      await restorePending(ctx, { ...entry, items: items.slice(index) }).catch(() => {})
    }
    if (e instanceof HttpError) throw e
    throw new HttpError(500, 'schedule_pending_accept_failed',
      `加入日程失败：${e?.message ?? e}。已经加入的不会重复，剩下的可以再点一次`)
  }

  return {
    entryId: entry.id,
    source,
    created: created.map(item => ({
      id: item.id,
      title: item.title,
      due: item.due,
      scheduled: item.scheduled,
      time: item.time,
      endTime: item.endTime,
      tags: item.tags,
      source: item.source,
    })),
  }
}

/**
 * 首页「识别到日程」卡片的 HTTP 接口（#55）。挂在 modules/index.js 里，
 * 和 schedule.register 一起注册；卡片列表只回当前库的条目。
 */
export function registerPendingScheduleRoutes(router, ctx) {
  router.get('/schedule/pending', async () => ({ entries: await listPendingSchedules(ctx) }))

  router.post('/schedule/pending/accept', async req => {
    const body = (await req.json()) ?? {}
    return acceptPendingSchedule(ctx, body.id)
  })

  router.post('/schedule/pending/dismiss', async req => {
    const body = (await req.json()) ?? {}
    const removed = await removePendingSchedule(ctx, body.id)
    if (!removed.removed) {
      throw new HttpError(404, 'schedule_pending_missing', '这条识别结果已经处理过或不存在，刷新后再看')
    }
    return { removed: true, entry: removed.entry }
  })
}

// ---- 执行函数 ----

/**
 * 建日程。第一次只复述（并记下待确认），带 confirmToken 才写 `日程.md`。
 * 一次可以建多条：一封邮件里有几轮面试就放几条。
 */
export async function createScheduleItems(ctx, { items, confirmToken } = {}) {
  const normalized = normalizeNewItems(ctx, items)
  const publicItems = normalized.map(publicItem)
  const token = fingerprint('create', publicItems)
  const now = ctx.now()
  const lines = publicItems.map(item => `· ${describeLine(item, now)}`)

  if (!confirmToken) {
    const source = publicItems.find(item => item.source)?.source ?? '对话'
    await addPending(ctx, { items: publicItems, source, token })
    return {
      confirmToken: token,
      text: [
        `识别到 ${publicItems.length} 条日程：`,
        ...lines,
        '',
        '还没加入日程。请把上面的列表原样复述给用户（日期 + 星期 + 时刻都要说清楚），并问「确认吗？」；',
        `用户确认后，用同样的 items 和 confirmToken: "${token}" 再调用一次才会真正写进 日程.md。用户要改就改完重新调用（不带 confirmToken）。`,
      ].join('\n'),
    }
  }
  if (confirmToken !== token) {
    throw new HttpError(409, 'confirm_mismatch',
      '确认码和这批日程对不上（内容改过或日期已变），还没建。请不带 confirmToken 重新调用，拿到新的复述给用户确认')
  }

  const created = []
  let index = 0
  try {
    for (index = 0; index < normalized.length; index++) {
      const result = await createItem(ctx, publicItem(normalized[index]))
      created.push(result.item)
    }
  } catch (e) {
    const done = created.length
      ? `已经建好的 ${created.length} 条：\n${created.map(item => `· ${describeLine(item, now)}（编号 ${item.id}）`).join('\n')}\n`
      : ''
    throw new HttpError(e?.status ?? 500, e?.code ?? 'schedule_create_failed',
      `${done}从「${normalized[index]?.title ?? '下一条'}」开始没建成：${e?.message ?? e}。已经建好的不会重复，没建成的可以重新确认后再建`)
  }

  // 日程已经写成功了，待确认状态清不掉（比如数据目录临时不可用）不该反过来报「没建成」。
  await clearPending(ctx, token).catch(() => {})
  const reminderErrors = created.filter(item => item.reminderError)
  const reminderCount = created.reduce((total, item) => total + (item.reminders?.length ?? 0), 0)
  const reminderLines = []
  if (reminderCount) reminderLines.push(`已建好 ${reminderCount} 封邮件提醒。`)
  for (const item of reminderErrors) {
    reminderLines.push(`· 「${item.title}」${item.reminderError}`)
  }
  return {
    created: created.map(item => ({
      id: item.id, title: item.title, due: item.due, time: item.time,
      ...(item.reminderError ? { reminderError: item.reminderError } : {}),
    })),
    reminderError: reminderErrors.length
      ? reminderErrors.map(item => `${item.title}：${item.reminderError}`).join('；')
      : null,
    text: [
      `已建好 ${created.length} 条日程：`,
      ...created.map(item => `· ${describeLine(item, now)}（编号 ${item.id}）`),
      ...(reminderLines.length ? ['', ...reminderLines] : []),
    ].join('\n'),
  }
}

/** 查日程。默认列出全部未完成；group 可选 overdue / today / week / later / unscheduled / done。 */
export async function listScheduleItems(ctx, { group = 'all' } = {}) {
  const wanted = group == null || group === '' ? 'all' : String(group)
  if (!GROUPS.includes(wanted)) {
    throw new HttpError(400, 'group_invalid', `group 只能是 ${GROUPS.join(' / ')}`)
  }
  const view = await loadSchedule(ctx)
  const now = ctx.now()
  if (!view.exists) {
    return { exists: false, items: [], done: [], text: `还没有日程（${SCHEDULE_PATH}），可以在对话里说「明天下午三点面试」让我建一条。` }
  }

  const renderItem = item => `· ${describeLine(item, now)}（编号 ${item.id}）`

  if (wanted === 'done') {
    const done = view.done
    return {
      exists: true,
      items: [],
      done,
      text: done.length
        ? [`已完成 ${done.length} 条（最近在前）：`, ...done.map(renderItem)].join('\n')
        : '还没有已完成的日程。',
    }
  }

  const groups = wanted === 'all'
    ? view.groups
    : view.groups.filter(entry => entry.key === wanted)
  const items = groups.flatMap(entry => entry.items)
  const blocks = []
  for (const entry of groups) {
    if (!entry.items.length) continue
    blocks.push(`${GROUP_LABELS[entry.key] ?? entry.key}（${entry.items.length} 条）：`)
    for (const item of entry.items) blocks.push(renderItem(item))
  }
  if (!blocks.length) {
    return { exists: true, items, done: [], text: wanted === 'all' ? '没有未完成的日程。' : `「${GROUP_LABELS[wanted] ?? wanted}」里没有日程。` }
  }
  return {
    exists: true,
    items,
    done: [],
    text: [`日程文件 ${SCHEDULE_PATH}（共 ${items.length} 条未完成）：`, ...blocks].join('\n'),
  }
}

/** 改日程：先复述旧内容和新内容，用户确认后按 id 合并写入。 */
export async function updateScheduleItem(ctx, { id, changes, confirmToken } = {}) {
  requireId(id)
  const now = ctx.now()
  const current = await findParsedItem(ctx, id, '修改')
  const next = applyItemChanges(current, changes)
  const token = fingerprint('update', { id, changes: changedValues(next, changes) })

  if (!confirmToken) {
    return {
      confirmToken: token,
      text: [
        `要修改编号 ${id} 的日程：`,
        `原来是：· ${describeLine(current, now)}`,
        `改成：· ${describeLine(next, now)}`,
        '',
        `还没改。请把上面的改动原样复述给用户（日期 + 星期 + 时刻都要说清楚）并问「确认吗？」；用户确认后，用同样的 id、changes 和 confirmToken: "${token}" 再调用一次才会真正写文件。用户要改就改完重新调用（不带 confirmToken）。`,
      ].join('\n'),
    }
  }
  if (confirmToken !== token) {
    throw new HttpError(409, 'confirm_mismatch',
      '确认码和这次修改对不上（内容改过或日期已变），还没改。请不带 confirmToken 重新调用，拿到新的复述给用户确认')
  }

  // 日程先保存；提醒同步失败只作为 warning 返回，不回滚。
  // updateItem 里按行合并写入，changes.subtasks 会整体替换子步骤行、保留说明行。
  const result = await updateItem(ctx, id, changes)
  const reminderNote = result.reminderError
    ? `\n提醒：${result.reminderError}`
    : (result.reminders?.length ? `\n已同步 ${result.reminders.length} 封邮件提醒。` : '')

  return {
    item: result.item,
    merged: result.merged,
    reminderError: result.reminderError ?? null,
    text: `已把编号 ${id} 的日程改成：\n· ${describeLine(result.item, now)}${reminderNote}`,
  }
}

/**
 * 完成 / 取消完成一条日程：同样先复述，确认后走 schedule.completeItem（和 HTTP 勾选同一条写入路径）。
 * 这样 AI 完成重复事项会生成下一条、完成最后一步子步骤会自动完成父事项，
 * 不会像以前那样只把 `- [ ]` 改成 `- [x]` 而漏掉这些语义。
 * 已经处于目标状态时返回空操作（安全、幂等），不再报 already_done / not_done。
 */
export async function completeScheduleItem(ctx, { id, done = true, confirmToken } = {}) {
  requireId(id)
  if (typeof done !== 'boolean') throw new HttpError(400, 'done_invalid', 'done 必须是 true 或 false')
  const now = ctx.now()
  const current = await findParsedItem(ctx, id, done ? '完成' : '取消完成')
  if (current.done === done) {
    return {
      alreadyDone: true,
      item: publicItem(current),
      autoCompleted: [],
      generated: null,
      merged: false,
      text: done
        ? `编号 ${id} 的日程已经是完成了，不用再完成：\n· ${describeLine(current, now)}（编号 ${id}）`
        : `编号 ${id} 的日程还没有完成，不用取消：\n· ${describeLine(current, now)}（编号 ${id}）`,
    }
  }
  const token = fingerprint('complete', { id, done })
  const action = done ? '标记为已完成' : '改回未完成'

  if (!confirmToken) {
    return {
      confirmToken: token,
      text: [
        `要把这条日程${action}：`,
        `· ${describeLine(current, now)}（编号 ${id}）`,
        '',
        `还没改。请把上面这条原样复述给用户并问「确认吗？」；用户确认后，用同样的 id、done 和 confirmToken: "${token}" 再调用一次才会真正写文件。`,
      ].join('\n'),
    }
  }
  if (confirmToken !== token) {
    throw new HttpError(409, 'confirm_mismatch',
      '确认码和这次操作对不上，还没改。请不带 confirmToken 重新调用，拿到新的复述给用户确认')
  }

  // AI 工具没有 baseVersion，仍按 id 合并写入；重复下一条和父事项自动完成都由这里统一处理。
  const result = await completeItem(ctx, id, done, null, { requireVersion: false })
  const generated = result.generated ?? null
  const autoCompleted = result.autoCompleted ?? []
  const extra = []
  if (generated) extra.push(`已生成下一条：${describeGenerated(generated, now)}（编号 ${generated.id}）`)
  if (autoCompleted.length) {
    extra.push(`已自动完成父事项：${autoCompleted.map(item => `「${item.title}」（编号 ${item.id}）`).join('、')}`)
  }

  return {
    item: result.item,
    merged: result.merged,
    autoCompleted,
    generated,
    text: [
      done
        ? `已完成：\n· ${describeLine(result.item, now)}（编号 ${id}）`
        : `已改回未完成：\n· ${describeLine(result.item, now)}（编号 ${id}）`,
      ...(extra.length ? ['', ...extra] : []),
    ].join('\n'),
  }
}

/** 重复下一条在工具结果里的简短描述。 */
function describeGenerated(item, now) {
  const day = item.scheduled ?? item.due
  const when = day ? formatDate(day, now) : '没排期'
  return `${when}${item.time ? ' ' + item.time : ''} —— ${item.title}`
}

/** 删除一条日程和它的子步骤：先复述，确认后按 id 重新定位再删。 */
export async function deleteScheduleItem(ctx, { id, confirmToken } = {}) {
  requireId(id)
  const now = ctx.now()
  const current = await findParsedItem(ctx, id, '删除')
  const token = fingerprint('delete', { id })
  const line = `· ${describeLine(current, now)}（编号 ${id}）`

  if (!confirmToken) {
    return {
      confirmToken: token,
      text: [
        '要删除这条日程：',
        line,
        '',
        `删除后不能恢复。还没删。请把这条原样复述给用户并问「确认删除吗？」；用户确认后，用同样的 id 和 confirmToken: "${token}" 再调用一次才会真正删除。`,
      ].join('\n'),
    }
  }
  if (confirmToken !== token) {
    throw new HttpError(409, 'confirm_mismatch',
      '确认码和要删除的日程对不上，还没删。请不带 confirmToken 重新调用，拿到新的复述给用户确认')
  }

  // 日程先删；提醒取消失败只作为 warning 返回，不回滚。
  const result = await deleteItem(ctx, id, null, { requireVersion: false })
  const reminderNote = result.reminderError ? `\n提醒：${result.reminderError}` : ''

  return {
    deleted: result.deleted,
    merged: result.merged,
    reminderError: result.reminderError ?? null,
    text: `已删除：\n${line}${reminderNote}`,
  }
}

// ---- 找目标行 ----

function requireId(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'id_invalid', '要说明是哪一条日程（用查日程拿到的编号）')
}

async function findParsedItem(ctx, id, action) {
  const view = await loadSchedule(ctx)
  if (!view.exists) throw new HttpError(404, 'schedule_missing', '还没有日程文件，先在首页或对话里建一条')
  const target = findInParsed(parseSchedule(view.content), id)
  if (!target) {
    throw new HttpError(404, 'schedule_item_missing', `日程里没有编号 ${id} 的这一条，没法${action}；可能刚被删掉，先查一下日程再试`)
  }
  return target
}

function findInParsed(parsed, id) {
  return flattenItems(parsed.items).find(item => item.id === id) ?? null
}

// ---- AI 工具定义 ----

function renderText(_args, value) {
  return [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : JSON.stringify(value) }]
}

function present(title) {
  return args => ({ card: 'generic', kind: 'other', title, rawInput: args })
}

function toolError(e) {
  return new Error(e?.message ?? String(e))
}

async function run(fn) {
  try {
    return await fn()
  } catch (e) {
    throw toolError(e)
  }
}

const SUBTASK_PROPERTIES = {
  title: { type: 'string', required: true, description: '子步骤标题，例如「写讲解稿」' },
  due: { type: 'string', description: '子步骤自己的截止日 YYYY-MM-DD；一般只写计划日' },
  scheduled: { type: 'string', description: '子步骤计划哪天做 YYYY-MM-DD；可以只给某一步排期' },
  time: { type: 'string', description: '子步骤开始时刻 HH:mm；一般不用填' },
  endTime: { type: 'string', description: '子步骤结束时刻 HH:mm；一般不用填' },
  duration: { type: 'string', description: '这一步的预估时长，例如 2h、90m、1 小时' },
  tags: { type: 'array', items: { type: 'string' }, description: '子步骤标签；一般不用填' },
  source: { type: 'string', description: '来源，默认跟父事项一致' },
}

const ITEM_PROPERTIES = {
  title: { type: 'string', required: true, description: '日程标题，例如「某公司终面」；面试要写清公司 / 轮次' },
  due: { type: 'string', description: '截止日 YYYY-MM-DD。面试 / 会议这类有具体时刻的事，把当天日期写在这里' },
  scheduled: { type: 'string', description: '计划日 YYYY-MM-DD（打算哪天做，不是截止日）；没有计划日就不填' },
  time: { type: 'string', description: '开始时刻 HH:mm（24 小时制，本机时区），例如 10:00' },
  endTime: { type: 'string', description: '结束时刻 HH:mm；面试、会议最好填上，例如 11:00' },
  duration: { type: 'string', description: '预估时长，例如 6h、90m、1h30m、6 小时；没排期的事用它表示大约要多久' },
  tags: { type: 'array', items: { type: 'string' }, description: '类别标签，例如 ["面试"]；没有就不填' },
  source: { type: 'string', description: '来源，默认「对话」；从对话里贴邮件解析出来的都写「对话」' },
  location: { type: 'string', description: '地点（面试 / 会议地址、腾讯会议号等）；没有就不填。会写进 %%beer loc=%% 并显示在待确认卡片上' },
  recurrence: { type: 'string', description: '重复规则（Tasks 写法），例如 every day、every week on Sunday、every month on 5' },
  remind: { type: 'string', description: '邮件提醒偏好：有具体时刻时默认 default（前一天 21:30 + 开始前 1 小时）；用户说「提前 N 分钟」写 30m / 60m；用户说「不提醒」写 off' },
  reminderId: { type: 'string', description: '关联的 Cloudflare Worker 提醒编号（#56 用），一般不用填' },
  articlePath: { type: 'string', description: '关联文章在库里的路径，例如 内容库/文章/某篇/index.md；一般不用填' },
  subtasks: {
    type: 'array',
    description: '把这件事拆成几步（缩进子任务）。用户说「拆一下步骤」时用；每步可以有自己的预估时长和计划日。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: SUBTASK_PROPERTIES,
    },
  },
}

const CHANGE_PROPERTIES = {
  ...ITEM_PROPERTIES,
  title: { type: 'string', description: '新的标题；不改就不填' },
}

export function scheduleToolDefinitions(ctx) {
  return [
    {
      name: 'beer_schedule_create',
      description: [
        '在 日程.md 里建日程（一次可以建多条）。用户说「记到日程」「加个日程」，或贴来面试 / 会议邮件时调用。',
        '面试邮件由你解析：一轮面试一条，把时间换算成 YYYY-MM-DD 和 HH:mm，地点、会议号写进 title，类别放 tags（如「面试」），来源默认「对话」。',
        '用户说「拆一下步骤」时用 items[].subtasks 把一件事拆成几步，每步可以有 duration 和 scheduled；没提日期就只写预估时长（进「没排期」）。',
        '有具体时刻的事项默认同时建邮件提醒（前一天 21:30 + 开始前 1 小时）：用户说「提前 30 分钟」时把 remind 写成 30m，说「不提醒」写成 off。',
        '必须分两步：第一次不带 confirmToken，只返回复述（具体日期 + 星期 + 时刻 + 提醒）和确认码，不会写文件；把复述原样给用户确认，用户说对之后再带 confirmToken 调用才真正写。',
        '不要在用户确认前带 confirmToken。',
      ].join(''),
      parameters: {
        items: {
          type: 'array',
          required: true,
          description: '要加的日程，一条一个；一封邮件里有几轮面试就放几条。',
          items: {
            type: 'object',
            additionalProperties: false, // 宿主要求嵌套对象明确写出，不写整个工具注册失败
            properties: ITEM_PROPERTIES,
          },
        },
        confirmToken: { type: 'string', description: '上一次调用返回的确认码。只有用户已经确认了复述内容才带上' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('建日程'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => createScheduleItems(ctx, args))
      },
    },
    {
      name: 'beer_schedule_list',
      description: [
        '查 日程.md 里的日程，返回日期、星期、时刻、标签、来源和编号。用户问「我最近有什么日程」「明天有什么事」时调用。',
        'group 不填时列出全部未完成；可以只看已逾期 / 今天 / 本周 / 以后 / 没排期，或 done 看已完成。',
        '改、完成、删除之前先用它拿到编号。',
      ].join(''),
      parameters: {
        group: { type: 'string', enum: GROUPS, description: 'all（默认）/ overdue / today / week / later / unscheduled / done' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('查日程'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => listScheduleItems(ctx, args))
      },
    },
    {
      name: 'beer_schedule_update',
      description: [
        '修改 日程.md 里的一条日程，用 beer_schedule_list 拿到的编号。',
        '改时间 / 标题 / 提醒偏好时会同步云端邮件提醒（旧提醒取消、按新时间重建）；提醒服务连不上时日程照常改，结果里会说明「提醒没改成」。',
        '必须分两步：第一次不带 confirmToken，只返回「原来是 / 改成」的复述和确认码，不会写文件；用户确认后再带同一个 confirmToken 调用才真正改。',
        'changes 里只放要改的字段；把时间改成具体日期 + 星期 + 时刻让用户确认。',
        '用户说「把这件事拆成几步」时，用 changes.subtasks 给出完整的新步骤列表（会整体替换原来的子步骤）；只加一步也可以用这个字段列出全部步骤。',
      ].join(''),
      parameters: {
        id: { type: 'string', required: true, description: '日程编号（beer_schedule_list 返回的 id）' },
        changes: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: CHANGE_PROPERTIES,
        },
        confirmToken: { type: 'string', description: '上一次调用返回的确认码。只有用户已经确认了复述内容才带上' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('改日程'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => updateScheduleItem(ctx, args))
      },
    },
    {
      name: 'beer_schedule_complete',
      description: [
        '把 日程.md 里的一条待办标记为已完成（写 - [x] 和 ✅ 日期），或者用 done: false 改回未完成。',
        '完成重复事项会生成下一条，完成最后一步子步骤会自动完成父事项；结果里会说明。',
        '必须分两步：第一次不带 confirmToken，只返回复述和确认码，不会写文件；用户确认后再带同一个 confirmToken 调用才真正改。',
      ].join(''),
      parameters: {
        id: { type: 'string', required: true, description: '日程编号（beer_schedule_list 返回的 id）' },
        done: { type: 'boolean', description: 'true（默认）标记完成，false 取消完成' },
        confirmToken: { type: 'string', description: '上一次调用返回的确认码。只有用户已经确认了复述内容才带上' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('完成日程'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => completeScheduleItem(ctx, args))
      },
    },
    {
      name: 'beer_schedule_delete',
      description: [
        '从 日程.md 删除一条日程（连同它的子步骤）。用户说「删掉那个日程」「不去了」时调用。',
        '必须分两步：第一次不带 confirmToken，只返回要删除的内容和确认码，不会删；用户确认后再带同一个 confirmToken 调用才真正删。删除后不能恢复。',
      ].join(''),
      parameters: {
        id: { type: 'string', required: true, description: '日程编号（beer_schedule_list 返回的 id）' },
        confirmToken: { type: 'string', description: '上一次调用返回的确认码。只有用户已经确认了复述内容才带上' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('删除日程'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return run(() => deleteScheduleItem(ctx, args))
      },
    },
  ]
}

/**
 * 注册五个日程工具；defineTool 测试里可以传假的。返回注销函数。
 * 每个工具单独注册：一个定义被宿主拒绝时不连累另外四个，错误打到宿主日志。
 */
export async function registerScheduleTools(toolsCtx, ctx, defineTool, log = console.error) {
  const define = defineTool ?? (await import('@deepseek-ai/dsh-tools')).defineTool
  const disposers = []
  for (const definition of scheduleToolDefinitions(ctx)) {
    try {
      disposers.push(toolsCtx.tools.register(define(definition)))
    } catch (e) {
      log(`[beer] 注册工具 ${definition.name} 失败：${e?.message ?? e}`)
    }
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}
