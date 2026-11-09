import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles } from './helpers/beer.js'

const MODEL_PATH = 'POST /inference/go/openai/v1/chat/completions'
const ARTICLE = '内容库/文章/2026-11-06-平台版本测试'
const INDEX = ARTICLE + '/index.md'
const MAIN = `---
标题: 平台版本测试
状态: 成稿
日期: 2026-11-06
---

# 平台版本测试

第一段正文，讲一个观点。
第二段正文，给出理由。
第三段正文，做总结。
`

/** library 的版本格式：sha256-<十六进制>。 */
function versionOf(text) {
  return 'sha256-' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** 按接口约定拆出 frontmatter 和正文（测试里的独立实现，不复用服务端代码）。 */
function parsePlatformFile(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  const meta = {}
  if (!m) return { meta, body: content }
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: content.slice(m[0].length).replace(/^\r?\n/, '') }
}

const vaultFiles = async beer => (await listFiles(beer.vault)).map(p => p.replaceAll('\\', '/'))

/** 假模型：按请求里提到的平台返回不同正文；reply 可自定义每轮内容。 */
async function startFakeModel(t, reply = platform => `${platform}改写版\n\n这是给${platform}的正文。`) {
  let calls = 0
  const fake = await startFake(t, {
    [MODEL_PATH]: (_req, body) => {
      const text = JSON.stringify(body?.messages ?? [])
      const platform = text.includes('知乎') ? '知乎' : text.includes('小红书') ? '小红书' : ''
      calls++
      return { choices: [{ message: { content: reply(platform, calls) } }] }
    },
  })
  return Object.assign(fake, { calls: () => calls })
}

const newBeer = (t, model, more = {}) => startBeer(t, {
  vault: { [INDEX]: MAIN },
  config: { opencodeGoBase: model.url },
  secrets: { 'opencode-go-api-key': 'go-key' },
  now: () => new Date('2026-11-06T10:00:00Z'),
  ...more,
})

test('生成平台版本：按平台调模型改写，写 知乎.md / 小红书.md，元数据正确，主稿一个字节都不改', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  const before = await readFile(join(beer.vault, INDEX))

  const res = await beer.api('POST', '/articles/versions/generate', { path: INDEX })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.versions.map(v => [v.platform, v.path, v.action]), [
    ['知乎', ARTICLE + '/知乎.md', 'ok'],
    ['小红书', ARTICLE + '/小红书.md', 'ok'],
  ])
  assert.deepEqual(await vaultFiles(beer), [INDEX, ARTICLE + '/小红书.md', ARTICLE + '/知乎.md'])

  const zhihu = await readFile(join(beer.vault, ARTICLE, '知乎.md'), 'utf8')
  const { meta, body } = parsePlatformFile(zhihu)
  assert.deepEqual(
    { platform: meta['平台'], mainDraftVersion: meta['主稿版本'], generatedAt: meta['生成时间'] },
    { platform: '知乎', mainDraftVersion: versionOf(MAIN), generatedAt: '2026-11-06T10:00:00.000Z' },
  )
  assert.match(meta['生成内容版本'], /^sha256-[0-9a-f]{64}$/)
  assert.equal(body, '知乎改写版\n\n这是给知乎的正文。\n')
  assert.equal(meta['生成内容版本'], versionOf(body))
  assert.equal(parsePlatformFile(await readFile(join(beer.vault, ARTICLE, '小红书.md'), 'utf8')).meta['平台'], '小红书')

  // 假模型收到的是改写请求：带主稿全文、平台名，不是让模型照抄。
  assert.equal(model.requests.length, 2)
  for (const req of model.requests) {
    assert.equal(req.headers.authorization, 'Bearer go-key')
    assert.match(req.headers['content-type'], /application\/json/)
    assert.ok(req.headers['x-opencode-session'])
    assert.equal(req.body.model, 'deepseek-v4.1-flash')
    assert.equal(typeof req.body.temperature, 'number')
    assert.ok(req.body.messages.some(m => m.content.includes(MAIN)), '请求里要有主稿全文')
  }
  assert.match(JSON.stringify(model.requests[0].body), /知乎/)
  assert.match(JSON.stringify(model.requests[1].body), /小红书/)

  // 主稿只读：生成前后逐字节一致。
  assert.deepEqual(await readFile(join(beer.vault, INDEX)), before)
})

