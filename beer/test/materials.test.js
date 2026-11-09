import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, listFiles } from './helpers/beer.js'

// 默认标签表（工单 #11）：库里没有标签表时按这一份返回。
const DEFAULT_TAGS = ['AI 工具', 'Obsidian', '笔记方法', '写作', '效率', '自动化', '费用', '内容运营', '读书', '生活']
// 默认类型集合：和现有条目里的类型合并，供筛选按钮用。
const DEFAULT_TYPES = ['录音', '链接', '图片', '文字', 'PDF', '手动']

const q = params => '?' + new URLSearchParams(params).toString()
// listFiles 在 Windows 上返回反斜杠；测试里统一成库内相对路径（/ 分隔）。
const vaultFiles = async dir => (await listFiles(dir)).map(f => f.replaceAll('\\', '/'))

test('素材：库里还没有素材时返回空列表，类型和标签给出默认值', async t => {
  const beer = await startBeer(t, { vault: { '笔记.md': '# hi\n' } })

  const res = await beer.api('GET', '/materials')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.entries, [])
  assert.deepEqual(res.body.types, DEFAULT_TYPES)
  assert.deepEqual(res.body.tags, DEFAULT_TAGS)
})

test('素材：列出条目，解析类型、标签、状态、来源、标题和摘要', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/素材/2026-11-04-周会/index.md': '---\n类型: 录音\n标签: [AI 工具, 写作]\n状态: 待整理\n来源: 家里转录\n---\n# 周会：Q4 内容排期\n\n每周二出选题简报；知乎、小红书先半自动。\n',
      '内容库/素材/2026-11-05-读书笔记/index.md': '---\n类型: 文字\n标签:\n  - 读书\n  - 笔记方法\n状态: 可用\n来源: 手动摘录\n---\n读书笔记正文。\n',
      '内容库/素材/2026-11-06-没有标题/index.md': '---\n类型: 手动\n---\n正文没有标题。\n',
      '内容库/素材/随手记.md': '---\n类型: 课程\n标签: 读书, 生活\n---\n# 随手记的标题\n\n一段摘要。\n',
      '内容库/素材/无属性.md': '# 无属性\n\n正文。\n',
      '内容库/素材/2026-11-07-录音摘要/index.md': '---\n标题: 周会录音\n类型: 会议\n---\n\n## 结论\n\n下周二发布 **第一篇** 文章。\n\n## 要点\n\n- 由我写初稿\n',
      '内容库/素材/标签表.md': '# 素材标签表\n\n## 标签\n\n- AI 工具\n- 读书\n',
      '内容库/素材/说明.md': '# 素材说明\n',
    },
  })

  const res = await beer.api('GET', '/materials')

  assert.equal(res.status, 200)
  const byPath = Object.fromEntries(res.body.entries.map(e => [e.path, e]))
  assert.deepEqual(Object.keys(byPath).sort(), [
    '内容库/素材/2026-11-04-周会/index.md',
    '内容库/素材/2026-11-05-读书笔记/index.md',
    '内容库/素材/2026-11-06-没有标题/index.md',
    '内容库/素材/2026-11-07-录音摘要/index.md',
    '内容库/素材/无属性.md',
    '内容库/素材/随手记.md',
  ])

  const meeting = byPath['内容库/素材/2026-11-04-周会/index.md']
  assert.equal(meeting.folder, '内容库/素材/2026-11-04-周会')
  assert.equal(meeting.title, '周会：Q4 内容排期')
  assert.equal(meeting.type, '录音')
  assert.deepEqual(meeting.tags, ['AI 工具', '写作'])
  assert.equal(meeting.status, '待整理')
  assert.equal(meeting.source, '家里转录')
  assert.equal(meeting.summary, '每周二出选题简报；知乎、小红书先半自动。')
  assert.ok(!Number.isNaN(Date.parse(meeting.modifiedAt)))

  const notes = byPath['内容库/素材/2026-11-05-读书笔记/index.md']
  assert.deepEqual(notes.tags, ['读书', '笔记方法'])
  assert.equal(notes.title, '2026-11-05-读书笔记') // 正文没有 `# ` 标题时用文件夹名
  assert.equal(notes.summary, '读书笔记正文。')
  // 录音摘要这种只有小标题的正文：标题取属性里的「标题」，摘要片段去掉 ## / ** / 列表符号。
  const recording = byPath['内容库/素材/2026-11-07-录音摘要/index.md']
  assert.equal(recording.title, '周会录音')
  assert.equal(recording.summary, '结论 下周二发布 第一篇 文章。 要点 由我写初稿')

  const noHeading = byPath['内容库/素材/2026-11-06-没有标题/index.md']
  assert.equal(noHeading.title, '2026-11-06-没有标题')
  assert.deepEqual(noHeading.tags, [])
  assert.equal(noHeading.status, '')
  assert.equal(noHeading.source, '')

  const loose = byPath['内容库/素材/随手记.md']
  assert.equal(loose.folder, '内容库/素材')
  assert.equal(loose.title, '随手记的标题')
  assert.deepEqual(loose.tags, ['读书', '生活']) // `标签: a, b` 也认

  const bare = byPath['内容库/素材/无属性.md']
  assert.equal(bare.title, '无属性')
  assert.equal(bare.type, '')
  assert.deepEqual(bare.tags, [])

  // 默认类型在前，现有条目里多出来的类型接在后面。
  assert.deepEqual(res.body.types, [...DEFAULT_TYPES, '会议', '课程'])
  assert.deepEqual(res.body.statuses, ['待整理', '可用'])
  assert.deepEqual(res.body.tags, ['AI 工具', '读书'])
})

