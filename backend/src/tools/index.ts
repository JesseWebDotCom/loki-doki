import type { OllamaTool } from '@/llm/ollama'

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  offline?: boolean
  // If set, the chat pipeline speaks this text directly and skips the LLM synthesis
  // pass entirely — for tools whose result is already a finished, speakable reply
  // (e.g. Home Assistant's own action confirmation). Maximum-snappiness path.
  directReply?: string
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
import { readerLibraryTool } from './readerLibrary'
import { saveToReaderTool } from './saveToReader'
import { propertyLookupTool } from './propertyLookup'
import { peopleLookupTool } from './peopleLookup'
import { mapsTool } from './maps'
import { repairTool } from './repair'
import { knowledgeTool } from './knowledge'
import { showtimesTool } from './showtimes'

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
  readerLibraryTool,
  saveToReaderTool,
  propertyLookupTool,
  peopleLookupTool,
  mapsTool,
  repairTool,
  knowledgeTool,
  showtimesTool,
]
