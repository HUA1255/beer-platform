import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, deadUrl, listFiles } from './helpers/beer.js'

const ARTICLES = '内容库/文章'
const ARTICLE = ARTICLES + '/2026-11-06-发布测试'
const INDEX = ARTICLE + '/index.md'
const RECORD = ARTICLE + '/发布记录.md'
const MAIN = `---
标题: 发布测试
状态: 成稿
日期: 2026-11-06
摘要: 一句话摘要
---

# 发布测试

第一段正文。

![封面](images/封面.png)

再看 ./images/副图.png。
`
const IMAGES = {
  [ARTICLE + '/images/封面.png']: 'PNG-封面',
  [ARTICLE + '/images/副图.png']: 'PNG-副图',
}

/** library 的版本格式：sha256-<十六进制>。 */
function versionOf(text) {
  return 'sha256-' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** 造一个平台版本文件：正文原样写在 frontmatter 后面。 */
function versionFile(platform, body, generatedBody = body) {
  return `---
平台: ${platform}
主稿版本: sha256-main
生成时间: 2026-11-05T10:00:00.000Z
生成内容版本: ${versionOf(generatedBody)}
---

${body}`
}

/** 造一篇文章（默认成稿，正文是主稿正文）。 */
function articleFile(title, status, body = `# ${title}\n\n第一行\n第二行\n`) {
  return `---
标题: ${title}
状态: ${status}
日期: 2026-11-05
---

${body}`
}

/** 固定「现在」为本地时间 2026-11-06 18:30，发布记录按这个时间写。 */
const fixedNow = () => new Date(2026, 10, 6, 18, 30, 0)

const vaultFiles = async beer => (await listFiles(beer.vault)).map(p => p.replaceAll('\\', '/'))

/** 钥匙串里的 Rin 账号密码（假的）。 */
const RIN_CREDENTIALS = { 'rin-admin-username': 'admin', 'rin-admin-password': 'pw' }

/** 造一个只带 exp 的 JWT（签名是假的，Beer 不校验签名）。 */
function fakeJwt(expiresAt, id = 'x') {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ id, exp: Math.floor(expiresAt.getTime() / 1000) })}.sig`
}

/**
 * 假 Rin 博客：默认 /api/auth/login 回令牌 rin-token，/api/feed 回 insertedId，
 * /api/storage 按 multipart 里的 key 回一个 url。
 * login / feed / storage 可以换成自定义处理函数，用来模拟 401、429、500、坏回包。
 */
async function startFakeRin(t, { login, feed, storage } = {}) {
  return startFake(t, {
    'POST /api/auth/login': login ?? (() => ({ success: true, token: 'rin-token' })),
    'POST /api/feed': feed ?? (() => ({ insertedId: 'feed-123' })),
    'POST /api/storage': storage ?? ((_req, raw) => {
      const key = /name="key"\r?\n\r?\n([^\r\n]*)/.exec(raw)?.[1] ?? 'unknown'
      return { url: `https://rin.test/r2/${key}` }
    }),
  })
}

const newBeer = (t, rin, more = {}) => startBeer(t, {
  vault: { [INDEX]: MAIN, ...IMAGES },
  config: { rinApiBase: rin.url },
  secrets: RIN_CREDENTIALS,
  now: fixedNow,
  ...more,
})

const feedRequests = rin => rin.requests.filter(r => r.method === 'POST' && r.path === '/api/feed')
const storageRequests = rin => rin.requests.filter(r => r.method === 'POST' && r.path === '/api/storage')
const loginRequests = rin => rin.requests.filter(r => r.method === 'POST' && r.path === '/api/auth/login')

