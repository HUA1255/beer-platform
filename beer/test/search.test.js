// 搜索（#8）：只通过 GET /api/beer/search 验证外部行为。
// 直接扫库，不建持久索引；返回结果按分页分组，带命中字段、片段和高亮位置。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { startBeer } from './helpers/beer.js'

const q = (query, more = '') => '?q=' + encodeURIComponent(query) + more
const ARTICLE = '内容库/文章/2026-11-05-笔记搬家/index.md'

test('搜标题：条目文件夹名和正文一级标题都能命中，结果按分页分组', async t => {
  const beer = await startBeer(t, {
    vault: {
      [ARTICLE]: '# 为什么我把笔记搬到 Obsidian\n\n两台电脑之间用 Syncthing 同步。\n',
    },
  })

  const byFolder = await beer.api('GET', '/search' + q('笔记搬家'))

  assert.equal(byFolder.status, 200)
  assert.equal(byFolder.body.query, '笔记搬家')
  assert.equal(byFolder.body.total, 1)
  assert.equal(byFolder.body.groups.length, 1)
  assert.equal(byFolder.body.groups[0].tabId, 'articles')
  assert.equal(byFolder.body.groups[0].title, '文章')
  const hit = byFolder.body.groups[0].hits[0]
  assert.equal(hit.path, ARTICLE)
  assert.equal(hit.name, 'index.md')
  assert.equal(hit.title, '为什么我把笔记搬到 Obsidian')
  assert.equal(hit.kind, 'article')
  assert.equal(hit.tabId, 'articles')
  assert.ok(hit.matchedIn.includes('title'))
  assert.equal(typeof hit.snippet, 'string')
  assert.ok(Array.isArray(hit.highlights))

  const byHeading = await beer.api('GET', '/search' + q('obsidian'))
  assert.equal(byHeading.body.total, 1)
  assert.ok(byHeading.body.groups[0].hits[0].matchedIn.includes('title'))
})

test('搜正文：返回命中附近的片段，高亮位置就在片段里', async t => {
  const beer = await startBeer(t, {
    vault: {
      [ARTICLE]: '# 笔记搬家\n\n两台电脑之间用 Syncthing 同步，不走 iCloud。\n',
    },
  })

  const res = await beer.api('GET', '/search' + q('syncthing'))

  assert.equal(res.body.total, 1)
  const hit = res.body.groups[0].hits[0]
  assert.ok(hit.matchedIn.includes('body'))
  assert.match(hit.snippet, /Syncthing/)
  assert.ok(hit.highlights.length >= 1)
  const at = hit.highlights[0]
  assert.equal(hit.snippet.slice(at.start, at.end), 'Syncthing')
})

test('长行只截取命中附近的一段，高亮跟着位移，不会跑到片段外面', async t => {
  const longLine = '开头'.repeat(100) + '关键词' + '结尾'.repeat(100)
  const beer = await startBeer(t, {
    vault: { [ARTICLE]: '# 长行\n\n' + longLine + '\n' },
  })

  const res = await beer.api('GET', '/search' + q('关键词'))

  const hit = res.body.groups[0].hits[0]
  assert.ok(hit.snippet.length < 200, `片段应被截短，实际 ${hit.snippet.length} 字`)
  assert.match(hit.snippet, /关键词/)
  assert.equal(hit.snippet.slice(hit.highlights[0].start, hit.highlights[0].end), '关键词')
})

const MATERIAL = '内容库/素材/2026-11-04-知乎评论/index.md'
const MATERIAL_SOURCE = `---
标签: [同步, Obsidian, 读者反馈]
状态: 成稿
类型: 链接
---
# 知乎评论：想看多台电脑怎么同步

有人问多台电脑怎么同步，能不能写一篇。
`

