// Beer 的 Markdown 编辑器：CodeMirror 6 + 类似 Obsidian「实时预览」的显示方式。
// 光标所在的行 / 片段显示原文，其余地方隐藏 Markdown 标记，标题、粗体、链接、图片、列表、引用直接排版。
//
// 这里是源码；`npm run build:editor` 用 esbuild 打成 client/editor.js（一个 ES 模块），
// 由 Beer 服务端 GET /api/beer/client/editor.js 提供，面板进入编辑时才按需加载。
//
//   const editor = createLiveEditor({ parent, doc, imageUrl, uploadImage, onError, onChange, onSave, ariaLabel })
//   uploadImage(file) → Promise<写进正文的相对路径>：粘贴 / 拖入图片时调用
//   editor.getValue() / editor.setValue(text) / editor.focus() / editor.destroy()
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxTree, syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

// ---------- 小部件 ----------

class ImageWidget extends WidgetType {
  constructor(src, alt, width) {
    super()
    this.src = src
    this.alt = alt
    this.width = width
  }
  eq(other) { return other.src === this.src && other.width === this.width && other.alt === this.alt }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-beer-img'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt || ''
    img.loading = 'lazy'
    if (this.width) img.style.width = this.width + 'px'
    img.onerror = () => {
      wrap.textContent = '图片没找到：' + (this.alt || this.src)
      wrap.className = 'cm-beer-img missing'
    }
    wrap.appendChild(img)
    return wrap
  }
  ignoreEvent() { return false }
}

class TextWidget extends WidgetType {
  constructor(text, className) {
    super()
    this.text = text
    this.className = className
  }
  eq(other) { return other.text === this.text && other.className === this.className }
  toDOM() {
    const span = document.createElement('span')
    span.className = this.className
    span.textContent = this.text
    return span
  }
}

class RuleWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-beer-hr'
    return span
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) {
    super()
    this.checked = checked
    this.pos = pos
  }
  eq(other) { return other.checked === this.checked && other.pos === this.pos }
  toDOM(view) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-beer-task'
    box.checked = this.checked
    box.onmousedown = e => e.preventDefault()
    box.onclick = e => {
      e.preventDefault()
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    }
    return box
  }
  ignoreEvent() { return false }
}

// ---------- 实时预览 ----------

const hide = Decoration.replace({})
const line = cls => Decoration.line({ class: cls })
const mark = cls => Decoration.mark({ class: cls })

/** 选区是否碰到 [from, to]（含两端：光标贴着标记时也显示原文）。 */
function touches(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true
  return false
}

function lineTouched(state, pos) {
  const l = state.doc.lineAt(pos)
  return touches(state, l.from, l.to)
}

/** 文档开头的 --- 属性块：返回结束位置（含闭合行），没有返回 -1。 */
function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text !== '---') return -1
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text === '---') return doc.line(n).to
  }
  return -1
}

/** ![[x.png|300]] → { target, width, alt }；不是图片返回 null。 */
function wikiImage(inner) {
  const [target, ...rest] = inner.split('|')
  const clean = target.split('#')[0].trim()
  if (!IMAGE_EXT.test(clean)) return null
  const size = /^(\d+)(x\d+)?$/.exec((rest[rest.length - 1] ?? '').trim())
  return { target: clean, width: size ? Number(size[1]) : undefined, alt: size ? '' : rest.join('|').trim() }
}

