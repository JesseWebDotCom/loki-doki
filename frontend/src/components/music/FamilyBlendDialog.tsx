// Family Blend - create and manage blends: two or more household profiles' listening
// merged into one auto-refreshing shared playlist with a taste-match percent. Launched
// from the Library's Playlists tab, next to Magic mix and Smart playlist.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { RefreshCw, Trash2, Users } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { listBlends, createBlend, refreshBlend, deleteBlend, type Blend } from '@/lib/music/intelApi'

interface Profile { id: string; nickname: string }

async function fetchProfiles(): Promise<Profile[]> {
  const res = await fetch('/api/auth/profiles', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json() as Array<{ id: string; nickname: string }>
  return data.map(p => ({ id: p.id, nickname: p.nickname }))
}

function BlendRow({ blend, onChanged }: { blend: Blend; onChanged: () => void }) {
  const navigate = useNavigate()
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState<'refresh' | 'delete' | null>(null)

  const refresh = async () => {
    setBusy('refresh')
    try { await refreshBlend(blend.id); toast.success('Blend refreshed'); onChanged() }
    catch { toast.error('Could not refresh the blend') }
    finally { setBusy(null) }
  }
  const del = async () => {
    setBusy('delete')
    try { await deleteBlend(blend.id); toast.success('Blend deleted'); onChanged() }
    catch { toast.error('Could not delete the blend') }
    finally { setBusy(null) }
  }

  return (
    <div className="flex items-center gap-2 rounded-control border border-border/60 px-3 py-2">
      <button type="button" onClick={() => navigate(`/music/playlist/${blend.playlistId}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-brand/15 text-brand">
          <Users className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{blend.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {blend.members.map(m => m.name).join(', ')}
            {blend.matchPercent != null && ` · ${blend.matchPercent}% taste match`}
            {` · ${blend.trackCount} tracks`}
          </span>
        </span>
      </button>
      {blend.member && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh blend" title="Refresh now"
          className="shrink-0 text-muted-foreground hover:text-foreground">
          {busy === 'refresh' ? <Spinner size="sm" /> : <RefreshCw className="size-4" />}
        </Button>
      )}
      {blend.owned && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmDel(true)} aria-label="Delete blend"
          className="shrink-0 text-muted-foreground hover:text-destructive">
          {busy === 'delete' ? <Spinner size="sm" /> : <Trash2 className="size-4" />}
        </Button>
      )}
      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete this blend?"
        description={`"${blend.name}" and its shared playlist will be permanently removed for the whole household.`}
        destructive confirmLabel="Delete" onConfirm={() => void del()} />
    </div>
  )
}

export function FamilyBlendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const { data: profiles } = useQuery({ queryKey: ['household-profiles'], queryFn: fetchProfiles, enabled: open, staleTime: 60_000 })
  const { data: blendData, refetch } = useQuery({ queryKey: ['music-blends'], queryFn: listBlends, enabled: open })
  const blends = blendData?.blends ?? []
  const others = (profiles ?? []).filter(p => p.id !== user?.id)

  const create = useMutation({
    mutationFn: () => createBlend({ memberIds: [...picked], name: name.trim() || undefined }),
    onSuccess: ({ blend }) => {
      toast.success(`"${blend.name}" is live and refreshes daily`)
      setPicked(new Set()); setName('')
      void qc.invalidateQueries({ queryKey: ['music-blends'] })
      void qc.invalidateQueries({ queryKey: ['music-playlists'] })
      onOpenChange(false)
      navigate(`/music/playlist/${blend.playlistId}`)
    },
    onError: () => toast.error('Could not create the blend'),
  })

  const toggle = (id: string) => setPicked(s => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <Dialog open={open} onOpenChange={v => { if (!create.isPending) onOpenChange(v) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users className="size-5 text-brand" /> Family Blend</DialogTitle>
          <DialogDescription>
            Pick who's in: their listening blends into one shared playlist that refreshes
            daily, with a taste-match score.
          </DialogDescription>
        </DialogHeader>

        {blends.length > 0 && (
          <div className="space-y-2">
            {blends.map(b => (
              <BlendRow key={b.id} blend={b} onChanged={() => { void refetch(); void qc.invalidateQueries({ queryKey: ['music-playlists'] }) }} />
            ))}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Blend with</p>
            {others.length === 0 ? (
              <p className="rounded-control bg-foreground/[0.05] p-3 text-sm text-muted-foreground">
                A blend needs at least two household profiles.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {others.map(p => (
                  // design-ok(hand-styled-button): selection chip, not a chrome control
                  <button key={p.id} type="button" onClick={() => toggle(p.id)}
                    className={cn('rounded-full px-3 py-1 text-xs font-medium transition',
                      picked.has(p.id) ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 hover:bg-foreground/15')}>
                    {p.nickname}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Input value={name} placeholder="Blend name (optional)" onChange={e => setName(e.target.value)} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>Close</Button>
          <Button onClick={() => create.mutate()} disabled={!picked.size || create.isPending}>
            {create.isPending ? <><Spinner size="sm" /> Blending…</> : <><Users className="size-4" /> Create blend</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