test('素材：「录音」筛选也包括家里转录来的会议、访谈等录音（来源: 录音）', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/素材/2026-11-04-手动录音/index.md': '---\n类型: 录音\n---\n# 手动录音\n',
      '内容库/素材/2026-11-07-周会/index.md': '---\n标题: 周会\n类型: 会议\n来源: 录音\n录音编号: abc\n---\n摘要\n',
      '内容库/素材/2026-11-07-访谈/index.md': '---\n类型: 访谈\n来源: 录音\n---\n摘要\n',
      '内容库/素材/2026-11-07-文章/index.md': '---\n类型: 文字\n来源: 公众号\n---\n# 文章\n',
    },
  })
  const paths = res => res.body.entries.map(e => e.path).sort()

  assert.deepEqual(paths(await beer.api('GET', '/materials' + q({ type: '录音' }))), [
    '内容库/素材/2026-11-04-手动录音/index.md',
    '内容库/素材/2026-11-07-周会/index.md',
    '内容库/素材/2026-11-07-访谈/index.md',
  ])
  // 具体类型照样能单独筛
  assert.deepEqual(paths(await beer.api('GET', '/materials' + q({ type: '会议' }))), ['内容库/素材/2026-11-07-周会/index.md'])
})

test('素材：按类型、标签、状态筛选，可以叠加；类型和标签列表始终给全量', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/素材/2026-11-04-周会/index.md': '---\n类型: 录音\n标签: [AI 工具]\n状态: 待整理\n---\n# 周会\n',
      '内容库/素材/2026-11-05-读书/index.md': '---\n类型: 文字\n标签: [读书, 写作]\n状态: 可用\n---\n# 读书\n',
      '内容库/素材/2026-11-06-链接/index.md': '---\n类型: 链接\n标签: [AI 工具, 效率]\n状态: 可用\n---\n# 链接\n',
    },
  })
  const paths = body => body.entries.map(e => e.path)

  assert.deepEqual(paths((await beer.api('GET', '/materials' + q({ type: '录音' }))).body), ['内容库/素材/2026-11-04-周会/index.md'])
  assert.deepEqual(paths((await beer.api('GET', '/materials' + q({ tag: 'AI 工具' }))).body).sort(), [
    '内容库/素材/2026-11-04-周会/index.md',
    '内容库/素材/2026-11-06-链接/index.md',
  ])
  assert.deepEqual(paths((await beer.api('GET', '/materials' + q({ status: '可用' }))).body).sort(), [
    '内容库/素材/2026-11-05-读书/index.md',
    '内容库/素材/2026-11-06-链接/index.md',
  ])
  assert.deepEqual(paths((await beer.api('GET', '/materials' + q({ type: '文字', tag: '读书' }))).body), [
    '内容库/素材/2026-11-05-读书/index.md',
  ])
  assert.deepEqual(paths((await beer.api('GET', '/materials' + q({ type: 'PDF' }))).body), [])

  const filtered = (await beer.api('GET', '/materials' + q({ status: '可用' }))).body
  assert.deepEqual(filtered.types, DEFAULT_TYPES) // 筛选不缩窄类型按钮
  assert.deepEqual(filtered.tags, DEFAULT_TAGS) // 库里没有标签表时仍是默认标签
})