test('发布列表：只列成稿和已确认，主稿与平台版本逐行对照，标出用户改过的地方', async t => {
  const body = '# 成稿文章\n\n第一行\n第二行\n'
  const zhihuBody = '# 成稿文章\n\n第一行\n第二行（知乎改）\n'
  const xhsGenerated = '# 成稿文章\n\n第一行\n第二行\n'
  const xhsBody = xhsGenerated + '\n用户自己补的一句。\n'
  const DRAFT = ARTICLES + '/2026-11-05-草稿/index.md'
  const CONFIRMED = ARTICLES + '/2026-11-05-已确认/index.md'
  const PUBLISHED = ARTICLES + '/2026-11-05-已发布/index.md'
  const beer = await startBeer(t, {
    vault: {
      [DRAFT]: articleFile('草稿', '草稿'),
      [CONFIRMED]: articleFile('已确认', '已确认'),
      [PUBLISHED]: articleFile('已发布', '已发布'),
      [ARTICLES + '/2026-11-05-成稿/index.md']: articleFile('成稿文章', '成稿', body),
      [ARTICLES + '/2026-11-05-成稿/知乎.md']: versionFile('知乎', zhihuBody),
      [ARTICLES + '/2026-11-05-成稿/小红书.md']: versionFile('小红书', xhsBody, xhsGenerated),
    },
  })

  const res = await beer.api('GET', '/publish')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.articles.map(a => [a.path, a.title, a.status]).sort(), [
    [CONFIRMED, '已确认', '已确认'],
    [ARTICLES + '/2026-11-05-成稿/index.md', '成稿文章', '成稿'],
  ])
  const draft = res.body.articles.find(a => a.status === '成稿')
  assert.equal(draft.main, body)
  assert.deepEqual(draft.versions.map(v => [v.platform, v.userEdited]), [
    ['知乎', false],
    ['小红书', true],
  ])
  assert.equal(draft.versions[0].content, zhihuBody)
  assert.deepEqual(draft.versions[0].diff, [
    { type: 'same', text: '# 成稿文章' },
    { type: 'same', text: '' },
    { type: 'same', text: '第一行' },
    { type: 'removed', text: '第二行' },
    { type: 'added', text: '第二行（知乎改）' },
  ])
  assert.deepEqual(draft.versions[1].diff.slice(-2), [
    { type: 'added', text: '' },
    { type: 'added', text: '用户自己补的一句。' },
  ])
  assert.deepEqual(res.body.articles.find(a => a.status === '已确认').versions, [])

  // 已发布默认不列；includePublished=1 时补上并排在最后，给补记录、重看发布包用。
  const all = await beer.api('GET', '/publish?includePublished=1')
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.articles.map(a => [a.path, a.status]), [
    [ARTICLES + '/2026-11-05-成稿/index.md', '成稿'],
    [CONFIRMED, '已确认'],
    [PUBLISHED, '已发布'],
  ])
})

test('确认发布：成稿 → 已确认 → 已发布，先传图片再替换正文里的地址，写发布记录，主稿只改状态行', async t => {
  const rin = await startFakeRin(t)
  const beer = await newBeer(t, rin)

  const res = await beer.api('POST', '/publish/confirm', { path: INDEX })

  assert.equal(res.status, 200)
  assert.equal(res.body.path, INDEX)
  assert.equal(res.body.status, '已发布')
  assert.equal(res.body.feedId, 'feed-123')
  assert.equal(res.body.link, null)
  assert.deepEqual(res.body.images.map(i => [i.name, i.url]).sort(), [
    ['副图.png', 'https://rin.test/r2/副图.png'],
    ['封面.png', 'https://rin.test/r2/封面.png'],
  ].sort())

  // 主稿除状态行外逐字节不变。
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), MAIN.replace('状态: 成稿', '状态: 已发布'))
  // 发布记录一行，时间是本地时间。
  assert.equal(await readFile(join(beer.vault, RECORD), 'utf8'), '- 2026-11-06 18:30 Rin 博客 feed-123\n')

  // 图片逐张上传：multipart 的 file / key 字段，带管理员令牌；上传发生在提交 feed 之前。
  const uploads = storageRequests(rin)
  assert.equal(uploads.length, 2)
  const raws = uploads.map(r => r.raw.toString('utf8'))
  assert.ok(raws.some(r => r.includes('name="file"; filename="封面.png"') && r.includes('PNG-封面')))
  assert.ok(raws.some(r => r.includes('name="file"; filename="副图.png"') && r.includes('PNG-副图')))
  for (const upload of uploads) {
    assert.equal(upload.headers.authorization, 'Bearer rin-token')
    assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.match(upload.raw.toString('utf8'), /name="key"\r\n\r\n[^\r\n]+\.png\r\n/)
  }
  const order = rin.requests.map(r => r.path)
  assert.ok(order.lastIndexOf('/api/storage') < order.indexOf('/api/feed'), '图片上传要排在 feed 之前')

  // feed 请求：头、必填字段、正文里的图片地址都已替换。
  const feeds = feedRequests(rin)
  assert.equal(feeds.length, 1)
  assert.equal(feeds[0].headers.authorization, 'Bearer rin-token')
  assert.match(feeds[0].headers['content-type'], /application\/json/)
  assert.deepEqual(feeds[0].body, {
    title: '发布测试',
    content: [
      '# 发布测试',
      '',
      '第一段正文。',
      '',
      '![封面](https://rin.test/r2/封面.png)',
      '',
      '再看 https://rin.test/r2/副图.png。',
      '',
    ].join('\n'),
    summary: '一句话摘要',
    draft: false,
    listed: true,
    tags: [],
  })
})

