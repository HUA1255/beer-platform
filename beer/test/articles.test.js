import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, listFiles } from './helpers/beer.js'

const ARTICLES = '内容库/文章'
const ARCHIVE = ARTICLES + '/_归档'

/** 库里的文件列表，分隔符统一成 /（Windows 上是 \）。 */
const vaultFiles = async beer => (await listFiles(beer.vault)).map(p => p.replaceAll('\\', '/'))

/** 固定「现在」为本地时间 2026-11-06 10:30，和文章文件夹日期对得上。 */
const fixedNow = () => new Date(2026, 10, 6, 10, 30, 0)

const articleFile = (title, { status = '选题', date = '2026-11-06' } = {}) =>
  `---\n标题: ${title}\n状态: ${status}\n日期: ${date}\n---\n\n# ${title}\n`

test('新建文章：生成 内容库/文章/<日期>-<标题>/index.md，开头带标题、状态和日期', async t => {
  const beer = await startBeer(t, { now: fixedNow })

  const res = await beer.api('POST', '/articles', { title: '为什么我把笔记搬到 Obsidian' })

  assert.equal(res.status, 201)
  const folder = ARTICLES + '/2026-11-06-为什么我把笔记搬到 Obsidian'
  assert.deepEqual(res.body, {
    path: folder + '/index.md',
    folder,
    title: '为什么我把笔记搬到 Obsidian',
    status: '选题',
  })
  assert.deepEqual(await vaultFiles(beer), [folder + '/index.md'])
  assert.equal(
    await readFile(join(beer.vault, folder, 'index.md'), 'utf8'),
    articleFile('为什么我把笔记搬到 Obsidian'),
  )
})

test('新建文章：标题里的不安全字符去掉、首尾空白去掉，空名称用「未命名」', async t => {
  const beer = await startBeer(t, { now: fixedNow })

  const res = await beer.api('POST', '/articles', { title: '  小团队/别先上:自动化?"*<>|  ' })
  assert.equal(res.status, 201)
  assert.equal(res.body.folder, ARTICLES + '/2026-11-06-小团队别先上自动化')
  assert.equal(res.body.title, '小团队/别先上:自动化?"*<>|')

  const empty = await beer.api('POST', '/articles', { title: '///' })
  assert.equal(empty.status, 201)
  assert.equal(empty.body.folder, ARTICLES + '/2026-11-06-未命名')
  assert.equal(empty.body.title, '///')
  assert.equal(
    await readFile(join(beer.vault, empty.body.path), 'utf8'),
    articleFile('///'),
  )
})

test('新建文章：同一天同名自动加 -2、-3，绝不覆盖已有条目', async t => {
  const beer = await startBeer(t, { now: fixedNow })

  const first = (await beer.api('POST', '/articles', { title: '同名文章' })).body
  await writeFile(join(beer.vault, first.path), articleFile('同名文章') + '\n用户后来写的内容\n')
  const second = (await beer.api('POST', '/articles', { title: '同名文章' })).body
  const third = (await beer.api('POST', '/articles', { title: '同名文章' })).body

  assert.equal(first.folder, ARTICLES + '/2026-11-06-同名文章')
  assert.equal(second.folder, ARTICLES + '/2026-11-06-同名文章-2')
  assert.equal(third.folder, ARTICLES + '/2026-11-06-同名文章-3')
  assert.equal(
    await readFile(join(beer.vault, first.path), 'utf8'),
    articleFile('同名文章') + '\n用户后来写的内容\n',
  )
})

test('新建文章：标题不是非空字符串时拒绝，库里什么都不建', async t => {
  const beer = await startBeer(t, { now: fixedNow })

  for (const body of [{}, { title: '' }, { title: '   ' }, { title: 42 }, { title: null }]) {
    const res = await beer.api('POST', '/articles', body)
    assert.equal(res.status, 400, `应拒绝 title=${JSON.stringify(body.title)}`)
    assert.equal(res.body.error.code, 'title_invalid')
  }
  assert.deepEqual(await vaultFiles(beer), [])
})

