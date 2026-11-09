// 本机时区的日期文本：条目文件夹名、frontmatter 里的日期和发布记录都用这一份，别各写一遍。
//   localDate(date)     → 2026-11-06
//   localDateTime(date) → 2026-11-06 18:30
export function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localDateTime(date) {
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pad(n) {
  return String(n).padStart(2, '0')
}
