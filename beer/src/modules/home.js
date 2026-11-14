// 首页：把各模块「今天要处理什么」汇总成一次请求，只做汇总，不复制业务逻辑。
//   GET  /api/beer/home[?ensure=1]        → { date, tasks, recordings, week, rules }
//        ensure=1 时今天还没有选题简报就先调 topics 生成（模拟每天第一次打开）；
//        生成失败不让首页 500，tasks.brief 带 exists: false 和 error。
//   POST /api/beer/home/brief/regenerate  → { path, content, angles }（首页不再调用，选题页用 /topics/brief/regenerate）
//
// - tasks.publishPending 复用 articles.readArticles，只取状态「成稿」「已确认」，不读发布记录。
//   每条带：statusTime（frontmatter 的 状态时间，旧文章退回 modifiedAt）、statusTimeSource、
//   waitedDays（本机日历日差）、waitedLong（超过 2 天，面板标红）、words（正文字数）、
//   platforms（各平台版本「已生成 / 未生成 / 待发」）和 action（confirm / publish）。
// - tasks.writing 同样复用 readArticles，只取状态「选题」「草稿」——首页「正在写」用。
// - tasks.brief 复用 topics.todayBrief / topics.ensureBrief：今天简报的路径、文件是否存在、
//   第一个角度的标题和角度数；generatedToday 就是「今天的文件在」。
//   首页先渲染 GET /home，再异步 GET /home?ensure=1：ensure 慢或失败都不挡首屏。
// - tasks.editConflicts 读 library.readEditConflicts 的最近几条（保存冲突时留下的记录）。
// - recordings 复用 recordings.recordingSummary；家里连不上时 online: false + error，不让整个首页 500。
// - week 从本周一（本机时区）起算，比较到「天」：
//     materials：素材条目路径里的日期（`内容库/素材/YYYY-MM-DD-…`），没有日期前缀时按修改时间；
//     drafts / published：文章当前状态是「成稿」/「已发布」，且文件修改时间在本周
//     （改状态时文件会更新，所以修改时间可以当作进入该状态的时间）。
// - rules 复用 rules.ruleSummary，只给数字（硬 / 软规则数、待转正数）。
import { PUBLISHABLE_STATUSES } from './publish.js'
import { STATUS_CONFIRMED, STATUS_DRAFT, STATUS_FINAL, STATUS_PUBLISHED, STATUS_TOPIC, readArticles } from './articles.js'
import { listMaterialEntries } from './materials.js'
import { listFolder, readEditConflicts } from './library.js'
import { recordingSummary } from './recordings.js'
import { ruleSummary } from './rules.js'
import { scheduleSummary } from './schedule.js'
import { BRIEFS_DIR, ensureBrief, regenerateBrief, todayBrief } from './topics.js'
import { PLATFORMS } from '../platform-versions.js'
import { localDate } from '../dates.js'

/** 首页只显示最近几条编辑冲突，完整记录最多留 50 条。 */
const CONFLICTS_SHOWN = 5
/** 成稿等了超过这么多天，面板把「等了 N 天」标红（第 3 天起）。 */
export const WAITING_ALERT_DAYS = 2

/**
 * 「正在写」的粗略进度（0–100），只按状态给一个里程碑，不是真实写作完成度：
 * 选题 = 15（刚定题），草稿 = 50（在写）。客户端画成一条小进度条，让人一眼看出大概阶段。
 */
export const WRITING_PROGRESS = {
  [STATUS_TOPIC]: 15,
  [STATUS_DRAFT]: 50,
}

export function writingProgress(status) {
  return WRITING_PROGRESS[status] ?? null
}

export function register(router, ctx) {
  router.get('/home', async req => home(ctx, { ensure: req.query.get('ensure') === '1' }))
  router.post('/home/brief/regenerate', async () => {
    const result = await regenerateBrief(ctx)
    return { path: result.briefPath, content: result.content, angles: result.angles }
  })
}

