import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, listFiles } from './helpers/beer.js'

const MODEL_PATH = 'POST /inference/go/openai/v1/chat/completions'
const ARTICLE = '内容库/文章/2026-11-06-规则测试'
const INDEX = ARTICLE + '/index.md'
const ZHIHU = ARTICLE + '/知乎.md'
const HARD = '内容库/规则/硬规则.md'
const SOFT = '内容库/规则/软规则.md'
const MAIN = `---
标题: 规则测试
状态: 成稿
日期: 2026-11-06
---

# 规则测试

第一段正文，讲一个观点。
第二段正文，给出理由。
第三段正文，做总结。
`
const RULE = '开头要直接给结论'

function versionOf(text) {
  return 'sha256-' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

const vaultFiles = async beer => (await listFiles(beer.vault)).map(p => p.replaceAll('\\', '/'))

const modelReply = content => ({ choices: [{ message: { content } }] })
/** 假模型常把 JSON 包在代码块里，这里故意跟着包，顺便验证服务端能解析。 */
const jsonReply = value => modelReply('```json\n' + JSON.stringify(value) + '\n```')

/**
 * 假模型：按系统提示区分三类请求。
 *   generate 平台改写 / observe 归纳规则 / check 硬规则检查
 * options 可以按类型覆盖回复；返回 { status, body } 时模拟上游错误。
 */
async function startFakeModel(t, options = {}) {
  const calls = []
  const fake = await startFake(t, {
    [MODEL_PATH]: (_req, body) => {
      const messages = body?.messages ?? []
      const system = String(messages[0]?.content ?? '')
      const user = String(messages[1]?.content ?? '')
      const kind = system.includes('硬规则检查') ? 'check'
        : system.includes('写作规则归纳') ? 'observe'
          : 'generate'
      calls.push({ kind, messages, user, body })
      if (kind === 'check') {
        return options.check ? options.check(user) : jsonReply({ violations: [] })
      }
      if (kind === 'observe') {
        return options.observe ? options.observe(user) : jsonReply({
          rules: [{ rule: RULE, evidence: '把开头改成了先给结论' }],
        })
      }
      if (options.generate) return options.generate(user)
      const platform = user.includes('小红书') ? '小红书' : '知乎'
      return modelReply(`${platform}改写版\n\n这是给${platform}的正文。`)
    },
  })
  return Object.assign(fake, {
    calls: () => calls,
    kinds: () => calls.map(c => c.kind),
  })
}

const newBeer = (t, model, more = {}) => startBeer(t, {
  vault: { [INDEX]: MAIN },
  config: { opencodeGoBase: model.url },
  secrets: { 'opencode-go-api-key': 'go-key' },
  now: () => new Date('2026-11-06T10:00:00Z'),
  ...more,
})

/** 打开开关（默认是关的）。 */
const enable = (beer, enabled = true) => beer.api('PUT', '/rules/settings', { enabled })

test('规则开关默认关闭；可以打开、关闭并持久化', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  assert.deepEqual((await beer.api('GET', '/rules/settings')).body, { enabled: false })

  const on = await enable(beer)
  assert.equal(on.status, 200)
  assert.deepEqual(on.body, { enabled: true })
  assert.equal((await beer.api('GET', '/rules/settings')).body.enabled, true)
  assert.equal((await beer.api('GET', '/rules')).body.enabled, true)

  const bad = await beer.api('PUT', '/rules/settings', { enabled: 'yes' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'enabled_invalid')

  // 重启（同一数据目录）后开关还记得。
  const restarted = await beer.restart()
  assert.equal((await restarted.api('GET', '/rules/settings')).body.enabled, true)
})

test('开关关闭：observe 不调模型、不学习、不写规则；生成不检查硬规则、提示词里不放规则', async t => {
  const model = await startFakeModel(t)
  const hardText = '# 我的硬规则\n\n- 已有硬规则\n'
  const softText = '# 我的软规则\n\n- 已有软规则\n'
  const beer = await newBeer(t, model, {
    vault: { [INDEX]: MAIN, [HARD]: hardText, [SOFT]: softText },
  })

  // 生成时不检查硬规则（硬规则非空也只调一次改写模型），提示词里没有软规则。
  const gen = await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })
  assert.equal(gen.status, 200)
  assert.deepEqual(gen.body.hardRuleWarnings, [])
  assert.equal(gen.body.hardRuleCheckError, undefined)
  assert.deepEqual(model.kinds(), ['generate'])
  assert.ok(!JSON.stringify(model.calls()[0].messages).includes('已有软规则'), '关闭时提示词里不能有软规则')

  // 观察改稿只回「已关闭」，不调模型、不写任何规则文件。
  const observed = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })
  assert.equal(observed.status, 200)
  assert.deepEqual(observed.body, { observed: false, reason: 'disabled', added: [], pending: [] })
  assert.deepEqual(model.kinds(), ['generate'])

  // 规则文件原样保留，没有新建规则文件。
  assert.equal(await readFile(join(beer.vault, HARD), 'utf8'), hardText)
  assert.equal(await readFile(join(beer.vault, SOFT), 'utf8'), softText)
  assert.deepEqual(await vaultFiles(beer), [HARD, SOFT, INDEX, ZHIHU].sort())
})

