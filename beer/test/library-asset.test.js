// 文章预览里的图片：GET /api/beer/library/asset?path=<链接里写的路径>&from=<笔记路径>
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBeer, PREFIX } from './helpers/beer.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPG = Buffer.from('ffd8ffe000104a464946', 'hex')

const NOTE = '内容库/文章/2026-11-05-原型/index.md'

async function asset(beer, params) {
  const res = await fetch(beer.url + PREFIX + '/library/asset?' + new URLSearchParams(params))
  const bytes = Buffer.from(await res.arrayBuffer())
  let body
  try { body = JSON.parse(bytes.toString('utf8')) } catch {}
  return { status: res.status, type: res.headers.get('content-type'), bytes, body, headers: res.headers }
}

async function vaultWithImages(t) {
  return startBeer(t, {
    vault: {
      [NOTE]: '# 原型\n\n![首页](images/01-首页.png)\n',
      '内容库/文章/2026-11-05-原型/images/01-首页.png': PNG,
      '内容库/文章/共用/封面.jpg': JPG,
      'assets/截图 1.png': PNG,
      '附件/深层/只在这里.webp': PNG,
      '内容库/文章/2026-11-05-原型/说明.md': '# 不是图片\n',
    },
  })
}

test('图片：按笔记所在文件夹解析相对路径，回原始字节和图片类型', async t => {
  const beer = await vaultWithImages(t)
  const res = await asset(beer, { path: 'images/01-首页.png', from: NOTE })
  assert.equal(res.status, 200)
  assert.equal(res.type, 'image/png')
  assert.deepEqual(res.bytes, PNG)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('图片：../ 回到上级、./ 开头、库根路径都能找到', async t => {
  const beer = await vaultWithImages(t)
  const up = await asset(beer, { path: '../共用/封面.jpg', from: NOTE })
  assert.equal(up.status, 200)
  assert.equal(up.type, 'image/jpeg')
  assert.equal((await asset(beer, { path: './images/01-首页.png', from: NOTE })).status, 200)
  assert.equal((await asset(beer, { path: 'assets/截图 1.png', from: NOTE })).status, 200)
  assert.equal((await asset(beer, { path: 'assets/截图%201.png', from: NOTE })).status, 200) // Markdown 里空格常写成 %20
})

test('图片：Obsidian 的 ![[文件名]] 只写文件名，在整个库里按文件名找', async t => {
  const beer = await vaultWithImages(t)
  const res = await asset(beer, { path: '只在这里.webp', from: NOTE })
  assert.equal(res.status, 200)
  assert.equal(res.type, 'image/webp')
  assert.equal((await asset(beer, { path: '截图 1.png' })).status, 200) // 没有 from 也能按文件名找
})

test('图片：找不到回 404；不是图片回 415；跑出库外回 400/403', async t => {
  const beer = await vaultWithImages(t)
  assert.equal((await asset(beer, { path: 'images/没有.png', from: NOTE })).status, 404)
  assert.equal((await asset(beer, { path: '说明.md', from: NOTE })).body.error.code, 'not_image')
  const escape = await asset(beer, { path: '../../../../../etc/passwd.png', from: NOTE })
  assert.equal(escape.status, 400)
  assert.equal((await asset(beer, { path: '/etc/hosts.png' })).status, 400)
  assert.equal((await asset(beer, { path: '' })).status, 400)
})

// 编辑器里粘贴 / 拖入图片：POST /api/beer/library/attachment?from=<笔记路径>&name=<文件名>，请求体是图片字节
async function attach(beer, params, bytes, type = 'image/png') {
  const res = await fetch(beer.url + PREFIX + '/library/attachment?' + new URLSearchParams(params), {
    method: 'POST', headers: { 'content-type': type }, body: bytes,
  })
  return { status: res.status, body: await res.json() }
}

test('粘贴图片：存到笔记旁边的 images/，返回库内路径和 Markdown 相对链接', async t => {
  const beer = await vaultWithImages(t)
  const res = await attach(beer, { from: NOTE, name: '截图 2.png' }, PNG)
  assert.equal(res.status, 201)
  assert.equal(res.body.path, '内容库/文章/2026-11-05-原型/images/截图-2.png') // 空白换成 -，链接里不用转义
  assert.equal(res.body.link, 'images/截图-2.png')
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  assert.deepEqual(await readFile(join(beer.vault, res.body.path)), PNG)
  // 存进去马上能读
  assert.equal((await asset(beer, { path: res.body.link, from: NOTE })).status, 200)
})

test('粘贴图片：重名不覆盖，自动加序号；没给文件名按类型起名', async t => {
  const beer = await vaultWithImages(t)
  const again = await attach(beer, { from: NOTE, name: '01-首页.png' }, PNG)
  assert.equal(again.body.link, 'images/01-首页-1.png')
  const unnamed = await attach(beer, { from: NOTE }, JPG, 'image/jpeg')
  assert.match(unnamed.body.link, /^images\/粘贴图片-\d{8}-\d{6}\.jpg$/)
})

test('粘贴图片：不是图片、太大、笔记路径不对都拒绝', async t => {
  const beer = await vaultWithImages(t)
  assert.equal((await attach(beer, { from: NOTE, name: 'a.exe' }, PNG, 'application/octet-stream')).status, 415)
  assert.equal((await attach(beer, { from: '../外面/x.md', name: 'a.png' }, PNG)).status, 400)
  assert.equal((await attach(beer, { name: 'a.png' }, PNG)).status, 400)
  assert.equal((await attach(beer, { from: NOTE, name: 'a.png' }, Buffer.alloc(0))).status, 400)
  const big = Buffer.alloc(21 * 1024 * 1024)
  assert.equal((await attach(beer, { from: NOTE, name: 'big.png' }, big)).status, 413)
})
