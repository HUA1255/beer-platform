// 首页：把各模块「今天要处理什么」汇总成一次请求，只做汇总，不复制业务逻辑。
//   GET  /api/beer/home[?ensure=1]        → { date, tasks, recordings, week, rules }
//        ensure=1 时今天还没有选题简报就先调 topics 生成（模拟每天第一次打开）；
//        生成失败不让首页 500，tasks.brief 带 exists: false 和 error。
//   POST /api/beer/home/brief/regenerate  → { path, content, angles }
//
// - tasks.publishPending 复用 articles.readArticles，只取状态「成稿」「已确认」，不读发布记录。
// - tasks.brief 复用 topics.todayBrief / topics.ensureBrief：今天简报的路径和文件是否存在；
//   generatedToday 就是「今天的文件在」。
// - tasks.editConflicts 读 library.readEditConflicts 的最近几条（保存冲突时留下的记录）。
// - recordings 复用 recordings.recordingSummary；家里连不上时 online: false + error，不让整个首页 500。
// - week 从本周一（本机时区）起算，比较到「天」：
//     materials：素材条目路径里的日期（`内容库/素材/YYYY-MM-DD-…`），没有日期前缀时按修改时间；
//     drafts / published：文章当前状态是「成稿」/「已发布」，且文件修改时间在本周
//     （改状态时文件会更新，所以修改时间可以当作进入该状态的时间）。
// - rules 复用 rules.ruleSummary，只给数字（硬 / 软规则数、待转正数）。
import { PUBLISHABLE_STATUSES } from './publish.js'
import { STATUS_FINAL, STATUS_PUBLISHED, readArticles } from './articles.js'
import { listMaterialEntries } from './materials.js'
import { readEditConflicts } from './library.js'
import { recordingSummary } from './recordings.js'
import { ruleSummary } from './rules.js'
import { BRIEFS_DIR, ensureBrief, regenerateBrief, todayBrief } from './topics.js'
import { localDate } from '../dates.js'

/** 首页只显示最近几条编辑冲突，完整记录最多留 50 条。 */
const CONFLICTS_SHOWN = 5

export function register(router, ctx) {
  router.get('/home', async req => home(ctx, { ensure: req.query.get('ensure') === '1' }))
  router.post('/home/brief/regenerate', async () => {
    const result = await regenerateBrief(ctx)
    return { path: result.briefPath, content: result.content, angles: result.angles }
  })
}

async function home(ctx, { ensure = false } = {}) {
  const [articles, brief, materials, editConflicts, recordings, rules] = await Promise.all([
    readArticles(ctx),
    briefForHome(ctx, ensure),
    listMaterialEntries(ctx),
    readEditConflicts(ctx),
    recordingSummary(ctx),
    ruleSummary(ctx),
  ])
  return {
    date: localDate(ctx.now()),
    tasks: {
      publishPending: articles
        .filter(article => PUBLISHABLE_STATUSES.includes(article.status))
        .map(({ path, title, status }) => ({ path, title, status })),
      brief: {
        path: brief.path,
        exists: brief.exists,
        generatedToday: brief.exists,
        ...(brief.error ? { error: brief.error } : {}),
      },
      editConflicts: editConflicts.slice(0, CONFLICTS_SHOWN),
    },
    recordings,
    week: weekOf(ctx.now(), materials, articles),
    rules,
  }
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