test('观察改稿：第 1、2 次只累计、不满 3 次转正回 409；第 3 次进 pending', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await enable(beer)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })

  // 用户在 Obsidian 里补了一句总结。
  const zhihuPath = join(beer.vault, ARTICLE, '知乎.md')
  await writeFile(zhihuPath, (await readFile(zhihuPath, 'utf8')) + '\n我补了一句总结。\n')

  const first = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })
  assert.equal(first.status, 200)
  assert.equal(first.body.observed, true)
  assert.deepEqual(first.body.added, [{ rule: RULE, evidence: '把开头改成了先给结论', count: 1 }])
  assert.deepEqual(first.body.pending, [])
  // 归纳请求带上了生成时正文和用户改后的正文。
  const observeCall = model.calls().find(c => c.kind === 'observe')
  assert.match(observeCall.user, /这是给知乎的正文/)
  assert.match(observeCall.user, /我补了一句总结/)

  // 第一次的提示里还没有已观察的规则；第二次起带上，让模型意思相同时沿用原文，计数才能累加。
  assert.doesNotMatch(observeCall.user, /已经记下的规则/)
  const second = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })
  const secondCall = model.calls().filter(c => c.kind === 'observe')[1]
  assert.match(secondCall.user, /已经记下的规则/)
  assert.ok(secondCall.user.includes(`- ${RULE}`), '第二次归纳要带上第一次记下的规则原文')
  assert.deepEqual(second.body.added, [{ rule: RULE, evidence: '把开头改成了先给结论', count: 2 }])
  assert.deepEqual(second.body.pending, [])

  const early = await beer.api('POST', '/rules/promote', { rule: RULE, kind: 'hard' })
  assert.equal(early.status, 409)
  assert.equal(early.body.error.code, 'rule_not_ready')
  assert.deepEqual(await vaultFiles(beer), [INDEX, ZHIHU].sort())

  const third = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })
  assert.deepEqual(third.body.pending, [{ rule: RULE, count: 3 }])

  const list = await beer.api('GET', '/rules')
  assert.deepEqual(list.body.pending, [{ rule: RULE, count: 3 }])
  assert.deepEqual(list.body.observations, [{ rule: RULE, count: 3 }])
  assert.deepEqual(list.body.hard, [])
  assert.deepEqual(list.body.soft, [])

  const promoted = await beer.api('POST', '/rules/promote', { rule: RULE, kind: 'hard' })
  assert.equal(promoted.status, 200)
  assert.equal(promoted.body.path, HARD)
  assert.deepEqual(promoted.body.hard, [RULE])
  assert.deepEqual(promoted.body.pending, [])
  assert.deepEqual(promoted.body.observations, [])
  assert.equal(await readFile(join(beer.vault, HARD), 'utf8'), `- ${RULE}\n`)
  assert.deepEqual(await vaultFiles(beer), [HARD, INDEX, ZHIHU].sort())
})

test('转正：软规则写进软规则文件；类型不认识回 400', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await enable(beer)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })
  const zhihuPath = join(beer.vault, ARTICLE, '知乎.md')
  await writeFile(zhihuPath, (await readFile(zhihuPath, 'utf8')) + '\n结尾加一句提问。\n')
  for (let i = 0; i < 3; i++) await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })

  const bad = await beer.api('POST', '/rules/promote', { rule: RULE, kind: 'medium' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'kind_invalid')

  const res = await beer.api('POST', '/rules/promote', { rule: RULE, kind: 'soft' })
  assert.equal(res.status, 200)
  assert.equal(res.body.path, SOFT)
  assert.deepEqual(res.body.soft, [RULE])
  assert.equal(await readFile(join(beer.vault, SOFT), 'utf8'), `- ${RULE}\n`)
  assert.equal((await beer.api('GET', '/rules/settings')).body.enabled, true)
})

