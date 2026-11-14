# Beer（`beer-workbench`）

DSH Desktop 里的 Beer 工作台包：业务整页布局（`customFrame` + 紧凑顶栏），宿主原生对话放在右侧可收起；8 个固定分页（首页、录音、素材、选题、文章、发布、规则、回收站），分页横排末尾的「＋」可添加绑定库内文件夹的自定义分页（笔记 / 条目列表样式，可删除，固定分页不能排序、隐藏、删除）；第一次使用时用宿主目录选择器选 Obsidian 库并记住。术语见仓库根目录 `GLOSSARY.md`，整体布局以 `docs/layouts/v3.html` 为准，首页以 `docs/layouts/home-a-v2.html` 为准。

> **包名 `beer-workbench` 不要再改**：宿主按包名生成本地身份 `local:beer-workbench`，改名会变成新工作台，旧会话不迁移。

## 依据的规范版本

- DSH Desktop 工作台开发规范（在线版）：<https://dshdesktop.com/workbench/docs/development.md>，**版本 2026-10-27**（2026-11-05 实际获取并通读）。
- 目标 DSH Desktop 0.13.2，内置 dsh 运行时 **0.2.2-alpha.2**。`engines.dsh` 写 `>=0.2.2-alpha.2 <0.3.0-0`（宿主比较时 `includePrerelease`，预发布版在范围内）。
- 不写 `register({ id })`，不写 `repository`，没有 `prepare` / `postinstall` 脚本。

## 结构

```
beer/
├── package.json、cordis.patch.yml
├── src/                 服务端（手写 ESM，零第三方运行时依赖；@deepseek-ai/schemastery 由宿主提供）
│   ├── index.js         dsh 入口：name / inject / Config / apply —— 只接线 + 连接鉴权 + 注册 AI 工具
│   ├── app.js           createBeerContext({ config, secrets, now?, fetch? }) 业务上下文；createBeerHandler({ context }) → (req, res) handler
│   ├── config.js        插件配置项（Schemastery）
│   ├── secrets.js       钥匙串读取（/usr/bin/security）
│   ├── llm.js           共享的模型调用（opencode go，OpenAI 兼容 chat/completions）
│   ├── home-client.js   家里服务的 HTTP 客户端（homeFetch / homeJson / homeError）
│   ├── dates.js         本机时区的日期文本（localDate / localDateTime）
│   ├── platform-versions.js  平台列表、平台版本快照和「用户是否改过」判断（存数据目录，不进内容库）
│   ├── state.js         数据目录里的小状态（库位置、会话编号、对话栏状态）
│   ├── http/router.js   /api/beer 下的路由表、HttpError、reply()
│   └── modules/         每个业务模块一个文件，在 modules/index.js 里登记
│       ├── schedule.js  日程文件 `日程.md` 的解析、分组、勾选 / 删除、快速添加、计划日 / 预估时长 / 子步骤 / 没排期、按行合并写入、小月历网格，以及建 / 改 / 删时的邮件提醒同步（#56）
│       ├── schedule-tools.js  日程 AI 工具（#53、#54）：建 / 查 / 改 / 完成 / 删除、拆步骤、两步确认、待确认状态，以及首页待确认接口（#55）
│       ├── schedule-reminders.js  日程邮件提醒同步（#56）：提醒偏好、云端建 / 删、编号写回
│       └── schedule-shared.js  日程模块共用的星期名称、分组标题和 flattenItems
├── client/beer-client.js  面板（手写单文件，只 require react，不需要构建）
└── test/                接口测试（node --test）
```

### 现有接口

