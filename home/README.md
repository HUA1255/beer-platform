# 家里服务（Mac mini）

一个 FastAPI 服务（工单 #18，规格 #1）：接收录音上传，调度 Windows 上的 BeeBox 转写（只调用 `/v1` 接口，#37），记录五步进度（上传、排队、转写、摘要、入库），失败后从断点重试，结果留着等 Beer 取回。第一版不读写内容库。

技术选型：FastAPI + SQLite（标准库 `sqlite3`）+ uv。

## HTTP 接口

所有请求都要带 `Authorization: Bearer <HOME_ACCESS_KEY>`，缺少或错误返回 `401`。错误统一返回 `{"detail": "...", "error_code": "..."}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康和机器在线状态：`machines.mac_mini / windows / nas` 的 `online`；`windows` 另带 BeeBox 的 `ready`、`version`、`bilibili_login`（`valid` / `expired` / `absent`） |
| POST | `/recordings` | multipart 字段 `file`。原件先落本地暂存 `HOME_ORIGINALS_DIR/<编号>/<文件名>`，再 PUT 到 NAS 的 WebDAV，返回 `201` 和录音视图（含 `id`），随即开始转写。NAS 不可用返回 `503 ORIGINALS_UNAVAILABLE`，本地不留半成品 |
| POST | `/videos` | JSON `{url}`：按链接提交 B 站（`bilibili.com`、`b23.tv`）或 YouTube（`youtube.com`、`youtu.be`）视频（#34），返回 `201` 和录音视图（`kind: "video"`），后面和录音走同一条流水线，进度、重试、删除、取回都用 `/recordings/{id}`。其他链接返回 `400 UNSUPPORTED_URL`，缺 url 返回 `400 INVALID_URL`。视频的音频不存 NAS |
| GET | `/recordings?status=ready` | 录音列表；`status` 可选 `processing` / `failed` / `ready`（结果就绪、等 Beer 取回）/ `stored` |
| GET | `/recordings/{id}` | 录音视图：`status`、五步 `steps[{key,name,status}]`（`pending`/`running`/`done`/`failed`）、`progress`（0–100）、`error_code`、`error`、`retryable`（失败能否在 BeeBox 上从断点重试），BeeBox 任务的 `job_status` 和 `stage`，以及 `summary`（摘要正文）、`summary_type`（会议 / 口述灵感 / 课程讲座 / 视频）、`mail_error`（发信失败原因，没失败为 `null`）。另有 `kind`（`recording` / `video`）、`title`（视频是 BeeBox 给的标题，转写完之前是原链接；录音是文件名）、`source_url`；视频还有 `author`、`duration_ms`、`text_source`（`platform_manual` / `platform_auto` 是平台字幕，`asr` 是语音识别），第一步名叫「提交链接」，`original_path` 为 `null` |
| POST | `/recordings/{id}/retry` | 从失败的那一步接着做，返回 `202`；没失败返回 `409 NOT_FAILED` |
| DELETE | `/recordings/{id}` | 只删失败的录音记录，返回 `204`；NAS 上的原件不动，只清 Mac mini 本地暂存。不存在 `404 NOT_FOUND`，没失败或正在跑 `409 NOT_FAILED` |
| GET | `/recordings/{id}/transcript` | 取回 `{markdown, srt, summary, summary_type, kind, title, source_url, source}`（`source` 是 BeeBox 结果里的文字来源、标题、作者、时长、原链接）；没好返回 `409 NOT_READY` |
| POST | `/recordings/{id}/resummarize` | JSON `{type}`（`会议` / `口述灵感` / `课程讲座` / `视频`）：按指定类型重做摘要，覆盖原摘要，文字稿和 srt 不动，返回录音视图。没好返回 `409 NOT_READY`，类型不认识返回 `400 TYPE_INVALID` |
| POST | `/recordings/{id}/stored` | Beer 写进内容库后确认，「入库」一步完成，随后删除 BeeBox 上的任务 |
| GET | `/recordings/{id}/audio` | 下载录音原件；视频返回 `404 NO_AUDIO` |

调度流程（BeeBox `/v1`，契约见 [HUA1255/beebox](https://github.com/HUA1255/beebox) 的 `openapi.json` 与 ADR-0009）：读 `GET /v1/health` 确认就绪 → `POST /v1/files` 流式上传得到文件 id → `POST /v1/jobs`（`kind=transcription`，`source: {type: "file", file_id}`；视频链接任务用 `source: {type: "url", url}`）→ 轮询 `GET /v1/jobs/{id}` → 导出 `/v1/jobs/{id}/exports/md` 和 `srt`、读 `/v1/jobs/{id}/result` 的 `source` → 摘要。每一步落库，服务重启后接着跑没完成的录音。

任务只看五种状态：`queued`（「排队」一步）、`running`（「转写」一步，`stage` 和 `progress` 显示进度，`progress` 换算成 0–100）、`succeeded`、`failed`、`cancelled`。重试时：
- 任务 `failed` 且 `retryable` → `POST /v1/jobs/{id}/retry`，BeeBox 从断点接着跑，不重新上传；
- 不可重试的失败（如 `MODEL_NOT_DOWNLOADED`）、已取消、或 BeeBox 上已没有这个任务（404，过了 30 天保留期等）→ 删掉旧任务，从原件重新提交一个新任务。

结果入库（`/stored`）或失败记录被删除后，home 调 `DELETE /v1/jobs/{id}`，BeeBox 同时清掉源文件；删不掉只记日志，留给 BeeBox 的保留期清理。

BeeBox 的错误码按 `beebox.py` 的 `ERROR_HINTS` 映射成中文提示，原样放在 `error_code`。常见：`WINDOWS_UNREACHABLE`（连不上 BeeBox）、`BEEBOX_NOT_READY`（数据库或存储不可用）、`AUTH_INVALID_TOKEN`（`HOME_BEEBOX_TOKEN` 不对）、`SPEECH_ENGINE_FAILED` / `TASK_INTERRUPTED`（转写失败或被重启打断，可从断点重试）、`MODEL_NOT_DOWNLOADED`（到 BeeBox 控制台下载模型）、视频链接的 `VIDEO_LOGIN_REQUIRED` / `VIDEO_NOT_ACCESSIBLE` / `UNSUPPORTED_URL` 等，以及摘要模型的 `MODEL_UNREACHABLE` / `MODEL_UNAUTHORIZED` / `MODEL_UPSTREAM_ERROR` / `MODEL_BAD_RESPONSE`（可重试）。

### B 站登录失效提醒

每次读到 BeeBox 的 `/v1/health`（Beer 查 `/health`、提交录音前、以及每 `HOME_BEEBOX_HEALTH_INTERVAL` 秒一次的后台检查，默认 1800，设 0 关闭）都看 `bilibili_login`：变成 `expired` 时发一封「B 站登录已失效」邮件，附 BeeBox 控制台地址（`<HOME_BEEBOX_BASE_URL>/console`），提醒扫码登录。同一次失效只发一次（记在 SQLite 的 `meta` 表，重启不重发），恢复后再失效会重新提醒。没配 SMTP 时只记日志。

## 录音原件的存放（#18，2026-11-07 改）

**NAS 上的 WebDAV 是主副本，本地目录只是暂存。** 不再依赖 SMB 挂载。

分工：
- 上传：写本地暂存 → `PUT` 到 WebDAV（`HOME_WEBDAV_ROOT/<编号>/<文件名>`）→ 两步都成功才算上传成功；失败清掉本地半成品，返回 `503 ORIGINALS_UNAVAILABLE`。
- 视图里的 `original_path` 是**NAS 上的相对路径**（`录音原件/<编号>/<文件名>`），Beer 直接写进素材条目。
- 入库确认（`POST /recordings/{id}/stored`）后删掉本地暂存，原件只留在 NAS。
- 重试、播放（`GET /recordings/{id}/audio`）时本地没有就自动从 NAS 取回；NAS 取不到返回 `503`。
- `/health` 的 `nas.online` 改成对 WebDAV 做 `PROPFIND`（根目录不存在会先建），不再看本地挂载点。

配置（见 `deploy/home-service.env.example`）：`HOME_WEBDAV_URL`（要带个人空间路径，如 `http://192.168.1.10:5005/your-space`）、`HOME_WEBDAV_USER`、`HOME_WEBDAV_PASSWORD`、`HOME_WEBDAV_ROOT`（默认 `录音原件`）。三个都留空时退回纯本地目录，和以前一样。