async function home(ctx, { ensure = false } = {}) {
  const now = ctx.now()
  const [articles, brief, materials, editConflicts, recordings, rules, schedule] = await Promise.all([
    readArticles(ctx),
    briefForHome(ctx, ensure),
    listMaterialEntries(ctx),
    readEditConflicts(ctx),
    recordingSummary(ctx),
    ruleSummary(ctx),
    scheduleSummary(ctx),
  ])
  const pending = articles.filter(article => PUBLISHABLE_STATUSES.includes(article.status))
  const publishPending = await Promise.all(pending.map(article => publishTask(ctx, article, now)))
  return {
    date: localDate(now),
    tasks: {
      publishPending,
      writing: articles
        .filter(article => article.status === STATUS_TOPIC || article.status === STATUS_DRAFT)
        .map(({ path, title, status }) => ({ path, title, status, progress: writingProgress(status) })),
      brief: {
        path: brief.path,
        exists: brief.exists,
        generatedToday: brief.exists,
        title: brief.angles?.[0]?.title ?? null,
        angleCount: brief.angles?.length ?? 0,
        ...(brief.error ? { error: brief.error } : {}),
      },
      editConflicts: editConflicts.slice(0, CONFLICTS_SHOWN),
    },
    recordings,
    // 日程只给首页汇总句要的数字；完整列表由 GET /schedule 提供。
    schedule,
    week: weekOf(now, materials, articles),
    rules,
  }
}

/**
 * 「等你处理」里的一条发布类任务：状态时间、等了几天、字数、平台版本状态和该做的动作。
 * 旧文章 frontmatter 里没有 `状态时间:` 时退回文件修改时间（README 有说明），并标明来源。
 */
async function publishTask(ctx, article, now) {
  const statusTime = article.statusTime || article.modifiedAt
  const waitedDays = waitedDaysSince(statusTime, now)
  return {
    path: article.path,
    title: article.title,
    status: article.status,
    statusTime,
    statusTimeSource: article.statusTime ? 'frontmatter' : 'mtime',
    waitedDays,
    waitedLong: waitedDays > WAITING_ALERT_DAYS,
    words: article.words,
    platforms: await platformStates(ctx, article),
    action: article.status === STATUS_FINAL ? 'confirm' : 'publish',
  }
}

/** 各平台版本在条目里存不存在：成稿是「已生成 / 未生成」，已确认是「待发 / 未生成」。 */
async function platformStates(ctx, article) {
  const listing = await listFolder(ctx, article.folder)
  const files = new Set(listing.entries.filter(entry => entry.kind === 'file').map(entry => entry.name))
  return PLATFORMS.map(platform => ({
    platform,
    state: files.has(platform + '.md')
      ? (article.status === STATUS_CONFIRMED ? '待发' : '已生成')
      : '未生成',
  }))
}

/** 两个时间之间隔了几个本机日历日；状态时间在未来（时钟不准）按 0 天算。 */
export function waitedDaysSince(statusTime, now) {
  const from = new Date(statusTime)
  if (Number.isNaN(from.getTime())) return 0
  return Math.max(0, localDayNumber(now) - localDayNumber(from))
}

/** 本机日历日的序号（用 UTC 建同一个日期，避开夏令时导致的 23 / 25 小时）。 */
function localDayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
}

/**
 * 首页的简报部分：ensure=1 时当天没有就生成，已有文件不调模型。
 * 模型 / 密钥 / 读写失败都不让首页 500，返回空状态和原因让面板提示。
 */
async function briefForHome(ctx, ensure) {
  if (!ensure) return todayBrief(ctx)
  try {
    return await ensureBrief(ctx)
  } catch (e) {
    const date = localDate(ctx.now())
    return {
      date,
      path: `${BRIEFS_DIR}/${date}.md`,
      exists: false,
      content: null,
      angles: [],
      error: e?.message ?? String(e),
    }
  }
}

function weekOf(now, materials, articles) {
  const since = mondayOf(now)
  return {
    since,
    materials: materials.filter(entry => materialDate(entry) >= since).length,
    drafts: articles.filter(article => article.status === STATUS_FINAL && articleDate(article) >= since).length,
    published: articles.filter(article => article.status === STATUS_PUBLISHED && articleDate(article) >= since).length,
  }
}

/** 本周一（本机时区）的 `YYYY-MM-DD`。 */
function mondayOf(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return localDate(monday)
}

/** 素材条目的日期：优先用路径里的创建日期，手动放进来的文件按修改时间。 */
function materialDate(entry) {
  const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})-/.exec(entry.path)
  return m ? m[1] : localDate(new Date(entry.modifiedAt))
}

/** 文章在「天」这一层的日期：改状态会更新修改时间。 */
function articleDate(article) {
  return localDate(new Date(article.modifiedAt))
}
