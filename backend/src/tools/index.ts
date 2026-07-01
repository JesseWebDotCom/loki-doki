import type { OllamaTool } from '@/llm/ollama'

/**
 * A structured client-side action a tool wants the frontend to perform, surfaced
 * over the chat/companion SSE stream as a `directive` event. Currently the only
 * directive is `play_media`, which drives the global mini-player: a single video
 * (YouTube mini-bar) or an AI radio station (RadioContext). Lets the companion
 * actually START playback — "play the Thriller music video", "play heavy metal" —
 * instead of just linking to the Music app.
 */
export interface PlayMediaDirective {
  action: 'play_media'
  /** 'video' → dock+expand one clip in the YouTube mini-player.
   *  'station' → start an AI radio station seeded by `seedType`/`seed`. */
  media: 'video' | 'station'
  // ── video ────────────────────────────────────────────────────────────────
  videoId?: string
  title?: string
  artist?: string | null
  channelThumb?: string | null
  thumbnail?: string | null
  durationSec?: number | null
  // ── station ──────────────────────────────────────────────────────────────
  seedType?: 'artist' | 'song' | 'genre'
  seed?: string
}

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  offline?: boolean
  // If set, the chat pipeline speaks this text directly and skips the LLM synthesis
  // pass entirely — for tools whose result is already a finished, speakable reply
  // (e.g. Home Assistant's own action confirmation). Maximum-snappiness path.
  directReply?: string
  // If set, emitted to the client as a `directive` event so the frontend performs
  // an action (e.g. start playback in the mini-player). Independent of directReply.
  directive?: PlayMediaDirective
  // If set, replaces the generic "use this data" instruction given to the LLM with
  // a tool-tailored one — and suppresses the raw data dump. Use when the tool has
  // ALREADY acted (e.g. started playback) and just wants a natural, in-character
  // acknowledgement rather than a data summary. Unlike directReply, the LLM still
  // runs, so the reply is in the companion's voice.
  synthesisHint?: string
}

export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'secret'
export type ConfigFieldScope = 'global' | 'user' | 'both'

export interface ToolConfigField {
  key: string
  label: string
  description?: string
  type: ConfigFieldType
  scope: ConfigFieldScope
  required?: boolean
  default?: string | number | boolean
  placeholder?: string
}

/** A single external service contacted by a tool or feature. */
export interface DataSource {
  name: string     // "ESPN"
  domain: string   // "espn.com"
  purpose: string  // "Live sports scores and schedules"
  type: 'api' | 'rss' | 'web' | 'cdn'
}

export interface Tool {
  id: string
  name: string
  description: string
  // Example prompts that map to this tool — embedded at startup for semantic routing
  examples: string[]
  // Passed to Ollama for Tier 2 function calling
  toolDefinition: OllamaTool
  // Whether this tool works without internet
  offline: boolean
  // If defined, skip Tier 2 arg extraction for confident Tier 1 matches and pass the
  // raw user message as this arg instead. Use for tools where the message IS the query.
  // null = no args needed (e.g. jokes). string = arg name to pass message as.
  passMessage?: string | null
  // Declarative config fields — drives the admin/settings UI and config resolution
  configSchema?: ToolConfigField[]
  // External services this tool contacts. Empty array = fully local/offline.
  // Presence of any entry drives consent requirements and the data-access audit view.
  dataSources: DataSource[]
  execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult>
}

import { weatherTool } from './weather'
import { searchTool } from './search'
import { calculatorTool } from './calculator'
import { unitConversionTool } from './unit_conversion'
import { jokesTool } from './jokes'
import { newsTool } from './news'
import { recipesTool } from './recipes'
import { dictionaryTool } from './dictionary'
import { youtubeTool } from './youtube'
import { tvShowsTool } from './tvshows'
import { datetimeTool } from './datetime'
import { moonphaseTool } from './moonphase'
import { imageGenTool } from './imageGen'
import { videoGenTool } from './videoGen'
import { documentEditTool } from './documentEdit'
import { medicalTool } from './medical'
import { whereToWatchTool } from './whereToWatch'
import { holidaysTool } from './holidays'
import { homeInventoryTool } from './homeInventory'
import { onThisDayTool } from './onThisDay'
import { localEventsTool } from './localEvents'
import { localNewsTool } from './localNews'
import { contentRatingTool } from './contentRating'
import { sportsTool } from './sports'
import { homeAssistantTool } from './homeAssistant'
import { timeTool } from './time'
import { converterTool } from './converter'
import { bookmarksLibraryTool } from './bookmarksLibrary'
import { saveToBookmarksTool } from './saveToBookmarks'
import { propertyLookupTool } from './propertyLookup'
import { peopleLookupTool } from './peopleLookup'
import { mapsTool } from './maps'
import { repairTool } from './repair'
import { knowledgeTool } from './knowledge'
import { showtimesTool } from './showtimes'
import { playMusicTool } from './playMusic'
import { plexTool } from './plex'
import { setStatusTool } from './setStatus'
import { sleepTool } from './sleep'
import { displayAlertTool } from './displayAlert'
import { rememberTool, forgetTool } from './memory'

export const toolRegistry: Tool[] = [
  weatherTool,
  searchTool,
  calculatorTool,
  unitConversionTool,
  jokesTool,
  newsTool,
  recipesTool,
  dictionaryTool,
  youtubeTool,
  tvShowsTool,
  datetimeTool,
  moonphaseTool,
  imageGenTool,
  videoGenTool,
  documentEditTool,
  medicalTool,
  whereToWatchTool,
  holidaysTool,
  homeInventoryTool,
  onThisDayTool,
  localEventsTool,
  localNewsTool,
  contentRatingTool,
  sportsTool,
  homeAssistantTool,
  timeTool,
  converterTool,
  bookmarksLibraryTool,
  saveToBookmarksTool,
  propertyLookupTool,
  peopleLookupTool,
  mapsTool,
  repairTool,
  knowledgeTool,
  showtimesTool,
  playMusicTool,
  plexTool,
  setStatusTool,
  sleepTool,
  displayAlertTool,
  rememberTool,
  forgetTool,
]
