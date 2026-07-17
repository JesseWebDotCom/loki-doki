import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, History, RotateCw, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ToggleRow } from '@/components/shared/ToggleRow'
import {
  backfillScrobbles, getScrobbleSettings, retryFailedScrobbles, saveScrobbleSettings,
} from '@/lib/music/portabilityApi'

/** Music settings - Scrobbling section: send your listens to ListenBrainz. Submission
 *  itself is a background queue on the server, so nothing here touches playback. */
export function MusicScrobbleSettings() {
  const qc = useQueryClient()
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [backfilling, setBackfilling] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['music-scrobble-settings'],
    queryFn: getScrobbleSettings,
    // The queue drains in the background; keep the counts honest while the page is open.
    refetchInterval: q => ((q.state.data?.queue.pending ?? 0) > 0 ? 5000 : false),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['music-scrobble-settings'] })

  async function handleSaveToken() {
    const t = token.trim()
    if (!t) return
    setSaving(true)
    try {
      const res = await saveScrobbleSettings({ token: t, enabled: true })
      setToken('')
      await refresh()
      toast.success(res.listenBrainzUser ? `Connected as ${res.listenBrainzUser}.` : 'Token saved.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the token.')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle() {
    if (!data) return
    const next = !data.enabled
    try {
      await saveScrobbleSettings({ enabled: next })
      await refresh()
      toast.success(next ? 'Scrobbling is on.' : 'Scrobbling is off.')
    } catch {
      toast.error('Could not change that setting.')
    }
  }

  async function handleDisconnect() {
    try {
      await saveScrobbleSettings({ token: null, enabled: false })
      await refresh()
      toast.success('Disconnected from ListenBrainz.')
    } catch {
      toast.error('Could not disconnect.')
    }
  }

  async function handleBackfill() {
    setBackfilling(true)
    try {
      const { queued } = await backfillScrobbles()
      await refresh()
      if (queued > 0) toast.success(`Queued ${queued.toLocaleString()} ${queued === 1 ? 'listen' : 'listens'}. They submit in the background.`)
      else toast.info('Nothing new to backfill.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the backfill.')
    } finally {
      setBackfilling(false)
    }
  }

  async function handleRetry() {
    try {
      await retryFailedScrobbles()
      await refresh()
      toast.success('Failed listens re-queued.')
    } catch {
      toast.error('Could not retry.')
    }
  }

  if (isLoading || !data) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" /> Loading…</p>
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="text-sm font-semibold">ListenBrainz</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Send every song you play to your ListenBrainz account. Listens are queued locally and submitted in the
          background, so this never slows playback and nothing is lost while you are offline.
        </p>
        <a
          href="https://listenbrainz.org/settings/"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline"
        >
          Get your user token <ExternalLink className="size-3" />
        </a>

        {data.tokenSet ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Connected with token <span className="font-mono text-foreground">{data.tokenHint}</span>
            </p>
            <ToggleRow
              title="Scrobble my listens"
              description="Songs you play are submitted to ListenBrainz."
              checked={data.enabled}
              onCheckedChange={() => void handleToggle()}
            />
            <Button variant="outline" size="sm" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Paste your ListenBrainz user token"
              className="sm:flex-1"
            />
            <Button onClick={() => void handleSaveToken()} disabled={saving || !token.trim()} className="gap-2">
              {saving && <Spinner className="text-current" />}
              {saving ? 'Checking…' : 'Connect'}
            </Button>
          </div>
        )}
      </Card>

      {data.tokenSet && (
        <Card className="p-4">
          <p className="text-sm font-semibold">Backfill history</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Send everything you have already played on Loki Doki. Listens go out in small batches so ListenBrainz is
            never hammered. Running this twice never sends a listen twice.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" className="gap-2" disabled={backfilling || !data.enabled} onClick={() => void handleBackfill()}>
              {backfilling ? <Spinner className="text-current" /> : <History className="size-4" />}
              {backfilling ? 'Queueing…' : 'Backfill history'}
            </Button>
            {!data.enabled && <span className="text-xs text-muted-foreground">Turn scrobbling on first.</span>}
          </div>

          {(data.queue.pending > 0 || data.queue.failed > 0) && (
            <div className="mt-4 space-y-2 text-xs">
              {data.queue.pending > 0 && (
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Spinner size="sm" className="text-current" />
                  {data.queue.pending.toLocaleString()} waiting to send
                </p>
              )}
              {data.queue.failed > 0 && (
                <div className="flex items-start gap-1.5 text-destructive">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    <p>{data.queue.failed.toLocaleString()} could not be sent after repeated tries.</p>
                    {data.queue.lastError && <p className="mt-0.5 text-muted-foreground">Last error: {data.queue.lastError}</p>}
                    <Button variant="outline" size="sm" className="mt-2 gap-1.5" onClick={() => void handleRetry()}>
                      <RotateCw className="size-3.5" /> Retry these
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Last.fm is not supported yet: it needs a per-install API key pair and a browser sign-in round trip, which does
        not fit the paste-one-token setup here. ListenBrainz covers the same ground with an open API.
      </p>
    </div>
  )
}
