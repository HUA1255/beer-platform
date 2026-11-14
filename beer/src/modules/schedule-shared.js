// 日程模块之间共用的小工具，避免 schedule.js / schedule-tools.js / schedule-reminders.js
// 各写一份星期名称、分组标题和扁平化逻辑。这里只放纯数据和纯函数，不依赖任何模块。
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 重复规则小标签用的单字：日 / 一 / 二 … */
export const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']

export const GROUP_LABELS = {
  overdue: '已逾期',
  today: '今天',
  week: '本周',
  later: '以后',
  unscheduled: '没排期',
}

/** 顶层事项 + 所有层级的子步骤，拍平成一个数组。 */
export function flattenItems(items) {
  const out = []
  for (const item of items ?? []) {
    out.push(item)
    out.push(...flattenItems(item.subtasks))
  }
  return out
}
