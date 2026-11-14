// 首页「识别到日程」卡片（#55）的 HTTP 接口：
//   GET  /schedule/pending          列出当前库的待确认识别结果
//   POST /schedule/pending/accept   整批写进 日程.md 并清掉待确认
//   POST /schedule/pending/dismiss  只清掉待确认，不写文件
// 只通过 HTTP 调用，状态由 #53 的建日程预览写入（schedule-pending）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createScheduleItems,
  SCHEDULE_PENDING_KEY,
} from '../src/modules/schedule-tools.js'
import { startBeer } from './helpers/beer.js'

const SCHEDULE = '日程.md'
// 2026-11-12（周四）10:00；11-18 周三，11-20 周五。
const NOW = () => new Date('2026-11-12T10:00:00')

const INTERVIEWS = [
  {
    title: '某公司终面',
    due: '2026-11-20',
    time: '10:00',
    endTime: '11:00',
    tags: ['面试'],
  },
  {
    title: '另一家公司一面',
    due: '2026-11-18',
    time: '14:00',
    endTime: '15:00',
    tags: ['面试'],
  },
]

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

async function pendingEntries(beer) {
  const res = await beer.api('GET', '/schedule/pending')
  assert.equal(res.status, 200)
  return res.body.entries
}

test('待确认日程：没有识别结果或还没选库时返回空列表', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  assert.deepEqual(await pendingEntries(beer), [])

  const noVault = await startBeer(t, { vault: false, now: NOW })
  assert.deepEqual(await pendingEntries(noVault), [])
})

test('待确认日程：只列当前库的条目，条目形状和 #53 写入的一致', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  await createScheduleItems(beer.context, { items: INTERVIEWS })

  const entries = await pendingEntries(beer)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'id', 'items', 'source', 'vault'])
  assert.match(entry.id, /^sp-[0-9a-f]+$/)
  assert.equal(entry.vault, beer.vault)
  assert.equal(entry.source, '对话')
  assert.equal(entry.createdAt, NOW().toISOString())
  assert.deepEqual(entry.items.map(item => item.title), ['某公司终面', '另一家公司一面'])
  assert.equal(entry.items[0].due, '2026-11-20')
  assert.equal(entry.items[0].time, '10:00')
  assert.equal(entry.items[0].endTime, '11:00')

  // 数据目录里的状态是跨库共享的：别的库的条目不能出现在当前库的卡片里。
  await beer.context.state.set(SCHEDULE_PENDING_KEY, {
    entries: [
      ...entries,
      {
        id: 'sp-other-vault',
        items: [{ title: '别的库的日程', source: '对话' }],
        source: '对话',
        createdAt: NOW().toISOString(),
        vault: 'C:\\另一个库',
      },
    ],
  })
  assert.deepEqual((await pendingEntries(beer)).map(item => item.id), [entry.id])
})

test('加入日程：一次接受把整批条目写进 日程.md，来源是对话，并清掉待确认', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  await createScheduleItems(beer.context, { items: INTERVIEWS })
  const [entry] = await pendingEntries(beer)

  const res = await beer.api('POST', '/schedule/pending/accept', { id: entry.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.entryId, entry.id)
  assert.equal(res.body.source, '对话')
  assert.deepEqual(res.body.created.map(item => item.title), ['某公司终面', '另一家公司一面'])
  assert.match(res.body.created[0].id, /^[0-9a-f]{10}$/)
  assert.equal(res.body.created[0].source, '对话')

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  const rows = content.trimEnd().split('\n')
  assert.equal(rows.length, 2)
  // #56：接受流程复用 schedule.createItem，有时刻的条目默认带 remind=default。
  assert.match(rows[0], /^- \[ \] 10:00–11:00 某公司终面 #面试 %%beer id=[0-9a-f]{10} src=对话 remind=default%% 📅 2026-11-20$/)
  assert.match(rows[1], /^- \[ \] 14:00–15:00 另一家公司一面 #面试 %%beer id=[0-9a-f]{10} src=对话 remind=default%% 📅 2026-11-18$/)

  assert.deepEqual(await pendingEntries(beer), [], '接受成功后卡片里这条消失')
})

test('加入日程：连点两次只写一份（并发也只成功一次），第二次报 404', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  await createScheduleItems(beer.context, { items: INTERVIEWS })
  const [entry] = await pendingEntries(beer)

  const clicks = await Promise.all([
    beer.api('POST', '/schedule/pending/accept', { id: entry.id }),
    beer.api('POST', '/schedule/pending/accept', { id: entry.id }),
  ])
  assert.deepEqual(clicks.map(res => res.status).sort(), [200, 404])
  const failed = clicks.find(res => res.status === 404)
  assert.equal(failed.body.error.code, 'schedule_pending_missing')
  assert.match(failed.body.error.message, /已经|不存在|处理过/)

  const content = await readFile(join(beer.vault, SCHEDULE), 'utf8')
  assert.equal(content.trimEnd().split('\n').length, 2, '两条日程各写了一次，没有重复')

  const again = await beer.api('POST', '/schedule/pending/accept', { id: entry.id })
  assert.equal(again.status, 404)
  assert.equal(await readFile(join(beer.vault, SCHEDULE), 'utf8'), content)
})

test('忽略：只清掉待确认状态，不写 日程.md', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  await createScheduleItems(beer.context, { items: INTERVIEWS })
  const [entry] = await pendingEntries(beer)

  const res = await beer.api('POST', '/schedule/pending/dismiss', { id: entry.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.removed, true)
  assert.equal(res.body.entry.id, entry.id)
  assert.equal(await exists(join(beer.vault, SCHEDULE)), false, '忽略不能写日程文件')
  assert.deepEqual(await pendingEntries(beer), [], '忽略后卡片里这条消失')
})

test('未知或缺少 id：接受和忽略都给出明确错误', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const acceptMissing = await beer.api('POST', '/schedule/pending/accept', { id: 'sp-missing' })
  assert.equal(acceptMissing.status, 404)
  assert.equal(acceptMissing.body.error.code, 'schedule_pending_missing')
  assert.match(acceptMissing.body.error.message, /处理过|不存在/)

  const dismissMissing = await beer.api('POST', '/schedule/pending/dismiss', { id: 'sp-missing' })
  assert.equal(dismissMissing.status, 404)
  assert.equal(dismissMissing.body.error.code, 'schedule_pending_missing')

  const acceptNoId = await beer.api('POST', '/schedule/pending/accept', {})
  assert.equal(acceptNoId.status, 400)
  assert.equal(acceptNoId.body.error.code, 'id_invalid')

  const dismissNoId = await beer.api('POST', '/schedule/pending/dismiss', { id: '' })
  assert.equal(dismissNoId.status, 400)
  assert.equal(dismissNoId.body.error.code, 'id_invalid')

  assert.equal(await exists(join(beer.vault, SCHEDULE)), false)
})
