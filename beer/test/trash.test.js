import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { startBeer, listFiles, makeTempDir } from './helpers/beer.js'

const ARTICLE = '内容库/文章/2026-11-01-搬家'
const NOTE = ARTICLE + '/index.md'
const FILE = '内容库/文章/散件.md'
const MANIFEST = '.trash/.beer-trash.json'

/** 库里的文件列表，分隔符统一成 /（Windows 上是 \）。 */
const vaultFiles = async beer => (await listFiles(beer.vault)).map(p => p.replaceAll('\\', '/'))

const fixedNow = () => new Date('2026-11-06T10:30:00+08:00')

test('删除文件：移到 .trash 并保留原路径，原位置不再有它，回收站能列出原路径', async t => {
  const beer = await startBeer(t, { vault: { [FILE]: '# 正文\n' }, now: fixedNow })

  const res = await beer.api('POST', '/library/trash', { path: FILE })

  assert.equal(res.status, 200)
  assert.equal(res.body.path, FILE)
  assert.equal(res.body.originalPath, FILE)
  assert.equal(res.body.trashedTo, '.trash/' + FILE)
  assert.equal(res.body.kind, 'file')
  assert.equal(res.body.size, Buffer.byteLength('# 正文\n'))
  assert.equal(res.body.deletedAt, '2026-11-06T02:30:00.000Z')
  assert.ok(res.body.id)
  assert.deepEqual(await vaultFiles(beer), [MANIFEST, '.trash/' + FILE])
  assert.equal(await readFile(join(beer.vault, '.trash', FILE), 'utf8'), '# 正文\n')
  const folder = await beer.api('GET', '/library/folder?path=' + encodeURIComponent('内容库/文章'))
  assert.deepEqual(folder.body.entries, [])

  const trash = await beer.api('GET', '/trash')
  assert.equal(trash.status, 200)
  assert.deepEqual(trash.body.items, [{
    id: res.body.id,
    path: '.trash/' + FILE,
    originalPath: FILE,
    kind: 'file',
    size: Buffer.byteLength('# 正文\n'),
    deletedAt: '2026-11-06T02:30:00.000Z',
  }])
})

test('删除文件夹：整个文章条目移进 .trash，回收站记为文件夹并带上总大小', async t => {
  const beer = await startBeer(t, {
    vault: { [NOTE]: '# 正文\n', [ARTICLE + '/images/封面.png']: 'png' },
    now: fixedNow,
  })

  const res = await beer.api('POST', '/library/trash', { path: ARTICLE })

  assert.equal(res.status, 200)
  assert.equal(res.body.kind, 'folder')
  assert.equal(res.body.size, Buffer.byteLength('# 正文\n') + 3)
  assert.equal(res.body.trashedTo, '.trash/' + ARTICLE)
  assert.deepEqual(await vaultFiles(beer), [
    MANIFEST,
    '.trash/' + ARTICLE + '/images/封面.png',
    '.trash/' + ARTICLE + '/index.md',
  ])
  const folder = await beer.api('GET', '/library/folder?path=' + encodeURIComponent('内容库/文章'))
  assert.deepEqual(folder.body.entries, [])

  const trash = await beer.api('GET', '/trash')
  assert.deepEqual(trash.body.items.map(i => [i.path, i.originalPath, i.kind, i.size]), [
    ['.trash/' + ARTICLE, ARTICLE, 'folder', Buffer.byteLength('# 正文\n') + 3],
  ])
})

test('回收站里已有同路径的项时加时间戳和序号，绝不覆盖原来的', async t => {
  const beer = await startBeer(t, { vault: { [FILE]: '第一版\n' }, now: fixedNow })

  const first = (await beer.api('POST', '/library/trash', { path: FILE })).body
  await writeFile(join(beer.vault, FILE), '第二版\n')
  const second = (await beer.api('POST', '/library/trash', { path: FILE })).body
  await writeFile(join(beer.vault, FILE), '第三版\n')
  const third = (await beer.api('POST', '/library/trash', { path: FILE })).body

  assert.equal(first.trashedTo, '.trash/' + FILE)
  assert.equal(second.trashedTo, '.trash/内容库/文章/散件-20261106-103000.md')
  assert.equal(third.trashedTo, '.trash/内容库/文章/散件-20261106-103000-2.md')
  assert.equal(await readFile(join(beer.vault, '.trash', FILE), 'utf8'), '第一版\n')
  assert.equal(await readFile(join(beer.vault, second.trashedTo), 'utf8'), '第二版\n')
  assert.equal(await readFile(join(beer.vault, third.trashedTo), 'utf8'), '第三版\n')
  assert.deepEqual((await beer.api('GET', '/trash')).body.items.map(i => i.originalPath), [FILE, FILE, FILE])
})

test('恢复：从回收站移回原路径，回收站里不再有它，Obsidian 里的路径不变', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '# 正文\n' }, now: fixedNow })
  const deleted = (await beer.api('POST', '/library/trash', { path: ARTICLE })).body
  assert.equal((await beer.api('GET', '/trash')).body.items.length, 1)

  const res = await beer.api('POST', '/trash/restore', { id: deleted.id })

  assert.equal(res.status, 200)
  assert.equal(res.body.id, deleted.id)
  assert.equal(res.body.path, ARTICLE)
  assert.equal(await readFile(join(beer.vault, NOTE), 'utf8'), '# 正文\n')
  assert.deepEqual((await beer.api('GET', '/trash')).body.items, [])
  const folder = await beer.api('GET', '/library/folder?path=' + encodeURIComponent('内容库/文章'))
  assert.deepEqual(folder.body.entries.map(e => e.name), ['2026-11-01-搬家'])
  // 恢复后不在 .trash 里留空文件夹
  assert.deepEqual(await readdir(join(beer.vault, '.trash')), ['.beer-trash.json'])
})

