// 演示用的示例 Obsidian 库：{ 库内相对路径: 文件内容 }。内容都是虚构的。
const pad = n => String(n).padStart(2, '0')
const day = offset => {
  const d = new Date(Date.now() - offset * 86400_000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const material = ({ title, type, tags, source, summary, body }) => `---
标题: ${title}
类型: ${type}
标签: [${tags.join(', ')}]
状态: 未使用
来源: ${source}
摘要: ${summary}
---

# ${title}

${body}
`

const article = ({ title, status, date, body }) => `---
标题: ${title}
状态: ${status}
日期: ${date}
---

# ${title}

${body}
`

/** 演示里已是「成稿」的那篇文章，启动时给它生成平台版本。 */
export const demoArticlePath = () => `内容库/文章/${day(4)}-我的写作工作台/index.md`

export function demoVault() {
  const today = day(0)
  return {
    [`内容库/素材/${day(1)}-讲座-个人知识管理的十年/index.md`]: material({
      title: '讲座-个人知识管理的十年',
      type: '课程讲座',
      tags: ['知识管理', '写作'],
      source: '录音',
      summary: '讲者回顾十年笔记工具迁移，结论是工具会换，三个习惯留了下来：随手记、每周回顾、写给别人看。',
      body: '## 摘要\n\n- 工具换了五次，真正留下来的是习惯\n- 随手记：先记下来，不分类\n- 每周回顾：把散落的笔记连起来\n- 写给别人看：输出倒逼整理',
    }),
    [`内容库/素材/${day(1)}-讲座-个人知识管理的十年/transcript.md`]: '# 讲座-个人知识管理的十年\n\n[00:00] 大家好，今天想聊聊我做个人知识管理的这十年……\n[03:12] 第一个习惯是随手记。不要想着分类，先记下来……\n[11:40] 第二个习惯是每周回顾……\n',
    [`内容库/素材/${day(2)}-从笔记到文章/index.md`]: material({
      title: '从笔记到文章：一条可复用的流水线',
      type: '链接',
      tags: ['写作', '工具'],
      source: 'https://example.com/notes-to-posts',
      summary: '作者用「收集 → 连接 → 成稿」三步把笔记变成文章，每一步都有固定的文件夹。',
      body: '文章把写作拆成三个阶段，每个阶段对应 Obsidian 里一个文件夹……',
    }),
    [`内容库/素材/${day(3)}-读者留言-选题从哪来/index.md`]: material({
      title: '读者留言：你的选题都从哪来？',
      type: '文字',
      tags: ['读者反馈', '写作'],
      source: '知乎评论',
      summary: '好几位读者问选题是怎么来的，是不是每天都在想写什么。',
      body: '> 想问一下作者，选题都是怎么来的？我每次想写东西都不知道写什么。\n\n> 同问，感觉每篇都很有积累。',
    }),
    [`内容库/素材/${day(5)}-慢下来的效率/index.md`]: material({
      title: '慢下来的效率',
      type: '链接',
      tags: ['效率'],
      source: 'https://example.com/slow-productivity',
      summary: '少做几件事、按自然节奏工作、追求质量，三条原则对写作同样适用。',
      body: '书评：作者提出三条原则……',
    }),

    [demoArticlePath()]: article({
      title: '我把写作搬进了一个工作台',
      status: '成稿',
      date: day(4),
      body: '过去半年，我把录音、素材、选题和发布都收进了一个工作台。\n\n## 为什么要搭\n\n素材散在手机、电脑和 NAS 上，每次写作前要花半小时找东西。\n\n## 现在的样子\n\n录音上传后自动转写和摘要，进素材库；每天早上有一份选题简报；写完确认一次，各平台版本自动生成。\n\n## 收获\n\n找素材的时间几乎没有了，写作本身的时间多了。',
    }),
    [`内容库/文章/${day(2)}-十年笔记三个习惯/index.md`]: article({
      title: '十年笔记，只剩三个习惯',
      status: '草稿',
      date: day(2),
      body: '工具换了五次，留下来的只有三个习惯。\n\n## 1. 随手记\n\n先记下来，不要急着分类。\n\n## 2. 每周回顾\n\n（待写）\n\n## 3. 写给别人看\n\n（待写）',
    }),
    [`内容库/文章/${today}-选题从哪来/index.md`]: article({
      title: '选题不是想出来的，是攒出来的',
      status: '选题',
      date: today,
      body: '',
    }),
    [`内容库/文章/${day(12)}-为什么用-Obsidian/index.md`]: article({
      title: '为什么我最后留在了 Obsidian',
      status: '已发布',
      date: day(12),
      body: '本地文件、Markdown、插件生态，三个理由就够了。',
    }),

    '内容库/规则/硬规则.md': '# 硬规则\n\n- 小红书版本不超过 1000 字\n- 知乎版本保留原文的小标题结构\n',
    '内容库/规则/软规则.md': '# 软规则\n\n- 小红书开头一句话点题，少用长句\n- 结尾留一个问题引导评论\n',
  }
}
