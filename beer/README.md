# Beer（`beer-workbench`）

DSH Desktop 里的 Beer 工作台包：业务整页布局（`customFrame` + 紧凑顶栏），宿主原生对话放在右侧可收起；8 个固定分页（首页、录音、素材、选题、文章、发布、规则、回收站），分页横排末尾的「＋」可添加绑定库内文件夹的自定义分页（笔记 / 条目列表样式，可删除，固定分页不能排序、隐藏、删除）；第一次使用时用宿主目录选择器选 Obsidian 库并记住。术语见仓库根目录 `GLOSSARY.md`，布局以 `docs/layouts/v3.html` 为准。

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
| `POST /api/beer/materials/import/url` `{ url, title?, tags?, type? }` | 抓网页写素材：文章抓正文（去掉 script/style/nav/header/footer/aside，优先 `<article>`，最多 200k 字符）；视频站（YouTube、B 站、Vimeo、抖音等）只存标题和简介。20 秒超时、普通 UA；抓取失败 → 502 `fetch_failed`，不写半成品；标签不在表里 → 400 `tag_unknown`，什么都不写 |
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
| `GET /api/beer/articles?status=&includeArchived=1` | 列出文章：`{ articles: [{ path, folder, title, status, date, modifiedAt, archived }] }`。默认跳过 `_归档`；`status=已归档` 只列归档区，`includeArchived=1` 一起列出 |
| `POST /api/beer/articles/status` `{ path, status, baseVersion? }` | 改状态：只能在 `选题`、`草稿`、`成稿` 之间改；目标或当前是 `已确认` / `已发布` → 403 `status_locked`。只改 frontmatter 的 `状态:` 行。改成 `成稿` 时多回 `askGeneratePlatformVersions: true`，只提示，不生成平台版本 |
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
| `POST /api/beer/topics/articles` `{ title, why?, materials? }` | 选中角度建选题：用文章模块新建状态为「选题」的文章，正文 `# <标题>`，frontmatter 写 `素材:`（`[[库内路径]]` 列表）→ 201 `{ path, title, status: '选题', materials }` |
| `POST /api/beer/topics/materials` `{ path, materials }` | 把多选素材合并进状态为「选题」的文章的 `素材:` 字段（去重）；正文和其余 frontmatter 逐字不动，素材一侧不写反向记录。非「选题」→ 409 `article_not_topic`；素材不存在 → 400 `material_missing` |
| `GET /api/beer/topics/discuss?angle=&why=` | 和 AI 讨论某个角度：回 `{ prompt }`（带当天简报全文和角度），由面板放进对话草稿；**不调模型** |
| `POST /api/beer/publish/confirm` `{ path }` | 确认发布：`成稿` 先把状态改成 `已确认`，`已确认` 直接重跑发布。发布时逐张上传条目 `images/` 下的图片（`POST {rinApiBase}/api/storage`，multipart `file` + `key`=文件名），把正文里的 `images/x.png` / `./images/x.png` 换成返回的 `url`，再 `POST {rinApiBase}/api/feed`（`Authorization: Bearer <自动登录拿到的令牌>`，JSON `{ title, content, summary?, draft: false, listed: true, tags: [] }`）。成功后状态改 `已发布`，往条目里的 `发布记录.md` 追加 `- <YYYY-MM-DD HH:mm> Rin 博客 <链接或文章 id>`。成功后顺手为已有平台版本的 `知乎` / `小红书` 各准备一份发布包，回包带 `packages: [{ platform, text, images, packageDir, publishUrl }]`（没有平台版本文件的平台跳过；只读库、写 Beer 数据目录，**不向平台发请求**）；包准备失败回空数组和 `packageError`，不影响已经成功的发布。失败码：502 `rin_unreachable` / `rin_unauthorized` / `rin_upstream_error` / `rin_bad_response`，没令牌 503 `rin_no_token`，没配地址 503 `rin_not_configured`；状态停在失败前（原状态或 `已确认`），不写发布记录。主稿只改 `状态:` 一行 |
| `POST /api/beer/publish/retry` `{ path }` | 只对 `已确认` 的文章重跑发布；成功后同样改 `已发布` 并写记录。`已发布` / 没确认过的 → 409 `status_invalid` |
| `POST /api/beer/publish/package` `{ path, platform }` | 准备知乎 / 小红书发布包（半自动发布）：`platform` 只能是 `知乎`、`小红书`，文章状态必须是 `已确认` 或 `已发布`（其他 → 409 `status_invalid`）。正文取条目里的 `<platform>.md` 并去掉 frontmatter（没有 → 409 `version_missing`）；条目 `images/` 下的 `.png/.jpg/.jpeg/.gif/.webp/.avif` 复制到 `{root}/publish-packages/<安全条目名>-<platform>/`（库外，先清空再建）。回 `{ platform, text, images: [{ name, source, copiedTo }], packageDir, publishUrl }`，`source` 是库内相对路径，`copiedTo` 是复制后的绝对路径。**服务端不登录、不提交、不向平台发任何请求** |
| `POST /api/beer/publish/record` `{ path, platform, url }` | 用户确认已发布后填链接：`platform` 是 `知乎` / `小红书` / `Rin 博客`，`url` 必须是 http(s) 完整地址（否则 400 `url_invalid` / `platform_invalid`）。往条目 `发布记录.md` 追加 `- <YYYY-MM-DD HH:mm> <平台> <链接>`（不存在就新建，已有内容保留）；同平台同链接重复提交不重复追加（`appended: false`）。主稿状态是 `已确认` 时只改 `状态:` 行成 `已发布`（带 baseVersion，冲突 → 409 `edit_conflict`）；已是 `已发布` 不重复改。回 `{ path, platform, url, status, record, appended }` |
| `GET /api/beer/rules/settings` | 规则学习开关 `{ enabled }`，默认 `false` |
| `PUT /api/beer/rules/settings` `{ enabled }` | 打开 / 关闭规则学习（存在 Beer 数据目录的 `rules.json`）；`enabled` 不是布尔 → 400 `enabled_invalid` |
| `GET /api/beer/rules` | `{ enabled, hard: [...], soft: [...], pending: [{ rule, count }], observations: [{ rule, count }] }`；规则取自 `内容库/规则/硬规则.md`、`软规则.md` |
| `POST /api/beer/rules/observe` `{ path, platform }` | 把用户改后的平台版本和生成时正文对比，调模型归纳 0–3 条规则并累计观察次数：`{ observed: true, added: [{ rule, evidence, count }], pending }`。没有生成快照 / 没有改动 / 开关关闭 → `{ observed: false, reason: 'no_snapshot' \| 'unchanged' \| 'disabled', added: [], pending }`；后两种情况不调模型 |
| `POST /api/beer/rules/promote` `{ rule, kind: 'hard' \| 'soft' }` | 观察满 3 次的规则写进对应规则文件，并从观察计数移除；不足 3 次 → 409 `rule_not_ready`；`kind` 不认识 → 400 `kind_invalid` |
| `GET /api/beer/home[?ensure=1]` | 首页汇总 `{ date, tasks: { publishPending: [{ path, title, status }], brief: { path, exists, generatedToday, error? }, editConflicts: [{ path, detectedAt }] }, recordings: { online, processing: [{ id, filename, progress, step }], failedCount, error? }, week: { since, materials, drafts, published }, rules: { enabled, hard, soft, pending } }`。`ensure=1` 时今天还没有选题简报就先调模型生成（每天第一次打开），已存在不调模型；生成失败不影响首页，`brief` 回 `exists: false` 和 `error`。家里连不上时 `recordings.online: false`，接口仍回 200。见下文「首页（#23）」 |
| `POST /api/beer/home/brief/regenerate` | 重新生成当天选题简报（直接调 `topics.regenerateBrief`）→ `{ path, content, angles }`。模型不可用时和选题分页一样不写半成品 |

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
- 视频站按域名判断（`youtube.com`、`youtu.be`、`bilibili.com`、`b23.tv`、`vimeo.com`、`douyin.com`），只保存 `og:title` / `<title>`、`og:description` / `meta description` 和链接，不抓正文，类型固定「链接」。
- 本地文件只认图片（jpg/jpeg/png/gif/webp/avif）和 PDF；必须是存在的绝对路径。原文件按原文件名复制进条目文件夹，同名条目文件夹自动加 `-2`，绝不覆盖。
- 导出的函数：`importUrl(ctx, body)`、`importFile(ctx, body)`、`createTextMaterial(ctx, body)`、`saveMaterial(ctx, args)`（AI 工具的执行逻辑）、`formatMaterialEntry(entry)`、`createSaveMaterialTool(defineTool, ctx)`。

