import { sqliteTable, text, integer, unique, uniqueIndex, real, index, primaryKey, blob } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  nickname: text('nickname').notNull(),
  birthdate: text('birthdate').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  avatarUrl: text('avatar_url'),
  dicebearStyle: text('dicebear_style'),
  dicebearSeed: text('dicebear_seed'),
  dicebearConfig: text('dicebear_config'),  // JSON string
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Presence of a row = profile is PIN-protected. No PIN column on users.
export const profilePins = sqliteTable('profile_pins', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  pinHash: text('pin_hash').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Characters ──────────────────────────────────────────────────────────────

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  personalityPrompt: text('personality_prompt').notNull(),
  backstory: text('backstory'),
  voiceId: text('voice_id'),
  avatarRef: text('avatar_ref'),
  // ── Avatar rigging (DiceBear) ──
  // renderer chooses the avatar engine; 'dicebear' is the only one implemented today,
  // but the behavior engine is renderer-agnostic so 'rive'/'vrm' can drop in later.
  renderer: text('renderer').notNull().default('dicebear'),
  style: text('style'),                 // DiceBear collection name (e.g. 'avataaars')
  seed: text('seed'),                   // DiceBear seed
  avatarConfig: text('avatar_config'),  // JSON: full DiceBear rigging options
  phoneticName: text('phonetic_name'),
  replyStyle: text('reply_style', { enum: ['brief', 'balanced', 'detailed', 'auto'] }).notNull().default('balanced'),
  // ── Voice ──
  // ttsVoice is a qualified `engine:voice_id` (e.g. 'piper:en_US-amy-medium' or
  // 'clone:loki'); null falls back to the user/app default voice. voiceId (above)
  // remains the link to this character's active voiceSamples reference for cloning.
  ttsVoice: text('tts_voice'),
  // Wakeword model id (a pretrained catalog id like 'hey_jarvis' or a trained
  // model id); null falls back to the app default wakeword.
  wakeWordModelId: text('wake_word_model_id'),
  wakeWordPhrase: text('wake_word_phrase'),
  speechRate: real('speech_rate'),       // 0.8–1.3 multiplier; null = engine default
  // 0–1: how far emote/punctuation prosody swings from neutral. null = default (0.6).
  expressiveness: real('expressiveness'),
  // Content config: JSON { profanity, sexual, violence, substances, candor }. The
  // character's fixed, non-negotiable content identity — gated by the user's ceiling.
  // null = all dials off (most widely usable). See @/lib/contentPolicy.
  contentDials: text('content_dials'),
  // Store category key for the Companion Store (e.g. 'everyday', 'coaches', 'mature').
  // See frontend lib/companions/companionCategories.ts. null = uncategorized.
  category: text('category'),
  createdBy: text('created_by').notNull().references(() => users.id),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  published: integer('published', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Per-user character access grants. Default-visible: a character with isActive+published
// is shown to everyone UNLESS an explicit 'off' grant row exists for that user.
// Mirrors imageLoraUserLoraGrants.
export const characterUserGrants = sqliteTable('character_user_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['on', 'off'] }).notNull().default('on'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userCharacterUnique: unique().on(t.userId, t.characterId),
}))

