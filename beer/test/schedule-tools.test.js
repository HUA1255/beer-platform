// 日程 AI 工具（#53）：建 / 查 / 改 / 完成 / 删除，以及两步确认和「识别到日程」待确认状态。
// 不经过宿主，直接调 schedule-tools.js 的执行函数；宿主的 defineTool 用假实现验证参数形状。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createScheduleItems,
  listScheduleItems,
  updateScheduleItem,
  completeScheduleItem,
  deleteScheduleItem,
  registerScheduleTools,
  listPendingSchedules,
  removePendingSchedule,
  SCHEDULE_PENDING_KEY,
} from '../src/modules/schedule-tools.js'
import { startBeer } from './helpers/beer.js'

const SCHEDULE = '日程.md'
// 2026-11-12（周四）10:00，本机时区；11-18 周三，11-20 周五。
const NOW = () => new Date('2026-11-12T10:00:00')

const INTERVIEWS = [
  {
    title: '某公司终面',
    due: '2026-11-20',
    time: '10:00',
    endTime: '11:00',
    tags: ['面试'],
    source: '对话',
  },
  {
    title: '另一家公司一面',
    due: '2026-11-18',
    time: '14:00',
    endTime: '15:00',
    tags: ['面试'],
  },
]

const lines = (...rows) => rows.join('\n') + '\n'

function itemLine(over = {}) {
  const item = {
    box: '[ ]',
    time: '',
    title: '某件事',
    tags: [],
    beer: '',
    tasks: '',
    ...over,
  }
  return `- ${item.box} ${item.time ? item.time + ' ' : ''}${item.title}`
    + (item.tags.length ? ' ' + item.tags.map(tag => '#' + tag).join(' ') : '')
    + (item.beer ? ` %%beer ${item.beer}%%` : '')
    + (item.tasks ? ' ' + item.tasks : '')
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

/** 宿主 defineTool 的硬性要求：嵌套对象写 additionalProperties: false，output 带 schema 和 render。 */
function assertHostSchema(definition) {
  assert.equal(typeof definition.name, 'string')
  assert.equal(typeof definition.description, 'string')
  assert.equal(typeof definition.parameters, 'object')
  assert.equal(definition.output?.schema?.type, 'json')
  assert.equal(typeof definition.output?.render, 'function')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.presentCall, 'function')

  const walk = (prop, path) => {
    if (prop.required !== undefined) assert.equal(typeof prop.required, 'boolean', `${path}.required`)
    assert.equal(typeof prop.type, 'string', `${path}.type`)
    if (prop.type === 'object') {
      assert.equal(prop.additionalProperties, false, `${path} 必须写 additionalProperties: false`)
      assert.equal(typeof prop.properties, 'object', `${path}.properties`)
      for (const [key, child] of Object.entries(prop.properties)) walk(child, `${path}.properties.${key}`)
    }
    if (prop.type === 'array') {
      assert.equal(typeof prop.items, 'object', `${path}.items`)
      if (prop.items.type === 'object') walk(prop.items, `${path}.items`)
      else assert.equal(typeof prop.items.type, 'string', `${path}.items.type`)
    }
  }
  for (const [key, prop] of Object.entries(definition.parameters)) walk(prop, `parameters.${key}`)
}

const hostDefineTool = definition => {
  assertHostSchema(definition)
  return definition
}

