import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { startBeer, listFiles, makeTempDir } from './helpers/beer.js'

const NOTE = '内容库/文章/2026-11-01-搬家/index.md'
const q = path => '?path=' + encodeURIComponent(path)

test('打开库里的 Markdown 文件：返回原文和版本标记', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '---\n状态: 草稿\n---\n# 为什么搬到 Obsidian\n' } })

  const res = await beer.api('GET', '/library/file' + q(NOTE))

  assert.equal(res.status, 200)
  assert.equal(res.body.path, NOTE)
  assert.equal(res.body.content, '---\n状态: 草稿\n---\n# 为什么搬到 Obsidian\n')
  assert.equal(typeof res.body.version, 'string')
  assert.ok(res.body.version.length > 0)
  assert.ok(!Number.isNaN(Date.parse(res.body.modifiedAt)))
})

test('预览 → 编辑 → 保存：带着读取时的版本保存，文件被改写，版本更新', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '# 旧标题\n' } })
  const opened = (await beer.api('GET', '/library/file' + q(NOTE))).body

  const saved = await beer.api('PUT', '/library/file', { path: NOTE, content: '# 新标题\n\n正文\n', baseVersion: opened.version })

  assert.equal(saved.status, 200)
  assert.equal(saved.body.path, NOTE)
  assert.notEqual(saved.body.version, opened.version)
  assert.equal(await readFile(join(beer.vault, NOTE), 'utf8'), '# 新标题\n\n正文\n')
  const reopened = (await beer.api('GET', '/library/file' + q(NOTE))).body
  assert.equal(reopened.content, '# 新标题\n\n正文\n')
  assert.equal(reopened.version, saved.body.version)
})

test('冲突：读取后文件被别处（Obsidian）改过，保存被拒，原文件内容不变', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '# 原文\n' } })
  const opened = (await beer.api('GET', '/library/file' + q(NOTE))).body
  await writeFile(join(beer.vault, NOTE), '# 原文\n\nObsidian 里加的一段\n')

  const saved = await beer.api('PUT', '/library/file', { path: NOTE, content: '# 我在 Beer 里改的\n', baseVersion: opened.version })

  assert.equal(saved.status, 409)
  assert.equal(saved.body.error.code, 'edit_conflict')
  assert.match(saved.body.error.message, /别处/)
  assert.equal(await readFile(join(beer.vault, NOTE), 'utf8'), '# 原文\n\nObsidian 里加的一段\n')
  const current = (await beer.api('GET', '/library/file' + q(NOTE))).body
  assert.equal(saved.body.current.version, current.version)
  assert.equal(saved.body.current.modifiedAt, current.modifiedAt)
})

test('冲突：读取后文件在别处被删掉，保存被拒，不重新建出这个文件', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '# 原文\n' } })
  const opened = (await beer.api('GET', '/library/file' + q(NOTE))).body
  await rm(join(beer.vault, NOTE))

  const saved = await beer.api('PUT', '/library/file', { path: NOTE, content: '# 改过\n', baseVersion: opened.version })

  assert.equal(saved.status, 409)
  assert.equal(saved.body.error.code, 'edit_conflict')
  assert.equal(saved.body.current, null)
  assert.deepEqual(await listFiles(beer.vault), [])
})

test('保存时缺少版本标记被拒，不写文件', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '# 原文\n' } })

  for (const baseVersion of [undefined, '', 42]) {
    const saved = await beer.api('PUT', '/library/file', { path: NOTE, content: '# 改过\n', baseVersion })
    assert.equal(saved.status, 400, `应拒绝 baseVersion=${baseVersion}`)
  }
  const saved = await beer.api('PUT', '/library/file', { path: NOTE, content: 42, baseVersion: 'x' })
  assert.equal(saved.status, 400)
  assert.equal(await readFile(join(beer.vault, NOTE), 'utf8'), '# 原文\n')
})

test('只能读写库根目录之内：越界路径、绝对路径一律拒绝，库外文件不被读也不被改', async t => {
  const outside = await makeTempDir(t, 'outside-', { 'secret.md': '库外的秘密\n' })
  const beer = await startBeer(t, { vault: { [NOTE]: '# 原文\n' } })
  const outsideFile = join(outside, 'secret.md')
  const escape = relative(beer.vault, outsideFile) // ../outside-xxx/secret.md
  const bad = [escape, outsideFile, '内容库/../../x.md', '', '内容库/\0.md']

  for (const path of bad) {
    const read = await beer.api('GET', '/library/file' + q(path))
    assert.equal(read.status, 400, `读 ${JSON.stringify(path)} 应被拒`)
    assert.equal(read.body.error.code, 'path_invalid')
    const saved = await beer.api('PUT', '/library/file', { path, content: '覆盖\n', baseVersion: 'x' })
    assert.equal(saved.status, 400, `写 ${JSON.stringify(path)} 应被拒`)
  }
  const missingPath = await beer.api('GET', '/library/file')
  assert.equal(missingPath.status, 400)
  assert.equal(await readFile(outsideFile, 'utf8'), '库外的秘密\n')
})