test('搜 frontmatter：普通关键词也能命中标签、状态、类型', async t => {
  const beer = await startBeer(t, { vault: { [MATERIAL]: MATERIAL_SOURCE } })

  const byTag = await beer.api('GET', '/search' + q('读者反馈'))
  assert.equal(byTag.body.total, 1)
  assert.deepEqual(byTag.body.groups[0].hits[0].matchedIn, ['tags'])
  // 只命中标签时，片段要说明是哪个标签，并且高亮落在标签词上
  const tagHit = byTag.body.groups[0].hits[0]
  assert.match(tagHit.snippet, /#读者反馈/)
  assert.equal(tagHit.snippet.slice(tagHit.highlights[0].start, tagHit.highlights[0].end), '读者反馈')

  const byStatus = await beer.api('GET', '/search' + q('成稿'))
  assert.equal(byStatus.body.total, 1)
  assert.deepEqual(byStatus.body.groups[0].hits[0].matchedIn, ['status'])

  const byType = await beer.api('GET', '/search' + q('链接'))
  assert.equal(byType.body.total, 1)
  assert.deepEqual(byType.body.groups[0].hits[0].matchedIn, ['type'])
})

test('条件语法：#标签、状态:、类型: 可单独用，也能和关键词混用，多个词按 AND', async t => {
  const beer = await startBeer(t, {
    vault: {
      [MATERIAL]: MATERIAL_SOURCE,
      '内容库/素材/2026-11-03-笔记方法/index.md': `---
标签: [写作]
状态: 草稿
类型: 笔记
---
# 卡片笔记的写法

同步一些想法到卡片里。
`,
      '内容库/素材/2026-11-02-正文标签/index.md': '# 正文标签\n\n这条在正文里写了 #AI工具 和 #效率。\n',
    },
  })

  const byTag = await beer.api('GET', '/search' + q('#同步'))
  assert.equal(byTag.body.total, 1)
  assert.equal(byTag.body.groups[0].hits[0].path, MATERIAL)
  assert.deepEqual(byTag.body.groups[0].hits[0].matchedIn, ['tags'])

  const byBodyTag = await beer.api('GET', '/search' + q('#AI工具'))
  assert.equal(byBodyTag.body.total, 1)
  assert.deepEqual(byBodyTag.body.groups[0].hits[0].matchedIn, ['body'])

  const byStatus = await beer.api('GET', '/search' + q('状态:成稿'))
  assert.equal(byStatus.body.total, 1)
  assert.equal(byStatus.body.groups[0].hits[0].path, MATERIAL)

  const byType = await beer.api('GET', '/search' + q('类型:笔记'))
  assert.equal(byType.body.total, 1)
  assert.equal(byType.body.groups[0].hits[0].path, '内容库/素材/2026-11-03-笔记方法/index.md')

  const combined = await beer.api('GET', '/search' + q('#同步 多台电脑'))
  assert.equal(combined.body.total, 1) // 标签和正文词都命中同一条
  const none = await beer.api('GET', '/search' + q('状态:成稿 卡片笔记'))
  assert.equal(none.body.total, 0)

  const wideColon = await beer.api('GET', '/search' + q('状态：草稿'))
  assert.equal(wideColon.body.total, 1)

  const mixedCase = await beer.api('GET', '/search' + q('#obsidian'))
  assert.equal(mixedCase.body.total, 1)
  assert.equal(mixedCase.body.groups[0].hits[0].path, MATERIAL)
})

test('默认不搜回收站；includeTrash=1 时搜进来，归到回收站分页', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/文章/2026-11-01-活着/index.md': '# 活着的文章\n\n回收站关键词在这里。\n',
      '.trash/内容库/文章/2026-10-01-删掉/index.md': '# 删掉的文章\n\n回收站关键词也在这里。\n',
      '.obsidian/workspace.md': '# 藏起来的关键词\n\n回收站关键词\n',
    },
  })

  const normal = await beer.api('GET', '/search' + q('回收站关键词'))
  assert.equal(normal.body.total, 1)
  assert.deepEqual(normal.body.groups.map(g => g.tabId), ['articles'])

  const withTrash = await beer.api('GET', '/search' + q('回收站关键词', '&includeTrash=1'))
  assert.equal(withTrash.body.total, 2)
  const trash = withTrash.body.groups.find(g => g.tabId === 'trash')
  assert.ok(trash, '应有一组归到回收站')
  assert.equal(trash.title, '回收站')
  assert.equal(trash.hits[0].path, '.trash/内容库/文章/2026-10-01-删掉/index.md')
  assert.equal(trash.hits[0].kind, 'article')
})