**为什么不用 SMB 挂载（2026-11-07 实测）**：极空间 Z2Pro 的 SMB 在 macOS 上反复挂载/卸载后会陷入僵死会话，`umount` 自己也会超时（`net.smb.fs.kern_hard_deadtimer` 600 秒才回收），表现为「空闲一会儿后所有操作卡死」。同一台 NAS 的 WebDAV（5005 明文 / 5006 加密，Basic 认证）稳定：局域网 `PUT` 2 MB ≈ 0.08 秒、50 MB ≈ 0.75 秒，回读哈希一致，中文目录名可用。而且 WebDAV 是普通 HTTP，不受内核挂载状态影响。

> 注意：`HOME_WEBDAV_URL` 指向局域网地址时，客户端用 `trust_env=False` 建连，**不走** `HTTP_PROXY/ALL_PROXY`。附带解决一个坑：Clash 注入的 `NO_PROXY` 里带 `[::1]`，httpx 解析会直接抛 `InvalidURL`。

## 按类型摘要与邮件（#20）

「摘要」一步调用 opencode go 的 OpenAI 兼容接口（`{HOME_OPENCODE_BASE}/inference/go/openai/v1/chat/completions`，`Authorization: Bearer <HOME_OPENCODE_API_KEY>`，带 `x-opencode-session`，默认模型 `deepseek-v4.1-flash`，可用 `HOME_SUMMARY_MODEL` 覆盖，超时 120 秒）：