test('发布失败：Rin 一直 401、连不上、坏回包、上传失败、没有账号密码、登录失败都报明确错误，状态停在已确认，不写发布记录', async t => {
  const confirmedMain = MAIN.replace('状态: 成稿', '状态: 已确认')
  const cases = []
  const anywhere = await startFake(t, {})

  const denied = await startFakeRin(t, { feed: () => ({ status: 401, body: { error: 'bad token' } }) })
  cases.push({ name: '401', beer: await newBeer(t, denied), status: 502, code: 'rin_unauthorized', message: /令牌/ })

  const badFeed = await startFakeRin(t, { feed: () => ({}) })
  cases.push({ name: '坏回包', beer: await newBeer(t, badFeed), status: 502, code: 'rin_bad_response', message: /编号/ })

  const badStorage = await startFakeRin(t, { storage: () => ({ status: 500, body: {} }) })
  cases.push({ name: '上传失败', beer: await newBeer(t, badStorage), status: 502, code: 'rin_upstream_error', message: /上传|返回 500/ })

  const noIdStorage = await startFakeRin(t, { storage: () => ({}) })
  cases.push({ name: '上传坏回包', beer: await newBeer(t, noIdStorage), status: 502, code: 'rin_bad_response', message: /地址/ })

  const dead = await startBeer(t, {
    vault: { [INDEX]: MAIN, ...IMAGES },
    config: { rinApiBase: await deadUrl(t) },
    secrets: RIN_CREDENTIALS,
    now: fixedNow,
  })
  cases.push({ name: '连不上', beer: dead, status: 502, code: 'rin_unreachable', message: /连不上/ })

  const noCredentials = await startBeer(t, {
    vault: { [INDEX]: MAIN, ...IMAGES },
    config: { rinApiBase: anywhere.url },
    secrets: { 'rin-admin-username': 'admin' },
    now: fixedNow,
  })
  cases.push({ name: '没有账号密码', beer: noCredentials, status: 503, code: 'rin_no_credentials', message: /账号密码/ })

  const wrongPassword = await startFakeRin(t, { login: () => ({ status: 403, body: { message: 'Invalid credentials' } }) })
  cases.push({ name: '账号密码不对', beer: await newBeer(t, wrongPassword), status: 502, code: 'rin_login_failed', message: /账号密码/ })

  const tooMany = await startFakeRin(t, { login: () => ({ status: 429, body: {} }) })
  cases.push({ name: '登录太频繁', beer: await newBeer(t, tooMany), status: 502, code: 'rin_login_rate_limited', message: /频繁/ })

  for (const c of cases) {
    const res = await c.beer.api('POST', '/publish/confirm', { path: INDEX })
    assert.equal(res.status, c.status, c.name)
    assert.equal(res.body.error.code, c.code, c.name)
    assert.match(res.body.error.message, c.message, c.name)
    // 失败时状态停在「已确认」，正文逐字不变，也没有发布记录。
    assert.equal(await readFile(join(c.beer.vault, INDEX), 'utf8'), confirmedMain, c.name)
    assert.ok(!(await vaultFiles(c.beer)).includes(RECORD), `${c.name} 时不能写发布记录`)
    const list = await c.beer.api('GET', '/publish')
    assert.deepEqual(list.body.articles.map(a => [a.path, a.status]), [[INDEX, '已确认']], c.name)
  }
  // 一直 401：重新登录一次、重发一次就停，不无限重试。
  assert.equal(loginRequests(denied).length, 2)
  assert.equal(feedRequests(denied).length, 2)
  assert.equal(feedRequests(badFeed).length, 1)
  // 登录没成功时一张图片都不上传。
  for (const rin of [wrongPassword, tooMany]) {
    assert.equal(storageRequests(rin).length, 0)
    assert.equal(feedRequests(rin).length, 0)
  }
  assert.equal(loginRequests(tooMany).length, 1, '登录被限流时不能马上再试')
  assert.equal(feedRequests(badStorage).length, 0)
  assert.equal(feedRequests(noIdStorage).length, 0)
})

