import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, Plus, X, FileText } from 'lucide-react'
import { cn } from '@/lib/cn'
import { RippleButton } from '@/components/shared/RippleButton'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useChatContext } from '@/context/ChatContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

const DETAIL_PHRASES = /\b(tell me more|elaborate|more detail|in detail|explain.*detail|expand on|go deeper|more info|more information|more thoroughly|walk me through|step by step|give me more|be specific|specifics)\b/i

const DETAIL_SUFFIX = '\n\n(Please give a thorough, detailed response for this message — ignore any brevity instructions.)'

interface Props {
  onSend: (text: string, attachments?: File[]) => void
  onStop?: () => void
  isGenerating?: boolean
  /** True while streaming but no tokens received yet — renders the wild thinking animation. */
  isThinking?: boolean
  placeholder?: string
  autoFocus?: boolean
  onTyping?: () => void
  /** Changing this number programmatically focuses the input (e.g. the ⌘J shortcut). */
  focusKey?: number
  /** When false, Photos option is disabled (no vision model available). */
  visionAvailable?: boolean
}

// The companion's text input. Self-contained local state; the overlay decides where
// the message goes (chat.submit on /chat, navigate+submit elsewhere). Visual style
// matches the retired GlobalChatInput InputBar.
export function CompanionComposer({ onSend, onStop, isGenerating = false, isThinking = false, placeholder = 'Message LokiDoki…', autoFocus = false, onTyping, focusKey, visionAvailable = true }: Props) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  // Document attachments live in chat context (extracted text persists to the conversation).
  const { attachedDocs, attachDocument, removeAttachedDoc, attachingDoc } = useChatContext()
  const inputRef = useRef<HTMLInputElement>(null)
  const photosInputRef = useRef<HTMLInputElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (autoFocus) inputRef.current?.focus() }, [autoFocus])
  useEffect(() => { if (focusKey !== undefined && focusKey > 0) { inputRef.current?.focus(); inputRef.current?.select() } }, [focusKey])

  function send() {
    const text = value.trim()
    if (!text && attachments.length === 0 && attachedDocs.length === 0) return
    // Doc-only send (no typed question) gets a sensible default prompt so the turn isn't empty.
    const base = text || (attachedDocs.length > 0 ? 'Please summarize the attached document(s).' : text)
    const finalText = DETAIL_PHRASES.test(base) ? `${base}${DETAIL_SUFFIX}` : base
    onSend(finalText, attachments.length > 0 ? attachments : undefined)
    setValue('')
    setAttachments([])
  }

  function addFiles(files: FileList | null) {
    if (!files) return
    const images: File[] = []
    for (const f of Array.from(files)) {
      // Images → vision attachments (sent via onSend). Everything else → document
      // extraction (text stuffed into the conversation context on submit).
      if (f.type.startsWith('image/')) images.push(f)
      else void attachDocument(f)
    }
    if (images.length) setAttachments(prev => [...prev, ...images].slice(0, 4))
  }

  function removeAttachment(index: number) {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <div className={cn('ai-ring', isGenerating && 'ai-ring--active', isThinking && 'ai-ring--thinking')}>
    <div className={cn(
      'rounded-[calc(1rem-1.5px)] border border-border bg-card transition-all focus-within:border-brand/50',
    )}>
      {/* Attachment chips (images + documents) */}
      {(attachments.length > 0 || attachedDocs.length > 0 || attachingDoc) && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {attachments.map((file, i) => (
            <div key={`img-${i}`} className="flex items-center gap-1 rounded-control bg-muted px-2 py-1 text-xs max-w-[120px]">
              <span className="truncate text-foreground/70">{file.name}</span>
              <button onClick={() => removeAttachment(i)} className="shrink-0 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {attachedDocs.map((doc, i) => (
            <div key={`doc-${i}`} className="flex items-center gap-1 rounded-control bg-brand/10 px-2 py-1 text-xs max-w-[140px]" title={`${doc.chars.toLocaleString()} chars`}>
              <FileText className="size-3 shrink-0 text-brand" />
              <span className="truncate text-foreground/70">{doc.filename}</span>
              <button onClick={() => removeAttachedDoc(i)} className="shrink-0 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {attachingDoc && (
            <div className="flex items-center gap-1 rounded-control bg-muted px-2 py-1 text-xs text-muted-foreground">
              <Spinner size="sm" className="size-3" /> reading…
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-3">
        {/* Hidden file inputs */}
        <input
          ref={photosInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
        />
        <input
          ref={filesInputRef}
          type="file"
          accept="image/*,.pdf,.docx,.pptx,.html,.htm,.md,.markdown,.txt"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
        />

        {/* Attach dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-control transition-all',
                attachments.length > 0
                  ? 'text-brand hover:text-brand/80'
                  : 'text-foreground/25 hover:text-foreground/60',
              )}
              title="Attach"
            >
              <Plus className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-36">
            <DropdownMenuItem
              disabled={!visionAvailable}
              onSelect={() => photosInputRef.current?.click()}
            >
              Photos
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => filesInputRef.current?.click()}
            >
              Files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); onTyping?.() }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm text-foreground/90 outline-none placeholder:text-foreground/25"
        />

        {!value.trim() && !isGenerating && attachments.length === 0 && (
          <kbd className="hidden shrink-0 select-none rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground/30 sm:inline">
            {isMac ? '⌘' : 'Ctrl'} /
          </kbd>
        )}
        {isGenerating ? (
          <Button
            onClick={onStop}
            size="icon-sm"
            variant="ghost"
            className="stop-btn-animated shrink-0 hover:scale-110 active:scale-95"
          >
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <RippleButton
            onClick={send}
            disabled={!value.trim() && attachments.length === 0 && attachedDocs.length === 0}
            rippleColor="var(--background)"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors disabled:opacity-20"
          >
            <ArrowUp className="size-3.5" />
          </RippleButton>
        )}
      </div>
    </div>
    </div>
  )
}
