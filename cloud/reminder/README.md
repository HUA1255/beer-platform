# 云端提醒服务（beer-reminder）

Beer Platform 的邮件提醒（issue #44）。这是一个 Cloudflare Worker：提醒存在 D1 里，Cron 每分钟检查一次，到点用 Cloudflare 自带的发信功能（`send_email` 绑定）给自己发邮件。和 MacBook 开不开机、家里在不在线都没关系，MacBook 只要能上网就能建提醒。

- 地址：`https://remind.example.com`（换成你自己域名的子域名；`workers.dev` 在国内访问不稳定）
- 套餐：Workers Free。发给账号里**验证过**的地址不收费，也不占发信额度（2026-11-12 实测可用）
- 发件人 `MAIL_FROM` 必须在 Email Routing 域名下；收件人固定是 `MAIL_TO`（只发给自己），接口不接受收件人字段
- 只做一次性提醒，不做重复提醒（周期性的日程由调用方每次生成下一条时再建）

## 接口

所有请求都要带 `Authorization: Bearer <REMINDER_TOKEN>`。错误统一是 `{ "error": { "code", "message" } }`，`message` 是中文，可以直接给用户看。

| 请求 | 说明 |
|---|---|
| `POST /reminders` | 建一条。请求体 `{ due_at, title, body?, source?, ref? }`。`due_at` 必须带时区，例如 `2026-11-18T13:30:00+08:00`；比现在早 2 分钟以上的拒绝（`due_in_past`）。回 201 和这条提醒 |
| `GET /reminders` | 按到点时间排序列出。可选 `?status=pending\|sent\|failed\|cancelled`、`?ref=…`、`?limit=…`（默认 100，最多 500） |
| `GET /reminders/{id}` | 查一条 |
| `DELETE /reminders/{id}` | 取消待发的，回这条提醒（状态 `cancelled`；重复取消也成功）。已发或已失败的回 409 |
| `GET /health` | `{ "ok": true }` |

提醒的字段：`id`、`due_at`（UTC）、`due_at_beijing`（「2026 年 11 月 18 日（周三）13:30」）、`title`、`body`、`source`（调用方，例如 `beer`）、`ref`（调用方自己的编号）、`status`、`attempts`、`last_error`、`sent_at`、`created_at`。

没配 `MAIL_FROM` / `MAIL_TO` 时建提醒直接回 503 `mail_not_configured`，不会建了发不出去。

## 到点发送

- Cron 每分钟跑一次，把 `status = pending` 且到了 `next_try_at` 的提醒发出去，一次最多 20 条。实测到点后 1 分钟内发出。
- 发之前先「认领」：把 `next_try_at` 往后推 5 分钟，推成功的那次触发才发，所以两次触发重叠也不会重复发。
- 发信失败按 1、2、4、8、16 分钟的间隔重试，一共试 6 次，还失败就记为 `failed`，原因写在 `last_error`。
- 晚发 5 分钟以上（比如 Cloudflare 那边出故障后恢复），邮件里注明「原定 xx:xx，晚发了 N 分钟」。
- 时间一律按北京时间显示，存的是 UTC。
- 新部署的 Cron 大约 3 分钟后才开始触发（2026-11-12 实测），刚部署完马上到点的提醒会晚几分钟。

## 部署

第一次部署（已经做过，记在这里备查）：

```bash
cd cloud/reminder
npm install
npx wrangler login
npx wrangler d1 create beer-reminder          # 把 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply beer-reminder --remote
npx wrangler deploy
openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put REMINDER_TOKEN   # 同一个值存进 Beer 钥匙串的 reminder-api-key
printf '<发件地址>' | npx wrangler secret put MAIL_FROM
printf '<验证过的收件地址>' | npx wrangler secret put MAIL_TO
```

还要在 Cloudflare 后台（或用 `wrangler email routing enable <域名>`）给域名开 Email Routing，并添加、验证收件地址（`wrangler email routing addresses create <地址>`，再去邮箱点验证链接）。

改代码以后：`npm test`，然后 `npx wrangler deploy`。改表结构时在 `migrations/` 加新文件，再跑 `npm run migrate`。

## 测试

```bash
npm test
```

测试用 Node 自带的 `node:sqlite` 模拟 D1，跑的是真实的建表 SQL；发信和时钟都换成假的。覆盖建、列、取消、到点发、重叠触发只发一次、失败重试、连续失败记为失败、重启后照常发、晚发注明原定时间。
