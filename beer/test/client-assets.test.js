// 编辑器前端文件：GET /api/beer/client/editor.js 回打包好的 ES 模块
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBeer, PREFIX } from './helpers/beer.js'

test('编辑器：服务端提供打包好的编辑器模块，导出 createLiveEditor', async t => {
  const beer = await startBeer(t)
  const res = await fetch(beer.url + PREFIX + '/client/editor.js')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /javascript/)
  const code = await res.text()
  assert.match(code, /createLiveEditor/)
})

