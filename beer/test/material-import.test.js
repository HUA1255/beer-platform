import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, deadUrl, listFiles, listen, makeTempDir } from './helpers/beer.js'
import { createBeerContext } from '../src/app.js'
import { createSaveMaterialTool, formatMaterialEntry, saveMaterial } from '../src/modules/material-import.js'

// listFiles 在 Windows 上返回反斜杠；测试里统一成库内相对路径（/ 分隔）。
const vaultFiles = async dir => (await listFiles(dir)).map(f => f.replaceAll('\\', '/'))
// 固定日期，条目文件夹名和 frontmatter 里的日期才稳定。
const NOW = () => new Date(2026, 10, 6, 10, 0, 0)

/** 起一个返回 HTML 的假网页；requests 记下收到的请求。 */
async function htmlPage(t, html, { status = 200, headers = {} } = {}) {
  const requests = []
  const server = await listen(t, (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers })
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(html)
  })
  return { url: server.url, requests }
}

test('URL 文章：抓正文写进素材条目，frontmatter 正确，说明文件自动建出', async t => {
  const page = await htmlPage(t, [
    '<!doctype html><html><head>',
    '<title>页面标题 - 站点</title>',
    '<meta property="og:title" content="小团队 AI 工作流">',
    '<meta name="description" content="页面简介">',
    '</head><body>',
    '<nav>导航不要</nav>',
    '<header>页头不要</header>',
    '<article>',
    '<h1>小团队 AI 工作流</h1>',
    '<p>第一段 &amp; 重点。</p>',
    '<script>alert(1)</script>',
    '<style>.a{color:red}</style>',
    '<p>第二段&nbsp;文字，&quot;引号&quot;和&#39;撇号&#39;。</p>',
    '</article>',
    '<aside>侧栏不要</aside>',
    '<footer>页脚不要</footer>',
    '</body></html>',
  ].join('\n'))
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/materials/import/url', { url: page.url + '/post', tags: ['AI 工具'] })

  assert.equal(res.status, 201)
  const entry = res.body.entry
  assert.equal(entry.path, '内容库/素材/2026-11-06-小团队 AI 工作流/index.md')
  assert.equal(entry.title, '小团队 AI 工作流')
  assert.equal(entry.type, '链接')
  assert.deepEqual(entry.tags, ['AI 工具'])
  assert.equal(entry.status, '待整理')
  assert.equal(entry.source, page.url + '/post')

  const file = await readFile(join(beer.vault, entry.path), 'utf8')
  assert.ok(file.startsWith([
    '---',
    '标题: 小团队 AI 工作流',
    '类型: 链接',
    '标签: [AI 工具]',
    '状态: 待整理',
    `来源: ${page.url}/post`,
    '日期: 2026-11-06',
    '---',
    '# 小团队 AI 工作流',
  ].join('\n')), file)
  assert.ok(file.includes('第一段 & 重点。'))
  assert.ok(file.includes('第二段 文字，"引号"和\'撇号\'。'))
  assert.ok(!file.includes('导航不要'))
  assert.ok(!file.includes('页头不要'))
  assert.ok(!file.includes('侧栏不要'))
  assert.ok(!file.includes('页脚不要'))
  assert.ok(!file.includes('alert(1)'))
  assert.ok(!file.includes('color:red'))

  // 说明文件和标签表一起建好；它们不算素材条目。
  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-小团队 AI 工作流/index.md',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
  const guide = await readFile(join(beer.vault, '内容库/素材/说明.md'), 'utf8')
  assert.match(guide, /整理素材前必须先读这个文件/)
  assert.match(guide, /标签表\.md/)
  assert.match(guide, /视频/)

  // 抓页面时带了普通 User-Agent，不是 Node 的默认值。
  assert.equal(page.requests.length, 1)
  assert.match(page.requests[0].headers['user-agent'], /Mozilla\/5\.0/)
})

