// dsh 插件入口：只做接线。业务都在 app.js 和 modules/ 里，测试不经过这里也能跑。
//
// 除了 HTTP 面板接口，这里还把 AI 工具注册给宿主（#12 素材导入、#22 录音转录、#44 邮件提醒），
// DSH Desktop 对话里的 AI 可以直接调用。执行逻辑在 modules/ 里，这里只做
// defineTool 包装和注册。
import { createBeerContext, createBeerHandler, API_PREFIX } from './app.js'
import { sendJson } from './http/router.js'
import { keychainStore } from './secrets.js'
import { createSaveMaterialTool } from './modules/material-import.js'
import { Config } from './config.js'
import { submitFromPath, toolStatus, toolResult } from './modules/recordings.js'
import { registerReminderTools } from './modules/reminders.js'
import { registerScheduleTools } from './modules/schedule-tools.js'

export const name = 'beer'
export const inject = ['webServer', 'connection']
export { Config }

export function apply(ctx, config) {
  const context = createBeerContext({ config, secrets: keychainStore(config.keychainService) })
  const handle = createBeerHandler({ context })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      // 自己的 /api/beer 前缀比宿主 /api 更长，会绕过宿主的连接鉴权，所以这里必须先自己检查。
      // 要按方法调用：宿主的 requestRejection 用到 this，拆下来单独调用会抛错，宿主只回 400。
      const connection = ctx.connection
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 403
      if (rejection !== undefined) {
        return sendJson(res, rejection === 401 ? 401 : 403, { error: { code: 'unauthorized', message: '需要认证' } })
      }
      return handle(req, res)
    },
  }))

  // AI 工具：宿主提供 tools 服务时注册；没有这个服务（测试或精简宿主）就不注册。
  ctx.inject?.(['tools'], toolsCtx => {
    void import('@deepseek-ai/dsh-tools')
      .then(({ defineTool }) => {
        toolsCtx.tools.register(createSaveMaterialTool(defineTool, context))
      })
      .catch(() => {
        // 宿主没有内置 dsh-tools 时只影响 AI 工具，面板和 HTTP 接口照常
      })
  })

  // 转录三件套（#22）：提交、查进度、取结果。registerRecordingTools 自己 import defineTool，
  // 返回的清理函数会随插件卸载注销工具。
  ctx.inject?.(['tools'], toolsCtx => registerRecordingTools(toolsCtx, context))

  // 邮件提醒三件套（#44）：建、查、取消，调云端提醒服务（cloud/reminder）。
  ctx.inject?.(['tools'], toolsCtx => registerReminderTools(toolsCtx, context))

  // 日程五件套（#53）：建、查、改、完成、删除，写库根目录 日程.md。
  ctx.inject?.(['tools'], toolsCtx => registerScheduleTools(toolsCtx, context))
}

/** tool 的输出统一是 { text } 对象，render 只把这段文本交给模型。 */
function renderText(_args, value) {
  const text = value && typeof value === 'object' && typeof value.text === 'string'
    ? value.text
    : JSON.stringify(value)
  return [{ type: 'text', text }]
}

function present(title) {
  return args => ({ card: 'generic', kind: 'other', title, rawInput: args })
}

/**
 * 三个录音工具的原始定义。执行只调用 recordings.js 导出的函数，不绕回 HTTP，也不自己碰家里接口。
 * 描述写清楚「什么时候调用、参数是什么」，对话里的 AI 靠它决定用哪个工具。
 */
function recordingToolDefinitions(context) {
  return [
    {
      name: 'beer_transcribe_submit',
      description: '把一个本机音频或视频文件提交给家里的录音转录服务，返回录音编号和「上传 → 排队 → 转写 → 摘要 → 入库」五步状态。用户要求把某个录音转成文字、出逐字稿或摘要时调用；提交后用 beer_transcribe_status 查进度、beer_transcribe_result 取结果。',
      parameters: {
        filePath: {
          type: 'string',
          required: true,
          description: '本机文件的绝对路径（必填），例如 /Users/me/录音/周会.m4a 或 C:\\Users\\me\\录音\\周会.m4a。只支持常见音频和视频格式（.m4a、.mp3、.wav、.mp4、.mov 等）。',
        },
        filename: {
          type: 'string',
          description: '可选：家里保存和显示用的文件名（不含路径），默认用 filePath 的文件名。',
        },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('提交转录'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return submitFromPath(context, { filePath: args.filePath, filename: args.filename })
      },
    },
    {
      name: 'beer_transcribe_status',
      description: '查询家里转录任务的五步进度（上传 / 排队 / 转写 / 摘要 / 入库）、百分比和失败原因。提交后用户问「转写好了吗」、或需要确认卡在哪一步时调用。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '录音编号（必填），就是 beer_transcribe_submit 返回的 id。',
        },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('查转录进度'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return toolStatus(context, args.id)
      },
    },
    {
      name: 'beer_transcribe_result',
      description: '取回一条录音的转录结果：文字稿 markdown 全文和摘要。结果还没好时返回「还没转写完」，可以稍后再取。用户在转写完成后要文字稿、逐字稿或摘要时调用。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '录音编号（必填），就是 beer_transcribe_submit 返回的 id。',
        },
      },
      output: { schema: { type: 'json' }, render: renderText },
      presentCall: present('取转录结果'),
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.()
        return toolResult(context, args.id)
      },
    },
  ]
}

/**
 * 注册三个转录工具。@deepseek-ai/dsh-tools 由宿主提供，用动态 import 拿，
 * 不写进 package.json；测试可以传第三个参数（假的 defineTool），不依赖宿主包。
 * @returns 注销函数，供插件卸载时调用。
 */
export async function registerRecordingTools(toolsCtx, context, defineTool) {
  const define = defineTool ?? (await import('@deepseek-ai/dsh-tools')).defineTool
  const disposers = recordingToolDefinitions(context).map(definition => toolsCtx.tools.register(define(definition)))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