test('文章列表：返回路径、文件夹、标题、状态、日期和修改时间', async t => {
  const title = '笔记搬家'
  const folder = ARTICLES + '/2026-11-05-' + title
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: { [folder + '/index.md']: articleFile(title, { status: '草稿', date: '2026-11-05' }) },
  })

  const res = await beer.api('GET', '/articles')

  assert.equal(res.status, 200)
  assert.equal(res.body.articles.length, 1)
  const [item] = res.body.articles
  assert.equal(item.path, folder + '/index.md')
  assert.equal(item.folder, folder)
  assert.equal(item.title, title)
  assert.equal(item.status, '草稿')
  assert.equal(item.date, '2026-11-05')
  assert.equal(item.archived, false)
  assert.ok(!Number.isNaN(Date.parse(item.modifiedAt)))
})

test('文章列表：按状态筛选；默认跳过 _归档，includeArchived=1 时一起列出', async t => {
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: {
      [ARTICLES + '/2026-11-01-选题/index.md']: articleFile('选题', { date: '2026-11-01' }),
      [ARTICLES + '/2026-11-02-草稿/index.md']: articleFile('草稿', { status: '草稿', date: '2026-11-02' }),
      [ARTICLES + '/2026-11-03-成稿/index.md']: articleFile('成稿', { status: '成稿', date: '2026-11-03' }),
      [ARCHIVE + '/2026-10-01-旧文/index.md']: articleFile('旧文', { status: '已发布', date: '2026-10-01' }),
      // 就算 _归档 自己带 index.md，也不能当成一篇文章混进普通列表
      [ARCHIVE + '/index.md']: articleFile('归档说明', { date: '2026-10-01' }),
    },
  })

  const all = (await beer.api('GET', '/articles')).body.articles
  assert.deepEqual(all.map(a => a.title).sort(), ['成稿', '草稿', '选题'])

  const drafts = (await beer.api('GET', '/articles?status=' + encodeURIComponent('草稿'))).body.articles
  assert.deepEqual(drafts.map(a => a.title), ['草稿'])

  const archived = (await beer.api('GET', '/articles?status=' + encodeURIComponent('已归档'))).body.articles
  assert.deepEqual(archived.map(a => [a.title, a.archived]), [['旧文', true]])

  const withArchived = (await beer.api('GET', '/articles?includeArchived=1')).body.articles
  assert.deepEqual(withArchived.map(a => a.title).sort(), ['成稿', '旧文', '选题', '草稿'].sort())
})

const BODY = '正文第一段，保留原样。\n\n## 小标题\n\n正文第二段。\n'
const STATUS_NOTE = ARTICLES + '/2026-11-05-笔记搬家/index.md'
const STATUS_CONTENT = `---\n标题: 笔记搬家\n状态: 选题\n日期: 2026-11-05\n---\n\n# 笔记搬家\n\n${BODY}`

test('改状态：选题 → 草稿 → 成稿只在三者之间改，只动状态和状态时间两行，正文逐字不变', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [STATUS_NOTE]: STATUS_CONTENT } })

  for (const status of ['草稿', '成稿', '选题']) {
    const res = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status })
    assert.equal(res.status, 200)
    assert.equal(res.body.path, STATUS_NOTE)
    assert.equal(res.body.status, status)
    assert.equal(
      await readFile(join(beer.vault, STATUS_NOTE), 'utf8'),
      STATUS_CONTENT.replace('状态: 选题', `状态: ${status}\n状态时间: ${fixedNow().toISOString()}`),
    )
  }
  // 正文没有任何平台版本被生成
  assert.deepEqual(await vaultFiles(beer), [STATUS_NOTE])
})