test('重试发布：已确认的只重跑发布，成功后改已发布并写记录；不是已确认的不能重试', async t => {
  let calls = 0
  const rin = await startFakeRin(t, {
    feed: () => (++calls === 1 ? { status: 500, body: {} } : { insertedId: 'feed-retry' }),
  })
  const DRAFT = ARTICLES + '/2026-11-06-还没成稿/index.md'
  const beer = await newBeer(t, rin, {
    vault: { [INDEX]: MAIN, ...IMAGES, [DRAFT]: articleFile('还没成稿', '草稿') },
  })

  const first = await beer.api('POST', '/publish/confirm', { path: INDEX })
  assert.equal(first.status, 502)
  assert.equal(first.body.error.code, 'rin_upstream_error')
  assert.equal(await readFile(join(beer.vault, RECORD), 'utf8').catch(() => ''), '')

  const retry = await beer.api('POST', '/publish/retry', { path: INDEX })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.status, '已发布')
  assert.equal(retry.body.feedId, 'feed-retry')
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), MAIN.replace('状态: 成稿', '状态: 已发布'))
  assert.equal(await readFile(join(beer.vault, RECORD), 'utf8'), '- 2026-11-06 18:30 Rin 博客 feed-retry\n')
  assert.equal(feedRequests(rin).length, 2)

  // 已发布、没确认过的都不能走 retry，也不再发请求。
  const published = await beer.api('POST', '/publish/retry', { path: INDEX })
  assert.equal(published.status, 409)
  assert.equal(published.body.error.code, 'status_invalid')
  const draft = await beer.api('POST', '/publish/retry', { path: DRAFT })
  assert.equal(draft.status, 409)
  assert.equal(draft.body.error.code, 'status_invalid')
  assert.equal(feedRequests(rin).length, 2)
})

test('重复确认：已发布的文章不再发布，不写第二条记录；草稿不能确认', async t => {
  const rin = await startFakeRin(t)
  const DRAFT = ARTICLES + '/2026-11-06-草稿/index.md'
  const beer = await newBeer(t, rin, { vault: { [INDEX]: MAIN, ...IMAGES, [DRAFT]: articleFile('草稿', '草稿') } })

  assert.equal((await beer.api('POST', '/publish/confirm', { path: INDEX })).status, 200)
  const record = await readFile(join(beer.vault, RECORD), 'utf8')

  const again = await beer.api('POST', '/publish/confirm', { path: INDEX })
  assert.equal(again.status, 409)
  assert.equal(again.body.error.code, 'status_invalid')
  assert.equal(feedRequests(rin).length, 1, '重复 confirm 不能重复发布')
  assert.equal(await readFile(join(beer.vault, RECORD), 'utf8'), record)

  const draft = await beer.api('POST', '/publish/confirm', { path: DRAFT })
  assert.equal(draft.status, 409)
  assert.equal(draft.body.error.code, 'status_invalid')
  assert.equal(await readFile(join(beer.vault, DRAFT), 'utf8'), articleFile('草稿', '草稿'))
  assert.equal(feedRequests(rin).length, 1)
})

test('发布记录追加和可选摘要：已有记录原样保留，没有摘要就不发 summary；路径不对回 400', async t => {
  const NO_SUMMARY = ARTICLES + '/2026-11-06-无摘要/index.md'
  const NO_SUMMARY_MAIN = `---
标题: 无摘要
状态: 成稿
日期: 2026-11-06
---

# 无摘要

正文一段。
`
  const EXISTING = '- 2026-11-01 09:00 知乎 https://zhihu.com/p/1\n'
  const rin = await startFakeRin(t)
  const beer = await startBeer(t, {
    vault: {
      [INDEX]: MAIN,
      ...IMAGES,
      [NO_SUMMARY]: NO_SUMMARY_MAIN,
      [ARTICLE + '/' + '发布记录.md']: EXISTING,
    },
    config: { rinApiBase: rin.url },
    secrets: RIN_CREDENTIALS,
    now: fixedNow,
  })

  const bad = await beer.api('POST', '/publish/confirm', {})
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'path_invalid')

  const first = await beer.api('POST', '/publish/confirm', { path: INDEX })
  assert.equal(first.status, 200)
  assert.equal(
    await readFile(join(beer.vault, RECORD), 'utf8'),
    EXISTING + '- 2026-11-06 18:30 Rin 博客 feed-123\n',
  )

  const second = await beer.api('POST', '/publish/confirm', { path: NO_SUMMARY })
  assert.equal(second.status, 200)
  const feeds = feedRequests(rin)
  assert.equal(feeds.length, 2)
  assert.equal(feeds[1].body.title, '无摘要')
  assert.ok(!('summary' in feeds[1].body), '没有摘要时不发 summary')
  assert.deepEqual(feeds[1].body.tags, [])
})