export const voiceSamples = sqliteTable('voice_samples', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  durationSeconds: integer('duration_seconds'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Wakeword model catalog. Pretrained entries (hey_jarvis, alexa, hey_mycroft)
// live in a frontend constant; this table holds TRAINED/custom per-character
// ONNX models (kind='trained', characterId set) plus admin enable flags.
export const wakeWordCatalog = sqliteTable('wake_word_catalog', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  kind: text('kind', { enum: ['pretrained', 'trained'] }).notNull().default('trained'),
  assetPath: text('asset_path'),         // path under data/voices/wakewords/<id>.onnx
  defaultThreshold: real('default_threshold'),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Physical Pod devices (ESP32 voice satellites). Bound to a user + optional
// companion/wake word; the Wyoming gateway authenticates the socket via tokenHash.
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('pod'),   // dot | show | watch | tablet | pod
  wakeWord: text('wake_word'),                    // optional per-device detector id
  tokenHash: text('token_hash'),                  // SHA-256 of the device token; null until paired
  pairingCode: text('pairing_code'),              // short-lived code; null once redeemed
  pairingExpiresAt: integer('pairing_expires_at', { mode: 'timestamp' }),
  capabilities: text('capabilities'),             // JSON: { screen, camera, sampleRate }
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Created on first interaction between a user and a character
export const userCharacters = sqliteTable('user_characters', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  nickname: text('nickname'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userCharUnique: unique().on(t.userId, t.characterId),
}))

// ─── Projects ─────────────────────────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  color: text('color'),
  description: text('description'),
  instructions: text('instructions'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// ─── Conversations & Messages ─────────────────────────────────────────────────

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  title: text('title'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  // Tracks up to which message timestamp the memory judge has processed this conversation.
  // Null = never processed. The idle sweep only runs the judge on messages newer than this.
  memoryProcessedThrough: integer('memory_processed_through', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Memory ───────────────────────────────────────────────────────────────────

// Named entities (people, places, things) personally relevant to the user.
// Linked to memories via memories.entity_id for deterministic alias-based recall.
// Scoping mirrors memories: user-global (character_id=null), character-instance, character-global.
export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['person', 'place', 'thing', 'org'] }).notNull().default('person'),
  // JSON string array of lowercase aliases (e.g. ["brother","art","artie"])
  aliases: text('aliases').notNull().default('[]'),
  importance: integer('importance').notNull().default(5), // 1–10
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  // user_id=X, character_id=null  → user-global (any character can read)
  // user_id=X, character_id=Y     → character-instance (what Y knows about X)
  // user_id=null, character_id=Y  → character-global (Y's own knowledge)
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  // FK to entities (enforced in app code — SQLite ALTER TABLE doesn't support FK constraints)
  entityId: text('entity_id'),
  text: text('text').notNull(),
  sourceText: text('source_text'),
  category: text('category', {
    enum: ['person', 'place', 'thing', 'preference', 'identity', 'event', 'project', 'goal', 'relationship', 'fact'],
  }).notNull().default('fact'),
  // durable = identity/relationship/person/preference — never pruned
  // episodic = event/goal/project/thing/place/fact   — subject to decay & archival
  tier: text('tier', { enum: ['durable', 'episodic'] }).notNull().default('episodic'),
  // active = normal | superseded = overwritten by newer fact | archived = pruned by maintenance
  status: text('status', { enum: ['active', 'superseded', 'archived'] }).notNull().default('active'),
  // JSON float array from nomic-embed-text, computed in-process for cosine similarity
  embedding: text('embedding'),
  importance: integer('importance').notNull().default(5), // 1–10
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  uses: integer('uses').notNull().default(0),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const memoryEpisodes = sqliteTable('memory_episodes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  summary: text('summary').notNull(),
  embedding: text('embedding'),
  messageCount: integer('message_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── App Settings ─────────────────────────────────────────────────────────────

export const appSettings = sqliteTable('app_settings', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Background download jobs ────────────────────────────────────────────────
// Durable, server-owned download queue. First-run hands the non-essential set
// (extra models, ZIMs, maps, components) to this so the app can boot on essentials
// and finish the rest in the background — surviving navigation and backend restarts.

export const downloadJobs = sqliteTable('download_jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),            // 'model' | 'archive' | 'map' | 'component'
  refId: text('ref_id').notNull(),         // model id | sourceId | regionId | component id
  variantKey: text('variant_key'),         // archives only
  domain: text('domain').notNull(),        // 'ollama' | 'huggingface' | 'kiwix' | 'maps' | 'comfyui' | 'github'
  sizeClass: text('size_class').notNull(), // 'large' | 'small'
  label: text('label').notNull(),
  priority: integer('priority').notNull().default(100),
  status: text('status').notNull().default('pending'), // pending|running|completed|failed|cancelled
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(4),
  nextEligibleAt: integer('next_eligible_at', { mode: 'timestamp' }), // backoff gate
  lastError: text('last_error'),
  progress: text('progress'),              // JSON {completed,total,speedBps,etaSeconds,note}
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Tool Config ─────────────────────────────────────────────────────────────

export const toolUserPermissions = sqliteTable('tool_user_permissions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toolId: text('tool_id').notNull(),
  state: text('state', { enum: ['allow', 'deny'] }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ unique: unique().on(t.userId, t.toolId) }))

export const toolGlobalConfig = sqliteTable('tool_global_config', {
  id: text('id').primaryKey(),
  toolId: text('tool_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ toolKeyUnique: unique().on(t.toolId, t.key) }))

export const toolUserConfig = sqliteTable('tool_user_config', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toolId: text('tool_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userToolKeyUnique: unique().on(t.userId, t.toolId, t.key) }))

// Per-user Home Assistant control grants. Each row is one (domain, area) scope a
// user is allowed to control. Wildcard '*' means "all". A user with no rows cannot
// control anything (admins bypass). Examples:
//   (userId, '*',     '*')          → control everything
//   (userId, 'light', '*')          → all lights, any area
//   (userId, '*',     'office')     → everything in the office
//   (userId, 'light', 'living_room')→ living-room lights only
export const haUserGrants = sqliteTable('ha_user_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),   // entity domain (light, switch, …) or '*'
  areaId: text('area_id').notNull(),   // HA area id/slug or '*'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ grantUnique: unique().on(t.userId, t.domain, t.areaId) }))

export const userPreferences = sqliteTable('user_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userKeyUnique: unique().on(t.userId, t.key),
}))

// ─── Image Generation ─────────────────────────────────────────────────────────

export const generatedImages = sqliteTable('generated_images', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  negativePrompt: text('negative_prompt'),
  seed: integer('seed'),
  width: integer('width').notNull().default(1024),
  height: integer('height').notNull().default(1024),
  steps: integer('steps').notNull().default(20),
  guidance: real('guidance').notNull().default(3.5),
  modelId: text('model_id'),
  state: text('state', { enum: ['building', 'ready', 'failed', 'cancelled'] }).notNull().default('building'),
  failureReason: text('failure_reason'),
  path: text('path'),
  stepCurrent: integer('step_current'),
  loraIds: text('lora_ids').notNull().default('[]'),
  pipeline: text('pipeline').notNull().default('txt2img'),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── File Conversions ─────────────────────────────────────────────────────────

export const conversions = sqliteTable('conversions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  inputName: text('input_name').notNull(),
  outputName: text('output_name').notNull(),
  inputFormat: text('input_format').notNull(),
  outputFormat: text('output_format').notNull(),
  family: text('family', { enum: ['image', 'audio', 'video'] }).notNull(),
  engine: text('engine').notNull(),
  relPath: text('rel_path'), // relative to user-data root; null until ready
  state: text('state', { enum: ['pending', 'converting', 'ready', 'failed', 'cancelled'] }).notNull().default('pending'),
  failureReason: text('failure_reason'),
  inputBytes: integer('input_bytes'),
  outputBytes: integer('output_bytes'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Vision Analysis ──────────────────────────────────────────────────────────

export const analysisResults = sqliteTable('analysis_results', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  path: text('path'), // saved source image at data/analysis/{id}.png
  result: text('result'), // JSON: AnalysisResult shape
  model: text('model').notNull(),
  tasks: text('tasks').notNull().default('[]'), // JSON: string[]
  state: text('state', { enum: ['building', 'ready', 'failed'] }).notNull().default('building'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Music Generation ─────────────────────────────────────────────────────────
// A saved music track from the Music app. v1 only produces tracks client-side via
// the offline MIDI engine (`engine: 'midi-offline'`), but the columns are shaped so
// future server-side engines (neural/Suno-like) and stem separation slot in with no
// migration: `engine`/`prompt`/`metaJson` carry arbitrary provenance, `state` powers
// async jobs, and `parentTrackId` + `kind='stem'` model separated stems.

export const musicTracks = sqliteTable('music_tracks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  kind: text('kind', { enum: ['track', 'intro', 'outro', 'loop', 'bed', 'stem'] }).notNull().default('track'),
  engine: text('engine').notNull().default('midi-offline'),  // midi-offline | neural | remix | upload
  styleId: text('style_id'),
  bpm: integer('bpm'),
  keyName: text('key_name'),
  sourceName: text('source_name'),       // remix/import origin (e.g. "mario.mid")
  prompt: text('prompt'),                 // free-text (Suno-style), for future engines
  metaJson: text('meta_json'),            // engine-specific params: lyrics, style tags, model id, stem layout
  durationSec: real('duration_sec'),
  state: text('state', { enum: ['building', 'ready', 'failed', 'cancelled'] }).notNull().default('ready'),
  failureReason: text('failure_reason'),
  stepCurrent: integer('step_current'),
  parentTrackId: text('parent_track_id'), // self-ref: stems point at their source track
  path: text('path'),                     // relative; per-track dir <id>/main.wav
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Resolver cache: maps a MusicBrainz recording (or a synthetic keyless query key) to the
// YouTube videoId we play for it. Resolution is fuzzy and rate-limited, so we cache the
// answer permanently and reuse it everywhere (stations, playlists, search, offline). A row
// with a null videoId is a memoised miss ("we looked and found nothing playable").
export const musicResolve = sqliteTable('music_resolve', {
  key: text('key').primaryKey(),          // recording MBID, or `q:<sha>` for keyless lookups
  videoId: text('video_id'),              // resolved YouTube id; null = known-unresolvable
  title: text('title'),
  artist: text('artist'),
  durationSec: integer('duration_sec'),
  score: real('score'),                   // resolver confidence (debug/tuning)
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }).notNull(),
})

// AI music stations. A station is a *rule* (an AI prompt or an artist/song seed) that the
// station engine turns into a fresh YouTube-backed queue on each tune-in. userId null +
// isBuiltin = a default station shipped on every install; visibility 'shared' = a user-made
// station the whole family can see and play (owner-only edits). djMode controls the AI DJ:
// full (talks between songs), minimal (just announces each song), or silent.
export const musicStations = sqliteTable('music_stations', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = built-in
  name: text('name').notNull(),
  description: text('description'),
  aiPrompt: text('ai_prompt').notNull().default(''),
  seedType: text('seed_type', { enum: ['prompt', 'genre', 'artist', 'song'] }).notNull().default('prompt'),
  seedValue: text('seed_value'),
  iconPath: text('icon_path'),        // relative path to generated station icon (SVG)
  bannerPath: text('banner_path'),    // relative path to generated station banner (SVG)
  accent: text('accent'),             // color slug for tinting when art is absent
  category: text('category'),         // browse grouping for built-ins (Genres, Moods, Movies…)
  loadingMessages: text('loading_messages'), // JSON string[] of playful "tuning in" lines (LLM-written, per station)
  djMode: text('dj_mode', { enum: ['full', 'minimal', 'silent'] }).notNull().default('full'),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull().default('private'),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// User-curated playlists — an explicit, fixed track list (distinct from generative stations).
export const musicPlaylists = sqliteTable('music_playlists', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  coverPath: text('cover_path'),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull().default('private'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const musicPlaylistTracks = sqliteTable('music_playlist_tracks', {
  id: text('id').primaryKey(),
  playlistId: text('playlist_id').notNull().references(() => musicPlaylists.id, { onDelete: 'cascade' }),
  mbid: text('mbid'),                 // MusicBrainz recording id when known
  videoId: text('video_id').notNull(),
  title: text('title').notNull(),
  artist: text('artist'),
  durationSec: integer('duration_sec'),
  position: integer('position').notNull().default(0),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
})

// Favorites: songs, stations, or playlists a user has hearted. refId is a videoId (songs) or
// the station/playlist id. Favoriting a shared station keeps it linked to the original.
export const musicFavorites = sqliteTable('music_favorites', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['song', 'station', 'playlist'] }).notNull(),
  refId: text('ref_id').notNull(),
  title: text('title'),               // denormalized for song favorites (videoId has no row)
  artist: text('artist'),
  mbid: text('mbid'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userKindRefUnique: unique().on(t.userId, t.kind, t.refId) }))

// Listening history — powers "Continue listening" + recently played.
export const musicHistory = sqliteTable('music_history', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: text('video_id').notNull(),
  mbid: text('mbid'),
  title: text('title').notNull(),
  artist: text('artist'),
  stationId: text('station_id'),      // the station/playlist context, when played from one
  positionSec: real('position_sec').notNull().default(0),
  playedAt: integer('played_at', { mode: 'timestamp' }).notNull(),
})

// ─── Offline music ──────────────────────────────────────────────────────────────
// Saving a station "offline" freezes its generative queue into a fixed tracklist, downloads
// each track's audio (via ytDownloads), and pre-renders the AI DJ — so the station plays end
// to end with no internet. One musicOfflineStations row per (user, station); display fields are
// cached so offline cards render with zero live calls. status: pending→partial→ready/failed.
export const musicOfflineStations = sqliteTable('music_offline_stations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stationId: text('station_id').notNull(),
  name: text('name').notNull(),
  accent: text('accent'),
  djMode: text('dj_mode', { enum: ['full', 'minimal', 'silent'] }).notNull().default('full'),
  media: text('media', { enum: ['audio', 'video', 'both'] }).notNull().default('audio'), // what was downloaded
  iconPath: text('icon_path'),
  bannerPath: text('banner_path'),
  status: text('status', { enum: ['pending', 'partial', 'ready', 'failed'] }).notNull().default('pending'),
  trackTotal: integer('track_total').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userStationUnique: unique().on(t.userId, t.stationId) }))

// The frozen tracklist captured at save time — decouples offline playback from live re-resolution.
export const musicOfflineStationTracks = sqliteTable('music_offline_station_tracks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stationId: text('station_id').notNull(),
  videoId: text('video_id').notNull(),
  title: text('title').notNull(),
  artist: text('artist'),
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Pre-rendered AI DJ segments for an offline station. position 'transition' carries fromVideoId
// (the song that just finished) and toVideoId (what's next); 'intro'/'outro' use fromVideoId only.
export const musicDjCache = sqliteTable('music_dj_cache', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stationId: text('station_id').notNull(),
  position: text('position', { enum: ['intro', 'transition', 'outro'] }).notNull(),
  fromVideoId: text('from_video_id'),
  toVideoId: text('to_video_id'),
  // Context stored at snapshot time so the LLM can generate fresh audio on demand.
  genre: text('genre'),
  stationName: text('station_name'),
  trackName: text('track_name'),
  artistName: text('artist_name'),
  nextTrackName: text('next_track_name'),
  nextArtistName: text('next_artist_name'),
  style: text('style'),
  facts: text('facts'),  // cached Wikipedia lookup; null = no trivia available offline
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── LoRA System ──────────────────────────────────────────────────────────────

export const imageLoraCategories = sqliteTable('image_lora_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const imageLoras = sqliteTable('image_loras', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  categoryId: text('category_id').references(() => imageLoraCategories.id, { onDelete: 'set null' }),
  sourceUrl: text('source_url'),
  author: text('author'),
  baseFamilies: text('base_families').notNull().default('["flux"]'),
  sha256: text('sha256'),
  sizeBytes: integer('size_bytes'),
  filePath: text('file_path').notNull(),
  triggerTokens: text('trigger_tokens').notNull().default('[]'),
  defaultWeight: real('default_weight').notNull().default(1.0),
  minWeight: real('min_weight').notNull().default(0.0),
  maxWeight: real('max_weight').notNull().default(2.0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  thumbnailUrl: text('thumbnail_url'),
  styleLabel: text('style_label'),
  // Routing metadata — populated by background LLM extraction after import
  civitaiId: text('civitai_id'),
  whenToUse: text('when_to_use'),
  exampleRequests: text('example_requests').notNull().default('[]'),
  isStylisticLora: integer('is_stylistic_lora', { mode: 'boolean' }).notNull().default(false),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Per-user category grants (state='on' = access granted, state='off' = revoked)
export const imageLoraUserCategoryGrants = sqliteTable('image_lora_user_category_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => imageLoraCategories.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['on', 'off'] }).notNull().default('on'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userCategoryUnique: unique().on(t.userId, t.categoryId),
}))

// Per-user lora grants (state='on' = access granted, state='off' = revoked)
export const imageLoraUserLoraGrants = sqliteTable('image_lora_user_lora_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  loraId: text('lora_id').notNull().references(() => imageLoras.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['on', 'off'] }).notNull().default('on'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userLoraUnique: unique().on(t.userId, t.loraId),
}))

// NOTE: the legacy Organizr-style `bookmarks` table was removed — live links now live
// in the unified Bookmarks library (see the `bookmarks` table below, formerly bookmarks).

// ─── ZIM Archives (offline content via kiwix-serve) ───────────────────────────

export const zimArchives = sqliteTable('zim_archives', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().unique(),
  variantKey: text('variant_key').notNull(),
  kiwixBookName: text('kiwix_book_name'),  // ZIM Name metadata — kiwix-serve URL path segment
  filePath: text('file_path'),
  fileSizeBytes: integer('file_size_bytes'),
  zimDate: text('zim_date'),               // e.g. "2024-12"
  downloadedAt: integer('downloaded_at', { mode: 'timestamp' }),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }),  // last passed corrupt-check
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Home Inventory ───────────────────────────────────────────────────────────

export const homeDevices = sqliteTable('home_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  brand: text('brand'),
  model: text('model'),
  serialNumber: text('serial_number'),
  category: text('category', {
    enum: ['appliance', 'electronics', 'vehicle', 'tool', 'furniture', 'other'],
  }).notNull().default('other'),
  location: text('location'),
  owner: text('owner'),
  description: text('description'),
  manufacturedDate: text('manufactured_date'), // e.g. "2020" or "2020-03"
  specs: text('specs'),                        // JSON key-value object
  photoPath: text('photo_path'),
  mainPhotoId: text('main_photo_id'),          // references homeDeviceFiles.id
  purchaseDate: text('purchase_date'),       // YYYY-MM-DD
  purchasePrice: real('purchase_price'),
  purchaseStore: text('purchase_store'),
  warrantyExpires: text('warranty_expires'), // YYYY-MM-DD
  warrantyNotes: text('warranty_notes'),
  supportUrl: text('support_url'),
  supportPhone: text('support_phone'),
  rawLabelText: text('raw_label_text'),       // verbatim OCR text from identify scan
  manualPath: text('manual_path'),           // local cached PDF path
  manualUrl: text('manual_url'),             // source URL
  manualFetchedAt: integer('manual_fetched_at', { mode: 'timestamp' }),
  manualText: text('manual_text'),           // extracted text for RAG
  notes: text('notes'),
  lookupStatus: text('lookup_status', {
    enum: ['pending', 'complete', 'failed', 'skipped'],
  }).notNull().default('pending'),
  lookupQueuedAt: integer('lookup_queued_at', { mode: 'timestamp' }),
  addedBy: text('added_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const homeServiceLog = sqliteTable('home_service_log', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => homeDevices.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),             // YYYY-MM-DD
  type: text('type', {
    enum: ['repair', 'maintenance', 'inspection', 'upgrade', 'other'],
  }).notNull().default('other'),
  description: text('description').notNull(),
  technician: text('technician'),
  cost: real('cost'),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const homeDeviceFiles = sqliteTable('home_device_files', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => homeDevices.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  filePath: text('file_path').notNull(),
  fileType: text('file_type', { enum: ['pdf', 'image', 'other'] }).notNull().default('other'),
  source: text('source', { enum: ['user', 'ai'] }).notNull().default('user'),
  sizeBytes: integer('size_bytes'),
  uploadedBy: text('uploaded_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  comment: text('comment'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const homeDeviceLinks = sqliteTable('home_device_links', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => homeDevices.id, { onDelete: 'cascade' }),
  category: text('category', { enum: ['manual', 'support', 'download', 'video', 'other'] }).notNull().default('other'),
  label: text('label').notNull(),
  url: text('url').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['install_request', 'install_complete', 'download_complete', 'system', 'frigate_event'] }).notNull(),
  payload: text('payload').notNull().default('{}'),
  readAt: integer('read_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ── Content profiles ──────────────────────────────────────────────────────────
// A named set of per-category content ceilings, assigned to users. Built-ins are
// seeded at boot; admins can edit them and create their own. `dials` is a JSON
// Record<DialKey, level>. See lib/contentPolicy.ts.
export const contentProfiles = sqliteTable('content_profiles', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  dials: text('dials').notNull(),               // JSON Record<DialKey, level>
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ── Frigate camera integration ────────────────────────────────────────────────
// One row per notable Frigate event. Two producers:
//   • 'genai'  — the OpenAI-compatible shim (kind 'description'): what the VLM told
//                Frigate, logged for the admin history.
//   • 'mqtt'   — the event consumer (kinds 'object' | 'plate' | 'review'): the
//                source of truth for notifications + companion announcements,
//                because it carries camera/label/sub_label/plate/zone/severity.
// `announce` marks rows that should be spoken aloud; `spoken` is claimed by the
// first client that voices it so other open tabs don't double-speak.
export const frigateEvents = sqliteTable('frigate_events', {
  id: text('id').primaryKey(),
  source: text('source', { enum: ['genai', 'mqtt'] }).notNull(),
  kind: text('kind', { enum: ['object', 'plate', 'review', 'description'] }).notNull(),
  camera: text('camera'),
  eventId: text('event_id'),            // Frigate tracked-object / review id
  label: text('label'),                 // person, car, dog, ...
  subLabel: text('sub_label'),          // delivery brand / recognized name
  plate: text('plate'),                 // normalized recognized plate
  plateName: text('plate_name'),        // friendly name if the plate is known
  zones: text('zones'),                 // JSON array of zone names
  severity: text('severity'),           // normal | suspicious | dangerous (reviews)
  title: text('title'),
  description: text('description'),      // VLM / genai text
  score: real('score'),
  snapshotUrl: text('snapshot_url'),
  clipUrl: text('clip_url'),
  announce: integer('announce', { mode: 'boolean' }).notNull().default(false),
  spoken: integer('spoken', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ── Maps subsystem ────────────────────────────────────────────────────────────

// One row per installed offline map region. `street`/.../geocoder flags mirror
// which artifacts have finished building for that region (streets.pmtiles,
// graphhopper routing graph, FTS geocoder DB). `bytesOnDisk` is a JSON map of
// artifact → bytes. `installStatus`: pending | building | ready | error.
export const mapRegions = sqliteTable('map_regions', {
  id: text('id').primaryKey(),
  regionId: text('region_id').notNull().unique(),       // e.g. 'us-ct'
  street: integer('street', { mode: 'boolean' }).notNull().default(true),
  installStatus: text('install_status').notNull().default('pending'),
  phase: text('phase'),                                  // current build phase
  streetInstalled: integer('street_installed', { mode: 'boolean' }).notNull().default(false),
  demInstalled: integer('dem_installed', { mode: 'boolean' }).notNull().default(false),
  landcoverInstalled: integer('landcover_installed', { mode: 'boolean' }).notNull().default(false),
  valhallaInstalled: integer('valhalla_installed', { mode: 'boolean' }).notNull().default(false),
  pbfInstalled: integer('pbf_installed', { mode: 'boolean' }).notNull().default(false),
  geocoderInstalled: integer('geocoder_installed', { mode: 'boolean' }).notNull().default(false),
  openaddressesInstalled: integer('openaddresses_installed', { mode: 'boolean' }).notNull().default(false),
  geocoderSchemaVersion: integer('geocoder_schema_version').notNull().default(2),
  bytesOnDisk: text('bytes_on_disk').notNull().default('{}'),  // JSON: artifact → bytes
  lastError: text('last_error'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// User-created saved map pins. `placeRef` holds the JSON PlaceResult snapshot.
export const mapsSavedPins = sqliteTable('maps_saved_pins', {
  pinId: text('pin_id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  color: text('color').notNull(),
  placeRefJson: text('place_ref_json'),
  notes: text('notes'),
  collectionId: text('collection_id'),
  createdAt: text('created_at').notNull(),  // ISO string, matches v2 contract
})

// ─── YouTube Client ───────────────────────────────────────────────────────────

export const ytSubscriptions = sqliteTable('yt_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['channel', 'playlist'] }).notNull().default('channel'),
  externalId: text('external_id').notNull(),   // channel_id or playlist_id
  title: text('title').notNull().default(''),
  handle: text('handle'),
  thumbnailUrl: text('thumbnail_url'),
  description: text('description'),
  lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp' }),
  // Last full back-catalog reconcile (InnerTube channel/playlist scan). The RSS poller
  // only sees the 15 newest items, so anything that scrolls past that window between polls
  // (bursts, extended downtime) is invisible to it forever; the reconcile re-scans deeply
  // on a slow cadence to backfill those missed rows. See youtube/reconcile.ts.
  lastReconciledAt: integer('last_reconciled_at', { mode: 'timestamp' }),
  // Automation (off by default — subscribing only adds the channel to your feed).
  // autoSave: download each new upload offline; autoSaveKind: as video or audio-only;
  // autoSaveKeep: per-sub rolling "keep latest N" override (null → global default).
  autoSave: integer('auto_save', { mode: 'boolean' }).notNull().default(false),
  autoSaveKind: text('auto_save_kind', { enum: ['audio', 'video'] }).notNull().default('video'),
  autoSaveKeep: integer('auto_save_keep'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userExtUnique: unique().on(t.userId, t.externalId) }))

export const ytVideos = sqliteTable('yt_videos', {
  id: text('id').primaryKey(),
  videoId: text('video_id').notNull().unique(),
  subscriptionId: text('subscription_id').references(() => ytSubscriptions.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  author: text('author').notNull().default(''),
  channelId: text('channel_id'),
  thumbnailUrl: text('thumbnail_url'),
  channelThumb: text('channel_thumb'),         // channel avatar URL (resolved at save time so Offline cards show real logos)
  publishedAt: integer('published_at'),        // Unix ms
  durationSec: integer('duration_sec'),
  description: text('description'),
  summary: text('summary'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Cached first page of a channel's Videos tab (meta + videos + continuation token).
// Lets channel pages load instantly without re-hitting YouTube, and — crucially —
// be served stale when a live InnerTube fetch fails, so a transient error never
// leaves a channel showing zero videos.
export const ytChannelCache = sqliteTable('yt_channel_cache', {
  channelId: text('channel_id').primaryKey(),
  metaJson: text('meta_json'),
  videosJson: text('videos_json').notNull().default('[]'),
  continuation: text('continuation'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
})

// Read-through cache for YouTube artwork (video thumbnails, channel avatars + banners).
// The /img proxy fills this lazily; bytes live on disk under data/yt-image-cache/<urlHash>.
// Non-subscribed entries are evicted 24h after fetch; subscribed channel artwork is kept
// and conditionally re-validated (ETag/Last-Modified) every 24h by the maintenance pass.
export const ytImageCache = sqliteTable('yt_image_cache', {
  urlHash: text('url_hash').primaryKey(),       // sha256 of the source URL
  url: text('url').notNull(),
  filePath: text('file_path'),                  // filename under data/yt-image-cache/ (== urlHash)
  contentType: text('content_type'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  subscribed: integer('subscribed', { mode: 'boolean' }).notNull().default(false),
  sizeBytes: integer('size_bytes'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
  checkedAt: integer('checked_at', { mode: 'timestamp' }).notNull(),
})

export const ytDownloads = sqliteTable('yt_downloads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: text('video_id').notNull(),
  title: text('title').notNull().default(''),
  kind: text('kind', { enum: ['audio', 'video'] }).notNull().default('audio'),
  relPath: text('rel_path'),
  transcriptRelPath: text('transcript_rel_path'),
  status: text('status', { enum: ['pending', 'downloading', 'ready', 'failed'] }).notNull().default('pending'),
  sizeBytes: integer('size_bytes'),
  maxHeight: integer('max_height'),   // resolution THIS user requested (drives the asset's desiredHeight)
  // Points at the shared media_assets rendition that holds the actual bytes. Null on legacy
  // rows until the background dedup migration links them; serve falls back to relPath then.
  assetId: text('asset_id'),
  // True when written by subscription auto-save (vs an explicit user Save). Only auto
  // rows are eligible for the rolling "keep latest N" prune — manual saves never expire.
  auto: integer('auto', { mode: 'boolean' }).notNull().default(false),
  // True when written by the transient music PREFETCH cache (download-ahead for gapless play).
  // Ephemeral: hidden from libraries and evicted by a rolling keep-N prune. Promoted to a real
  // ref (prefetch=false) if the user later explicitly saves the same track.
  prefetch: integer('prefetch', { mode: 'boolean' }).notNull().default(false),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userVidKindUnique: unique().on(t.userId, t.videoId, t.kind) }))

// ── Content-addressable blob store (Layer 1) ────────────────────────────────────
// One row per physical file on disk, keyed by sha256(bytes). Byte-identical content from
// any app/user/source collapses to one blob. `status` gates GC: a freshly-written blob is
// `staging` (invisible to GC) until a referrer flips it `live`. See lib/content/store.ts.
export const blobs = sqliteTable('blobs', {
  hash: text('hash').primaryKey(),                 // sha256 hex of the bytes
  relPath: text('rel_path').notNull(),             // relative to the user data root
  sizeBytes: integer('size_bytes').notNull(),
  mime: text('mime'),
  status: text('status', { enum: ['staging', 'live'] }).notNull().default('staging'),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ── Media assets (Layer 2: identity + store-the-max) ────────────────────────────
// One logical rendition of a piece of media, keyed by (sourceType, sourceId, kind, format).
// Holds the single best-quality blob anyone in the household requested (store-the-max for
// video; audio is height-independent). yt_downloads rows are the per-user REFERENCES.
export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull().default('youtube'),
  sourceId: text('source_id').notNull(),           // e.g. the YouTube videoId
  kind: text('kind', { enum: ['audio', 'video'] }).notNull(),
  format: text('format').notNull(),                // container (m4a | mp3 | mp4) — part of identity
  height: integer('height'),                       // actual stored pixel height (null for audio)
  blobHash: text('blob_hash'),                     // → blobs.hash; null until first download lands
  status: text('status', { enum: ['pending', 'downloading', 'ready', 'failed'] }).notNull().default('pending'),
  sizeBytes: integer('size_bytes'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ srcUnique: unique().on(t.sourceType, t.sourceId, t.kind, t.format) }))

export const ytWatchState = sqliteTable('yt_watch_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: text('video_id').notNull(),
  positionSec: real('position_sec').notNull().default(0),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userVidUnique: unique().on(t.userId, t.videoId) }))

// Per-user video collections (Watch Later, Liked). Server-backed so they sync across
// devices instead of living only in one browser's localStorage.
export const ytCollections = sqliteTable('yt_collections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  collection: text('collection', { enum: ['watch-later', 'liked'] }).notNull(),
  videoId: text('video_id').notNull(),
  title: text('title').notNull().default(''),
  author: text('author'),
  channelId: text('channel_id'),
  durationSec: integer('duration_sec'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userColVidUnique: unique().on(t.userId, t.collection, t.videoId) }))

// ─── Podcasts ─────────────────────────────────────────────────────────────────

export const podcastShows = sqliteTable('podcast_shows', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  coverRelPath: text('cover_rel_path'),
  style: text('style', { enum: ['recap', 'in-depth', 'roundtable', 'interview', 'briefing', 'story'] }).notNull().default('recap'),
  scheduleJson: text('schedule_json'),
  segmentsJson: text('segments_json').notNull().default('[]'),
  hostsJson: text('hosts_json').notNull().default('[]'),
  stingerJson: text('stinger_json'),
  // Internal per-show "cast": each host's topic-relative persona (role, background,
  // hobbies) plus an evolving rolling history of per-episode personal "life beats".
  // Generated once, nudged a little each episode. Not surfaced in the UI.
  castJson: text('cast_json'),
  visibility: text('visibility', { enum: ['personal', 'shared'] }).notNull().default('personal'),
  source: text('source', { enum: ['user', 'suggested', 'app'] }).notNull().default('user'),
  // Origin of an auto-built show, e.g. 'channel:<id>' / 'playlist:<id>' — lets a YouTube
  // source find the show it created so "generate next batch" can continue it.
  sourceRef: text('source_ref'),
  // When true, the feed poller auto-generates a new episode whenever a fresh video lands
  // for the subscription matching this show's sourceRef. Off by default; opt-in per show.
  autoGenerate: integer('auto_generate', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ ownerIdx: index('podcast_shows_owner_idx').on(t.ownerUserId) }))

export const podcastEpisodes = sqliteTable('podcast_episodes', {
  id: text('id').primaryKey(),
  showId: text('show_id').notNull().references(() => podcastShows.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  audioRelPath: text('audio_rel_path'),
  durationSec: integer('duration_sec'),
  chaptersJson: text('chapters_json'),
  scriptJson: text('script_json'),
  status: text('status', { enum: ['pending', 'generating', 'ready', 'failed'] }).notNull().default('pending'),
  error: text('error'),
  generatedAt: integer('generated_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ showIdx: index('podcast_episodes_show_idx').on(t.showId) }))

// Which source items (e.g. YouTube videos) fed each generated episode — powers the
// reverse link "this video is featured in these podcasts" on the YouTube watch page.
export const podcastEpisodeSources = sqliteTable('podcast_episode_sources', {
  id: text('id').primaryKey(),
  episodeId: text('episode_id').notNull().references(() => podcastEpisodes.id, { onDelete: 'cascade' }),
  sourceType: text('source_type', { enum: ['youtube', 'tvshow', 'movie'] }).notNull().default('youtube'),
  sourceId: text('source_id').notNull(),   // YouTube videoId, TVMaze episode id, or movie title
  title: text('title'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  episodeIdx: index('podcast_ep_sources_ep_idx').on(t.episodeId),
  sourceIdx: index('podcast_ep_sources_src_idx').on(t.sourceType, t.sourceId),
  epSourceUnique: unique().on(t.episodeId, t.sourceType, t.sourceId),
}))

export const podcastSuggestions = sqliteTable('podcast_suggestions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  templateKey: text('template_key').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  style: text('style').notNull().default('recap'),
  segmentsJson: text('segments_json').notNull().default('[]'),
  status: text('status', { enum: ['pending', 'accepted', 'dismissed'] }).notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userTplUnique: unique().on(t.userId, t.templateKey) }))

export const podcastWatchState = sqliteTable('podcast_watch_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  episodeId: text('episode_id').notNull().references(() => podcastEpisodes.id, { onDelete: 'cascade' }),
  positionSec: real('position_sec').notNull().default(0),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userEpUnique: unique().on(t.userId, t.episodeId) }))

// Cache of web-enriched POI metadata (phone/website/menu), keyed by place_id.
export const mapsPoiEnrichments = sqliteTable('maps_poi_enrichments', {
  placeId: text('place_id').primaryKey(),
  title: text('title').notNull().default(''),
  subtitle: text('subtitle').notNull().default(''),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  category: text('category').notNull().default(''),
  phone: text('phone'),
  website: text('website'),
  menuUrl: text('menu_url'),
  lastAttemptAt: text('last_attempt_at').notNull(),
  lastSuccessAt: text('last_success_at'),
  menuAttemptAt: text('menu_attempt_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Generic lookup cache ─────────────────────────────────────────────────────────
// Read-through TTL cache shared by any tool that scrapes a slow/rate-limited external
// source (property lookup, people lookup, …). One row per (namespace, key); `data` is
// the JSON-serialised result — including JSON `null` to mark a "fetched but empty"
// negative result so we don't re-scrape a miss every time. `expiresAt` is epoch ms.
export const lookupCache = sqliteTable('lookup_cache', {
  key: text('key').primaryKey(),         // `${namespace}:${sha256(key)}`
  namespace: text('namespace').notNull(),
  data: text('data').notNull(),          // JSON-encoded payload (may be "null")
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

// ─── Time / Clock App ───────────────────────────────────────────────────────────
// World-clock locations, alarms, and timer presets. All per-user. The `tone` column
// references either a synthesized built-in ("builtin:<key>") or a saved music track
// ("track:<id>", generated by the offline music engine). Running timers + the
// stopwatch are ephemeral client-side state (localStorage), not stored here.

export const clockLocations = sqliteTable('clock_locations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  timezone: text('timezone').notNull(),        // IANA tz, e.g. "America/New_York"
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const clockAlarms = sqliteTable('clock_alarms', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default('Alarm'),
  hour: integer('hour').notNull(),             // 0–23
  minute: integer('minute').notNull(),         // 0–59
  repeatDays: text('repeat_days').notNull().default('[]'),  // JSON int[] 0=Sun..6=Sat; [] = one-time
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  tone: text('tone').notNull().default('builtin:radar'),    // builtin:<key> | track:<id>
  toneName: text('tone_name'),                 // display name of the chosen tone
  announce: integer('announce', { mode: 'boolean' }).notNull().default(true),
  snoozeMinutes: integer('snooze_minutes').notNull().default(9),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const clockTimers = sqliteTable('clock_timers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default('Timer'),
  durationSec: integer('duration_sec').notNull(),
  tone: text('tone').notNull().default('builtin:beacon'),   // builtin:<key> | track:<id>
  toneName: text('tone_name'),
  announce: integer('announce', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Active running countdowns. Server-backed (not just client state) so the companion
// can start/cancel live timers and the open Time app picks them up via polling.
// `endsAt`/`remainingMs` are epoch-ms / ms numbers; paused freezes remainingMs.
export const clockTimerRuns = sqliteTable('clock_timer_runs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default('Timer'),
  tone: text('tone').notNull().default('builtin:beacon'),
  toneName: text('tone_name'),
  announce: integer('announce', { mode: 'boolean' }).notNull().default(true),
  durationSec: integer('duration_sec').notNull(),
  endsAt: integer('ends_at').notNull(),            // epoch ms when it will fire
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  remainingMs: integer('remaining_ms').notNull(),  // authoritative while paused
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Feeds (RSS/Atom reader; absorbs curated News as system feeds) ──────────────
// user_id = null → system/curated feed (the News presets, visible to everyone).
// Items are stored once per feed (shared for system feeds); only feed_item_state is
// per-user. Saving an item promotes a copy into bookmarks, so feed_items prunes freely.

// A folder is also a News "category". userId=null → shared/built-in category visible to all;
// slug marks the fixed built-ins ('global'/'local'); locked blocks feed editing on built-ins.
export const feedFolders = sqliteTable('feed_folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),  // null = shared/built-in
  name: text('name').notNull(),
  slug: text('slug'),                          // 'global' | 'local' for built-ins, else null
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),  // built-ins: feeds not editable
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  slugUnique: uniqueIndex('feed_folders_slug_unique').on(t.slug),  // at most one 'global'/'local'
}))

export const feeds = sqliteTable('feeds', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),  // null = system
  kind: text('kind', { enum: ['rss', 'atom', 'search', 'youtube'] }).notNull().default('rss'),
  url: text('url'),                            // null for kind='search'
  query: text('query'),                        // for kind='search'
  title: text('title').notNull().default(''),
  faviconUrl: text('favicon_url'),
  siteUrl: text('site_url'),
  folderId: text('folder_id').references(() => feedFolders.id, { onDelete: 'set null' }),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  notify: integer('notify', { mode: 'boolean' }).notNull().default(false),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  pollIntervalSec: integer('poll_interval_sec'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userUrlUnique: unique().on(t.userId, t.url),  // NB: NULL userId is distinct — guard seeds explicitly
  userIdx: index('feeds_user_idx').on(t.userId),
  systemIdx: index('feeds_system_idx').on(t.isSystem),
}))

export const feedItems = sqliteTable('feed_items', {
  id: text('id').primaryKey(),
  feedId: text('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
  guid: text('guid').notNull(),                // dedup key per feed (guid→id→url→hash fallback)
  title: text('title'),
  url: text('url'),
  author: text('author'),
  summary: text('summary'),
  contentHtml: text('content_html'),           // Phase 2 full-text (offline store)
  imageUrl: text('image_url'),
  publishedAt: integer('published_at'),        // unix ms, nullable
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  feedGuidUnique: unique().on(t.feedId, t.guid),
  feedPubIdx: index('feed_items_feed_pub_idx').on(t.feedId, t.publishedAt),
  pubIdx: index('feed_items_pub_idx').on(t.publishedAt),
}))

export const feedItemState = sqliteTable('feed_item_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => feedItems.id, { onDelete: 'cascade' }),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  saved: integer('saved', { mode: 'boolean' }).notNull().default(false),  // promoted to bookmarks
  readAt: integer('read_at', { mode: 'timestamp' }),
}, t => ({
  userItemUnique: unique().on(t.userId, t.itemId),
  savedIdx: index('feed_item_state_saved_idx').on(t.userId, t.saved),
  readIdx: index('feed_item_state_read_idx').on(t.userId, t.read),
}))

export const feedInterests = sqliteTable('feed_interests', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  interestsText: text('interests_text'),
  likesJson: text('likes_json').notNull().default('[]'),
  hidesJson: text('hides_json').notNull().default('[]'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const feedItemScores = sqliteTable('feed_item_scores', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  score: real('score'),
  reason: text('reason'),
  scoredAt: integer('scored_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userItemUnique: unique().on(t.userId, t.itemId) }))

// ─── Bookmarks (the unified saved-content library; absorbs Links/Reader) ───────
// The single home for everything saved: Live links (dashboards/services, like the old
// Organizr bookmarks) and Offline articles (extracted full text). owner_id = null → global/admin.
// Saved feed items are promoted here (source='feed'). source='bookmark' = a Live link.

export const bookmarkCollections = sqliteTable('bookmark_collections', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  color: text('color'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const bookmarkTags = sqliteTable('bookmark_tags', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
})

export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),  // null = global/admin
  source: text('source', { enum: ['bookmark', 'article', 'feed'] }).notNull().default('bookmark'),
  sourceRef: text('source_ref'),               // e.g. 'feed:<feedItemId>'
  type: text('type', { enum: ['live', 'offline'] }).notNull().default('live'),
  url: text('url').notNull(),
  title: text('title').notNull().default(''),
  byline: text('byline'),
  siteName: text('site_name'),
  faviconUrl: text('favicon_url'),
  excerpt: text('excerpt'),
  contentHtml: text('content_html'),           // sanitized (offline)
  contentText: text('content_text'),           // plaintext for FTS / RAG
  wordCount: integer('word_count').notNull().default(0),
  readingMins: integer('reading_mins').notNull().default(0),
  status: text('status', { enum: ['unread', 'reading', 'archived'] }).notNull().default('unread'),
  archiveState: text('archive_state', { enum: ['none', 'pending', 'fetching', 'ready', 'failed'] }).notNull().default('none'),
  archiveError: text('archive_error'),
  readAt: integer('read_at', { mode: 'timestamp' }),
  useProxy: integer('use_proxy', { mode: 'boolean' }).notNull().default(false),
  useEmbed: integer('use_embed', { mode: 'boolean' }).notNull().default(false),
  category: text('category').notNull().default('Other'),
  collectionId: text('collection_id').references(() => bookmarkCollections.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  // ── Auto-update / change monitoring ──
  // autoUpdate: periodically re-archive this item on a schedule (see lib/bookmarks/autoUpdate.ts).
  // intervalMins null → default cadence. alertOnChange: notify the owner when a refresh detects
  // the page's reader-text changed. contentHash is the sha256 of the normalized contentText at the
  // last capture; the diff baseline. last/contentChangedAt power "due" + the "updated" badge.
  autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull().default(false),
  autoUpdateIntervalMins: integer('auto_update_interval_mins'),
  alertOnChange: integer('alert_on_change', { mode: 'boolean' }).notNull().default(false),
  contentHash: text('content_hash'),
  lastCheckedAt: integer('last_checked_at', { mode: 'timestamp' }),
  contentChangedAt: integer('content_changed_at', { mode: 'timestamp' }),
  // reserved for later phases (no P1 UI):
  screenshotPath: text('screenshot_path'),
  snapshotPath: text('snapshot_path'),
  ogImagePath: text('og_image_path'),
  // ── Archiver depth (ArchiveBox-style extractors) ──
  // pdfPath/mediaPath: archive-relative paths to a printed PDF and captured page media (yt-dlp),
  // served via /api/bookmarks/:id/archive/<rel>. captureMedia: opt-in to run yt-dlp on archive
  // (off by default — most pages have no media and it's expensive). archiveOrgUrl: a Wayback
  // Machine permalink saved as an off-box fallback when local capture fails.
  pdfPath: text('pdf_path'),
  mediaPath: text('media_path'),
  captureMedia: integer('capture_media', { mode: 'boolean' }).notNull().default(false),
  archiveOrgUrl: text('archive_org_url'),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  ownerStatusIdx: index('bookmarks_owner_status_idx').on(t.ownerId, t.status),
  sourceRefIdx: index('bookmarks_source_ref_idx').on(t.source, t.sourceRef),
}))

// ─── Bookmark snapshot history (versioned captures) ───────────────────────────
// One row per archive capture, so re-archiving builds a timeline instead of silently
// overwriting. Stores the reader view at that point in time (contentHtml/text) so an old
// version stays viewable, plus the fingerprint to mark which captures actually changed.
export const bookmarkSnapshots = sqliteTable('bookmark_snapshots', {
  id: text('id').primaryKey(),
  bookmarkId: text('bookmark_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
  capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
  title: text('title'),
  contentHtml: text('content_html'),
  contentText: text('content_text'),
  wordCount: integer('word_count').notNull().default(0),
  contentHash: text('content_hash'),
  changed: integer('changed', { mode: 'boolean' }).notNull().default(false),
}, t => ({
  bookmarkIdx: index('bookmark_snapshots_bookmark_idx').on(t.bookmarkId, t.capturedAt),
}))

export const bookmarkItemTags = sqliteTable('bookmark_item_tags', {
  itemId: text('item_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => bookmarkTags.id, { onDelete: 'cascade' }),
}, t => ({ pk: primaryKey({ columns: [t.itemId, t.tagId] }) }))

// ─── Skills / Bundles ───────────────────────────────────────────────────────────
// User-authored markdown "skills" (frontmatter + body) shape the companion's reply.
// The skill definitions live on disk (family scope: {dataDir}/skills/*.md, default off;
// personal scope: {dataDir}/users/{userId}/skills/*.md, default on). This table only
// records per-user enable overrides — a missing row means "use the scope default".
// `source` audits how the row got its value (user_toggle | admin_assign | default).
export const skillEnabled = sqliteTable('skill_enabled', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  skillName: text('skill_name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  source: text('source').notNull().default('user_toggle'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ pk: primaryKey({ columns: [t.userId, t.skillName] }) }))

// ─── Voice memos ────────────────────────────────────────────────────────────────
// Recorded audio (stored as 16 kHz mono WAV) + a best-effort whisper transcript.
export const voiceMemos = sqliteTable('voice_memos', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  durationMs: integer('duration_ms').notNull(),
  transcript: text('transcript'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Document RAG (project attachments + chunks + generated docs) ────────────────
export const projectDocuments = sqliteTable('project_documents', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  userId: text('user_id').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  blobPath: text('blob_path').notNull(),
  status: text('status').notNull().default('pending'),   // pending | ready | failed
  chunkCount: integer('chunk_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const documentChunks = sqliteTable('document_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => projectDocuments.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  embedding: blob('embedding'),         // Float32Array bytes
  loc: text('loc'),                     // e.g. "p.5" or "§2"
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const generatedDocuments = sqliteTable('generated_documents', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  conversationId: text('conversation_id'),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  preset: text('preset'),
  markdown: text('markdown').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Chat document attachments ──────────────────────────────────────────────────
// A document (PDF/text/HTML) dropped into a conversation. Its extracted text is
// stuffed into the prompt for that conversation's turns ("ask about this PDF").
export const chatDocuments = sqliteTable('chat_documents', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  text: text('text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Edited documents ───────────────────────────────────────────────────────────
// The result of the Document Assistant tool transforming an uploaded document
// (fix spelling, rewrite, summarize, translate, …). Persisted so the edited file
// stays downloadable later, after the live result card is gone.
export const chatDocumentEdits = sqliteTable('chat_document_edits', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  originalFilename: text('original_filename').notNull(),
  editedFilename: text('edited_filename').notNull(),
  instruction: text('instruction').notNull(),
  text: text('text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── TTS pronunciation packs ───────────────────────────────────────────────────
// Named, toggleable sets of respelling rules shipped with each app. Built-ins
// (chat/maps/music) are seeded at boot and are global (admin-toggled). Custom
// rules in the pronunciations table with packId=null always apply regardless.
export const pronunciationPacks = sqliteTable('pronunciation_packs', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  appKey: text('app_key'),           // 'chat' | 'maps' | 'music' | null for global
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── TTS pronunciation lexicon ──────────────────────────────────────────────────
// Global admin-managed respellings applied to text before synthesis (audio only —
// on-screen captions keep the original spelling). Ported from v1 /audio/pronunciation.
// packId null = custom rule (always applied); non-null = belongs to a pack (applied
// only when that pack is enabled).
export const pronunciations = sqliteTable('pronunciations', {
  id: text('id').primaryKey(),
  packId: text('pack_id').references(() => pronunciationPacks.id, { onDelete: 'cascade' }),
  term: text('term').notNull(),            // word/phrase to match (case-insensitive, whole-word)
  replacement: text('replacement').notNull(), // phonetic respelling fed to the TTS engine
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Shared watchlist for the Shows + Movies apps. refId is the TVMaze show id (shows) or the
// title (movies — JustWatch/Fandango share no stable numeric id). One row per user+title.
export const mediaWatchlist = sqliteTable('media_watchlist', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mediaType: text('media_type', { enum: ['show', 'movie'] }).notNull(),
  refId: text('ref_id').notNull(),
  title: text('title').notNull(),
  posterUrl: text('poster_url'),
  subtitle: text('subtitle'),  // network/year — shown on watchlist cards
  status: text('status', { enum: ['want', 'watching', 'completed', 'dropped'] }).notNull().default('want'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userItemUnique: unique().on(t.userId, t.mediaType, t.refId) }))

// Per-episode watched marks for shows — drives episode checkmarks + "Continue Watching".
export const showWatchedEpisodes = sqliteTable('show_watched_episodes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tvmazeId: integer('tvmaze_id').notNull(),
  episodeId: integer('episode_id').notNull(),
  season: integer('season').notNull(),
  number: integer('number'),
  watchedAt: integer('watched_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userEpUnique: unique().on(t.userId, t.episodeId) }))
