import test from 'node:test'
import assert from 'node:assert/strict'
import { startBeer } from './helpers/beer.js'

const FIXED_TABS = ['home', 'recordings', 'materials', 'topics', 'articles', 'publish', 'rules', 'trash']

test('面板状态：8 个固定分页按顺序给出，对话栏默认只有发布页收起', async t => {
  const beer = await startBeer(t, { vault: false })

  const res = await beer.api('GET', '/panel')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.tabs.map(tab => tab.id), FIXED_TABS)
  assert.deepEqual(res.body.tabs.map(tab => tab.title), ['首页', '录音', '素材', '选题', '文章', '发布', '规则', '回收站'])
  assert.deepEqual(res.body.chatCollapsed, {
    home: false, recordings: false, materials: false, topics: false,
    articles: false, publish: true, rules: false, trash: false,
  })
  assert.equal(res.body.sessionId, null)
})

test('每个分页绑定库里的一个文件夹，可直接用来列出内容', async t => {
  const beer = await startBeer(t, { vault: { '内容库/文章/2026-11-01-a/index.md': '# a\n' } })

  const { tabs } = (await beer.api('GET', '/panel')).body

  assert.deepEqual(Object.fromEntries(tabs.map(tab => [tab.id, tab.folder])), {
    home: '内容库', recordings: '内容库/素材', materials: '内容库/素材', topics: '内容库/选题简报',
    articles: '内容库/文章', publish: '内容库/文章', rules: '内容库/规则', trash: '.trash',
  })
  const articles = tabs.find(tab => tab.id === 'articles')
  const listed = await beer.api('GET', '/library/folder?path=' + encodeURIComponent(articles.folder))
  assert.deepEqual(listed.body.entries.map(e => e.name), ['2026-11-01-a'])
})

test('对话栏展开 / 收起按分页分别记住，重启后仍在', async t => {
  const beer = await startBeer(t)

  assert.equal((await beer.api('PUT', '/panel/chat/recordings', { collapsed: true })).status, 200)
  assert.equal((await beer.api('PUT', '/panel/chat/publish', { collapsed: false })).status, 200)

  const again = await beer.restart()
  const { chatCollapsed } = (await again.api('GET', '/panel')).body
  assert.equal(chatCollapsed.recordings, true)
  assert.equal(chatCollapsed.publish, false)
  assert.equal(chatCollapsed.home, false)
})

test('对话栏状态：collapsed 不是布尔值时拒绝', async t => {
  const beer = await startBeer(t)

  const res = await beer.api('PUT', '/panel/chat/home', { collapsed: 'yes' })

  assert.equal(res.status, 400)
  assert.equal((await beer.api('GET', '/panel')).body.chatCollapsed.home, false)
})

test('「开始对话」后记下本工作台的会话编号，下次用它恢复', async t => {
  const beer = await startBeer(t)

  assert.equal((await beer.api('PUT', '/panel/session', { sessionId: 'sess-123' })).status, 200)

  const again = await beer.restart()
  assert.equal((await again.api('GET', '/panel')).body.sessionId, 'sess-123')
})
