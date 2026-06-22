import { useEffect, useState } from 'react'
import { Save, Check } from 'lucide-react'

interface LocaleSettings {
  measurement: 'metric' | 'imperial'
  temperature: 'celsius' | 'fahrenheit'
  currency: string
  timeFormat: '12h' | '24h'
}

const CURRENCIES = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
  { value: 'CNY', label: 'CNY — Chinese Yuan' },
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'MXN', label: 'MXN — Mexican Peso' },
  { value: 'BRL', label: 'BRL — Brazilian Real' },
  { value: 'KRW', label: 'KRW — South Korean Won' },
]

const selectCls = [
  'w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm',
  'focus:outline-none focus:ring-2 focus:ring-violet-500/40',
  'transition-all',
].join(' ')

function OptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              'flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all',
              value === opt.value
                ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                : 'border-border bg-card text-muted-foreground hover:border-border/80 hover:text-foreground',
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function AdminLocaleTab() {
  const [settings, setSettings] = useState<LocaleSettings>({
    measurement: 'imperial',
    temperature: 'fahrenheit',
    currency: 'USD',
    timeFormat: '12h',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/admin/locale', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((data: LocaleSettings | null) => { if (data) setSettings(data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const r = await fetch('/api/admin/locale', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings),
      })
      if (r.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <div className="space-y-8 p-6">
      <div>
        <p className="text-sm text-muted-foreground">
          These preferences are passed to the AI so it responds in the right units, currency, and format.
        </p>
      </div>

      <div className="space-y-6">
        <OptionGroup
          label="Measurement system"
          value={settings.measurement}
          onChange={v => setSettings(s => ({ ...s, measurement: v }))}
          options={[
            { value: 'imperial', label: 'Imperial' },
            { value: 'metric',   label: 'Metric' },
          ]}
        />

        <OptionGroup
          label="Temperature"
          value={settings.temperature}
          onChange={v => setSettings(s => ({ ...s, temperature: v }))}
          options={[
            { value: 'fahrenheit', label: 'Fahrenheit (°F)' },
            { value: 'celsius',    label: 'Celsius (°C)' },
          ]}
        />

        <OptionGroup
          label="Time format"
          value={settings.timeFormat}
          onChange={v => setSettings(s => ({ ...s, timeFormat: v }))}
          options={[
            { value: '12h', label: '12-hour (AM/PM)' },
            { value: '24h', label: '24-hour' },
          ]}
        />

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Currency</p>
          <select
            value={settings.currency}
            onChange={e => setSettings(s => ({ ...s, currency: e.target.value }))}
            className={selectCls}
          >
            {CURRENCIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
      >
        {saved
          ? <><Check className="size-4" /> Saved</>
          : <><Save className="size-4" /> Save</>}
      </button>
    </div>
  )
}