test('建日程：第一次只复述并记下待确认，不写日程文件', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const file = join(beer.vault, SCHEDULE)

  const preview = await createScheduleItems(beer.context, { items: INTERVIEWS })

  assert.equal(await exists(file), false, '复述阶段不能写 日程.md')
  assert.ok(preview.confirmToken)
  assert.match(preview.text, /识别到 2 条日程/)
  assert.match(preview.text, /11 月 20 日（周五）10:00–11:00 —— 某公司终面/)
  assert.match(preview.text, /11 月 18 日（周三）14:00–15:00 —— 另一家公司一面/)
  assert.match(preview.text, /确认吗/)
  assert.doesNotMatch(preview.text, /已建好/)

  const pending = await listPendingSchedules(beer.context)
  assert.equal(pending.length, 1)
  assert.deepEqual(Object.keys(pending[0]).sort(), ['createdAt', 'id', 'items', 'source', 'vault'])
  assert.match(pending[0].id, /^sp-[0-9a-f]+$/)
  assert.equal(pending[0].vault, beer.vault)
  assert.equal(pending[0].source, '对话')
  assert.equal(pending[0].createdAt, NOW().toISOString())
  assert.deepEqual(pending[0].items.map(item => item.title), ['某公司终面', '另一家公司一面'])
  assert.equal(pending[0].items[1].source, '对话', '没写来源时默认「对话」')

  // 状态写在数据目录里，键名符合 /^[a-z0-9-]+$/。
  const state = JSON.parse(await readFile(join(beer.dataDir, `${SCHEDULE_PENDING_KEY}.json`), 'utf8'))
  assert.equal(state.entries.length, 1)
})

test('建日程：一次确认建多条，写进 日程.md 并清掉待确认', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const preview = await createScheduleItems(beer.context, { items: INTERVIEWS })

  const done = await createScheduleItems(beer.context, {
    items: INTERVIEWS,
    confirmToken: preview.confirmToken,
  })

  assert.match(done.text, /已建好 2 条日程/)
  assert.equal(done.created.length, 2)
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  const rows = content.trimEnd().split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows[0], /^- \[ \] 10:00–11:00 某公司终面 #面试 %%beer id=[0-9a-f]{10} src=对话 remind=default%% 📅 2026-11-20$/)
  assert.match(rows[1], /^- \[ \] 14:00–15:00 另一家公司一面 #面试 %%beer id=[0-9a-f]{10} src=对话 remind=default%% 📅 2026-11-18$/)

  assert.deepEqual(await listPendingSchedules(beer.context), [], '执行成功后清掉待确认')
})

test('建日程：接受计划日、预估时长、重复规则、提醒编号和关联文章，写回 Tasks 字段', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const item = {
    title: '整理本周素材',
    scheduled: '2026-11-13',
    duration: '2h',
    recurrence: 'every week on Sunday',
    reminderId: 'r1',
    articlePath: '内容库/文章/素材整理/index.md',
    tags: ['整理'],
  }

  const preview = await createScheduleItems(beer.context, { items: [item] })
  assert.match(preview.text, /计划 11 月 13 日（周五）/)
  assert.match(preview.text, /约 2 小时/)
  assert.match(preview.text, /🔁 every week on Sunday/)

  await createScheduleItems(beer.context, { items: [item], confirmToken: preview.confirmToken })
  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  // #51 起新写入的事项把 🔁 放在日期字段前面（FIELD_ORDER = recurrence, due, scheduled, …）。
  assert.match(content, /^- \[ \] 整理本周素材 #整理 %%beer id=[0-9a-f]{10} src=对话 reminder=r1 article=内容库\/文章\/素材整理\/index\.md%% 🔁 every week on Sunday ⏳ 2026-11-13 ⏱ 2h$/m)
})

test('建日程：不带确认码或确认码对不上时不写文件', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const file = join(beer.vault, SCHEDULE)

  const again = await createScheduleItems(beer.context, { items: INTERVIEWS })
  assert.ok(again.confirmToken)
  assert.equal(await exists(file), false, '不带确认码只重新复述')

  await assert.rejects(
    createScheduleItems(beer.context, { items: INTERVIEWS, confirmToken: 'made-up' }),
    e => e.status === 409 && e.code === 'confirm_mismatch' && /对不上/.test(e.message),
  )
  assert.equal(await exists(file), false)

  // 复述之后改了内容，旧确认码也失效。
  const changed = [INTERVIEWS[0], { ...INTERVIEWS[1], due: '2026-11-19' }]
  await assert.rejects(
    createScheduleItems(beer.context, { items: changed, confirmToken: again.confirmToken }),
    /对不上/,
  )
  assert.equal(await exists(file), false)
})

