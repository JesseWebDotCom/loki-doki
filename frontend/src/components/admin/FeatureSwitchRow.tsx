// One row per user-facing feature in Admin > Features: a single switch whose only
// user-facing consideration is disk space. Confirm dialogs quote the aggregate
// download size and current headroom; installs render the shared DownloadProgress;
// elevation-gated parts (the coding sandbox) surface as an inline Approve action.

import { useState } from 'react'
import { ArrowDownRight, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DownloadProgress } from '@/components/shared/DownloadProgress'
import type { FeatureSwitch } from '@/hooks/useFeatureSwitches'

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

// Below this, enabling is instant enough that a confirm dialog is just friction.
const CONFIRM_BYTES = 50e6

interface Props {
  feature: FeatureSwitch
  freeBytes: number | null
  busy: boolean
  onEnable: () => void
  onDisable: () => void
  onRepair: () => void
  /** Run the interactive (elevation) repair for a part; used by needs-approval rows. */
  onApprovePart: (componentId: string) => void
  /** Part ids with an interactive repair currently running. */
  approvingIds: ReadonlySet<string>
  /** Anchor id of this feature's advanced section (model choice) further down the page. */
  detailsAnchor?: string
}

export function FeatureSwitchRow({
  feature, freeBytes, busy, onEnable, onDisable, onRepair, onApprovePart, approvingIds, detailsAnchor,
}: Props) {
  const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null)

  const isOn = feature.state === 'on' || feature.state === 'installing' || feature.state === 'error'
  const needsConfirmEnable = feature.bytesRequired >= CONFIRM_BYTES

  const toggle = () => {
    if (busy) return
    if (isOn) setConfirm('disable')
    else if (needsConfirmEnable) setConfirm('enable')
    else onEnable()
  }

  const attention = feature.parts.filter(
    (p) => p.state === 'needs-approval' || p.state === 'needs-pkg-manager' || (p.optional && p.state === 'failed'),
  )
  const failedRequired = feature.parts.find((p) => !p.optional && p.state === 'failed')

  const chip = !isOn && feature.bytesRequired > 0
    ? <Badge variant="secondary">~{fmtBytes(feature.bytesRequired)}</Badge>
    : feature.state === 'installing'
    ? <Badge variant="info">Setting up</Badge>
    : feature.state === 'error'
    ? <Badge variant="destructive">Needs attention</Badge>
    : undefined

  return (
    <div className="space-y-2">
      <ToggleRow
        title={feature.label}
        description={feature.description}
        checked={isOn}
        onCheckedChange={toggle}
        disabled={busy}
        chip={chip}
      />

      {feature.state === 'installing' && feature.progress && (
        <DownloadProgress
          label={feature.progress.label}
          status="downloading"
          downloadedBytes={feature.progress.completed}
          totalBytes={feature.progress.total}
        />
      )}

      {feature.state === 'error' && failedRequired && (
        <div className="flex items-center justify-between gap-3 rounded-card border border-destructive/40 bg-destructive/5 px-3 py-2">
          <p className="min-w-0 truncate text-xs text-destructive">
            {failedRequired.label} failed{failedRequired.error ? `: ${failedRequired.error}` : ''}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onRepair} disabled={busy}>Retry</Button>
        </div>
      )}

      {isOn && attention.map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning/5 px-3 py-2">
          <p className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {p.state === 'needs-approval' ? <ShieldAlert className="size-3.5 shrink-0 text-warning" /> : <TriangleAlert className="size-3.5 shrink-0 text-warning" />}
            <span className="truncate">
              {p.state === 'needs-approval'
                ? `${p.label} needs a one-time admin approval on the server`
                : p.state === 'needs-pkg-manager'
                ? `${p.label} needs a system package manager (brew or apt) on the server`
                : `${p.label} did not install${p.error ? `: ${p.error}` : ''}`}
            </span>
          </p>
          {p.state === 'needs-approval' && (
            <Button type="button" size="sm" variant="outline" disabled={approvingIds.has(p.id)}
              onClick={() => onApprovePart(p.id)}>
              {approvingIds.has(p.id) ? 'Approving…' : 'Approve'}
            </Button>
          )}
          {p.optional && p.state === 'failed' && (
            <Button type="button" size="sm" variant="ghost" onClick={onRepair} disabled={busy}>Retry</Button>
          )}
        </div>
      ))}

      {(feature.contentNote || detailsAnchor) && (
        <p className="px-1 text-[11px] text-muted-foreground/70">
          {feature.contentNote}
          {feature.contentNote && detailsAnchor ? ' ' : ''}
          {detailsAnchor && (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 text-brand hover:underline"
              onClick={() => document.getElementById(detailsAnchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              Choose models and extras <ArrowDownRight className="size-3" />
            </button>
          )}
        </p>
      )}

      <ConfirmDialog
        open={confirm === 'enable'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Turn on ${feature.label}?`}
        description={`Downloads about ${fmtBytes(feature.bytesRequired)} to this server${freeBytes ? ` (${fmtBytes(freeBytes)} free)` : ''}. Everything runs locally, and installs continue in the background.`}
        confirmLabel="Turn on"
        onConfirm={() => { setConfirm(null); onEnable() }}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Turn off ${feature.label}?`}
        description="The feature stops working for everyone right away. Nothing is deleted, so turning it back on later is instant."
        confirmLabel="Turn off"
        onConfirm={() => { setConfirm(null); onDisable() }}
      />
    </div>
  )
}