test('改状态：把 状态时间 写进 frontmatter，再改只更新这一行，正文逐字不变', async t => {
  let now = new Date(2026, 10, 6, 10, 30, 0)
  const beer = await startBeer(t, { now: () => now, vault: { [STATUS_NOTE]: STATUS_CONTENT } })

  const first = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status: '草稿' })
  assert.equal(first.status, 200)
  assert.equal(
    await readFile(join(beer.vault, STATUS_NOTE), 'utf8'),
    STATUS_CONTENT.replace('状态: 选题', `状态: 草稿\n状态时间: ${now.toISOString()}`),
  )

  now = new Date(2026, 10, 8, 21, 5, 0)
  const second = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status: '成稿' })
  assert.equal(second.status, 200)
  const file = await readFile(join(beer.vault, STATUS_NOTE), 'utf8')
  assert.equal(
    file,
    STATUS_CONTENT.replace('状态: 选题', `状态: 成稿\n状态时间: ${now.toISOString()}`),
  )
  assert.equal(file.match(/^状态时间:/gm)?.length, 1, '只能有一行 状态时间')
  assert.ok(file.includes(BODY), '正文逐字不变')
})

test('改成成稿：返回询问是否生成平台版本，但不生成任何平台版本、不调模型', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [STATUS_NOTE]: STATUS_CONTENT } })

  const res = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status: '成稿' })

  assert.equal(res.status, 200)
  assert.equal(res.body.status, '成稿')
  assert.equal(res.body.askGeneratePlatformVersions, true)
  assert.deepEqual(await vaultFiles(beer), [STATUS_NOTE])

  // 改成别的状态时不带这个提示
  const back = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status: '草稿' })
  assert.equal(back.status, 200)
  assert.ok(!('askGeneratePlatformVersions' in back.body))
})

test('改状态：目标是已确认 / 已发布，或当前已是已确认 / 已发布时一律 403，文件不动', async t => {
  const confirmed = `---\n标题: 已确认的\n状态: 已确认\n日期: 2026-11-05\n---\n\n# 已确认的\n`
  const published = `---\n标题: 已发布\n状态: 已发布\n日期: 2026-11-05\n---\n\n# 已发布\n`
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: {
      [STATUS_NOTE]: STATUS_CONTENT,
      [ARTICLES + '/2026-11-05-已确认/index.md']: confirmed,
      [ARTICLES + '/2026-11-05-已发布/index.md']: published,
    },
  })

  // 从可手动修改的状态改成已确认 / 已发布
  for (const status of ['已确认', '已发布']) {
    const res = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status })
    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'status_locked')
    assert.match(res.body.error.message, /发布流程/)
  }
  // 从已确认 / 已发布改出
  for (const [path, status] of [[ARTICLES + '/2026-11-05-已确认/index.md', '草稿'], [ARTICLES + '/2026-11-05-已发布/index.md', '选题']]) {
    const res = await beer.api('POST', '/articles/status', { path, status })
    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'status_locked')
    assert.match(res.body.error.message, /发布流程/)
  }
  assert.equal(await readFile(join(beer.vault, STATUS_NOTE), 'utf8'), STATUS_CONTENT)
  assert.equal(await readFile(join(beer.vault, ARTICLES, '2026-11-05-已确认/index.md'), 'utf8'), confirmed)
  assert.equal(await readFile(join(beer.vault, ARTICLES, '2026-11-05-已发布/index.md'), 'utf8'), published)
})

test('改状态：不认识的状态值被拒，文件不动', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [STATUS_NOTE]: STATUS_CONTENT } })

  for (const status of ['随便', '', 42, null, undefined]) {
    const res = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status })
    assert.equal(res.status, 400, `应拒绝状态 ${JSON.stringify(status)}`)
    assert.equal(res.body.error.code, 'status_invalid')
  }
  assert.equal(await readFile(join(beer.vault, STATUS_NOTE), 'utf8'), STATUS_CONTENT)
})

test('改状态：读取之后文件被别处修改时 409 edit_conflict，不覆盖别处的改动', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [STATUS_NOTE]: STATUS_CONTENT } })
  const opened = (await beer.api('GET', '/library/file?path=' + encodeURIComponent(STATUS_NOTE))).body
  const external = STATUS_CONTENT.replace('正文第一段，保留原样。', 'Obsidian 里改过的正文。')
  await writeFile(join(beer.vault, STATUS_NOTE), external)

  const res = await beer.api('POST', '/articles/status', { path: STATUS_NOTE, status: '草稿', baseVersion: opened.version })

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'edit_conflict')
  assert.ok(res.body.current?.version)
  assert.equal(await readFile(join(beer.vault, STATUS_NOTE), 'utf8'), external)
})