test('查日程：按分组列出时间、星期、编号和来源；没有文件时给空说明', async t => {
  const empty = await startBeer(t, { vault: {}, now: NOW })
  const none = await listScheduleItems(empty.context, {})
  assert.equal(none.exists, false)
  assert.match(none.text, /还没有日程/)

  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        itemLine({ time: '14:00–15:00', title: '某公司一面', tags: ['面试'], beer: 'id=a1 src=对话', tasks: '📅 2026-11-12' }),
        itemLine({ title: '交专栏稿', beer: 'id=b2 src=快速添加', tasks: '📅 2026-11-13' }),
        itemLine({ title: '做讲解视频', beer: 'id=c3 src=对话', tasks: '⏱ 6h' }),
      ),
    },
    now: NOW,
  })

  const all = await listScheduleItems(beer.context, {})
  assert.equal(all.exists, true)
  assert.match(all.text, /今天/)
  assert.match(all.text, /14:00.*某公司一面.*编号 a1/)
  assert.match(all.text, /11 月 13 日（周五）.*交专栏稿.*编号 b2/)
  assert.match(all.text, /做讲解视频.*编号 c3/)

  const today = await listScheduleItems(beer.context, { group: 'today' })
  assert.match(today.text, /某公司一面/)
  assert.doesNotMatch(today.text, /交专栏稿/)
})

test('改日程：先复述旧内容和新内容，确认后才写；确认码对不上不写', async t => {
  const original = lines(
    itemLine({ time: '14:00–15:00', title: '某公司一面', tags: ['面试'], beer: 'id=a1 src=对话', tasks: '📅 2026-11-18' }),
    itemLine({ title: '交专栏稿', beer: 'id=b2 src=快速添加', tasks: '📅 2026-11-13' }),
  )
  const beer = await startBeer(t, { vault: { [SCHEDULE]: original }, now: NOW })
  const file = join(beer.vault, SCHEDULE)

  const changes = { title: '某公司终面', due: '2026-11-20', time: '10:00', endTime: '11:00' }
  const preview = await updateScheduleItem(beer.context, { id: 'a1', changes })

  assert.equal(await readFile(file, 'utf8'), original, '复述阶段不能写')
  assert.ok(preview.confirmToken)
  assert.match(preview.text, /11 月 20 日（周五）10:00–11:00 —— 某公司终面/)
  assert.match(preview.text, /原来是/)
  assert.match(preview.text, /某公司一面/)

  await assert.rejects(
    updateScheduleItem(beer.context, { id: 'a1', changes: { title: '别的' }, confirmToken: preview.confirmToken }),
    /对不上/,
  )
  assert.equal(await readFile(file, 'utf8'), original)

  const done = await updateScheduleItem(beer.context, { id: 'a1', changes, confirmToken: preview.confirmToken })
  assert.match(done.text, /已把/) 
  assert.equal(await readFile(file, 'utf8'), lines(
    itemLine({ time: '10:00–11:00', title: '某公司终面', tags: ['面试'], beer: 'id=a1 src=对话 remind=default', tasks: '📅 2026-11-20' }),
    itemLine({ title: '交专栏稿', beer: 'id=b2 src=快速添加', tasks: '📅 2026-11-13' }),
  ))
})