test('结果按分页归属：最长前缀匹配，不属于任何分页的归到首页', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/文章/2026-11-01-a/index.md': '# 一篇文章\n\n分页归属词\n',
      '内容库/素材/周会/index.md': '# 周会素材\n\n分页归属词\n',
      '内容库/选题简报/2026-11-05.md': '# 简报\n\n分页归属词\n',
      '内容库/规则/硬规则.md': '# 硬规则\n\n分页归属词\n',
      '工作 SOP/报价书.md': '# 报价书\n\n分页归属词\n',
    },
  })

  const res = await beer.api('GET', '/search' + q('分页归属词'))

  assert.equal(res.body.total, 5)
  assert.deepEqual(res.body.groups.map(g => g.tabId), ['home', 'materials', 'topics', 'articles', 'rules'])
  const byTab = Object.fromEntries(res.body.groups.map(g => [g.tabId, g.hits.map(h => h.path)]))
  assert.deepEqual(byTab.home, ['工作 SOP/报价书.md'])
  assert.deepEqual(byTab.materials, ['内容库/素材/周会/index.md'])
  assert.deepEqual(byTab.articles, ['内容库/文章/2026-11-01-a/index.md'])
})

test('scope 只搜该分页绑定的文件夹；scope=trash 直接搜回收站', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/文章/2026-11-01-a/index.md': '# 文章\n\n范围词\n',
      '内容库/素材/周会/index.md': '# 素材\n\n范围词\n',
      '.trash/内容库/文章/2026-10-01-b/index.md': '# 回收站里的\n\n范围词\n',
    },
  })

  const articles = await beer.api('GET', '/search' + q('范围词', '&scope=articles'))
  assert.equal(articles.body.total, 1)
  assert.equal(articles.body.groups[0].hits[0].path, '内容库/文章/2026-11-01-a/index.md')

  const materials = await beer.api('GET', '/search' + q('范围词', '&scope=materials'))
  assert.equal(materials.body.total, 1)
  assert.equal(materials.body.groups[0].hits[0].path, '内容库/素材/周会/index.md')

  const home = await beer.api('GET', '/search' + q('范围词', '&scope=home'))
  assert.equal(home.body.total, 2)

  const trash = await beer.api('GET', '/search' + q('范围词', '&scope=trash'))
  assert.equal(trash.body.total, 1)
  assert.equal(trash.body.groups[0].tabId, 'trash')

  const unknown = await beer.api('GET', '/search' + q('范围词', '&scope=nope'))
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'scope_invalid')
})

const TRANSCRIPT = '内容库/素材/2026-11-04-周会/transcript.md'
const TRANSCRIPT_SOURCE = `# 周会文字稿

[00:12] 说话人 1：今天先过一下排期。
续行没有时间点，讲讲同步方案。
[00:45] 说话人 2：Rin 博客走接口直接发。
00:58 说话人 1：不用同步到仓库。
01:02:07 说话人 3：最后一段用小时格式。
`

test('文字稿命中带 playAt：方括号、纯 mm:ss、hh:mm:ss 都解析成秒', async t => {
  const beer = await startBeer(t, { vault: { [TRANSCRIPT]: TRANSCRIPT_SOURCE } })

  const cases = [
    ['排期', 12],
    ['Rin 博客', 45],
    ['仓库', 58],
    ['小时格式', 3727],
  ]
  for (const [word, seconds] of cases) {
    const res = await beer.api('GET', '/search' + q(word))
    assert.equal(res.body.total, 1, `「${word}」应命中文字稿`)
    const hit = res.body.groups[0].hits[0]
    assert.equal(hit.kind, 'transcript')
    assert.equal(hit.title, '2026-11-04-周会')
    assert.equal(hit.tabId, 'recordings')
    assert.equal(hit.playAt, seconds, `「${word}」应在第 ${seconds} 秒`)
  }
})

test('家里服务的文字稿格式：时间点包在反引号里也能解析', async t => {
  const source = '# Beer录音测试\n\n- `00:00:03` **说话人 1**: 今天先过一下排期。\n- `00:01:15` **说话人 2**: 下周二发布。\n'
  const beer = await startBeer(t, { vault: { [TRANSCRIPT]: source } })

  for (const [word, seconds] of [['排期', 3], ['下周二', 75]]) {
    const res = await beer.api('GET', '/search' + q(word))
    assert.equal(res.body.groups[0].hits[0].playAt, seconds, `「${word}」应在第 ${seconds} 秒`)
  }
})

test('文字稿的续行没有时间点时，沿用上一行的时间点', async t => {
  const beer = await startBeer(t, { vault: { [TRANSCRIPT]: TRANSCRIPT_SOURCE } })

  const res = await beer.api('GET', '/search' + q('同步方案'))

  const hit = res.body.groups[0].hits[0]
  assert.match(hit.snippet, /同步方案/)
  assert.equal(hit.playAt, 12)
})