| 接口 | 说明 |
|---|---|
| `GET /api/beer/vault` | `{ status: 'unset' }` / `{ status: 'ready', path }` / `{ status: 'missing', path }` |
| `PUT /api/beer/vault` `{ path }` | 记住用户选定的已有文件夹；不存在、不是文件夹、不是绝对路径 → 400，什么都不写 |
| `GET /api/beer/panel` | 分页列表（8 个固定分页 + 自定义分页，按添加顺序；每个分页带绑定的库内文件夹 `folder`，自定义分页另有 `custom: true` 和 `style: 'note' \| 'list'`）、各分页对话栏是否收起（发布页默认收起，自定义分页默认展开）、记住的会话编号 |
| `POST /api/beer/panel/tabs` `{ title, folder, style }` | 新建自定义分页，返回 201 和 `{ id, title, folder, style, custom: true }`。`title` 非空、最多 40 字（两端空白会去掉）；`folder` 是库内相对路径（`/` 分隔、无 `..`、允许尚不存在）；`style` 只能是 `note`（笔记）或 `list`（条目列表）。`id` 由服务端生成（`custom-<随机短串>`） |
| `DELETE /api/beer/panel/tabs/:id` | 删除自定义分页，同时清掉它的对话栏状态；固定分页 → 403 `tab_fixed`，没有这个分页 → 404。只删分页，不删库里的文件夹和文件 |
| `PUT /api/beer/panel/chat/:tab` `{ collapsed }` | 记住某个分页的对话栏状态 |
| `PUT /api/beer/panel/session` `{ sessionId }` | 记住本工作台的会话，下次 `ensureSession` 用它恢复 |
| `GET /api/beer/settings` | 当前配置项、钥匙串里各密钥 `present` / `missing` / `error`（不返回密钥本身） |
| `PUT /api/beer/settings/secrets/:name` `{ value }` | 设置弹层填写钥匙串密钥（#33）→ `{ name, status: 'present' }`，不回密钥值。账号名不在 `SECRET_NAMES` 里 → 404 `secret_unknown`；值不是字符串、去掉首尾空白后为空、或含换行等控制字符 → 400 `secret_invalid`；写钥匙串失败 → 500 `keychain_write_failed`（不带原始错误）。存的是去掉首尾空白后的值；改了 Rin 账号或密码会清掉内存里的 Rin 令牌，下次发布重新登录 |
| `GET /api/beer/library/folder?path=` | 列出库内一个文件夹（`path` 为库内相对路径，`/` 分隔，空 = 库根目录）：`{ path, exists, entries: [{ name, path, kind: 'folder'\|'file', size, modifiedAt }] }`；子文件夹在前，不列 `.` 开头的隐藏项；文件夹不存在时 `exists: false`、不建目录 |
| `GET /api/beer/library/file?path=` | 读一个 Markdown 文件：`{ path, content, version, modifiedAt }`；`version` 是内容指纹（不透明字符串），保存时原样带回 |
| `PUT /api/beer/library/file` `{ path, content, baseVersion }` | 保存 Markdown。文件此刻的版本 ≠ `baseVersion`（读取后被别处改过或删掉）→ **409 `edit_conflict`，不写入**，回 `current: { version, modifiedAt } \| null`；成功回新的 `{ path, version, modifiedAt }`。先写同目录临时文件再改名，不会留下写了一半的文件 |
| `GET /api/beer/materials?type=&tag=&status=` | 列出素材条目 `{ entries: [{ path, folder, title, type, tags, status, source, modifiedAt, summary? }], types, tags, statuses }`；`path` 是稳定的库内相对路径，供多选等后续功能用；`types` / `tags` 始终给全量（供筛选按钮） |
| `GET /api/beer/materials/tags` | 当前标签表 `{ tags: [...] }`；`内容库/素材/标签表.md` 不存在时回默认 10 个标签 |
| `PUT /api/beer/materials/tags` `{ tags }` | 覆盖写回标签表（去重、去首尾空白；空标签 / 换行等控制字符 / 方括号 / 逗号 / 超长 → 400，最多 100 个）。只重写 `## 标签` 下面的列表，文件其余内容保留 |
| `POST /api/beer/materials/tags` `{ tag }` 或 `{ tags }` | 往标签表末尾追加（已有的不重复加），回完整的 `{ tags }` |
| `POST /api/beer/materials` `{ title, type?, tags?, content?, status?, source? }` | 手动新建素材：写 `内容库/素材/<YYYY-MM-DD>-<安全名称>/index.md`，同名自动加 `-2`；标签必须在标签表里（400 `tag_unknown`）→ 201 `{ entry }` |
| `POST /api/beer/materials/init` | 建出 `内容库/素材/标签表.md` 和 `内容库/素材/说明.md`（已存在的不动），回路径和当前标签 |
| `POST /api/beer/materials/import/url` `{ url, title?, tags?, type? }` | 抓网页写素材：文章抓正文（去掉 script/style/nav/header/footer/aside，优先 `<article>`，最多 200k 字符）；B 站和 YouTube 的视频链接交给家里转写（#34）→ **202 `{ video }`**（家里的录音视图，`kind: 'video'`），不当场写条目，转写完由录音分页取回写成「视频」条目，家里连不上 → 502 `home_unreachable`，不排队；Vimeo、抖音等其他视频站只存标题和简介。20 秒超时、普通 UA；抓取失败 → 502 `fetch_failed`，不写半成品；标签不在表里 → 400 `tag_unknown`，什么都不写 |
| `POST /api/beer/materials/import/file` `{ filePath, title?, type?, tags?, summary? }` | 导入本地图片（jpg/jpeg/png/gif/webp/avif）或 PDF：原文件保留文件名复制进条目文件夹，`index.md` 写 `类型: 图片\|PDF`、`原件:`、`来源: 本地文件`；没有 `summary` 时正文写「（待补充）」。只接受存在且后缀受支持的绝对路径，其他 → 400 |
| `POST /api/beer/materials/import/text` `{ title, content, tags?, type? }` | 文字素材：写 `类型: 文字`，正文就是 `content`；标题或正文为空 → 400 |
| `GET /api/beer/quota` | opencode go 三个限额 `{ checkedAt, limits: [{ window: '5h'\|'week'\|'month', label, percent, state, resetsAt }] }`；失败见下文「opencode go 限额接口」 |
| `POST /api/beer/recordings` | multipart 原文（字段 `file`，可多个文件逐个上传）流式转发给家里 `POST /recordings`（守背压：家里读多快 Beer 就读多快，1 GB 录音也只占几 MB 内存，#31），返回家里的录音视图（201）。家里连不上 / 超时 → 502 `home_unreachable`「家里暂时连不上」，**不排队**；家里的错误按原状态码和 `error_code` 透传 |
| `GET /api/beer/recordings[?status=&sync=1]` | 转发家里录音列表；`status` 可为 `processing` / `failed` / `ready` / `stored`。`sync=1` 时先取回一次（30 秒内不重复） |
| `GET /api/beer/recordings/:id` | 转发单条录音视图（五步 `steps`、`progress`、`error_code`，以及 `summary`、`summary_type`、`mail_error`） |
| `GET /api/beer/recordings/:id/transcript` | 转发 `{ id, filename, markdown, srt, summary, summary_type }`；没就绪 → 409 `NOT_READY` |
| `POST /api/beer/recordings/:id/retry` | 转发重试；没失败 → 409 `NOT_FAILED` |
| `DELETE /api/beer/recordings/:id` | 转发删除，只能删失败的录音（其他状态 → 409 `NOT_FAILED`，不存在 → 404 `NOT_FOUND`）；NAS 原件保留，成功后清本机 `audio-cache/` 里这一条，返回 `{ deleted, id, cacheCleared }` |
| `POST /api/beer/recordings/:id/summarize` `{ type }` | 转给家里 `POST /recordings/{id}/resummarize`，按 `会议` / `口述灵感` / `课程讲座` 重做摘要并覆盖原摘要（文字稿、srt 不动），返回家里的录音视图，另加 `entryUpdated: <路径> \| null`：这条录音已经入库时，同步素材条目的 `类型:` 和摘要正文（`transcript.md` / `transcript.srt` 不动）；没入库就只返回家里结果，不建条目。家里连不上 → 502 `home_unreachable`；家里自己的 400 `TYPE_INVALID` / 409 `NOT_READY` 原样透传 |
| `POST /api/beer/recordings/sync` | 取回家里 `status=ready` 的结果，写成 `内容库/素材/<日期>-<名称>/`（`index.md`、`transcript.md`、`transcript.srt`），再对每条调 `POST /recordings/{id}/stored`。返回 `{ imported: [{ id, filename, path }], skipped: [{ id, filename, path }] }`；重复调用不重写、不覆盖（按 `index.md` 的 `录音编号:` 判断） |
| `GET /api/beer/recordings/:id/audio` | 播放录音原件：本机上传过的直接读缓存，本地没有再向家里 `GET /recordings/{id}/audio` 下载到数据目录的 `audio-cache/`。返回音频字节，`content-type` 按扩展名给；支持 `Range`（206 + `Content-Range` + `Accept-Ranges: bytes`）。家里连不上 → 502 `home_unreachable`，家里的错误码按原状态透传 |
| `GET /api/beer/machines` | 家里 `/health` 的三台机器：`{ online: true, machines: { mac_mini, windows, nas } }`；连不上 → `{ online: false, error: '家里暂时连不上' }` |
| `GET /api/beer/search?q=&includeTrash=1&scope=` | 直接扫库的检索：`{ query, total, groups: [{ tabId, title, hits: [{ path, name, title, kind, snippet, highlights: [{ start, end }], matchedIn, tabId, playAt? }] }] }`；支持 `#标签`、`状态:`、`类型:` 条件；默认不搜 `.trash`；`scope=<tabId>` 只搜该分页的文件夹。见下文「搜索（#8）」 |
| `POST /api/beer/library/trash` `{ path }` | 把库内一项（文件或整个文件夹）移到库里的 `.trash/<原路径>`：`{ id, path, originalPath, trashedTo, kind, size, deletedAt }`；目标已存在时加时间戳 / 序号，**绝不覆盖**；不存在 → 404 `not_found`；`path` 已经在 `.trash` 里 → 400 `trash_path_invalid` |
| `GET /api/beer/trash` | 回收站列表 `{ items: [{ id, path, originalPath, kind: 'file'\|'folder', size, deletedAt }] }`；`path` 是它在 `.trash` 里的位置，最新的在前 |
| `POST /api/beer/trash/restore` `{ id }` | 恢复到原路径，回 `{ id, path }`；原位置已被占用 → **409 `restore_conflict`，不覆盖**；回收站里已经没有了 → 404 `trash_item_missing` |
| `DELETE /api/beer/trash` | 手动清空回收站（唯一会真正删除文件的地方，没有任何自动清理）：删掉 `.trash` 里的内容并清空清单，回 `{ removed }` |
| `POST /api/beer/articles` `{ title }` | 新建文章条目：`内容库/文章/<YYYY-MM-DD>-<名称>/index.md`，回 201 `{ path, folder, title, status: '选题' }`。名称去掉 `\/:*?"<>\|` 和首尾空白，空则用「未命名」；同日同名加 `-2`、`-3`，绝不覆盖 |
| `GET /api/beer/articles?status=&includeArchived=1` | 列出文章：`{ articles: [{ path, folder, title, status, date, modifiedAt, statusTime, words, archived }] }`。默认跳过 `_归档`；`status=已归档` 只列归档区，`includeArchived=1` 一起列出。`statusTime` 是 frontmatter 的 `状态时间:`（ISO），旧文章没有时为 `null`；`words` 是正文去掉空白后的字符数 |
| `POST /api/beer/articles/status` `{ path, status, baseVersion? }` | 改状态：只能在 `选题`、`草稿`、`成稿` 之间改；目标或当前是 `已确认` / `已发布` → 403 `status_locked`。只改 frontmatter 的 `状态:` 和 `状态时间:` 两行：`状态时间:` 写成服务端当前时间（ISO），没有这一行时插在状态行后面，重复改状态不会多出好几行。改成 `成稿` 时多回 `askGeneratePlatformVersions: true`，只提示，不生成平台版本 |
| `POST /api/beer/articles/title` `{ path, title, baseVersion? }` | 改标题：改正文第一个 `# ` 行（没有就插在 frontmatter 后），frontmatter 里本来有 `标题:` 时一起改（没有就不加）；文件夹名不变 |
| `POST /api/beer/articles/archive` `{ path }` | 把整个条目文件夹移到 `内容库/文章/_归档/<原文件夹名>`；重名加 `-2` 等；回新 `{ path, folder }` |
| `POST /api/beer/articles/delete` `{ path }` | 删除：状态 `已发布` → 403 `published_immutable`（只能归档）；其余状态调用回收站，整个条目移进 `.trash/<原路径>` |
| `GET /api/beer/articles/assist?path=&kind=outline\|facts\|counter\|titles` | AI 帮手：回 `{ prompt }`（带标题和正文），由面板放进对话草稿或复制；**不调模型、不写正文** |
| `POST /api/beer/articles/versions/generate` `{ path, platforms? }` | 为成稿生成平台版本，默认 `知乎`、`小红书`（`platforms` 只能是这两个）；逐个调模型改写后写 `<条目>/知乎.md`、`<条目>/小红书.md`，回 `{ versions: [...], hardRuleWarnings: [{ platform, rule, reason }] }`。**主稿一个字节都不改**；已有且用户改过的平台版本 → 409 `version_user_edited`，不覆盖。规则开关打开时把软规则带进改写提示词，写文件后用硬规则检查正文；检查失败只回 `hardRuleWarnings: []` + `hardRuleCheckError`，不影响版本 |
| `GET /api/beer/articles/versions?path=` | 列出这条文章已有的平台版本：`{ versions: [{ platform, path, generatedAt, mainDraftVersion, stale, userEdited, action: 'ok' \| 'regenerate' \| 'prompt_only' }] }`。`path` 可以是 `index.md` 或条目文件夹 |
| `POST /api/beer/articles/versions/regenerate` `{ path, platform }` | 只重新生成没被用户改过的平台版本；改过的 → 409 `version_user_edited`，body 带 `mainDraftChanges: { added, removed }`（生成时快照与当前主稿的逐行 diff）。回包也带 `hardRuleWarnings` |
| `GET /api/beer/publish[?includePublished=1]` | 发布分页列表，默认只列状态 `成稿`、`已确认` 的文章；`includePublished=1` 时把 `已发布` 也列出来（排在最后，给补记录 / 重看发布包用）：`{ articles: [{ path, title, status, main, versions: [{ platform, content, diff: [{ type: 'same' \| 'added' \| 'removed', text }], userEdited }] }] }`。`main` / `content` 是去掉 frontmatter 的正文；`diff` 以主稿为基准逐行对照，`added` 是平台版本新增的行；`userEdited` 用平台文件 frontmatter 的 `生成内容版本` 判断（同 #14） |
| `GET /api/beer/topics?ensure=1` | 选题分页：`{ date, briefPath, exists, content, angles, topics }`。`ensure=1` 时当天的 `内容库/选题简报/<日期>.md` 不存在就生成（模拟每天第一次打开），已存在直接返回、不调模型；`topics` 是状态为「选题」的文章 |
| `POST /api/beer/topics/brief/regenerate` | 强制重新调模型生成并覆盖当天简报，回同样的结构；模型失败时当天已有文件原样保留 |
| `POST /api/beer/topics/articles` `{ title, why?, materials?, skipMissing? }` | 建选题（选角度或手动新建）：用文章模块新建状态为「选题」的文章，正文 `# <标题>`（有 `why` 时下面加一行 `> 为什么值得写：…`），frontmatter 写 `素材:`（`[[库内路径]]` 列表）→ 201 `{ path, title, status: '选题', materials, skipped }`。`skipMissing: true` 时对不上的素材跳过并列进 `skipped`，否则 400 `material_missing` |
| `POST /api/beer/topics/materials` `{ path, materials }` | 把多选素材合并进状态为「选题」的文章的 `素材:` 字段（去重）；正文和其余 frontmatter 逐字不动，素材一侧不写反向记录。非「选题」→ 409 `article_not_topic`；素材不存在 → 400 `material_missing` |
| `GET /api/beer/topics/discuss?angle=&why=` | 和 AI 讨论某个角度：回 `{ prompt }`（带当天简报全文和角度），由面板放进对话草稿；**不调模型** |
| `POST /api/beer/publish/confirm` `{ path }` | 确认发布：`成稿` 先把状态改成 `已确认`，`已确认` 直接重跑发布。发布时逐张上传条目 `images/` 下的图片（`POST {rinApiBase}/api/storage`，multipart `file` + `key`=文件名），把正文里的 `images/x.png` / `./images/x.png` 换成返回的 `url`；Obsidian 的 `![[图片]]` / `![[图片\|300]]` / `![[图片\|说明]]` 按预览同一规则在库里找（笔记文件夹 → 库根 → 全库按文件名），上传（key 里空格换 `-`）后换成 `![说明](url)`，有一张找不到就 422 `image_missing`、一张图都不传；再 `POST {rinApiBase}/api/feed`（`Authorization: Bearer <自动登录拿到的令牌>`，JSON `{ title, content, summary?, draft: false, listed: true, tags: [] }`）。成功后状态改 `已发布`，往条目里的 `发布记录.md` 追加 `- <YYYY-MM-DD HH:mm> Rin 博客 <链接或文章 id>`。成功后顺手为已有平台版本的 `知乎` / `小红书` 各准备一份发布包，回包带 `packages: [{ platform, text, images, packageDir, publishUrl }]`（没有平台版本文件的平台跳过；只读库、写 Beer 数据目录，**不向平台发请求**）；包准备失败回空数组和 `packageError`，不影响已经成功的发布。失败码：502 `rin_unreachable` / `rin_unauthorized` / `rin_upstream_error` / `rin_bad_response`，没令牌 503 `rin_no_token`，没配地址 503 `rin_not_configured`；状态停在失败前（原状态或 `已确认`），不写发布记录。主稿只改 `状态:` / `状态时间:` 两行 |
| `POST /api/beer/publish/retry` `{ path }` | 只对 `已确认` 的文章重跑发布；成功后同样改 `已发布` 并写记录。`已发布` / 没确认过的 → 409 `status_invalid` |
| `POST /api/beer/publish/package` `{ path, platform }` | 准备知乎 / 小红书发布包（半自动发布）：`platform` 只能是 `知乎`、`小红书`，文章状态必须是 `已确认` 或 `已发布`（其他 → 409 `status_invalid`）。正文取条目里的 `<platform>.md` 并去掉 frontmatter（没有 → 409 `version_missing`）；条目 `images/` 下的 `.png/.jpg/.jpeg/.gif/.webp/.avif` 复制到 `{root}/publish-packages/<安全条目名>-<platform>/`（库外，先清空再建）。回 `{ platform, text, images: [{ name, source, copiedTo }], packageDir, publishUrl }`，`source` 是库内相对路径，`copiedTo` 是复制后的绝对路径。**服务端不登录、不提交、不向平台发任何请求** |
| `POST /api/beer/publish/record` `{ path, platform, url }` | 用户确认已发布后填链接：`platform` 是 `知乎` / `小红书` / `Rin 博客`，`url` 必须是 http(s) 完整地址（否则 400 `url_invalid` / `platform_invalid`）。往条目 `发布记录.md` 追加 `- <YYYY-MM-DD HH:mm> <平台> <链接>`（不存在就新建，已有内容保留）；同平台同链接重复提交不重复追加（`appended: false`）。主稿状态是 `已确认` 时只改 `状态:` / `状态时间:` 两行成 `已发布`（带 baseVersion，冲突 → 409 `edit_conflict`）；已是 `已发布` 不重复改。回 `{ path, platform, url, status, record, appended }` |
| `GET /api/beer/rules/settings` | 规则学习开关 `{ enabled }`，默认 `false` |
| `PUT /api/beer/rules/settings` `{ enabled }` | 打开 / 关闭规则学习（存在 Beer 数据目录的 `rules.json`）；`enabled` 不是布尔 → 400 `enabled_invalid` |
| `GET /api/beer/rules` | `{ enabled, hard: [...], soft: [...], pending: [{ rule, count }], observations: [{ rule, count }] }`；规则取自 `内容库/规则/硬规则.md`、`软规则.md` |
| `POST /api/beer/rules/observe` `{ path, platform }` | 把用户改后的平台版本和生成时正文对比，调模型归纳 0–3 条规则并累计观察次数：`{ observed: true, added: [{ rule, evidence, count }], pending }`。没有生成快照 / 没有改动 / 开关关闭 → `{ observed: false, reason: 'no_snapshot' \| 'unchanged' \| 'disabled', added: [], pending }`；后两种情况不调模型 |
| `POST /api/beer/rules/promote` `{ rule, kind: 'hard' \| 'soft' }` | 观察满 3 次的规则写进对应规则文件，并从观察计数移除；不足 3 次 → 409 `rule_not_ready`；`kind` 不认识 → 400 `kind_invalid` |
| `GET /api/beer/home[?ensure=1]` | 首页汇总 `{ date, tasks: { publishPending: [{ path, title, status, statusTime, statusTimeSource: 'frontmatter' \| 'mtime', waitedDays, waitedLong, words, platforms: [{ platform, state: '已生成' \| '未生成' \| '待发' }], action: 'confirm' \| 'publish' }], writing: [{ path, title, status, progress }], brief: { path, exists, generatedToday, title, angleCount, error? }, editConflicts: [{ path, detectedAt }] }, recordings: { online, processing: [{ id, filename, progress, step }], failedCount, error? }, schedule: { path, exists, summary: { today, overdue, dueThisWeek, unscheduled } }, week: { since, materials, drafts, published }, rules: { enabled, hard, soft, pending } }`。`ensure=1` 时今天还没有选题简报就先调模型生成（每天第一次打开），已存在不调模型；生成失败不影响首页，`brief` 回 `exists: false` 和 `error`。家里连不上时 `recordings.online: false`，接口仍回 200。`waitedDays` / `waitedLong` / 字数和平台状态见下文「首页（#23）」；日程汇总的数字见「日程与待办（#49）」，完整列表仍由 `GET /schedule` 提供 |
| `POST /api/beer/home/brief/regenerate` | 重新生成当天选题简报（直接调 `topics.regenerateBrief`）→ `{ path, content, angles }`。模型不可用时和选题分页一样不写半成品 |
| `GET /api/beer/schedule[?month=YYYY-MM]` | 读库根目录 `日程.md`：`{ path, exists, version, modifiedAt, today, weekEnd, summary: { today, overdue, dueThisWeek, unscheduled }, items, entries, done, groups, calendar }`。`items` 是未完成的顶层事项（按时间排好）；`entries` 是分组用的平铺列表（顶层事项 + 排了计划日 / 截止日的子步骤）；`done` 是已完成的最近 100 条（✅ 日期倒序）；`groups` 是 `overdue / today / week / later / unscheduled` 五组（每组 `{ key, label, count, items }`，没排期组另有 `totalMinutes` 和 `subtitle`）。`calendar` 是首页小月历（#52）的当月网格 `{ year, month, today, days: [{ date, day, inMonth, today, event, due, overdue }] }`，周一开头、补齐前后月；`?month=` 换一个月，格式不对 → 400 `month_invalid`。每条事项带 `date`（事件 / 计划日 = `scheduled ?? due`）、`due`、`location`（`%%beer loc=%%` 解码后的地点）、`remind`（`default` / `off` / `30m`）、`reminderIds`、`reminderLabel`（如 `13:30 邮件提醒` / `提前 30 分钟`）和 `reminderError`（云端没建成时是「提醒没建成」）。文件不存在时 `exists: false`、不建文件。见下文「日程与待办（#49）」「月历（#52）」和「日程邮件提醒（#56）」 |
| `POST /api/beer/schedule/items` `{ title, due?, scheduled?, time?, endTime?, duration?, tags?, source?, location?, recurrence?, remind?, reminderId?, articlePath?, subtasks? }` | 往 `日程.md` 追加一条，带 `%%beer id=… src=… loc=… remind=…%%`（放在 Tasks 字段前面）→ 201 `{ path, item, version, modifiedAt, reminders?, reminderError? }`。文件不存在时新建。`subtasks` 是 `[{ title, duration?, scheduled?, due?, time?, endTime?, tags?, location? }]`，父事项下面写缩进四格的子步骤，每步有自己的 id。`due` / `scheduled` 用 `YYYY-MM-DD`，`time` / `endTime` 用 `HH:mm`，`duration` 用 `6h` / `90m` / `1h30m` / `6 小时` / `90 分钟` / `2 小时 30 分钟`（统一由 `parseDuration` 解析）；`source` 默认「快速添加」。`location` 是可选的文字地点，写进 `loc=` 时做 percent-encode，读回时解码，未知 `%%beer%%` 字段和顺序不变。`recurrence` 接受 Tasks 写法或中文（`每天` / `每周日` / `每月 15 日` / `每月最后一天`），写入前转成 Tasks 英文写法，读不懂的文本原样写入。有具体时刻时默认建邮件提醒（`remind: 'default'`，可写 `off` / `30m`）；云端连不上时日程照常 201，回 `reminderError: '提醒没建成：…'`。给 #50 快速添加、#54 子步骤和 #56 提醒同步复用 |
| `POST /api/beer/schedule/quick-add` `{ text }` | 快速添加（#50、#54）：从一句话里识别日期 / 时刻 / 预估时长（「周五前交专栏稿」「明天 14:00 开会」「做一期讲解视频，约 6 小时」），标题去掉这些短语，来源固定「快速添加」，走和 `POST /schedule/items` 相同的校验与按行合并写入 → 201 `{ path, item, version, modifiedAt, reminders?, reminderError? }`。没提日期就存成「没排期」。空文本、只有日期 / 时长没有标题的句子 → 400 `text_invalid`；日期不存在 → 400 `date_invalid`。识别出时刻时同样默认建邮件提醒（#56）。支持的说法见下文「快速添加（#50）」 |
| `POST /api/beer/schedule/items/complete` `{ id, done, baseVersion }` | 勾选 / 取消勾选：完成写 `- [x]` 和 ✅ 当天日期，取消勾选去掉 ✅；其余字节（包括读不懂的行、未知 Tasks 字段）不动 → `{ path, item, version, modifiedAt, merged, autoCompleted, generated }`。`generated` 是这次生成的重复下一条（`{ id, title, due, scheduled, time, endTime }`），没有生成时为 `null`。完成带 `🔁` 且日期可算的事项时追加下一条未完成事项（新 id，保留时刻 / 标签 / 时长 / 来源 / 关联文章，不复制提醒偏好和提醒编号），然后才判断父事项自动完成：通过这个接口把子步骤全部勾完时父事项自动写 `- [x]` 和 ✅，`autoCompleted` 列出被自动完成的事项；在 Obsidian 里手勾不会触发。生成的下一条还没进解析树，不算进本次父事项判断。`baseVersion` 对不上时重新读、按 `id` 找到最新那一行再改，不覆盖 Obsidian 里的修改（`merged: true`）；目标行已不在时，版本没变 → 404 `schedule_item_missing`，版本变了 → 409 `schedule_merge_conflict`；连读三次都被抢先 → 409，不写文件。重复规则见下文「重复事项（#51）」 |
| `POST /api/beer/schedule/items/delete` `{ id, baseVersion }` | 删除这一条和紧跟其后、缩进更深的子步骤 / 说明行（遇到空行或不更深的行为止）→ `{ path, deleted: { id, title }, version, modifiedAt, merged, remindersCancelled?, reminderError? }`。日程删成功后才去云端取消提醒；取消失败只回 `reminderError`，不回滚。合并规则同勾选；版本没变但已经找不到这一条 → 404 `schedule_item_missing`，版本变了找不到 → 409 `schedule_merge_conflict` |
| `POST /api/beer/schedule/items/schedule` `{ id, scheduled, baseVersion }` | 把一条（顶层事项或子步骤）排到某天：写 `⏳ YYYY-MM-DD`，其他字节不动 → `{ path, item, version, modifiedAt, merged }`。`scheduled` 必须是 `YYYY-MM-DD` |
| `POST /api/beer/schedule/items/unschedule` `{ id, baseVersion }` | 取消排期：去掉这一行的 `⏳`，条目回到「没排期」→ `{ path, item, version, modifiedAt, merged }` |
| `POST /api/beer/schedule/items/subtasks` `{ parentId, title, duration?, scheduled?, due?, time?, endTime?, tags?, source?, baseVersion? }` | 给一条日程加子步骤，插在父事项最后一行缩进内容之后（原有子步骤 / 说明行保留）→ 201 `{ path, item, parent, version, modifiedAt, merged }`。`item` 带 `parentTitle` / `stepIndex` / `stepCount`；`baseVersion` 可选 |
| `POST /api/beer/schedule/items/subtasks/update` `{ id, changes, baseVersion }` | 改一个子步骤（`title` / `due` / `scheduled` / `time` / `endTime` / `duration` / `tags` / `source`）→ `{ path, item, version, modifiedAt, merged }`。目标不是子步骤 → 400 `not_subtask` |
| `POST /api/beer/schedule/items/subtasks/delete` `{ id, baseVersion }` | 删除一个子步骤和它下面缩进更深的行，父事项保留 → `{ path, deleted, parent, version, modifiedAt, merged }`。目标不是子步骤 → 400 `not_subtask` |
| `GET /api/beer/schedule/pending` | 列出当前库待确认的识别结果：`{ entries: [{ id, items, source, createdAt, vault }] }`，只含 `GET /schedule` 同一个库的条目；没有条目或还没选库时 `entries: []`。`items` 和 `beer_schedule_create` 的字段一致，另带 `location` 和按 `ctx.now()` 现算的 `reminderLabel`（`default` 取下一封默认提醒的时刻，`30m` 写「提前 30 分钟（HH:mm）」，`off` 为 `null`）；`durationMinutes` 也会补上。见下文「识别到日程卡片（#55）」 |
| `POST /api/beer/schedule/pending/accept` `{ id }` | 「加入日程」：把这条识别结果里的所有条目写进 `日程.md`（逐条走 `schedule.createItem`，保留按行合并、版本检查和 #56 的提醒同步），来源沿用这批识别的来源（现在「对话」，以后 QQ 邮箱识别复用同一字段），然后从待确认状态删掉 → `{ entryId, source, created: [{ id, title, due, scheduled, time, endTime, tags, source }] }`。先原子取走条目再写，所以并发 / 连点两次只有一次成功，另一次 404 `schedule_pending_missing`，不会重复写；写到一半失败时没写进去的条目会放回状态，已经建好的不会在重试时再建。缺 `id` → 400 `id_invalid`，还没选库 → 409 `vault_unset` |
| `POST /api/beer/schedule/pending/dismiss` `{ id }` | 「忽略」：只从待确认状态删掉，不写 `日程.md` → `{ removed: true, entry }`；未知或已经处理过 → 404 `schedule_pending_missing`，缺 `id` → 400 `id_invalid` |

