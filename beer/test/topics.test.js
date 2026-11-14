import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles } from './helpers/beer.js'

const MODEL_PATH = 'POST /inference/go/openai/v1/chat/completions'
const BRIEF_PATH = '内容库/选题简报/2026-11-06.md'
const MATERIAL_MEETING = '内容库/素材/2026-11-04-周会'
const MATERIAL_FEEDBACK = '内容库/素材/2026-11-05-读者反馈'

const VAULT = {
  [`${MATERIAL_MEETING}/index.md`]: `---
类型: 录音
标签: [AI 工具, 写作]
状态: 可用
---
# 周会记录

每周二出选题简报；知乎、小红书先半自动跑一个月。
`,
  [`${MATERIAL_FEEDBACK}/index.md`]: `---
类型: 读者反馈
标签: [写作]
状态: 待整理
---
# 读者来信

读者问：你怎么安排写作时间？
`,
  '读书笔记/2026-11-03-卡片笔记.md': `# 卡片笔记

写作是把想法写下来再整理。` + '甲'.repeat(400) + '超过四百字的标记。\n',
  '内容库/素材/2025-01-01-旧素材/index.md': `---
类型: 文字
标签: [写作]
---
# 旧素材

不该出现的过期素材。
`,
  '.trash/2026-11-02-旧笔记/index.md': '# 旧笔记\n\n不该出现的回收站笔记。\n',
  '内容库/文章/2026-11-04-旧文/index.md': `---
标题: 旧文
状态: 草稿
日期: 2026-11-04
---

# 旧文

不该出现的文章正文。
`,
  '内容库/选题简报/2026-11-01.md': `---
日期: 2026-11-01
类型: 选题简报
状态: 已生成
---

# 2026-11-01 选题简报

不该出现的旧简报。
`,
}

const ANGLES = [
  {
    title: '小团队别先上自动化',
    why: '周会里反复提到流程比工具重要。',
    materials: [MATERIAL_MEETING],
  },
  {
    title: '会议纪要到底谁来写',
    why: '读者来信问到了写作分工。',
    materials: [MATERIAL_FEEDBACK],
  },
  {
    title: '半自动发布每月省多少时间',
    why: '半自动已经跑了一个月，有真实数据。',
    materials: [],
  },
]

/** 假模型：记录调用次数，默认回一份合法的角度 JSON。 */
async function startFakeModel(t, reply = () => JSON.stringify({ angles: ANGLES })) {
  let calls = 0
  const fake = await startFake(t, {
    [MODEL_PATH]: (_req, body) => {
      calls++
      const result = reply(calls, body)
      if (result && typeof result === 'object' && 'choices' in result) return result
      if (result && typeof result === 'object' && typeof result.status === 'number') return result
      return { choices: [{ message: { content: String(result) } }] }
    },
  })
  return Object.assign(fake, { calls: () => calls })
}

const newBeer = (t, model, more = {}) => startBeer(t, {
  vault: VAULT,
  config: { opencodeGoBase: model.url },
  secrets: { 'opencode-go-api-key': 'go-key' },
  now: () => new Date('2026-11-06T10:00:00Z'),
  ...more,
})

const vaultFiles = async beer => (await listFiles(beer.vault)).map(p => p.replaceAll('\\', '/'))

/** 按接口约定拆出 frontmatter 和正文（测试里的独立实现）。 */
function parseNote(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  const meta = {}
  if (!m) return { meta, body: content }
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: content.slice(m[0].length).replace(/^\r?\n/, '') }
}