AI 工具 `beer_save_material` 在 `src/index.js` 里用 `ctx.inject(['tools'], ...)` 注册，`@deepseek-ai/dsh-tools` 用动态 `import()`（不写进依赖）。参数是 `title`（必填）、`type`（链接/图片/PDF/文字/手动）、`tags`、`url`、`filePath`、`content`、`summary`；按字段选择导入方式，返回新条目路径和属性。工具描述要求 AI 先读 `内容库/素材/说明.md` 和标签表。

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

主稿正文由用户自己写：改状态只替换 `状态:` 行，改标题只替换正文第一个 `# ` 行（frontmatter 里有 `标题:` 时一起改）；两次写入都带读取时的 `baseVersion`，读取后被别处改过 → 409 `edit_conflict`，不覆盖。删除复用 `trash.js` 的 `moveToTrash`；归档只是在库内把整个文件夹移动到 `_归档/`。AI 帮手只拼 prompt，不调用模型，也不写主稿。新建文件用 `library.js` 新增的 `createNote(ctx, path, content)`（父文件夹自动创建，已存在则 409 `file_exists`，绝不覆盖）。

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

  素材可以给条目路径（`内容库/素材/xxx`、`xxx/index.md`、`[[…]]`）或素材标题；不存在的素材 → 400 `material_missing`，不会建出半篇。
