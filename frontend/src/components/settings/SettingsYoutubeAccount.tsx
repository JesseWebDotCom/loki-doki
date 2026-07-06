// YouTube → Settings → Account: link your real YouTube (Google) account via the TV-style
// device flow: we show a short code + QR, the user approves on their phone, and the
// backend mirrors subscriptions / Watch Later / Liked from then on (accountSync.ts).
// No cookies, no passwords typed here; Google runs the approval on its own site.

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { ExternalLink, Play, RefreshCw } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { timeAgo } from '@/lib/notifications'
import { rehydrateCollections } from '@/lib/youtube/collections'
import * as yt from '@/lib/youtube/api'

type SyncPref = 'syncSubscriptions' | 'syncWatchLater' | 'syncLiked' | 'pushEnabled'

export function SettingsYoutubeAccount() {
  const qc = useQueryClient()
  const [linkOpen, setLinkOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [confirmUnlink, setConfirmUnlink] = useState(false)

  const { data: state, isLoading } = useQuery({
    queryKey: ['yt-account'],
    queryFn: yt.getAccount,
    // While the sign-in dialog waits for approval, poll so the card flips the moment
    // the user taps Allow on their phone.
    refetchInterval: (query) =>
      linkOpen && query.state.data?.flow?.status === 'pending' ? 2500 : false,
  })
  const account = state?.account ?? null
  const flow = state?.flow ?? null

  // Approval landed → close the dialog and pull the freshly-mirrored library.
  useEffect(() => {
    if (!linkOpen || !state?.linked || flow?.status !== 'success') return
    setLinkOpen(false)
    toast.success('YouTube account connected. Importing your library now')
    void qc.invalidateQueries({ queryKey: ['yt-subs'] })
    void qc.invalidateQueries({ queryKey: ['yt-feed'] })
    void rehydrateCollections()
  }, [linkOpen, state?.linked, flow?.status, qc])

  async function signIn() {
    setStarting(true)
    try {
      const newFlow = await yt.startAccountLink()
      qc.setQueryData<yt.YtAccountState>(['yt-account'], old =>
        old ? { ...old, flow: newFlow } : { linked: false, account: null, flow: newFlow })
      setLinkOpen(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start sign-in')
    } finally {
      setStarting(false)
    }
  }

  function closeLinkDialog(open: boolean) {
    if (open) return
    setLinkOpen(false)
    if (flow?.status === 'pending') void yt.cancelAccountLink()
  }

  async function setPref(key: SyncPref, value: boolean) {
    qc.setQueryData<yt.YtAccountState>(['yt-account'], old =>
      old?.account ? { ...old, account: { ...old.account, [key]: value } } : old)
    try {
      const next = await yt.patchAccount({ [key]: value })
      qc.setQueryData(['yt-account'], next)
    } catch {
      toast.error('Could not save the setting')
      void qc.invalidateQueries({ queryKey: ['yt-account'] })
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      await yt.syncAccountNow()
      toast.success('Sync started. Updates appear over the next minute')
      // The pull runs server-side in the background; refresh what it feeds a bit later.
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['yt-account'] })
        void qc.invalidateQueries({ queryKey: ['yt-subs'] })
        void qc.invalidateQueries({ queryKey: ['yt-feed'] })
        void rehydrateCollections()
        setSyncing(false)
      }, 10_000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed to start')
      setSyncing(false)
    }
  }

  async function unlink() {
    try {
      await yt.unlinkAccount()
      toast.success('YouTube account disconnected')
      void qc.invalidateQueries({ queryKey: ['yt-account'] })
    } catch {
      toast.error('Could not disconnect the account')
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <p className="text-overline text-muted-foreground">YouTube account</p>
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-overline text-muted-foreground">YouTube account</p>

        {!account && (
          <div className="rounded-card border border-border/50 bg-background/50 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-destructive/10">
                <Play className="h-5 w-5 text-destructive" />
              </span>
              <div className="space-y-1">
                <p className="text-xs font-semibold">Connect your YouTube account</p>
                <p className="text-[11px] text-muted-foreground">
                  Sign in the way a smart TV does: we show a short code, you approve it on
                  your phone. Your subscriptions, Watch Later and liked videos then stay in
                  sync here, and subscribing or saving in this app updates YouTube too.
                  No passwords are entered in this app.
                </p>
              </div>
            </div>
            <Button size="sm" onClick={signIn} disabled={starting}>
              {starting ? <Spinner size="sm" /> : 'Sign in with YouTube'}
            </Button>
          </div>
        )}

        {account && (
          <div className="rounded-card border border-border/50 bg-background/50 p-4 space-y-3">
            <div className="flex items-center gap-3">
              {account.channelAvatarUrl ? (
                <img
                  src={proxyImg(account.channelAvatarUrl)}
                  alt=""
                  className="h-11 w-11 rounded-full object-cover"
                />
              ) : (
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-destructive/10">
                  <Play className="h-5 w-5 text-destructive" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">
                  {account.channelTitle ?? 'YouTube account'}
                  {account.channelHandle && (
                    <span className="ml-1.5 font-normal text-muted-foreground">{account.channelHandle}</span>
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {account.status === 'expired'
                    ? 'Sign-in expired. Reconnect to resume syncing'
                    : account.lastSyncAt
                      ? `Synced ${timeAgo(account.lastSyncAt)}`
                      : 'First sync is running…'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {account.status === 'expired' ? (
                  <Button size="sm" onClick={signIn} disabled={starting}>
                    {starting ? <Spinner size="sm" /> : 'Reconnect'}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing}>
                    {syncing ? <Spinner size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    <span className="ml-1.5">Sync now</span>
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmUnlink(true)}>
                  Disconnect
                </Button>
              </div>
            </div>
            {account.lastSyncError && account.status !== 'expired' && (
              <p className="text-[11px] text-warning">Last sync had problems: {account.lastSyncError}</p>
            )}
          </div>
        )}
      </div>

      {account && account.status === 'active' && (
        <div className="space-y-2">
          <p className="text-overline text-muted-foreground">What stays in sync</p>
          <div className="space-y-2">
            <ToggleRow
              title="Subscriptions"
              description="Your subscribed channels appear here and feed the Subscriptions page"
              checked={account.syncSubscriptions}
              onCheckedChange={() => setPref('syncSubscriptions', !account.syncSubscriptions)}
            />
            <ToggleRow
              title="Watch Later"
              description="Mirror your YouTube Watch Later list"
              checked={account.syncWatchLater}
              onCheckedChange={() => setPref('syncWatchLater', !account.syncWatchLater)}
            />
            <ToggleRow
              title="Liked videos"
              description="Mirror your most recent likes"
              checked={account.syncLiked}
              onCheckedChange={() => setPref('syncLiked', !account.syncLiked)}
            />
            <ToggleRow
              title="Apply my changes to YouTube"
              description="Subscribing, Watch Later and likes in this app also update your YouTube account"
              checked={account.pushEnabled}
              onCheckedChange={() => setPref('pushEnabled', !account.pushEnabled)}
            />
          </div>
        </div>
      )}

      <SignInDialog open={linkOpen} onOpenChange={closeLinkDialog} flow={flow} onRetry={signIn} retrying={starting} />

      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Disconnect YouTube account?"
        description="Syncing stops, but everything already imported stays in your library. Your YouTube account itself is not changed."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => { void unlink() }}
      />
    </div>
  )
}

function SignInDialog({ open, onOpenChange, flow, onRetry, retrying }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flow: yt.YtLinkFlow | null
  onRetry: () => void
  retrying: boolean
}) {
  // QR encodes the verification URL with the code pre-filled, so scanning it lands the
  // phone one tap from approval.
  const qrTarget = flow ? `${flow.verificationUrl}?user_code=${encodeURIComponent(flow.userCode)}` : null
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    if (!qrTarget) { setQr(null); return }
    QRCode.toDataURL(qrTarget, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(null))
  }, [qrTarget])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with YouTube</DialogTitle>
          <DialogDescription>
            {flow?.status === 'error'
              ? 'The sign-in could not be completed.'
              : 'Approve this device from your phone or computer, like signing in on a TV.'}
          </DialogDescription>
        </DialogHeader>

        {flow?.status === 'pending' && (
          <div className="flex flex-col items-center gap-4 py-2">
            {qr && (
              <span className="rounded-card bg-white p-2">
                <img src={qr} alt="Sign-in QR code" className="h-[180px] w-[180px]" />
              </span>
            )}
            <div className="text-center">
              <p className="text-[11px] text-muted-foreground">
                Scan the code, or visit{' '}
                <a
                  href={qrTarget ?? flow.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2"
                >
                  {flow.verificationUrl.replace(/^https?:\/\/(www\.)?/, '')}
                  <ExternalLink className="h-3 w-3" />
                </a>{' '}
                and enter:
              </p>
              <p className="mt-2 font-mono text-2xl font-bold tracking-[0.3em]">{flow.userCode}</p>
            </div>
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Spinner size="sm" /> Waiting for approval…
            </p>
          </div>
        )}

        {flow?.status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-center text-[11px] text-muted-foreground">{flow.error}</p>
            <Button size="sm" onClick={onRetry} disabled={retrying}>
              {retrying ? <Spinner size="sm" /> : 'Try again'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
