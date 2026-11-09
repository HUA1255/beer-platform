# Beer Platform

一个跑在 [DSH Desktop](https://dshdesktop.com) 里的个人内容工作台：录音转录、素材整理、选题、写作、多平台发布都在一个工作台里完成，内容全部落在本机的 Obsidian 库里。

> **定位**：这是作者给自己搭的工作台，和作者的环境绑得比较紧（MacBook + 家里 Mac mini + Windows 转录服务 + NAS，靠 Tailscale 连通）。开源出来主要作为 **DSH Desktop 工作台的参考实现**，不保证能开箱即用。欢迎参考、拆用其中的模块。

![架构图](docs/architecture.svg)

## 组成

| 目录 | 是什么 | 技术 |
|---|---|---|
| [`beer/`](beer/README.md) | DSH Desktop 工作台包 `beer-workbench`：8 个分页（首页、录音、素材、选题、文章、发布、规则、回收站）+ 自定义分页，读写 Obsidian 库，调用模型生成选题简报和平台版本，发布到 Rin 博客 | Node.js ≥ 22，手写 ESM，零第三方运行时依赖；面板是单文件 React |
| [`home/`](home/README.md) | 家里服务：接收录音上传、调度转写、按类型生成摘要、发通知邮件，录音原件存 NAS（WebDAV） | Python ≥ 3.12，FastAPI，uv |
| `docs/` | 架构图和早期界面草图 | |
| [`GLOSSARY.md`](GLOSSARY.md) | 项目术语表 | |

## 需要的外部服务

- **DSH Desktop**（目标 0.13.2，dsh 运行时 0.2.2-alpha.2）
- **Obsidian 库**：任意本机文件夹
- **转写服务**：家里服务按 HTTP 调用一个外部转写服务（作者用的是自维护的 voice-transcription），接口见 `home/src/home_service/asr.py`
- **模型**：OpenAI 兼容的 `chat/completions` 接口（作者用 opencode go）
- 可选：Rin 博客、SMTP 邮箱、WebDAV（NAS）

## 快速开始

```bash
# 工作台包
cd beer && npm ci && npm test

# 家里服务
cd home && uv sync && uv run pytest
```

打包、安装到 DSH Desktop、密钥配置（macOS 钥匙串）见 [beer/README.md](beer/README.md)；家里服务的部署（LaunchDaemon）见 [home/README.md](home/README.md)。

## 说明

- 文档和代码注释是中文。
- 文档里的 `#11`、`#19` 这类编号指作者原来私有仓库里的 Issue，公开仓库里没有对应页面。
- 部署文件里的 `you`、`com.example`、`100.x.y.z`、`192.168.1.10` 都是占位符，按自己的环境替换。

## 许可证

[MIT](LICENSE)。`beer/client/editor.js` 里打包了 CodeMirror 等第三方代码，许可证见 [beer/THIRD_PARTY_NOTICES.md](beer/THIRD_PARTY_NOTICES.md)。