/** 把服务端的 fetch 包一层：只记下它想请求哪些地址，方便断言「只请求了假 Rin」。 */
function fetchSpy() {
  const calls = []
  const spy = (url, init) => {
    calls.push(String(url))
    return globalThis.fetch(url, init)
  }
  return { calls, spy }
}

const ZHIHU_BODY = '# 发布测试\n\n这是知乎版本。\n'
const XHS_BODY = '# 发布测试\n\n这是小红书版本。\n'

test('确认发布：Rin 成功后顺手准备知乎 / 小红书发布包，包里文字和图片正确，不向平台发任何请求', async t => {
  const external = fetchSpy()
  const rin = await startFakeRin(t)
  const beer = await newBeer(t, rin, {
    vault: {
      [INDEX]: MAIN,
      ...IMAGES,
      [ARTICLE + '/知乎.md']: versionFile('知乎', ZHIHU_BODY),
      [ARTICLE + '/小红书.md']: versionFile('小红书', XHS_BODY),
    },
    fetch: external.spy,
  })

  const res = await beer.api('POST', '/publish/confirm', { path: INDEX })

  assert.equal(res.status, 200)
  assert.equal(res.body.status, '已发布')
  assert.deepEqual(res.body.packages.map(p => p.platform).sort(), ['小红书', '知乎'].sort())
  const byPlatform = Object.fromEntries(res.body.packages.map(p => [p.platform, p]))
  assert.equal(byPlatform['知乎'].text, ZHIHU_BODY)
  assert.equal(byPlatform['小红书'].text, XHS_BODY)
  assert.equal(byPlatform['知乎'].publishUrl, 'https://zhuanlan.zhihu.com/write')
  assert.equal(byPlatform['小红书'].publishUrl, 'https://creator.xiaohongshu.com/publish/publish')

  // 每个包在 Beer 数据目录里，图片复制后内容和库里一致。
  for (const platform of ['知乎', '小红书']) {
    const pkg = byPlatform[platform]
    const expectedDir = join(beer.dataDir, 'publish-packages', `2026-11-06-发布测试-${platform}`)
    assert.equal(pkg.packageDir, expectedDir)
    assert.deepEqual(pkg.images.map(i => i.name).sort(), ['副图.png', '封面.png'].sort())
    assert.equal(await readFile(join(expectedDir, '封面.png'), 'utf8'), 'PNG-封面')
    assert.equal(await readFile(join(expectedDir, '副图.png'), 'utf8'), 'PNG-副图')
  }

  // 除了假 Rin，一个外部请求都没发：没有登录、没有向知乎 / 小红书提交。
  assert.ok(external.calls.length > 0)
  assert.ok(
    external.calls.every(url => url.startsWith(rin.url)),
    '只应请求假 Rin 博客：' + external.calls.join(', '),
  )
})

test('确认发布：没有平台版本文件的那个平台跳过，不建空的发布包目录', async t => {
  const rin = await startFakeRin(t)
  const beer = await newBeer(t, rin, {
    vault: {
      [INDEX]: MAIN,
      ...IMAGES,
      [ARTICLE + '/知乎.md']: versionFile('知乎', ZHIHU_BODY),
    },
  })

  const res = await beer.api('POST', '/publish/confirm', { path: INDEX })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.packages.map(p => p.platform), ['知乎'])
  assert.equal(res.body.packages[0].text, ZHIHU_BODY)
  const created = (await listFiles(join(beer.dataDir, 'publish-packages'))).map(p => p.replaceAll('\\', '/'))
  assert.deepEqual(created.sort(), [
    '2026-11-06-发布测试-知乎/副图.png',
    '2026-11-06-发布测试-知乎/封面.png',
  ])
})