1. 先让模型判断类型，只回 JSON `{"type": "会议"|"口述灵感"|"课程讲座"}`；类型不认识（或没按 JSON 回）时按「会议」处理，并在摘要开头注明「类型未能识别」。
2. 按类型生成 Markdown 摘要：会议给结论、要点、谁说了什么（沿用文字稿里的「说话人 N」）；口述灵感尽量保留原话、整理成写作素材；课程讲座给知识点大纲和值得记下的观点。
3. 结果写进 `summary` 和 `summary_type`。

视频链接任务（#34）跳过第 1 步，直接按「视频」整理：一句话概括、要点（按视频顺序，保留作者的表述和例子）、可以怎么写；提示词里带上视频标题和作者。和录音一样可以用 `/resummarize` 改类型重做。模型出错时「摘要」一步记 `failed`，可用 `/retry` 重做。

配置了 SMTP（`HOME_SMTP_*`、`HOME_MAIL_TO`，见 `deploy/home-service.env.example`）时，摘要完成后发一封标题为「录音已转写：<文件名>」、正文含类型和摘要的邮件；视频是「视频已转写：<视频标题>」，正文多一行原链接。没配 SMTP 时跳过并记日志；发信失败不影响摘要，原因放在录音视图的 `mail_error` 里。`POST /recordings/{id}/resummarize` 只重做摘要、不发邮件。

> **opencode go 的用法已确认**（2026-11-09 用户决定）：家里服务的脚本可以调用 opencode go 套餐做摘要。

SQLite 老库启动时自动用 `ALTER TABLE` 补 `summary_type`、`mail_error` 两列，已有录音不丢。


## 开发

```bash
cd home
uv sync
uv run pytest
```

