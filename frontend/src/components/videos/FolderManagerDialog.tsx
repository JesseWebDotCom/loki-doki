import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FolderPlus, Trash2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { cn } from '@/lib/cn'
import { toast } from 'sonner'
import {
  createFolder, deleteFolder, listFolders, setFolderMember,
  type VideoFolder, type VideoSource,
} from '@/lib/videos/api'

export interface FolderChannel {
  source: VideoSource
  externalId: string
  title: string
  thumbnailUrl: string | null
}

// Manage subscription folders: create/delete them, and tick which channels belong to the
// selected one. YouTube retired Collections a decade ago and never replaced it; grouping
// subscriptions is the most-asked-for library feature in the alt-frontend communities.
export function FolderManagerDialog({ open, onOpenChange, channels }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channels: FolderChannel[]
}) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['videos-folders'], queryFn: listFolders, enabled: open })
  const folders = data?.folders ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [delTarget, setDelTarget] = useState<VideoFolder | null>(null)

  const selected = folders.find((f) => f.id === selectedId) ?? folders[0] ?? null
  const invalidate = () => qc.invalidateQueries({ queryKey: ['videos-folders'] })

  const create = useMutation({
    mutationFn: (name: string) => createFolder(name),
    onSuccess: ({ folder }) => { setNewName(''); setSelectedId(folder.id); void invalidate() },
    onError: () => toast.error('Could not create the folder'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteFolder(id),
    onSuccess: () => { setSelectedId(null); void invalidate() },
    onError: () => toast.error('Could not delete the folder'),
  })
  const toggleMember = useMutation({
    mutationFn: ({ folderId, ch, member }: { folderId: string; ch: FolderChannel; member: boolean }) =>
      setFolderMember(folderId, ch.source, ch.externalId, member),
    onSuccess: () => void invalidate(),
    onError: () => toast.error('Could not update the folder'),
  })

  const isMember = (f: VideoFolder, ch: FolderChannel) =>
    f.members.some((m) => m.source === ch.source && m.externalId === ch.externalId)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Subscription folders</DialogTitle>
            <DialogDescription>
              Group your channels so each folder gets its own feed. A channel can sit in more than one.
            </DialogDescription>
          </DialogHeader>

          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create.mutate(newName.trim()) }}>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="New folder name" className="h-9" />
            <Button type="submit" size="sm" disabled={!newName.trim() || create.isPending} className="shrink-0 gap-1.5">
              <FolderPlus className="size-4" /> Add
            </Button>
          </form>

          {isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : folders.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No folders yet. Create one above.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
              <div className="space-y-1">
                {folders.map((f) => (
                  <div key={f.id} className="flex items-center gap-1">
                    <button onClick={() => setSelectedId(f.id)}
                      className={cn('min-w-0 flex-1 truncate rounded-control px-2.5 py-1.5 text-left text-sm transition',
                        selected?.id === f.id ? 'bg-brand/15 font-semibold text-brand' : 'hover:bg-accent')}>
                      {f.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">{f.members.length}</span>
                    </button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${f.name}`}
                      onClick={() => setDelTarget(f)}
                      className="shrink-0 text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="max-h-80 space-y-0.5 overflow-y-auto">
                {selected && channels.map((ch) => {
                  const member = isMember(selected, ch)
                  return (
                    <button key={`${ch.source}:${ch.externalId}`}
                      onClick={() => toggleMember.mutate({ folderId: selected.id, ch, member: !member })}
                      className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition hover:bg-accent">
                      <CreatorAvatar title={ch.title} src={ch.thumbnailUrl} className="size-7 shrink-0 text-[10px]" />
                      <span className="min-w-0 flex-1 truncate text-sm">{ch.title}</span>
                      <span className={cn('grid size-5 shrink-0 place-items-center rounded border',
                        member ? 'border-brand bg-brand text-brand-foreground' : 'border-border')}>
                        {member && <Check className="size-3" />}
                      </span>
                    </button>
                  )
                })}
                {selected && channels.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">Subscribe to channels first.</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(o) => { if (!o) setDelTarget(null) }}
        title={`Delete "${delTarget?.name}"?`}
        description="The folder is removed. Your subscriptions themselves are untouched."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (delTarget) remove.mutate(delTarget.id); setDelTarget(null) }}
      />
    </>
  )
}
