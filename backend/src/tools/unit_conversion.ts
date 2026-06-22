import type { Tool, ToolResult } from './index'

interface UnitEntry { factor: number; category: string; canonical: string }
const UNITS = new Map<string, UnitEntry>()

function reg(category: string, canonical: string, factor: number, ...aliases: string[]): void {
  const entry: UnitEntry = { factor, category, canonical }
  UNITS.set(canonical.toLowerCase(), entry)
  for (const a of aliases) UNITS.set(a.toLowerCase(), entry)
}

// Length — base: meter
reg('length', 'm', 1, 'meter', 'meters', 'metre', 'metres')
reg('length', 'km', 1000, 'kilometer', 'kilometers', 'kilometre', 'kilometres')
reg('length', 'cm', 0.01, 'centimeter', 'centimeters', 'centimetre', 'centimetres')
reg('length', 'mm', 0.001, 'millimeter', 'millimeters', 'millimetre', 'millimetres')
reg('length', 'μm', 1e-6, 'um', 'micrometer', 'micrometers', 'micron', 'microns')
reg('length', 'nm', 1e-9, 'nanometer', 'nanometers', 'nanometre', 'nanometres')
reg('length', 'in', 0.0254, 'inch', 'inches')
reg('length', 'ft', 0.3048, 'foot', 'feet')
reg('length', 'yd', 0.9144, 'yard', 'yards')
reg('length', 'mi', 1609.344, 'mile', 'miles')
reg('length', 'nmi', 1852, 'nautical mile', 'nautical miles')
reg('length', 'ly', 9.461e15, 'light-year', 'light-years', 'lightyear', 'lightyears')
reg('length', 'au', 1.496e11, 'astronomical unit', 'astronomical units')

// Weight — base: gram
reg('weight', 'g', 1, 'gram', 'grams')
reg('weight', 'kg', 1000, 'kilogram', 'kilograms', 'kilo', 'kilos')
reg('weight', 'mg', 0.001, 'milligram', 'milligrams')
reg('weight', 't', 1e6, 'tonne', 'tonnes', 'metric ton', 'metric tons')
reg('weight', 'lb', 453.592, 'lbs', 'pound', 'pounds')
reg('weight', 'oz', 28.3495, 'ounce', 'ounces')
reg('weight', 'st', 6350.29, 'stone', 'stones')
reg('weight', 'ton', 907185, 'short ton', 'short tons', 'us ton', 'us tons')