test('普通笔记里的时间点不当作播放位置', async t => {
  const beer = await startBeer(t, {
    vault: { '内容库/规则/模板.md': '# 模板\n\n[00:12] 这只是笔记里的一个时间点。\n' },
  })

  const res = await beer.api('GET', '/search' + q('时间点'))

  const hit = res.body.groups[0].hits[0]
  assert.equal(hit.kind, 'rule')
  assert.equal(hit.playAt, undefined)
})

test('空查询返回空结果，不扫库也不报错', async t => {
  const beer = await startBeer(t, { vault: { [ARTICLE]: '# 文章\n\n随便一个词\n' } })

  for (const query of ['', '   ']) {
    const res = await beer.api('GET', '/search' + q(query))
    assert.equal(res.status, 200)
    assert.equal(res.body.total, 0)
    assert.deepEqual(res.body.groups, [])
    assert.equal(res.body.query, '')
  }

  const missing = await beer.api('GET', '/search')
  assert.equal(missing.status, 200)
  assert.equal(missing.body.total, 0)
})

test('没有命中时 total 为 0、groups 为空数组', async t => {
  const beer = await startBeer(t, { vault: { [ARTICLE]: '# 文章\n\n这个词不在查询里\n' } })

  const res = await beer.api('GET', '/search' + q('完全不存在的词'))

  assert.equal(res.status, 200)
  assert.equal(res.body.query, '完全不存在的词')
  assert.equal(res.body.total, 0)
  assert.deepEqual(res.body.groups, [])
})

test('只搜 Markdown 文件，其他文件不参与', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/文章/2026-11-01-a/index.md': '# 文章\n\n只搜 Markdown\n',
      '内容库/文章/2026-11-01-a/图片说明.txt': '只搜 Markdown\n',
    },
  })

  const res = await beer.api('GET', '/search' + q('只搜 Markdown'))

  assert.equal(res.body.total, 1)
  assert.equal(res.body.groups[0].hits[0].name, 'index.md')
})

test('不依赖内存索引：重启后仍能搜，重启后库里新写的文件马上能搜到', async t => {
  const beer = await startBeer(t, { vault: { [ARTICLE]: '# 旧文章\n\n旧词在这里\n' } })
  assert.equal((await beer.api('GET', '/search' + q('旧词'))).body.total, 1)

  const again = await beer.restart()
  assert.equal((await again.api('GET', '/search' + q('旧词'))).body.total, 1)

  // 模拟在 Obsidian 里刚写完一个文件：不等任何索引更新，下一次搜索就能找到
  const fresh = join(beer.vault, '内容库/文章/2026-11-06-新写的/index.md')
  await mkdir(dirname(fresh), { recursive: true })
  await writeFile(fresh, '# 新写的文章\n\n新词在这里\n')
  const res = await again.api('GET', '/search' + q('新词'))
  assert.equal(res.body.total, 1)
  assert.equal(res.body.groups[0].hits[0].path, '内容库/文章/2026-11-06-新写的/index.md')
})

test('自定义分页：按它的文件夹归属，scope 也能只搜这个分页', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/读书笔记/Syncthing 设置.md': '# Syncthing 设置\n\n忽略 .obsidian/workspace.json。\n',
      '内容库/文章/2026-11-01-a/index.md': '# 一篇文章\n\n忽略这个配置文件。\n',
    },
  })
  const created = await beer.api('POST', '/panel/tabs', { title: '读书笔记', folder: '内容库/读书笔记', style: 'note' })
  assert.equal(created.status, 201)

  const res = await beer.api('GET', '/search' + q('忽略'))
  const group = res.body.groups.find(g => g.tabId === created.body.id)
  assert.ok(group, '自定义分页应有一组结果')
  assert.equal(group.title, '读书笔记')
  assert.equal(group.hits[0].path, '内容库/读书笔记/Syncthing 设置.md')
  assert.equal(group.hits[0].kind, 'note')

  const scoped = await beer.api('GET', '/search' + q('忽略', '&scope=' + created.body.id))
  assert.equal(scoped.body.total, 1)
  assert.equal(scoped.body.groups[0].tabId, created.body.id)
})