test('自动登录：用钥匙串里的账号密码换令牌，令牌在内存里复用，不每次都登录', async t => {
  const SECOND = ARTICLES + '/2026-11-06-第二篇/index.md'
  const rin = await startFakeRin(t)
  const beer = await newBeer(t, rin, { vault: { [INDEX]: MAIN, ...IMAGES, [SECOND]: articleFile('第二篇', '成稿') } })

  assert.equal((await beer.api('POST', '/publish/confirm', { path: INDEX })).status, 200)
  assert.equal((await beer.api('POST', '/publish/confirm', { path: SECOND })).status, 200)

  const logins = loginRequests(rin)
  assert.equal(logins.length, 1, '令牌没过期时第二次发布不再登录')
  assert.deepEqual(logins[0].body, { username: 'admin', password: 'pw' })
  assert.match(logins[0].headers['content-type'], /application\/json/)
  assert.equal(logins[0].headers.authorization, undefined)
  for (const r of [...feedRequests(rin), ...storageRequests(rin)]) assert.equal(r.headers.authorization, 'Bearer rin-token')
})

test('令牌快过期时提前重新登录', async t => {
  const SECOND = ARTICLES + '/2026-11-06-第二篇/index.md'
  let clock = fixedNow()
  let issued = 0
  const rin = await startFakeRin(t, {
    // Rin 签 24 小时的令牌；每次登录给一个新的。
    login: () => ({ success: true, token: fakeJwt(new Date(clock.getTime() + 24 * 3600_000), `t${++issued}`) }),
  })
  const beer = await newBeer(t, rin, {
    vault: { [INDEX]: MAIN, ...IMAGES, [SECOND]: articleFile('第二篇', '成稿') },
    now: () => clock,
  })

  assert.equal((await beer.api('POST', '/publish/confirm', { path: INDEX })).status, 200)
  assert.equal(loginRequests(rin).length, 1)
  // 23 小时 56 分后：离过期不到 5 分钟，先重新登录再发布。
  clock = new Date(clock.getTime() + (23 * 60 + 56) * 60_000)
  assert.equal((await beer.api('POST', '/publish/confirm', { path: SECOND })).status, 200)

  assert.equal(loginRequests(rin).length, 2)
  const [first, second] = feedRequests(rin)
  assert.notEqual(second.headers.authorization, first.headers.authorization)
})

test('令牌被拒时重新登录一次，用新令牌重发同一个请求，发布成功只建一篇文章', async t => {
  const tokens = ['old-token', 'new-token']
  const rin = await startFakeRin(t, {
    login: () => ({ success: true, token: tokens.shift() }),
    feed: req => (req.headers.authorization === 'Bearer old-token'
      ? { status: 401, body: { error: 'expired' } }
      : { insertedId: 'feed-relogin' }),
  })
  const beer = await newBeer(t, rin)

  const res = await beer.api('POST', '/publish/confirm', { path: INDEX })

  assert.equal(res.status, 200)
  assert.equal(res.body.status, '已发布')
  assert.equal(res.body.feedId, 'feed-relogin')
  assert.equal(loginRequests(rin).length, 2)
  assert.deepEqual(feedRequests(rin).map(r => r.headers.authorization), ['Bearer old-token', 'Bearer new-token'])
  assert.equal(storageRequests(rin).length, 2, '图片已经传好，重新登录后不再重传')
  assert.equal(await readFile(join(beer.vault, RECORD), 'utf8'), '- 2026-11-06 18:30 Rin 博客 feed-relogin\n')
})

test('设置弹层改了 Rin 密码：丢掉内存里的令牌，下一次发布用新密码重新登录', async t => {
  const SECOND = ARTICLES + '/2026-11-06-第二篇/index.md'
  const rin = await startFakeRin(t)
  const beer = await newBeer(t, rin, {
    vault: { [INDEX]: MAIN, ...IMAGES, [SECOND]: articleFile('第二篇', '成稿') },
    secrets: { ...RIN_CREDENTIALS },
  })

  assert.equal((await beer.api('POST', '/publish/confirm', { path: INDEX })).status, 200)
  assert.equal((await beer.api('PUT', '/settings/secrets/rin-admin-password', { value: 'pw-new' })).status, 200)
  assert.equal((await beer.api('POST', '/publish/confirm', { path: SECOND })).status, 200)

  assert.deepEqual(loginRequests(rin).map(r => r.body), [
    { username: 'admin', password: 'pw' },
    { username: 'admin', password: 'pw-new' },
  ])
})