/** frontmatter 里的 `素材:` 块（只给断言用）。 */
function materialLines(content) {
  const { meta } = parseNote(content)
  assert.equal('素材' in meta, true, 'index.md 开头要有 素材: 字段')
  return content
    .split(/\r?\n/)
    .filter(line => /^\s*-\s+.*\[\[/.test(line))
    .map(line => /\[\[([^\]]+)\]\]/.exec(line)?.[1])
    .filter(Boolean)
}

test('选题简报：第一次 ensure=1 生成并写文件，角度、素材清单和 frontmatter 都对', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  const res = await beer.api('GET', '/topics?ensure=1')

  assert.equal(res.status, 200)
  assert.equal(model.calls(), 1)
  assert.equal(res.body.date, '2026-11-06')
  assert.equal(res.body.briefPath, BRIEF_PATH)
  assert.equal(res.body.exists, true)
  assert.deepEqual(res.body.angles.map(a => a.title), ANGLES.map(a => a.title))
  assert.equal(res.body.angles[0].why, ANGLES[0].why)
  assert.deepEqual(res.body.angles[0].materials, [MATERIAL_MEETING])
  assert.deepEqual(res.body.topics, [])

  const content = await readFile(join(beer.vault, BRIEF_PATH), 'utf8')
  assert.equal(res.body.content, content)
  const { meta, body } = parseNote(content)
  assert.equal(meta['日期'], '2026-11-06')
  assert.equal(meta['类型'], '选题简报')
  assert.equal(meta['状态'], '已生成')
  assert.match(body, /## 角度/)
  assert.match(body, /小团队别先上自动化/)
  assert.match(body, /## 素材清单/)
  assert.match(body, /\[\[内容库\/素材\/2026-11-04-周会\]\]/)
  assert.match(body, /\[\[内容库\/素材\/2026-11-05-读者反馈\]\]/)

  // 发给模型的请求：带素材、笔记、读者反馈和 JSON 输出要求。
  const request = model.requests[0]
  assert.equal(request.headers.authorization, 'Bearer go-key')
  const prompt = request.body.messages.map(m => m.content).join('\n')
  assert.match(prompt, /周会记录/)
  assert.match(prompt, /录音/)
  assert.match(prompt, /AI 工具/)
  assert.match(prompt, /读者反馈/)
  assert.match(prompt, /读者来信/)
  assert.match(prompt, /卡片笔记/)
  assert.match(prompt, /写作是把想法写下来再整理/)
  assert.match(prompt, /angles/)
  assert.match(prompt, /why/)
  assert.doesNotMatch(prompt, /不该出现的回收站笔记/)
  assert.doesNotMatch(prompt, /不该出现的文章正文/)
  assert.doesNotMatch(prompt, /不该出现的旧简报/)
  assert.doesNotMatch(prompt, /不该出现的过期素材/, '只取最近 30 天的素材')
  assert.doesNotMatch(prompt, /超过四百字的标记/, '笔记只取前 400 字')
  // 读者反馈排在别的素材前面。
  assert.ok(prompt.indexOf('读者来信') < prompt.indexOf('周会记录'))
})

test('选题简报：第二次 ensure=1 直接返回已有文件，不再调模型', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  const first = await beer.api('GET', '/topics?ensure=1')
  const second = await beer.api('GET', '/topics?ensure=1')

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.exists, true)
  assert.equal(second.body.content, first.body.content)
  assert.equal(second.body.angles.length, ANGLES.length)
  assert.equal(model.calls(), 1)
})

test('选题简报：不带 ensure 时不会生成；文件不存在就如实返回 exists=false', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  const res = await beer.api('GET', '/topics')

  assert.equal(res.status, 200)
  assert.equal(res.body.exists, false)
  assert.equal(res.body.content, null)
  assert.deepEqual(res.body.angles, [])
  assert.equal(model.calls(), 0)
  assert.equal((await vaultFiles(beer)).includes(BRIEF_PATH), false)
})

test('选题简报：regenerate 强制重新调模型并覆盖当天文件', async t => {
  const model = await startFakeModel(t, call => JSON.stringify({
    angles: [{ title: `第 ${call} 版角度`, why: `第 ${call} 次生成。`, materials: [] }],
  }))
  const beer = await newBeer(t, model)
  await beer.api('GET', '/topics?ensure=1')

  const res = await beer.api('POST', '/topics/brief/regenerate')

  assert.equal(res.status, 200)
  assert.equal(res.body.exists, true)
  assert.equal(model.calls(), 2)
  assert.deepEqual(res.body.angles.map(a => a.title), ['第 2 版角度'])
  const content = await readFile(join(beer.vault, BRIEF_PATH), 'utf8')
  assert.match(content, /第 2 版角度/)
  assert.doesNotMatch(content, /第 1 版角度/)
})

test('选题简报：模型回的不是 JSON 时把原文写进正文并标「模型输出未解析」，angles 为空', async t => {
  const model = await startFakeModel(t, () => '这是模型随手写的一段话，不是 JSON。')
  const beer = await newBeer(t, model)

  const res = await beer.api('GET', '/topics?ensure=1')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.angles, [])
  assert.match(res.body.content, /模型输出未解析/)
  assert.match(res.body.content, /这是模型随手写的一段话，不是 JSON。/)
  const content = await readFile(join(beer.vault, BRIEF_PATH), 'utf8')
  assert.equal(content, res.body.content)
  assert.match(content, /类型: 选题简报/)
})