test('生成平台版本：可以只生成知乎；平台名只接受知乎、小红书', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  const res = await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.versions.map(v => v.platform), ['知乎'])
  assert.deepEqual(await vaultFiles(beer), [INDEX, ARTICLE + '/知乎.md'])
  assert.equal(model.requests.length, 1)

  for (const platforms of [['微博'], [], '知乎', [42]]) {
    const bad = await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms })
    assert.equal(bad.status, 400, JSON.stringify(platforms))
    assert.equal(bad.body.error.code, 'platform_invalid')
  }
  assert.equal(model.requests.length, 1)
})

test('改写提示：只用主稿里有的内容，主稿短就写短，不凑小节', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)

  await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })

  const prompt = JSON.stringify(model.requests[0].body.messages)
  assert.match(prompt, /不要编造/)
  assert.match(prompt, /主稿很短/)
})

test('生成平台版本：没 key、401、连不上、回包看不懂都给出明确错误，且不写平台版本文件', async t => {
  const before = Buffer.from(MAIN)
  const cases = []

  // 没有 key：不向模型发请求。
  const model = await startFakeModel(t)
  const noKey = await startBeer(t, {
    vault: { [INDEX]: MAIN },
    config: { opencodeGoBase: model.url },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })
  cases.push({ beer: noKey, status: 503, code: 'model_no_key', message: /钥匙串/ })

  // key 无效。
  const deniedModel = await startFake(t, { [MODEL_PATH]: () => ({ status: 401, body: { error: 'Unauthorized' } }) })
  cases.push({ beer: await newBeer(t, deniedModel), status: 502, code: 'model_unauthorized', message: /API key/ })

  // 连不上 / 超时。
  const unreachable = await startBeer(t, {
    vault: { [INDEX]: MAIN },
    config: { opencodeGoBase: await deadUrl(t) },
    secrets: { 'opencode-go-api-key': 'go-key' },
    now: () => new Date('2026-11-06T10:00:00Z'),
  })
  cases.push({ beer: unreachable, status: 502, code: 'model_unreachable', message: /连不上/ })

  // 回包结构不认识。
  const badModel = await startFake(t, { [MODEL_PATH]: () => ({ choices: [] }) })
  cases.push({ beer: await newBeer(t, badModel), status: 502, code: 'model_bad_response', message: /格式/ })

  for (const c of cases) {
    const res = await c.beer.api('POST', '/articles/versions/generate', { path: INDEX })
    assert.equal(res.status, c.status, c.code)
    assert.equal(res.body.error.code, c.code)
    assert.match(res.body.error.message, c.message)
    assert.deepEqual(await vaultFiles(c.beer), [INDEX], `${c.code} 时不能写平台版本`)
    assert.deepEqual(await readFile(join(c.beer.vault, INDEX)), before, `${c.code} 时主稿不能变`)
  }
  assert.equal(model.requests.length, 0)
  assert.equal(deniedModel.requests.length, 1)
})