test('标签表：没有文件时返回默认标签；保存后写进 内容库/素材/标签表.md，重启后仍读到', async t => {
  const beer = await startBeer(t, { vault: {} })

  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, DEFAULT_TAGS)

  const saved = await beer.api('PUT', '/materials/tags', { tags: ['  AI 工具 ', 'AI 工具', '读书', '新标签'] })

  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.tags, ['AI 工具', '读书', '新标签']) // 去首尾空白、去重
  const file = await readFile(join(beer.vault, '内容库/素材/标签表.md'), 'utf8')
  assert.match(file, /## 标签/)
  assert.ok(file.includes('- AI 工具\n- 读书\n- 新标签\n'), '标签应该一行一个 `- 标签名`')

  // 标签表不算是素材条目；列表接口返回新的标签表。
  const list = await beer.api('GET', '/materials')
  assert.deepEqual(list.body.entries, [])
  assert.deepEqual(list.body.tags, ['AI 工具', '读书', '新标签'])

  // 重启 Harness（同一个库）后从文件里读回来。
  const again = await beer.restart()
  assert.deepEqual((await again.api('GET', '/materials/tags')).body.tags, ['AI 工具', '读书', '新标签'])
})

test('标签表：只重写列表区，文件里其他说明和列表保留', async t => {
  const original = [
    '# 我的标签',
    '',
    '这些字是我自己写的，Beer 不要动。',
    '',
    '## 标签',
    '',
    '先写一句说明，也别动。',
    '',
    '- 旧标签',
    '- 写作',
    '',
    '## 备注',
    '',
    '- 这一条不是标签，别删',
    '',
  ].join('\n')
  const beer = await startBeer(t, { vault: { '内容库/素材/标签表.md': original } })

  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, ['旧标签', '写作'])

  const saved = await beer.api('PUT', '/materials/tags', { tags: ['写作', '新标签'] })

  assert.equal(saved.status, 200)
  const file = await readFile(join(beer.vault, '内容库/素材/标签表.md'), 'utf8')
  assert.ok(file.includes('这些字是我自己写的，Beer 不要动。'))
  assert.ok(file.includes('先写一句说明，也别动。'))
  assert.ok(file.includes('## 备注'))
  assert.ok(file.includes('- 这一条不是标签，别删'))
  assert.ok(!file.includes('- 旧标签'))
  assert.ok(file.includes('- 写作\n- 新标签'))
  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, ['写作', '新标签'])
})

test('标签表：文件里没有 `## 标签` 标题时按顶层 `- 标签名` 读，保存时原地替换', async t => {
  const beer = await startBeer(t, { vault: { '内容库/素材/标签表.md': '- 甲\n- 乙\n' } })

  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, ['甲', '乙'])

  await beer.api('PUT', '/materials/tags', { tags: ['乙', '丙'] })

  assert.equal(await readFile(join(beer.vault, '内容库/素材/标签表.md'), 'utf8'), '- 乙\n- 丙\n')
  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, ['乙', '丙'])
})

test('标签表：POST 追加标签，重复的不重复加', async t => {
  const beer = await startBeer(t, { vault: {} })

  const first = await beer.api('POST', '/materials/tags', { tag: '新标签' })

  assert.equal(first.status, 200)
  assert.deepEqual(first.body.tags, [...DEFAULT_TAGS, '新标签'])

  const more = await beer.api('POST', '/materials/tags', { tags: ['新标签', '另一个'] })
  assert.equal(more.status, 200)
  assert.deepEqual(more.body.tags, [...DEFAULT_TAGS, '新标签', '另一个'])

  const duplicate = await beer.api('POST', '/materials/tags', { tag: 'AI 工具' })
  assert.deepEqual(duplicate.body.tags, [...DEFAULT_TAGS, '新标签', '另一个'])
})

