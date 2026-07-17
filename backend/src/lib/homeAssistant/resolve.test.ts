import { describe, expect, test } from 'bun:test'
import { deterministicResolve } from './resolve'
import type { CatalogEntity } from './sync'
import { serviceCallsFor } from './actions'
import { setClarify, resolveClarify, ctxKey, getContext } from './context'

function ent(entityId: string, name: string, areaId: string | null, areaName: string | null): CatalogEntity {
  return { entityId, domain: entityId.split('.')[0]!, name, areaId, areaName, deviceClass: null, category: null }
}

const areas = new Map<string, string>([
  ['office', 'Office'],
  ['bedroom', 'Bedroom'],
  ['living', 'Living Room'],
])

// A representative multi-room home.
const HOME: CatalogEntity[] = [
  ent('light.office_ceiling', 'Office Ceiling', 'office', 'Office'),
  ent('light.bedroom_lamp', 'Bedroom Lamp', 'bedroom', 'Bedroom'),
  ent('light.living_floor', 'Living Room Floor Lamp', 'living', 'Living Room'),
  ent('fan.ceiling_fan', 'Ceiling Fan', 'bedroom', 'Bedroom'),
  ent('fan.desk_fan', 'Desk Fan', 'office', 'Office'),
  ent('climate.office', 'Office Thermostat', 'office', 'Office'),
  ent('climate.bedroom', 'Bedroom Thermostat', 'bedroom', 'Bedroom'),
  ent('media_player.living_tv', 'Living Room TV', 'living', 'Living Room'),
]

describe('fan speed (A2)', () => {
  test('set the fan to 50% → set_percentage', () => {
    const p = deterministicResolve('set the office fan to 50%', HOME, areas)
    expect(p.action).toBe('set_percentage')
    expect(p.value).toBe(50)
    const calls = serviceCallsFor('set_percentage', ['fan.desk_fan'], { value: p.value })
    expect(calls[0]).toEqual({ domain: 'fan', service: 'set_percentage', data: { entity_id: ['fan.desk_fan'], percentage: 50 } })
  })
  test('turn on the fan is still turn_on, not a speed change', () => {
    const p = deterministicResolve('turn on the desk fan', HOME, areas)
    expect(p.action).toBe('turn_on')
  })
})

describe('light colour vs climate disambiguation (A3)', () => {
  test('make the lights warmer → colour temp, not thermostat', () => {
    const p = deterministicResolve('make the office lights warmer', HOME, areas)
    expect(p.action).toBe('set_color_temp')
    expect(p.matchedDomain).toBe('light')
    expect(p.kelvin).toBe(2700)
  })
  test('make it warmer (no light word) still nudges the thermostat', () => {
    const p = deterministicResolve('make the office warmer', HOME, areas)
    expect(p.action).toBe('set_temperature')
    expect(p.tempDelta).toBe(2)
  })
  test('set the lights to blue → set_color', () => {
    const p = deterministicResolve('set the office lights to blue', HOME, areas)
    expect(p.action).toBe('set_color')
    expect(p.colorName).toBe('blue')
  })
})

describe('ambiguity fails closed with candidates (E)', () => {
  test('turn on the fan with two fans, no room → ambiguous, no targets', () => {
    const p = deterministicResolve('turn on the fan', HOME, areas)
    expect(p.intent).toBe('unknown')
    expect(p.reason).toBe('ambiguous')
    expect(p.ambiguousCandidates?.length).toBe(2)
    expect(p.action).toBe('turn_on')
  })
  test('one fan in the home resolves directly', () => {
    const oneFan = HOME.filter(e => e.entityId !== 'fan.desk_fan')
    const p = deterministicResolve('turn on the fan', oneFan, areas)
    expect(p.intent).toBe('control')
    expect(p.targets).toHaveLength(1)
  })
})

