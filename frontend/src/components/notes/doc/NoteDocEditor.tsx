// Outline-style WYSIWYG document editor for notes. One seamless writing surface:
// markdown input rules convert live (## , - , 1. , [ ] , > , ``` , ---), a "/" at
// the start of an empty paragraph opens the block menu, and selecting text raises
// a floating format toolbar. Markdown stays the storage format (tiptap-markdown
// serializes on every update) so backend FTS/RAG/chunking are untouched.
//
// Statically imports TipTap/ProseMirror, so it MUST only be reached via lazy()
// (same bundle rule as CanvasEditor).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, TextQuote,
  ListTodo, List, ListOrdered, Link2, Check, X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Input } from '@/components/ui/input'
import { createSlashExtension, type SlashItem, type SlashMenuState } from './slashCommand'
import './notedoc.css'

// Exact strings from Outline (app/scenes/Document/components/Editor.tsx +
// app/editor/extensions/BlockMenu.tsx).
const PLACEHOLDER_EMPTY_DOC = "Type '/' to insert, or start writing…"
const PLACEHOLDER_EMPTY_PARAGRAPH = "Type '/' to insert…"

/** Commands the page uses to hand focus from the title into the document. */
export interface NoteDocController {
  /** Focus the body start; when insertParagraph (Enter in title, Outline-style),
   *  a fresh empty paragraph is inserted at the top first. */
  focusStart: (insertParagraph?: boolean) => void
  focusEnd: () => void
}

// ── "/" block menu popup ─────────────────────────────────────────────────────────

