import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowDown, Circle, ClipboardCheck, ClipboardCopy, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'

interface LogEntry {
  id: number
  level: number
  time: number
  msg: string
  method?: string
  path?: string
  status?: number
  ms?: number
  err?: { message?: string; stack?: string }
  [key: string]: unknown
}

const LEVEL_META: Record<number, { label: string; row: string; badge: string }> = {
  10: { label: 'TRC', row: 'text-zinc-500',  badge: 'bg-zinc-800 text-zinc-400' },
  20: { label: 'DBG', row: 'text-blue-300',  badge: 'bg-blue-950 text-blue-400' },
  30: { label: 'INF', row: 'text-zinc-200',  badge: 'bg-emerald-950 text-emerald-400' },
  40: { label: 'WRN', row: 'text-amber-300', badge: 'bg-amber-950 text-amber-400' },
  50: { label: 'ERR', row: 'text-red-300',   badge: 'bg-red-950 text-red-400' },
  60: { label: 'FTL', row: 'text-red-200',   badge: 'bg-red-900 text-red-300' },
}

function levelMeta(level: number) {
  const key = [60, 50, 40, 30, 20, 10].find((k) => level >= k) ?? 30
  return LEVEL_META[key] ?? LEVEL_META[30]!
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  const ms = d.getMilliseconds().toString().padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function formatExtra(entry: LogEntry): string {
  const skip = new Set(['level', 'time', 'pid', 'hostname', 'msg'])
  const parts: string[] = []
  for (const [k, v] of Object.entries(entry)) {
    if (skip.has(k) || k === 'id') continue
    if (k === 'err' && typeof v === 'object' && v !== null) {
      const err = v as { message?: string }
      parts.push(`err="${err.message ?? String(v)}"`)
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`)
    }
  }
  return parts.join(' ')
}

// Detect Python-style log levels from raw text lines
function detectTextLevel(raw: string): number {
  if (/\bDEBUG\b/.test(raw))              return 20
  if (/\bWARNING\b|\bWARN\b/.test(raw))  return 40
  if (/\bERROR\b|\bCRITICAL\b/.test(raw)) return 50
  return 30
}

const FILTER_LEVELS = [
  { label: 'All',   min: 0  },
  { label: 'Debug', min: 20 },
  { label: 'Info',  min: 30 },
  { label: 'Warn',  min: 40 },
  { label: 'Error', min: 50 },
]

const MAX_ENTRIES = 1000

interface LogViewerProps {
  /** SSE endpoint to stream from. Defaults to app logs. */
  streamUrl?: string
  /** 'json' for pino structured logs; 'text' for plain-text lines wrapped in {time,raw}. */
  mode?: 'json' | 'text'
}

export function LogViewer({ streamUrl = '/api/logs/stream', mode = 'json' }: LogViewerProps) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [filterMin, setFilterMin] = useState(0)
  const [atBottom, setAtBottom] = useState(true)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [copied, setCopied] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)

  const appendLine = useCallback((raw: string) => {
    try {
      let entry: Omit<LogEntry, 'id'>

      if (mode === 'text') {
        const { time, raw: text } = JSON.parse(raw) as { time: number; raw: string }
        entry = { time, level: detectTextLevel(text), msg: text }
      } else {
        entry = JSON.parse(raw) as Omit<LogEntry, 'id'>
      }

      setEntries((prev) => {
        const next = [...prev, { ...entry, id: idRef.current++ }]
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
      })
    } catch {
      // unparseable line — skip
    }
  }, [mode])

  useEffect(() => {
    // Reset entries when the stream URL or mode changes
    setEntries([])
    idRef.current = 0

    let es: EventSource
    let retryTimer: ReturnType<typeof setTimeout>

    function connect() {
      setStatus('connecting')
      es = new EventSource(streamUrl, { withCredentials: true })

      es.addEventListener('log', (e) => {
        appendLine(e.data)
      })

      es.onopen = () => setStatus('connected')

      es.onerror = () => {
        setStatus('disconnected')
        es.close()
        retryTimer = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      es?.close()
      clearTimeout(retryTimer)
    }
  }, [streamUrl, appendLine])

  // Auto-scroll
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries, atBottom])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAtBottom(nearBottom)
  }

  function scrollToBottom() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }

  const visible = entries.filter((e) => e.level >= filterMin)

  function copyToClipboard() {
    const text = visible
      .map((entry) => {
        const meta = levelMeta(entry.level)
        const extra = mode === 'json' ? formatExtra(entry) : ''
        return `[${formatTime(entry.time)}] ${meta.label} ${entry.msg}${extra ? ' | ' + extra : ''}`
      })
      .join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 shrink-0">
        {/* Connection status */}
        <Circle
          className={cn('size-2 shrink-0 fill-current', {
            'text-amber-400': status === 'connecting',
            'text-emerald-400': status === 'connected',
            'text-red-400': status === 'disconnected',
          })}
        />
        <span className="text-[11px] text-muted-foreground capitalize mr-2">{status}</span>

        {/* Level filters */}
        <div className="flex items-center gap-0.5">
          {FILTER_LEVELS.map((f) => (
            <button
              key={f.min}
              onClick={() => setFilterMin(f.min)}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] transition-colors',
                filterMin === f.min
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <span className="text-[11px] text-muted-foreground">{visible.length} entries</span>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={copyToClipboard}
          title={copied ? 'Copied!' : 'Copy all visible logs'}
        >
          {copied ? <ClipboardCheck className="size-3.5 text-emerald-400" /> : <ClipboardCopy className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setEntries([])}
          title="Clear"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* Log area */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative flex-1 min-h-0 overflow-y-auto bg-zinc-950 font-mono text-xs leading-5"
      >
        {visible.length === 0 ? (
          <p className="flex items-center justify-center h-full text-zinc-600">
            Waiting for logs…
          </p>
        ) : (
          <div className="p-2 space-y-px">
            {visible.map((entry) => {
              const meta = levelMeta(entry.level)
              const extra = mode === 'json' ? formatExtra(entry) : ''
              return (
                <div key={entry.id} className={cn('flex gap-2 items-baseline', meta.row)}>
                  <span className="shrink-0 text-zinc-600">{formatTime(entry.time)}</span>
                  <span className={cn('shrink-0 rounded px-1 text-[10px] font-bold uppercase tracking-wider', meta.badge)}>
                    {meta.label}
                  </span>
                  <span className="flex-1 break-all">{entry.msg}</span>
                  {extra && (
                    <span className="shrink-0 text-zinc-600 text-[10px]">{extra}</span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Jump to bottom */}
        {!atBottom && (
          <button
            onClick={scrollToBottom}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-[11px] text-zinc-300 shadow hover:bg-zinc-700 transition-colors"
          >
            <ArrowDown className="size-3" />
            Jump to bottom
          </button>
        )}
      </div>
    </div>
  )
}
