/** mm:ss or h:mm:ss */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${m}:${String(ss).padStart(2, '0')}`
}

/** Human duration like "42 min" / "1h 06m". */
export function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return ''
  const m = Math.round(sec / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
  return `${m} min`
}

/** Sum of episode durations as "18h 42m". */
export function fmtTotalRuntime(totalSec: number): string {
  const m = Math.round(totalSec / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${m}m`
}

/** "May 12, 2024" */
export function fmtDate(iso: string | number | Date | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
