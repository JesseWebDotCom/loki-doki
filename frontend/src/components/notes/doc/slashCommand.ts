// "/" block-insert menu (Outline's block menu): typing "/" at the start of an
// empty paragraph opens a filterable list of block types. Built on
// @tiptap/suggestion; the React popup lives in NoteDocEditor and is driven
// through the controller callbacks below.

import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion'
import {
  Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, TextQuote, Code2, Minus,
  type LucideIcon,
} from 'lucide-react'

export interface SlashItem {
  title: string
  keywords: string
  icon: LucideIcon
  /** Outline groups its block menu with separators; same section = same group. */
  section: number
  run: (editor: Editor, range: Range) => void
}

// Order and grouping mirror Outline's block menu (app/editor/menus/block.tsx):
// headings | lists (todo first) | blocks.
export const SLASH_ITEMS: SlashItem[] = [
  { title: 'Big heading',    keywords: 'h1 heading1 title',     icon: Heading1,   section: 0, run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
  { title: 'Medium heading', keywords: 'h2 heading2 subtitle',  icon: Heading2,   section: 0, run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
  { title: 'Small heading',  keywords: 'h3 heading3',           icon: Heading3,   section: 0, run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
  { title: 'Todo list',      keywords: 'checkbox checklist task', icon: ListTodo, section: 1, run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: 'Bulleted list',  keywords: 'unordered ul bullet',   icon: List,       section: 1, run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: 'Ordered list',   keywords: 'numbered ol',           icon: ListOrdered, section: 1, run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: 'Quote',          keywords: 'blockquote',            icon: TextQuote,  section: 2, run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: 'Code block',     keywords: 'code snippet pre',      icon: Code2,      section: 2, run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: 'Divider',        keywords: 'horizontal rule hr separator', icon: Minus, section: 2, run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
]

export interface SlashMenuState {
  items: SlashItem[]
  clientRect: (() => DOMRect | null) | null
  command: (item: SlashItem) => void
}

/** Bridge between the Suggestion plugin lifecycle and the React popup. */
export interface SlashController {
  onOpen: (state: SlashMenuState) => void
  onUpdate: (state: SlashMenuState) => void
  onClose: () => void
  /** Return true when the key was handled by the popup (arrows/enter/escape). */
  onKeyDown: (event: KeyboardEvent) => boolean
}

export function createSlashExtension(controller: SlashController) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: '/',
          // Outline opens its block menu after line start OR whitespace, not only
          // on empty paragraphs; Suggestion's default allowedPrefixes ([' ']) plus
          // startOfLine:false matches that.
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }: { query: string }) => {
            const q = query.toLowerCase()
            return SLASH_ITEMS.filter((i) => !q || i.title.toLowerCase().includes(q) || i.keywords.includes(q))
          },
          command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
            props.run(editor, range)
          },
          render: () => ({
            onStart: (props: SuggestionProps<SlashItem>) => {
              controller.onOpen({
                items: props.items,
                clientRect: props.clientRect ? () => props.clientRect?.() ?? null : null,
                command: props.command,
              })
            },
            onUpdate: (props: SuggestionProps<SlashItem>) => {
              controller.onUpdate({
                items: props.items,
                clientRect: props.clientRect ? () => props.clientRect?.() ?? null : null,
                command: props.command,
              })
            },
            onKeyDown: (props: SuggestionKeyDownProps) => controller.onKeyDown(props.event),
            onExit: () => controller.onClose(),
          }),
        }),
      ]
    },
  })
}
