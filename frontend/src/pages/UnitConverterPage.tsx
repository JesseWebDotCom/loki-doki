import { useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { cn } from '@/lib/cn'

// ── Unit definitions ──────────────────────────────────────────────────────────

interface UnitDef {
  symbol: string
  name: string
  /** Conversion factor to base unit (0 = temperature sentinel) */
  factor: number
}

type Category = 'length' | 'weight' | 'volume' | 'temperature' | 'speed'

const UNITS: Record<Category, UnitDef[]> = {
  length: [
    { symbol: 'm',   name: 'Meters',           factor: 1 },
    { symbol: 'km',  name: 'Kilometers',        factor: 1000 },
    { symbol: 'cm',  name: 'Centimeters',       factor: 0.01 },
    { symbol: 'mm',  name: 'Millimeters',       factor: 0.001 },
    { symbol: 'in',  name: 'Inches',            factor: 0.0254 },
    { symbol: 'ft',  name: 'Feet',              factor: 0.3048 },
    { symbol: 'yd',  name: 'Yards',             factor: 0.9144 },
    { symbol: 'mi',  name: 'Miles',             factor: 1609.344 },
    { symbol: 'nmi', name: 'Nautical Miles',    factor: 1852 },
    { symbol: 'ly',  name: 'Light-Years',       factor: 9.461e15 },
    { symbol: 'au',  name: 'Astronomical Units', factor: 1.496e11 },
  ],
  weight: [
    { symbol: 'g',   name: 'Grams',        factor: 1 },
    { symbol: 'kg',  name: 'Kilograms',    factor: 1000 },
    { symbol: 'mg',  name: 'Milligrams',   factor: 0.001 },
    { symbol: 't',   name: 'Tonnes',       factor: 1e6 },
    { symbol: 'lb',  name: 'Pounds',       factor: 453.592 },
    { symbol: 'oz',  name: 'Ounces',       factor: 28.3495 },
    { symbol: 'st',  name: 'Stone',        factor: 6350.29 },
    { symbol: 'ton', name: 'Short Tons',   factor: 907185 },
  ],
  volume: [
    { symbol: 'L',     name: 'Liters',           factor: 1 },
    { symbol: 'mL',    name: 'Milliliters',       factor: 0.001 },
    { symbol: 'cL',    name: 'Centiliters',       factor: 0.01 },
    { symbol: 'm³',    name: 'Cubic Meters',      factor: 1000 },
    { symbol: 'tsp',   name: 'Teaspoons',         factor: 0.00492892 },
    { symbol: 'tbsp',  name: 'Tablespoons',       factor: 0.0147868 },
    { symbol: 'fl oz', name: 'Fluid Ounces',      factor: 0.0295735 },
    { symbol: 'cup',   name: 'Cups',              factor: 0.236588 },
    { symbol: 'pt',    name: 'Pints',             factor: 0.473176 },
    { symbol: 'qt',    name: 'Quarts',            factor: 0.946353 },
    { symbol: 'gal',   name: 'Gallons',           factor: 3.78541 },
  ],
  temperature: [
    { symbol: '°C', name: 'Celsius',    factor: 0 },
    { symbol: '°F', name: 'Fahrenheit', factor: 0 },
    { symbol: 'K',  name: 'Kelvin',     factor: 0 },
  ],
  speed: [
    { symbol: 'm/s',  name: 'Meters per Second',     factor: 1 },
    { symbol: 'km/h', name: 'Kilometers per Hour',   factor: 1 / 3.6 },
    { symbol: 'mph',  name: 'Miles per Hour',        factor: 0.44704 },
    { symbol: 'knot', name: 'Knots',                 factor: 0.514444 },
    { symbol: 'ft/s', name: 'Feet per Second',       factor: 0.3048 },
  ],
}

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'length',      label: 'Length' },
  { id: 'weight',      label: 'Weight' },
  { id: 'volume',      label: 'Volume' },
  { id: 'temperature', label: 'Temperature' },
  { id: 'speed',       label: 'Speed' },
]

// ── Conversion math ───────────────────────────────────────────────────────────

function convertTemperature(value: number, fromSymbol: string, toSymbol: string): number {
  // Normalize to Celsius first
  let celsius: number
  if (fromSymbol === '°C') celsius = value
  else if (fromSymbol === '°F') celsius = (value - 32) * 5 / 9
  else celsius = value - 273.15 // Kelvin

  // Convert from Celsius to target
  if (toSymbol === '°C') return celsius
  if (toSymbol === '°F') return celsius * 9 / 5 + 32
  return celsius + 273.15 // Kelvin
}