库访问的规则（`src/modules/library.js`，其他模块直接 import 用 `locate` / `listFolder` / `readNote` / `saveNote` / `createNote` / `writeNote` / `parseFrontmatter`）：路径必须是库内相对路径——空、绝对路径、`..` / `.` / 空段、NUL → 400 `path_invalid`；经符号链接落到库外 → 403 `outside_vault`；`file` 接口只认 `.md`，其他 → 415 `not_markdown`；没有的文件 → 404 `not_found`；还没选库 → 409 `vault_unset`。`createNote` 只在文件不存在时新建（已存在 → 409 `file_exists`），`writeNote` 不做冲突检测、给配置文件用。冲突后只检测和提示、不覆盖，不做合并（2026-11-09 定，issue #32）。

## 素材分页与标签表（#11）

素材分页（`materials`）不列文件夹，而是列出**素材条目**：

- `内容库/素材/<日期>-<名称>/index.md`（文件夹条目），以及直接放在 `内容库/素材/` 下的 `*.md`。`标签表.md`、`说明.md` 是配置文件，不算素材。
- 开头 `---` 之间的属性读 `类型:`、`标签:`、`状态:`、`来源:`、`标题:`、`摘要:`（也认英文 `type` / `tags` / `status` / `source` / `title` / `summary`）。`标签:` 支持 `[a, b]`、下面缩进的 `- a`、以及 `a, b` 三种写法，解析在 `src/modules/library.js` 的 `parseFrontmatter`。
- 标题依次取 `标题:`、正文第一个 `# `、文件夹名；`summary` 取 `摘要:` 或正文去掉标题后的前 120 字。
- 默认类型集合：录音、链接、图片、文字、PDF、手动；`GET /materials` 会把现有条目里的类型并进来，`types` / `tags` 不受筛选影响。

**标签表**固定在 `内容库/素材/标签表.md`，Beer 写出的格式是：

```md
# 素材标签表

（这段说明文字 Beer 不改）

## 标签

- AI 工具
- Obsidian
```

一行一个 `- 标签名`。Beer 只重写 `## 标签` 标题下面那段列表；找不到这个标题时，替换文件里第一段顶层 `- xxx` 列表；两者都没有时在文件末尾追加一节。列表之外的说明、其他标题和列表原样保留。写标签表不做版本冲突检测（这是配置文件，允许覆盖）。文件不存在时接口返回默认 10 个标签：AI 工具、Obsidian、笔记方法、写作、效率、自动化、费用、内容运营、读书、生活。

`内容库/素材/说明.md` 是给 AI 看的说明文件（条目格式、类型、状态、标签表怎么用）。`POST /api/beer/materials/init`、保存标签表、新建素材时若不存在就建出来，已有内容不覆盖。

`assertKnownTags(ctx, tags)` 从 `src/modules/materials.js` 导出，供新建 / 修改素材时复用：规范化标签并检查都在标签表里，不在的 → 400 `tag_unknown`。

新建条目用 `createEntry(ctx, folder, name, files, { fallbackName })`（返回 `{ path, name, files }`）：名称里的 `\ / : * ? " < > |` 和控制字符去掉、空名用 `fallbackName`，已有同名文件夹时依次用 `-2`、`-3`，绝不覆盖；任一文件写失败会把新建的文件夹整个删掉。名称安全化单独用 `safeEntryName(name, fallback)`。

## 素材导入（#12）

`src/modules/material-import.js` 把链接、本地图片 / PDF、文字整理成和手动素材一样的条目，接口和 AI 工具共用同一套逻辑：

- 条目格式：`内容库/素材/<YYYY-MM-DD>-<名称>/index.md`，开头属性至少 `标题:`、`类型:`、`标签:`、`状态: 待整理`、`来源:`、`日期:`；图片 / PDF 多一行 `原件: <原文件名>`。
- 导入前先建出 `说明.md` 和 `标签表.md`（已有的不覆盖），说明文件写明条目格式、类型集合、支持的来源，以及「整理素材前必须先读这个文件」「标签只能从标签表里选」。
- 标签一律先经 `assertKnownTags`；不在表里 → 400 `tag_unknown`，本次导入一个文件都不写。抓页面失败 → 502 `fetch_failed`，同样不写。
- B 站和 YouTube（`bilibili.com`、`b23.tv`、`youtube.com`、`youtu.be`，含子域名）的链接不抓页面，交给家里 `POST /videos` 转出文字稿和摘要（#34），见下文「视频链接」。
- 其他视频站（`vimeo.com`、`douyin.com`）只保存 `og:title` / `<title>`、`og:description` / `meta description` 和链接，不抓正文，类型固定「链接」。
- 本地文件只认图片（jpg/jpeg/png/gif/webp/avif）和 PDF；必须是存在的绝对路径。原文件按原文件名复制进条目文件夹，同名条目文件夹自动加 `-2`，绝不覆盖。
- 导出的函数：`importUrl(ctx, body)`、`importFile(ctx, body)`、`createTextMaterial(ctx, body)`、`saveMaterial(ctx, args)`（AI 工具的执行逻辑）、`formatMaterialEntry(entry)`、`createSaveMaterialTool(defineTool, ctx)`。

AI 工具 `beer_save_material` 在 `src/index.js` 里用 `ctx.inject(['tools'], ...)` 注册，`@deepseek-ai/dsh-tools` 用动态 `import()`（不写进依赖）。参数是 `title`（必填）、`type`（链接/视频/图片/PDF/文字/手动）、`tags`、`url`、`filePath`、`content`、`summary`；按字段选择导入方式，返回新条目路径和属性。B 站 / YouTube 链接（不填类型、填「链接」或「视频」）提交给家里，返回「已把视频交给家里转写，进度在录音分页」的说明；「视频」配其他站的链接 → 400 `url_invalid`。视频条目的标题用视频本身的标题，AI 给的标题和标签不带过去。工具描述要求 AI 先读 `内容库/素材/说明.md` 和标签表。

回收站（`src/modules/trash.js`）把原路径、删除时间、类型和大小记在 `.trash/.beer-trash.json` 清单里，恢复靠它，重启 Harness 后仍然有效。`.trash` 是隐藏文件夹，库列表里看不到。

## 录音分页（#19、#20）

- 面板的「录音」分页是专用视图：拖入（或点选）一个或多个录音上传，逐个显示上传进度；下方是家里录音列表，每条显示「上传 → 排队 → 转写 → 摘要 → 入库」五步、`progress`、失败原因和「重试」，可以展开摘要。摘要生成前显示「摘要待生成」。
- 每条录音显示家里判断的类型 chip（会议 / 口述灵感 / 课程讲座）；类型判断错时用旁边的下拉框改成正确类型，点「重新总结」调 `POST /api/beer/recordings/:id/summarize` 重做摘要，摘要立即刷新，文字稿和 srt 不动。已经入库的录音（素材条目里有 `录音编号:`）会同步更新条目 `index.md` 的 `类型:` 和摘要正文（`entryUpdated` 给路径），`transcript.md` / `transcript.srt` 一个字节都不动。
- 摘要完成后家里会发通知邮件（见 `home/README.md`）。发信失败不影响摘要，家里视图里的 `mail_error` 会显示在录音条目上。
- Beer 打开时（选好库之后）和开着期间每 60 秒调一次 `POST /api/beer/recordings/sync`；列表每 5 秒刷新。顶栏的三台机器状态每 30 秒刷新。
- 写进素材的条目结构（`内容库/素材/<YYYY-MM-DD>-<名称>/`，日期取取回当天）：
  ```markdown
  ---
  类型: 会议
  状态: 待整理
  来源: 录音
  原件: /Volumes/NAS/录音原件/<家里编号>/<文件名>
  录音编号: <家里 id>
  日期: 2026-11-05
  ---

  摘要正文
  ```
  `类型` 取家里视图的 `summary_type`（旧版家里服务只有 `type` 字段，也认）；同目录还有 `transcript.md`（家里的 markdown 原文）和 `transcript.srt`（字幕）。`原件` 来自家里视图的 `original_path`（#19 在 `home/` 的 `view()` 里加上；旧版家里服务没有这个字段时写「未知」）。
- 已经写过的录音按条目开头属性里的 `录音编号:` 认出来，不再写、不覆盖；跳过时仍会补一次 `POST /recordings/{id}/stored`，保证「入库」一步完成。
- 「在 Obsidian 打开」用本次运行里 sync 返回的条目路径拼 `obsidian://open?path=…`；重启后还没再取回过的录音没有路径映射，会提示先取回。「交给 AI 讨论」把摘要复制到剪贴板（宿主还没提供从分页往对话输入框写草稿的注入服务）。

### 视频链接（#34）

- 提交：对话里让 AI 把 B 站 / YouTube 链接「整理到素材栏」（`beer_save_material`），或在录音分页的「粘贴 B 站 / YouTube 视频链接」框里提交；都走 `POST /api/beer/materials/import/url` → 家里 `POST /videos`。家里连不上直接报「家里暂时连不上」，不排队。
- 录音分页里和录音排在一起：标题是视频标题（转写完之前是原链接），带「视频」chip，第一步叫「提交链接」；显示作者和文字来源（平台字幕 / 平台自动字幕 / 语音识别）。没有「播放」，换成「打开原链接」；失败可以重试、删除（视频没有 NAS 原件）。
- 摘要类型下拉多了「视频」，视频默认就是这一类，可以改成别的类型重新总结。
- 取回写成的条目：
  ```markdown
  ---
  标题: <视频标题>
  类型: 视频
  摘要类型: 视频
  状态: 待整理
  来源: <原链接>
  作者: <UP 主 / 频道>
  时长: 10:15
  文字来源: 平台字幕
  录音编号: <家里 id>
  日期: 2026-11-11
  ---

  摘要正文
  ```
  同目录有 `transcript.md`（全文）和 `transcript.srt`，和录音一样。`类型` 固定「视频」，素材分页按「视频」能筛出来；重新总结只改 `摘要类型:` 和正文。
- 搜索命中视频的文字稿时，点播放会在浏览器打开原链接，并带上 `t=<秒>` 从那一秒开始。

> **opencode go 的用法已确认**（2026-11-09 用户决定）：家里服务的脚本可以调用 opencode go 套餐做摘要。详见 `home/README.md`。

## 转录 AI 工具（#22）

DSH Desktop 对话里的 AI 可以直接调用三个工具，把「提交转录、查进度、取结果」做完。`src/index.js` 用 `ctx.inject(['tools'], ...)` 注册（`tools` 是可选服务，宿主没有就不注册），`@deepseek-ai/dsh-tools` 由宿主提供、用动态 `import()` 拿，**不写进 `package.json`**；执行逻辑在 `src/modules/recordings.js`，和面板走同一套家里转发。

| 工具 | 参数 | 说明 |
|---|---|---|
| `beer_transcribe_submit` | `filePath`（本机绝对路径，必填）、`filename`（可选，家里保存用的文件名） | 读本机音频/视频，按 multipart 字段 `file` 提交给家里 `POST /recordings`，返回录音编号和五步状态文本。文件不存在、格式不支持、家里连不上（401 等）都给中文错误 |
| `beer_transcribe_status` | `id`（录音编号，必填） | 转发 `GET /recordings/{id}`，返回五步进度（上传 / 排队 / 转写 / 摘要 / 入库）、进度百分比和失败原因 |
| `beer_transcribe_result` | `id`（录音编号，必填） | 转发 `GET /recordings/{id}/transcript`，返回文字稿 markdown 全文和摘要；没有摘要时明确说明；还没转完（409 `NOT_READY`）返回「还没转写完」而不是报错 |

