import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { startBeer, startFake, makeTempDir } from './helpers/beer.js'
import { keychainStore } from '../src/secrets.js'

test('设置：返回注入的插件配置项和各密钥是否已存，不泄露密钥本身', async t => {
  const beer = await startBeer(t, {
    config: { homeApiBase: 'http://home.test:8787', rinApiBase: 'https://blog.test', opencodeGoBase: 'https://go.test', audioCacheLimitGB: 3 },
    secrets: { 'home-api-key': 'super-secret-home' },
  })

  const res = await beer.api('GET', '/settings')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.config, {
    homeApiBase: 'http://home.test:8787',
    rinApiBase: 'https://blog.test',
    opencodeGoBase: 'https://go.test',
    audioCacheLimitGB: 3,
  })
  assert.deepEqual(res.body.secrets, {
    'home-api-key': 'present',
    'rin-admin-username': 'missing',
    'rin-admin-password': 'missing',
    'opencode-go-api-key': 'missing',
  })
  assert.doesNotMatch(JSON.stringify(res.body), /super-secret-home/)
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(beer.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不暴露数据目录')
})

test('设置：读钥匙串出错时标为 error，接口照常返回', async t => {
  const beer = await startBeer(t, {
    secrets: { get: async name => { if (name === 'rin-admin-password') throw new Error('locked'); return undefined } },
  })

  const res = await beer.api('GET', '/settings')

  assert.equal(res.status, 200)
  assert.equal(res.body.secrets['rin-admin-password'], 'error')
  assert.equal(res.body.secrets['home-api-key'], 'missing')
})

test('钥匙串：通过 macOS security 命令读取（用假 security 脚本验证参数、找不到、出错）', { skip: process.platform !== 'darwin' && '只在 macOS 上验证 security 命令' }, async t => {
  const bin = await makeTempDir(t, 'fake-security-')
  const security = join(bin, 'security')
  // 假 security：记录参数；-a home-api-key 返回值，-a broken 失败，其他按 macOS 的「找不到」退出码 44。
  await writeFile(security, `#!/bin/sh
echo "$@" >> "${join(bin, 'calls.log')}"
case "$*" in
  *"-a home-api-key"*) printf 'k-from-keychain\\n' ;;
  *"-a broken"*) echo "boom" >&2; exit 1 ;;
  *) exit 44 ;;
esac
`)
  await chmod(security, 0o755)
  const store = keychainStore('beer-test', { securityPath: security })
  const beer = await startBeer(t, { secrets: store })

  const res = await beer.api('GET', '/settings')
  assert.equal(res.body.secrets['home-api-key'], 'present')
  assert.equal(res.body.secrets['rin-admin-password'], 'missing')

  assert.equal(await store.get('home-api-key'), 'k-from-keychain')
  assert.equal(await store.get('nope'), undefined)
  await assert.rejects(store.get('broken'), err => {
    assert.match(err.message, /broken/)
    assert.doesNotMatch(err.message, /boom/)
    return true
  })
  const { readFile } = await import('node:fs/promises')
  assert.match(await readFile(join(bin, 'calls.log'), 'utf8'), /find-generic-password -s beer-test -a home-api-key -w/)
})

test('保存密钥：写进钥匙串，回包只有状态不带值，之后 GET 显示已存', async t => {
  const store = {}
  const beer = await startBeer(t, { secrets: store })

  const res = await beer.api('PUT', '/settings/secrets/opencode-go-api-key', { value: '  sk-new key$"\'\\中  ' })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { name: 'opencode-go-api-key', status: 'present' })
  assert.equal(store['opencode-go-api-key'], 'sk-new key$"\'\\中', '去掉首尾空白，中间原样')
  assert.doesNotMatch(JSON.stringify(res.body), /sk-new/)
  const after = await beer.api('GET', '/settings')
  assert.equal(after.body.secrets['opencode-go-api-key'], 'present')
  assert.doesNotMatch(JSON.stringify(after.body), /sk-new/)
})

