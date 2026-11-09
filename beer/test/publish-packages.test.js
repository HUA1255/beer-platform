import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, listFiles } from './helpers/beer.js'

const ARTICLES = '内容库/文章'
const ARTICLE = ARTICLES + '/2026-11-06-发布包测试'
const INDEX = ARTICLE + '/index.md'
const RECORD = ARTICLE + '/发布记录.md'
const MAIN = `---
标题: 发布包测试
状态: 已确认
日期: 2026-11-06
---

# 发布包测试

主稿正文，只用来对照。
`
const ZHIHU_BODY = `# 发布包测试

知乎版本第一段。

![封面](images/封面.png)
`
const XHS_BODY = `# 发布包测试

小红书版本，口语化一点。

![封面](images/封面.png)
`

/** 造一个平台版本文件：正文原样写在 frontmatter 后面。 */
function versionFile(platform, body) {
  return `---
平台: ${platform}
主稿版本: sha256-main
生成时间: 2026-11-05T10:00:00.000Z
生成内容版本: sha256-generated
---

${body}`
}

function articleFile(status = '已确认', body = MAIN) {
  return body.replace('状态: 已确认', `状态: ${status}`)
}

const IMAGES = {
  [ARTICLE + '/images/封面.png']: 'PNG-封面的内容',
  [ARTICLE + '/images/副图.webp']: 'WEBP-副图的内容',
  [ARTICLE + '/images/说明.txt']: '不是图片，不能进发布包',
  [ARTICLE + '/images/子文件夹/深处的.png']: '子文件夹里的图片不算',
}

/** 固定「现在」为本地时间 2026-11-06 18:30，发布记录按这个时间写。 */
const fixedNow = () => new Date(2026, 10, 6, 18, 30, 0)

/** 把服务端的 fetch 包一层：只记下它想请求哪些地址，方便断言「没有向外发请求」。 */
function fetchSpy() {
  const calls = []
  const spy = (url, init) => {
    calls.push(String(url))
    return globalThis.fetch(url, init)
  }
  return { calls, spy }
}

test('知乎发布包：文字取平台版本正文，图片复制到库外目录且内容一致，返回知乎发布页地址', async t => {
  const external = fetchSpy()
  const beer = await startBeer(t, {
    vault: {
      [INDEX]: MAIN,
      [ARTICLE + '/知乎.md']: versionFile('知乎', ZHIHU_BODY),
      [ARTICLE + '/小红书.md']: versionFile('小红书', XHS_BODY),
      ...IMAGES,
    },
    now: fixedNow,
    fetch: external.spy,
  })
  // 上一次留下的旧包：目录已存在时要清空重建，旧图不能混进来。
  const packageDir = join(beer.dataDir, 'publish-packages', '2026-11-06-发布包测试-知乎')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, '旧图.png'), '上一次的图')

  const res = await beer.api('POST', '/publish/package', { path: ARTICLE, platform: '知乎' })

  assert.equal(res.status, 200)
  assert.equal(res.body.platform, '知乎')
  // 正文去掉 frontmatter，逐字取自 知乎.md。
  assert.equal(res.body.text, ZHIHU_BODY)
  assert.equal(res.body.publishUrl, 'https://zhuanlan.zhihu.com/write')
  assert.equal(res.body.packageDir, packageDir)
  assert.ok(packageDir.startsWith(beer.dataDir), '发布包在 Beer 数据目录里')
  assert.ok(!packageDir.startsWith(beer.vault), '发布包不在内容库里')

  // 只收条目 images/ 下直接放的图片，顺序按文件夹列表；源路径是库内相对路径。
  assert.deepEqual(res.body.images.map(i => i.name).sort(), ['副图.webp', '封面.png'])
  const cover = res.body.images.find(i => i.name === '封面.png')
  assert.deepEqual(cover, {
    name: '封面.png',
    source: ARTICLE + '/images/封面.png',
    copiedTo: join(packageDir, '封面.png'),
  })
  // 复制后内容逐字节一致，旧图被清掉，非图片和子文件夹里的文件不进包。
  assert.equal(await readFile(join(packageDir, '封面.png'), 'utf8'), 'PNG-封面的内容')
  assert.equal(await readFile(join(packageDir, '副图.webp'), 'utf8'), 'WEBP-副图的内容')
  assert.deepEqual((await listFiles(packageDir)).sort(), ['副图.webp', '封面.png'].sort())
  // 库里只多了原来那些文件，没有把发布包写进库。
  assert.ok(!(await listFiles(beer.vault)).some(p => p.includes('publish-packages')))
  // 只准备文字和图片，不向任何外部平台发请求。
  assert.deepEqual(external.calls, [])
})