- 工具输出统一是带 `text` 字段的 JSON（`output.schema: { type: 'json' }`），`output.render` 把这段文本交给模型；`presentCall` 用 `card: 'generic'`、`kind: 'other'`。
- 家里连不上时错误文本一定包含「家里暂时连不上」，不会静默成功；401 / 403 提醒检查钥匙串里的 `home-api-key`。
- `registerRecordingTools(toolsCtx, context, defineTool?)` 从 `src/index.js` 导出，供测试用假的 `defineTool` 验证注册接线，不依赖宿主包。
- 提交本机文件用流式 multipart（不把整个录音读进内存），文件名按 UTF-8 原始字节写进 `filename`（家里 python-multipart 认这种，不认 `filename*`）。

## 邮件提醒 AI 工具（#44）

对话里说「周五下午三点提醒我交稿」，或者贴一份面试日程，AI 用这三个工具建、查、取消邮件提醒。提醒交给云端提醒服务（Cloudflare Worker，见 [`cloud/reminder/README.md`](../cloud/reminder/README.md)），到点由云端发邮件给自己，和 MacBook 开不开机、家里在不在线都没关系。执行逻辑在 `src/modules/reminders.js`。

| 工具 | 参数 | 说明 |
|---|---|---|
| `beer_reminder_create` | `reminders`（数组，每条 `title` 必填，`eventAt` / `remindAt` / `details` 可选）、`confirmToken` | 一份日程里几件事就放几条。只给 `eventAt`（事情本身的时间）时默认建两封：**前一天晚上 21:30** 和**开始前 1 小时**（2026-11-12 定），已经过了的那封跳过；给了 `remindAt` 就只建那一封 |
| `beer_reminder_list` | `status`（`pending` 默认 / `sent` / `failed` / `cancelled` / `all`） | 列出提醒的时间、标题、状态和编号；失败的带原因 |
| `beer_reminder_cancel` | `ids`、`confirmToken` | 取消还没发的；已发或已失败的给中文说明 |

- **必须复述确认**：建和取消都分两步。第一次不带 `confirmToken` 调用，只返回复述（具体日期 + 星期 + 时刻，例如「11 月 17 日（周二）21:30 [前一天晚上] —— 某公司一面（11 月 18 日（周三）14:00）」）和确认码，不碰云端；用户确认后带同一个确认码再调用才真正执行。确认码是这批内容的指纹，内容改了就对不上，要重新复述。
- 时间一律按北京时间，写成 `2026-11-18 14:00`，交给云端时带 `+08:00`。
- 只发给自己：云端的收件人是固定的，工具不收收件人。
- 连不上云端时错误文本以「提醒服务暂时连不上」开头，并说明没建成、不会排队补建；一批建到一半断了，会列出已经建好的几封。
- 没存 `reminder-api-key` 时提示去设置弹层里填。
- 只做一次性提醒。周期性日程的提醒由日程功能（#45）在生成下一条时再建。
- 宿主的 `defineTool` 要求参数里嵌套的对象（比如 `reminders` 数组的元素）明确写 `additionalProperties`，不写会在注册时抛错。0.1.18 就因此没注册上任何提醒工具，0.1.19 补上了，并改成三个工具各自注册：一个失败不连累另外两个，错误打到宿主日志（`[beer] 注册工具 … 失败`）。

## 录音播放与缓存（#21）

录音分页的每条录音有「播放」，打开 `GET /api/beer/recordings/:id/audio`，面板里是一个 `<audio controls>`（点到播放才请求音频，第一次播放会显示加载）。搜索结果的文字稿命中带 `▶ mm:ss`，点它切到录音分页，播放器加载这条录音并从 `playAt` 秒开始放；录音编号从素材条目 `index.md` 的 `录音编号:` 读。

- 缓存目录是 **Beer 数据目录**下的 `audio-cache/`（`path.join(config.root, 'audio-cache')`），不在内容库那棵树里；索引 `audio-cache.json` 记录 `{ id, file, size, lastPlayedAt }`。
- 上传给家里（面板拖入和 AI 工具提交两条路）用 `node:http` + `pipeline` 发，不用 `fetch`：Node 自带的 `fetch` 发流式请求体时不守背压，家里读得慢它也照样往下读，1 GB 录音会在 Beer 进程里攥住约 1 GB（#31）。见 `src/home-client.js` 的 `homeUpload`。
- 本机上传的录音在上传转发时就把 multipart 请求体 tee 到缓存目录的临时文件（边转发边写，不读进内存），家里接收成功后再流式抽出第一个文件部分放进缓存；家里连不上或回 4xx 则删掉临时文件，不留缓存。
- 本地没有的录音在播放时向家里下载，先写 `.download-*.part` 临时文件再改名；下载失败（连不上、中途断开、家里错误）清理临时文件，回 502 `home_unreachable` 或家里的原状态码 / 错误码。
- `Range: bytes=...` 支持 `start-end`、`start-`、`-suffix`，合法回 206 和 `Content-Range`，越界回 416；总能拖动进度条、从某一秒开始播。`content-type` 按缓存文件扩展名给（m4a / mp3 / wav / ogg / webm / mp4 等）。
- 每次播放把该条的 `lastPlayedAt` 更新为当前时间。超过 `audioCacheLimitGB`（默认 5）时按 `lastPlayedAt` 最久远的先删，直到不超限；只删 `audio-cache/` 里的文件，不碰内容库和家里原件。

## 文章分页（#10）

文章（`src/modules/articles.js`）的条目是 `内容库/文章/日期-名称/index.md`，开头属性至少是：

```yaml
---
标题: 为什么我把笔记搬到 Obsidian
状态: 选题
日期: 2026-11-06
---
```

改状态时会多写一行 `状态时间: 2026-11-06T02:30:00.000Z`（这次改状态的时间，ISO，用于首页算「等了几天」和确认时间）；新建文章还没有改过状态，所以一开始没有这一行。

主稿正文由用户自己写：改状态只替换 `状态:` 行并写入 / 更新 `状态时间:` 行，改标题只替换正文第一个 `# ` 行（frontmatter 里有 `标题:` 时一起改）；两次写入都带读取时的 `baseVersion`，读取后被别处改过 → 409 `edit_conflict`，不覆盖。删除复用 `trash.js` 的 `moveToTrash`；归档只是在库内把整个文件夹移动到 `_归档/`。AI 帮手只拼 prompt，不调用模型，也不写主稿。新建文件用 `library.js` 新增的 `createNote(ctx, path, content)`（父文件夹自动创建，已存在则 409 `file_exists`，绝不覆盖）。

## 平台版本（#14）

成稿文章可以在文章视图里生成「知乎」「小红书」两个平台版本，文件放在同一个条目里：`知乎.md`、`小红书.md`。每个文件开头记录：

```yaml
---
平台: 知乎
主稿版本: sha256-…
生成时间: 2026-11-06T10:00:00.000Z
生成内容版本: sha256-…
---
```

- 生成走 `src/llm.js` 的 `chatText`：`POST {opencodeGoBase}/inference/go/openai/v1/chat/completions`，默认模型 `deepseek-v4.1-flash`（配置项 `platformVersionModel`），密钥还是钥匙串里的 `opencode-go-api-key`。提示词要求按平台重写，不照抄主稿。
- 主稿 `index.md` 只读：生成、重新生成都只读取它的版本标记，不写任何一个字节。
- 判断：当前主稿版本 ≠ `主稿版本` → `stale`；平台文件正文的内容版本 ≠ `生成内容版本`（用户改过正文）→ `userEdited`。`stale && !userEdited` 可重新生成；`stale && userEdited` 只提示、不覆盖；其余 `ok`。
- 重新生成时用生成时存在 Beer 数据目录 `versions/` 里的主稿快照和当前主稿做逐行 diff；改过的版本回 409 `version_user_edited`，body 带 `mainDraftChanges: { added, removed }`。快照缺失时两个数组为空。快照不进内容库。
- 模型错误：没 key → 503 `model_no_key`；401/403 → 502 `model_unauthorized`；连不上/超时 → 502 `model_unreachable`；回包看不懂 → 502 `model_bad_response`；其他非 2xx → 502 `model_upstream_error`。

## 选题简报（#13）

选题分页（`topics`）是专用视图：当天简报、角度卡片（「建选题」「和 AI 讨论」）、「重新生成」按钮，以及状态为「选题」的文章列表。第一次打开时调 `GET /api/beer/topics?ensure=1`，当天还没有简报就生成；同一天再打开直接读文件，不再调模型。

简报文件是 `内容库/选题简报/<YYYY-MM-DD>.md`，开头属性：

```yaml
---
日期: 2026-11-06
类型: 选题简报
状态: 已生成
生成时间: 2026-11-06T10:00:00.000Z
---
```

正文是 `## 角度`（每个角度一个 `### 标题`，带「为什么值得写」和素材）和 `## 素材清单`（`[[库内路径]]` 链接、标题、类型、标签、摘要），Obsidian 里直接可读。`GET /topics` 的 `angles` 就是从这个格式读回来的；用户手工改简报改坏了，读不出角度时返回空数组，不报错。

- 输入只有库里的东西：最近 30 天素材（`内容库/素材`，最多 40 条，带标题 / 类型 / 标签 / 摘要，`类型: 读者反馈` 的排在最前）、笔记（库里除 `.trash`、`内容库/素材`、`内容库/文章`、`内容库/选题简报` 之外的 Markdown，最多 40 个文件的前 400 字）。不抓热点、不联网。素材已有单独输入，不再当笔记重复读。
- 模型走 `src/llm.js` 的 `chatText`，要求只输出 `{"angles":[{"title","why","materials"}]}`，3–6 个角度。模型回的不是合法 JSON 时，原文写进简报正文并标「模型输出未解析」，`angles: []`，接口仍回 200。
- 模型不可用（没 key、连不上、上游报错）时不写半成品：当天已有简报原样保留并回明确错误；没有文件就不建。
- 「建选题」调 `POST /topics/articles`，用 `articles.js` 的 `createArticle` 建条目（状态「选题」），再在 `index.md` 的 frontmatter 写：

  ```yaml
  素材:
    - "[[内容库/素材/2026-11-04-周会]]"
  ```

  素材可以给条目路径（`内容库/素材/xxx`、`xxx/index.md`、`[[…]]`）或素材标题。从角度建时带 `skipMissing: true`：模型给的引用对不上（比如填了笔记路径）就跳过，照样建；有跳过时留在选题分页提示跳过了哪些（不自动跳到文章分页）；不带时不存在的素材 → 400 `material_missing`，不会建出半篇。角度的「为什么值得写」写在正文标题下面。已建过同名选题的角度显示「已建 · 打开」，不再重复建。提示词里写明笔记只作参考、不能填进 materials。
- 「＋ 新建选题」：在选题分页顶栏打开选素材面板，填标题、可勾选任意素材（也可以不勾），一步建出选题。面板每次打开都重新读素材列表。
- 素材分页的「多选素材」：勾选素材卡片、选一篇状态为「选题」的文章，调 `POST /topics/materials`。只改 `素材:` 这一个块，正文和其他属性逐字不动，素材一侧不写任何反向记录。选题分页里也有同样的多选流程。
- 复用：`articles.js` 新增导出 `createArticle(ctx, title)` 和 `readArticles(ctx, { status, includeArchived })`；`materials.js` 新增导出 `listMaterialEntries(ctx)`。`topics.js` 的 `withMaterials(content, materials)`、`parseAngles(content)`、`parseAnglesJson(text)` 也导出了，供后续工单复用；首页（#23）另外用到 `topics.todayBrief(ctx)` 和 `topics.regenerateBrief(ctx)`。

## 发布分页与 Rin 博客（#15）

发布分页（`publish`）是专用视图：左边列出状态为 `成稿`、`已确认` 的文章，右边显示主稿预览和每个平台版本的逐行对照（`same` 原样、`added` 平台版本新增、`removed` 主稿有而平台版本没有），并标出用户改过的平台版本（`你改过`）。主稿正文只读，发布流程只改 frontmatter 的 `状态:` / `状态时间:` 两行。

- 确认按钮：`成稿` → `已确认` → 发布 → `已发布`。发布失败时停在 `已确认`，按钮变成「重试发布到 Rin 博客」，只重跑发布，不再改一次状态；发布记录只在成功后写一行。发布成功后顺手为已有平台版本的知乎 / 小红书各准备一份发布包（见下一节），回包里的 `packages` 直接给面板展示，`window.open` 打开发布页（被拦时给链接）。
- 图片：条目 `images/` 下的 `.png/.jpg/.jpeg/.gif/.webp/.avif` 逐张上传，返回的 `url` 替换正文里的相对路径。正文里 Obsidian 的 `![[图片]]` 嵌入（粘贴截图默认存在库根或附件文件夹）也会在库里找到并上传，换成标准的 `![说明](url)`；数字别名（`|300`）是显示尺寸，丢掉，其余别名当说明。同一张图只传一次；有找不到的图整篇不发。知乎 / 小红书发布包暂时仍只认 `images/`。`发布记录.md` 不存在时新建，已有时追加，原有内容不动。
- 时间用本机本地时间，格式 `YYYY-MM-DD HH:mm`；记录目标优先用 feed 回包里的 `url`，没有就用文章编号（`insertedId` / `id`）。
- **Rin 接口没有实测**：本文与实现依据家里服务笔记第 3 节（读 `~/rin-blog/Rin` 源码，2026-11-05）和用户已有的 `rin-publish.py`，没有对真实 Rin 实例跑过。真机验收项见仓库外的 `F:/ZcodeProjects/beer-acceptance/15.md`。若真实接口与此不同，先改 `src/modules/publish.js` 里的 `publishToRin` / `uploadImages` 和对应测试。
- 登录：Beer 用钥匙串里的 `rin-admin-username` / `rin-admin-password` 调 `POST {rinApiBase}/api/auth/login`（JSON `{ username, password }`，回 `{ token }`）换管理员令牌。Rin 的令牌是 24 小时有效的 JWT；Beer 只把它放在内存里，离过期不到 5 分钟（读 JWT 的 `exp`，读不出按 23 小时算）就重新登录，发布请求被拒（401/403）时重新登录一次、用新令牌重发同一个请求，还被拒才报 `rin_unauthorized`。登录被拒报 `rin_login_failed`，登录被限流（429）报 `rin_login_rate_limited`，钥匙串里缺账号或密码报 `rin_no_credentials`；这几种情况都不上传图片、不提交文章。

## 知乎、小红书发布包（#16）

知乎、小红书没有可用的自动发布接口，这一版做**半自动发布**：Beer 把文字和图片准备好，用户到平台网页上粘贴、上传、自己点发布，回来把链接填给 Beer。

- 发布分页里对 `已确认` 的文章显示「知乎发布包」「小红书发布包」按钮。点击后调 `POST /api/beer/publish/package`，面板把 `text` 写进剪贴板（宿主不允许剪贴板 API 时显示可全选的 textarea），列出包目录绝对路径和图片清单，再 `window.open(publishUrl, '_blank')` 打开发布页；弹窗被拦时显示可点链接。
- 文字是条目里的 `知乎.md` / `小红书.md` 去掉 frontmatter 的正文，原样复制，不改图片相对路径。
- 图片复制到 `{root}/publish-packages/<安全条目名>-<platform>/`（Beer 数据目录，库外）。每次重新准备都会清空这个目录再复制，避免上一次的旧图混进来。
- **不自动登录、不自动提交**：服务端只读库里的文件、写自己的数据目录，不向知乎 / 小红书发任何请求。
- 用户发布完在面板里选平台、填链接，调 `POST /api/beer/publish/record`：往条目 `发布记录.md` 追加一行，并把主稿从 `已确认` 改成 `已发布`（只动 `状态:` 行）。同一平台同一链接只记一次；Rin 博客由 #15 自动写记录，这里也允许手动补。
- 发布包的接口和文件位置见上面「现有接口」两行；真机验收项见仓库外的 `F:/ZcodeProjects/beer-acceptance/16.md`。

