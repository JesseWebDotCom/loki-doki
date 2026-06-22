import { useEffect, useState } from 'react'

export interface AdminSettings {
  measurement: 'metric' | 'imperial'
  temperature: 'celsius' | 'fahrenheit'
  currency: string
  timeFormat: '12h' | '24h'
  /** Convenience alias used by maps */
  measurementSystem: 'metric' | 'imperial'
}

const DEFAULTS: AdminSettings = {
  measurement: 'imperial',
  temperature: 'fahrenheit',
  currency: 'USD',
  timeFormat: '12h',
  measurementSystem: 'imperial',
}

export function useAdminSettings(): { settings: AdminSettings; loading: boolean } {
  const [settings, setSettings] = useState<AdminSettings>(DEFAULTS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/admin/locale', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((data: { measurement: string; temperature: string; currency: string; timeFormat: string } | null) => {
        if (!data) return
        setSettings({
          measurement: data.measurement as AdminSettings['measurement'],
          temperature: data.temperature as AdminSettings['temperature'],
          currency: data.currency,
          timeFormat: data.timeFormat as AdminSettings['timeFormat'],
          measurementSystem: data.measurement as AdminSettings['measurementSystem'],
        })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { settings, loading }
}
