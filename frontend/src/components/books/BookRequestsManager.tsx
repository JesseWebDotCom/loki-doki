// Admin queue of kid-safe acquisition requests. A household member on a kid-safe
// content profile can't download book bytes directly; their request lands here for
// an admin to approve (kicks off the download) or decline.

import { useCallback, useEffect, useState } from 'react'
import { Check, Clock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { listBookRequests, approveBookRequest, denyBookRequest, type BookRequest } from '@/lib/books/api'

export function BookRequestsManager() {
  const [requests, setRequests] = useState<BookRequest[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => { void listBookRequests().then(setRequests) }, [])
  useEffect(load, [load])

  const act = useCallback(async (r: BookRequest, kind: 'approve' | 'deny') => {
    const key = `${r.userId}:${r.bookId}`
    setBusy(key)
    try {
      if (kind === 'approve') await approveBookRequest(r.userId, r.bookId)
      else await denyBookRequest(r.userId, r.bookId)
      setRequests((prev) => (prev ?? []).filter((x) => `${x.userId}:${x.bookId}` !== key))
      toast.success(kind === 'approve' ? 'Approved, downloading now' : 'Request declined')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }, [])

  if (requests === null) return <div className="flex justify-center py-6"><Spinner /></div>

  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Clock className="size-4" />Book requests</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">Downloads requested by kid-safe profiles, waiting for your approval.</p>
      {requests.length === 0 ? (
        <p className="mt-3 rounded-card border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No pending requests.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {requests.map((r) => {
            const key = `${r.userId}:${r.bookId}`
            return (
              <div key={key} className="flex items-center gap-3 rounded-card border border-border p-3">
                {r.coverUrl
                  ? <img src={proxyImg(r.coverUrl)} alt="" className="h-12 w-9 shrink-0 rounded object-cover" />
                  : <span className="flex h-12 w-9 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground"><Clock className="size-4" /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[r.author, `Requested by ${r.userName ?? 'a household member'}`].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" disabled={busy !== null} onClick={() => void act(r, 'approve')}>
                    {busy === key ? <Spinner size="sm" className="mr-1" /> : <Check className="mr-1 size-4" />}Approve
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(r, 'deny')}>
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