test('恢复时原位置已经有东西：409，不覆盖原位置的内容，回收站里的项还在', async t => {
  const beer = await startBeer(t, { vault: { [FILE]: '删除前\n' }, now: fixedNow })
  const deleted = (await beer.api('POST', '/library/trash', { path: FILE })).body
  await writeFile(join(beer.vault, FILE), '删除后新写的\n')

  const res = await beer.api('POST', '/trash/restore', { id: deleted.id })

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'restore_conflict')
  assert.match(res.body.error.message, /已经有/)
  assert.equal(await readFile(join(beer.vault, FILE), 'utf8'), '删除后新写的\n')
  assert.equal(await readFile(join(beer.vault, deleted.trashedTo), 'utf8'), '删除前\n')
  assert.equal((await beer.api('GET', '/trash')).body.items.length, 1)
})

test('清空回收站：只有显式调用才真的删掉，清空后列表为空、文件不回到库里', async t => {
  const beer = await startBeer(t, { vault: { [FILE]: '散件\n', [NOTE]: '# 正文\n' }, now: fixedNow })
  await beer.api('POST', '/library/trash', { path: FILE })
  await beer.api('POST', '/library/trash', { path: ARTICLE })

  const res = await beer.api('DELETE', '/trash')

  assert.equal(res.status, 200)
  assert.equal(res.body.removed, 2)
  assert.deepEqual((await beer.api('GET', '/trash')).body.items, [])
  assert.deepEqual(await vaultFiles(beer), [MANIFEST])
  assert.equal(await readFile(join(beer.vault, MANIFEST), 'utf8'), JSON.stringify({ version: 1, items: [] }, null, 2) + '\n')
  const folder = await beer.api('GET', '/library/folder?path=' + encodeURIComponent('内容库/文章'))
  assert.equal(folder.body.exists, true)
  assert.deepEqual(folder.body.entries, [])
})

test('清空回收站：本来就空时也正常返回，不建多余的东西', async t => {
  const beer = await startBeer(t, { vault: { [FILE]: '散件\n' }, now: fixedNow })

  const res = await beer.api('DELETE', '/trash')

  assert.equal(res.status, 200)
  assert.equal(res.body.removed, 0)
  assert.deepEqual(await vaultFiles(beer), [FILE])
})

test('不存在、越界、回收站内部的路径都不能删除，库外文件不受影响', async t => {
  const outside = await makeTempDir(t, 'outside-', { 'secret.md': '库外的秘密\n' })
  const beer = await startBeer(t, { vault: { [FILE]: '散件\n' }, now: fixedNow })
  const escape = relative(beer.vault, join(outside, 'secret.md'))
  const cases = [
    ['内容库/没有这个.md', 404, 'not_found'],
    [escape, 400, 'path_invalid'],
    [join(outside, 'secret.md'), 400, 'path_invalid'],
    ['内容库/../文章', 400, 'path_invalid'],
    ['', 400, 'path_invalid'],
    [undefined, 400, 'path_invalid'],
    [42, 400, 'path_invalid'],
    ['.trash', 400, 'trash_path_invalid'],
    ['.TRASH/内容库/文章/x.md', 400, 'trash_path_invalid'],
    ['.trash/内容库/文章/x.md', 400, 'trash_path_invalid'],
  ]

  for (const [path, status, code] of cases) {
    const res = await beer.api('POST', '/library/trash', { path })
    assert.equal(res.status, status, `删除 ${JSON.stringify(path)} 应返回 ${status}`)
    assert.equal(res.body.error.code, code)
  }
  assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), '库外的秘密\n')
  assert.deepEqual(await vaultFiles(beer), [FILE])
})

test('恢复：缺少编号或编号不存在时拒绝，库里的东西不动', async t => {
  const beer = await startBeer(t, { vault: { [FILE]: '散件\n' }, now: fixedNow })

  for (const body of [{}, { id: '' }, { id: 42 }]) {
    const res = await beer.api('POST', '/trash/restore', body)
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'id_invalid')
  }
  const unknown = await beer.api('POST', '/trash/restore', { id: 't-不存在' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'trash_item_not_found')
  assert.deepEqual(await vaultFiles(beer), [FILE])
})

test('重启 Beer 后回收站列表和原路径都还在，仍然可以恢复', async t => {
  const beer = await startBeer(t, { vault: { [NOTE]: '# 正文\n' }, now: fixedNow })
  const deleted = (await beer.api('POST', '/library/trash', { path: ARTICLE })).body

  const again = await beer.restart()

  const trash = await again.api('GET', '/trash')
  assert.deepEqual(trash.body.items.map(i => [i.id, i.originalPath, i.path, i.kind]), [
    [deleted.id, ARTICLE, '.trash/' + ARTICLE, 'folder'],
  ])
  const restored = await again.api('POST', '/trash/restore', { id: deleted.id })
  assert.equal(restored.status, 200)
  assert.equal(await readFile(join(beer.vault, NOTE), 'utf8'), '# 正文\n')
})
