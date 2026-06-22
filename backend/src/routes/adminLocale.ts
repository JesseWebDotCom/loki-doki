import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import type { AppEnv } from '@/types'

export interface LocaleSettings {
  measurement: 'metric' | 'imperial'
  temperature: 'celsius' | 'fahrenheit'
  currency: string
  timeFormat: '12h' | '24h'
}

const DEFAULTS: LocaleSettings = {
  measurement: 'imperial',
  temperature: 'fahrenheit',
  currency: 'USD',
  timeFormat: '12h',
}

let _localeCache: LocaleSettings | null = null

export async function getLocaleSettings(): Promise<LocaleSettings> {
  if (_localeCache) return _localeCache
  const [measurement, temperature, currency, timeFormat] = await Promise.all([
    getAppSetting('locale.measurement'),
    getAppSetting('locale.temperature'),
    getAppSetting('locale.currency'),
    getAppSetting('locale.time_format'),
  ])
  _localeCache = {
    measurement: (measurement as LocaleSettings['measurement']) ?? DEFAULTS.measurement,
    temperature: (temperature as LocaleSettings['temperature']) ?? DEFAULTS.temperature,
    currency: (currency as string) ?? DEFAULTS.currency,
    timeFormat: (timeFormat as LocaleSettings['timeFormat']) ?? DEFAULTS.timeFormat,
  }
  return _localeCache
}

export function invalidateLocaleCache(): void {
  _localeCache = null
}

const adminLocale = new Hono<AppEnv>()

adminLocale.get('/', requireAuth, async (c) => {
  return c.json(await getLocaleSettings())
})

adminLocale.put('/', requireAdmin, async (c) => {
  const body = await c.req.json() as Partial<LocaleSettings>

  if (body.measurement !== undefined) await setAppSetting('locale.measurement', body.measurement)
  if (body.temperature !== undefined) await setAppSetting('locale.temperature', body.temperature)
  if (body.currency !== undefined) await setAppSetting('locale.currency', body.currency)
  if (body.timeFormat !== undefined) await setAppSetting('locale.time_format', body.timeFormat)

  invalidateLocaleCache()
  return c.json(await getLocaleSettings())
})

const TEMP_LABELS: Record<LocaleSettings['temperature'], string> = {
  fahrenheit: 'Fahrenheit (°F)',
  celsius: 'Celsius (°C)',
}

const MEASURE_LABELS: Record<LocaleSettings['measurement'], string> = {
  imperial: 'imperial (miles, lbs, oz, fl oz)',
  metric: 'metric (km, kg, L)',
}

const TIME_LABELS: Record<LocaleSettings['timeFormat'], string> = {
  '12h': '12-hour AM/PM',
  '24h': '24-hour',
}

/** Builds the locale instruction block injected into the LLM system prompt. */
export function buildLocalePrompt(locale: LocaleSettings): string {
  return [
    `Units: always use ${TEMP_LABELS[locale.temperature]} for temperature,`,
    `${MEASURE_LABELS[locale.measurement]} for distances and weights,`,
    `${locale.currency} for prices,`,
    `${TIME_LABELS[locale.timeFormat]} for time.`,
    `Never convert to other units unless explicitly asked.`,
  ].join(' ')
}

export { adminLocale }