test('URL 视频：只存页面标题和简介，不抓正文，类型记「链接」', async t => {
  const page = await htmlPage(t, [
    '<html><head>',
    '<title>视频页标题</title>',
    '<meta property="og:title" content="十分钟讲清 AI 工作流">',
    '<meta property="og:description" content="这期聊聊怎么把重复劳动交给 AI。">',
    '</head><body>',
    '<article><p>这是视频页的正文，不应该被保存。</p></article>',
    '</body></html>',
  ].join('\n'))
  const beer = await startBeer(t, {
    vault: {},
    now: NOW,
    // 视频站的域名没法改，测试里把请求转给本地假网页。
    fetch: (url, init) => {
      assert.equal(url, 'https://www.youtube.com/watch?v=abc123')
      return fetch(page.url + '/watch?v=abc123', init)
    },
  })

  const res = await beer.api('POST', '/materials/import/url', {
    url: 'https://www.youtube.com/watch?v=abc123',
    tags: ['AI 工具'],
  })

  assert.equal(res.status, 201)
  const entry = res.body.entry
  assert.equal(entry.type, '链接')
  assert.equal(entry.title, '十分钟讲清 AI 工作流')
  assert.equal(entry.source, 'https://www.youtube.com/watch?v=abc123')
  assert.equal(entry.path, '内容库/素材/2026-11-06-十分钟讲清 AI 工作流/index.md')

  const file = await readFile(join(beer.vault, entry.path), 'utf8')
  assert.ok(file.includes('标题：十分钟讲清 AI 工作流'))
  assert.ok(file.includes('简介：这期聊聊怎么把重复劳动交给 AI。'))
  assert.ok(!file.includes('这是视频页的正文'))
  assert.ok(!file.includes('<p>'))
})

