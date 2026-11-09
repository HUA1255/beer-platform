# 家里服务（Mac mini）

一个 FastAPI 服务（工单 #18，规格 #1）：接收录音上传，调度 Windows 上的 voice-transcription 转写，记录五步进度（上传、排队、转写、摘要、入库），失败后从断点重试，结果留着等 Beer 取回。第一版不读写内容库。

技术选型：FastAPI + SQLite（标准库 `sqlite3`）+ uv。

## HTTP 接口

所有请求都要带 `Authorization: Bearer <HOME_ACCESS_KEY>`，缺少或错误返回 `401`。错误统一返回 `{"detail": "...", "error_code": "..."}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康和机器在线状态：`machines.mac_mini / windows / nas` 的 `online` |
| POST | `/recordings` | multipart 字段 `file`。原件先落本地暂存 `HOME_ORIGINALS_DIR/<编号>/<文件名>`，再 PUT 到 NAS 的 WebDAV，返回 `201` 和录音视图（含 `id`），随即开始转写。NAS 不可用返回 `503 ORIGINALS_UNAVAILABLE`，本地不留半成品 |
| GET | `/recordings?status=ready` | 录音列表；`status` 可选 `processing` / `failed` / `ready`（结果就绪、等 Beer 取回）/ `stored` |
| GET | `/recordings/{id}` | 录音视图：`status`、五步 `steps[{key,name,status}]`（`pending`/`running`/`done`/`failed`）、`progress`、`error_code`、`error`，以及 `summary`（摘要正文）、`summary_type`（会议 / 口述灵感 / 课程讲座）、`mail_error`（发信失败原因，没失败为 `null`） |
| POST | `/recordings/{id}/retry` | 从失败的那一步接着做，返回 `202`；没失败返回 `409 NOT_FAILED` |
| DELETE | `/recordings/{id}` | 只删失败的录音记录，返回 `204`；NAS 上的原件不动，只清 Mac mini 本地暂存。不存在 `404 NOT_FOUND`，没失败或正在跑 `409 NOT_FAILED` |
| GET | `/recordings/{id}/transcript` | 取回 `{markdown, srt, summary, summary_type}`；没好返回 `409 NOT_READY` |
| POST | `/recordings/{id}/resummarize` | JSON `{type}`（`会议` / `口述灵感` / `课程讲座`）：按指定类型重做摘要，覆盖原摘要，文字稿和 srt 不动，返回录音视图。没好返回 `409 NOT_READY`，类型不认识返回 `400 TYPE_INVALID` |
| POST | `/recordings/{id}/stored` | Beer 写进内容库后确认，「入库」一步完成 |
| GET | `/recordings/{id}/audio` | 下载录音原件 |

调度流程：就绪检查（`/transcriptions/readiness`）→ 提交（`POST /transcriptions`）→ 轮询 `/tasks/{id}` → 导出 md 和 srt → 摘要。每一步落库，服务重启后接着跑没完成的录音。重试时如果 Windows 上的任务还在，就让 Windows 重跑（`/tasks/{id}/retry`，`failed_resumable` 用 `/chunks/retry-failed`），不重新上传。

常见 `error_code`：`WINDOWS_UNREACHABLE`（连不上 Windows）、`ASR_NOT_READY`（缺模型等）、`ASR_UNAUTHORIZED`（`ASRBOX_API_TOKEN` 不对）、`CHUNK_FAILED` / `TASK_INTERRUPTED`（Windows 上转写失败或中断）、`MODEL_UNREACHABLE` / `MODEL_UNAUTHORIZED` / `MODEL_UPSTREAM_ERROR` / `MODEL_BAD_RESPONSE`（摘要模型出错，可重试）。

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
3. 结果写进 `summary` 和 `summary_type`。模型出错时「摘要」一步记 `failed`，可用 `/retry` 重做。

配置了 SMTP（`HOME_SMTP_*`、`HOME_MAIL_TO`，见 `deploy/home-service.env.example`）时，摘要完成后发一封标题为「录音已转写：<文件名>」、正文含类型和摘要的邮件。没配 SMTP 时跳过并记日志；发信失败不影响摘要，原因放在录音视图的 `mail_error` 里。`POST /recordings/{id}/resummarize` 只重做摘要、不发邮件。

> **opencode go 的用法已确认**（2026-11-09 用户决定）：家里服务的脚本可以调用 opencode go 套餐做摘要。

SQLite 老库启动时自动用 `ALTER TABLE` 补 `summary_type`、`mail_error` 两列，已有录音不丢。


## 开发

```bash
cd home
uv sync
uv run pytest
```

测试只走 HTTP 接口；Windows 上的 voice-transcription 用 `tests/fake_asr.py` 里的假服务（模拟未就绪、转写中、完成、失败、中断、连不上），摘要模型用 httpx `MockTransport`，SMTP 用 `tests/test_summary.py` 里起的最小 SMTP sink（不用真实密钥，也不发真邮件）。原件路径指向临时目录。

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
   填写访问密钥、本地暂存目录、NAS 的 WebDAV 地址与账号（`HOME_WEBDAV_*`）、Windows 基址和 `ASRBOX_API_TOKEN`。基址两种写法：直连 uvicorn 端口 `http://<Windows 的 Tailscale 或局域网 IP>:17494`（2026-11-07 已实测：17494 直接对局域网开放，要求 `Authorization: Bearer <token>`），或绕 nginx 的 `http://<IP>:8080/api`；按需填 `HOME_OPENCODE_API_KEY`（摘要）和 `HOME_SMTP_*` / `HOME_MAIL_TO`（通知邮件）。LaunchDaemon 读不到登录用户的钥匙串，所以密钥放在这个只有本人可读的文件里。
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
- Windows 端要先完成 #3（对局域网开放、设置 `ASRBOX_API_TOKEN`）。

- 本机 shell 带 Clash 代理变量时，`NO_PROXY` 里的 `[::1]` 会让 httpx 建 URL 抛 `InvalidURL`，服务起不来（2026-11-07 实测）。launchd 环境没有这些变量，不受影响；手动调试时先清掉 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 再起。