const TITLE_NOTE = ARTICLES + '/2026-11-05-旧标题/index.md'
const TITLE_CONTENT = `---\n标题: 旧标题\n状态: 草稿\n日期: 2026-11-05\n---\n\n# 旧标题\n\n第一段，保留原样。\n\n## 小标题\n\n第二段。\n`

test('改标题：正文第一个 # 标题行和 frontmatter 的 标题: 一起改，文件夹名不变', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [TITLE_NOTE]: TITLE_CONTENT } })

  const res = await beer.api('POST', '/articles/title', { path: TITLE_NOTE, title: '新标题' })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { path: TITLE_NOTE, title: '新标题' })
  assert.equal(
    await readFile(join(beer.vault, TITLE_NOTE), 'utf8'),
    TITLE_CONTENT.replace('标题: 旧标题', '标题: 新标题').replace('# 旧标题', '# 新标题'),
  )
  // 文件夹名没有跟着变；文章列表和发布用的标题都跟着 frontmatter 变。
  const list = (await beer.api('GET', '/articles')).body.articles
  assert.deepEqual(list.map(a => [a.folder, a.title]), [[ARTICLES + '/2026-11-05-旧标题', '新标题']])
  assert.deepEqual(await vaultFiles(beer), [TITLE_NOTE])
})

test('改标题：frontmatter 没有 标题: 时只改 H1，不新增属性', async t => {
  const noTitle = `---\n状态: 草稿\n日期: 2026-11-05\n---\n\n# 旧标题\n\n正文保留。\n`
  const beer = await startBeer(t, { now: fixedNow, vault: { [TITLE_NOTE]: noTitle } })

  const res = await beer.api('POST', '/articles/title', { path: TITLE_NOTE, title: '新标题' })

  assert.equal(res.status, 200)
  const file = await readFile(join(beer.vault, TITLE_NOTE), 'utf8')
  assert.equal(file, `---\n状态: 草稿\n日期: 2026-11-05\n---\n\n# 新标题\n\n正文保留。\n`)
  assert.ok(!/^标题\s*:/m.test(file), '没有 标题: 时不应该新增这一行')
})

test('改标题：正文没有 # 标题时，在 frontmatter 后插入一行，正文其余内容不动', async t => {
  const noHeading = `---\n标题: 旧标题\n状态: 草稿\n日期: 2026-11-05\n---\n\n正文开头，没有标题行。\n`
  const beer = await startBeer(t, { now: fixedNow, vault: { [TITLE_NOTE]: noHeading } })

  const res = await beer.api('POST', '/articles/title', { path: TITLE_NOTE, title: '补上的标题' })

  assert.equal(res.status, 200)
  assert.equal(
    await readFile(join(beer.vault, TITLE_NOTE), 'utf8'),
    `---\n标题: 补上的标题\n状态: 草稿\n日期: 2026-11-05\n---\n\n# 补上的标题\n\n正文开头，没有标题行。\n`,
  )
})

test('改标题：标题为空时拒绝；读取后被别处改过时 409 edit_conflict', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [TITLE_NOTE]: TITLE_CONTENT } })

  for (const title of ['', '   ', 42, null, undefined]) {
    const res = await beer.api('POST', '/articles/title', { path: TITLE_NOTE, title })
    assert.equal(res.status, 400, `应拒绝标题 ${JSON.stringify(title)}`)
    assert.equal(res.body.error.code, 'title_invalid')
  }
  assert.equal(await readFile(join(beer.vault, TITLE_NOTE), 'utf8'), TITLE_CONTENT)

  const opened = (await beer.api('GET', '/library/file?path=' + encodeURIComponent(TITLE_NOTE))).body
  const external = TITLE_CONTENT.replace('第一段，保留原样。', 'Obsidian 里改过的第一段。')
  await writeFile(join(beer.vault, TITLE_NOTE), external)
  const conflict = await beer.api('POST', '/articles/title', { path: TITLE_NOTE, title: '新标题', baseVersion: opened.version })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'edit_conflict')
  assert.equal(await readFile(join(beer.vault, TITLE_NOTE), 'utf8'), external)
})

