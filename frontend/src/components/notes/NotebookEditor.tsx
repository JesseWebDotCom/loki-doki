import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/shared/ColorPicker'
import { IconPicker } from '@/components/shared/IconPicker'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { updateNotebook, deleteNotebook, type Notebook } from '@/lib/notes/api'

interface NotebookEditorProps {
  open: boolean
  notebook: Notebook | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function NotebookEditor({ open, notebook, onOpenChange, onDeleted }: NotebookEditorProps) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [shared, setShared] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (open && notebook) {
      setName(notebook.name)
      setIcon(notebook.icon)
      setColor(notebook.color)
      setShared(notebook.isShared)
    }
  }, [open, notebook])

  async function handleSave() {
    if (!notebook) return
    const trimmed = name.trim()
    if (!trimmed) { toast.error('Name is required'); return }
    setPending(true)
    try {
      await updateNotebook(notebook.id, {
        name: trimmed, icon, color,
        ...(isAdmin && shared !== notebook.isShared ? { makeShared: shared } : {}),
      })
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      qc.invalidateQueries({ queryKey: ['notes'] })
      toast.success('Notebook updated')
      onOpenChange(false)
    } catch {
      toast.error('Failed to update notebook')
    } finally {
      setPending(false)
    }
  }

  async function handleDelete() {
    if (!notebook) return
    setPending(true)
    try {
      await deleteNotebook(notebook.id)
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      qc.invalidateQueries({ queryKey: ['notes'] })
      toast.success('Notebook deleted')
      setConfirmDelete(false)
      onOpenChange(false)
      onDeleted?.()
    } catch {
      toast.error('Failed to delete notebook')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) onOpenChange(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit notebook</DialogTitle>
            <DialogDescription>Rename this notebook or give it an icon and color.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="nb-name" className="text-sm font-medium">Name</label>
              <Input
                id="nb-name"
                placeholder="Notebook name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Icon</span>
                <IconPicker value={icon} onChange={setIcon} />
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Color</span>
                <ColorPicker value={color} onChange={setColor} />
              </div>
            </div>

            {isAdmin && (
              <div className="flex items-center justify-between rounded-control border border-border/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Share with household</p>
                  <p className="text-xs text-muted-foreground">Everyone can see this notebook. Only shared notes can live in it.</p>
                </div>
                <Switch checked={shared} onCheckedChange={setShared} />
              </div>
            )}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={pending}>
              Delete
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={pending}>Save</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete notebook?"
        description={`"${notebook?.name ?? ''}" will be removed. Its notes stay in your library.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </>
  )
}
