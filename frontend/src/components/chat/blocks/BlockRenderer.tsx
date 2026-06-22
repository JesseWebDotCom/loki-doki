import { memo } from 'react'
import { WeatherCard } from './WeatherCard'
import { YouTubeEmbed } from './YouTubeEmbed'
import { NewsCards } from './NewsCards'
import { SearchResults } from './SearchResults'
import { CalcResult } from './CalcResult'
import { UnitConversionBlock } from './UnitConversionBlock'
import { RecipeCard } from './RecipeCard'
import { DictionaryBlock } from './DictionaryBlock'
import { TvShowCard } from './TvShowCard'
import { JokeCard } from './JokeCard'
import { ImageBlock } from './ImageBlock'
import { WhereToWatchCard } from './WhereToWatchCard'
import { HolidaysCard } from './HolidaysCard'
import { ContentRatingCard } from './ContentRatingCard'
import type { Block } from './types'

export type { Block }

// Memoized so streaming ChatMessage re-renders (one per token) don't re-render
// every block card. Blocks are append-only, so a shallow compare is sufficient.
export const BlockRenderer = memo(function BlockRenderer({ block }: { block: Block }) {
  switch (block.kind) {
    case 'weather':        return <WeatherCard data={block.data} />
    case 'youtube':        return <YouTubeEmbed data={block.data} />
    case 'news':           return <NewsCards data={block.data} />
    case 'search':         return <SearchResults data={block.data} />
    case 'calculator':     return <CalcResult data={block.data} />
    case 'unit_conversion': return <UnitConversionBlock data={block.data} />
    case 'recipe':         return <RecipeCard data={block.data} />
    case 'dictionary':     return <DictionaryBlock data={block.data} />
    case 'tvshow':         return <TvShowCard data={block.data} />
    case 'joke':           return <JokeCard data={block.data} />
    case 'image_gen':      return <ImageBlock data={block.data} />
    case 'where_to_watch': return <WhereToWatchCard data={block.data} />
    case 'holidays':       return <HolidaysCard data={block.data} />
    case 'content_rating': return <ContentRatingCard data={block.data} />
    default:               return null
  }
})
