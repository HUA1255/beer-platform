// 面板状态：分页列表、各分页对话栏展开 / 收起、本工作台的会话编号。
//   GET    /api/beer/panel                → { tabs: [{ id, title, folder } | { id, title, folder, custom: true, style }], chatCollapsed, sessionId }
//   POST   /api/beer/panel/tabs { title, folder, style } → 201 新分页
//   DELETE /api/beer/panel/tabs/:id       → 只删自定义分页，固定分页 403
//   PUT    /api/beer/panel/chat/:tab { collapsed: boolean }
//   PUT    /api/beer/panel/session { sessionId: string }
// folder 是分页绑定的库内文件夹（相对库根目录，用 / 分隔），面板用 /api/beer/library/folder 列出。
// 自定义分页（「＋」）存在数据目录里，追加在 8 个固定分页之后，按添加顺序；chatCollapsed 同样按 id 记。
// 固定分页第一版不能排序、隐藏、删除。
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { HttpError, reply } from '../http/router.js'
import { locate } from './library.js'

export const FIXED_TABS = [
  { id: 'home', title: '首页', folder: '内容库' },
  { id: 'recordings', title: '录音', folder: '内容库/素材' },
  { id: 'materials', title: '素材', folder: '内容库/素材' },
  { id: 'topics', title: '选题', folder: '内容库/选题简报' },
  { id: 'articles', title: '文章', folder: '内容库/文章' },
  { id: 'publish', title: '发布', folder: '内容库/文章' },
  { id: 'rules', title: '规则', folder: '内容库/规则' },
  { id: 'trash', title: '回收站', folder: '.trash' },
]

const CHAT_COLLAPSED_BY_DEFAULT = new Set(['publish'])
const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/
const CUSTOM_TABS_KEY = 'custom-tabs'
const TITLE_MAX = 40
const STYLES = new Set(['note', 'list'])

/**
 * 当前全部分页：8 个固定分页在前，自定义分页按添加顺序追加。
 * 搜索等模块用它把库里的文件归到分页，不要在别处另抄一份分页表。
 */
export async function listTabs(ctx) {
  return [...FIXED_TABS, ...(await readCustomTabs(ctx)).map(tab => ({ ...tab, custom: true }))]
}

export function register(router, ctx) {
  router.get('/panel', async () => {
    const tabs = await listTabs(ctx)
    const saved = (await ctx.state.get('chat-collapsed')) ?? {}
    const chatCollapsed = {}
    for (const tab of tabs) chatCollapsed[tab.id] = saved[tab.id] ?? CHAT_COLLAPSED_BY_DEFAULT.has(tab.id)
    const session = await ctx.state.get('session')
    return { tabs, chatCollapsed, sessionId: session?.sessionId ?? null }
  })

  router.post('/panel/tabs', async req => {
    const body = (await req.json()) ?? {}
    const { title, style } = body
    const folder = typeof body.folder === 'string' ? body.folder.trim() : body.folder
    const trimmedTitle = typeof title === 'string' ? title.trim() : ''
    if (!trimmedTitle || [...trimmedTitle].length > TITLE_MAX) {
      throw new HttpError(400, 'title_invalid', `标题不能为空，最多 ${TITLE_MAX} 个字`)
    }
    if (!validFolder(folder)) {
      throw new HttpError(400, 'folder_invalid', '文件夹必须是库内的相对路径，用 / 分隔，不能有 ..')
    }
    if (!STYLES.has(style)) throw new HttpError(400, 'style_invalid', '样式只能是 note 或 list')
    // 允许文件夹还不存在，但必须落在库内（locate 会拦住符号链接跑到库外的情况）。
    await locate(ctx, folder)

    const custom = await readCustomTabs(ctx)
    const tab = { id: newTabId(custom), title: trimmedTitle, folder, style }
    await ctx.state.set(CUSTOM_TABS_KEY, [...custom, tab])
    return reply(201, { ...tab, custom: true })
  })

  router.delete('/panel/tabs/:id', async req => {
    const { id } = req.params
    if (!TAB_ID.test(id)) throw new HttpError(400, 'tab_invalid', '分页编号不合法')
    if (FIXED_TABS.some(tab => tab.id === id)) {
      throw new HttpError(403, 'tab_fixed', '固定分页不能删除')
    }
    const custom = await readCustomTabs(ctx)
    const rest = custom.filter(tab => tab.id !== id)
    if (rest.length === custom.length) throw new HttpError(404, 'tab_not_found', '没有这个分页')
    await ctx.state.set(CUSTOM_TABS_KEY, rest)

    const saved = (await ctx.state.get('chat-collapsed')) ?? {}
    if (Object.hasOwn(saved, id)) {
      delete saved[id]
      await ctx.state.set('chat-collapsed', saved)
    }
    return { id }
  })

  router.put('/panel/chat/:tab', async req => {
    const { tab } = req.params
    if (!TAB_ID.test(tab)) throw new HttpError(400, 'tab_invalid', '分页编号不合法')
    const { collapsed } = await req.json()
    if (typeof collapsed !== 'boolean') throw new HttpError(400, 'collapsed_invalid', 'collapsed 必须是 true 或 false')
    const saved = (await ctx.state.get('chat-collapsed')) ?? {}
    saved[tab] = collapsed
    await ctx.state.set('chat-collapsed', saved)
    return { tab, collapsed }
  })

  router.put('/panel/session', async req => {
    const { sessionId } = await req.json()
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
      throw new HttpError(400, 'session_invalid', 'sessionId 必须是非空字符串')
    }
    await ctx.state.set('session', { sessionId })
    return { sessionId }
  })
}

/** 读出保存的自定义分页；手工改坏的条目直接忽略，免得整个面板打不开。 */
async function readCustomTabs(ctx) {
  const saved = await ctx.state.get(CUSTOM_TABS_KEY)
  if (!Array.isArray(saved)) return []
  return saved.flatMap(entry => {
    if (!entry || typeof entry.id !== 'string' || !TAB_ID.test(entry.id)) return []
    if (FIXED_TABS.some(tab => tab.id === entry.id)) return []
    if (typeof entry.title !== 'string' || !entry.title || [...entry.title].length > TITLE_MAX) return []
    if (!validFolder(entry.folder) || !STYLES.has(entry.style)) return []
    return [{ id: entry.id, title: entry.title, folder: entry.folder, style: entry.style }]
  })
}

function validFolder(folder) {
  if (typeof folder !== 'string' || !folder || folder.includes('\0')) return false
  if (isAbsolute(folder) || folder.includes('\\')) return false
  return folder.split('/').every(segment => segment && segment !== '.' && segment !== '..')
}

function newTabId(custom) {
  const taken = new Set([...FIXED_TABS, ...custom].map(tab => tab.id))
  for (;;) {
    const id = 'custom-' + randomBytes(4).toString('hex')
    if (!taken.has(id)) return id
  }
}