测试只走 HTTP 接口；Windows 上的 BeeBox 用 `tests/fake_beebox.py` 里的 `/v1` 假服务（模拟未就绪、排队、转写中、完成、可重试 / 不可重试的失败、取消、任务被清理、连不上、B 站登录失效），摘要模型用 httpx `MockTransport`，SMTP 用 `tests/test_summary.py` 里起的最小 SMTP sink（不用真实密钥，也不发真邮件）。原件路径指向临时目录。

## 部署到 Mac mini

1. 装 uv：`brew install uv`。
2. 放代码并安装依赖：
   ```bash
   git clone <仓库> /Users/you/home-service
   cd /Users/you/home-service/home
   uv sync --frozen --no-dev
   mkdir -p /Users/you/home-service/data
   ```
3. 配置：
   ```bash
   sudo mkdir -p /usr/local/etc /usr/local/var/log
   sudo cp deploy/home-service.env.example /usr/local/etc/home-service.env
   sudo chown you /usr/local/etc/home-service.env /usr/local/var/log
   chmod 600 /usr/local/etc/home-service.env
   ```
   填写访问密钥、本地暂存目录、NAS 的 WebDAV 地址与账号（`HOME_WEBDAV_*`）、BeeBox 基址 `HOME_BEEBOX_BASE_URL` 和 `HOME_BEEBOX_TOKEN`（与 Windows 上的 `BEEBOX_API_TOKEN` 一致）。基址只有一种写法：`http://<Windows 的局域网或 Tailscale IP>:17494`，不带路径（请求都以 `/v1` 开头；端到端预演时用开发实例的 17495）。旧的 `HOME_ASR_BASE_URL` / `HOME_ASR_TOKEN` 还在时服务拒绝启动并提示改名；按需填 `HOME_OPENCODE_API_KEY`（摘要）和 `HOME_SMTP_*` / `HOME_MAIL_TO`（通知邮件）。LaunchDaemon 读不到登录用户的钥匙串，所以密钥放在这个只有本人可读的文件里。
4. 安装 LaunchDaemon：把 `deploy/com.example.home-service.plist` 里的 `100.x.y.z` 换成 Mac mini 的 Tailscale IP（`tailscale ip -4`），路径按实际改，然后：
   ```bash
   sudo cp deploy/com.example.home-service.plist /Library/LaunchDaemons/
   sudo chown root:wheel /Library/LaunchDaemons/com.example.home-service.plist
   sudo chmod 644 /Library/LaunchDaemons/com.example.home-service.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.home-service.plist
   ```
5. 验证：`curl -H "Authorization: Bearer <密钥>" http://<Tailscale IP>:8787/health`。

常用命令：
- 重启：`sudo launchctl kickstart -k system/com.example.home-service`
- 查看：`sudo launchctl print system/com.example.home-service`
- 卸载：`sudo launchctl bootout system/com.example.home-service`
- 日志：`/usr/local/var/log/home-service.{log,err}`
- 更新代码后：`git pull && uv sync --frozen --no-dev`，再重启。

## 部署风险（未实测）

- 服务只绑 Tailscale IP。开机时 Tailscale 可能比服务晚起来，绑定会失败，靠 `KeepAlive` 每 10 秒重试。Mac App Store 版 Tailscale 要用户登录后才连网；不登录也要能用的话，需要换成独立版 `tailscaled`。
- 原件走 WebDAV，不再受「SMB 挂载要等用户登录」影响；但家里的 NAS 若关机或重启，上传仍会返回 `503 ORIGINALS_UNAVAILABLE`、`/health` 里 `nas.online` 为 `false`。LaunchDaemon 是系统级、比登录更早起来，WebDAV 只要网络通就能用。
- Windows 端要先部署 BeeBox 并设置 `BEEBOX_API_TOKEN`（部署见 [HUA1255/beebox](https://github.com/HUA1255/beebox) 的 README）。

- 本机 shell 带 Clash 代理变量时，`NO_PROXY` 里的 `[::1]` 会让 httpx 建 URL 抛 `InvalidURL`，服务起不来（2026-11-07 实测）。launchd 环境没有这些变量，不受影响；手动调试时先清掉 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 再起。