test('选题简报：模型不可用又没有当天文件时不写半成品；已有文件时不动它并回明确错误', async t => {
  let fail = false
  const model = await startFakeModel(t, () => (fail
    ? { status: 500, body: { error: 'boom' } }
    : JSON.stringify({ angles: ANGLES })))

  // 没有当天文件：生成失败，库里不能出现 选题简报 下的任何文件。
  const broken = await startBeer(t, {
    vault: VAULT,
    config: { opencodeGoBase: await deadUrl(t) },
    secrets: { 'opencode-go-api-key': 'go-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })
  const res = await broken.api('GET', '/topics?ensure=1')
  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'model_unreachable')
  assert.equal((await vaultFiles(broken)).some(p => p.startsWith('内容库/选题简报/2026-11-06')), false)

  // 已有当天文件：重新生成失败，文件逐字节不变。
  const beer = await newBeer(t, model)
  const first = await beer.api('GET', '/topics?ensure=1')
  assert.equal(first.status, 200)
  fail = true
  const before = await readFile(join(beer.vault, BRIEF_PATH))
  const again = await beer.api('POST', '/topics/brief/regenerate')
  assert.equal(again.status, 502)
  assert.equal(again.body.error.code, 'model_upstream_error')
  assert.deepEqual(await readFile(join(beer.vault, BRIEF_PATH)), before)
})

test('选角度建选题：新建状态为「选题」的文章，正文是 # 标题加「为什么值得写」引用，frontmatter 带素材链接', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await beer.api('GET', '/topics?ensure=1')

  const res = await beer.api('POST', '/topics/articles', {
    title: '小团队别先上自动化',
    why: '周会里反复提到流程比工具重要。',
    materials: [MATERIAL_MEETING, MATERIAL_FEEDBACK + '/index.md'],
  })

  assert.equal(res.status, 201)
  assert.equal(res.body.title, '小团队别先上自动化')
  assert.equal(res.body.status, '选题')
  assert.deepEqual(res.body.materials, [MATERIAL_MEETING, MATERIAL_FEEDBACK])
  assert.deepEqual(res.body.skipped, [])
  assert.match(res.body.path, /^内容库\/文章\/2026-11-06-小团队别先上自动化\/index\.md$/)

  const content = await readFile(join(beer.vault, res.body.path), 'utf8')
  const { meta, body } = parseNote(content)
  assert.equal(meta['标题'], '小团队别先上自动化')
  assert.equal(meta['状态'], '选题')
  assert.equal(meta['日期'], '2026-11-06')
  assert.deepEqual(materialLines(content), [MATERIAL_MEETING, MATERIAL_FEEDBACK])
  assert.equal(body, '# 小团队别先上自动化\n\n> 为什么值得写：周会里反复提到流程比工具重要。\n')

  // 选题分页同时列出状态为「选题」的文章。
  const topics = await beer.api('GET', '/topics?ensure=1')
  assert.deepEqual(topics.body.topics.map(a => [a.path, a.status]), [[res.body.path, '选题']])
  const articles = await beer.api('GET', '/articles?status=选题')
  assert.deepEqual(articles.body.articles.map(a => a.path), [res.body.path])
})

test('选角度建选题：素材也能按标题认出来；不存在的素材回 400 且不建文章', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  const byTitle = await beer.api('POST', '/topics/articles', {
    title: '会议纪要到底谁来写',
    materials: ['读者来信'],
  })
  assert.equal(byTitle.status, 201)
  assert.deepEqual(byTitle.body.materials, [MATERIAL_FEEDBACK])

  const before = await vaultFiles(beer)
  const missing = await beer.api('POST', '/topics/articles', {
    title: '不存在的素材',
    materials: ['内容库/素材/2026-11-05-没有这条'],
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'material_missing')
  assert.deepEqual(await vaultFiles(beer), before)
})

test('选角度建选题：skipMissing 时跳过笔记路径和不存在的素材，照样建并列出 skipped', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  const res = await beer.api('POST', '/topics/articles', {
    title: '笔记混进了素材引用',
    materials: [MATERIAL_MEETING, '读书笔记/2026-11-03-卡片笔记', '没有这个标题', '读者来信'],
    skipMissing: true,
  })
  assert.equal(res.status, 201)
  assert.deepEqual(res.body.materials, [MATERIAL_MEETING, MATERIAL_FEEDBACK])
  assert.deepEqual(res.body.skipped, ['读书笔记/2026-11-03-卡片笔记', '没有这个标题'])
  const content = await readFile(join(beer.vault, res.body.path), 'utf8')
  assert.deepEqual(materialLines(content), [MATERIAL_MEETING, MATERIAL_FEEDBACK])
  assert.equal(parseNote(content).body, '# 笔记混进了素材引用\n')

  // 全部对不上时也照样建，只是没有 素材: 字段。
  const none = await beer.api('POST', '/topics/articles', {
    title: '全是笔记', materials: ['读书笔记/2026-11-03-卡片笔记'], skipMissing: true,
  })
  assert.equal(none.status, 201)
  assert.deepEqual(none.body.materials, [])
  assert.deepEqual(none.body.skipped, ['读书笔记/2026-11-03-卡片笔记'])
  assert.equal(await readFile(join(beer.vault, none.body.path), 'utf8'),
    '---\n标题: 全是笔记\n状态: 选题\n日期: 2026-11-06\n---\n\n# 全是笔记\n')
})