test('归档：整个条目文件夹移到 文章/_归档/<原文件夹名>，正文和附带文件都不变', async t => {
  const folder = ARTICLES + '/2026-11-05-笔记搬家'
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: {
      [folder + '/index.md']: articleFile('笔记搬家', { status: '草稿', date: '2026-11-05' }),
      [folder + '/images/封面.png']: 'png',
    },
  })

  const res = await beer.api('POST', '/articles/archive', { path: folder + '/index.md' })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    path: ARCHIVE + '/2026-11-05-笔记搬家/index.md',
    folder: ARCHIVE + '/2026-11-05-笔记搬家',
  })
  assert.deepEqual(await vaultFiles(beer), [
    ARCHIVE + '/2026-11-05-笔记搬家/images/封面.png',
    ARCHIVE + '/2026-11-05-笔记搬家/index.md',
  ])
  assert.equal(
    await readFile(join(beer.vault, ARCHIVE, '2026-11-05-笔记搬家/index.md'), 'utf8'),
    articleFile('笔记搬家', { status: '草稿', date: '2026-11-05' }),
  )
  // 默认列表不再显示；按「已归档」筛能看到
  assert.deepEqual((await beer.api('GET', '/articles')).body.articles, [])
  const archived = (await beer.api('GET', '/articles?status=' + encodeURIComponent('已归档'))).body.articles
  assert.deepEqual(archived.map(a => [a.folder, a.archived]), [[ARCHIVE + '/2026-11-05-笔记搬家', true]])
})

test('归档：_归档 里已有同名文件夹时加 -2，不覆盖；不存在或已经归档时拒绝', async t => {
  const beer = await startBeer(t, { now: fixedNow })
  const first = (await beer.api('POST', '/articles', { title: '同名文章' })).body
  const archived1 = await beer.api('POST', '/articles/archive', { path: first.path })
  assert.equal(archived1.status, 200)

  const second = (await beer.api('POST', '/articles', { title: '同名文章' })).body
  assert.equal(second.folder, ARTICLES + '/2026-11-06-同名文章')
  const archived2 = await beer.api('POST', '/articles/archive', { path: second.path })
  assert.equal(archived2.status, 200)
  assert.equal(archived2.body.folder, ARCHIVE + '/2026-11-06-同名文章-2')
  assert.deepEqual(await vaultFiles(beer), [
    ARCHIVE + '/2026-11-06-同名文章-2/index.md',
    ARCHIVE + '/2026-11-06-同名文章/index.md',
  ])

  const missing = await beer.api('POST', '/articles/archive', { path: ARTICLES + '/2026-11-06-没有这篇/index.md' })
  assert.equal(missing.status, 404)

  const again = await beer.api('POST', '/articles/archive', { path: archived1.body.path })
  assert.equal(again.status, 409)
  assert.equal(again.body.error.code, 'already_archived')
})

test('删除：已发布的文章拒绝（只能归档），文件夹和文件都还在，也没进回收站', async t => {
  const folder = ARTICLES + '/2026-11-05-已发布'
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: { [folder + '/index.md']: articleFile('已发布', { status: '已发布', date: '2026-11-05' }) },
  })

  const res = await beer.api('POST', '/articles/delete', { path: folder + '/index.md' })

  assert.equal(res.status, 403)
  assert.equal(res.body.error.code, 'published_immutable')
  assert.match(res.body.error.message, /归档/)
  assert.deepEqual(await vaultFiles(beer), [folder + '/index.md'])
  assert.deepEqual((await beer.api('GET', '/articles?includeArchived=1')).body.articles.map(a => a.status), ['已发布'])
  assert.deepEqual((await beer.api('GET', '/trash')).body.items, [])
})