function SlashMenuPopup({ state, selected }: { state: SlashMenuState; selected: number }) {
  const rect = state.clientRect?.()
  if (!rect) return null
  return (
    <div
      className="fixed z-50 w-56 overflow-hidden rounded-card border border-border bg-popover p-1 shadow-lg"
      style={{ left: rect.left, top: rect.bottom + 6 }}
    >
      {state.items.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">No blocks match</p>
      )}
      {state.items.map((item, i) => (
        <div key={item.title}>
          {i > 0 && state.items[i - 1]!.section !== item.section && <div className="mx-2 my-1 h-px bg-border/60" />}
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); state.command(item) }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-sm',
              i === selected ? 'bg-accent text-foreground' : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {item.title}
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Selection toolbar ────────────────────────────────────────────────────────────

function ToolbarButton({ active, onClick, label, children }: {
  active?: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      className={cn(
        'flex size-7 items-center justify-center rounded-control transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────────

export default function NoteDocEditor({ value, onChange, editable, autoFocus, onFocusTitle, controllerRef }: {
  /** Markdown source of truth. */
  value: string
  onChange: (markdown: string) => void
  editable: boolean
  autoFocus?: boolean
  /** Called when the caret should return to the title (ArrowUp at doc start). */
  onFocusTitle?: () => void
  /** Receives imperative focus commands for the title → body handoff. */
  controllerRef?: React.MutableRefObject<NoteDocController | null>
}) {
  const lastEmitted = useRef(value)
  const [slash, setSlash] = useState<SlashMenuState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const slashRef = useRef<{ state: SlashMenuState | null; index: number }>({ state: null, index: 0 })
  slashRef.current = { state: slash, index: slashIndex }

  const slashExtension = useMemo(() => createSlashExtension({
    onOpen: (s) => { setSlash(s); setSlashIndex(0) },
    onUpdate: (s) => { setSlash(s); setSlashIndex(0) },
    onClose: () => setSlash(null),
    onKeyDown: (event) => {
      const { state, index } = slashRef.current
      if (!state) return false
      if (event.key === 'ArrowDown') { setSlashIndex((index + 1) % Math.max(1, state.items.length)); return true }
      if (event.key === 'ArrowUp') { setSlashIndex((index - 1 + state.items.length) % Math.max(1, state.items.length)); return true }
      if (event.key === 'Enter') { const item = state.items[index] as SlashItem | undefined; if (item) state.command(item); return true }
      if (event.key === 'Escape') { setSlash(null); return true }
      return false
    },
  }), []) // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    editable,
    autofocus: autoFocus ? 'start' : false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        // Outline: the empty doc invites writing; any other empty paragraph under
        // the caret hints at the block menu.
        placeholder: ({ editor: e }) => (e.state.doc.textContent === '' ? PLACEHOLDER_EMPTY_DOC : PLACEHOLDER_EMPTY_PARAGRAPH),
        showOnlyCurrent: true,
      }),
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
      slashExtension,
    ],
    content: value,
    editorProps: {
      handleKeyDown: (view, event) => {
        // ArrowUp with the caret at the very start of the doc walks back up into
        // the title (Outline's UpArrowAtStart pattern).
        if (!onFocusTitle) return false
        const { from, empty } = view.state.selection
        if (event.key === 'ArrowUp' && empty && from === 1) {
          onFocusTitle()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = (e.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()
      lastEmitted.current = md
      onChange(md)
    },
  })

  // External value changes (initial hydrate, route change) reset the doc; edits we
  // emitted ourselves must never round-trip back in or the caret jumps.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return
    lastEmitted.current = value
    editor.commands.setContent(value)
  }, [editor, value])

  useEffect(() => { editor?.setEditable(editable) }, [editor, editable])

  // Title → body handoff (Outline's handleGoToNextInput): Enter in the title
  // inserts a fresh paragraph at doc start, Tab/ArrowDown just moves the caret.
  useEffect(() => {
    if (!controllerRef || !editor) return
    controllerRef.current = {
      focusStart: (insertParagraph) => {
        if (insertParagraph) {
          const paragraph = editor.state.schema.nodes['paragraph']
          if (paragraph) editor.view.dispatch(editor.state.tr.insert(0, paragraph.create()))
        }
        editor.chain().focus('start').run()
      },
      focusEnd: () => editor.chain().focus('end').run(),
    }
    return () => { controllerRef.current = null }
  }, [controllerRef, editor])

  // Link editing state inside the bubble toolbar (Outline embeds an input in the
  // selection toolbar rather than opening a dialog).
  const [linkMode, setLinkMode] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  useEffect(() => { if (!editor) return; setLinkMode(false) }, [editor])

  function applyLink() {
    if (!editor) return
    const url = linkValue.trim()
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    else editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkMode(false)
  }

  if (!editor) return null

  return (
    <div
      className="notedoc min-h-full flex-1 cursor-text"
      // Clicking the empty tail below the last block drops the caret at the end.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) { e.preventDefault(); editor.chain().focus('end').run() }
      }}
    >
      {editable && (
        <BubbleMenu
          editor={editor}
          tippyOptions={{ duration: 100, maxWidth: 'none' }}
          shouldShow={({ editor: e, state }) => !state.selection.empty && !e.isActive('codeBlock')}
        >
          <div className="flex items-center gap-0.5 rounded-card border border-border bg-popover p-1 shadow-lg">
            {linkMode ? (
              <div className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={linkValue}
                  onChange={(e) => setLinkValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); applyLink() }
                    if (e.key === 'Escape') setLinkMode(false)
                  }}
                  placeholder="Paste a link…"
                  className="h-7 w-56 border-none text-base shadow-none focus-visible:ring-0 md:text-sm"
                />
                <ToolbarButton label="Apply link" onClick={applyLink}><Check className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Cancel" onClick={() => setLinkMode(false)}><X className="size-3.5" /></ToolbarButton>
              </div>
            ) : (
              <>
                {/* Outline's formatting toolbar order: marks | headings + quote | lists | link */}
                <ToolbarButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code className="size-3.5" /></ToolbarButton>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <ToolbarButton label="Big heading" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Medium heading" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Small heading" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><TextQuote className="size-3.5" /></ToolbarButton>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <ToolbarButton label="Todo list" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListTodo className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="size-3.5" /></ToolbarButton>
                <ToolbarButton label="Ordered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="size-3.5" /></ToolbarButton>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <ToolbarButton label="Create link" active={editor.isActive('link')} onClick={() => {
                  setLinkValue((editor.getAttributes('link').href as string | undefined) ?? '')
                  setLinkMode(true)
                }}><Link2 className="size-3.5" /></ToolbarButton>
              </>
            )}
          </div>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {slash && <SlashMenuPopup state={slash} selected={slashIndex} />}
    </div>
  )
}