function buildDecorations(view, options) {
  const { state } = view
  const doc = state.doc
  const items = [] // [from, to, decoration]
  const add = (from, to, deco) => items.push([from, to, deco])
  const fmEnd = frontmatterEnd(doc)

  if (fmEnd > 0) {
    for (let pos = 0; pos <= fmEnd;) {
      const l = doc.lineAt(pos)
      add(l.from, l.from, line('cm-beer-fm' + (l.number === 1 ? ' first' : l.to === fmEnd ? ' last' : '')))
      pos = l.to + 1
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: node => {
        if (node.from <= fmEnd) return node.name === 'Document' ? undefined : false
        const name = node.name
        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) {
          add(node.from, node.from, line('cm-beer-h cm-beer-h' + heading[1]))
          if (!lineTouched(state, node.from)) {
            const markNode = node.node.getChild('HeaderMark')
            if (markNode) {
              const end = Math.min(markNode.to + 1, doc.lineAt(node.from).to)
              add(markNode.from, end, hide)
            }
          }
          return
        }
        switch (name) {
          case 'StrongEmphasis':
          case 'Emphasis':
          case 'Strikethrough':
          case 'InlineCode': {
            const cls = { StrongEmphasis: 'cm-beer-strong', Emphasis: 'cm-beer-em', Strikethrough: 'cm-beer-del', InlineCode: 'cm-beer-code' }[name]
            add(node.from, node.to, mark(cls))
            if (!touches(state, node.from, node.to)) {
              const markName = { StrongEmphasis: 'EmphasisMark', Emphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' }[name]
              for (const child of node.node.getChildren(markName)) add(child.from, child.to, hide)
            }
            return
          }
          case 'Image': {
            const text = doc.sliceString(node.from, node.to)
            const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(text)
            if (!m) return false
            const [alt, size] = m[1].split('|')
            const width = /^\d+$/.test((size ?? '').trim()) ? Number(size.trim()) : undefined
            const widget = Decoration.widget({ widget: new ImageWidget(options.imageUrl(m[2]), alt, width), side: 1 })
            if (touches(state, node.from, node.to)) add(node.to, node.to, widget)
            else add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(options.imageUrl(m[2]), alt, width) }))
            return false
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark')
            const url = node.node.getChild('URL')
            // 只处理 [文字](网址)；[[双链]] 里那层 [..] 也会被认成链接，交给下面的双链处理
            if (marks.length < 2 || !url) return false
            const textFrom = marks[0].to
            const textTo = marks[1].from
            if (textTo > textFrom) add(textFrom, textTo, Decoration.mark({ class: 'cm-beer-link', attributes: url ? { title: doc.sliceString(url.from, url.to) } : {} }))
            if (!touches(state, node.from, node.to)) {
              add(node.from, textFrom, hide)
              add(textTo, node.to, hide)
            }
            return false
          }
          case 'Blockquote': {
            for (let pos = node.from; pos <= node.to;) {
              const l = doc.lineAt(pos)
              add(l.from, l.from, line('cm-beer-quote'))
              pos = l.to + 1
            }
            return
          }
          case 'QuoteMark': {
            if (!lineTouched(state, node.from)) {
              const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
              add(node.from, end, hide)
            }
            return
          }
          case 'ListMark': {
            const markText = doc.sliceString(node.from, node.to)
            const after = node.node.nextSibling
            const isTask = after?.name === 'Task'
            if (/^[-*+]$/.test(markText) && !lineTouched(state, node.from)) {
              if (isTask) add(node.from, Math.min(node.to + 1, after.from), hide)
              else add(node.from, node.to, Decoration.replace({ widget: new TextWidget('•', 'cm-beer-bullet') }))
            }
            return
          }
          case 'TaskMarker': {
            const checked = /x/i.test(doc.sliceString(node.from, node.to))
            if (!lineTouched(state, node.from)) {
              add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }))
            }
            if (checked) {
              const l = doc.lineAt(node.from)
              if (node.to + 1 < l.to) add(node.to + 1, l.to, mark('cm-beer-done'))
            }
            return
          }
          case 'HorizontalRule': {
            if (!lineTouched(state, node.from)) add(node.from, node.to, Decoration.replace({ widget: new RuleWidget() }))
            return false
          }
          case 'FencedCode':
          case 'CodeBlock': {
            for (let pos = node.from; pos <= node.to;) {
              const l = doc.lineAt(pos)
              const edge = name === 'FencedCode' && (l.from === node.from || l.to === node.to)
              add(l.from, l.from, line('cm-beer-codeblock' + (edge ? ' fence' : '')))
              pos = l.to + 1
            }
            return false
          }
        }
      },
    })

    // [[双链]] 和 ![[嵌入]]：markdown 语法树里没有，按行用正则找（跳过代码块里的）。
    const re = /(!?)\[\[([^\]\n]+)\]\]/g
    const text = doc.sliceString(from, to)
    let m
    while ((m = re.exec(text))) {
      const start = from + m.index
      const end = start + m[0].length
      if (start <= fmEnd || inCode(state, start)) continue
      const inner = m[2]
      const active = touches(state, start, end)
      if (m[1]) {
        const img = wikiImage(inner)
        if (img) {
          const widget = new ImageWidget(options.imageUrl(img.target), img.alt || img.target, img.width)
          if (active) add(end, end, Decoration.widget({ widget, side: 1 }))
          else add(start, end, Decoration.replace({ widget }))
          continue
        }
      }
      const pipe = inner.lastIndexOf('|')
      const shownFrom = start + m[1].length + 2 + (pipe >= 0 ? pipe + 1 : 0)
      add(shownFrom, end - 2, mark('cm-beer-wiki'))
      if (!active) {
        add(start, shownFrom, hide)
        add(end - 2, end, hide)
      }
    }
  }

  // 替换区间不能互相重叠：按起点排好，和前一个替换重叠的丢掉（比如链接里套着的强调标记）。
  const isReplace = deco => deco === hide || (deco.spec?.widget !== undefined && deco.spec?.side === undefined)
  const kept = []
  let replacedTo = -1
  for (const item of items.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const [from, to, deco] = item
    if (isReplace(deco)) {
      if (from === to) continue
      if (from < replacedTo) continue
      replacedTo = to
    } else if (from < replacedTo && to <= replacedTo && from !== to) continue // 被整段替换掉的样式不用加
    kept.push(deco.range(from, to))
  }
  return Decoration.set(kept, true)
}