test('改日程：确认前后 Obsidian 改了文件，执行时按 id 合并，不覆盖别的行', async t => {
  const beer = await startBeer(t, {
    vault: {
      [SCHEDULE]: lines(
        itemLine({ time: '14:00–15:00', title: '某公司一面', beer: 'id=a1 src=对话', tasks: '📅 2026-11-18' }),
      ),
    },
    now: NOW,
  })
  const file = join(beer.vault, SCHEDULE)

  const preview = await updateScheduleItem(beer.context, {
    id: 'a1',
    changes: { due: '2026-11-20', time: '10:00', endTime: '11:00' },
  })

  // 复述之后，用户在手机 Obsidian 里改了标题、加了一条。
  await writeFile(file, lines(
    itemLine({ time: '14:00–15:00', title: '某公司一面（Obsidian 改过）', beer: 'id=a1 src=对话', tasks: '📅 2026-11-18' }),
    itemLine({ title: '新加的一条', beer: 'id=new src=快速添加', tasks: '📅 2026-11-15' }),
  ))

  const done = await updateScheduleItem(beer.context, {
    id: 'a1',
    changes: { due: '2026-11-20', time: '10:00', endTime: '11:00' },
    confirmToken: preview.confirmToken,
  })

  assert.match(done.text, /已把/)
  assert.equal(await readFile(file, 'utf8'), lines(
    itemLine({ time: '10:00–11:00', title: '某公司一面（Obsidian 改过）', beer: 'id=a1 src=对话 remind=default', tasks: '📅 2026-11-20' }),
    itemLine({ title: '新加的一条', beer: 'id=new src=快速添加', tasks: '📅 2026-11-15' }),
  ))
})

test('完成日程：先复述，确认后写 - [x] 和 ✅ 日期；不带确认码不写', async t => {
  const original = lines(
    itemLine({ time: '09:00', title: '看读者留言', beer: 'id=a1 src=对话', tasks: '📅 2026-11-12' }),
  )
  const beer = await startBeer(t, { vault: { [SCHEDULE]: original }, now: NOW })
  const file = join(beer.vault, SCHEDULE)

  const preview = await completeScheduleItem(beer.context, { id: 'a1' })
  assert.match(preview.text, /标记为已完成/)
  assert.match(preview.text, /09:00.*看读者留言/)
  assert.equal(await readFile(file, 'utf8'), original)

  await assert.rejects(completeScheduleItem(beer.context, { id: 'a1', confirmToken: 'bad' }), /对不上/)
  assert.equal(await readFile(file, 'utf8'), original)

  const done = await completeScheduleItem(beer.context, { id: 'a1', confirmToken: preview.confirmToken })
  assert.match(done.text, /已完成/)
  assert.equal(await readFile(file, 'utf8'), lines(
    itemLine({ box: '[x]', time: '09:00', title: '看读者留言', beer: 'id=a1 src=对话', tasks: '📅 2026-11-12 ✅ 2026-11-12' }),
  ))
})

test('删除日程：先复述再删；确认后 Obsidian 新加的行仍保留', async t => {
  const original = lines(
    itemLine({ time: '14:00–15:00', title: '某公司一面', beer: 'id=a1 src=对话', tasks: '📅 2026-11-18' }),
    itemLine({ title: '交专栏稿', beer: 'id=b2 src=快速添加', tasks: '📅 2026-11-13' }),
  )
  const beer = await startBeer(t, { vault: { [SCHEDULE]: original }, now: NOW })
  const file = join(beer.vault, SCHEDULE)

  const preview = await deleteScheduleItem(beer.context, { id: 'a1' })
  assert.match(preview.text, /要删除/)
  assert.match(preview.text, /14:00–15:00.*某公司一面.*编号 a1/)
  assert.equal(await readFile(file, 'utf8'), original)

  await assert.rejects(deleteScheduleItem(beer.context, { id: 'a1', confirmToken: 'bad' }), /对不上/)
  assert.equal(await readFile(file, 'utf8'), original)

  await writeFile(file, lines(
    itemLine({ time: '14:00–15:00', title: '某公司一面（改过）', beer: 'id=a1 src=对话', tasks: '📅 2026-11-18' }),
    itemLine({ title: '交专栏稿', beer: 'id=b2 src=快速添加', tasks: '📅 2026-11-13' }),
    itemLine({ title: 'Obsidian 新加的一条', beer: 'id=new src=快速添加', tasks: '📅 2026-11-15' }),
  ))

  const done = await deleteScheduleItem(beer.context, { id: 'a1', confirmToken: preview.confirmToken })
  assert.match(done.text, /已删除/)
  assert.equal(await readFile(file, 'utf8'), lines(
    itemLine({ title: '交专栏稿', beer: 'id=b2 src=快速添加', tasks: '📅 2026-11-13' }),
    itemLine({ title: 'Obsidian 新加的一条', beer: 'id=new src=快速添加', tasks: '📅 2026-11-15' }),
  ))
})

