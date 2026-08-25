// MaiPai TV page-channel screen registry: maps every TvScreenId to its
// full-bleed broadcast surface. The player shell renders TV_SCREENS[screen]
// inside its viewport container.

import type { ComponentType } from 'react'
import type { TvChannel, TvScreenId } from '@/lib/maipaitv/api'
import { ArrivalsScreen } from './ArrivalsScreen'
import { CalendarScreen } from './CalendarScreen'
import { CountdownScreen } from './CountdownScreen'
import { FiresideScreen } from './FiresideScreen'
import { GuideScreen } from './GuideScreen'
import { MemoriesScreen } from './MemoriesScreen'
import { NetScreen } from './NetScreen'
import { NewsScreen } from './NewsScreen'
import { NightSkyScreen } from './NightSkyScreen'
import { NocScreen } from './NocScreen'
import { OnThisDayScreen } from './OnThisDayScreen'
import { SecurityScreen } from './SecurityScreen'
import { SportsScreen } from './SportsScreen'
import { TonightScreen } from './TonightScreen'
import { WeatherScreen } from './WeatherScreen'

export interface TvScreenProps {
  channel: TvChannel
  title: string
  subtitle?: string | null
}

export const TV_SCREENS: Record<TvScreenId, ComponentType<TvScreenProps>> = {
  guide: GuideScreen,
  weather: WeatherScreen,
  calendar: CalendarScreen,
  countdown: CountdownScreen,
  sports: SportsScreen,
  net: NetScreen,
  noc: NocScreen,
  security: SecurityScreen,
  memories: MemoriesScreen,
  arrivals: ArrivalsScreen,
  news: NewsScreen,
  tonight: TonightScreen,
  nightsky: NightSkyScreen,
  onthisday: OnThisDayScreen,
  fireside: FiresideScreen,
}