- 素材分页的「多选素材」：勾选素材卡片、选一篇状态为「选题」的文章，调 `POST /topics/materials`。只改 `素材:` 这一个块，正文和其他属性逐字不动，素材一侧不写任何反向记录。选题分页里也有同样的多选流程。
- 复用：`articles.js` 新增导出 `createArticle(ctx, title)` 和 `readArticles(ctx, { status, includeArchived })`；`materials.js` 新增导出 `listMaterialEntries(ctx)`。`topics.js` 的 `withMaterials(content, materials)`、`parseAngles(content)`、`parseAnglesJson(text)` 也导出了，供后续工单复用；首页（#23）另外用到 `topics.todayBrief(ctx)` 和 `topics.regenerateBrief(ctx)`。

## 发布分页与 Rin 博客（#15）

发布分页（`publish`）是专用视图：左边列出状态为 `成稿`、`已确认` 的文章，右边显示主稿预览和每个平台版本的逐行对照（`same` 原样、`added` 平台版本新增、`removed` 主稿有而平台版本没有），并标出用户改过的平台版本（`你改过`）。主稿正文只读，发布流程只改 frontmatter 的 `状态:` 行。

- 确认按钮：`成稿` → `已确认` → 发布 → `已发布`。发布失败时停在 `已确认`，按钮变成「重试发布到 Rin 博客」，只重跑发布，不再改一次状态；发布记录只在成功后写一行。发布成功后顺手为已有平台版本的知乎 / 小红书各准备一份发布包（见下一节），回包里的 `packages` 直接给面板展示，`window.open` 打开发布页（被拦时给链接）。
- 图片：条目 `images/` 下的 `.png/.jpg/.jpeg/.gif/.webp/.avif` 逐张上传，返回的 `url` 替换正文里的相对路径。`发布记录.md` 不存在时新建，已有时追加，原有内容不动。
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

