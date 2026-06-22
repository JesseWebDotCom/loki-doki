import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/cn'

const SYSTEM_BYTES = 4.5 * 1_073_741_824  // macOS typical idle footprint

function fmt(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`
  if (bytes >= 1_073_741_824)     return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576)         return `${Math.round(bytes / 1_048_576)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

type DotVariant = 'system' | 'ai' | 'amber' | 'warn' | 'free' | 'used' | 'dl'

function LegendDot({ label, value, variant }: { label: string; value: string; variant: DotVariant }) {
  const dot: Record<DotVariant, string> = {
    system: 'bg-zinc-500/70',
    used:   'bg-zinc-500/70',
    ai:     'bg-violet-500',
    dl:     'bg-violet-500',
    amber:  'bg-amber-500',
    warn:   'bg-red-500',
    free:   'border border-white/10 bg-transparent',
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <div className={cn('size-[7px] rounded-full shrink-0', dot[variant])} />
      <span>{label}</span>
      <span className="tabular-nums text-foreground/60">{value}</span>
    </div>
  )
}

export interface ResourceBarsProps {
  totalRamGb: number
  // Only the LLM (+ separate vision if not builtinVision) — what's simultaneously
  // loaded during active inference. FLUX and XTTS run in separate processes on demand.
  hotModelBytes: number
  hotModelLabel: string  // e.g. "Gemma 4 12B" or "Llama 3.1 8B + Vision"
  diskTotalBytes: number
  diskFreeBytes: number
  toDownloadBytes: number
  className?: string
}

export function ResourceBars({
  totalRamGb,
  hotModelBytes,
  hotModelLabel,
  diskTotalBytes,
  diskFreeBytes,
  toDownloadBytes,
  className,
}: ResourceBarsProps) {
  const totalRam  = totalRamGb * 1_073_741_824
  const sysBytes  = Math.min(SYSTEM_BYTES, totalRam)
  const usableRam = Math.max(0, totalRam - sysBytes)

  // Clamp model segment so the bar never overflows visually
  const modelSeg  = Math.min(hotModelBytes, totalRam)
  const freeRam   = Math.max(0, totalRam - sysBytes - hotModelBytes)

  // fit ratio: model vs usable RAM (0 → 1+)
  const fitRatio = usableRam > 0 ? hotModelBytes / usableRam : (hotModelBytes > 0 ? 2 : 0)
  const memGood  = fitRatio <= 0.70
  const memTight = fitRatio <= 0.88

  const modelColor = memGood ? 'bg-violet-500' : memTight ? 'bg-amber-500' : 'bg-red-500'
  const dotVariant: DotVariant = memGood ? 'ai' : memTight ? 'amber' : 'warn'

  const memStatus = memGood
    ? { Icon: CheckCircle2,  color: 'text-emerald-400', text: 'Fits comfortably' }
    : memTight
    ? { Icon: AlertTriangle, color: 'text-amber-400',   text: `Tight — ${fmt(freeRam)} free for apps` }
    : { Icon: AlertCircle,   color: 'text-red-400',     text: `Too large for ${totalRamGb} GB — choose a smaller model` }

  const pct = (n: number, total: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0)
  const modelPct = pct(modelSeg, totalRam)
  const sysPct   = pct(sysBytes, totalRam)

  // Storage
  const diskUsed    = Math.max(0, diskTotalBytes - diskFreeBytes)
  const diskWarn    = diskTotalBytes > 0 && toDownloadBytes > diskFreeBytes * 0.95
  const freeAfter   = Math.max(0, diskFreeBytes - toDownloadBytes)
  const usedPct     = pct(diskUsed, diskTotalBytes)
  const dlPct       = Math.min(pct(toDownloadBytes, diskTotalBytes), 100 - usedPct)

  return (
    <div className={cn('space-y-4', className)}>

      {/* ── Memory ─────────────────────────────────────────────────────────── */}
      {totalRamGb > 0 && hotModelBytes > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Memory</span>
            <span className="text-xs tabular-nums text-muted-foreground">{totalRamGb} GB</span>
          </div>
          <div className="relative h-[7px] w-full rounded-full overflow-hidden bg-white/[0.06]">
            <div className="absolute inset-y-0 left-0 flex h-full">
              <div
                className={cn('h-full transition-[width] duration-500', modelColor)}
                style={{ width: `${modelPct}%` }}
              />
              <div
                className="h-full bg-zinc-500/70 transition-[width] duration-500"
                style={{ width: `${sysPct}%` }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
            <LegendDot label={hotModelLabel || 'Model'} value={fmt(hotModelBytes)} variant={dotVariant} />
            <LegendDot label="System" value={fmt(sysBytes)} variant="system" />
            <LegendDot label="Free" value={fmt(freeRam)} variant="free" />
          </div>
          <div className={cn('flex items-center gap-1.5 text-xs pt-0.5', memStatus.color)}>
            <memStatus.Icon className="size-3 shrink-0" />
            {memStatus.text}
          </div>
        </div>
      )}

      {/* ── Storage ────────────────────────────────────────────────────────── */}
      {diskTotalBytes > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Storage</span>
            <span className="text-xs tabular-nums text-muted-foreground">{fmt(diskTotalBytes)}</span>
          </div>
          <div className="relative h-[7px] w-full rounded-full overflow-hidden bg-white/[0.06]">
            <div className="absolute inset-y-0 left-0 flex h-full">
              <div
                className="h-full bg-zinc-500/70 transition-[width] duration-500"
                style={{ width: `${usedPct}%` }}
              />
              <div
                className={cn(
                  'h-full transition-[width] duration-500',
                  diskWarn ? 'bg-red-500' : 'bg-violet-500',
                )}
                style={{ width: `${dlPct}%` }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
            <LegendDot label="Used" value={fmt(diskUsed)} variant="used" />
            {toDownloadBytes > 0 && (
              <LegendDot label="To download" value={fmt(toDownloadBytes)} variant={diskWarn ? 'warn' : 'dl'} />
            )}
            <LegendDot label="Free after" value={fmt(freeAfter)} variant="free" />
          </div>
          {diskWarn ? (
            <div className="flex items-center gap-1.5 text-xs text-red-400 pt-0.5">
              <AlertCircle className="size-3 shrink-0" />
              Not enough space — free up at least {fmt(toDownloadBytes - diskFreeBytes + 1_073_741_824)} more
            </div>
          ) : toDownloadBytes > 0 ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 pt-0.5">
              <CheckCircle2 className="size-3 shrink-0" />
              Enough space
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