## 规则学习（#17）

规则分页从用户改过的平台版本里学写作规则，开关默认关闭（存在 Beer 数据目录的 `rules.json` 的 `enabled`）。

- **观察改稿**：在 Obsidian 里改过 `知乎.md` / `小红书.md` 后，在文章的平台版本行点「观察改稿」（或调 `POST /api/beer/rules/observe`）。服务端读生成时存在数据目录 `versions/` 里的正文快照，和当前正文对比；没有快照 → `no_snapshot`，正文没变 → `unchanged`，两种都不调模型。有改动时用 `src/llm.js` 的 `chatText` 归纳 0–3 条 `{ rule, evidence }`。
- **计数与转正**：同一规则按 trim 后的文本累加观察次数，存在 `rules.json`；满 3 次进入 `pending`。`POST /api/beer/rules/promote` 把它写进 `内容库/规则/硬规则.md` 或 `软规则.md` 并清掉计数；不足 3 次 → 409 `rule_not_ready`。
- **规则文件**：一行一条 `- 规则文本`；只把 `- ` 开头的行当规则，标题、说明等其他行原样保留。文件不存在时在转正时创建。
- **生成时**：开关打开时软规则附在平台版本提示词里；平台版本写完后用硬规则检查生成正文，违规放在 `hardRuleWarnings`（带平台名）。检查失败只回空数组和 `hardRuleCheckError`，版本照常生成。开关关闭时不读规则、不检查、提示词里不放规则。
- 供其他模块复用：`rules.js` 导出 `readRuleFiles(ctx)`、`enabledRules(ctx)`、`checkHardRules(ctx, hardRules, text)`、`ruleSummary(ctx)`（首页用的计数）；`src/platform-versions.js` 导出 `PLATFORMS`、`bodyOf`、`versionEdited(contentBody, recordedVersion)`（按 LF 归一比生成内容版本）、`saveVersionSnapshot`、`loadVersionSnapshot`；`recordings.js` 导出 `recordingSummary(ctx)`（首页用的处理中 / 失败摘要，家里连不上时不抛错）。

## 首页（#23、#47、#48）

首页是专用视图（不再复用库列表），骨架按 `docs/layouts/home-a-v2.html` 做成两栏，窄窗口堆成一列。顶部一行是日期（本机时区的「11 月 12 日 周四」）、一句话汇总（今天几件 · 几件逾期 · 本周还有几件到期 · 几件等你处理 · 几件没排期）和右侧的本周产出（新素材 / 成稿 / 已发布）。

- **左栏「日程与待办」**：`ScheduleCard`（#49）自己读 `GET /schedule`，按已逾期 / 今天 / 本周 / 以后 / 没排期分组显示，可以勾选、删除、切换 按时间 / 全部 / 已完成；「没排期」在最后、默认展开，支持预估时长、子步骤和「排到…」（#54，见下文）；顶部汇总句里的日程数字来自 `GET /home` 的 `schedule.summary`。卡片保持独立，顶部有一行快速添加（#50）：输入一句话回车保存到 `日程.md`；旁边「在对话里说」只把输入放进右侧对话草稿，不自动发送。点小月历的日期后（#52），卡片会切回「按时间」、展开「以后」、高亮并滚到当天的事项；再点同一天清除。
- **右栏**（从上到下）：**「识别到日程」**（#55，只在有待确认结果时显示；见下文「识别到日程卡片（#55）」）→ **小月历**（#52）→ 「等你处理」（#48 重排，见下）→ 「今天的选题」（一行标题 + 「打开简报 →」）→ 「正在写」（状态为 `选题` / `草稿` 的文章，显示状态和一条**粗略进度条**，点进文章页）→ 录音一行（只在有处理中或失败录音时显示）。规则积累卡片、简报全文预览、等你处理里的「新选题简报」条目已删除；生成 / 重新生成简报仍可在选题页操作。
- **等你处理（#48）**：每条左边一个类型图标，标题下一行写状态，右边是这条该做的具体动作：
  - **稿 = 成稿待确认**：`成稿待确认 · N 字 · 等了 N 天`，等了超过 2 天时这一段标红；下面列出各平台版本是「已生成」还是「未生成」；按钮「确认」（去发布页）。
  - **发 = 已确认还没发**：`已确认，还没发出 · 昨天 21:40 确认`；平台版本显示「待发」或「未生成」；按钮「去发布」。
  - **冲 = 编辑冲突**：`编辑冲突 · Obsidian 和 Beer 各改了一份 · 10 分钟前`；按钮「对比」（打开那份文件）。
  - 标题旁写「最久的已等 N 天」，按当前成稿里最长的等待天数算。
  - 平台版本状态只有「知乎」「小红书」两个真实平台（没有公众号）。「已生成」= 条目里的 `<平台>.md` 存在；「未生成」= 没有；「待发」= 文章状态是 `已确认` 且平台文件存在——Beer 没有平台维度的发布标记（只有 `发布记录.md`），所以「待发」按文章状态推导，不查发布记录。
  - 编辑冲突记录里只有 `{ path, detectedAt }`，没有保存 Obsidian 和 Beer 两边的版本内容，因此「对比」按钮只是打开那份文件（在文章页 / 对应分页里用现有的冲突提示和编辑器对照），不自动生成逐行 diff。
- **「等了几天」的数据来源**：改状态时（选题 / 草稿 / 成稿，以及发布流程的 `已确认` / `已发布`）把当时的时间写进主稿 frontmatter 的 `状态时间:`（ISO）。`waitedDays` 按 `状态时间:` 和今天在本机时区的日历日差计算；**旧文章没有 `状态时间:` 时退回文件修改时间**（`statusTimeSource: 'mtime'`），并以此计算、显示确认时间。`waitedDays > 2` 时 `waitedLong: true`，面板把「等了 N 天」标红。文件修改时间会因为改一个字就变化，所以只作为旧文章的兜底，不是可靠来源。
- **首屏不等简报**：面板先 `GET /home` 立即渲染，再异步 `GET /home?ensure=1`；生成期间「今天的选题」显示「生成中…」，返回后自动补上。生成失败（`tasks.brief.error`）或 ensure 请求本身失败只在这张卡片里提示，不影响其他卡片，也不写全局错误；每天第一次打开自动生成简报的逻辑不变。
- `GET /home` 只做汇总：`tasks.publishPending` 复用 `articles.readArticles` 再按 `publish.js` 的 `PUBLISHABLE_STATUSES` 过滤（状态 `成稿` / `已确认`，不读发布记录），每条补上 `statusTime`（frontmatter 的 `状态时间:`，没有就退回 `modifiedAt`）、`statusTimeSource`、`waitedDays`、`waitedLong`、`words`（正文去掉空白后的字符数）、`platforms`（成稿看文件在不在：在 = 已生成，不在 = 未生成；已确认时在 = 待发，不在 = 未生成）和 `action`（成稿 `confirm`、已确认 `publish`）；`tasks.writing` 复用同一份文章列表，只取 `选题` / `草稿`，按下一次修改时间倒序，每条带 `progress`（**粗略里程碑进度**，不是真实字数完成度：`选题 = 15`、`草稿 = 50`，见 `home.js` 的 `WRITING_PROGRESS` / `writingProgress`，面板画成小进度条）；`tasks.brief` 复用 `topics.todayBrief` / `topics.ensureBrief`，字段是 `{ path, exists, generatedToday, title, angleCount, error? }`，`title` 是第一个角度的标题（没有解析出角度时为 `null`）；录音复用 `recordings.recordingSummary`；规则复用 `rules.ruleSummary`（首页不再显示规则卡片，字段保留给其他界面）；`schedule` 复用 `schedule.scheduleSummary(ctx)`，只回 `{ path, exists, summary }`，完整列表由 `GET /schedule` 提供。
- `GET /home?ensure=1`：当天简报不存在时复用 `topics.ensureBrief` 生成（同一进程里并发请求也只调一次模型），已存在直接返回；模型 / 密钥等失败时首页仍 200，`tasks.brief` 回 `exists: false, generatedToday: false, title: null, angleCount: 0` 和 `error`。
- 本周从本机时区的周一起算（`week.since`）：素材按条目路径里的日期（`内容库/素材/YYYY-MM-DD-…`），没有日期前缀时按文件修改时间；成稿 / 已发布按文章修改时间（改状态时文件会更新），并且当前状态要对应「成稿」/「已发布」。
- 编辑冲突：`library.saveNote` 发现版本对不上时，把 `{ path, detectedAt }` 记到数据目录的 `edit-conflicts.json`（最多 50 条、同一路径只留最新）；这个路径之后保存成功就删掉。首页只显示最近 5 条（「对比」打开冲突文件）。
- 家里连不上或没配密钥时 `recordings` 回 `{ online: false, processing: [], failedCount: 0, error }`，首页其余部分照常返回；此时没有处理中 / 失败录音，录音行不显示。

## 日程与待办（#49、#50、#51、#52、#54）

日程存在**库根目录的 `日程.md`**，一行一条，用 Obsidian Tasks 插件的写法，手机上的 Obsidian 也能看、能勾。首页左侧「日程与待办」读它、分组显示，快速添加、勾选、排期、拆步骤和删除都写回同一个文件；右栏小月历（#52）也从同一份事项算点。重复事项（#51）完成后在同一份文件里追加下一条。后续工单（提醒同步）都在这份文件上扩展，不另存一份。

### 文件格式

```markdown
- [ ] 14:00–15:00 某公司一面（腾讯会议 123-456） #面试 %%beer id=a1 src=对话 remind=default reminder=r-8f2a,r-91c3%% 📅 2026-11-18
- [ ] 交《效率工具》专栏稿 %%beer id=b2 src=快速添加%% 📅 2026-11-13
- [ ] 整理本周素材，挑下周选题 %%beer id=c3 src=对话%% 🔁 every week on Sunday 📅 2026-11-15
- [x] 09:00 看昨天的读者留言 %%beer id=d4 src=对话%% 📅 2026-11-12 ✅ 2026-11-12
- [ ] 做一期 Beer 讲解视频 %%beer id=e5 src=对话%% ⏱ 6h
    - [ ] 写讲解稿 %%beer id=f6 src=对话%% ⏱ 2h ⏳ 2026-11-12
    - [ ] 录制 %%beer id=g7 src=对话%% ⏱ 1h
```

- `- [ ]` / `- [x]` 是未完成 / 已完成；缩进四格（或 Tab）的行是上一条的子步骤。子步骤不单独占一个分组条目，但**自己排了 `⏳` / `📅` 时会出现在对应分组**（父事项仍显示进度 `0 / 3 步`）。
- 描述开头的 `HH:mm` 或 `HH:mm–HH:mm` 是具体时刻；`📅` 是截止日（due），`⏳` 是计划日（scheduled），两个都没有就是没排期。计划日不是截止日：过了没做完留在「今天」，不算逾期。
- `⏱` 是预估时长，支持 `6h` / `6 小时` / `30m` / `1.5h` / `90 分钟` / `1h30m` / `2 小时 30 分钟`；Tasks 插件不认识这个字段，会当成正文，不影响它解析。
- `🔁` 是重复规则（Tasks 写法，如 `every day`、`every week on Sunday`、`every month on 5`）；#51 负责完成后生成下一条，详见下文「重复事项（#51）」。
- `✅` 是完成日期；#49 勾选时写当天日期，取消勾选时删掉这个字段。通过 Beer 接口把子步骤全部勾完时，父事项自动写 `- [x]` 和 ✅；在 Obsidian 里手动勾完不会触发自动完成。
- `#标签` 是类别；Beer 只把行内的 `#xxx` 当标签，不读标签表。
- `%%beer ...%%` 是 Beer 自用字段：`id`（稳定编号）、`src`（来源：对话 / 快速添加 / QQ 邮箱）、`loc`（地点，percent-encode 后写入，读回时解码）、`remind`（邮件提醒偏好：`default` / `off` / `30m`，#56）、`reminder`（云端提醒编号，逗号分隔，如 `r-8f2a,r-91c3`，#56）、`article`（关联文章路径）。未知的 `key=value` 会原样保留；含空格的值写成 `src="QQ 邮箱"`（`loc` 已经 percent-encode，不再加引号）。已有的 Beer 字段保持原顺序，只替换值；新出现的字段按 `id src loc remind reminder article` 追加在注释块末尾，整块仍在 Tasks 字段前面。

**`%%beer ...%%` 的位置**：必须放在 Tasks 字段（📅 ⏳ 🔁 ⏱ ✅）**前面**。Tasks 插件从行尾往前认字段，Beer 注释放在中间会挡住它；反过来，`%%...%%` 是 Obsidian 自己的注释语法，阅读视图 / 实时预览里不显示，源码模式可见。**真机确认情况**：2026-11-12 在 Windows 开发机上实现，没有安装 Obsidian，未在手机 / 桌面 Obsidian 里实测阅读视图和 Tasks 渲染；验收时需要在真机 Obsidian 里打开 `日程.md` 确认注释不显示、Tasks 仍能识别截止日和勾选框。如果 Tasks 实测会受影响，先改 `schedule.js` 的 `newItemContent` / `serializeItem` 和本段说明。

### 快速添加（#50）

「日程与待办」卡片顶部的输入框：输入一句话按回车，直接写进 `日程.md`，来源记为「快速添加」；旁边「在对话里说」把当前输入放进右侧对话草稿（不自动发送，宿主没有草稿接口时退回剪贴板），不做任何 AI 调用。

- **日期短语**（都按 `ctx.now()` 的本机时区算）：
  - `今天` / `明天` / `后天`；
  - `周一`～`周日`（也认 `星期X` / `礼拜X`）：下一个 X，含今天；
  - `本周X` / `这周X`：本周的 X（周一为一周开始，即使那天已经过去也按字面写）；
  - `下周X`：下周的 X；
  - `YYYY-MM-DD`、`YYYY年M月D日`、`M月D日`、`MM-DD`。没写年份且今年这一天已经过去时，按明年同一天算（12 月写「01-05」是明年）。
  - 日期短语后面的「前 / 之前 / 以前」会一起识别并去掉（「周五前」）。
- **时刻**：`HH:mm`（也认全角冒号）。有时刻的条目按事件写（`kind: 'event'`），日期是截止日。只写时刻、没写日期时按今天算。
- **预估时长**（#54）：`约 6 小时` / `6 小时` / `90 分钟` / `1.5h` / `30m` / `1h30m` / `2 小时 30 分钟`。识别后写成规范化的 `6h` / `90m` / `1.5h` / `30m` / `1h30m` / `2h30m`，标题里去掉这段短语。没提日期时进「没排期」。分钟数统一由 `schedule.js` 的 `parseDuration` 解释，快速添加、AI 工具和待确认卡片不再各写一套单位正则。
- **计划日**（#54）：`计划明天写讲解稿` / `排到周五录制` 里的日期写成 `⏳`（计划日），不是 `📅`。
- **标题**：去掉识别出的日期 / 时刻 / 时长短语和两端的标点，剩下的就是标题。日期短语放在句中、句尾都可以；去掉后没有标题的句子（如只输入「明天」「约 6 小时」）回 400，不保存。
- **没提日期**：照样存成一条没有截止日 / 计划日的待办，出现在「没排期」分组，左边写预估时长，右边有「排到…」。
- **解析器**：`schedule.js` 导出的 `parseQuickAdd(text, now)` 只做识别，返回 `{ title, due, scheduled, time, endTime, duration, source, matched }`，再交给和 `POST /schedule/items` 相同的校验 / 写入。`now` 是**必填**的 `Date`（调用方一律传 `ctx.now()`，没有墙上时钟兜底；漏传会抛 `TypeError`）。`matched` 里记识别到的日期 / 时刻 / 时长原文；日期 / 时刻识别集中在函数顶部的正则表里，时长短语识别后交给 `parseDuration`。

