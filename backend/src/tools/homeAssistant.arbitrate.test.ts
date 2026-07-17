import { describe, expect, test } from 'bun:test'
import { arbitrateLocalMedia } from '@/lib/homeAssistant/mediaArbitration'

describe('local vs HA media arbitration (C)', () => {
  test('bare volume/transport → local player', () => {
    expect(arbitrateLocalMedia('lower the volume')?.action).toBe('volume_down')
    expect(arbitrateLocalMedia('turn it up')?.action).toBe('volume_up')
    expect(arbitrateLocalMedia('mute')?.action).toBe('mute')
    expect(arbitrateLocalMedia('pause')?.action).toBe('play_pause')
    expect(arbitrateLocalMedia('skip')?.action).toBe('next_track')
  })

  test('naming a physical device defers to HA (null)', () => {
    expect(arbitrateLocalMedia('lower the volume on the living room tv')).toBeNull()
    expect(arbitrateLocalMedia('pause the bedroom speaker')).toBeNull()
  })

  test('non-media device commands are never treated as volume', () => {
    expect(arbitrateLocalMedia('turn down the thermostat')).toBeNull()
    expect(arbitrateLocalMedia('turn down the lights')).toBeNull()
    expect(arbitrateLocalMedia('turn off the fan')).toBeNull()
  })
})