describe('origin-area room context (B)', () => {
  test('turn off the lights from the bedroom pod → bedroom lamp only', () => {
    const p = deterministicResolve('turn off the lights', HOME, areas, 'bedroom')
    expect(p.intent).toBe('control')
    expect(p.action).toBe('turn_off')
    expect(p.targets.map(t => t.entityId)).toEqual(['light.bedroom_lamp'])
    expect(p.matchedArea).toBe('Bedroom')
  })
  test('a spoken room overrides the origin', () => {
    const p = deterministicResolve('turn off the office lights', HOME, areas, 'bedroom')
    expect(p.targets.map(t => t.entityId)).toEqual(['light.office_ceiling'])
  })
  test('"in here" resolves to the origin room', () => {
    const p = deterministicResolve('turn off the fan in here', HOME, areas, 'office')
    expect(p.targets.map(t => t.entityId)).toEqual(['fan.desk_fan'])
  })
  test('set the thermostat prefers the origin zone', () => {
    const p = deterministicResolve('set the thermostat to 72', HOME, areas, 'office')
    expect(p.targets.map(t => t.entityId)).toEqual(['climate.office'])
    expect(p.value).toBe(72)
  })
})

describe('comfort cues (D)', () => {
  test("it's hot in here → climate cool cue in origin room", () => {
    const p = deterministicResolve("it's hot in here", HOME, areas, 'office')
    expect(p.cue).toBe(true)
    expect(p.cueAxis).toBe('temperature')
    expect(p.action).toBe('set_temperature')
    expect(p.tempDelta).toBe(-2)
    expect(p.targets.map(t => t.entityId)).toEqual(['climate.office'])
  })
  test("it's freezing → climate warm cue", () => {
    const p = deterministicResolve("it's freezing in here", HOME, areas, 'bedroom')
    expect(p.cueAxis).toBe('temperature')
    expect(p.tempDelta).toBe(2)
  })
  test("that's too loud → volume down cue", () => {
    const p = deterministicResolve("that's too loud", HOME, areas)
    expect(p.cue).toBe(true)
    expect(p.cueAxis).toBe('volume')
    expect(p.action).toBe('volume_down')
  })
  test('cues can be disabled', () => {
    const p = deterministicResolve("it's hot in here", HOME, areas, 'office', { cues: false })
    expect(p.cue).toBeUndefined()
    expect(p.intent).toBe('unknown')
  })
  test('"it\'s hot outside" is weather, not a cue', () => {
    const p = deterministicResolve("it's hot outside", HOME, areas, 'office')
    expect(p.cue).toBeUndefined()
  })
  test('a direct command is never treated as a cue', () => {
    const p = deterministicResolve('turn off the bedroom lights', HOME, areas, 'office')
    expect(p.cue).toBeUndefined()
    expect(p.action).toBe('turn_off')
  })
})

describe('clarification memory (E)', () => {
  test('a short reply resolves a pending clarification', () => {
    const key = ctxKey('u1', 'c1')
    const fans = HOME.filter(e => e.domain === 'fan')
    setClarify(key, { candidates: fans, action: 'turn_on' })
    const ctx = getContext(key)!
    const rc = resolveClarify('the desk one', ctx)
    expect(rc?.action).toBe('turn_on')
    expect(rc?.targets.map(t => t.entityId)).toEqual(['fan.desk_fan'])
  })
  test('an ordinal reply works too', () => {
    const key = ctxKey('u2', 'c2')
    const fans = HOME.filter(e => e.domain === 'fan')
    setClarify(key, { candidates: fans, action: 'turn_on' })
    const rc = resolveClarify('the first one', getContext(key)!)
    expect(rc?.targets).toHaveLength(1)
  })
})

describe('volume verbs (regression)', () => {
  test('lower the volume → volume_down', () => {
    const p = deterministicResolve('lower the volume on the living room tv', HOME, areas)
    expect(p.action).toBe('volume_down')
    expect(p.targets.map(t => t.entityId)).toEqual(['media_player.living_tv'])
  })
})