test('小红书发布包：已发布的文章也能重看包，没有图片时包目录为空，地址是小红书发布页', async t => {
  const published = ARTICLE + '/index.md'
  const beer = await startBeer(t, {
    vault: {
      [published]: articleFile('已发布'),
      [ARTICLE + '/小红书.md']: versionFile('小红书', XHS_BODY),
    },
    now: fixedNow,
  })

  const res = await beer.api('POST', '/publish/package', { path: ARTICLE, platform: '小红书' })

  assert.equal(res.status, 200)
  assert.equal(res.body.platform, '小红书')
  assert.equal(res.body.text, XHS_BODY)
  assert.equal(res.body.publishUrl, 'https://creator.xiaohongshu.com/publish/publish')
  assert.deepEqual(res.body.images, [])
  // 包目录照样建出来（用它可以知道放图片的位置），只是里面没有图。
  assert.deepEqual(await listFiles(res.body.packageDir), [])
})

test('发布包校验：非法平台 400，没确认 409，没有平台版本 409，这些情况都不写任何文件', async t => {
  const DRAFT = ARTICLES + '/2026-11-06-还没确认/index.md'
  const NO_VERSION = ARTICLES + '/2026-11-06-没有版本/index.md'
  const beer = await startBeer(t, {
    vault: {
      [INDEX]: MAIN,
      [ARTICLE + '/知乎.md']: versionFile('知乎', ZHIHU_BODY),
      ...IMAGES,
      [DRAFT]: articleFile('成稿'),
      [NO_VERSION]: articleFile('已确认'),
    },
    now: fixedNow,
  })
  const before = await listFiles(beer.vault)

  const cases = [
    { name: '非法平台', body: { path: ARTICLE, platform: '微博' }, status: 400, code: 'platform_invalid', message: /知乎/ },
    { name: '没带平台', body: { path: ARTICLE }, status: 400, code: 'platform_invalid', message: /知乎/ },
    { name: '成稿', body: { path: DRAFT, platform: '知乎' }, status: 409, code: 'status_invalid', message: /已确认/ },
    { name: '没有平台版本', body: { path: NO_VERSION, platform: '知乎' }, status: 409, code: 'version_missing', message: /知乎/ },
    { name: '路径不对', body: { platform: '知乎' }, status: 400, code: 'path_invalid', message: /路径/ },
  ]
  for (const c of cases) {
    const res = await beer.api('POST', '/publish/package', c.body)
    assert.equal(res.status, c.status, c.name)
    assert.equal(res.body.error.code, c.code, c.name)
    assert.match(res.body.error.message, c.message, c.name)
  }

  assert.deepEqual(await listFiles(beer.vault), before, '失败的请求不能改库里的任何文件')
  assert.ok(
    !(await listFiles(beer.dataDir)).some(p => p.startsWith('publish-packages')),
    '失败的请求不能建发布包目录',
  )
})