test('待确认状态：列出和移除（供 #55 首页卡片接受 / 忽略），按库过滤', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const first = await createScheduleItems(beer.context, { items: [INTERVIEWS[0]] })
  const second = await createScheduleItems(beer.context, { items: [INTERVIEWS[1]] })
  assert.ok(first.confirmToken)
  assert.ok(second.confirmToken)

  const pending = await listPendingSchedules(beer.context)
  assert.equal(pending.length, 2)

  const removed = await removePendingSchedule(beer.context, pending[0].id)
  assert.equal(removed.removed, true)
  const left = await listPendingSchedules(beer.context)
  assert.deepEqual(left.map(entry => entry.id), [pending[1].id])

  assert.deepEqual(await removePendingSchedule(beer.context, 'sp-missing'), { removed: false })
  await removePendingSchedule(beer.context, pending[1].id)
  assert.deepEqual(await listPendingSchedules(beer.context), [])
})

test('注册：五个工具的形状符合宿主 defineTool 要求，一个失败不连累其他', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const registered = []
  const toolsCtx = { tools: { register: definition => (registered.push(definition), () => {}) } }

  const dispose = await registerScheduleTools(toolsCtx, beer.context, hostDefineTool)
  assert.deepEqual(registered.map(tool => tool.name), [
    'beer_schedule_create',
    'beer_schedule_list',
    'beer_schedule_update',
    'beer_schedule_complete',
    'beer_schedule_delete',
  ])

  const [create, list, update, complete, remove] = registered
  assert.equal(create.parameters.items.type, 'array')
  assert.equal(create.parameters.items.required, true)
  assert.equal(create.parameters.items.items.additionalProperties, false)
  assert.equal(create.parameters.items.items.properties.title.required, true)
  assert.match(create.description, /两步|确认/)
  assert.match(create.description, /面试/)
  assert.equal(typeof create.output.render, 'function')
  assert.deepEqual(create.output.render(null, { text: '复述文本' }), [{ type: 'text', text: '复述文本' }])
  assert.equal(create.presentCall({}).title, '建日程')

  assert.deepEqual(Object.keys(list.parameters), ['group'])
  assert.equal(update.parameters.id.required, true)
  assert.equal(update.parameters.changes.additionalProperties, false)
  assert.equal(update.parameters.changes.properties.title.required, undefined)
  assert.equal(complete.parameters.id.required, true)
  assert.equal(remove.parameters.id.required, true)

  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.presentCall({}).card, 'generic')
    assert.equal(tool.presentCall({}).kind, 'other')
  }

  dispose()
})

test('注册：宿主拒绝一个定义时其他照常注册，并记 [beer] 日志', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const registered = []
  const logs = []
  const toolsCtx = { tools: { register: definition => (registered.push(definition.name), () => {}) } }
  const strict = definition => {
    if (definition.name === 'beer_schedule_create') throw new Error('unsupported JSON schema')
    return hostDefineTool(definition)
  }

  await registerScheduleTools(toolsCtx, beer.context, strict, line => logs.push(line))

  assert.deepEqual(registered, [
    'beer_schedule_list',
    'beer_schedule_update',
    'beer_schedule_complete',
    'beer_schedule_delete',
  ])
  assert.match(logs[0], /\[beer\] 注册工具 beer_schedule_create 失败/)
})