### 解析与写回

- `src/modules/schedule.js` 的 `parseItem` / `parseSchedule` 是唯一解析入口。一条事项的记录形状（后续工单直接加字段，不重写解析）：

  ```
  { id, title, done, completedAt, due, scheduled, time, endTime, duration, durationMinutes,
    tags, source, location, recurrence, remind, reminderIds, reminderId, articlePath, parentId, indent, lineIndex,
    raw, rawLines, unknownLines, subtasks, beerFields, fields, timeSeparator, explicitEnd }
  ```

  `fields` 保留 Tasks 字段的原始顺序和原文（包括 Tasks 的优先级 `⏫` 等 Beer 不认识的字段），写回时只改 Beer 认识的字段；`beerFields` 同理。没有 `%%beer id%%` 的手动行会得到一个 `auto-<行内容哈希>` 临时 id，只在这一行内容不变时稳定。
- 读不懂的行（不是 `- [ ]` / `- [x]` 的标题、说明、空行）原样留在文件里。勾选只替换目标那一行；删除只移除目标行和紧跟其后、缩进更深的所有行（子步骤、说明都算），遇到空行或缩进不更深的行为止。子步骤的说明行同样保留；加子步骤插在父事项缩进块的最后。
- 子步骤自动完成父事项：只有 `POST /schedule/items/complete`（或走同一个 `completeItem` 的 AI 工具 `beer_schedule_complete`）完成某一步、且父事项的所有子步骤都已完成时，才把父事项改成 `- [x]` 并写 ✅；读取文件时不会自动补（在 Obsidian 里手勾的不算）。逐层向上，最深一层先完成。
- 写入一律走 `library.saveNote`（带 `baseVersion`），**不用 `writeNote`**。版本对不上时重新读当前文件，按 `id` 找到最新那一行再应用勾选 / 删除，然后用最新版本保存；连续 3 次都被别的写入抢先才回 409 `schedule_merge_conflict`。目标行在 Obsidian 里被删掉 / 改掉 id 时也回 409，不按猜测的行号误删别的条目。
- 供后续工单复用的导出：`parseSchedule`、`parseItem`、`serializeItem`、`newItemContent`、`newItemLines`、`parseQuickAdd(text, now)`（`now` 必填，传 `ctx.now()`）、`mergeIntoLatest(ctx, baseVersion, mutate, { action, createIfMissing })`、`loadSchedule(ctx)`、`scheduleSummary(ctx)`、`createItem(ctx, body)`、`updateItem(ctx, id, changes)`、`deleteItem(ctx, id, baseVersion, { requireVersion })`、`completeItem(ctx, id, done, baseVersion, { requireVersion })`、`normalizeNewItem(ctx, body)`、`applyItemChanges(current, changes)`、`calendarMonth(items, year, month, today)`、`SCHEDULE_PATH`；时长相关：`parseDuration(value)`（唯一解析器，返回 `{ hours, minutes, totalMinutes, hasHours }`）、`durationMinutesOf(value)`、`humanMinutes(minutes)`；重复规则相关：`parseRecurrence(text)`、`nextOccurrence(rule, 'YYYY-MM-DD')`、`recurrenceLabel(rule)`；提醒相关：`reminderFieldsChanged(changes)`。`schedule-shared.js` 另导出 `WEEKDAY_NAMES`、`WEEKDAY_SHORT`、`GROUP_LABELS`、`flattenItems`，三个日程模块共用。`mergeIntoLatest` 就是「重新读 → 在当前行数组上修改 → 用当前版本保存」的有界重试，AI 工具（#53）和提醒同步（#56）都走它；`createIfMissing: true` 时文件不存在也能建出第一条（快速添加 / 建日程用）。`applyItemChanges` 让 AI 工具的「复述」和真正写入共用同一套字段校验（含 `remind` / `reminderIds` / `subtasks` / 计划日 / 预估时长）；`updateItem` 里 `changes.subtasks` 会整体替换子步骤行并保留父事项下面的说明行。
- 完成一条事项的顺序固定为：**写完成状态 → 生成重复事项的下一条 → 判断父事项自动完成**。生成的重复下一条插在目标整个缩进块之后（有子步骤时不插到父子中间），并且还没进本次解析树，所以不会挡住父事项的自动完成，也不会误触发别的父项。生成的下一条不复制 `remind` / `reminder`，要提醒需在面板里重新设置（#56 的已知限制）。这个顺序只实现一次：HTTP 勾选和 AI 工具 `beer_schedule_complete` 都调用 `completeItem`，接口回 `autoCompleted` 和 `generated`；AI 工具不再自己拼 `- [x]`。完成已经是完成状态的事项是安全空操作（不写文件、不重复生成下一条）。

### 重复事项（#51）

`🔁` 后只支持下面三种规则；其他写法（如 `every 2 weeks on Monday`）原样保留在文件里，视为不支持，完成时不生成下一条。新建时中文写法会先转成 Tasks 英文写法再写进文件。`GET /schedule` 的每条事项带 `recurrence`（文件里的原文）和 `recurrenceLabel`（中文小标签），客户端直接用后者。

| 规则 | 列表标签 | 下一条的日期 |
| --- | --- | --- |
| `every day`（新建时也接受 `每天`） | `↻ 每天` | 参考日期 + 1 天 |
| `every week on Sunday`（英文星期名 `Monday`…`Sunday`；新建时也接受 `每周日` / `每周天` / `周日` / `星期二`） | `↻ 每周日` | 参考日期之后的第一个该星期几；参考日正好是那天时 +7 天 |
| `every month on the 15th`（也接受 `every month on 15`；新建时也接受 `每月 15 日` / `每月15号`） | `↻ 每月 15 日` | 之后的第一个该日；短月夹到当月最后一天 |
| `every month on the last`（新建时也接受 `每月最后一天`） | `↻ 每月最后一天` | 之后那个月的最后一天 |

完成重复事项时（只由 Beer 的勾选触发；在 Obsidian 里手动勾选不会由 Beer 模拟）：

1. 原来那一行保留 `- [x]` 和 `✅ <完成当天>`；
2. 紧跟其后追加一条未完成的新事项：新 `id`，保留标题、时刻 / 时间段、标签、预估时长、来源、关联文章和未知 Beer 字段；**不复制提醒偏好 `remind` 和提醒编号 `reminder`**（#56 暂不为生成的下一条建提醒，要提醒需在面板里再设——已知限制）；
3. 参考日期取 `📅` 到期日，没有就取 `⏳` 计划日；到期日按规则推进。同时有 `⏳` 时，计划日按与到期日相同的天数差平移（和 Tasks 保持相对距离的算法一致）；只有 `⏳` 时以计划日为参考，只推进计划日；
4. 没有 `📅` / `⏳` 的重复事项无法确定下一次日期，只完成、不生成；
5. 取消勾选只去掉 ✅，已经生成的下一条不会删除。

**月度规则（2026-11-13 定）**：短月按「夹到当月最后一天」处理，不跳过整月。例如 `every month on the 31st`：1 月 31 日 → 2 月 28 日（闰年 2 月 29 日）→ 3 月 31 日；下一条仍按规则里的 31 日算，不会退化成 28 日。`every month on the last` 总是取当月最后一天。Tasks 插件对 `every month on the 31st` 会跳过没有 31 日的月份；这里选择了夹到月末，避免一个月没有下一条。
### 分组、时间标签和汇总

- 未完成事项按 **已逾期 / 今天 / 本周 / 以后 / 没排期** 分组；「以后」在面板上默认收起，「没排期」在列表最下面、默认展开。「本周」从本周一到周日（本机时区）。
- 有 `⏳` 计划日时按计划日分组；计划日过了没做完仍留在「今天」，**不算逾期、不标红**。只有 `📅` 截止日过了才算逾期。同时有计划日和截止日时按计划日分组，截止日过了照常算逾期；`deadline: { label, overdue }` 单独给出截止标签（面板显示在标题下面）。
- 子步骤自己有 `⏳` / `📅` 时作为独立条目进对应分组（`parentTitle` / `stepIndex` / `stepCount` 用来显示「属于 X 第 N 步」）；没排期的子步骤只在父事项下面显示。
- 「没排期」组：`totalMinutes` 只累加顶层事项的预估时长，顶层没写时退回子步骤合计（避免父子重复相加）；`subtitle` 是「想做、但没定哪天 · 共约 N 小时」。
- 有具体时刻的是 `kind: 'event'`：过了结束时间 `past: true` / `gray: true`，沉到本组下面，不算逾期、面板不显示勾选框。只写开始时刻时按预估时长或默认 1 小时算结束；开始前 2 小时内给 `startsInMinutes`（面板显示「还有 N 分钟」）。
- 左边时间标签由服务端算好放在 `when: { kind, label, overdue }`：时刻写 `14:00`；只有截止日写 `今天截止` / `周五截止`，超过本周写 `11月20日截止`；逾期写 `昨天截止`（更早写 `11月5日截止`）；计划日写 `计划今天` / `计划周五`；没日期有预估写 `约 6 小时`。
- `summary` 的数字：`today` 是今天组里未完成的条目数（含今天已过去的事件和排到今天的子步骤），`overdue` 是截止日过期且不是事件、未完成的数量，`dueThisWeek` 是截止日在今天之后、本周日之前的未完成数量，`unscheduled` 是没排期的顶层事项数量。首页顶部汇总句用这四个数（`GET /home` 的 `schedule.summary`），「等你处理」的数字不变。
- `items` 只含顶层事项；`entries` 是分组 / 全部视图用的平铺列表（顶层 + 排了日期的子步骤）。已完成事项只在 `done` 列表 / 面板的「已完成」视图出现，不进分组和汇总。

### 月历（#52）

首页右栏的「小月历」在「等你处理」上面；#55 的「识别到日程」出现时，月历在它下面。卡片是 `CalendarCard`，只读 `GET /schedule` 的 `calendar`，不自己解析 `日程.md`，和左侧列表用同一份事项。

- 网格由服务端纯函数 `schedule.calendarMonth(items, year, month, today)` 算：**周一开头**、7 列，默认当月，`‹ ›` 翻月（`GET /schedule?month=YYYY-MM`）。前后月补位的日期也显示，但 `inMonth: false`、颜色变淡。
- 每天三个标记，**各标记只看它自己的日期**，不再把一个事项的所有标记堆到同一天；全部来自同一批未完成事项（子步骤递归计入，已完成的不算）：
  - `event: true`：这天是带具体时刻事项的事件 / 计划日（`date = scheduled ?? due`）→ 橘点。对应 `日程.md` 里的 `14:00` / `14:00–15:00`。
  - `due: true`：这天是**任一**事项的截止日（`📅`）→ 黄点。即使它同时有具体时刻、或另有一个更早的计划日，截止日照样画黄点；只有计划日（`⏳`）、没有截止日的事项不画黄点。
  - `overdue: true`：这天是截止日、已过且还没完成 → 日期数字标红。有具体时刻的事过了时间只是变灰，不标红，和左侧列表口径一致。
  - 例：「周五截止、计划周三」只在周五有黄点，周三不画点；带 `14:00` 且周五截止的事项在周五同时有橘点和黄点。
- 今天用强调色圈出来；同一格里可以同时有橘点和黄点（一天里既有会议又有截止事项）。
- 点某天：`HomeView` 的 `selectedDate` 同时传给月历和左侧列表。`ScheduleCard` 切回「按时间」视图，如果当天的事项在「以后」组就展开它，高亮所有匹配事项并滚到第一条；匹配条件是该事项的事件 / 计划日、**截止日**，或任一步骤的日期（同时有计划日和截止日的事项点两天都能命中）。卡片顶部显示「跳到 11 月 13 日 ✕」，再点同一天或点这个标签清除。点到前后月补位的日期会顺手翻到那个月。
- 勾选 / 删除后 `ScheduleCard` 通过 `onChanged` 让月历重新取一次当月数据，点和红字会跟着变。
- 测试在 `test/schedule-calendar.test.js`：周一开头 / 前后月补位 / 闰年、橘点黄点、逾期红字（含子步骤）、同一天两种点、不修改输入，以及 `GET /schedule?month=` 的接线；`test/schedule-review-fixes.test.js` 另覆盖「周五截止、计划周三」、有时刻 + 截止、逾期落在截止日，以及 `date` / `due` 两个点击匹配字段。

### 面板

「日程与待办」卡片是独立组件 `ScheduleCard`（`client/beer-client.js`），只依赖 `GET /schedule` 和几个写接口，方便 #47 的两栏首页把它放进左栏。顶部有 `按时间 / 全部 / 已完成` 切换（「全部」是未完成的平铺列表）和一行快速添加（回车保存，「在对话里说」放进草稿），「以后」默认收起、「没排期」默认展开；每条显示时间、标题、标签、来源、关联文章链接、重复规则小标签（`↻ 每天` / `↻ 每周日` / `↻ 每月 15 日`，未知规则显示原文）、邮件提醒小标签（有提醒时写 `✉ 13:30 邮件提醒` / `✉ 提前 30 分钟`，云端没建成写 `✉ 提醒没建成`，`remind=off` 不显示）和截止日标签（同时有计划日 / 截止日时）；非事件可勾选，每条可删除（确认后调删除接口）。事件不显示勾选框，时刻栏写时段（`14:00–15:00`），不是今天的再在上面小字写哪天（本周写星期，其余写几月几日；接口里是 `when.day` / `when.time`，`when.label` 是两者拼起来）；有地点时多一个「地点 …」小标签（`%%beer loc=%%` 在 Obsidian 里看不到，Beer 里要能看到会议号 / 地址）；过了结束时间变灰并写「已结束」；`startsInMinutes` 显示「还有 N 分钟」。添加成功后卡片重新读 `GET /schedule`，并刷新首页顶部的日程汇总。有小月历选中的日期时，顶部多一个跳转标签，匹配的事项用强调底色标出，并在数据就绪后滚到第一条。

没排期 / 子步骤 / 排到… 的细节（#54）：
- 在「没排期」组名旁显示「想做、但没定哪天 · 共约 N 小时」，每条左边写「约 N 小时」，右边「排到…」打开今天 / 明天 / 这周某天的菜单；已排期的显示「改期…」，菜单里有「取消排期」。
- 父事项下面列出子步骤（勾选框、预估时长、已排到哪天、单独的「排到…」），标题下显示 `0 / 3 步`；排了日期的子步骤另外出现在对应分组，标题后注明「属于 <父事项> 第 N 步」。
- 同时有计划日和截止日的条目标题下面显示截止日标签（过期标红）。计划日过了的只显示 `计划…`，不标红。
- 顶部汇总句固定带上「N 件没排期」。

## 日程 AI 工具（#53、#54）

