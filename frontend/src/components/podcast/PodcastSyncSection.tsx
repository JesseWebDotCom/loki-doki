import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound, RotateCw, Rss, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  generateGpodderPassword, getGpodderStatus, getRssToken, radioFeedUrl,
  regenerateRssToken, revokeGpodderPassword,
} from '@/lib/podcast/portabilityApi'

/** A read-only value with a copy button - used for feed URLs and credentials. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success(`${label} copied.`)
    } catch {
      toast.error('Could not copy to the clipboard.')
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-control border border-border/60 bg-background/60 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <Button variant="ghost" size="icon-sm" onClick={() => void copy()} title={`Copy ${label}`} aria-label={`Copy ${label}`}>
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

/** Podcast settings - Sync & feeds section: the private RSS feed token for generated
 *  shows and radio recordings, plus the gPodder app password AntennaPod uses. */
export function PodcastSyncSection() {
  const qc = useQueryClient()
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [confirmRevokePassword, setConfirmRevokePassword] = useState(false)
  const [newPassword, setNewPassword] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const { data: token, isLoading: tokenLoading } = useQuery({ queryKey: ['podcast-rss-token'], queryFn: getRssToken })
  const { data: gpodder, isLoading: gpodderLoading } = useQuery({ queryKey: ['podcast-gpodder'], queryFn: getGpodderStatus })

  async function handleRegenerate() {
    try {
      await regenerateRssToken()
      await qc.invalidateQueries({ queryKey: ['podcast-rss-token'] })
      toast.success('New feed URLs generated. The old ones no longer work.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not regenerate the feed URLs.')
    }
  }

  async function handleGeneratePassword() {
    setGenerating(true)
    try {
      const res = await generateGpodderPassword()
      setNewPassword(res.password)
      await qc.invalidateQueries({ queryKey: ['podcast-gpodder'] })
      toast.success('App password generated. Copy it now.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate an app password.')
    } finally {
      setGenerating(false)
    }
  }

  async function handleRevokePassword() {
    try {
      await revokeGpodderPassword()
      setNewPassword(null)
      await qc.invalidateQueries({ queryKey: ['podcast-gpodder'] })
      toast.success('App password revoked. Connected apps will stop syncing.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke the app password.')
    }
  }

  const serverUrl = window.location.origin

  return (
    <div className="space-y-4">
      {/* ── Private RSS feeds ── */}
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Rss className="size-4 text-brand" /> Private podcast feeds
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Your AI shows and radio recordings each get a private feed URL any podcast app on your network can subscribe
          to. The URL contains a secret token, so treat it like a password: anyone with the link can listen.
        </p>

        {tokenLoading ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Spinner size="sm" /> Loading…</p>
        ) : token ? (
          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1.5 text-xs font-medium">Radio recordings feed</p>
              <CopyField label="Feed URL" value={radioFeedUrl(token)} />
            </div>
            <p className="text-xs text-muted-foreground">
              For an individual AI show, use the Copy RSS feed action on that show's page.
            </p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setConfirmRegen(true)}>
              <RotateCw className="size-3.5" /> Regenerate feed URLs
            </Button>
          </div>
        ) : null}
      </Card>

      {/* ── gPodder sync ── */}
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Smartphone className="size-4 text-brand" /> Sync with AntennaPod
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Loki Doki speaks the gpodder.net sync protocol, so AntennaPod (and other gpodder-compatible apps) can keep
          your subscriptions and playback positions in step with the app.
        </p>

        {gpodderLoading ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Spinner size="sm" /> Loading…</p>
        ) : gpodder ? (
          <>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-xs text-muted-foreground marker:text-muted-foreground/60">
              <li>In AntennaPod, open Settings, then Synchronization, and choose gpodder.net.</li>
              <li>Pick "Self-hosted server" and enter the server address below.</li>
              <li>Sign in with your username and the app password you generate here (never your profile PIN).</li>
            </ol>

            <div className="mt-3 space-y-3">
              <div>
                <p className="mb-1.5 text-xs font-medium">Server address</p>
                <CopyField label="Server address" value={serverUrl} />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium">Username</p>
                <CopyField label="Username" value={gpodder.username} />
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium">App password</p>
                {newPassword ? (
                  <>
                    <CopyField label="App password" value={newPassword} />
                    <p className="mt-1.5 text-xs text-warning">
                      Copy this now. It is shown once and cannot be recovered, only replaced.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {gpodder.configured
                      ? 'An app password is set. Generate a new one if you have lost it (the old one stops working).'
                      : 'No app password yet. Generate one to connect a podcast app.'}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" className="gap-1.5" disabled={generating} onClick={() => void handleGeneratePassword()}>
                    {generating ? <Spinner className="text-current" /> : <KeyRound className="size-3.5" />}
                    {gpodder.configured ? 'Generate a new password' : 'Generate app password'}
                  </Button>
                  {gpodder.configured && (
                    <Button variant="outline" size="sm" onClick={() => setConfirmRevokePassword(true)}>
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {gpodder.devices.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium">Connected apps</p>
                <ul className="mt-1.5 space-y-1">
                  {gpodder.devices.map(d => (
                    <li key={d.deviceId} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">{d.caption || d.deviceId}</span>
                      {d.lastSeenAt && (
                        <span className="shrink-0">last synced {new Date(d.lastSeenAt).toLocaleDateString()}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : null}
      </Card>

      <ConfirmDialog
        open={confirmRegen}
        onOpenChange={setConfirmRegen}
        title="Regenerate feed URLs?"
        description="Every feed URL you have shared will stop working, and any podcast app subscribed to one will need the new link. This cannot be undone."
        confirmLabel="Regenerate"
        destructive
        onConfirm={() => void handleRegenerate()}
      />

      <ConfirmDialog
        open={confirmRevokePassword}
        onOpenChange={setConfirmRevokePassword}
        title="Revoke the app password?"
        description="Any podcast app signed in with it will stop syncing until you generate a new password and sign in again."
        confirmLabel="Revoke"
        destructive
        onConfirm={() => void handleRevokePassword()}
      />
    </div>
  )
}
