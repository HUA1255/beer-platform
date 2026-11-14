// 测试用：node:sqlite 包成 D1 的最小接口（prepare / bind / first / all / run），
// 跑真实的建表 SQL；再加一个可控时钟和假的发信绑定。
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService } from '../src/service.js'

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url))

export function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    async first() {
      return sqlite.prepare(sql).get(...args) ?? null
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) }
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args)
      return { meta: { changes: Number(r.changes) } }
    },
  })
  return { prepare: sql => statement(sql), sqlite }
}

export const TOKEN = 'test-token'
export const ENV = { REMINDER_TOKEN: TOKEN, MAIL_FROM: 'remind@example.com', MAIL_TO: 'me@example.com' }

/** 一个完整的服务：时钟从 start 开始，clock.advance(分钟) 往前拨；sent 记录发出的邮件。 */
export function setup({ start = '2026-11-18T00:00:00Z', env = ENV, failTimes = 0 } = {}) {
  const db = fakeD1()
  let current = new Date(start)
  const clock = {
    now: () => new Date(current),
    advance(minutes) {
      current = new Date(current.getTime() + minutes * 60e3)
    },
    set(iso) {
      current = new Date(iso)
    },
  }
  const sent = []
  let failures = failTimes
  const email = {
    async send(msg) {
      if (failures > 0) {
        failures--
        const e = new Error('delivery failed')
        e.code = 'E_DELIVERY_FAILED'
        throw e
      }
      sent.push(msg)
      return { messageId: `<m${sent.length}@example.com>` }
    },
  }
  let n = 0
  const logs = []
  const make = () => createService({ db, email, env, now: clock.now, newId: () => `r${++n}`, log: l => logs.push(l) })
  const service = make()
  const api = async (method, path, body, token = TOKEN) => {
    const res = await service.fetch(new Request('https://remind.test' + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: res.status, body: await res.json() }
  }
  return { db, clock, sent, service, api, logs, restart: make }
}