DSH Desktop 对话里的 AI 可以直接建 / 查 / 改 / 完成 / 删除日程，写的就是库根目录的 `日程.md`。`src/index.js` 用 `ctx.inject(['tools'], ...)` 注册（和转录、提醒工具一样），`@deepseek-ai/dsh-tools` 由宿主提供、用动态 `import()` 拿，**不写进 `package.json`**；执行逻辑在 `src/modules/schedule-tools.js`。

| 工具 | 参数 | 说明 |
|---|---|---|
| `beer_schedule_create` | `items`（数组，每条 `title` 必填；`due` / `scheduled` / `time` / `endTime` / `duration` / `tags` / `source` / `location` / `recurrence` / `remind` / `reminderId` / `articlePath` / `subtasks` 可选）、`confirmToken` | 一次可以建多条（一封邮件里有几轮面试就放几条）。`due` / `scheduled` 用 `YYYY-MM-DD`，`time` / `endTime` 用 `HH:mm`；`source` 默认「对话」。面试 / 会议这类有具体时刻的事把当天日期放 `due`，地点写进 `location`（会写进 `%%beer loc=%%`，也显示在待确认卡片上；会议号仍可写进 `title`），类别放 `tags`（如 `["面试"]`）。有具体时刻时默认同时建邮件提醒；`remind` 可写 `30m`（提前 30 分钟）或 `off`（不提醒）。`subtasks` 是 `[{ title, duration?, scheduled?, due?, time?, endTime?, tags?, source?, location? }]`，用来把一件事拆成几步，每步可以有预估时长和计划日（#54）；复述时每一步会带自己的预估，如「写讲解稿（约 2 小时）」 |
| `beer_schedule_list` | `group`（`all` 默认 / `overdue` / `today` / `week` / `later` / `unscheduled` / `done`） | 列出日期、星期、时刻、标签、来源和编号；改、完成、删除之前用它拿编号。子步骤排在父事项下面 |
| `beer_schedule_update` | `id`（必填）、`changes`（只放要改的字段，字段同 create，含 `subtasks`）、`confirmToken` | 先复述「原来是 / 改成」，确认后按编号找到最新那一行再改；改时间 / 标题 / 提醒偏好时同步取消并重建云端提醒；旧提醒 DELETE 失败时保留旧编号、不建新提醒，结果里说明「提醒没改成」，下次修改再试。`changes.subtasks` 给出完整的新步骤列表（整体替换原来的子步骤行，父事项下面的说明行保留），`duration` / `scheduled` 可以同时改（#54） |
| `beer_schedule_complete` | `id`（必填）、`done`（默认 `true`；`false` 取消完成）、`confirmToken` | 走和 HTTP `POST /schedule/items/complete` 相同的 `completeItem`：完成写 `- [x]` 和 ✅ 当天日期；重复事项完成后生成下一条（结果里 `generated`）；子步骤全部完成时父事项自动完成（结果里 `autoCompleted`）。已经处于目标状态时是安全空操作（`alreadyDone: true`，不写文件、不重复生成下一条） |
| `beer_schedule_delete` | `id`（必填）、`confirmToken` | 删除这条和它的子步骤；确认后不能恢复 |

- **必须复述确认**：建、改、完成、删除都分两步，和邮件提醒（#44）一样无状态。第一次不带 `confirmToken` 调用，只做校验并返回复述文本（具体日期 + 星期 + 时刻，例如 `11 月 20 日（周五）10:00–11:00 —— 某公司终面`）和确认码，**不写 `日程.md`**；用户确认后带同一个确认码再调用才真正执行。
- 确认码是 `sha256(kind + '\n' + 规范化 JSON)` 的前 12 位，覆盖这次要改的全部内容（日期、时刻、标题、标签、来源、子步骤等）。内容改了确认码就对不上，回 409 `confirm_mismatch`，必须重新复述。`changes.subtasks` 里每步的 id 由「父事项 id + 序号 + 标题」算出来，复述和执行两次调用得到同一个确认码。
- 改、完成、删除执行时都会重新读一遍 `日程.md`，用 `mergeIntoLatest` 按 `id` 找到最新那一行再改，所以确认前后用户在 Obsidian 里的修改不会被整文件覆盖；目标行已经不在时回 409 `schedule_merge_conflict`，不误删别的行。
- 面试邮件由对话里的模型解析成结构化条目（一轮面试一条），工具只负责校验、复述和写入；第一版不做 IMAP 自动读取（另开 issue，不在 #53 里）。来源默认「对话」。
- 复述（建 / 改）里的时间、地点、提醒、子步骤预估都来自同一份规范化数据：地点写成「地点 …」，提醒用 `schedule-reminders.js` 的 `remindSummary`，子步骤写成「写讲解稿（约 2 小时）」；父事项自己的 `duration` 也保留在括号里。
- 时长参数统一用 `schedule.js` 的 `parseDuration` 解析：`6h` / `6 小时` / `90 分钟` / `1h30m` / `2 小时 30 分钟` 都接受，AI 工具不再只认 `h/m`。
- 宿主的 `defineTool` 要求参数里嵌套的对象（`items` 数组的元素、`changes`）明确写 `additionalProperties: false`，必填字段用逐属性的 `required: true`；每个工具都有 `output.schema` + `render`。五个工具各自注册，一个被宿主拒绝不连累另外四个，错误打到宿主日志（`[beer] 注册工具 … 失败`）。

### 待确认状态（供 #55「识别到日程」卡片）

建日程的第一次调用（预览）会把这次识别结果写进 Beer 数据目录的 `schedule-pending.json`（`ctx.state` 键 `schedule-pending`），首页「识别到日程」卡片（#55）读它来显示、接受或忽略。状态是跨库共享的，所以每条都带 `vault`，卡片只显示当前库的条目：

```json
{
  "entries": [
    {
      "id": "sp-1a2b3c4d",
      "items": [
        {
          "title": "某公司终面",
          "due": "2026-11-20",
          "time": "10:00",
          "endTime": "11:00",
          "tags": ["面试"],
          "source": "对话",
          "location": "上海市浦东新区张江 1 号楼（3 层会议室）",
          "remind": "default"
        }
      ],
      "source": "对话",
      "createdAt": "2026-11-12T02:00:00.000Z",
      "vault": "/Users/me/Obsidian/主库"
    }
  ]
}
```

- `items` 是 `beer_schedule_create` 所需的同一套字段（`publicItem` 之后的形状，含 `location`），卡片接受时原样交给创建流程；`source` 是这批识别的来源，`createdAt` 是 ISO 时间。`GET /schedule/pending` 返回时会给每个 item 现算 `reminderLabel`（不写进状态文件，避免过夜后过期）和 `durationMinutes`。
- 同一批内容重复预览会更新原条目，不堆重复；执行成功后自动清掉对应条目。用户点「改一下」时客户端会先调 dismiss 移除旧条目，所以旧版本之后不能被接受。
- `src/modules/schedule-tools.js` 导出 `listPendingSchedules(ctx)`（只返回当前库的条目）、`removePendingSchedule(ctx, id)`（只移除状态，返回 `{ removed, entry? }`）和 `acceptPendingSchedule(ctx, id)`（整批写进 `日程.md` 再移除）；HTTP 接口由同文件的 `registerPendingScheduleRoutes` 注册。条目里的 `source` 是自由字符串，以后 QQ 邮箱 IMAP 识别（另开 issue）只需要写入 `QQ 邮箱`，卡片和接受流程不用改。

### 识别到日程卡片（#55）

首页右栏最上面是「识别到日程」卡片，显示对话里解析出来、还没确认的日程。数据只来自 `GET /schedule/pending`，组件 `PendingScheduleCard`（`client/beer-client.js`）自己轮询（25 秒一次，卸载时清掉定时器，乱序返回只认最后一次），所以对话里刚解析出的日程不用手动刷新首页就会出现。

- 一条识别结果里有几条日程就一条条往下排，每条写时间、地点、提醒和来源（现在「对话」，`QQ 邮箱` 原样显示）：
  - 时间：同时有计划日和截止日时**两个都写**（`计划 11 月 14 日，11 月 20 日 截止`），不会因为有时刻就把截止日藏掉；只有截止日写「… 截止」，只有计划日写「计划 …」。
  - 地点：只读服务端写进条目的顶层 `location`（来自 `%%beer loc=%%`），有才显示「地点 …」。
  - 提醒：直接用服务端算好的 `reminderLabel`，不再由客户端硬编码。`remind=default` 显示下一封默认提醒的时刻（如 `✉ 21:30 邮件提醒`，默认是前一天 21:30 + 开始前 1 小时）；`30m` 显示 `✉ 提前 30 分钟（13:30）`；`off`、没有具体时刻或提醒时间已过时不显示。
- 「加入日程」调 `POST /schedule/pending/accept`：整批写进 `日程.md`，卡片里这条立刻消失，左栏「日程与待办」和顶部汇总同时刷新。连点两次只有第一次成功，第二次 404，不会重复写。
- 「改一下」先调 `POST /schedule/pending/dismiss` 把这条识别结果从待确认状态移除，再把复述文本放进宿主对话草稿（复用 `attachToConversation`，和素材 / 选题的「和 AI 讨论」一样），**不自动发送**；这样旧版本之后不能再被「加入日程」，只能接受 AI 改完后的新复述。dismiss 失败时不放草稿，避免旧版本继续存在；没有可用对话时退回剪贴板。
- 「忽略」调 `POST /schedule/pending/dismiss`：只删待确认状态，不写 `日程.md`。
- 右上角 ✕ 只把**当前显示的条目编号**记进这次页面会话的隐藏列表，不删服务端状态；之后新识别出的条目照常出现，刷新页面后所有待确认结果会重新出现。没有待确认结果时整块不显示。
- 插入位置固定为右栏第一张卡；#52 小月历、#48「等你处理」都排在它下面。卡片样式用 `beer-found-*`，颜色沿用 `beer-*` 的 accent / paper token。

## 日程邮件提醒（#56）

日程接上 #44 的云端提醒服务（`cloud/reminder/`）：有具体时刻的事项可以设邮件提醒，建、改、删日程时同步建、改、取消对应提醒。执行逻辑在 `src/modules/schedule-reminders.js`，云端调用复用 `reminders.js` 的 `reminderJson`（`ctx.fetch` + 钥匙串里的 `reminder-api-key` + `ctx.config.reminderApiBase`）。

### 提醒偏好

| `%%beer remind=` | 含义 |
|---|---|
| `default` | 有具体时刻的事项默认：**前一天 21:30** + **开始前 1 小时**（#44 定的）。已经过去的那封跳过 |
| `30m` | 用户说「提前 N 分钟」：只建一封，开始前 N 分钟；也接受 `60m` 等 |
| `off` | 不提醒 |

- 新建有具体时刻的日程（`time` / `endTime`）默认写 `remind=default`；没有时刻的待办不写提醒偏好、不建提醒。用户明确说「不提醒」时写 `remind=off`。
- 云端提醒编号写在同一个 `%%beer ...%%` 里的 `reminder=`，逗号分隔（如 `reminder=r-8f2a,r-91c3`）。Beer 认识的字段按 `id src loc remind reminder article` 顺序排，未知字段原样保留，整个块仍然在 Tasks 字段前面。
- 创建提醒时 POST body 带 `ref=<日程 id>`，云端能按日程反查；标题用日程标题，正文写具体时间（含星期和结束时刻），有地点时另起一行写「地点：…」。改标题 / 日期 / 时刻 / 地点 / 提醒偏好都会重建提醒。
- 时间按日程的本机墙钟理解，交给云端时写成 `+08:00`（和 #44 的北京时间一致）。

### 同步语义

- **建日程**：先把日程写进 `日程.md`，再按偏好 POST 云端提醒；返回的编号用 `mergeIntoLatest` 按 id 合并写回那一行（写回期间 Obsidian 的修改不会被覆盖）。
- **改日程**：云端没有 PATCH / 修改接口。日程先把改后的标题 / 时间 / 偏好写进文件，但**旧提醒编号先留在文件里**；然后 DELETE 旧提醒，全部删成功（404 / 409 算已处理）才清掉 / 替换编号并按新时间 / 偏好 POST 新提醒，最后把新编号写回。旧提醒有一封删失败（不是 404 / 409）时：保留旧编号、**不 POST 新提醒**，回 `reminderError: '提醒没改成：…'`，用户下次修改会再次尝试取消。改标题也会重建提醒（邮件标题跟着变）。
- **删日程**：日程先删成功，再 DELETE 所有旧提醒编号。
- **409 容错**：DELETE 已经发出去 / 发失败的提醒时云端回 409，说明它已经不用管了，不算失败，继续后面的操作；404（已经不在了）同样放过。
- **失败不排队、不回滚**：日程保存成功后云端失败，接口 / 工具结果带 `reminderError`（「提醒没建成」/「提醒没改成」/「提醒没取消」+ 原因），不写重试队列、以后也不会自动补建；面板在那条日程的小标签上显示 `✉ 提醒没建成`。改日程时旧提醒没删掉：旧编号留在 `%%beer reminder=%%` 里，不建新提醒，避免「旧提醒还在、新编号又没写回」；用户再改一次会先重试删除。删日程取消失败同样只回错误，不回滚。

### 列表小标签

`GET /schedule` 每条事项返回 `remind`、`reminderIds`、`reminderLabel` 和 `reminderError`：

- `default`：显示下一次提醒时刻，如 `21:30 邮件提醒`（面板加 `✉ ` 前缀）。
- `30m`：显示 `提前 30 分钟`。
- `off`：不显示。
- 有偏好但没有云端编号（或编号数量少于该建的封数）：`reminderError: '提醒没建成'`，小标签显示 `✉ 提醒没建成`；没有 `remind` 字段的手动旧行不会误报。
- 待确认卡片（#55）复用同一套计算：`schedule-reminders.pendingReminderLabel(item, now)` 给 `GET /schedule/pending` 的每个 item 现算 `reminderLabel`（default = 下一封默认提醒时刻，30m = `提前 30 分钟（HH:mm）`，off = `null`），客户端只渲染。

## 搜索（#8）

`GET /api/beer/search` 每次请求直接扫库，不建持久索引（中文按子串匹配，库里的改动下一次搜索就生效）。

- 查询串按空白切开：`#标签` 匹配 frontmatter 的 `标签:` / `tags:` 列表或正文里的 `#标签`；`状态:成稿`、`类型:链接` 匹配 frontmatter 字段（也认 `status:` / `type:`）；其余词按 AND 子串匹配，大小写不敏感。
- 一个文件最多一条命中。标题看文件名（`index.md` / `transcript.md` 看条目文件夹名）和正文第一个 `# ` 标题；正文、标签、状态、类型也参与。`matchedIn` 给出 `title` / `body` / `tags` / `status` / `type`，`snippet` 是命中附近的一段（只命中 frontmatter 时写成「标签：… · 状态：…」），`highlights` 是片段里的 UTF-16 区间。
- 默认跳过 `.trash`（以及 `.obsidian` 等隐藏目录）；`includeTrash=1` 时把 `.trash` 也搜进来，结果归到回收站分页。
- 分页归属用 `panel.js` 导出的 `listTabs(ctx)`（8 个固定分页 + 自定义分页）的 `folder` 做最长前缀匹配；`内容库/素材`、`内容库/文章` 这种多个分页共用一个文件夹时按条目类型偏向对应分页（文字稿 → 录音、素材条目 → 素材、文章 → 文章）。不属于任何分页的文件归到首页。
- `scope=<tabId>` 只搜该分页绑定的文件夹（此时忽略 `includeTrash`，`scope=trash` 直接搜回收站）；分页编号不认识 → 400 `scope_invalid`。
- `transcript.md` 里带时间点的行（`[00:12]`、`00:12`、`00:12:34`，可带 `- ` / `>` / `**`）解析成秒数放进 `playAt`；命中的是续行时沿用往上最近一个时间点。播放见「录音播放与缓存（#21）」。
- 空查询回 200 空结果；没选库仍按库访问规则回 409。

