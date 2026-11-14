// 日程快速添加（#50）：一句话 → 一条日程。
// 两层接口：导出的 parseQuickAdd（#54 会在这上面加预估时长 / 计划日）和
// POST /schedule/quick-add（解析 + 按行合并写入 日程.md）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseQuickAdd, SCHEDULE_PATH } from '../src/modules/schedule.js'
import { startBeer } from './helpers/beer.js'

/** 固定在本机时区的 2026-11-12（周四）10:00；本周一 11-09，本周日 11-15。 */
const NOW = () => new Date('2026-11-12T10:00:00')

test('parseQuickAdd：周五前 → 本周五截止，标题去掉日期短语', () => {
  const parsed = parseQuickAdd('周五前交专栏稿', NOW())

  assert.equal(parsed.title, '交专栏稿')
  assert.equal(parsed.due, '2026-11-13')
  assert.equal(parsed.scheduled, null)
  assert.equal(parsed.time, null)
  assert.equal(parsed.source, '快速添加')
})

test('parseQuickAdd：明天 14:00 → 明天截止 + 时刻，标题去掉日期和时间', () => {
  const parsed = parseQuickAdd('明天 14:00 和编辑开会', NOW())

  assert.equal(parsed.title, '和编辑开会')
  assert.equal(parsed.due, '2026-11-13')
  assert.equal(parsed.time, '14:00')

  // 解析器只识别日期 / 时刻：只剩时间也给出结果（接口会拒绝没有标题的句子）。
  const timeOnly = parseQuickAdd('明天 14:00', NOW())
  assert.equal(timeOnly.title, '')
  assert.equal(timeOnly.due, '2026-11-13')
  assert.equal(timeOnly.time, '14:00')
})

test('parseQuickAdd：没提日期 → 日期和时刻都为空，标题原样', () => {
  const parsed = parseQuickAdd('做一期讲解视频', NOW())

  assert.equal(parsed.title, '做一期讲解视频')
  assert.equal(parsed.due, null)
  assert.equal(parsed.time, null)
  assert.equal(parsed.source, '快速添加')
})

test('parseQuickAdd：只写时刻时按今天算，方便直接记今天的事', () => {
  const parsed = parseQuickAdd('14:00 和编辑开会', NOW())

  assert.equal(parsed.title, '和编辑开会')
  assert.equal(parsed.due, '2026-11-12')
  assert.equal(parsed.time, '14:00')
})

test('parseQuickAdd：支持今天 / 后天 / 周一 / 本周X / 下周X', () => {
  assert.equal(parseQuickAdd('今天交稿', NOW()).due, '2026-11-12')
  assert.equal(parseQuickAdd('后天交稿', NOW()).due, '2026-11-14')
  // 单独的「周一」是下一个周一（今天周四）。
  assert.equal(parseQuickAdd('周一交稿', NOW()).due, '2026-11-16')
  assert.equal(parseQuickAdd('本周一交稿', NOW()).due, '2026-11-09')
  assert.equal(parseQuickAdd('下周一交稿', NOW()).due, '2026-11-16')
  assert.equal(parseQuickAdd('周日交稿', NOW()).due, '2026-11-15')
})

test('parseQuickAdd：支持 2026-11-20 / 11-20 / 11月20日；没写年份且已过时算下一年', () => {
  assert.equal(parseQuickAdd('2026-12-01 交稿', NOW()).due, '2026-12-01')
  assert.equal(parseQuickAdd('11-20 交稿', NOW()).due, '2026-11-20')
  assert.equal(parseQuickAdd('11月20日交稿', NOW()).due, '2026-11-20')
  // 11-12 是今天，不算过去；11-01 已经过去，按明年的 11-01 算。
  assert.equal(parseQuickAdd('11-12 交稿', NOW()).due, '2026-11-12')
  assert.equal(parseQuickAdd('11-01 交稿', NOW()).due, '2027-11-01')

  const parsed = parseQuickAdd('11月20日交稿', NOW())
  assert.equal(parsed.title, '交稿')
})

test('parseQuickAdd：日期短语在句尾或带逗号也能去掉', () => {
  assert.equal(parseQuickAdd('交专栏稿，周五前', NOW()).title, '交专栏稿')
  assert.equal(parseQuickAdd('周五前，交专栏稿', NOW()).title, '交专栏稿')
  assert.equal(parseQuickAdd('2026-11-20前交稿', NOW()).title, '交稿')
})