test('平台版本列表：生成后显示元数据；生成后又改主稿则标为「主稿已更新」，未改过的版本可重新生成', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  const listPath = '/articles/versions?path=' + encodeURIComponent(INDEX)

  const empty = await beer.api('GET', listPath)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { versions: [] })

  await beer.api('POST', '/articles/versions/generate', { path: INDEX })
  const fresh = await beer.api('GET', listPath)
  assert.equal(fresh.status, 200)
  assert.deepEqual(fresh.body.versions.map(v => [v.platform, v.path, v.stale, v.userEdited, v.action]), [
    ['知乎', ARTICLE + '/知乎.md', false, false, 'ok'],
    ['小红书', ARTICLE + '/小红书.md', false, false, 'ok'],
  ])
  assert.equal(fresh.body.versions[0].generatedAt, '2026-11-06T10:00:00.000Z')
  assert.equal(fresh.body.versions[0].mainDraftVersion, versionOf(MAIN))
  assert.equal((await beer.api('GET', '/articles/versions?path=' + encodeURIComponent(ARTICLE))).status, 200)

  // 用户在主稿里改了一行：两个平台版本都应该变成「主稿已更新」。
  const updated = MAIN.replace('第三段正文，做总结。', '第三段正文改过了。')
  await writeFile(join(beer.vault, INDEX), updated)
  const stale = await beer.api('GET', listPath)

  assert.deepEqual(stale.body.versions.map(v => [v.platform, v.stale, v.userEdited, v.action]), [
    ['知乎', true, false, 'regenerate'],
    ['小红书', true, false, 'regenerate'],
  ])
  assert.equal(stale.body.versions[0].mainDraftVersion, versionOf(MAIN))
  assert.equal((await beer.api('GET', '/articles/versions')).status, 400)
})

test('用户改过的平台版本：标记 userEdited，generate / regenerate 都不覆盖，并给出主稿新增和删除的行', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  const listPath = '/articles/versions?path=' + encodeURIComponent(INDEX)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX })

  const zhihuPath = join(beer.vault, ARTICLE, '知乎.md')
  const xhsPath = join(beer.vault, ARTICLE, '小红书.md')
  const userVersion = (await readFile(zhihuPath, 'utf8')) + '\n我自己补的一段。\n'
  await writeFile(zhihuPath, userVersion)

  let list = (await beer.api('GET', listPath)).body.versions
  assert.deepEqual(list.map(v => [v.platform, v.stale, v.userEdited, v.action]), [
    ['知乎', false, true, 'ok'],
    ['小红书', false, false, 'ok'],
  ])

  // 主稿还没改时，generate 也不能覆盖用户改过的知乎版；而且不白调模型。
  const callsBefore = model.calls()
  let res = await beer.api('POST', '/articles/versions/generate', { path: INDEX })
  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'version_user_edited')
  assert.equal(res.body.platform, '知乎')
  assert.deepEqual(res.body.mainDraftChanges, { added: [], removed: [] })
  assert.equal(model.calls(), callsBefore)
  assert.equal(await readFile(zhihuPath, 'utf8'), userVersion)

  // 再改主稿：知乎版 stale + userEdited → prompt_only；小红书版可重新生成。
  const xhsBefore = await readFile(xhsPath, 'utf8')
  const updated = MAIN.replace('第二段正文，给出理由。', '主稿里换了这一行。')
  await writeFile(join(beer.vault, INDEX), updated)
  list = (await beer.api('GET', listPath)).body.versions
  assert.deepEqual(list.map(v => [v.platform, v.stale, v.userEdited, v.action]), [
    ['知乎', true, true, 'prompt_only'],
    ['小红书', true, false, 'regenerate'],
  ])

  res = await beer.api('POST', '/articles/versions/regenerate', { path: INDEX, platform: '知乎' })
  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'version_user_edited')
  assert.equal(res.body.platform, '知乎')
  assert.deepEqual(res.body.mainDraftChanges, {
    added: ['主稿里换了这一行。'],
    removed: ['第二段正文，给出理由。'],
  })
  assert.equal(model.calls(), callsBefore)
  assert.equal(await readFile(zhihuPath, 'utf8'), userVersion, '用户改过的版本不能覆盖')
  assert.equal(await readFile(xhsPath, 'utf8'), xhsBefore, '失败时其他平台版本也不动')
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), updated)
})