function convert(value: number, from: UnitDef, to: UnitDef, category: Category): number {
  if (from.symbol === to.symbol) return value
  if (category === 'temperature') return convertTemperature(value, from.symbol, to.symbol)
  return value * from.factor / to.factor
}

function formatResult(n: number): string {
  if (!isFinite(n)) return String(n)
  const abs = Math.abs(n)
  if ((abs > 1e6 || (abs < 1e-4 && abs !== 0))) return parseFloat(n.toPrecision(6)).toString()
  // Round to at most 10 decimal places to avoid floating point noise
  return parseFloat(n.toPrecision(10)).toString()
}

// ── Component ─────────────────────────────────────────────────────────────────

const GRADIENT = 'linear-gradient(135deg,#134e4a,#0d9488)'

export function UnitConverterPage() {
  const [category, setCategory] = useState<Category>('length')
  const [fromIdx, setFromIdx] = useState(0)
  const [toIdx, setToIdx] = useState(1)
  const [inputStr, setInputStr] = useState('1')

  usePublishUIContext({
    label: 'Unit Converter',
    description: 'User is converting units on the Unit Converter page.',
  })

  const units = UNITS[category]

  const fromUnit = units[fromIdx] ?? units[0]
  const toUnit = units[toIdx] ?? units[1]

  const inputValue = parseFloat(inputStr)
  const isValidInput = inputStr.trim() !== '' && isFinite(inputValue)
  const result = isValidInput ? convert(inputValue, fromUnit, toUnit, category) : null
  const resultStr = result !== null ? formatResult(result) : ''

  function handleCategoryChange(newCat: Category) {
    setCategory(newCat)
    setFromIdx(0)
    setToIdx(1)
    setInputStr('1')
  }

  function handleSwap() {
    setFromIdx(toIdx)
    setToIdx(fromIdx)
  }

  return (
    <PageShell gradient={GRADIENT} GhostIcon={ArrowLeftRight}>
      <PageHeader
        variant="compact"
        title="Unit Converter"
        gradient={GRADIENT}
        icon={<ArrowLeftRight className="size-7 text-white" />}
      />

      {/* Category chips */}
      <div className="px-5 pb-3">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => handleCategoryChange(id)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors',
                category === id
                  ? 'bg-brand text-white'
                  : 'bg-foreground/8 text-foreground/70 hover:bg-foreground/12',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Converter card */}
      <div className="px-5 pb-10">
        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">

          {/* Two-column layout with swap button */}
          <div className="flex items-start gap-2">

            {/* From column */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                From
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={inputStr}
                onChange={(e) => setInputStr(e.target.value)}
                className={cn(
                  'w-full rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-base font-semibold',
                  'focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/60',
                  'transition-colors placeholder:text-muted-foreground/50',
                )}
                placeholder="0"
              />
              <select
                value={fromIdx}
                onChange={(e) => setFromIdx(Number(e.target.value))}
                className={cn(
                  'w-full rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/60',
                  'transition-colors cursor-pointer',
                )}
              >
                {units.map((u, i) => (
                  <option key={u.symbol} value={i}>
                    {u.symbol} - {u.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Swap button */}
            <div className="flex flex-col items-center pt-6 pb-0 mt-4">
              <button
                onClick={handleSwap}
                className={cn(
                  'flex size-9 items-center justify-center rounded-xl',
                  'bg-foreground/8 hover:bg-brand/20 hover:text-brand',
                  'transition-colors active:scale-95',
                )}
                title="Swap units"
              >
                <ArrowLeftRight className="size-4" />
              </button>
            </div>

            {/* To column */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                To
              </label>
              <div
                className={cn(
                  'flex w-full items-center rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5',
                  'min-h-[44px]',
                )}
              >
                {result !== null ? (
                  <span className="text-3xl font-bold leading-none text-foreground">
                    {resultStr}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground/50">Result</span>
                )}
              </div>
              <select
                value={toIdx}
                onChange={(e) => setToIdx(Number(e.target.value))}
                className={cn(
                  'w-full rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/60',
                  'transition-colors cursor-pointer',
                )}
              >
                {units.map((u, i) => (
                  <option key={u.symbol} value={i}>
                    {u.symbol} - {u.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Result summary line */}
          {result !== null && (
            <div className="mt-4 rounded-xl bg-muted/30 px-4 py-3 text-center">
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{inputStr}</span>
                {' '}{fromUnit.symbol}{' '}
                <span className="text-muted-foreground/60">=</span>
                {' '}
                <span className="font-semibold text-foreground">{resultStr}</span>
                {' '}{toUnit.symbol}
              </p>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}
