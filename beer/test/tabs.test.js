import test from 'node:test'
import assert from 'node:assert/strict'
import { startBeer, listFiles } from './helpers/beer.js'

const FIXED_TABS = ['home', 'recordings', 'materials', 'topics', 'articles', 'publish', 'rules', 'trash']

test('新建自定义分页：出现在固定分页之后，带 custom 和 style，重启后仍在', async t => {
  const beer = await startBeer(t, { vault: { '内容库/读书笔记/2026-11-01-a/index.md': '# 读书\n' } })

  const created = await beer.api('POST', '/panel/tabs', { title: '读书笔记', folder: '内容库/读书笔记', style: 'note' })

  assert.equal(created.status, 201)
  assert.match(created.body.id, /^custom-[A-Za-z0-9_-]+$/)
  assert.deepEqual(created.body, {
    id: created.body.id,
    title: '读书笔记',
    folder: '内容库/读书笔记',
    style: 'note',
    custom: true,
  })

  const panel = (await beer.api('GET', '/panel')).body
  assert.deepEqual(panel.tabs.slice(0, 8).map(tab => tab.id), FIXED_TABS)
  assert.deepEqual(panel.tabs.slice(8).map(tab => tab.id), [created.body.id])
  assert.deepEqual(panel.tabs[8], created.body)
  assert.equal(panel.chatCollapsed[created.body.id], false)
  // 固定分页不带 custom / style
  for (const tab of panel.tabs.slice(0, 8)) {
    assert.equal('custom' in tab, false)
    assert.equal('style' in tab, false)
  }

  const again = await beer.restart()
  const reloaded = (await again.api('GET', '/panel')).body
  assert.deepEqual(reloaded.tabs, panel.tabs)
})

test('自定义分页按添加顺序追加，可绑定尚不存在的库内文件夹', async t => {
  const beer = await startBeer(t)

  const first = await beer.api('POST', '/panel/tabs', { title: '工作 SOP', folder: '工作 SOP', style: 'list' })
  const second = await beer.api('POST', '/panel/tabs', { title: '读书', folder: '内容库/还没有的文件夹', style: 'note' })

  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  const tabs = (await beer.api('GET', '/panel')).body.tabs
  assert.deepEqual(tabs.slice(8).map(tab => tab.title), ['工作 SOP', '读书'])
  assert.deepEqual(tabs.slice(8).map(tab => tab.style), ['list', 'note'])
  const listed = await beer.api('GET', '/library/folder?path=' + encodeURIComponent('内容库/还没有的文件夹'))
  assert.equal(listed.body.exists, false)
})

test('新建自定义分页：非法 title / folder / style 被拒且不写入', async t => {
  const beer = await startBeer(t)

  const cases = [
    [{ title: '', folder: '内容库/读书', style: 'note' }, 'title'],
    [{ title: '   ', folder: '内容库/读书', style: 'note' }, 'title'],
    [{ title: '长'.repeat(41), folder: '内容库/读书', style: 'note' }, 'title'],
    [{ folder: '内容库/读书', style: 'note' }, 'title'],
    [{ title: '读书', folder: '', style: 'note' }, 'folder'],
    [{ title: '读书', folder: '../外面', style: 'note' }, 'folder'],
    [{ title: '读书', folder: '内容库/../外面', style: 'note' }, 'folder'],
    [{ title: '读书', folder: '/内容库', style: 'note' }, 'folder'],
    [{ title: '读书', folder: '内容库//读书', style: 'note' }, 'folder'],
    [{ title: '读书', folder: '内容库\\读书', style: 'note' }, 'folder'],
    [{ title: '读书', folder: './内容库', style: 'note' }, 'folder'],
    [{ title: '读书', folder: '内容库/读书', style: 'other' }, 'style'],
    [{ title: '读书', folder: '内容库/读书', style: '' }, 'style'],
    [{ title: '读书', folder: '内容库/读书' }, 'style'],
  ]
  for (const [body] of cases) {
    const res = await beer.api('POST', '/panel/tabs', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.ok(res.body.error?.code, JSON.stringify(body))
  }

  assert.equal((await beer.api('GET', '/panel')).body.tabs.length, 8)
  const again = await beer.restart()
  assert.equal((await again.api('GET', '/panel')).body.tabs.length, 8)
})

test('标题去掉两端空白后最多 40 字', async t => {
  const beer = await startBeer(t)

  const res = await beer.api('POST', '/panel/tabs', { title: '  ' + '读'.repeat(40) + '  ', folder: '内容库/读书', style: 'note' })

  assert.equal(res.status, 201)
  assert.equal(res.body.title, '读'.repeat(40))
})

test('删除自定义分页：只删分页不删文件夹；固定分页不能删', async t => {
  const beer = await startBeer(t, { vault: { '内容库/读书笔记/a.md': '# a\n' } })
  const created = (await beer.api('POST', '/panel/tabs', { title: '读书笔记', folder: '内容库/读书笔记', style: 'note' })).body

  const fixed = await beer.api('DELETE', '/panel/tabs/home')
  assert.ok(fixed.status === 400 || fixed.status === 403)
  assert.ok((await beer.api('GET', '/panel')).body.tabs.some(tab => tab.id === 'home'))

  const removed = await beer.api('DELETE', '/panel/tabs/' + created.id)
  assert.equal(removed.status, 200)

  const panel = (await beer.api('GET', '/panel')).body
  assert.deepEqual(panel.tabs.map(tab => tab.id), FIXED_TABS)
  assert.equal(Object.hasOwn(panel.chatCollapsed, created.id), false)
  // 文件夹和文件都还在
  const listed = await beer.api('GET', '/library/folder?path=' + encodeURIComponent('内容库/读书笔记'))
  assert.deepEqual(listed.body.entries.map(e => e.name), ['a.md'])
  assert.deepEqual((await listFiles(beer.vault)).map(file => file.replaceAll('\\', '/')), ['内容库/读书笔记/a.md'])

  assert.equal((await beer.api('DELETE', '/panel/tabs/' + created.id)).status, 404)
  const again = await beer.restart()
  assert.deepEqual((await again.api('GET', '/panel')).body.tabs.map(tab => tab.id), FIXED_TABS)
})

test('自定义分页的对话栏默认展开，状态按 id 记住，删除时一起清掉', async t => {
  const beer = await startBeer(t)
  const created = (await beer.api('POST', '/panel/tabs', { title: '读书', folder: '内容库/读书', style: 'note' })).body

  assert.equal((await beer.api('GET', '/panel')).body.chatCollapsed[created.id], false)
  assert.equal((await beer.api('PUT', '/panel/chat/' + created.id, { collapsed: true })).status, 200)

  const again = await beer.restart()
  assert.equal((await again.api('GET', '/panel')).body.chatCollapsed[created.id], true)

  assert.equal((await again.api('DELETE', '/panel/tabs/' + created.id)).status, 200)
  const after = (await again.api('GET', '/panel')).body
  assert.equal(Object.hasOwn(after.chatCollapsed, created.id), false)
  const restarted = await again.restart()
  assert.equal(Object.hasOwn((await restarted.api('GET', '/panel')).body.chatCollapsed, created.id), false)
})

test('文件夹两端的空白由服务端去掉', async t => {
  const beer = await startBeer(t)

  const created = await beer.api('POST', '/panel/tabs', { title: '读书', folder: '  内容库/读书笔记  ', style: 'note' })

  assert.equal(created.status, 201)
  assert.equal(created.body.folder, '内容库/读书笔记')
})