test('重新生成：未改过的平台版本被覆盖、元数据更新、主稿不变；主稿快照存在 Beer 数据目录', async t => {
  let clock = new Date('2026-11-06T10:00:00Z')
  const model = await startFakeModel(t, (platform, call) => `${platform}第${call}版\n\n第${call}次生成的内容。`)
  const beer = await startBeer(t, {
    vault: { [INDEX]: MAIN },
    config: { opencodeGoBase: model.url },
    secrets: { 'opencode-go-api-key': 'go-key' },
    now: () => clock,
  })
  const listPath = '/articles/versions?path=' + encodeURIComponent(INDEX)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX })

  // 生成时把主稿快照写进 Beer 数据目录，不写进内容库。
  const dataFiles = (await listFiles(beer.dataDir)).map(p => p.replaceAll('\\', '/'))
  const snapshots = dataFiles.filter(p => p.startsWith('versions/'))
  assert.equal(snapshots.length, 2)
  const snapshot = JSON.parse(await readFile(join(beer.dataDir, snapshots.find(p => p.endsWith('-zhihu.json'))), 'utf8'))
  assert.equal(snapshot.platform, '知乎')
  assert.equal(snapshot.mainDraft, MAIN)
  assert.deepEqual(await vaultFiles(beer), [INDEX, ARTICLE + '/小红书.md', ARTICLE + '/知乎.md'])

  const updated = MAIN.replace('第三段正文，做总结。', '第三段换成新的结论。')
  await writeFile(join(beer.vault, INDEX), updated)
  clock = new Date('2026-11-06T11:00:00Z')

  const res = await beer.api('POST', '/articles/versions/regenerate', { path: INDEX, platform: '知乎' })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.versions.map(v => [v.platform, v.stale, v.userEdited, v.action]), [
    ['知乎', false, false, 'ok'],
  ])
  assert.equal(model.calls(), 3)

  const zhihu = await readFile(join(beer.vault, ARTICLE, '知乎.md'), 'utf8')
  const { meta, body } = parsePlatformFile(zhihu)
  assert.equal(meta['平台'], '知乎')
  assert.equal(meta['主稿版本'], versionOf(updated))
  assert.equal(meta['生成时间'], '2026-11-06T11:00:00.000Z')
  assert.equal(body, '知乎第3版\n\n第3次生成的内容。\n')
  assert.equal(meta['生成内容版本'], versionOf(body))

  const list = (await beer.api('GET', listPath)).body.versions
  assert.deepEqual(list.map(v => [v.platform, v.stale, v.action]), [
    ['知乎', false, 'ok'],
    ['小红书', true, 'regenerate'],
  ])

  // 主稿除了用户自己的改动外，一个字节都没被碰。
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), updated)
})

test('重新生成：平台名不认识回 400，没生成过的平台回 404', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX, platforms: ['知乎'] })

  const bad = await beer.api('POST', '/articles/versions/regenerate', { path: INDEX, platform: '微博' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'platform_invalid')

  const missing = await beer.api('POST', '/articles/versions/regenerate', { path: INDEX, platform: '小红书' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'version_missing')
  assert.equal(model.calls(), 1)
})

test('主稿快照缺失：改过的版本仍不覆盖，mainDraftChanges 是空数组', async t => {
  const model = await startFakeModel(t)
  const beer = await newBeer(t, model)
  await beer.api('POST', '/articles/versions/generate', { path: INDEX })

  const zhihuPath = join(beer.vault, ARTICLE, '知乎.md')
  const userVersion = (await readFile(zhihuPath, 'utf8')) + '\n用户又改了一句。\n'
  await writeFile(zhihuPath, userVersion)
  for (const file of (await listFiles(beer.dataDir)).map(p => p.replaceAll('\\', '/')).filter(p => p.startsWith('versions/'))) {
    await rm(join(beer.dataDir, file), { force: true })
  }
  await writeFile(join(beer.vault, INDEX), MAIN.replace('第一段正文，讲一个观点。', '主稿第一段改了。'))

  const res = await beer.api('POST', '/articles/versions/regenerate', { path: INDEX, platform: '知乎' })

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'version_user_edited')
  assert.deepEqual(res.body.mainDraftChanges, { added: [], removed: [] })
  assert.equal(await readFile(zhihuPath, 'utf8'), userVersion)
})
