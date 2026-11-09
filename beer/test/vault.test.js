import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, listFiles, makeTempDir } from './helpers/beer.js'

test('首次使用：还没选库时返回 unset，且不在数据目录留下任何文件', async t => {
  const beer = await startBeer(t, { vault: false })

  const res = await beer.api('GET', '/vault')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'unset' })
  assert.deepEqual(await listFiles(beer.dataDir), [])
})

test('选定库后返回 ready，重启后仍记得', async t => {
  const vault = await makeTempDir(t, 'my-vault-', { '笔记.md': '# hi' })
  const beer = await startBeer(t, { vault: false })

  const chosen = await beer.api('PUT', '/vault', { path: vault })
  assert.equal(chosen.status, 200)
  assert.deepEqual(chosen.body, { status: 'ready', path: vault })

  const again = await beer.restart()
  assert.deepEqual((await again.api('GET', '/vault')).body, { status: 'ready', path: vault })
  assert.deepEqual(await listFiles(vault), ['笔记.md'], '选库不往库里写东西')
})

test('选的位置不存在时拒绝，不建目录也不记住', async t => {
  const parent = await makeTempDir(t, 'parent-')
  const missing = join(parent, '不存在的库')
  const beer = await startBeer(t, { vault: false })

  const res = await beer.api('PUT', '/vault', { path: missing })

  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'vault_not_found')
  assert.equal(existsSync(missing), false)
  assert.deepEqual((await beer.api('GET', '/vault')).body, { status: 'unset' })
  assert.deepEqual(await listFiles(beer.dataDir), [])
})

test('选的不是文件夹或不是绝对路径时拒绝', async t => {
  const dir = await makeTempDir(t, 'parent-', { 'a.md': 'x' })
  const beer = await startBeer(t, { vault: false })

  for (const path of [join(dir, 'a.md'), 'relative/vault', '', 42]) {
    const res = await beer.api('PUT', '/vault', { path })
    assert.equal(res.status, 400, `应拒绝 ${path}`)
  }
  assert.deepEqual((await beer.api('GET', '/vault')).body, { status: 'unset' })
})

test('记住的库被移走后返回 missing，让用户重新选，不自动重建', async t => {
  const beer = await startBeer(t)
  await rm(beer.vault, { recursive: true })

  const res = await beer.api('GET', '/vault')

  assert.deepEqual(res.body, { status: 'missing', path: beer.vault })
  assert.equal(existsSync(beer.vault), false)
})
