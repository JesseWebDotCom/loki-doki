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

/** A structured client-side action telling the frontend to read a piece of text
 *  aloud with a distinct TTS voice per detected speaker (backend/src/lib/narration).
 *  `turns` are pre-resolved (voice already assigned) so the client can start
 *  playback immediately via the existing streaming TTS pipeline. */
export interface StartNarrationDirective {
  action: 'start_narration'
  sessionId: string
  turns: { voiceId: string | null; text: string }[]
}

/** A structured client-side action telling the frontend to open a Canvas artifact
 *  (a code snippet, markdown document, or small HTML page the companion produced).
 *  On-chat it opens the side pane; off-chat (voice, no chat mounted) it floats the
 *  pane over the current app. The artifact itself is already persisted; the client
 *  loads its content from /api/artifacts/:id and, during the same turn, receives the
 *  streaming body via `artifact_token`/`artifact_done` events. */
export interface OpenArtifactDirective {
  action: 'open_artifact'
  artifactId: string
  artifactType: 'code' | 'document' | 'html'
  title: string
}

/** A structured client-side prompt: the companion staged an action (send,
 *  delete, unlock...) and is asking for confirmation. Surfaces render
 *  approve/decline buttons; either re-enters the turn with a canonical
 *  'Yes'/'No', or the REST endpoint /api/companions/action/:id resolves it.
 *  The staged work itself lives server-side in lib/companionActions. */
export interface ConfirmActionDirective {
  action: 'confirm_action'
  actionId: string
  summary: string
  approveLabel: string
  declineLabel: string
  /** Optional rich preview (e.g. movie poster + "Title (Year)" for a media request)
   *  so the user confirms the exact thing being acted on. Additive: surfaces without
   *  card support keep rendering summary + buttons. */
  card?: { title: string; subtitle?: string; imageUrl?: string }
}

/** A structured client-side action telling the frontend to open a saved playlist
 *  the companion just built or refined (curate_playlist tool). Off-chat (voice) the
 *  shell navigates to the playlist page so the user sees it; `autoplay` is currently
 *  false by design (curating shouldn't hijack whatever audio is playing) but the field
 *  is honored if set, so playback can be opted into later. */
export interface OpenPlaylistDirective {
  action: 'open_playlist'
  playlistId: string
  name: string
  trackCount: number
  autoplay?: boolean
}

export type Directive = PlayMediaDirective | StartNarrationDirective | OpenArtifactDirective | ConfirmActionDirective | OpenPlaylistDirective

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
  // an action (e.g. start playback in the mini-player, or start multi-voice
  // narration). Independent of directReply.
  directive?: Directive
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
  // Core companion plumbing (memory, status, alerts...): never listed on user
  // surfaces (store, app-settings ability toggles); admin master list only.
  core?: boolean
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
import { calendarTool } from './calendar'
import { searchTool } from './search'
import { calculatorTool } from './calculator'
import { unitConversionTool } from './unit_conversion'
import { jokesTool } from './jokes'
import { newsTool } from './news'
import { recipesTool } from './recipes'
import { dictionaryTool } from './dictionary'
import { youtubeTool } from './youtube'
import { videoAboutTool } from './videoAbout'
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
import { serviceStatusTool } from './serviceStatus'
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
import { onTvTool } from './onTv'
import { playMusicTool } from './playMusic'
import { curatePlaylistTool } from './curatePlaylist'
import { musicInsightsTool } from './musicInsights'
import { requestMediaTool } from './requestMedia'
import { downloadStatusTool } from './downloadStatus'
import { plexTool } from './plex'
import { setStatusTool } from './setStatus'
import { sleepTool } from './sleep'
import { displayAlertTool } from './displayAlert'
import { rememberTool, forgetTool } from './memory'
import { shoppingTool } from './shopping'
import { codingTool } from './coding'
import { canvasTool } from './canvas'
import { narrateTool } from './narrate'
import { confirmPendingTool } from './confirmPending'
import { createRoutineTool } from './createRoutine'
import { saveMethodTool } from './saveMethod'
import { machineStatusTool } from './machineStatus'
import { dockFilesTool } from './dockFiles'
import { recallConversationsTool } from './recallConversations'
import { fetchUrlTool } from './fetchUrl'

export const toolRegistry: Tool[] = [
  weatherTool,
  calendarTool,
  searchTool,
  calculatorTool,
  unitConversionTool,
  jokesTool,
  newsTool,
  recipesTool,
  dictionaryTool,
  youtubeTool,
  videoAboutTool,
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
  serviceStatusTool,
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
  onTvTool,
  playMusicTool,
  curatePlaylistTool,
  musicInsightsTool,
  requestMediaTool,
  downloadStatusTool,
  plexTool,
  setStatusTool,
  createRoutineTool,
  saveMethodTool,
  sleepTool,
  displayAlertTool,
  rememberTool,
  forgetTool,
  shoppingTool,
  codingTool,
  canvasTool,
  narrateTool,
  confirmPendingTool,
  machineStatusTool,
  dockFilesTool,
  recallConversationsTool,
  fetchUrlTool,
]