test('标签表：拒绝空标签、换行、逗号、方括号和超长名字；被拒时什么文件都不写', async t => {
  const beer = await startBeer(t, { vault: {} })

  for (const tag of ['', '   ', 'a\nb', 'a\rb', 'a,b', '[a]', 'x'.repeat(41)]) {
    const res = await beer.api('PUT', '/materials/tags', { tags: [tag] })
    assert.equal(res.status, 400, `应拒绝标签 ${JSON.stringify(tag)}`)
    assert.equal(res.body.error.code, 'tag_invalid')
  }
  const notArray = await beer.api('PUT', '/materials/tags', { tags: '写作' })
  assert.equal(notArray.status, 400)
  assert.equal(notArray.body.error.code, 'tags_invalid')
  const tooMany = await beer.api('PUT', '/materials/tags', { tags: Array.from({ length: 101 }, (_, i) => `标签${i}`) })
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.body.error.code, 'tags_invalid')

  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, DEFAULT_TAGS)
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('开头属性：三种标签写法、引号、带冒号的值和 CRLF 都能读，属性区没闭合时整篇算正文', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/素材/2026-11-01-行内/index.md': '---\n类型: 录音\n标签: [AI 工具, 写作]\n状态: 待整理\n来源: https://example.com/a:b\n作者: "张三"\n---\n# 行内标题\n\n正文\n',
      '内容库/素材/2026-11-02-列表/index.md': '---\r\n类型: 文字\r\n标签:\r\n  - 读书\r\n  - 笔记方法\r\n状态: 可用\r\n---\r\n# 列表标题\r\n\r\n正文\r\n',
      '内容库/素材/2026-11-03-逗号/index.md': '---\n类型: 课程\n标签: 读书, 生活\n---\n# 逗号标题\n',
      '内容库/素材/没闭合.md': '---\n类型: 手动\n# 没闭合的标题\n',
    },
  })

  const res = await beer.api('GET', '/materials')

  assert.equal(res.status, 200)
  const byPath = Object.fromEntries(res.body.entries.map(e => [e.path, e]))
  // 行内数组、带引号的值、值里带冒号（网址）都能读。
  assert.equal(byPath['内容库/素材/2026-11-01-行内/index.md'].type, '录音')
  assert.deepEqual(byPath['内容库/素材/2026-11-01-行内/index.md'].tags, ['AI 工具', '写作'])
  assert.equal(byPath['内容库/素材/2026-11-01-行内/index.md'].source, 'https://example.com/a:b')
  assert.equal(byPath['内容库/素材/2026-11-01-行内/index.md'].title, '行内标题')
  // 缩进列表、CRLF：属性和正文都能读。
  assert.equal(byPath['内容库/素材/2026-11-02-列表/index.md'].type, '文字')
  assert.deepEqual(byPath['内容库/素材/2026-11-02-列表/index.md'].tags, ['读书', '笔记方法'])
  assert.equal(byPath['内容库/素材/2026-11-02-列表/index.md'].status, '可用')
  assert.equal(byPath['内容库/素材/2026-11-02-列表/index.md'].title, '列表标题')
  // `标签: a, b` 这种逗号写法也认。
  assert.deepEqual(byPath['内容库/素材/2026-11-03-逗号/index.md'].tags, ['读书', '生活'])
  // `---` 没闭合：整篇都当正文，属性和标签为空，标题仍从正文 H1 读。
  const unclosed = byPath['内容库/素材/没闭合.md']
  assert.equal(unclosed.type, '')
  assert.deepEqual(unclosed.tags, [])
  assert.equal(unclosed.title, '没闭合的标题')
})

test('新建手动素材：写成 内容库/素材/<日期>-<名称>/index.md，属性和正文正确，标签必须在标签表里', async t => {
  const beer = await startBeer(t, { vault: {}, now: () => new Date(2026, 10, 6, 10, 0, 0) })

  const created = await beer.api('POST', '/materials', {
    title: '小团队 AI 工作流',
    type: '手动',
    tags: ['AI 工具', '写作'],
    content: '先把流程跑顺，再谈自动化。',
  })

  assert.equal(created.status, 201)
  const entry = created.body.entry
  assert.equal(entry.path, '内容库/素材/2026-11-06-小团队 AI 工作流/index.md')
  assert.equal(entry.folder, '内容库/素材/2026-11-06-小团队 AI 工作流')
  assert.equal(entry.title, '小团队 AI 工作流')
  assert.equal(entry.type, '手动')
  assert.deepEqual(entry.tags, ['AI 工具', '写作'])
  assert.equal(entry.status, '待整理')
  assert.equal(entry.source, '手动录入')

  const file = await readFile(join(beer.vault, entry.path), 'utf8')
  assert.equal(file, '---\n类型: 手动\n标签: [AI 工具, 写作]\n状态: 待整理\n来源: 手动录入\n---\n# 小团队 AI 工作流\n\n先把流程跑顺，再谈自动化。\n')

  // 说明文件、标签表一起建好；它们本身不算素材条目。
  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-小团队 AI 工作流/index.md',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
  const guide = await readFile(join(beer.vault, '内容库/素材/说明.md'), 'utf8')
  assert.match(guide, /类型：录音、链接、图片、文字、PDF、手动/)
  assert.match(guide, /标签表\.md/)

  // 同名再建一条：文件夹自动加序号，不覆盖。
  const second = await beer.api('POST', '/materials', { title: '小团队 AI 工作流', type: '手动', tags: [], content: '' })
  assert.equal(second.status, 201)
  assert.equal(second.body.entry.path, '内容库/素材/2026-11-06-小团队 AI 工作流-2/index.md')

  // 不在标签表里的标签被拒，第二条不新增。
  const rejected = await beer.api('POST', '/materials', { title: '另一条', tags: ['标签表里没有'] })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'tag_unknown')
  assert.equal((await beer.api('GET', '/materials')).body.entries.length, 2)
})