test('简报提示词：明确笔记不能填进 materials', async t => {
  let prompt = ''
  const model = await startFakeModel(t, (_n, body) => {
    prompt = body.messages.map(m => m.content).join('\n')
    return JSON.stringify({ angles: ANGLES })
  })
  const beer = await newBeer(t, model)
  await beer.api('GET', '/topics?ensure=1')
  assert.match(prompt, /「笔记」一节里的路径不是素材，不要填进 materials/)
  assert.match(prompt, /## 笔记（每个只给前 400 字；只作参考，不能填进 materials）/)
})

test('多选素材放进选题：合并去重，正文和其余 frontmatter 逐字不变，素材一侧不写反向记录', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  const created = await beer.api('POST', '/topics/articles', {
    title: '把素材放进选题',
    materials: [MATERIAL_MEETING],
  })
  const path = created.body.path
  const before = await readFile(join(beer.vault, path), 'utf8')
  const meetingBefore = await readFile(join(beer.vault, MATERIAL_MEETING, 'index.md'), 'utf8')
  const feedbackBefore = await readFile(join(beer.vault, MATERIAL_FEEDBACK, 'index.md'), 'utf8')

  const res = await beer.api('POST', '/topics/materials', {
    path,
    materials: [MATERIAL_FEEDBACK, MATERIAL_MEETING, MATERIAL_MEETING + '/index.md'],
  })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.materials, [MATERIAL_MEETING, MATERIAL_FEEDBACK])
  const after = await readFile(join(beer.vault, path), 'utf8')
  assert.deepEqual(materialLines(after), [MATERIAL_MEETING, MATERIAL_FEEDBACK])
  // 正文逐字不变；frontmatter 里除 素材: 外逐字不变。
  assert.equal(parseNote(after).body, parseNote(before).body)
  assert.equal(
    after.replace(/\n素材:\r?\n(?:\s*-\s+.*\r?\n)+/, '\n').replace(/\r\n/g, '\n'),
    before.replace(/\n素材:\r?\n(?:\s*-\s+.*\r?\n)+/, '\n').replace(/\r\n/g, '\n'),
  )
  // 素材一侧没有任何反向记录。
  assert.equal(await readFile(join(beer.vault, MATERIAL_MEETING, 'index.md'), 'utf8'), meetingBefore)
  assert.equal(await readFile(join(beer.vault, MATERIAL_FEEDBACK, 'index.md'), 'utf8'), feedbackBefore)
})

test('多选素材放进选题：只接受状态为「选题」的文章，也不接受不存在的素材', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  const draftPath = '内容库/文章/2026-11-04-旧文/index.md'
  const before = await readFile(join(beer.vault, draftPath), 'utf8')

  const notTopic = await beer.api('POST', '/topics/materials', {
    path: draftPath,
    materials: [MATERIAL_MEETING],
  })
  assert.equal(notTopic.status, 409)
  assert.equal(notTopic.body.error.code, 'article_not_topic')
  assert.equal(await readFile(join(beer.vault, draftPath), 'utf8'), before)

  const created = await beer.api('POST', '/topics/articles', { title: '素材校验' })
  const missing = await beer.api('POST', '/topics/materials', {
    path: created.body.path,
    materials: ['内容库/素材/2026-11-05-没有这条'],
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'material_missing')
  assert.equal(await readFile(join(beer.vault, created.body.path), 'utf8'), `---\n标题: 素材校验\n状态: 选题\n日期: 2026-11-06\n---\n\n# 素材校验\n`)
})

test('和 AI 讨论角度：返回带当天简报和角度的 prompt，不调模型', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await beer.api('GET', '/topics?ensure=1')

  const res = await beer.api('GET', '/topics/discuss?angle=' + encodeURIComponent('会议纪要到底谁来写') + '&why=' + encodeURIComponent('读者来信问到了写作分工。'))

  assert.equal(res.status, 200)
  assert.equal(typeof res.body.prompt, 'string')
  assert.match(res.body.prompt, /会议纪要到底谁来写/)
  assert.match(res.body.prompt, /读者来信问到了写作分工。/)
  assert.match(res.body.prompt, /小团队别先上自动化/, 'prompt 要带当天简报上下文')
  assert.equal(model.calls(), 1)

  const bad = await beer.api('GET', '/topics/discuss')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'angle_missing')
})