test('删除：其余状态整个文件夹移到 .trash，回收站里能按原路径恢复', async t => {
  const folder = ARTICLES + '/2026-11-05-成稿'
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: {
      [folder + '/index.md']: articleFile('成稿', { status: '成稿', date: '2026-11-05' }),
      [folder + '/images/封面.png']: 'png',
    },
  })

  const res = await beer.api('POST', '/articles/delete', { path: folder + '/index.md' })

  assert.equal(res.status, 200)
  assert.equal(res.body.path, folder + '/index.md')
  assert.equal(res.body.trashedTo, '.trash/' + folder)
  assert.deepEqual(await vaultFiles(beer), [
    '.trash/.beer-trash.json',
    '.trash/' + folder + '/images/封面.png',
    '.trash/' + folder + '/index.md',
  ])
  const trash = (await beer.api('GET', '/trash')).body.items
  assert.deepEqual(trash.map(i => [i.originalPath, i.kind]), [[folder, 'folder']])
  assert.deepEqual((await beer.api('GET', '/articles')).body.articles, [])

  const restored = await beer.api('POST', '/trash/restore', { id: trash[0].id })
  assert.equal(restored.status, 200)
  assert.equal(await readFile(join(beer.vault, folder, 'index.md'), 'utf8'), articleFile('成稿', { status: '成稿', date: '2026-11-05' }))
})

test('删除：已确认的文章允许删除；不存在的文章 404', async t => {
  const folder = ARTICLES + '/2026-11-05-已确认'
  const beer = await startBeer(t, {
    now: fixedNow,
    vault: { [folder + '/index.md']: articleFile('已确认', { status: '已确认', date: '2026-11-05' }) },
  })

  const missing = await beer.api('POST', '/articles/delete', { path: ARTICLES + '/2026-11-05-没有这篇/index.md' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not_found')

  const res = await beer.api('POST', '/articles/delete', { path: folder + '/index.md' })
  assert.equal(res.status, 200)
  assert.equal(res.body.trashedTo, '.trash/' + folder)
})

const ASSIST_NOTE = ARTICLES + '/2026-11-05-笔记搬家/index.md'
const ASSIST_CONTENT = `---\n标题: 笔记搬家\n状态: 草稿\n日期: 2026-11-05\n---\n\n# 笔记搬家\n\n我去年用 Obsidian 整理并搬完了四百多篇笔记。\n`

test('AI 帮手：列提纲、查事实、提反对意见、拟标题各自返回带标题和正文的 prompt，程序不写正文', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [ASSIST_NOTE]: ASSIST_CONTENT } })

  const cases = [['outline', /提纲/], ['facts', /事实/], ['counter', /反对/], ['titles', /标题/]]
  for (const [kind, keyword] of cases) {
    const res = await beer.api('GET', `/articles/assist?path=${encodeURIComponent(ASSIST_NOTE)}&kind=${kind}`)
    assert.equal(res.status, 200, `${kind} 应返回 200`)
    assert.equal(typeof res.body.prompt, 'string')
    assert.match(res.body.prompt, /笔记搬家/)
    assert.match(res.body.prompt, /四百多篇笔记/)
    assert.match(res.body.prompt, keyword)
  }
  // 只是生成 prompt，不改文件、不生成任何别的文件
  assert.deepEqual(await vaultFiles(beer), [ASSIST_NOTE])
  assert.equal(await readFile(join(beer.vault, ASSIST_NOTE), 'utf8'), ASSIST_CONTENT)
})

test('AI 帮手：不认识的 kind、没有这篇文章时拒绝', async t => {
  const beer = await startBeer(t, { now: fixedNow, vault: { [ASSIST_NOTE]: ASSIST_CONTENT } })

  const bad = await beer.api('GET', `/articles/assist?path=${encodeURIComponent(ASSIST_NOTE)}&kind=writeit`)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'kind_invalid')

  const missing = await beer.api('GET', `/articles/assist?path=${encodeURIComponent(ARTICLES + '/2026-11-05-没有这篇/index.md')}&kind=outline`)
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not_found')
})