test('规则文件保留用户手写内容；生成时软规则进提示词、硬规则参与检查并回 warnings', async t => {
  const hardText = '# 我的硬规则\n\n这段说明不要动。\n\n- 已有硬规则\n'
  const softText = '# 我的软规则\n\n- 已有软规则\n'
  const model = await startFakeModel(t, {
    check: () => jsonReply({
      violations: [{ rule: '已有硬规则', reason: '正文结尾用了绝对化表达' }],
    }),
  })
  const beer = await newBeer(t, model, {
    vault: { [INDEX]: MAIN, [HARD]: hardText, [SOFT]: softText },
  })
  await enable(beer)

  const res = await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.hardRuleWarnings.map(w => [w.rule, w.reason]), [
    ['已有硬规则', '正文结尾用了绝对化表达'],
  ])
  assert.equal(res.body.hardRuleCheckError, undefined)
  // 先改写、再检查；软规则只出现在改写提示词里。
  assert.deepEqual(model.kinds(), ['generate', 'check'])
  assert.ok(JSON.stringify(model.calls()[0].messages).includes('已有软规则'), '软规则要进生成提示词')
  assert.ok(JSON.stringify(model.calls()[1].messages).includes('已有硬规则'), '硬规则要进检查提示词')
  assert.ok(JSON.stringify(model.calls()[1].messages).includes('这是给知乎的正文'), '检查的是生成的正文')

  // 检查不改规则文件。
  assert.equal(await readFile(join(beer.vault, HARD), 'utf8'), hardText)
  assert.equal(await readFile(join(beer.vault, SOFT), 'utf8'), softText)
  assert.deepEqual((await beer.api('GET', '/rules')).body.hard, ['已有硬规则'])
  assert.deepEqual((await beer.api('GET', '/rules')).body.soft, ['已有软规则'])

  // 转正时只在文件末尾追加一条，说明文字和已有规则原样保留。
  const zhihuPath = join(beer.vault, ARTICLE, '知乎.md')
  await writeFile(zhihuPath, (await readFile(zhihuPath, 'utf8')) + '\n用户补了一段。\n')
  for (let i = 0; i < 3; i++) await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })
  const promoted = await beer.api('POST', '/rules/promote', { rule: RULE, kind: 'hard' })
  assert.equal(promoted.status, 200)
  assert.equal(await readFile(join(beer.vault, HARD), 'utf8'), hardText + `- ${RULE}\n`)
  assert.deepEqual(promoted.body.hard, ['已有硬规则', RULE])
})

test('硬规则检查失败不阻塞平台版本生成：版本照常写入，warnings 为空并带错误说明', async t => {
  const model = await startFakeModel(t, {
    check: () => ({ status: 500, body: { error: '上游炸了' } }),
  })
  const beer = await newBeer(t, model, {
    vault: { [INDEX]: MAIN, [HARD]: '- 已有硬规则\n' },
  })
  await enable(beer)

  const res = await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.versions.map(v => v.platform), ['知乎'])
  assert.deepEqual(res.body.hardRuleWarnings, [])
  assert.match(res.body.hardRuleCheckError, /模型接口返回 500|上游/)
  const zhihu = await readFile(join(beer.vault, ARTICLE, '知乎.md'), 'utf8')
  assert.match(zhihu, /这是给知乎的正文/)
})

test('改稿没有生成时快照：observe 回 no_snapshot，不学习、不调模型', async t => {
  const model = await startFakeModel(t)
  const oldVersion = `---
平台: 知乎
主稿版本: ${versionOf(MAIN)}
生成时间: 2026-11-05T10:00:00.000Z
生成内容版本: ${versionOf('旧正文\n')}
---

旧正文
`
  const beer = await newBeer(t, model, { vault: { [INDEX]: MAIN, [ZHIHU]: oldVersion } })
  await enable(beer)

  const res = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { observed: false, reason: 'no_snapshot', added: [], pending: [] })
  assert.deepEqual(model.kinds(), [])
  assert.deepEqual((await beer.api('GET', '/rules')).body.observations, [])
})

test('改稿没有变化：observe 回 unchanged，不调模型', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await enable(beer)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })
  assert.deepEqual(model.kinds(), ['generate'])

  const res = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '知乎' })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { observed: false, reason: 'unchanged', added: [], pending: [] })
  assert.deepEqual(model.kinds(), ['generate'])
})

test('观察和转正的参数校验：平台、路径、规则不能乱填', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await enable(beer)

  const badPlatform = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '微博' })
  assert.equal(badPlatform.status, 400)
  assert.equal(badPlatform.body.error.code, 'platform_invalid')

  const badPath = await beer.api('POST', '/rules/observe', { path: ZHIHU, platform: '小红书' })
  assert.equal(badPath.status, 400)
  assert.equal(badPath.body.error.code, 'path_invalid')

  const badRule = await beer.api('POST', '/rules/promote', { rule: '  ', kind: 'hard' })
  assert.equal(badRule.status, 400)
  assert.equal(badRule.body.error.code, 'rule_invalid')
  assert.deepEqual(model.kinds(), [])
})
