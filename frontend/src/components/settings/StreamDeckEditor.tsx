import { useEffect, useRef, useState } from 'react'
import { LayoutGrid, Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionType = 'none' | 'browser_navigate' | 'browser_url' | 'app_action' | 'page_jump' | 'webhook'

type StreamDeckAction =
  | { type: 'none' }
  | { type: 'browser_navigate'; path: string }
  | { type: 'browser_url'; url: string }
  | { type: 'app_action'; action: string }
  | { type: 'page_jump'; pageId: string }
  | { type: 'webhook'; url: string; method?: string; body?: string }

interface LocalButton {
  row: number
  col: number
  icon: string
  label: string
  bgColor: string
  textColor: string
  action: StreamDeckAction
}

interface Page {
  id: string
  name: string
  gridRows: number
  gridCols: number
  sortOrder: number
  buttons: LocalButton[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const APP_ACTIONS = [
  { value: 'play_pause',  label: 'Play / Pause' },
  { value: 'next_track',  label: 'Next Track'   },
  { value: 'volume_up',   label: 'Volume Up'    },
  { value: 'volume_down', label: 'Volume Down'  },
]

const SELECT_CLS =
  'w-full bg-background border border-input rounded-lg px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAction(raw: unknown): StreamDeckAction {
  if (!raw) return { type: 'none' }
  if (typeof raw === 'object' && raw !== null && 'type' in raw) return raw as StreamDeckAction
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as StreamDeckAction } catch { /* ignore */ }
  }
  return { type: 'none' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePages(data: any[]): Page[] {
  return data.map(p => ({
    id:       p.id,
    name:     p.name,
    gridRows: p.gridRows,
    gridCols: p.gridCols,
    sortOrder: p.sortOrder,
    buttons: (p.buttons ?? []).map((b: any) => ({
      row:       b.row,
      col:       b.col,
      icon:      b.icon      ?? 'Square',
      label:     b.label     ?? '',
      bgColor:   b.bgColor   ?? '#1e1e2e',
      textColor: b.textColor ?? '#ffffff',
      action:    parseAction(b.action),
    })),
  }))
}

// Renders a cell icon — emoji as text, Lucide names as a styled box
function CellIcon({ icon, color }: { icon: string; color: string }) {
  const isEmoji = /\p{Emoji_Presentation}/u.test(icon) || /\p{Emoji}️/u.test(icon)
  if (isEmoji) {
    return <span className="text-2xl leading-none select-none">{icon}</span>
  }
  if (!icon.trim()) {
    return null
  }
  return (
    <div
      className="size-8 rounded border flex items-center justify-center text-[9px] font-mono leading-tight text-center px-0.5"
      style={{ borderColor: color + '80', color }}
    >
      {icon.slice(0, 5)}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function StreamDeckEditor() {
  const [pages,         setPages]         = useState<Page[]>([])
  const [activePageId,  setActivePageId]  = useState<string | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [saving,        setSaving]        = useState(false)
  const [selectedCell,  setSelectedCell]  = useState<{ row: number; col: number } | null>(null)
  const [renamingId,    setRenamingId]    = useState<string | null>(null)
  const [renameValue,   setRenameValue]   = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Button editor state
  const [editIcon,            setEditIcon]            = useState('')
  const [editLabel,           setEditLabel]           = useState('')
  const [editBgColor,         setEditBgColor]         = useState('#1e1e2e')
  const [editTextColor,       setEditTextColor]       = useState('#ffffff')
  const [editActionType,      setEditActionType]      = useState<ActionType>('none')
  const [editActionPath,      setEditActionPath]      = useState('')
  const [editActionUrl,       setEditActionUrl]       = useState('')
  const [editActionAppAction, setEditActionAppAction] = useState('play_pause')
  const [editActionPageId,    setEditActionPageId]    = useState('')
  const [editWebhookUrl,      setEditWebhookUrl]      = useState('')
  const [editWebhookMethod,   setEditWebhookMethod]   = useState('POST')
  const [editWebhookBody,     setEditWebhookBody]     = useState('')

  const activePage = pages.find(p => p.id === activePageId) ?? null
  const selectedButton = (activePage && selectedCell)
    ? activePage.buttons.find(b => b.row === selectedCell.row && b.col === selectedCell.col) ?? null
    : null

  // ── Load pages on mount ────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/stream-deck/pages', { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data: unknown[]) => {
        const parsed = parsePages(data)
        setPages(parsed)
        if (parsed.length > 0) setActivePageId(parsed[0].id)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Auto-focus rename input when it appears
  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  // Sync editor fields when selected cell or active page tab changes
  useEffect(() => {
    if (!selectedCell) return
    const btn = activePage?.buttons.find(b => b.row === selectedCell.row && b.col === selectedCell.col)
    if (btn) {
      setEditIcon(btn.icon === 'Square' ? '' : btn.icon)
      setEditLabel(btn.label)
      setEditBgColor(btn.bgColor)
      setEditTextColor(btn.textColor)
      const a = btn.action
      setEditActionType(a.type as ActionType)
      setEditActionPath(      a.type === 'browser_navigate' ? a.path           : '')
      setEditActionUrl(       a.type === 'browser_url'      ? a.url            : '')
      setEditActionAppAction( a.type === 'app_action'       ? a.action         : 'play_pause')
      setEditActionPageId(    a.type === 'page_jump'        ? a.pageId         : '')
      setEditWebhookUrl(      a.type === 'webhook'          ? a.url            : '')
      setEditWebhookMethod(   a.type === 'webhook'          ? (a.method ?? 'POST') : 'POST')
      setEditWebhookBody(     a.type === 'webhook'          ? (a.body ?? '')   : '')
    } else {
      setEditIcon('')
      setEditLabel('')
      setEditBgColor('#1e1e2e')
      setEditTextColor('#ffffff')
      setEditActionType('none')
      setEditActionPath('')
      setEditActionUrl('')
      setEditActionAppAction('play_pause')
      setEditActionPageId('')
      setEditWebhookUrl('')
      setEditWebhookMethod('POST')
      setEditWebhookBody('')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCell?.row, selectedCell?.col, activePageId])

  // ── API helpers ────────────────────────────────────────────────────────────

  async function putButtons(pageId: string, buttons: LocalButton[]) {
    setSaving(true)
    try {
      await fetch(`/api/stream-deck/pages/${pageId}/buttons`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buttons),
      })
    } finally {
      setSaving(false)
    }
  }

  // ── Page actions ───────────────────────────────────────────────────────────

  async function addPage() {
    const name = `Page ${pages.length + 1}`
    setSaving(true)
    try {
      const res = await fetch('/api/stream-deck/pages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, gridRows: 3, gridCols: 5, sortOrder: pages.length }),
      })
      if (!res.ok) return
      const page = await res.json() as Omit<Page, 'buttons'>
      const newPage: Page = { ...page, buttons: [] }
      setPages(prev => [...prev, newPage])
      setActivePageId(newPage.id)
      setSelectedCell(null)
    } finally {
      setSaving(false)
    }
  }

  async function commitRename(id: string, name: string) {
    const trimmed = name.trim()
    setRenamingId(null)
    if (!trimmed) return
    const prev = pages.find(p => p.id === id)?.name
    if (trimmed === prev) return
    setPages(p => p.map(pg => pg.id === id ? { ...pg, name: trimmed } : pg))
    setSaving(true)
    try {
      await fetch(`/api/stream-deck/pages/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
    } finally {
      setSaving(false)
    }
  }

  async function deletePage(id: string) {
    setSaving(true)
    try {
      await fetch(`/api/stream-deck/pages/${id}`, { method: 'DELETE', credentials: 'include' })
      setPages(prev => {
        const next = prev.filter(p => p.id !== id)
        if (activePageId === id) {
          setActivePageId(next[0]?.id ?? null)
          setSelectedCell(null)
        }
        return next
      })
    } finally {
      setSaving(false)
    }
  }

  async function changeGridSize(pageId: string, gridRows: number, gridCols: number) {
    setPages(prev => prev.map(p => p.id === pageId ? { ...p, gridRows, gridCols } : p))
    if (selectedCell && (selectedCell.row >= gridRows || selectedCell.col >= gridCols)) {
      setSelectedCell(null)
    }
    setSaving(true)
    try {
      await fetch(`/api/stream-deck/pages/${pageId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gridRows, gridCols }),
      })
    } finally {
      setSaving(false)
    }
  }

  // ── Button actions ─────────────────────────────────────────────────────────

  async function saveButton() {
    if (!activePage || !selectedCell) return

    let action: StreamDeckAction
    switch (editActionType) {
      case 'browser_navigate': action = { type: 'browser_navigate', path: editActionPath }; break
      case 'browser_url':      action = { type: 'browser_url',      url:  editActionUrl  }; break
      case 'app_action':       action = { type: 'app_action',       action: editActionAppAction }; break
      case 'page_jump':        action = { type: 'page_jump',        pageId: editActionPageId }; break
      case 'webhook':          action = { type: 'webhook', url: editWebhookUrl, method: editWebhookMethod, body: editWebhookBody || undefined }; break
      default:                 action = { type: 'none' }
    }

    const updated: LocalButton = {
      row:       selectedCell.row,
      col:       selectedCell.col,
      icon:      editIcon.trim() || 'Square',
      label:     editLabel,
      bgColor:   editBgColor,
      textColor: editTextColor,
      action,
    }

    const idx = activePage.buttons.findIndex(b => b.row === selectedCell.row && b.col === selectedCell.col)
    const newButtons = idx >= 0
      ? activePage.buttons.map((b, i) => i === idx ? updated : b)
      : [...activePage.buttons, updated]

    setPages(prev => prev.map(p => p.id === activePage.id ? { ...p, buttons: newButtons } : p))
    await putButtons(activePage.id, newButtons)
  }

  async function clearButton() {
    if (!activePage || !selectedCell) return
    const newButtons = activePage.buttons.filter(
      b => !(b.row === selectedCell.row && b.col === selectedCell.col),
    )
    setPages(prev => prev.map(p => p.id === activePage.id ? { ...p, buttons: newButtons } : p))
    setSelectedCell(null)
    await putButtons(activePage.id, newButtons)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">

      {/* ── Page tabs ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {pages.map(page => (
          <div
            key={page.id}
            role="tab"
            aria-selected={page.id === activePageId}
            tabIndex={0}
            onClick={() => { if (renamingId !== page.id) { setActivePageId(page.id); setSelectedCell(null) } }}
            onKeyDown={e => { if (e.key === 'Enter') { setActivePageId(page.id); setSelectedCell(null) } }}
            className={cn(
              'group flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm border cursor-pointer transition-colors select-none',
              page.id === activePageId
                ? 'bg-card border-border text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
          >
            {renamingId === page.id ? (
              <input
                ref={renameInputRef}
                className="bg-transparent outline-none w-28 text-sm"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={() => commitRename(page.id, renameValue)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void commitRename(page.id, renameValue)
                  else if (e.key === 'Escape') setRenamingId(null)
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span
                onDoubleClick={e => {
                  e.stopPropagation()
                  setActivePageId(page.id)
                  setRenamingId(page.id)
                  setRenameValue(page.name)
                }}
              >
                {page.name}
              </span>
            )}
            {pages.length > 1 && (
              <button
                type="button"
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 ml-0.5 rounded p-0.5 hover:text-destructive transition-all"
                onClick={e => { e.stopPropagation(); setDeleteConfirm(page.id) }}
                aria-label={`Delete ${page.name}`}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={() => void addPage()}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 border border-dashed border-border/60 transition-colors disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add page
        </button>

        {saving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {activePage ? (
        <>
          {/* ── Grid size controls ─────────────────────────────────────────── */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LayoutGrid className="size-4 shrink-0" />
            <span>Grid size:</span>
            <select
              value={activePage.gridRows}
              onChange={e => void changeGridSize(activePage.id, Number(e.target.value), activePage.gridCols)}
              className="bg-card border border-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none"
            >
              {Array.from({ length: 8 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>rows ×</span>
            <select
              value={activePage.gridCols}
              onChange={e => void changeGridSize(activePage.id, activePage.gridRows, Number(e.target.value))}
              className="bg-card border border-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none"
            >
              {Array.from({ length: 8 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>cols</span>
          </div>

          {/* ── Grid + Editor panel ────────────────────────────────────────── */}
          <div className="flex gap-4 items-start flex-wrap">

            {/* Grid canvas */}
            <div
              className="grid gap-2 shrink-0"
              style={{ gridTemplateColumns: `repeat(${activePage.gridCols}, 80px)` }}
            >
              {Array.from({ length: activePage.gridRows }, (_, row) =>
                Array.from({ length: activePage.gridCols }, (_, col) => {
                  const btn = activePage.buttons.find(b => b.row === row && b.col === col)
                  const isSel = selectedCell?.row === row && selectedCell?.col === col
                  return (
                    <button
                      key={`${row}-${col}`}
                      type="button"
                      onClick={() => setSelectedCell({ row, col })}
                      className={cn(
                        'w-20 h-20 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all overflow-hidden',
                        isSel
                          ? 'ring-2 ring-brand border-transparent'
                          : btn
                          ? 'border-border/60 hover:brightness-110'
                          : 'border-dashed border-border/40 hover:border-border hover:bg-muted/30',
                      )}
                      style={btn ? { backgroundColor: btn.bgColor, color: btn.textColor } : undefined}
                    >
                      {btn ? (
                        <>
                          <CellIcon icon={btn.icon} color={btn.textColor} />
                          {btn.label && (
                            <span
                              className="text-[10px] leading-tight text-center px-1 line-clamp-2 w-full font-medium"
                              style={{ color: btn.textColor }}
                            >
                              {btn.label}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <Plus className="size-4 text-muted-foreground/40" />
                          <span className="text-[10px] text-muted-foreground/40">Add</span>
                        </>
                      )}
                    </button>
                  )
                })
              )}
            </div>

            {/* Button editor panel */}
            {selectedCell && (
              <div className="flex-1 min-w-[260px] max-w-sm bg-card border border-border rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    Button ({selectedCell.row + 1}, {selectedCell.col + 1})
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelectedCell(null)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Close editor"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                {/* Icon */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Icon</Label>
                  <Input
                    value={editIcon}
                    onChange={e => setEditIcon(e.target.value)}
                    placeholder="😀  or  Home, Music, Tv…"
                  />
                  <p className="text-[11px] text-muted-foreground">Emoji or Lucide icon name</p>
                </div>

                {/* Label */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Label</Label>
                  <Input
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder="Button label"
                  />
                </div>

                {/* Colors */}
                <div className="flex gap-3">
                  <div className="space-y-1.5 flex-1">
                    <Label className="text-xs text-muted-foreground">Background</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editBgColor}
                        onChange={e => setEditBgColor(e.target.value)}
                        className="size-8 rounded-md border border-border cursor-pointer p-0.5 bg-transparent"
                      />
                      <span className="text-xs text-muted-foreground font-mono">{editBgColor}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <Label className="text-xs text-muted-foreground">Text color</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editTextColor}
                        onChange={e => setEditTextColor(e.target.value)}
                        className="size-8 rounded-md border border-border cursor-pointer p-0.5 bg-transparent"
                      />
                      <span className="text-xs text-muted-foreground font-mono">{editTextColor}</span>
                    </div>
                  </div>
                </div>

                {/* Action type */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Action</Label>
                  <select
                    value={editActionType}
                    onChange={e => setEditActionType(e.target.value as ActionType)}
                    className={SELECT_CLS}
                  >
                    <option value="none">None</option>
                    <option value="browser_navigate">Navigate in app</option>
                    <option value="browser_url">Open URL</option>
                    <option value="app_action">App action</option>
                    <option value="page_jump">Switch page</option>
                    <option value="webhook">Webhook</option>
                  </select>
                </div>

                {/* Action sub-fields */}
                {editActionType === 'browser_navigate' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Path</Label>
                    <Input
                      value={editActionPath}
                      onChange={e => setEditActionPath(e.target.value)}
                      placeholder="/music"
                    />
                  </div>
                )}

                {editActionType === 'browser_url' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">URL</Label>
                    <Input
                      value={editActionUrl}
                      onChange={e => setEditActionUrl(e.target.value)}
                      placeholder="https://example.com"
                    />
                  </div>
                )}

                {editActionType === 'app_action' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Action</Label>
                    <select
                      value={editActionAppAction}
                      onChange={e => setEditActionAppAction(e.target.value)}
                      className={SELECT_CLS}
                    >
                      {APP_ACTIONS.map(a => (
                        <option key={a.value} value={a.value}>{a.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {editActionType === 'page_jump' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Target page</Label>
                    <select
                      value={editActionPageId}
                      onChange={e => setEditActionPageId(e.target.value)}
                      className={SELECT_CLS}
                    >
                      <option value="">— select page —</option>
                      {pages.filter(p => p.id !== activePageId).map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {editActionType === 'webhook' && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">URL</Label>
                      <Input
                        value={editWebhookUrl}
                        onChange={e => setEditWebhookUrl(e.target.value)}
                        placeholder="https://hooks.example.com/…"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Method</Label>
                      <select
                        value={editWebhookMethod}
                        onChange={e => setEditWebhookMethod(e.target.value)}
                        className={SELECT_CLS}
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Body (optional)</Label>
                      <Textarea
                        value={editWebhookBody}
                        onChange={e => setEditWebhookBody(e.target.value)}
                        placeholder="{}"
                        rows={3}
                        className="font-mono text-xs resize-none min-h-0"
                      />
                    </div>
                  </div>
                )}

                {/* Save / Clear */}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={() => void saveButton()} disabled={saving} className="flex-1">
                    <Save className="size-3.5 mr-1.5" />
                    Save
                  </Button>
                  {selectedButton && (
                    <Button size="sm" variant="outline" onClick={() => void clearButton()} disabled={saving}>
                      <Trash2 className="size-3.5 mr-1.5" />
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <LayoutGrid className="size-10 mb-3 opacity-20" />
          <p className="text-sm">No pages yet.</p>
          <p className="text-xs mt-1 opacity-60">Click "Add page" to get started.</p>
        </div>
      )}

      {/* Delete page confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={open => { if (!open) setDeleteConfirm(null) }}
        title="Delete page?"
        description="This will permanently delete the page and all its buttons."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (deleteConfirm) void deletePage(deleteConfirm) }}
      />
    </div>
  )
}