## 首页（#23）

首页是专用视图（不再复用库列表）：「等你处理」把待确认发布（状态 `成稿` / `已确认`）、当天选题简报、编辑冲突集中到一处，每项点一下跳到发布 / 选题 / 对应文件所在分页；另有录音进度（处理中条目的当前步骤和百分比、失败数，家里连不上时显示「家里暂时连不上」）、本周产出、规则积累，底部是当天选题简报正文预览和「重新生成」按钮。没有会话时照常可用，不自动创建会话。

- `GET /home` 只做汇总：发布待确认复用 `articles.readArticles` 再按 `publish.js` 的 `PUBLISHABLE_STATUSES` 过滤（不读发布记录）；简报复用 `topics.todayBrief`；录音复用 `recordings.recordingSummary`；规则复用 `rules.ruleSummary`。
- `GET /home?ensure=1`：面板每次打开首页都带 `ensure=1`。当天简报不存在时复用 `topics.ensureBrief` 生成（同一进程里并发请求也只调一次模型），已存在直接返回；模型 / 密钥等失败时首页仍 200，`tasks.brief` 回 `exists: false, generatedToday: false` 和 `error`，面板只显示提示。
- 本周从本机时区的周一起算（`week.since`）：素材按条目路径里的日期（`内容库/素材/YYYY-MM-DD-…`），没有日期前缀时按文件修改时间；成稿 / 已发布按文章修改时间（改状态时文件会更新），并且当前状态要对应「成稿」/「已发布」。
- 编辑冲突：`library.saveNote` 发现版本对不上时，把 `{ path, detectedAt }` 记到数据目录的 `edit-conflicts.json`（最多 50 条、同一路径只留最新）；这个路径之后保存成功就删掉。首页只显示最近 5 条。
- 家里连不上或没配密钥时 `recordings` 回 `{ online: false, processing: [], failedCount: 0, error }`，首页其余部分照常返回。

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

配置项（Schemastery，见 `src/config.js`）：`root`（数据目录，patch 里给 `dshHomePath('beer')`）、`homeApiBase`（家里 Mac mini 地址，默认 `http://mac-mini:8787`，按实际 Tailscale 地址改）、`opencodeGoBase`、`platformVersionModel`（生成平台版本的模型，默认 `deepseek-v4.1-flash`）、`rinApiBase`、`keychainService`（默认 `beer`）、`audioCacheLimitGB`（默认 5）。改配置：在 profile 的 `cordis.patch.yml` 里覆盖 `beer` 这一条的 `config`（整体替换，`root` 也要写上）。

密钥存 macOS 钥匙串，服务名 `beer`（配置项 `keychainService`）。**平时在面板顶栏齿轮打开的设置弹层里填**：逐个列出 4 个密钥的状态（已存 / 未存 / 读取出错），每个一个密码框和「保存」，输入框永远是空的、不回显已有值；保存后立即生效，不用重启（各模块每次请求现读钥匙串）。弹层里的配置项只读，改地址请改 profile 的 `cordis.patch.yml`。

保存时 Beer 运行 `security -i`，把 `add-generic-password -U -s <服务名> -a <账号名> -T /usr/bin/security -w <值>` 从标准输入送进去，参数用双引号包起来、`"` 和 `\` 前加反斜杠，密钥不出现在进程参数里（`ps` 看不到）。

| 账号名 | 用途 |
|---|---|
| `home-api-key` | Mac mini 家里服务的访问密钥 |
| `opencode-go-api-key` | opencode go（模型调用、查限额） |
| `rin-admin-username` | Rin 博客管理员账号 |
| `rin-admin-password` | Rin 博客管理员密码 |

备用：在终端里写入（Beer 没开或面板打不开时）：

```sh
security add-generic-password -U -s beer -a home-api-key        -T /usr/bin/security -w
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