// Volume — base: liter
reg('volume', 'L', 1, 'l', 'liter', 'liters', 'litre', 'litres')
reg('volume', 'mL', 0.001, 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc', 'cm3')
reg('volume', 'cL', 0.01, 'cl', 'centiliter', 'centiliters')
reg('volume', 'm³', 1000, 'm3', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres')
reg('volume', 'tsp', 0.00492892, 'teaspoon', 'teaspoons')
reg('volume', 'tbsp', 0.0147868, 'tablespoon', 'tablespoons')
reg('volume', 'fl oz', 0.0295735, 'fl. oz.', 'floz', 'fluid ounce', 'fluid ounces')
reg('volume', 'cup', 0.236588, 'cups')
reg('volume', 'pt', 0.473176, 'pint', 'pints', 'us pint', 'us pints')
reg('volume', 'qt', 0.946353, 'quart', 'quarts', 'us quart', 'us quarts')
reg('volume', 'gal', 3.78541, 'gallon', 'gallons', 'us gallon', 'us gallons')

// Temperature — handled separately (factor=0 is a sentinel)
reg('temperature', '°C', 0, 'c', 'celsius', 'centigrade')
reg('temperature', '°F', 0, 'f', 'fahrenheit')
reg('temperature', 'K', 0, 'kelvin', 'kelvins')

// Speed — base: m/s
reg('speed', 'm/s', 1, 'mps', 'meters per second', 'metres per second')
reg('speed', 'km/h', 1 / 3.6, 'kph', 'kmh', 'kilometers per hour', 'km/hr')
reg('speed', 'mph', 0.44704, 'miles per hour', 'mi/h')
reg('speed', 'knot', 0.514444, 'knots', 'kt', 'kts')
reg('speed', 'ft/s', 0.3048, 'fps', 'feet per second')

// Area — base: m²
reg('area', 'm²', 1, 'm2', 'sq m', 'square meter', 'square meters', 'square metre', 'square metres')
reg('area', 'km²', 1e6, 'km2', 'sq km', 'square kilometer', 'square kilometers')
reg('area', 'cm²', 1e-4, 'cm2', 'sq cm', 'square centimeter', 'square centimeters')
reg('area', 'in²', 6.4516e-4, 'in2', 'sq in', 'square inch', 'square inches')
reg('area', 'ft²', 0.092903, 'ft2', 'sq ft', 'square foot', 'square feet')
reg('area', 'yd²', 0.836127, 'yd2', 'sq yd', 'square yard', 'square yards')
reg('area', 'acre', 4046.86, 'acres')
reg('area', 'ha', 10000, 'hectare', 'hectares')
reg('area', 'mi²', 2.59e6, 'mi2', 'sq mi', 'square mile', 'square miles')

// Time — base: second
reg('time', 's', 1, 'sec', 'second', 'seconds')
reg('time', 'ms', 0.001, 'millisecond', 'milliseconds')
reg('time', 'min', 60, 'minute', 'minutes')
reg('time', 'h', 3600, 'hr', 'hour', 'hours')
reg('time', 'd', 86400, 'day', 'days')
reg('time', 'wk', 604800, 'week', 'weeks')
reg('time', 'mo', 2592000, 'month', 'months')
reg('time', 'yr', 31536000, 'year', 'years')

// Digital — base: byte
reg('digital', 'B', 1, 'byte', 'bytes')
reg('digital', 'bit', 0.125, 'bits')
reg('digital', 'KB', 1e3, 'kilobyte', 'kilobytes')
reg('digital', 'MB', 1e6, 'megabyte', 'megabytes')
reg('digital', 'GB', 1e9, 'gigabyte', 'gigabytes')
reg('digital', 'TB', 1e12, 'terabyte', 'terabytes')
reg('digital', 'PB', 1e15, 'petabyte', 'petabytes')
reg('digital', 'KiB', 1024, 'kibibyte', 'kibibytes')
reg('digital', 'MiB', 1048576, 'mebibyte', 'mebibytes')
reg('digital', 'GiB', 1073741824, 'gibibyte', 'gibibytes')
reg('digital', 'TiB', 1099511627776, 'tebibyte', 'tebibytes')

// Pressure — base: pascal
reg('pressure', 'Pa', 1, 'pascal', 'pascals')
reg('pressure', 'kPa', 1000, 'kilopascal', 'kilopascals')
reg('pressure', 'MPa', 1e6, 'megapascal', 'megapascals')
reg('pressure', 'bar', 1e5, 'bars')
reg('pressure', 'mbar', 100, 'millibar', 'millibars')
reg('pressure', 'atm', 101325, 'atmosphere', 'atmospheres')
reg('pressure', 'psi', 6894.76, 'pounds per square inch')
reg('pressure', 'mmHg', 133.322, 'torr', 'mm hg')

// Energy — base: joule
reg('energy', 'J', 1, 'joule', 'joules')
reg('energy', 'kJ', 1000, 'kilojoule', 'kilojoules')
reg('energy', 'cal', 4.184, 'calorie', 'calories')
reg('energy', 'kcal', 4184, 'kilocalorie', 'kilocalories', 'food calorie')
reg('energy', 'Wh', 3600, 'watt-hour', 'watt hour', 'watt hours')
reg('energy', 'kWh', 3.6e6, 'kilowatt-hour', 'kilowatt-hours', 'kwh')
reg('energy', 'BTU', 1055.06, 'btu', 'british thermal unit')

function lookupUnit(raw: string): UnitEntry | undefined {
  const key = raw.trim().toLowerCase().replace(/°/g, '').replace(/[²³]/g, s => s === '²' ? '2' : '3').replace(/\s+/g, ' ')
  return UNITS.get(key) ?? UNITS.get(raw.trim().toLowerCase())
}

function convertTemp(value: number, from: UnitEntry, to: UnitEntry): number {
  let celsius: number
  if (from.canonical === '°C') celsius = value
  else if (from.canonical === '°F') celsius = (value - 32) * 5 / 9
  else celsius = value - 273.15
  if (to.canonical === '°C') return celsius
  if (to.canonical === '°F') return celsius * 9 / 5 + 32
  return celsius + 273.15
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return String(n)
  if (Number.isInteger(n) && Math.abs(n) < 1e12) return String(n)
  return parseFloat(n.toPrecision(6)).toString()
}

export const unitConversionTool: Tool = {
  id: 'unit_conversion',
  name: 'Unit Conversion',
  description: 'Convert between units of length, weight, volume, temperature, speed, area, time, digital storage, pressure, and energy',
  offline: true,
  dataSources: [],
  examples: [
    'convert between units of measurement — length, weight, temperature, volume',
    'how many of one unit equals another unit',
    'unit conversion between metric and imperial',
    'convert distance, mass, speed, or data size units',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'unit_conversion',
      description: 'Convert a value from one unit to another',
      parameters: {
        type: 'object',
        required: ['value', 'from_unit', 'to_unit'],
        properties: {
          value: { type: 'number', description: 'Numeric value to convert' },
          from_unit: { type: 'string', description: 'Source unit (e.g. "miles", "kg", "°F")' },
          to_unit: { type: 'string', description: 'Target unit (e.g. "kilometers", "lb", "°C")' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { value, from_unit, to_unit } = args as { value: number; from_unit: string; to_unit: string }
    if (value === undefined || value === null) return { success: false, error: 'Value is required' }
    if (!from_unit?.trim() || !to_unit?.trim()) return { success: false, error: 'from_unit and to_unit are required' }

    const fromEntry = lookupUnit(from_unit)
    const toEntry = lookupUnit(to_unit)

    if (!fromEntry) return { success: false, error: `Unknown unit: ${from_unit}` }
    if (!toEntry) return { success: false, error: `Unknown unit: ${to_unit}` }
    if (fromEntry.category !== toEntry.category) {
      return { success: false, error: `Cannot convert ${fromEntry.category} to ${toEntry.category}` }
    }

    let result: number
    if (fromEntry.category === 'temperature') {
      result = convertTemp(value, fromEntry, toEntry)
    } else {
      result = value * fromEntry.factor / toEntry.factor
    }

    const resultStr = fmtNum(result)
    return {
      success: true,
      data: {
        value,
        from_unit: fromEntry.canonical,
        to_unit: toEntry.canonical,
        result,
        result_str: resultStr,
        category: fromEntry.category,
        answer_payload: { gist: `${value} ${fromEntry.canonical} = ${resultStr} ${toEntry.canonical}` },
      },
    }
  },
}