test('发布记录：追加一行并保留已有记录，把已确认改成已发布，主稿除状态行外逐字节不变', async t => {
  const EXISTING = '- 2026-11-01 09:00 知乎 https://zhuanlan.zhihu.com/p/old\n'
  const external = fetchSpy()
  const beer = await startBeer(t, {
    vault: { [INDEX]: MAIN, [RECORD]: EXISTING },
    now: fixedNow,
    fetch: external.spy,
  })

  const res = await beer.api('POST', '/publish/record', {
    path: INDEX,
    platform: '知乎',
    url: '  https://zhuanlan.zhihu.com/p/123  ',
  })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    path: INDEX,
    platform: '知乎',
    url: 'https://zhuanlan.zhihu.com/p/123',
    status: '已发布',
    record: RECORD,
    appended: true,
  })
  // 主稿只有 `状态:` 这一行变了，正文和其他属性逐字节不动。
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), MAIN.replace('状态: 已确认', '状态: 已发布'))
  // 已有记录原样保留，新记录按本地时间追加在末尾。
  assert.equal(
    await readFile(join(beer.vault, RECORD), 'utf8'),
    EXISTING + '- 2026-11-06 18:30 知乎 https://zhuanlan.zhihu.com/p/123\n',
  )
  // 记录流程同样不向任何平台发请求。
  assert.deepEqual(external.calls, [])
})

test('发布记录幂等：同一平台同一链接不重复追加，不同平台照常追加，已发布不再改状态', async t => {
  const beer = await startBeer(t, { vault: { [INDEX]: MAIN }, now: fixedNow })
  const url = 'https://www.xiaohongshu.com/explore/abc123'

  const first = await beer.api('POST', '/publish/record', { path: INDEX, platform: '小红书', url })
  assert.equal(first.status, 200)
  assert.equal(first.body.appended, true)
  const indexAfterFirst = await readFile(join(beer.vault, INDEX), 'utf8')
  const recordAfterFirst = await readFile(join(beer.vault, RECORD), 'utf8')

  const again = await beer.api('POST', '/publish/record', { path: INDEX, platform: '小红书', url })
  assert.equal(again.status, 200)
  assert.equal(again.body.appended, false)
  assert.equal(again.body.status, '已发布')
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), indexAfterFirst, '状态不重复改')
  assert.equal(await readFile(join(beer.vault, RECORD), 'utf8'), recordAfterFirst, '记录不重复追加')

  // 同一个链接发到另一个平台是另一条记录；Rin 博客分成两个词，也照样能记。
  const xhs = await beer.api('POST', '/publish/record', { path: INDEX, platform: 'Rin 博客', url })
  assert.equal(xhs.status, 200)
  assert.equal(xhs.body.appended, true)
  assert.equal(
    await readFile(join(beer.vault, RECORD), 'utf8'),
    recordAfterFirst + '- 2026-11-06 18:30 Rin 博客 ' + url + '\n',
  )
})

test('发布记录校验：非 http(s) 链接、非法平台、路径不对都 400，什么文件都不写', async t => {
  const beer = await startBeer(t, { vault: { [INDEX]: MAIN, ...IMAGES }, now: fixedNow })
  const before = await listFiles(beer.vault)

  const cases = [
    { name: 'ftp', body: { path: INDEX, platform: '知乎', url: 'ftp://example.com/a' }, status: 400, code: 'url_invalid', message: /http/ },
    { name: '不是链接', body: { path: INDEX, platform: '知乎', url: '随便写写' }, status: 400, code: 'url_invalid', message: /http/ },
    { name: '空链接', body: { path: INDEX, platform: '知乎' }, status: 400, code: 'url_invalid', message: /http/ },
    { name: '非法平台', body: { path: INDEX, platform: '微博', url: 'https://example.com/a' }, status: 400, code: 'platform_invalid', message: /Rin/ },
    { name: '路径不对', body: { platform: '知乎', url: 'https://example.com/a' }, status: 400, code: 'path_invalid', message: /路径/ },
  ]
  for (const c of cases) {
    const res = await beer.api('POST', '/publish/record', c.body)
    assert.equal(res.status, c.status, c.name)
    assert.equal(res.body.error.code, c.code, c.name)
    assert.match(res.body.error.message, c.message, c.name)
  }

  assert.deepEqual(await listFiles(beer.vault), before, '失败的记录不能改库里的任何文件')
  assert.equal(await readFile(join(beer.vault, INDEX), 'utf8'), MAIN, '状态没有被改')
})