test('URL 抓取失败：回 502 fetch_failed，库里一个文件都不写', async t => {
  const dead = await deadUrl(t)
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const unreachable = await beer.api('POST', '/materials/import/url', { url: dead + '/post', tags: [] })
  assert.equal(unreachable.status, 502)
  assert.equal(unreachable.body.error.code, 'fetch_failed')
  assert.match(unreachable.body.error.message, /抓取页面失败/)

  const broken = await htmlPage(t, '<html><body>服务端出错</body></html>', { status: 500 })
  const upstream = await beer.api('POST', '/materials/import/url', { url: broken.url, tags: [] })
  assert.equal(upstream.status, 502)
  assert.equal(upstream.body.error.code, 'fetch_failed')

  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('URL 导入：标签不在标签表里回 400 tag_unknown，不抓页面也不写文件', async t => {
  const page = await htmlPage(t, '<html><body><article><p>正文</p></article></body></html>')
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/materials/import/url', {
    url: page.url + '/post',
    tags: ['标签表里没有'],
  })

  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'tag_unknown')
  assert.match(res.body.error.message, /标签表/)
  assert.equal(page.requests.length, 0)
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('URL 导入：url 不是 http/https 或不是合法链接时回 400 url_invalid', async t => {
  const beer = await startBeer(t, { vault: {} })

  for (const url of [undefined, '', '   ', 42, 'not a url', 'ftp://example.com/a']) {
    const res = await beer.api('POST', '/materials/import/url', { url, tags: [] })
    assert.equal(res.status, 400, `应拒绝 url ${JSON.stringify(url)}`)
    assert.equal(res.body.error.code, 'url_invalid')
  }
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('本地 PDF：原文件复制进条目文件夹，index.md 写类型、原件、来源和摘要', async t => {
  const source = await makeTempDir(t, 'beer-source-', { '账单 2026.pdf': 'PDF-BYTES' })
  const filePath = join(source, '账单 2026.pdf')
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/materials/import/file', {
    filePath,
    tags: ['费用'],
    summary: '这个月的服务器账单。',
  })

  assert.equal(res.status, 201)
  const entry = res.body.entry
  assert.equal(entry.path, '内容库/素材/2026-11-06-账单 2026/index.md')
  assert.equal(entry.title, '账单 2026')
  assert.equal(entry.type, 'PDF')
  assert.deepEqual(entry.tags, ['费用'])
  assert.equal(entry.status, '待整理')
  assert.equal(entry.source, '本地文件')
  assert.equal(entry.summary, '这个月的服务器账单。')

  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-账单 2026/index.md',
    '内容库/素材/2026-11-06-账单 2026/账单 2026.pdf',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
  assert.equal(await readFile(join(beer.vault, '内容库/素材/2026-11-06-账单 2026/账单 2026.pdf'), 'utf8'), 'PDF-BYTES')
  const index = await readFile(join(beer.vault, entry.path), 'utf8')
  assert.ok(index.includes('标题: 账单 2026\n类型: PDF\n标签: [费用]\n状态: 待整理\n来源: 本地文件\n原件: 账单 2026.pdf\n日期: 2026-11-06'))
  assert.ok(index.endsWith('这个月的服务器账单。\n'))
})

test('本地图片：没有摘要时正文写「（待补充）」，原文件名保持不变', async t => {
  const source = await makeTempDir(t, 'beer-source-', { 'Screenshot.PNG': 'PNG-BYTES' })
  const filePath = join(source, 'Screenshot.PNG')
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/materials/import/file', { filePath, title: '账单截图', tags: ['费用'] })

  assert.equal(res.status, 201)
  const entry = res.body.entry
  assert.equal(entry.type, '图片')
  assert.equal(entry.title, '账单截图')
  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-账单截图/Screenshot.PNG',
    '内容库/素材/2026-11-06-账单截图/index.md',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
  const index = await readFile(join(beer.vault, entry.path), 'utf8')
  assert.ok(index.includes('类型: 图片'))
  assert.ok(index.includes('原件: Screenshot.PNG'))
  assert.ok(index.endsWith('（待补充）\n'))
  assert.equal(await readFile(join(beer.vault, '内容库/素材/2026-11-06-账单截图/Screenshot.PNG'), 'utf8'), 'PNG-BYTES')
})

test('本地文件导入：只接受存在且后缀受支持的绝对路径，被拒时不写文件', async t => {
  const source = await makeTempDir(t, 'beer-source-', { 'a.txt': 'text', 'dir/b.png': 'img' })
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const bad = [
    'a.txt',
    join(source, 'missing.pdf'),
    join(source, 'dir'),
    join(source, 'a.txt'),
    '',
  ]
  for (const filePath of bad) {
    const res = await beer.api('POST', '/materials/import/file', { filePath, tags: [] })
    assert.equal(res.status, 400, `应拒绝路径 ${JSON.stringify(filePath)}`)
    assert.ok(['file_path_invalid', 'file_type_invalid'].includes(res.body.error.code), res.body.error.code)
  }
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('本地文件导入：标签不在表里时被拒，不复制原文件', async t => {
  const source = await makeTempDir(t, 'beer-source-', { 'a.pdf': 'PDF' })
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/materials/import/file', {
    filePath: join(source, 'a.pdf'),
    tags: ['没有这个标签'],
  })

  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'tag_unknown')
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('本地文件导入：同名条目自动加序号，原文件都保留原文件名', async t => {
  const source = await makeTempDir(t, 'beer-source-', { 'a.pdf': 'PDF' })
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const first = await beer.api('POST', '/materials/import/file', {
    filePath: join(source, 'a.pdf'),
    title: '同名文件',
    tags: [],
  })
  const second = await beer.api('POST', '/materials/import/file', {
    filePath: join(source, 'a.pdf'),
    title: '同名文件',
    tags: [],
  })

  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(first.body.entry.path, '内容库/素材/2026-11-06-同名文件/index.md')
  assert.equal(second.body.entry.path, '内容库/素材/2026-11-06-同名文件-2/index.md')
  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-同名文件-2/a.pdf',
    '内容库/素材/2026-11-06-同名文件-2/index.md',
    '内容库/素材/2026-11-06-同名文件/a.pdf',
    '内容库/素材/2026-11-06-同名文件/index.md',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
})

test('本地文件导入：type 对不上或不是字符串时回 400 type_invalid', async t => {
  const source = await makeTempDir(t, 'beer-source-', { 'a.pdf': 'PDF' })
  const beer = await startBeer(t, { vault: {}, now: NOW })

  for (const type of ['手动', 42]) {
    const res = await beer.api('POST', '/materials/import/file', {
      filePath: join(source, 'a.pdf'),
      type,
      tags: [],
    })
    assert.equal(res.status, 400, `应拒绝 type ${JSON.stringify(type)}`)
    assert.equal(res.body.error.code, 'type_invalid')
  }
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('文字素材：正文原样写进条目，类型记「文字」', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const res = await beer.api('POST', '/materials/import/text', {
    title: '和朋友的聊天记录',
    content: '他说：先把重复的事交给工具。\n\n我说：那就从素材整理开始。',
    tags: ['写作', '效率'],
    type: '文字',
  })

  assert.equal(res.status, 201)
  const entry = res.body.entry
  assert.equal(entry.path, '内容库/素材/2026-11-06-和朋友的聊天记录/index.md')
  assert.equal(entry.title, '和朋友的聊天记录')
  assert.equal(entry.type, '文字')
  assert.deepEqual(entry.tags, ['写作', '效率'])
  assert.equal(entry.status, '待整理')
  assert.equal(entry.source, '手动录入')

  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-和朋友的聊天记录/index.md',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
  const file = await readFile(join(beer.vault, entry.path), 'utf8')
  assert.ok(file.includes('标题: 和朋友的聊天记录\n类型: 文字\n标签: [写作, 效率]\n状态: 待整理\n来源: 手动录入\n日期: 2026-11-06'))
  assert.ok(file.includes('他说：先把重复的事交给工具。\n\n我说：那就从素材整理开始。'))
})

test('文字素材：标题为空、正文为空、类型不是「文字」或标签不在表里都被拒，不写文件', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const cases = [
    [{ title: '', content: '正文' }, 'title_invalid'],
    [{ title: '标题', content: '   ' }, 'content_invalid'],
    [{ title: '标题', content: '正文', type: '手动' }, 'type_invalid'],
    [{ title: '标题', content: '正文', type: 42 }, 'type_invalid'],
    [{ title: '标题', content: '正文', tags: ['不存在'] }, 'tag_unknown'],
  ]
  for (const [body, code] of cases) {
    const res = await beer.api('POST', '/materials/import/text', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(res.body.error.code, code, JSON.stringify(body))
  }
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('说明文件：第一次导入时建出来，已有的 说明.md 和 标签表.md 不被覆盖', async t => {
  const guide = '# 我自己的素材说明\n\n这段字别动。\n'
  const tagTable = '# 我的标签表\n\n## 标签\n\n- 写作\n'
  const beer = await startBeer(t, {
    vault: { '内容库/素材/说明.md': guide, '内容库/素材/标签表.md': tagTable },
    now: NOW,
  })

  const res = await beer.api('POST', '/materials/import/text', {
    title: '用自定义标签表',
    content: '正文',
    tags: ['写作'],
  })

  assert.equal(res.status, 201)
  assert.equal(await readFile(join(beer.vault, '内容库/素材/说明.md'), 'utf8'), guide)
  assert.equal(await readFile(join(beer.vault, '内容库/素材/标签表.md'), 'utf8'), tagTable)
  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, ['写作'])
})

test('导入后 GET /materials 能看到新条目，类型、标签、来源都对', async t => {
  const source = await makeTempDir(t, 'beer-source-', { '账单.pdf': 'PDF' })
  const page = await htmlPage(t, '<html><body><article><p>文章正文。</p></article></body></html>')
  const beer = await startBeer(t, { vault: {}, now: NOW })

  const article = await beer.api('POST', '/materials/import/url', { url: page.url + '/post', tags: ['写作'] })
  const pdf = await beer.api('POST', '/materials/import/file', {
    filePath: join(source, '账单.pdf'),
    tags: ['费用'],
    summary: '账单摘要',
  })
  const text = await beer.api('POST', '/materials/import/text', {
    title: '一段文字',
    content: '文字正文',
    tags: ['效率'],
  })
  assert.equal(article.status, 201)
  assert.equal(pdf.status, 201)
  assert.equal(text.status, 201)

  const list = await beer.api('GET', '/materials')
  assert.equal(list.status, 200)
  const byPath = Object.fromEntries(list.body.entries.map(e => [e.path, e]))
  assert.deepEqual(Object.keys(byPath).sort(), [article.body.entry.path, pdf.body.entry.path, text.body.entry.path].sort())
  assert.equal(byPath[article.body.entry.path].type, '链接')
  assert.equal(byPath[article.body.entry.path].source, page.url + '/post')
  assert.equal(byPath[article.body.entry.path].summary, '文章正文。')
  assert.equal(byPath[pdf.body.entry.path].type, 'PDF')
  assert.equal(byPath[pdf.body.entry.path].source, '本地文件')
  assert.equal(byPath[pdf.body.entry.path].summary, '账单摘要')
  assert.equal(byPath[text.body.entry.path].type, '文字')
  assert.equal(byPath[text.body.entry.path].summary, '文字正文')
  assert.deepEqual(list.body.types, ['录音', '链接', '图片', '文字', 'PDF', '手动'])
  assert.deepEqual(list.body.tags, ['AI 工具', 'Obsidian', '笔记方法', '写作', '效率', '自动化', '费用', '内容运营', '读书', '生活'])
})

test('AI 工具逻辑 saveMaterial：按字段选链接 / 图片 / PDF / 文字 / 手动，返回条目属性', async t => {
  const source = await makeTempDir(t, 'beer-source-', { '页面.png': 'PNG' })
  const page = await htmlPage(t, '<html><body><article><p>文章正文。</p></article></body></html>')
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const ctx = createBeerContext({ config: { root: beer.dataDir }, secrets: {}, now: NOW })

  const link = await saveMaterial(ctx, { title: '对话里的链接', url: page.url + '/post', tags: ['写作'] })
  assert.equal(link.type, '链接')
  assert.equal(link.source, page.url + '/post')

  const text = await saveMaterial(ctx, { title: '对话里的文字', content: '一段正文', tags: ['效率'] })
  assert.equal(text.type, '文字')
  assert.equal(text.summary, '一段正文')

  const image = await saveMaterial(ctx, {
    title: '对话里的图片',
    filePath: join(source, '页面.png'),
    summary: '截图里的文字',
    tags: ['费用'],
  })
  assert.equal(image.type, '图片')
  assert.equal(image.source, '本地文件')
  assert.equal(image.summary, '截图里的文字')

  const manual = await saveMaterial(ctx, { title: '手动记一条', type: '手动', content: '手动正文', tags: [] })
  assert.equal(manual.type, '手动')
  assert.equal(manual.status, '待整理')

  const formatted = formatMaterialEntry(text)
  assert.match(formatted, /已写入素材：内容库\/素材\/2026-11-06-对话里的文字\/index\.md/)
  assert.match(formatted, /类型：文字/)
  assert.match(formatted, /标签：效率/)
})

test('AI 工具定义：名字、参数、描述里要求先读说明并按标签表选标签；execute 返回路径和属性', async t => {
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const ctx = createBeerContext({ config: { root: beer.dataDir }, secrets: {}, now: NOW })
  let definition
  const defineTool = config => (definition = config)

  const tool = createSaveMaterialTool(defineTool, ctx)

  assert.equal(tool.name, 'beer_save_material')
  assert.equal(tool.parameters.title.required, true)
  assert.deepEqual(tool.parameters.type.enum, ['链接', '图片', 'PDF', '文字', '手动'])
  assert.match(tool.description, /内容库\/素材\/说明\.md/)
  assert.match(tool.description, /标签只能从标签表里选/)
  assert.equal(tool.output.schema.type, 'string')

  const output = await tool.execute({ title: '工具写的文字', content: '正文', tags: ['写作'] }, {})
  assert.match(output, /已写入素材：内容库\/素材\/2026-11-06-工具写的文字\/index\.md/)
  assert.match(output, /标题：工具写的文字/)
  assert.match(output, /标签：写作/)
  assert.equal(definition, tool)
})

test('AI 工具逻辑 saveMaterial：连不上、标签不对、缺字段时抛出带中文原因的 Error', async t => {
  const dead = await deadUrl(t)
  const beer = await startBeer(t, { vault: {}, now: NOW })
  const ctx = createBeerContext({ config: { root: beer.dataDir }, secrets: {}, now: NOW })

  await assert.rejects(
    () => saveMaterial(ctx, { title: '抓不到', url: dead + '/post', tags: [] }),
    error => error.code === 'fetch_failed' && /抓取页面失败/.test(error.message),
  )
  await assert.rejects(
    () => saveMaterial(ctx, { title: '标签不对', content: '正文', tags: ['标签表里没有'] }),
    error => error.code === 'tag_unknown' && /标签表/.test(error.message),
  )
  await assert.rejects(
    () => saveMaterial(ctx, { content: '没有标题' }),
    error => error.code === 'title_invalid' && /标题/.test(error.message),
  )
  await assert.rejects(
    () => saveMaterial(ctx, { title: '没有路径', type: '图片' }),
    error => error.code === 'file_path_invalid' && /filePath/.test(error.message),
  )
  await assert.rejects(
    () => saveMaterial(ctx, { title: '没有链接', type: '链接' }),
    error => error.code === 'url_invalid' && /url/.test(error.message),
  )
  await assert.rejects(
    () => saveMaterial(ctx, { title: '类型不对', type: '录音' }),
    error => error.code === 'type_invalid' && /类型/.test(error.message),
  )

  assert.deepEqual(await vaultFiles(beer.vault), [])
})