test('parseQuickAdd：空文本 → 400 text_invalid', () => {
  for (const text of ['', '   ', 42, null]) {
    assert.throws(
      () => parseQuickAdd(text, NOW()),
      error => error.status === 400 && error.code === 'text_invalid',
      `「${text}」应该被拒绝`,
    )
  }
})

test('POST /schedule/quick-add：周五前交专栏稿 → 写进 日程.md，出现在本周分组', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/schedule/quick-add', { text: '周五前交专栏稿' })

  assert.equal(res.status, 201)
  assert.equal(res.body.path, SCHEDULE_PATH)
  assert.equal(res.body.item.title, '交专栏稿')
  assert.equal(res.body.item.due, '2026-11-13')
  assert.equal(res.body.item.source, '快速添加')
  assert.match(res.body.item.id, /^[0-9a-f]{10}$/)
  assert.equal(typeof res.body.version, 'string')

  const content = await readFile(join(beer.vault, SCHEDULE_PATH), 'utf8')
  assert.equal(content, `- [ ] 交专栏稿 %%beer id=${res.body.item.id} src=快速添加%% 📅 2026-11-13\n`)
  // Beer 字段必须在 Tasks 字段前面（Tasks 插件从行尾往前认字段）。
  assert.ok(content.indexOf('%%beer') < content.indexOf('📅'))

  const list = (await beer.api('GET', '/schedule')).body
  const week = list.groups.find(group => group.key === 'week')
  assert.deepEqual(week.items.map(item => item.id), [res.body.item.id])
  assert.equal(week.items[0].when.label, '周五截止')
})

test('POST /schedule/quick-add：明天 14:00 → 写成带时刻的事件行', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/schedule/quick-add', { text: '明天 14:00 和编辑开会' })

  assert.equal(res.status, 201)
  assert.equal(res.body.item.title, '和编辑开会')
  assert.equal(res.body.item.kind, 'event')
  assert.equal(res.body.item.due, '2026-11-13')
  assert.equal(res.body.item.time, '14:00')

  const content = await readFile(join(beer.vault, SCHEDULE_PATH), 'utf8')
  // #56：快速添加识别出时刻时也走同一条建提醒链路，默认 remind=default。
  assert.equal(content, `- [ ] 14:00 和编辑开会 %%beer id=${res.body.item.id} src=快速添加 remind=default%% 📅 2026-11-13\n`)
})

test('POST /schedule/quick-add：没提日期也保存，在「全部」和没排期分组里能看到', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/schedule/quick-add', { text: '做一期讲解视频' })

  assert.equal(res.status, 201)
  assert.equal(res.body.item.due, null)
  assert.equal(res.body.item.time, null)

  const list = (await beer.api('GET', '/schedule')).body
  assert.deepEqual(list.items.map(item => item.id), [res.body.item.id])
  assert.deepEqual(list.groups.find(group => group.key === 'unscheduled').items.map(item => item.id), [res.body.item.id])
  assert.equal(list.items[0].when.label, '没排期')
})

test('POST /schedule/quick-add：追加到已有 日程.md，不覆盖 Obsidian 里已有的行', async t => {
  const original = '- [ ] 在 Obsidian 里写的一条 %%beer id=keep src=对话%% 📅 2026-11-13\n'
  const beer = await startBeer(t, { vault: { [SCHEDULE_PATH]: original }, now: NOW })

  const res = await beer.api('POST', '/schedule/quick-add', { text: '后天交稿' })

  assert.equal(res.status, 201)
  const content = await readFile(join(beer.vault, SCHEDULE_PATH), 'utf8')
  assert.equal(content, original + `- [ ] 交稿 %%beer id=${res.body.item.id} src=快速添加%% 📅 2026-11-14\n`)
})

test('POST /schedule/quick-add：空文本 / 只有日期 / text 不是字符串 → 400，不建文件', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  for (const body of [{ text: '' }, { text: '   ' }, { text: '明天' }, { text: '明天 14:00' }, { text: 42 }, {}]) {
    const res = await beer.api('POST', '/schedule/quick-add', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(res.body.error.code, 'text_invalid')
  }
  assert.deepEqual(await readdir(beer.vault), [])
})