test('新建手动素材：标题为空或不合法时被拒', async t => {
  const beer = await startBeer(t, { vault: {} })

  for (const title of [undefined, '', '   ', 42, '带\n换行']) {
    const res = await beer.api('POST', '/materials', { title, tags: [] })
    assert.equal(res.status, 400, `应拒绝标题 ${JSON.stringify(title)}`)
    assert.equal(res.body.error.code, 'title_invalid')
  }
  assert.deepEqual(await vaultFiles(beer.vault), [])
})

test('素材说明：init 建出 标签表.md 和 说明.md，已有的文件不被覆盖', async t => {
  const beer = await startBeer(t, { vault: {} })

  const init = await beer.api('POST', '/materials/init')

  assert.equal(init.status, 200)
  assert.equal(init.body.tagsPath, '内容库/素材/标签表.md')
  assert.equal(init.body.guidePath, '内容库/素材/说明.md')
  assert.deepEqual(init.body.tags, DEFAULT_TAGS)
  assert.deepEqual(await vaultFiles(beer.vault), ['内容库/素材/标签表.md', '内容库/素材/说明.md'])

  const custom = '# 我自己的标签表\n\n## 标签\n\n- 只有这个\n'
  const edited = await startBeer(t, {
    vault: { '内容库/素材/标签表.md': custom, '内容库/素材/说明.md': '# 我自己的说明\n' },
  })
  await edited.api('POST', '/materials/init')
  assert.equal(await readFile(join(edited.vault, '内容库/素材/标签表.md'), 'utf8'), custom)
  assert.equal(await readFile(join(edited.vault, '内容库/素材/说明.md'), 'utf8'), '# 我自己的说明\n')
})

test('新建素材：只能用标签表里的标签，刚加进标签表的新标签立刻能用', async t => {
  const beer = await startBeer(t, { vault: {}, now: () => new Date(2026, 10, 6, 10, 0, 0) })

  const denied = await beer.api('POST', '/materials', { title: '还不能用', tags: ['新主题'] })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error.code, 'tag_unknown')

  await beer.api('POST', '/materials/tags', { tag: '新主题' })
  const allowed = await beer.api('POST', '/materials', { title: '现在能用', tags: ['新主题'] })

  assert.equal(allowed.status, 201)
  assert.deepEqual(allowed.body.entry.tags, ['新主题'])
  assert.equal((await beer.api('GET', '/materials')).body.entries.length, 1)
})

test('标签表：文件原来用 CRLF 时保存后仍是 CRLF，其他内容保留', async t => {
  const original = '# 我的标签\r\n\r\n## 标签\r\n\r\n- 旧\r\n\r\n## 备注\r\n\r\n保留\r\n'
  const beer = await startBeer(t, { vault: { '内容库/素材/标签表.md': original } })

  assert.deepEqual((await beer.api('GET', '/materials/tags')).body.tags, ['旧'])
  await beer.api('PUT', '/materials/tags', { tags: ['新'] })

  const file = await readFile(join(beer.vault, '内容库/素材/标签表.md'), 'utf8')
  assert.ok(!/[^\r]\n/.test(file), '不应混入单独的 LF')
  assert.ok(file.includes('## 备注\r\n\r\n保留'))
  assert.ok(file.includes('- 新'))
  assert.ok(!file.includes('- 旧'))
})

test('新建素材：标题里的路径字符被替换，不会跑出 内容库/素材/', async t => {
  const beer = await startBeer(t, { vault: {}, now: () => new Date(2026, 10, 6, 10, 0, 0) })

  const slashes = await beer.api('POST', '/materials', { title: 'a/b:c*?"<>|', tags: [] })

  assert.equal(slashes.status, 201)
  assert.equal(slashes.body.entry.path.split('/').length, 4) // 内容库 / 素材 / 文件夹 / index.md
  assert.ok(!/[\/:*?"<>|]/.test(slashes.body.entry.folder.split('/').pop()))
  assert.ok(slashes.body.entry.folder.startsWith('内容库/素材/2026-11-06-a'))

  const dots = await beer.api('POST', '/materials', { title: '..', tags: [] })
  assert.equal(dots.status, 201)
  assert.equal(dots.body.entry.folder, '内容库/素材/2026-11-06-未命名')
  assert.deepEqual(await vaultFiles(beer.vault), [
    '内容库/素材/2026-11-06-a-b-c------/index.md',
    '内容库/素材/2026-11-06-未命名/index.md',
    '内容库/素材/标签表.md',
    '内容库/素材/说明.md',
  ])
})