test('保存密钥：未知账号名 404，空值 / 非字符串 / 含换行 400，钥匙串不变', async t => {
  const store = { 'home-api-key': 'old' }
  const beer = await startBeer(t, { secrets: store })

  const unknown = await beer.api('PUT', '/settings/secrets/nope', { value: 'x' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'secret_unknown')

  for (const value of ['', '   ', 42, null, undefined, 'a\nb', 'a\tb', 'a\u0000b']) {
    const res = await beer.api('PUT', '/settings/secrets/home-api-key', value === undefined ? {} : { value })
    assert.equal(res.status, 400, JSON.stringify(value))
    assert.equal(res.body.error.code, 'secret_invalid')
  }
  assert.deepEqual(store, { 'home-api-key': 'old' })
})

test('保存密钥：写钥匙串失败回 500 keychain_write_failed，不带原始错误', async t => {
  const beer = await startBeer(t, {
    secrets: { get: async () => undefined, set: async () => { throw new Error('stderr: secret-in-error') } },
  })

  const res = await beer.api('PUT', '/settings/secrets/home-api-key', { value: 'abc' })

  assert.equal(res.status, 500)
  assert.equal(res.body.error.code, 'keychain_write_failed')
  assert.doesNotMatch(JSON.stringify(res.body), /secret-in-error|abc/)
})

test('保存密钥：限额、家里状态每次现读钥匙串，保存后立即用新值', async t => {
  const go = await startFake(t, { 'GET /zen/go/v1/usage': () => ({ usage: {} }) })
  const home = await startFake(t, { 'GET /health': () => ({ status: 'ok', machines: {} }) })
  const beer = await startBeer(t, { config: { opencodeGoBase: go.url, homeApiBase: home.url }, secrets: {} })

  assert.equal((await beer.api('GET', '/quota')).status, 503, '没填密钥时查不了限额')
  assert.equal((await beer.api('PUT', '/settings/secrets/opencode-go-api-key', { value: 'go-1' })).status, 200)
  assert.equal((await beer.api('PUT', '/settings/secrets/home-api-key', { value: 'home-1' })).status, 200)
  await beer.api('GET', '/quota')
  await beer.api('GET', '/machines')
  assert.equal((await beer.api('PUT', '/settings/secrets/opencode-go-api-key', { value: 'go-2' })).status, 200)
  await beer.api('GET', '/quota')

  assert.deepEqual(go.requests.map(r => r.headers.authorization), ['Bearer go-1', 'Bearer go-2'])
  assert.equal(home.requests.at(-1).headers.authorization, 'Bearer home-1')
})

test('钥匙串写入：用 security -i 从标准输入送命令，参数里没有密钥，特殊字符转义后读回逐字相同', { skip: process.platform !== 'darwin' && '只在 macOS 上验证 security 命令' }, async t => {
  const bin = await makeTempDir(t, 'fake-security-')
  const security = join(bin, 'security')
  // 假 security：参数记到 args.log，标准输入记到 stdin.log；-a broken 的命令失败。
  await writeFile(security, `#!/bin/sh
echo "$@" >> "${join(bin, 'args.log')}"
input=$(cat)
printf '%s\\n' "$input" >> "${join(bin, 'stdin.log')}"
case "$input" in *'-a "broken"'*) exit 1 ;; esac
exit 0
`)
  await chmod(security, 0o755)
  const store = keychainStore('beer-test', { securityPath: security })
  const value = `a b'c"d\\e$f中文`

  await store.set('home-api-key', value)
  await assert.rejects(store.set('broken', 'x'), err => {
    assert.match(err.message, /broken/)
    return true
  })
  await assert.rejects(store.set('home-api-key', 'a\nb'))

  const { readFile } = await import('node:fs/promises')
  const args = await readFile(join(bin, 'args.log'), 'utf8')
  assert.deepEqual(args.trim().split('\n'), ['-i', '-i'], '只带 -i，换行值根本不启动 security')
  const stdin = (await readFile(join(bin, 'stdin.log'), 'utf8')).split('\n')[0]
  assert.equal(stdin, `add-generic-password -U -s "beer-test" -a "home-api-key" -T /usr/bin/security -w "a b'c\\"d\\\\e$f中文"`)
})

test('钥匙串写入：真 security -i 对引号、反斜杠、$、中文的解析和 quoteArg 一致', { skip: process.platform !== 'darwin' && '只在 macOS 上验证 security 命令' }, async () => {
  // 只读探测：查一个不存在的钥匙串路径，security 的报错里会回显解析后的参数。不碰任何真钥匙串。
  const { execFile } = await import('node:child_process')
  const { quoteArg } = await import('../src/secrets.js')
  const path = `/nonexistent-beer-probe/a b'c"d\\e$f中文`
  const out = await new Promise(resolve => {
    const child = execFile('/usr/bin/security', ['-i'], (_err, stdout, stderr) => resolve(stdout + stderr))
    child.stdin.end(`show-keychain-info ${quoteArg(path)}\n`)
  })
  assert.ok(out.includes(path), out)
})