function inCode(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') return true
  }
  return false
}

function livePreview(options) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecorations(view, options) }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildDecorations(u.view, options)
      }
    }
  }, { decorations: v => v.decorations })
}

// ---------- 快捷键：加粗 / 斜体 ----------

function toggleWrap(marker) {
  return view => {
    const { state } = view
    const changes = state.changeByRange(range => {
      const text = state.sliceDoc(range.from, range.to)
      const before = state.sliceDoc(range.from - marker.length, range.from)
      const after = state.sliceDoc(range.to, range.to + marker.length)
      if (before === marker && after === marker) {
        return {
          changes: [{ from: range.from - marker.length, to: range.from }, { from: range.to, to: range.to + marker.length }],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        }
      }
      return {
        changes: { from: range.from, to: range.to, insert: marker + text + marker },
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      }
    })
    view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

// ---------- 粘贴 / 拖入图片 ----------

let uploadSeq = 0

/** 先插一个占位，存好后换成 ![](images/xx.png)；失败就删掉占位并报错。 */
function insertImages(view, files, pos, options) {
  for (const file of files) {
    const marker = `![正在保存图片…](beer-upload-${++uploadSeq})`
    let at = pos ?? view.state.selection.main.from
    const fmEnd = frontmatterEnd(view.state.doc)
    if (at <= fmEnd) { at = fmEnd; pos = at } // 不插进开头属性块里
    const prefix = at > 0 && view.state.sliceDoc(at - 1, at) !== '\n' ? '\n' : ''
    const insert = prefix + marker + '\n'
    view.dispatch({
      changes: { from: at, to: pos == null ? view.state.selection.main.to : at, insert },
      selection: { anchor: at + insert.length },
      userEvent: 'input.paste',
    })
    pos = null
    const replace = text => {
      const doc = view.state.doc.toString()
      const i = doc.indexOf(marker)
      if (i < 0) return
      view.dispatch({ changes: { from: i, to: i + marker.length + (text ? 0 : 1), insert: text }, userEvent: 'input.paste' })
    }
    Promise.resolve()
      .then(() => options.uploadImage(file))
      .then(link => replace(`![](${link})`))
      .catch(e => {
        replace('')
        options.onError?.(e?.message || '图片没有保存成功')
      })
  }
}

function imageFilesOf(transfer) {
  return [...(transfer?.files ?? [])].filter(f => /^image\//.test(f.type))
}

function imageDropAndPaste(options) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!options.uploadImage) return false
      const files = imageFilesOf(event.clipboardData)
      if (!files.length) return false
      event.preventDefault()
      insertImages(view, files, null, options)
      return true
    },
    drop(event, view) {
      if (!options.uploadImage) return false
      const files = imageFilesOf(event.dataTransfer)
      if (!files.length) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      insertImages(view, files, pos == null ? null : view.state.doc.lineAt(pos).to, options)
      return true
    },
  })
}

