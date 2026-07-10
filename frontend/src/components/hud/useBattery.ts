import { useEffect, useState } from 'react'
import type { BatteryStatus } from '@/types/desktop'

// Battery glance for the island top bar, via the shell bridge. null on web
// builds, desktop Macs without a battery, or an older shell binary.

export function useBattery(): BatteryStatus | null {
  const [battery, setBattery] = useState<BatteryStatus | null>(null)
  useEffect(() => {
    if (!window.lokiDesktop?.getBattery) return
    let cancelled = false
    const tick = () => {
      void window.lokiDesktop?.getBattery?.().then((b) => { if (!cancelled) setBattery(b) })
    }
    tick()
    const t = setInterval(tick, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])
  return battery
}