test('只能读写库根目录之内：库里指向库外的符号链接也不能借道', async t => {
  const outside = await makeTempDir(t, 'outside-', { 'secret.md': '库外的秘密\n' })
  const beer = await startBeer(t, { vault: { [NOTE]: '# 原文\n' } })
  try {
    await symlink(outside, join(beer.vault, '外链文件夹'))
    await symlink(join(outside, 'secret.md'), join(beer.vault, '外链.md'))
  } catch (err) {
    // Windows 默认不允许建符号链接（要开发者模式或管理员），这种环境跳过。
    if (err.code === 'EPERM' || err.code === 'EACCES') return t.skip('当前环境不能创建符号链接')
    throw err
  }

  for (const path of ['外链文件夹/secret.md', '外链.md']) {
    const read = await beer.api('GET', '/library/file' + q(path))
    assert.equal(read.status, 403, `读 ${path} 应被拒`)
    assert.equal(read.body.error.code, 'outside_vault')
    const saved = await beer.api('PUT', '/library/file', { path, content: '覆盖\n', baseVersion: 'x' })
    assert.equal(saved.status, 403, `写 ${path} 应被拒`)
  }
  assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), '库外的秘密\n')
})

test('只读写 Markdown：其他类型的文件、文件夹被拒', async t => {
  const beer = await startBeer(t, { vault: { '内容库/素材/a/录音.srt': '1\n', '内容库/素材/a/index.md': '# a\n' } })

  const srt = await beer.api('GET', '/library/file' + q('内容库/素材/a/录音.srt'))
  assert.equal(srt.status, 415)
  assert.equal(srt.body.error.code, 'not_markdown')
  const dir = await beer.api('GET', '/library/file' + q('内容库/素材/a'))
  assert.equal(dir.status, 415)
  const missing = await beer.api('GET', '/library/file' + q('内容库/素材/a/没有.md'))
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not_found')
})

test('列出文件夹：子文件夹在前、文件在后，各按名称排，不列隐藏文件', async t => {
  const beer = await startBeer(t, {
    vault: {
      '内容库/文章/2026-11-02-b/index.md': '# b\n',
      '内容库/文章/2026-11-01-a/index.md': '# a\n',
      '内容库/文章/说明.md': '说明\n',
      '内容库/文章/封面.png': 'png',
      '内容库/文章/.DS_Store': 'x',
      '内容库/文章/.obsidian/app.json': '{}',
    },
  })

  const res = await beer.api('GET', '/library/folder' + q('内容库/文章'))

  assert.equal(res.status, 200)
  assert.equal(res.body.path, '内容库/文章')
  assert.deepEqual(res.body.entries.map(e => [e.name, e.path, e.kind]), [
    ['2026-11-01-a', '内容库/文章/2026-11-01-a', 'folder'],
    ['2026-11-02-b', '内容库/文章/2026-11-02-b', 'folder'],
    ['封面.png', '内容库/文章/封面.png', 'file'],
    ['说明.md', '内容库/文章/说明.md', 'file'],
  ])
  const note = res.body.entries.find(e => e.name === '说明.md')
  assert.equal(note.size, Buffer.byteLength('说明\n'))
  assert.ok(!Number.isNaN(Date.parse(note.modifiedAt)))
})

test('列出文件夹：库根目录用空路径；分页绑定的文件夹还不存在时返回空列表，不建目录', async t => {
  const beer = await startBeer(t, { vault: { '笔记.md': '# hi\n' } })

  const root = await beer.api('GET', '/library/folder' + q(''))
  assert.equal(root.status, 200)
  assert.deepEqual(root.body.entries.map(e => e.name), ['笔记.md'])

  const missing = await beer.api('GET', '/library/folder' + q('内容库/规则'))
  assert.equal(missing.status, 200)
  assert.deepEqual(missing.body, { path: '内容库/规则', exists: false, entries: [] })
  assert.deepEqual(await listFiles(beer.vault), ['笔记.md'])

  const outside = await beer.api('GET', '/library/folder' + q('..'))
  assert.equal(outside.status, 400)
})

test('还没选库时读写都提示先选库', async t => {
  const beer = await startBeer(t, { vault: false })

  const read = await beer.api('GET', '/library/file' + q(NOTE))
  assert.equal(read.status, 409)
  assert.equal(read.body.error.code, 'vault_unset')
})