面板：顶栏搜索框 `⌘K`（Windows / Linux `Ctrl+K`）聚焦、回车打开浮层搜索；`↑↓` 选择、`↵` 切到所属分页并打开、`Esc` 关闭；结果按分页分组并高亮命中处，可勾选「包括回收站」。文字稿命中显示 `▶ mm:ss` 时间点，点一下切到录音分页从那一句开始播放。「附到对话」把路径和片段放进宿主对话草稿（宿主没开放草稿接口时复制到剪贴板并提示）；「让 AI 在库里找」把问题放进对话草稿。笔记样式和条目列表样式的分页内容区顶部都有只搜本页的小输入框（`scope=当前分页`），清空恢复原列表；回收站里的命中会切到回收站分页并只读预览那一份文件。

## opencode go 限额接口（#9）

顶栏的「Go 限额 5h · 周 · 月」由 `GET /api/beer/quota` 提供，Beer 服务端用钥匙串里的 `opencode-go-api-key` 向 opencode go 服务器查询，不做本地估算。

**接口来源**：opencode go 没有公开文档化的用量接口（官方文档只说「在 Console 查看用量」；功能请求 anomalyco/opencode#16017 已关闭）。查询方式取自参考插件 [emmmdty/opencode-usage](https://github.com/emmmdty/opencode-usage)，读的是 `e3f7a27`（2026-09-16）的 `internal/client/opencode.go`、`internal/provider/opencode.go`、`internal/models/usage.go`（2026-11-06 复核）：

- 请求：`GET {opencodeGoBase}/zen/go/v1/usage`（`opencodeGoBase` 默认 `https://opencode.ai`），头 `Authorization: Bearer <API key>`，插件超时 10 秒（Beer 相同）。
- 响应（插件注释称 2026-09-16 对线上核实过）：
  ```json
  {"usage": {
    "rolling": {"status": "ok", "percent": 37, "resetsAt": "2026-11-05T15:00:00Z"},
    "weekly":  {"status": "ok", "percent": 12, "resetsAt": "..."},
    "monthly": {"status": "rate-limited", "percent": 100, "resetsAt": "..."}
  }}
  ```
  `rolling` 是 5 小时窗口；`percent` 是已用百分比（整数）；`resetsAt` 为 RFC 3339。`status` 见过 `ok`、`idle`、`rate-limited`（用完）。
- 不带 key 请求返回 `401 {"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`（2026-11-05、2026-11-06 实测，说明端点在线）。**带真实 key 的响应没有实测过**。
- 另一个参考 slkiser/opencode-quota 用工作区 ID + 浏览器 cookie，不用。

**Beer 的处理**：`state` 归一为 `ok` / `idle` / `exhausted`（来自 `rate-limited`）/ `unknown`（不认识的值，不当成正常）；没有 `resetsAt` 时为 `null`。插件对 429/5xx 会重试 3 次，Beer 不重试，面板每 5 分钟刷新一次、点一下立即重查。失败时返回 `{ error: { code, message } }`，面板顶栏显示红色「Go 限额 查询失败」，悬停看原因：

| 情况 | 状态码 | `code` |
|---|---|---|
| 钥匙串里没有 `opencode-go-api-key` | 503 | `quota_no_key` |
| 读钥匙串出错（如已锁定） | 503 | `quota_keychain_error` |
| opencode go 回 401 / 403（key 无效） | 502 | `quota_unauthorized` |
| 连不上 / 超时 | 502 | `quota_unreachable` |
| 回其他非 2xx（如 429、5xx） | 502 | `quota_upstream_error` |
| 响应不是上面的结构（接口可能改了） | 502 | `quota_bad_response` |

这是非官方接口，可能变动；变了会落到 `quota_bad_response` / `quota_upstream_error`，而不是显示错的数字。

## 配置项与密钥

配置项（Schemastery，见 `src/config.js`）：`root`（数据目录，patch 里给 `dshHomePath('beer')`）、`homeApiBase`（家里 Mac mini 地址，默认 `http://mac-mini:8787`，按实际 Tailscale 地址改）、`reminderApiBase`（云端提醒服务地址，默认 `https://remind.example.com`）、`opencodeGoBase`、`platformVersionModel`（生成平台版本的模型，默认 `deepseek-v4.1-flash`）、`rinApiBase`、`keychainService`（默认 `beer`）、`audioCacheLimitGB`（默认 5）。改配置：在 profile 的 `cordis.patch.yml` 里覆盖 `beer` 这一条的 `config`（整体替换，`root` 也要写上）。

密钥存 macOS 钥匙串，服务名 `beer`（配置项 `keychainService`）。**平时在面板顶栏齿轮打开的设置弹层里填**：逐个列出 5 个密钥的状态（已存 / 未存 / 读取出错），每个一个密码框和「保存」，输入框永远是空的、不回显已有值；保存后立即生效，不用重启（各模块每次请求现读钥匙串）。弹层里的配置项只读，改地址请改 profile 的 `cordis.patch.yml`。

保存时 Beer 运行 `security -i`，把 `add-generic-password -U -s <服务名> -a <账号名> -T /usr/bin/security -w <值>` 从标准输入送进去，参数用双引号包起来、`"` 和 `\` 前加反斜杠，密钥不出现在进程参数里（`ps` 看不到）。

| 账号名 | 用途 |
|---|---|
| `home-api-key` | Mac mini 家里服务的访问密钥 |
| `reminder-api-key` | 云端提醒服务的访问密钥（和 Worker 的 `REMINDER_TOKEN` 是同一个值） |
| `opencode-go-api-key` | opencode go（模型调用、查限额） |
| `rin-admin-username` | Rin 博客管理员账号 |
| `rin-admin-password` | Rin 博客管理员密码 |

备用：在终端里写入（Beer 没开或面板打不开时）：

```sh
security add-generic-password -U -s beer -a home-api-key        -T /usr/bin/security -w
security add-generic-password -U -s beer -a reminder-api-key    -T /usr/bin/security -w
security add-generic-password -U -s beer -a opencode-go-api-key -T /usr/bin/security -w
security add-generic-password -U -s beer -a rin-admin-username  -T /usr/bin/security -w
security add-generic-password -U -s beer -a rin-admin-password  -T /usr/bin/security -w
```

（`-w` 放最后不带值会提示输入，密码不进 shell 历史。）

Rin 博客的账号密码如果已经按 `~/rin-blog/rin-publish.py` 的习惯存过（账号 `rin`，服务名 `RIN_ADMIN_USERNAME` / `RIN_ADMIN_PASSWORD`），可以直接复制过来，不在屏幕上显示：

```sh
for pair in rin-admin-username:RIN_ADMIN_USERNAME rin-admin-password:RIN_ADMIN_PASSWORD; do
  security add-generic-password -U -s beer -a "${pair%%:*}" -T /usr/bin/security \
    -w "$(security find-generic-password -a rin -s "${pair##*:}" -w)"
done
```

## 开发与测试

```sh
cd beer
npm install        # 只装开发依赖（schemastery、CodeMirror 6、esbuild）
npm test           # node --test "test/**/*.test.js"
npm run check      # node --check 两个入口 + 测试
npm run build:editor  # 改了 editor/ 之后重新打包 client/editor.js（打包结果要一起提交）
```

### 编辑器

文章和库文件的「编辑」用 CodeMirror 6 做成类似 Obsidian「实时预览」：光标所在的行或片段显示 Markdown 原文，其他地方直接排版（标题、粗体、斜体、代码、链接、`[[双链]]`、引用、列表、待办勾选框、分隔线、开头属性块），`![](相对路径)` 和 `![[图片.png|宽度]]` 显示成图片。快捷键：⌘S 保存、⌘B 加粗、⌘I 斜体、⌘F 查找、回车自动续列表。

- 源码在 `editor/live-editor.js`，用 esbuild 打成 `client/editor.js`（ES 模块，随插件包发布）。宿主只把 `beer-client.js` 打进插件合并包，所以编辑器由 Beer 自己的接口 `GET /api/beer/client/editor.js` 提供，进入编辑时才 `import()`；加载失败会退回纯文字框。
- 粘贴或拖入图片：存到笔记旁边的 `images/`（`POST /api/beer/library/attachment?from=<笔记路径>&name=<文件名>`，单张最多 20 MB，重名自动加序号），正文里插入 `![](images/xx.png)`。不跟 Obsidian 的附件文件夹设置走，因为发布到 Rin 和打发布包都只认文章文件夹下的 `images/`。
- 图片走 `GET /api/beer/library/asset?path=<链接里的路径>&from=<笔记路径>`：先按笔记所在文件夹解析，再按库根，最后在整个库里按文件名找（文件名索引缓存 30 秒）。

测试只通过 `/api/beer/` HTTP 接口验证外部行为，面板界面不写自动测试。`test/helpers/beer.js` 提供：

- `startBeer(t, { vault, config, secrets, dataDir, now })`：建临时数据目录和临时库（`vault: { '内容库/文章/a/index.md': '...' }`；`vault: false` 表示还没选库），起真 HTTP 服务并选好库；返回 `{ api(method, path, body), vault, dataDir, restart(), close() }`。`api('GET', '/vault')` 返回 `{ status, body }`。
- `startFake(t, { 'GET /health': (req, body) => ({...}) | { status, body } })`：假外部服务（家里 API、opencode go、Rin），`requests` 记下收到的请求；把它的 `url` 通过 `config` 传给 `startBeer`。
- `deadUrl(t)`：连不上的地址，测「家里连不上」。
- `fakeSecrets({...})` / `secrets: { 'home-api-key': 'k' }`：假钥匙串。
- `makeTempDir`、`listFiles(dir)`：准备和检查库里的文件。

### 加一个模块（后续工单）

1. 写 `src/modules/<名字>.js`，导出 `register(router, ctx)`，在里面 `router.get('/<名字>/...', async req => ...)`（路径参数 `:id` → `req.params.id`，请求体 `await req.json()`，原始流 `req.req` / `req.res`）。返回值即 200 JSON；`reply(201, body)` 指定状态码；`throw new HttpError(409, 'code', '中文说明')` 回错误。要库根目录用 `resolveVault(ctx)`（`modules/vault.js`）；外部服务地址从 `ctx.config` 拿，密钥 `await ctx.secrets.get(name)`，HTTP 用 `ctx.fetch`。
2. 在 `src/modules/index.js` 的数组里登记。新配置项加到 `src/config.js`（必须有默认值），新密钥名加到 `src/secrets.js` 的 `SECRET_NAMES`。
3. 写 `test/<名字>.test.js`：`startBeer` 起服务，`startFake` 代替外部依赖，只断言接口返回、库里的文件和发给假服务的请求。

## 打包

本机没有全局 pnpm，用 DSH Desktop 自带的：

```sh
cd beer
node "/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/pnpm/bin/pnpm.cjs" pack
tar -tzf beer-workbench-0.1.0.tgz
```

核对包里有 `package/package.json`、`package/src/index.js`、`package/client/beer-client.js`、`package/cordis.patch.yml`，没有 `test/`、`node_modules/`、密钥。tgz 不能超过 8 MiB（0.1.0 约 15 KB）。`npm pack` 结果相同。

## 安装（在 DSH Desktop 里）

Claude Code 调不到安装工具，安装要在 **DSH Desktop 的 Agent** 里做：

1. 在 Desktop 里新开一个对话，让 Agent 调用：`install_local_workbench({ path: "<beer-workbench-0.1.0.tgz 的绝对路径>", replace: false })`（以后更新同一个包时 `replace: true`，并先把 `version` 升一位）。按宿主审批确认。
2. 返回 `application: "applied"` 直接去看界面；`"restart-required"` 时点顶部提示的「立即重启」或菜单「Harness → 重启 Harness」。`failed` / `cancelled` / `overridden` 都不算装上。
3. 确认加载：终端里 `dsh --profile web --dump-config` 能找到 `beer` 插件层；Desktop 工作台市场「已安装」里有带「本地」标识的 Beer；从左侧入口打开面板。

## 真实界面验收（规范第 8 节，安装后手动做）

记录 Desktop 版本、macOS 版本、架构、包版本和走过的界面路径；做不了的项写「未验证」及原因。

- [ ] 首次进入、没有工作台会话：面板直接可用，看到 8 个分页和「选择 Obsidian 库」，对话栏只显示「开始对话」，没有自动建会话。
- [ ] 选库：点「选择 Obsidian 库…」弹出宿主目录选择器；**取消**后数据目录 `~/Library/Application Support/dsh-desktop/harness/beer/` 里没有新文件、库里也没有；选定后顶栏显示路径；重启 Harness 后仍记得。把库移走后重开：提示重新选择，不自动建同名目录。
- [ ] 点「开始对话」：创建本工作台会话，原生对话出现在右侧；再次打开时恢复同一会话；从侧栏打开已关联的会话时面板正常。
- [ ] 新对话（#28）：没有对话时对话栏只有「开始对话」；有对话时头部出现「＋ 新对话」，点它换成空白的新会话，旧会话在 DSH 侧栏里还在；重开 Beer 后「开始对话」恢复的是新会话；新会话里 Beer 的 AI 工具能用。当前会话上下文约 150K token 以上时，对话栏顶部提示「对话已经很长，可以点『新对话』新开」。
- [ ] 对话栏：各分页分别记住展开 / 收起；发布页第一次进入是收起的；收起后再展开，对话里的输入草稿还在（对话节点没被卸载）。
- [ ] 侧栏展开 / 收起、窄窗口、全屏进出：顶栏不双重留白、不遮挡系统控件；分页横排不竖排、不裁切，窄时可横向滚动；面板不越出宿主主内容区、不挡左侧会话栏和市场 / 管理入口。
- [ ] 用真实长度的中英文标题和长库路径检查顶栏与分页；键盘 Tab 能到达分页按钮、「选择库」「开始对话」「收起」。
- [ ] 实际拖动顶栏空白处能移动窗口。
- [ ] 库访问（#5）：每个分页列出绑定文件夹（文章 → `内容库/文章` 等）；进子文件夹、面包屑返回；非 Markdown 文件灰显不可开；文件夹不存在时提示、不建目录。点 Markdown 先看预览（开头属性、标题、列表、引用、代码、`[[链接]]`），点「编辑」改原文，「保存 ⌘S」后预览更新，Obsidian 里看到同样内容。
- [ ] 冲突：在 Beer 里点「编辑」后，去 Obsidian 改同一文件并保存，再回 Beer 保存：出现红色冲突提示（打开时间、被改时间），Obsidian 里的内容没被覆盖，编辑框里自己的改动还在；点「取消」后预览显示 Obsidian 改过的内容。文件在 Obsidian 里被删后保存：提示「被删掉了」，不重建文件。
- [ ] 限额（#9）：钥匙串存好真实 `opencode-go-api-key` 后，顶栏显示「Go 限额 5h ·周 ·月」三个百分比，与 opencode Console 里的用量一致；悬停看到重置时间；删掉钥匙串条目或断网后点一下，显示红色「查询失败」并能看到原因；窄窗口时顶栏换行不裁切。
- [ ] 注册失败时（例如临时改坏 client 文件）工作台管理显示包名、阶段、原因；修好重载后诊断消失。
