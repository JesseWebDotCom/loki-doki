import { useEffect, useState } from 'react'
import { Bot, CloudSun, Thermometer } from 'lucide-react'
import { toast } from 'sonner'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { Chip, ChipRow } from '@/components/shared/ChipRow'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'
import { getAppByPath } from '@/lib/appCategories'

// design-ok(hex-in-tsx): registry identity fallback data
const WEATHER_GRADIENT = getAppByPath('/weather')?.gradient ?? 'linear-gradient(135deg,#0c2a52,#1d6fa8)'

export function WeatherSettingsPage() {
  const { user } = useAuth()
  const [unit, setUnit] = useState<'fahrenheit' | 'celsius'>('fahrenheit')
  usePublishUIContext({ label: 'Weather Settings', description: 'User is on the Weather settings page.' })

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((prefs: Record<string, unknown> | null) => {
        if (prefs?.['weather.unit'] === 'celsius') setUnit('celsius')
      })
      .catch(() => {})
  }, [user?.id])

  function save(next: 'fahrenheit' | 'celsius') {
    if (!user?.id) return
    setUnit(next)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'weather.unit': next }),
    })
      .then((r) => { if (!r.ok) throw new Error() })
      .catch(() => toast.error('Could not save your temperature unit'))
  }

  const sections: AppSettingsSection[] = [
    {
      id: 'general',
      label: 'General',
      icon: Thermometer,
      content: (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Temperature unit</h2>
          <ChipRow>
            <Chip label="Fahrenheit" active={unit === 'fahrenheit'} onClick={() => save('fahrenheit')} />
            <Chip label="Celsius" active={unit === 'celsius'} onClick={() => save('celsius')} />
          </ChipRow>
        </section>
      ),
    },
    { id: 'companion', label: 'Companion', icon: Bot, content: <CompanionAbilitiesCard appId="weather" /> },
  ]

  return (
    <AppSettingsShell
      appId="weather"
      icon={CloudSun}
      gradient={WEATHER_GRADIENT}
      sections={sections}
    />
  )
}