// ---------- 外观 ----------

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700', color: 'var(--ink, #2b2621)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--ink3, #a39a8f)' },
  { tag: t.monospace, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' },
  { tag: [t.link, t.url], color: 'var(--accent-ink, #b4482b)' },
  { tag: t.quote, color: 'var(--ink2, #6f665c)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px', backgroundColor: '#fff', color: 'var(--ink, #2b2621)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '14px 22px 60px', maxWidth: '860px', caretColor: 'var(--accent, #d9694a)' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#f6d6c9 !important' },
  '.cm-beer-h': { fontWeight: '700', lineHeight: '1.4' },
  '.cm-beer-h1': { fontSize: '1.6em', paddingTop: '.5em !important' },
  '.cm-beer-h2': { fontSize: '1.35em', paddingTop: '.45em !important' },
  '.cm-beer-h3': { fontSize: '1.17em', paddingTop: '.35em !important' },
  '.cm-beer-h4, .cm-beer-h5, .cm-beer-h6': { fontSize: '1.05em' },
  '.cm-beer-strong': { fontWeight: '700' },
  '.cm-beer-em': { fontStyle: 'italic' },
  '.cm-beer-del': { textDecoration: 'line-through', color: 'var(--ink2, #6f665c)' },
  '.cm-beer-code': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '.88em', backgroundColor: 'var(--bg, #f3efe8)', borderRadius: '4px', padding: '1px 3px' },
  '.cm-beer-link, .cm-beer-wiki': { color: 'var(--accent-ink, #b4482b)', textDecoration: 'underline', textDecorationColor: 'rgba(180,72,43,.35)', textUnderlineOffset: '3px' },
  '.cm-beer-quote': { borderLeft: '3px solid var(--line, #e6dfd4)', paddingLeft: '12px !important', color: 'var(--ink2, #6f665c)' },
  '.cm-beer-bullet': { color: 'var(--ink3, #a39a8f)', padding: '0 .25em' },
  '.cm-beer-task': { margin: '0 .4em 0 0', verticalAlign: 'middle', cursor: 'pointer', accentColor: 'var(--accent, #d9694a)' },
  '.cm-beer-done': { color: 'var(--ink3, #a39a8f)', textDecoration: 'line-through' },
  '.cm-beer-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--line, #e6dfd4)', verticalAlign: 'middle' },
  '.cm-beer-codeblock': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '13px', backgroundColor: 'var(--bg, #f3efe8)', padding: '0 12px !important' },
  '.cm-beer-codeblock.fence': { color: 'var(--ink3, #a39a8f)' },
  '.cm-beer-fm': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '12.5px', color: 'var(--ink2, #6f665c)', backgroundColor: 'var(--bg, #f3efe8)', padding: '0 12px !important' },
  '.cm-beer-fm.first': { borderRadius: '8px 8px 0 0', paddingTop: '4px !important' },
  '.cm-beer-fm.last': { borderRadius: '0 0 8px 8px', paddingBottom: '4px !important', marginBottom: '6px' },
  '.cm-beer-img': { display: 'inline-block', maxWidth: '100%', verticalAlign: 'top', margin: '4px 0' },
  '.cm-beer-img img': { display: 'block', maxWidth: '100%', height: 'auto', borderRadius: '6px' },
  '.cm-beer-img.missing': { color: 'var(--ink3, #a39a8f)', backgroundColor: 'var(--bg, #f3efe8)', borderRadius: '4px', padding: '0 6px', fontSize: '12px' },
  '.cm-panels': { backgroundColor: 'var(--paper, #fbf8f3)', borderColor: 'var(--line, #e6dfd4)' },
})

// ---------- 对外接口 ----------

export function createLiveEditor({ parent, doc = '', imageUrl = src => src, uploadImage, onError, onChange, onSave, ariaLabel, autofocus = true }) {
  const callbacks = { onChange, onSave, uploadImage, onError }
  const editable = new Compartment()
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorView.lineWrapping,
        indentUnit.of('    '),
        // 不认 Setext 标题：开头属性块的 --- 不会把上一行变成标题（Obsidian 也这样显示）
        markdown({ base: markdownLanguage, extensions: [{ remove: ['SetextHeading'] }] }),
        syntaxHighlighting(highlight),
        livePreview({ imageUrl }),
        imageDropAndPaste({
          uploadImage: callbacks.uploadImage && (file => callbacks.uploadImage(file)),
          onError: msg => callbacks.onError?.(msg),
        }),
        theme,
        editable.of(EditorView.editable.of(true)),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel || '编辑', spellcheck: 'false' }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { callbacks.onSave?.(); return true } },
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          ...markdownKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of(u => {
          if (u.docChanged) callbacks.onChange?.(u.state.doc.toString())
        }),
      ],
    }),
  })
  if (autofocus) view.focus()
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      if (text === view.state.doc.toString()) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    setCallbacks(next) { Object.assign(callbacks, next) },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
