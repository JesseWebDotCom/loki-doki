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
  // JSON string[] of 2–3 short example lines in the character's voice — few-shot
  // voice samples are the biggest lever for small-model persona fidelity.
  personaExamples: text('persona_examples'),
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
  accuracy: real('accuracy'),            // held-out validation accuracy (0–1) captured at train time; null for pretrained/older models
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
  hwid: text('hwid'),                             // stable hardware id (MAC) for one-tap claim/rebind
  model: text('model'),                           // device catalog id (e.g. 'atom-echo') → make/model + art
  tokenHash: text('token_hash'),                  // SHA-256 of the device token; null until paired
  pairingCode: text('pairing_code'),              // short-lived code; null once redeemed
  pairingExpiresAt: integer('pairing_expires_at', { mode: 'timestamp' }),
  capabilities: text('capabilities'),             // JSON: { screen, camera, sampleRate }
  groupId: text('group_id'),                       // device_groups.id; null → built-in Default
  layoutTemplateId: text('layout_template_id'),    // device_layout_templates.id; null → built-in default layout
  layoutOverrides: text('layout_overrides'),       // JSON: per-device tweak { theme?, volume?, alarmVolume? }
  controllerLayoutTemplateId: text('controller_layout_template_id'), // → controller_layout_templates.id; null = builtin:blank
  controllerLayoutOverrides: text('controller_layout_overrides'),     // JSON: per-device button overrides
  orientation: integer('orientation').notNull().default(0),           // display rotation: 0 | 90 | 180 | 270
  displayMode: text('display_mode'),                                   // explicit mode: 'display' | 'activity' | 'status' | 'sleeping' | null (= 'display')
  // ── Unified screen deck (see device_screens below) ──
  // Two independent admin-only locks gating the OWNER's Settings → Devices editor. The
  // deck itself (device_screens rows) is shared — Admin and Settings mutate the SAME rows;
  // these flags only restrict what the owner (not the admin) may do to them.
  lockScreenSelection: integer('lock_screen_selection', { mode: 'boolean' }).notNull().default(false), // owner can't add/remove/reorder
  lockScreenConfig: integer('lock_screen_config', { mode: 'boolean' }).notNull().default(false),        // owner can't edit a screen's params
  // Audio/alarm bundle — device-GLOBAL (not per-screen), carved off the old layout template
  // so it survives the device switching which screen is primary. Null → built-in defaults
  // (see deviceStudio BUILTIN_TEMPLATES / FALLBACK_ALARM_TONE).
  soundPackId: text('sound_pack_id'),
  soundVolume: real('sound_volume'),
  alarmVolume: real('alarm_volume'),
  soundOverrides: text('sound_overrides').notNull().default('{}'),
  alarmToneId: text('alarm_tone_id'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ── Tab5 modular slot-based dashboard ────────────────────────────────────────
// A "template" is a named, reusable layout descriptor: which widget sits in which
// 3×3 slot at what size, plus a small theme-token set and a chosen sound pack /
// default alarm tone. Edited in Admin → Devices → Layouts and pushed to assigned
// screen devices over the gateway (a server-side edit, never a re-flash). The
// device ships every widget pre-built and just shows/places per this descriptor.
export const deviceLayoutTemplates = sqliteTable('device_layout_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  grid: text('grid').notNull().default('3x3'),
  theme: text('theme').notNull().default('{}'),        // JSON: { bg, accent, text, secondary?, font_scale }
  widgets: text('widgets').notNull().default('[]'),    // JSON: [{ type, size, anchor:[r,c], orient? }]
  soundPackId: text('sound_pack_id'),                  // device_sound_packs.id; null → silent
  volume: real('volume').notNull().default(0.7),       // earcon volume (0–1)
  alarmVolume: real('alarm_volume').notNull().default(1), // alarms bypass earcon vol/mute
  soundOverrides: text('sound_overrides').notNull().default('{}'), // JSON: event→recipeId|null layered on the pack
  alarmToneId: text('alarm_tone_id'),                  // default alarm tone (device_chimes.id, category 'alarm')
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// A "sound pack" maps the small earcon event vocabulary (wake/endpoint/thinking/
// success/error/alarm/notification) to chime recipes (or null = silent). Selecting
// a pack on a template is pure config; the device caches the resolved event→file map.
export const deviceSoundPacks = sqliteTable('device_sound_packs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  events: text('events').notNull().default('{}'),      // JSON: { wake: recipeId|null, ... }
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// A "chime" is a fully-described synthesis recipe (waveform + notes + envelope +
// optional reverb). The server renders it to a 16 kHz mono WAV (data/pod/audio/<id>.wav)
// the device plays on trigger — earcons (category 'earcon') and looping alarm tones
// (category 'alarm', loop=1) share this one model + the same chime designer.
export const deviceChimes = sqliteTable('device_chimes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category', { enum: ['earcon', 'alarm'] }).notNull().default('earcon'),
  loop: integer('loop', { mode: 'boolean' }).notNull().default(false),
  recipe: text('recipe').notNull().default('{}'),      // JSON: { waveform, notes[], envelope, effects? }
  wavSha: text('wav_sha'),                             // sha256 of the rendered WAV (asset_sync + cache-bust)
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Device setting groups. The built-in 'default' row (isDefault=1) holds the baseline
// settings; admin groups override specific keys. A device's effective settings =
// Default merged with its group's overrides; pushed to the device over the gateway.
export const deviceGroups = sqliteTable('device_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  settings: text('settings').notNull().default('{}'),  // JSON: partial for groups, full for Default
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ── Controller layouts (controller mode for screen Pods) ──────────────────────
// Named templates assigned to devices — parallel to device_layout_templates for
// the display side. Built-in templates ship with dynamic data (YouTube subscriptions,
// music stations) resolved at push time from the bound user's account.
export const controllerLayoutTemplates = sqliteTable('controller_layout_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  gridRows: integer('grid_rows').notNull().default(3),
  gridCols: integer('grid_cols').notNull().default(5),
  pagesJson: text('pages_json').notNull().default('[]'), // JSON: ControllerPage[]
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ── Unified screen deck ────────────────────────────────────────────────────────
// Collapses the display-layout / controller-layout / LVGL-screen-mode axes into ONE
// concept: a "screen" is a kind (clock-weather, analog-clock, controller, status, ...)
// from the `screens` catalog; a device has an ORDERED DECK of screen INSTANCES
// (`device_screens`) that it swipes between. Admin (Admin → Devices) and the device
// owner (Settings → Devices) edit the SAME rows — there is no separate override layer;
// `devices.lockScreenSelection` / `lockScreenConfig` only gate what the OWNER may do.
//
// `deviceStudio.ts`/`controllerStudio.ts` keep their existing push/resolve functions
// (and existing firmware push paths are unchanged for now); this is the new shared
// data model both the admin editor and the new Settings → Devices editor operate on.
export const screens = sqliteTable('screens', {
  id: text('id').primaryKey(),                 // uuid, or synthetic 'builtin:<kind>' / 'builtin:<kind>:<variant>'
  kind: text('kind').notNull(),                 // clock-weather | digital-clock | analog-clock | big-weather |
                                                 // nightstand | controller | activity | status | sleeping
  name: text('name').notNull(),
  // Native firmware-drawn (device ignores server frames) vs server-JPEG (React /display,
  // screenshotted). Explicit per catalog row — replaces the old 'builtin:lvgl' id-prefix sniff.
  renderer: text('renderer', { enum: ['lvgl', 'jpeg'] }).notNull().default('jpeg'),
  params: text('params').notNull().default('{}'), // per-kind descriptor union, shape depends on `kind`
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// The shared, ordered per-device deck. One row = one screen instance in the swipe order.
// Both Admin and Settings → Devices INSERT/UPDATE/DELETE these same rows (no `source`
// column — one source of truth). `id` is stable across reorders.
export const deviceScreens = sqliteTable('device_screens', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  screenId: text('screen_id'),                  // → screens.id; null = pure built-in kind, no catalog row
  kind: text('kind').notNull(),                 // denormalized so resolve can branch without a catalog join
  params: text('params').notNull().default('{}'), // per-instance overrides layered on screens.params
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  deviceIdx: index('device_screens_device_idx').on(t.deviceId, t.position),
}))

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
  // Rolling summary of everything older than the live history window (refreshed
  // detached on the fast model). Injected as "Earlier in this conversation" once
  // trimming starts dropping messages — the 800-token clamp used to mean the
  // model simply forgot turn 10 by turn 20.
  summary: text('summary'),
  summaryThrough: integer('summary_through', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  // Reply was cut off (user cancel or mid-stream failure) — content is partial.
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  // Compact record of tool results behind this reply ("Web Search → {…}"). Folded
  // into LLM history on later turns so follow-ups elaborate on real data instead
  // of re-searching; never rendered in the UI.
  toolNote: text('tool_note'),
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
  // 'state' = ongoing multi-day situation ("stressed about a deadline") — powers
  // caring follow-ups and hard-expires after ~a week (see memory/maintenance.ts).
  category: text('category', {
    enum: ['person', 'place', 'thing', 'preference', 'identity', 'event', 'project', 'goal', 'relationship', 'fact', 'state'],
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
// control anything (admins bypass). Security entities (locks + entry covers — see
// lib/homeAssistant/security.ts) are NEVER covered by '*' or plain-domain grants;
// they require the pseudo-domain 'security'. Examples:
//   (userId, '*',     '*')          → control everything EXCEPT locks/entry doors
//   (userId, 'light', '*')          → all lights, any area
//   (userId, '*',     'office')     → everything in the office (minus security)
//   (userId, 'light', 'living_room')→ living-room lights only
//   (userId, 'security', '*')       → locks + entry doors, any area
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
  // User-set display metadata for video/i2v clips surfaced in Videos → Mine. Null title
  // falls back to the prompt; both are editable from the Mine card.
  title: text('title'),
  description: text('description'),
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

// ─── Device Drop ──────────────────────────────────────────────────────────────
// Ephemeral device-to-device transfers ("AirDrop for the household"). A row is a
// single pending/claimed item routed from one of a user's devices to another. File
// bytes live at data/drops/<id> (NOT the content-dedup blob store — drops are
// transient, so the GC coupling isn't worth it); text/link drops carry `body`
// inline. A TTL sweep expires + deletes past `expiresAt`; claimed files are removed
// shortly after pickup. Currently same-user only (household targeting is a later add).

export const fileDrops = sqliteTable('file_drops', {
  id: text('id').primaryKey(),
  senderUserId: text('sender_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderDeviceId: text('sender_device_id').notNull(),
  senderLabel: text('sender_label').notNull(),
  targetUserId: text('target_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // null = "all my other devices" (broadcast to the sender's own fleet).
  targetDeviceId: text('target_device_id'),
  kind: text('kind', { enum: ['file', 'text'] }).notNull(),
  fileName: text('file_name'),        // file kind
  mime: text('mime'),                 // file kind
  sizeBytes: integer('size_bytes'),   // file kind
  relPath: text('rel_path'),          // file bytes, relative to data/drops
  body: text('body'),                 // text/link kind
  status: text('status', { enum: ['pending', 'claimed', 'expired'] }).notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
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

// Music Studio projects (Moises-style): a source song that gets split into stems (Demucs)
// and analysed (Essentia: tempo/beats/key/chords). Per-user, self-contained: the source
// audio + separated stems live as files under music/studio/<id>/ (NOT the blob store —
// the music app is per-user-file, and blob-store GC would orphan derived stems). The two
// background jobs (audio-analyze, stem-separate) fill in the analysis columns and stems.
export const musicStudioTracks = sqliteTable('music_studio_tracks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  artist: text('artist'),
  sourceRelPath: text('source_rel_path'),   // relative; music/studio/<id>/source.<ext>
  // The YouTube-ref the source was fetched from, when known. Lets Karaoke reuse an existing
  // stem-separated track for the same song instead of re-running a multi-minute Demucs job.
  sourceVideoId: text('source_video_id'),
  // Karaoke-prepared tracks are created behind the /music/karaoke flow; hidden from the Studio
  // library list so a party queue doesn't clutter it.
  origin: text('origin', { enum: ['studio', 'karaoke'] }).notNull().default('studio'),
  // Last time this track was prepared/re-sung. Karaoke reuses a cached stem separation for the
  // same song (no re-Demucs); a TTL sweep deletes karaoke tracks unused for a while to reclaim disk.
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  durationSec: real('duration_sec'),
  // Source acquisition: 'ready' the moment an upload lands; 'fetching' while a studio-source
  // job pulls a track picked from the Music app (resolve → saved blob or yt-dlp extract).
  sourceStatus: text('source_status', { enum: ['ready', 'fetching', 'failed'] }).notNull().default('ready'),
  sourceError: text('source_error'),
  // Cover art file (music/studio/<id>/cover.jpg): Cover Art Archive for catalog picks,
  // embedded art for uploads. Served via GET /:id/cover. Null when none was found.
  coverRelPath: text('cover_rel_path'),
  // Stem separation lifecycle. 'none' = not requested yet (analysis can still run).
  stemStatus: text('stem_status', { enum: ['none', 'pending', 'separating', 'ready', 'failed'] }).notNull().default('none'),
  stemModel: text('stem_model'),             // htdemucs | htdemucs_6s | htdemucs (2-stem)
  stemsJson: text('stems_json'),             // JSON string[] of ready stem names
  stemError: text('stem_error'),
  // Analysis lifecycle (tempo/key/chords).
  analysisStatus: text('analysis_status', { enum: ['none', 'pending', 'analyzing', 'ready', 'failed'] }).notNull().default('none'),
  bpm: real('bpm'),
  keyLabel: text('key_label'),
  beatsJson: text('beats_json'),             // JSON [{time, downbeat}]
  chordsJson: text('chords_json'),           // JSON [{startTime, endTime, label}]
  analysisError: text('analysis_error'),
  // Lyric forced-alignment lifecycle. LRCLIB's synced timing is for whatever recording it
  // matched, which is often a different edit than this audio; the align job re-times the
  // lines to the vocals stem so highlighting is accurate. Auto-runs after stems complete.
  lyricsAlignStatus: text('lyrics_align_status', { enum: ['none', 'pending', 'aligning', 'ready', 'failed'] }).notNull().default('none'),
  lyricsJson: text('lyrics_json'),           // JSON [{sec, text}] — aligned to THIS track's audio
  lyricsAlignError: text('lyrics_align_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Pinned YouTube tutorial videos for a Studio track (guitar/practice lessons). Plain
// synchronous CRUD (pin/unpin), not job-backed — no status/*Error/polling columns needed.
export const musicStudioTutorials = sqliteTable('music_studio_tutorials', {
  id: text('id').primaryKey(),
  trackId: text('track_id').notNull().references(() => musicStudioTracks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: text('video_id').notNull(),
  title: text('title').notNull(),
  author: text('author'),
  thumbnailUrl: text('thumbnail_url'),
  durationSec: integer('duration_sec'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  trackVideoUnique: uniqueIndex('music_studio_tutorials_track_video_idx').on(t.trackId, t.videoId),
}))

// An imported Guitar Pro / MusicXML tab for a Studio track, rendered + cursor-synced to
// playback client-side via alphaTab (see AlphaTabView.tsx) — parsing happens in the browser,
// so `status` only reflects upload validation, not a background job.
// `alignJson` maps the file's own written timeline onto THIS recording's real seconds: alphaTab
// assumes a constant tempo as written, but a real recording drifts (count-in, rubato, a
// different take's tempo) — {startSec, endSec} are two anchors (when the first/last bar of the
// score actually falls in this audio) that alphaTab's sync-point mechanism scales between.
export const musicStudioTabs = sqliteTable('music_studio_tabs', {
  id: text('id').primaryKey(),
  trackId: text('track_id').notNull().references(() => musicStudioTracks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  instrument: text('instrument'),
  sourceRelPath: text('source_rel_path').notNull(),   // music/studio/<trackId>/tabs/<id>.<ext>
  status: text('status', { enum: ['ready', 'failed'] }).notNull().default('ready'),
  tabError: text('tab_error'),
  alignJson: text('align_json'),   // JSON {startSec: number, endSec: number} | null
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
  sourceRef: text('source_ref'),      // origin tag for auto-built stations, e.g. "source:movie:Title" — kept out of the human-facing description
  aiPrompt: text('ai_prompt').notNull().default(''),
  seedType: text('seed_type', { enum: ['prompt', 'genre', 'artist', 'song'] }).notNull().default('prompt'),
  seedValue: text('seed_value'),
  iconPath: text('icon_path'),        // relative path to generated station icon (SVG)
  bannerPath: text('banner_path'),    // relative path to generated station banner (SVG)
  accent: text('accent'),             // color slug for tinting when art is absent
  category: text('category'),         // browse grouping for built-ins (Genres, Moods, Movies…)
  loadingMessages: text('loading_messages'), // JSON string[] of playful "tuning in" lines (LLM-written, per station)
  // Lead track of the last built queue ({videoId,title,artist}) — the station's "cover song".
  // Stamped on every tune-in/preview; cards resolve it to real album art so the grid matches
  // the detail hero's blended-cover look. Null until the station's first build.
  coverTrackJson: text('cover_track_json'),
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
  // manual = hand-built; magic = AI vibe-generated (recipe in rulesJson for Regenerate);
  // smart = rule-based, re-evaluated on read (no persisted track rows).
  kind: text('kind', { enum: ['manual', 'magic', 'smart'] }).notNull().default('manual'),
  rulesJson: text('rules_json'),
  generatedAt: integer('generated_at', { mode: 'timestamp' }),
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
  positionSec: real('position_sec').notNull().default(0),   // how far they got (progress beacon)
  durationSec: real('duration_sec'),                        // track length, when known
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

// ─── Live internet radio ──────────────────────────────────────────────────────
// Real-world radio stations a user saved to their library — either picked from the
// radio-browser.info directory or added manually by stream URL. This table IS the
// user's radio library (no musicFavorites dual-write). streamUrl is the resolved
// stream captured at add time so playback never re-hits the directory.
export const musicRadioStations = sqliteTable('music_radio_stations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['radio-browser', 'manual'] }).notNull(),
  stationUuid: text('station_uuid'),  // radio-browser stationuuid; null for manual adds
  name: text('name').notNull(),
  streamUrl: text('stream_url').notNull(),
  homepage: text('homepage'),
  favicon: text('favicon'),
  tags: text('tags'),                 // comma-separated, as radio-browser returns them
  country: text('country'),
  language: text('language'),
  codec: text('codec'),               // MP3 / AAC / AAC+ …
  bitrate: integer('bitrate'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userStreamUnique: unique().on(t.userId, t.streamUrl) }))

// Timed captures of a live stream ("record 30 minutes of KEXP") made server-side by
// ffmpeg through the download-jobs queue. Live audio can't be re-fetched, so a capture
// that dies mid-way keeps the partial file when ≥30s landed. Files are per-user
// (radio-recordings category), not blob-store: every capture is unique.
export const musicRadioRecordings = sqliteTable('music_radio_recordings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stationId: text('station_id'),      // loose ref — station may be deleted after recording
  stationName: text('station_name').notNull(),
  streamUrl: text('stream_url').notNull(),  // frozen at enqueue time
  codec: text('codec'),                     // station codec at enqueue — MP3 re-muxes, others transcode
  title: text('title').notNull(),
  requestedSec: integer('requested_sec').notNull(),
  durationSec: real('duration_sec'),  // actual captured length (ffprobe), set on finish
  relPath: text('rel_path'),
  sizeBytes: integer('size_bytes'),
  status: text('status', { enum: ['pending', 'recording', 'ready', 'failed'] }).notNull().default('pending'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userIdx: index('music_radio_recordings_user_idx').on(t.userId) }))

// ─── Local music library ─────────────────────────────────────────────────────────
// Admin-configured folders (plus one system-managed uploads folder) scanned into an index of
// playable audio files. A row's id is the stable target of a `local:<id>` track ref (see
// lib/music/trackRef.ts), so refs survive retags/rescans as long as the file path lives on.
// Folders are read-only external mounts — deliberately NOT storage_locations rows (those are
// app-managed write roots with move/delete machinery); only the uploads folder lives under
// the app's own 'music' content root.

export const musicLocalFolders = sqliteTable('music_local_folders', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),   // absolute directory, admin-validated
  kind: text('kind', { enum: ['admin', 'uploads'] }).notNull().default('admin'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastScanAt: integer('last_scan_at', { mode: 'timestamp' }),
  lastScanStatus: text('last_scan_status', { enum: ['idle', 'scanning', 'ok', 'failed'] }).notNull().default('idle'),
  lastScanError: text('last_scan_error'),
  trackCount: integer('track_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const musicLocalTracks = sqliteTable('music_local_tracks', {
  id: text('id').primaryKey(),             // uuid — the stable `local:<id>` ref target
  folderId: text('folder_id').notNull().references(() => musicLocalFolders.id, { onDelete: 'cascade' }),
  path: text('path').notNull().unique(),   // absolute file path (scan upsert key)
  title: text('title').notNull(),          // tag title, else filename stem
  artist: text('artist'),
  albumArtist: text('album_artist'),       // album grouping key (falls back to artist)
  album: text('album'),
  trackNo: integer('track_no'),
  discNo: integer('disc_no'),
  year: integer('year'),
  genre: text('genre'),
  durationSec: real('duration_sec'),
  codec: text('codec'),
  container: text('container'),
  bitrate: integer('bitrate'),             // bits/sec as music-metadata reports it
  sampleRate: integer('sample_rate'),
  bitDepth: integer('bit_depth'),
  channels: integer('channels'),
  // Chrome can't decode ALAC/WMA/APE/DSD — excluded from playback + library matching so
  // "prefer my library" never swaps a playable YouTube stream for an undecodable file.
  browserPlayable: integer('browser_playable', { mode: 'boolean' }).notNull().default(true),
  hasEmbeddedArt: integer('has_embedded_art', { mode: 'boolean' }).notNull().default(false),
  folderArtPath: text('folder_art_path'),  // cover.jpg/folder.jpg found beside the file
  mbid: text('mbid'),                      // MUSICBRAINZ_* tags (Picard-tagged libraries)
  mbAlbumId: text('mb_album_id'),
  mbArtistId: text('mb_artist_id'),
  // Parental advisory from tags (ITUNESADVISORY / MP4 rtng): null=unknown, 0=clean,
  // 1=explicit, 2=cleaned edit. Feeds the content-protection layer (music_track_advisory).
  advisory: integer('advisory'),
  // norm() from lib/music/resolve.ts applied at scan time — MUST stay in lockstep with
  // query-time matching (resolveSource.ts) or library matching silently drifts.
  normTitle: text('norm_title').notNull(),
  normArtist: text('norm_artist').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),  // with sizeBytes: the incremental-rescan skip key
  scannedAt: integer('scanned_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  normIdx: index('music_local_tracks_norm_idx').on(t.normArtist, t.normTitle),
  mbidIdx: index('music_local_tracks_mbid_idx').on(t.mbid),
  albumIdx: index('music_local_tracks_album_idx').on(t.albumArtist, t.album),
}))

// ─── Plex music index ─────────────────────────────────────────────────────────────
// A local mirror of the selected Plex music sections' tracks (synced by lib/plex/music.ts,
// 6-hourly + on demand). Mirroring — instead of live-proxying browse/search — is what makes
// per-track library matching, unified Collection search across local+plex, and later
// audio-analysis passes possible without hammering the Plex API. `machineId` is baked into
// each row (and into `plex:<machineId>:<ratingKey>` refs) so a server swap turns stale refs
// into clean 404s rather than pointing at the wrong library.

export const musicPlexTracks = sqliteTable('music_plex_tracks', {
  ratingKey: text('rating_key').primaryKey(),
  machineId: text('machine_id').notNull(),
  sectionKey: text('section_key').notNull(),
  title: text('title').notNull(),
  artist: text('artist'),                 // grandparentTitle
  album: text('album'),                   // parentTitle
  albumRatingKey: text('album_rating_key'),
  artistRatingKey: text('artist_rating_key'),
  trackNo: integer('track_no'),           // index
  discNo: integer('disc_no'),             // parentIndex
  year: integer('year'),
  durationSec: real('duration_sec'),
  codec: text('codec'),                   // Media[0].audioCodec
  container: text('container'),
  bitrate: integer('bitrate'),            // kbps, as Plex reports it
  partKey: text('part_key'),              // Media[0].Part[0].key — stream without a metadata roundtrip
  thumb: text('thumb'),                   // relative paths for the /api/plex/img proxy
  parentThumb: text('parent_thumb'),
  grandparentThumb: text('grandparent_thumb'),
  mbid: text('mbid'),                     // from Guid "mbid://<uuid>" (MusicBrainz-agent libraries)
  normTitle: text('norm_title').notNull(),
  normArtist: text('norm_artist').notNull(),
  syncedAt: integer('synced_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  normIdx: index('music_plex_tracks_norm_idx').on(t.normArtist, t.normTitle),
  mbidIdx: index('music_plex_tracks_mbid_idx').on(t.mbid),
  albumIdx: index('music_plex_tracks_album_idx').on(t.artist, t.album),
}))

// ─── Track audio facts + ratings ────────────────────────────────────────────────────
// music_track_audio: cheap ffmpeg-derived facts per track ref — codec/bitrate probe,
// EBU R128 integrated loudness (stored now, applied by the DSP phase), and a ~640-bucket
// waveform envelope for the Now Playing seek bar. One row per ref, shared across users;
// populated opportunistically (post-download hook + lazy on first waveform request).
// Deliberately separate from the ML features table (that one is gated on the optional
// stem-audio component; these facts must always be available).

export const musicTrackAudio = sqliteTable('music_track_audio', {
  ref: text('ref').primaryKey(),          // unified track ref (trackRef.ts)
  lufs: real('lufs'),                     // EBU R128 integrated; null = not measured (too long / failed)
  truePeakDb: real('true_peak_db'),
  codec: text('codec'),
  bitrateKbps: integer('bitrate_kbps'),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
  durationSec: real('duration_sec'),
  peaks: blob('peaks', { mode: 'buffer' }), // Uint8Array envelope, 0..255 per bucket
  scannedAt: integer('scanned_at', { mode: 'timestamp' }).notNull(),
})

// music_track_features: ML music intelligence per track ref — a 1280-d discogs-effnet
// sound embedding (Float32Array LE blob, ~5KB) plus mood/genre scalars and tags from
// the MTG classifier heads. Gated on the stem-audio component (library_analyze.py);
// deliberately separate from music_track_audio so loudness never depends on the ML
// install. status 'failed' rows keep the error for the admin coverage card.
export const musicTrackFeatures = sqliteTable('music_track_features', {
  ref: text('ref').primaryKey(),          // unified track ref (trackRef.ts)
  source: text('source'),                 // youtube | local | plex (display/debug)
  title: text('title'),
  artist: text('artist'),
  durationSec: real('duration_sec'),
  bpm: real('bpm'),
  keyLabel: text('key_label'),
  energy: real('energy'),                 // all scalars 0..1 (formulas in library_analyze.py)
  valence: real('valence'),
  danceability: real('danceability'),
  aggressiveness: real('aggressiveness'),
  acousticness: real('acousticness'),
  tagsJson: text('tags_json'),            // ["hard rock", ..., "mood/energetic", ...]
  embedding: blob('embedding', { mode: 'buffer' }), // Float32Array(1280) LE bytes
  modelVersion: text('model_version'),    // INTEL_MODEL_VERSION at analysis time
  status: text('status').notNull(),       // ready | failed
  error: text('error'),
  analyzedAt: integer('analyzed_at', { mode: 'timestamp' }).notNull(),
})

// Star ratings (1-5) per user per track ref. Denormalized title/artist follow the
// music_favorites posture (a ref alone has no row to join for display). Feeds Smart
// Rules + rail weighting later.
export const musicRatings = sqliteTable('music_ratings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ref: text('ref').notNull(),
  title: text('title'),
  artist: text('artist'),
  stars: integer('stars').notNull(),      // 1..5
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userRefUnique: unique().on(t.userId, t.ref) }))

// Parental-advisory state per track ref, feeding the per-profile music protections.
// explicit: null=unknown, 0=clean, 1=explicit, 2=clean edit of an explicit song.
// source precedence when writing: manual > tag > deezer/itunes (see lib/music/advisory).
export const musicTrackAdvisory = sqliteTable('music_track_advisory', {
  ref: text('ref').primaryKey(),
  explicit: integer('explicit'),
  source: text('source').notNull(),       // 'tag' | 'deezer' | 'itunes' | 'manual'
  title: text('title'),                   // denormalized identity for admin review lists
  artist: text('artist'),
  checkedAt: integer('checked_at', { mode: 'timestamp' }).notNull(),
})

// Cached topical-classification verdict per media item (videos + podcast episodes),
// keyed by source + item id. `categoriesJson` is a JSON Record<DialKey, level> using the
// same level vocabulary as content dials, so a verdict compares directly against a profile
// ceiling. Written by the fast-model classifier (lib/media/classify.ts); a row that exists
// with an all-'off' verdict means "checked, clean". See kid-safe media filtering.
export const mediaClassification = sqliteTable('media_classification', {
  source: text('source').notNull(),        // 'youtube' | 'tiktok' | 'reddit' | 'vimeo' | 'podcast' | ...
  itemId: text('item_id').notNull(),
  categoriesJson: text('categories_json').notNull(),  // JSON Record<DialKey, level>
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ pk: primaryKey({ columns: [t.source, t.itemId] }) }))

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

// Web Push subscriptions (VAPID). One row per browser/device a user has opted into push
// on; a user can have several (phone + desktop). `endpoint` is unique per browser
// subscription and doubles as the natural key for unsubscribe. See lib/push.ts.
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dhKey: text('p256dh_key').notNull(),
  authKey: text('auth_key').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['install_request', 'install_complete', 'download_complete', 'system', 'frigate_event', 'companion_checkin', 'watcher_alert', 'price_alert', 'file_drop', 'service_alert', 'resource_alert'] }).notNull(),
  payload: text('payload').notNull().default('{}'),
  // Delivery routing (lib/notify): 'urgent' breaks through quiet hours; 'info' is
  // bell-only fodder. Priority lives as a real column (not payload) because the
  // dispatcher and quiet-hours logic query on it.
  priority: text('priority', { enum: ['info', 'normal', 'urgent'] }).notNull().default('normal'),
  // Optional idempotency key: emitNotification() skips the insert when an unread row
  // with the same key exists (replaces payload-LIKE dedupe hacks).
  dedupeKey: text('dedupe_key'),
  readAt: integer('read_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Per-user delivery endpoints beyond web push (push endpoints live in push_subscriptions).
// One row per (user, kind): kind='telegram' → address is the chat id (label @username);
// kind='email' → address is the email (verified via a 6-digit code). See lib/notify/.
export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['telegram', 'email'] }).notNull(),
  address: text('address').notNull(),
  label: text('label'),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  verifyCode: text('verify_code'),
  verifyExpiresAt: integer('verify_expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userKindUnique: unique().on(t.userId, t.kind),
}))

// Delivery log + digest/deferred queue in one table (status is the discriminator).
// title/body/url are denormalized from the notification so a digest flush still works
// after the user clears their bell list. Pruned to the newest ~1000 terminal rows.
export const notificationDeliveries = sqliteTable('notification_deliveries', {
  id: text('id').primaryKey(),
  notificationId: text('notification_id'),
  userId: text('user_id').notNull(),
  channel: text('channel', { enum: ['push', 'telegram', 'email'] }).notNull(),
  status: text('status', { enum: ['sent', 'failed', 'digest', 'deferred'] }).notNull(),
  title: text('title').notNull(),
  body: text('body'),
  url: text('url'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
}, (t) => ({
  statusUserIdx: index('idx_notification_deliveries_status').on(t.status, t.userId),
}))

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
  // Music protections: JSON {explicit, unknown, lyrics, maskTitles}; null = defaults
  // derived from the profanity dial (lib/music/advisory.ts).
  musicJson: text('music_json'),
  // Video protections: JSON {adult, unknown, restrictedMode}; null = defaults derived
  // from the profile's dials (lib/media/policyTier.ts).
  videoJson: text('video_json'),
  // Podcast protections: JSON {explicit, unknown}; null = defaults derived from dials.
  podcastJson: text('podcast_json'),
  // Master "Kid-Safe Media" toggle: when true, all three media policies resolve to their
  // strictest ('kid' tier) regardless of the per-medium JSON. One parent-facing switch.
  kidSafeMedia: integer('kid_safe_media', { mode: 'boolean' }).notNull().default(false),
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
  // Delete this channel's auto-saved offline copies once fully watched (in-app completed
  // flag; independent of any Plex library policy — see lib/videos/offlineSweep.ts).
  removeWatched: integer('remove_watched', { mode: 'boolean' }).notNull().default(false),
  // 'local' = added in-app; 'google' = mirrored from the user's linked YouTube account.
  // Google-sourced rows are reconciled against the account every sync pass (removed there
  // → removed here); local rows are never touched by sync. See youtube/accountSync.ts.
  source: text('source', { enum: ['local', 'google'] }).notNull().default('local'),
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
  views: text('views'),                        // raw view-count text (e.g. "1.2M views" / "1234567"); display via fmtViews
  likeCount: integer('like_count'),            // numeric, from yt-dlp; feeds the Plex show audience rating
  viewCount: integer('view_count'),            // numeric, from yt-dlp (views above is display text)
  description: text('description'),
  summary: text('summary'),
  // "Smart Description" — the raw description with promotional/sponsor-read paragraphs
  // stripped by an LLM pass, or the transcript-based `summary` when nothing worth keeping
  // survives cleaning. Shown in place of the raw description everywhere (YouTube app +
  // Plex export) — kept separate from `description` so the original is never lost.
  descriptionClean: text('description_clean'),
  // Which InnerTube channel tab this came from, when known (null for RSS/playlist-sourced
  // rows) — 'shorts' drives the Plex export's separate "Channel — Shorts" show; legacy/null
  // rows fall back to the durationSec<=90 heuristic used elsewhere in this codebase.
  tab: text('tab', { enum: ['videos', 'shorts', 'live'] }),
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
  // Which app saved this ref. Music saves (station snapshots + à-la-carte songs) reuse the same
  // pipeline but belong to the Music app's offline library — the YouTube Saved tab filters them
  // out (origin <> 'music'). Defaults to 'youtube' for all existing/legacy rows.
  origin: text('origin', { enum: ['youtube', 'music'] }).notNull().default('youtube'),
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
  relPath: text('rel_path').notNull(),             // relative to whichever root this blob lives under
  sizeBytes: integer('size_bytes').notNull(),
  mime: text('mime'),
  status: text('status', { enum: ['staging', 'live'] }).notNull().default('staging'),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  // Which storage_locations row this blob's bytes actually live under. Null (the vast
  // majority of rows) = the default data root, exactly like before this column existed —
  // set only when the blob was written for a content type reassigned to another location.
  storageLocationId: text('storage_location_id'),
})

// ── Media assets (Layer 2: identity + store-the-max) ────────────────────────────
// One logical rendition of a piece of media, keyed by (sourceType, sourceId, kind, format).
// Holds the single best-quality blob anyone in the household requested (store-the-max for
// video; audio is height-independent). yt_downloads rows are the per-user REFERENCES.
export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull().default('youtube'),
  sourceId: text('source_id').notNull(),           // e.g. the YouTube videoId
  kind: text('kind', { enum: ['audio', 'video', 'ebook'] }).notNull(),
  format: text('format').notNull(),                // container (m4a | mp3 | mp4 | epub) — part of identity
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
  // Which app the play belongs to: Music-station plays share the player but must not
  // pollute the Videos watch history.
  origin: text('origin', { enum: ['youtube', 'music'] }).notNull().default('youtube'),
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
  // Video thumbnail snapshot. YouTube cards derive theirs from the videoId, but
  // non-YouTube hub sources have no derivable thumb URL — without this, their
  // Liked/Watch Later cards would render blank.
  thumbnailUrl: text('thumbnail_url'),
  // 'local' vs 'google' — same contract as ytSubscriptions.source: google rows mirror the
  // linked account's Watch Later / Liked and are owned by account sync.
  source: text('source', { enum: ['local', 'google'] }).notNull().default('local'),
  // Which VIDEO source the saved item belongs to (Videos hub cross-source collections).
  // Distinct from `source` above, which is account-sync ownership. 'mine' = Studio bin
  // items (exports/uploads/recordings/generated clips) — never mirrored to the linked
  // Google account (see pushCollectionChange's videoSource guard), since there's no real
  // YouTube video ID to push.
  videoSource: text('video_source', { enum: ['youtube', 'reddit', 'tiktok', 'vimeo', 'link', 'mine'] }).notNull().default('youtube'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userColVidUnique: unique().on(t.userId, t.collection, t.videoId) }))

// A user's linked YouTube (Google) account, authorized via the InnerTube TV-client OAuth
// device flow — the "enter this code on your phone" login a smart TV uses. One row per
// user. Tokens are the TV client's; authenticated InnerTube calls must therefore use the
// TVHTML5 client context (see youtube/tvClient.ts). The client_id/client_secret pair the
// tokens were minted with is stored alongside them because refresh must reuse the exact
// same identity, and the scraped TV identity can rotate over time.
export const ytAccounts = sqliteTable('yt_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),
  // Display-only identity fetched after link (account name / @handle / avatar).
  channelTitle: text('channel_title'),
  channelHandle: text('channel_handle'),
  channelAvatarUrl: text('channel_avatar_url'),
  // 'expired' = refresh failed with invalid_grant (revoked / password change) — the user
  // must re-link; sync skips the account until then.
  status: text('status', { enum: ['active', 'expired'] }).notNull().default('active'),
  // What the periodic pull mirrors into local tables. Push (applying in-app subscribe /
  // watch-later / like actions back to the account) is one switch.
  syncSubscriptions: integer('sync_subscriptions', { mode: 'boolean' }).notNull().default(true),
  syncWatchLater: integer('sync_watch_later', { mode: 'boolean' }).notNull().default(true),
  syncLiked: integer('sync_liked', { mode: 'boolean' }).notNull().default(true),
  pushEnabled: integer('push_enabled', { mode: 'boolean' }).notNull().default(true),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  lastSyncError: text('last_sync_error'),
  connectedAt: integer('connected_at', { mode: 'timestamp' }).notNull(),
})

// User-curated video playlists — explicit, named, ordered lists (distinct from the fixed
// Watch Later / Liked buckets in ytCollections above).
export const ytPlaylists = sqliteTable('yt_playlists', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull().default('private'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const ytPlaylistVideos = sqliteTable('yt_playlist_videos', {
  id: text('id').primaryKey(),
  playlistId: text('playlist_id').notNull().references(() => ytPlaylists.id, { onDelete: 'cascade' }),
  videoId: text('video_id').notNull(),
  title: text('title').notNull(),
  author: text('author'),
  channelId: text('channel_id'),
  durationSec: integer('duration_sec'),
  position: integer('position').notNull().default(0),
  // Which video source this entry came from (Videos hub cross-source playlists).
  videoSource: text('video_source', { enum: ['youtube', 'reddit', 'tiktok', 'vimeo', 'link', 'mine'] }).notNull().default('youtube'),
  // YouTube thumbnails are derived from videoId at render time; every other source's
  // thumbnail is an arbitrary provider URL that has to be stored to display it here.
  thumbnailUrl: text('thumbnail_url'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
})

// "Download all" batches for a curated playlist — a thin tracking row, not a download
// pipeline of its own. Each video in the batch is enqueued through the same per-video
// enqueueVideoSave() a manual Save uses, so status is computed live by joining ytDownloads
// on (userId, videoId IN videoIds, kind) rather than duplicated here.
export const ytPlaylistDownloadBatches = sqliteTable('yt_playlist_download_batches', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  playlistId: text('playlist_id').references(() => ytPlaylists.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  kind: text('kind', { enum: ['audio', 'video'] }).notNull(),
  maxHeight: integer('max_height'),
  videoIds: text('video_ids').notNull(),   // JSON string[] snapshot at batch-start time
  status: text('status', { enum: ['running', 'completed', 'completed_with_errors', 'cancelled'] }).notNull().default('running'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

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
  // 'rss' = a real-world podcast subscribed via its RSS feed. One show row per feed URL,
  // shared household-wide; per-user membership lives in podcastSubscriptions. RSS shows
  // keep visibility 'personal' (subscriptions, not the shared branch, grant access);
  // ownerUserId is the first subscriber and is reassigned when they unsubscribe.
  source: text('source', { enum: ['user', 'suggested', 'app', 'rss'] }).notNull().default('user'),
  // Origin of an auto-built show, e.g. 'channel:<id>' / 'playlist:<id>' — lets a YouTube
  // source find the show it created so "generate next batch" can continue it.
  sourceRef: text('source_ref'),
  // When true, the feed poller auto-generates a new episode whenever a fresh video lands
  // for the subscription matching this show's sourceRef. Off by default; opt-in per show.
  autoGenerate: integer('auto_generate', { mode: 'boolean' }).notNull().default(false),
  // Target episode length in minutes (null = use style default). Stored as integer; 165 words/min.
  targetMinutes: integer('target_minutes'),
  // ── RSS-subscription fields (source='rss' only) ──
  feedUrl: text('feed_url'),          // canonical (normalized) RSS URL — identity for dedup
  artworkUrl: text('artwork_url'),    // remote channel art; served via image proxy when no coverRelPath
  author: text('author'),
  link: text('link'),                 // channel homepage
  categoriesJson: text('categories_json'),
  feedEtag: text('feed_etag'),        // conditional-GET state for the refresh poller
  feedLastModified: text('feed_last_modified'),
  feedFetchedAt: integer('feed_fetched_at', { mode: 'timestamp' }),
  feedError: text('feed_error'),
  // Show-level parental advisory from <itunes:explicit> / collectionExplicitness:
  // null=unknown, 0=clean, 1=explicit. Feeds kid-safe podcast filtering.
  explicit: integer('explicit'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  ownerIdx: index('podcast_shows_owner_idx').on(t.ownerUserId),
  feedIdx: index('podcast_shows_feed_idx').on(t.feedUrl),
}))

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
  // ── RSS-episode fields (shows with source='rss'; inserted status='ready') ──
  guid: text('guid'),                 // per-show dedup key (feed guid → enclosureUrl → title+date hash)
  enclosureUrl: text('enclosure_url'),
  enclosureType: text('enclosure_type'),
  enclosureBytes: integer('enclosure_bytes'),
  imageUrl: text('image_url'),        // episode-level itunes:image
  link: text('link'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  // Shared media_assets rendition once any household member downloads this episode.
  assetId: text('asset_id'),
  // Episode-level parental advisory from <itunes:explicit>/trackExplicitness: null=unknown,
  // 0=clean, 1=explicit. Combined with the topical classifier for kid-safe filtering.
  explicit: integer('explicit'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  showIdx: index('podcast_episodes_show_idx').on(t.showId),
  guidIdx: index('podcast_episodes_guid_idx').on(t.showId, t.guid),
}))

// Which source items (e.g. YouTube videos) fed each generated episode — powers the
// reverse link "this video is featured in these podcasts" on the YouTube watch page.
export const podcastEpisodeSources = sqliteTable('podcast_episode_sources', {
  id: text('id').primaryKey(),
  episodeId: text('episode_id').notNull().references(() => podcastEpisodes.id, { onDelete: 'cascade' }),
  sourceType: text('source_type', { enum: ['youtube', 'tvshow', 'movie', 'tiktok', 'vimeo', 'reddit', 'link'] }).notNull().default('youtube'),
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

// Per-user membership in an RSS podcast show (shows with source='rss'). The show row is
// shared household-wide; subscriptions carry each user's prefs. autoDownload keeps the
// newest N episodes offline automatically (auto refs prune; manual downloads never do).
export const podcastSubscriptions = sqliteTable('podcast_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  showId: text('show_id').notNull().references(() => podcastShows.id, { onDelete: 'cascade' }),
  autoDownload: integer('auto_download', { mode: 'boolean' }).notNull().default(false),
  autoDownloadKeep: integer('auto_download_keep'),  // null → default 3
  notify: integer('notify', { mode: 'boolean' }).notNull().default(false),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userShowUnique: unique().on(t.userId, t.showId),
  showIdx: index('podcast_subscriptions_show_idx').on(t.showId),
}))

// Per-user offline refs for RSS episode audio — the ytDownloads-as-refs pattern over the
// shared blob store: two users downloading the same episode share one media_assets copy.
// gcSweep() counts these rows as pins; deleting the ref is what releases the blob.
export const podcastDownloads = sqliteTable('podcast_downloads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  episodeId: text('episode_id').notNull().references(() => podcastEpisodes.id, { onDelete: 'cascade' }),
  assetId: text('asset_id'),          // → mediaAssets.id once the download starts
  status: text('status', { enum: ['pending', 'downloading', 'ready', 'failed'] }).notNull().default('pending'),
  auto: integer('auto', { mode: 'boolean' }).notNull().default(false),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userEpUnique: unique().on(t.userId, t.episodeId),
  assetIdx: index('podcast_downloads_asset_idx').on(t.assetId),
}))

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
  tone: text('tone').notNull().default('builtin:radar'),    // builtin:<key> | track:<id> (browser playback)
  toneName: text('tone_name'),                 // display name of the chosen tone
  toneId: text('tone_id'),                      // per-alarm device tone override (device_chimes.id); null → template default
  targets: text('targets'),                     // JSON device id[] that should ring; null → all the user's pods
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
  // ── Watch conditions (scoped change monitoring — lib/bookmarks/watch.ts) ──
  // watchSelector: CSS selector scoping the diff to part of the page (null = reader text).
  // Runs against the RAW page HTML via Bun's HTMLRewriter (the sanitizer strips class/id).
  // watchMode + keyword/threshold turn "changed" into a real condition ("price below 500",
  // "'in stock' appeared"). lastWatchValue is the scoped extract at last capture.
  watchSelector: text('watch_selector'),
  watchMode: text('watch_mode', { enum: ['any_change', 'keyword_appears', 'keyword_disappears', 'number_below', 'number_above'] }).notNull().default('any_change'),
  watchKeyword: text('watch_keyword'),
  watchThreshold: real('watch_threshold'),
  lastWatchValue: text('last_watch_value'),
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
  watchValue: text('watch_value'),  // scoped watch extract at this capture (value-over-time timeline)
}, t => ({
  bookmarkIdx: index('bookmark_snapshots_bookmark_idx').on(t.bookmarkId, t.capturedAt),
}))

export const bookmarkItemTags = sqliteTable('bookmark_item_tags', {
  itemId: text('item_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => bookmarkTags.id, { onDelete: 'cascade' }),
}, t => ({ pk: primaryKey({ columns: [t.itemId, t.tagId] }) }))

// ─── Bookmark content chunks (semantic search) ─────────────────────────────────
// ~1.4k-char paragraph-packed chunks of an offline article's reader text, embedded
// (nomic via Ollama; JSON float array — docChunks convention) DETACHED after each
// archive. Powers paraphrase recall in global search, deep /ask context on long
// articles, and the bookmarksLibrary tool's FTS-miss fallback. Rows are absent when
// embeddings were unavailable at archive time — every consumer degrades to FTS.
export const bookmarkChunks = sqliteTable('bookmark_chunks', {
  id: text('id').primaryKey(),
  bookmarkId: text('bookmark_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  text: text('text').notNull(),
  embedding: text('embedding'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  bookmarkIdx: index('bookmark_chunks_bookmark_idx').on(t.bookmarkId),
}))

// ─── Bookmark highlights & notes ───────────────────────────────────────────────
// Per-user annotations on an article. kind='highlight' anchors a text quote in the
// reader view (prefix/suffix = ~32 chars of surrounding plain text to disambiguate
// duplicate phrases and survive re-archives); kind='note' is a page-level note with an
// empty quote. Anchors are TEXT QUOTES, not offsets — reflow/asset changes don't orphan
// them, only genuine content edits do (orphans stay listed with a badge, never dropped).
export const bookmarkHighlights = sqliteTable('bookmark_highlights', {
  id: text('id').primaryKey(),
  bookmarkId: text('bookmark_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['highlight', 'note'] }).notNull().default('highlight'),
  quote: text('quote').notNull().default(''),
  prefix: text('prefix').notNull().default(''),
  suffix: text('suffix').notNull().default(''),
  color: text('color').notNull().default('yellow'),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  bookmarkUserIdx: index('bookmark_highlights_bookmark_idx').on(t.bookmarkId, t.userId),
}))

// ─── Multi-voice narration (character TTS) ─────────────────────────────────────
// A "session" is one piece of text (pasted, uploaded, or pulled from a bookmark/chat
// document) run through speaker detection. Deliberately separate from `characters` —
// these speakers are lightweight and scoped to one session, not full companion personas.
export const narrationSessions = sqliteTable('narration_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  sourceType: text('source_type', { enum: ['paste', 'upload', 'bookmark', 'chat_document'] }).notNull().default('paste'),
  sourceRef: text('source_ref'),
  text: text('text').notNull(),
  status: text('status', { enum: ['detecting', 'ready', 'failed'] }).notNull().default('detecting'),
  detectionMethod: text('detection_method'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userIdx: index('narration_sessions_user_idx').on(t.userId),
}))

export const narrationSpeakers = sqliteTable('narration_speakers', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => narrationSessions.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  normalizedKey: text('normalized_key').notNull(),
  voiceId: text('voice_id').notNull(),
  speechRate: real('speech_rate').notNull().default(1.0),
  orderIndex: integer('order_index').notNull().default(0),
  isNarrator: integer('is_narrator', { mode: 'boolean' }).notNull().default(false),
}, t => ({
  sessionIdx: index('narration_speakers_session_idx').on(t.sessionId),
  sessionKeyUnique: unique().on(t.sessionId, t.normalizedKey),
}))

export const narrationTurns = sqliteTable('narration_turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => narrationSessions.id, { onDelete: 'cascade' }),
  speakerId: text('speaker_id').notNull().references(() => narrationSpeakers.id, { onDelete: 'cascade' }),
  turnIndex: integer('turn_index').notNull(),
  text: text('text').notNull(),
}, t => ({
  sessionIdx: index('narration_turns_session_idx').on(t.sessionId, t.turnIndex),
}))

// ─── Books (reading/listening hub) ──────────────────────────────────────────────
// Shared household catalog, mirroring the Podcasts/Music/YouTube shape: one `books`
// row per work regardless of who added it; only library membership and progress are
// per-user. The ebook/audiobook bytes themselves live in `media_assets`
// (sourceType='book', kind='ebook'|'audio', sourceId=books.id) — no per-user ref/dedup
// table like ytDownloads/podcastDownloads, since (for now) a book's files aren't
// re-downloaded per user the way YouTube/podcast media is; `bookLibrary` below is
// purely "is this in my library", not an offline-copy ref.
export const books = sqliteTable('books', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author'),
  narrator: text('narrator'),
  seriesName: text('series_name'),
  seriesIndex: real('series_index'),
  description: text('description'),
  language: text('language'),
  coverUrl: text('cover_url'),
  publishedYear: integer('published_year'),
  contentType: text('content_type', { enum: ['book', 'magazine', 'children', 'comic', 'manga', 'coloring_book'] }).notNull().default('book'),
  isbn: text('isbn'),
  sourceType: text('source_type', { enum: ['upload', 'gutenberg', 'standardebooks', 'archiveorg', 'wikisource', 'googlebooks', 'openlibrary', 'indexer', 'librivox', 'manual', 'ai-generated'] }).notNull().default('upload'),
  sourceRef: text('source_ref'),      // external id/URL — the dedup key for non-upload sources
  metadataJson: text('metadata_json'), // raw payload from Open Library / source API
  addedByUserId: text('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  sourceRefUnique: uniqueIndex('books_source_ref_unique').on(t.sourceType, t.sourceRef),
}))

// One row per chapter/spine-item — shared by EPUB TOC nav and audiobook chapter
// markers (audioStartSec/EndSec populated once a TTS render or chaptered upload exists).
export const bookChapters = sqliteTable('book_chapters', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  title: text('title').notNull().default(''),
  epubHref: text('epub_href'),
  audioStartSec: real('audio_start_sec'),
  audioEndSec: real('audio_end_sec'),
  wordCount: integer('word_count'),
  // Set only for "multi-track" audiobooks (e.g. LibriVox, one file per chapter on
  // Internet Archive) — this chapter streams from its own source URL via
  // /api/books/:bookId/chapters/:idx/stream instead of seeking into a single
  // shared mediaAssets file with audioStartSec/EndSec offsets.
  externalAudioUrl: text('external_audio_url'),
  externalAudioDurationSec: real('external_audio_duration_sec'),
}, t => ({
  bookIdx: index('book_chapters_book_idx').on(t.bookId, t.idx),
}))

// Per-user "in my library" membership — presence here, not just a catalog row,
// is what surfaces a book on the user's Library page. `status` distinguishes a
// lightweight save (metadata only, no bytes on disk — 'saved') from an offline
// download's lifecycle ('pending' → 'downloading' → 'ready', or 'failed'). Only
// 'ready' has a local copy; the "Offline" view keys off exactly that.
export const bookLibrary = sqliteTable('book_library', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['saved', 'pending', 'downloading', 'ready', 'failed'] }).notNull().default('ready'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userBookUnique: unique().on(t.userId, t.bookId),
}))

// Per-user reading/listening position. One row per (user, book) holding whichever
// mode was last touched — switching surfaces does NOT preserve position (no forced
// alignment between ebook text and audiobook audio exists yet).
export const bookProgress = sqliteTable('book_progress', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  mode: text('mode', { enum: ['reading', 'listening'] }).notNull().default('reading'),
  epubCfi: text('epub_cfi'),
  percent: real('percent').notNull().default(0),
  audioPositionSec: real('audio_position_sec'),
  // Which chapter is playing, for multi-track (LibriVox) audiobooks — those have no
  // single seekable file, so "position" is (chapterIdx, seconds into that chapter).
  audioChapterIdx: integer('audio_chapter_idx'),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userBookUnique: unique().on(t.userId, t.bookId),
}))

// Custom self-hosted OPDS indexers (Calibre-Web, Kavita, COPS, etc.) as extra Book
// Store sources. Admin-managed (Admin > Integrations > Books), multiple allowed —
// replaces an earlier single-slot design that lived in tool_global_config.
export const bookIndexers = sqliteTable('book_indexers', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  username: text('username'),
  password: text('password'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// AI book authoring workspace — a single-user draft-in-progress, kept separate from the
// shared `books` catalog so abandoned/rejected generations never surface in anyone's
// library. Once approved end to end, `commitProjectToBook()` materializes a real `books`
// row (sourceType='ai-generated') and this row's resultBookId is set.
export const bookProjects = sqliteTable('book_projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mode: text('mode', { enum: ['create', 'continue', 'reshape'] }).notNull(),
  sourceBookId: text('source_book_id').references(() => books.id, { onDelete: 'set null' }),
  resultBookId: text('result_book_id').references(() => books.id, { onDelete: 'set null' }),
  title: text('title'),
  promptJson: text('prompt_json'),          // brief: genre/premise/length/tone/POV, or reshape instruction
  styleProfileJson: text('style_profile_json'), // extracted voice/character/plot profile (continue/reshape)
  storyBibleJson: text('story_bible_json'),  // characters/setting/tone/themes, user-editable pre-generation
  outlineJson: text('outline_json'),         // [{idx,title,summary,targetWords}]
  coveredSummaryJson: text('covered_summary_json'), // running continuity summary, grows per chapter
  status: text('status', {
    enum: ['drafting_bible', 'pending_bible_approval', 'pending_sample', 'pending_sample_approval',
      'generating', 'pending_reshape_review', 'completed', 'failed', 'cancelled'],
  }).notNull().default('drafting_bible'),
  currentChapterIdx: integer('current_chapter_idx').notNull().default(0),
  targetChapterCount: integer('target_chapter_count'),
  targetWordsPerChapter: integer('target_words_per_chapter'),
  coverImageId: text('cover_image_id'),
  jobId: text('job_id'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  userIdx: index('book_projects_user_idx').on(t.userId),
}))

// Per-chapter draft state for a book_project. Decoupled from `book_chapters` (the
// published book's chapter list) since drafts may be regenerated, rejected, or forked
// (reshape keeps both an original reference and an alternate draft per chapter).
export const bookProjectChapters = sqliteTable('book_project_chapters', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => bookProjects.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  title: text('title'),
  draftText: text('draft_text'),
  wordCount: integer('word_count'),
  status: text('status', { enum: ['pending', 'generating', 'sample_ready', 'approved', 'failed'] })
    .notNull().default('pending'),
  isSample: integer('is_sample', { mode: 'boolean' }).notNull().default(false),
  // Reshape mode only: the chapter this one forks from, plus the AI-regenerated
  // alternate awaiting review. draftText holds the user's FINAL choice once reviewed.
  originalChapterId: text('original_chapter_id').references(() => bookChapters.id, { onDelete: 'set null' }),
  alternateText: text('alternate_text'),
  diffStatus: text('diff_status', { enum: ['pending', 'kept_original', 'kept_alternate'] }),
  attempts: integer('attempts').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  projectIdx: index('book_project_chapters_project_idx').on(t.projectId, t.idx),
}))

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

// Embedded chunks of OVERSIZED attached documents (built detached at attach time).
// Documents beyond the prompt-stuffing budget used to be hard-truncated at 8k
// chars — questions about page 5 hit thin air. Retrieval picks the top-k relevant
// chunks per question instead.
export const chatDocumentChunks = sqliteTable('chat_document_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => chatDocuments.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull(),
  filename: text('filename').notNull(),
  idx: integer('idx').notNull(),
  text: text('text').notNull(),
  embedding: text('embedding'),
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

// ─── Canvas artifacts ───────────────────────────────────────────────────────────
// A persistent, editable "canvas" the companion produces — a code snippet, a
// markdown document, or a small HTML page — surfaced beside chat (or, off-chat,
// as a floating pane) instead of dumped into the transcript. `currentContent`
// denormalizes the latest version for fast list/open; full history lives in
// artifact_versions. Personal-scoped (like chatDocumentEdits); conversationId is
// nullable because an off-chat voice turn may have no real conversation.
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id'),
  messageId: text('message_id'),
  type: text('type', { enum: ['code', 'document', 'html'] }).notNull(),
  language: text('language'),            // e.g. 'typescript', 'python', 'markdown'
  title: text('title').notNull(),
  currentContent: text('current_content').notNull().default(''),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  userIdx: index('artifacts_user_idx').on(t.userId),
  convIdx: index('artifacts_conversation_idx').on(t.conversationId),
}))

// One immutable revision of an artifact. `author` distinguishes the assistant's
// generation/edits from the user's own hand edits; `summary` is an optional
// human-readable note ("Made the function async").
export const artifactVersions = sqliteTable('artifact_versions', {
  id: text('id').primaryKey(),
  artifactId: text('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  summary: text('summary'),
  author: text('author', { enum: ['assistant', 'user'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  artifactIdx: index('artifact_versions_artifact_idx').on(t.artifactId),
}))

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
  // Plex account-Watchlist mirror: the global Discover ratingKey we pushed this title under,
  // when it was last synced, and a soft-delete tombstone so a removal isn't re-imported on the
  // next reconcile (the classic two-way-sync bug). Rows with deletedAt set are hidden from the UI.
  plexRatingKey: text('plex_rating_key'),
  plexSyncedAt: integer('plex_synced_at', { mode: 'timestamp' }),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
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

// ─── Shopping / price tracker ───────────────────────────────────────────────────
// A shopping_products row is the household-wide "comparison group" for one real-world
// item; each retailer listing links to it (the podcastShows/podcastSubscriptions split:
// products+listings+history are shared so an item is scraped once regardless of how
// many people watch it, while watches and discounts below are per-user).
export const shoppingProducts = sqliteTable('shopping_products', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  brand: text('brand'),
  model: text('model'),               // MPN / manufacturer model number
  gtin: text('gtin'),                 // normalized GTIN-13 (UPC-A padded with a leading 0)
  imageUrl: text('image_url'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ gtinIdx: index('shopping_products_gtin_idx').on(t.gtin) }))

// One retailer listing per product. retailer='generic' for any-URL tracks (externalId is
// then the normalized URL). Latest observation is denormalized here for fast list views;
// the append-only history lives in shoppingPricePoints.
export const shoppingListings = sqliteTable('shopping_listings', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().references(() => shoppingProducts.id, { onDelete: 'cascade' }),
  retailer: text('retailer').notNull(),
  externalId: text('external_id').notNull(),
  url: text('url').notNull(),
  title: text('title'),
  imageUrl: text('image_url'),
  priceCents: integer('price_cents'),        // null = never seen or currently unavailable
  wasPriceCents: integer('was_price_cents'), // strikethrough/list price when shown
  currency: text('currency').notNull().default('USD'),
  inStock: integer('in_stock', { mode: 'boolean' }),
  // Best-effort product detail-page enrichment — populated opportunistically per adapter
  // (Amazon feature bullets + star rating, JSON-LD description/aggregateRating for stores
  // that expose it); null when a retailer doesn't surface it. Never blocks a price check.
  description: text('description'),
  ratingValue: real('rating_value'),
  ratingCount: integer('rating_count'),
  matchConfidence: text('match_confidence', { enum: ['gtin', 'model', 'fuzzy', 'manual'] }).notNull().default('manual'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastCheckedAt: integer('last_checked_at', { mode: 'timestamp' }),
  lastChangedAt: integer('last_changed_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  failCount: integer('fail_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  retailerItemUnique: unique().on(t.retailer, t.externalId),
  productIdx: index('shopping_listings_product_idx').on(t.productId),
}))

// Append-only price history. A point is written only when price/stock changed or the
// newest point is >24h old, so a stable listing costs ~1 row/day. priceCents null = out
// of stock at that observation. `via` records which provider produced the observation.
export const shoppingPricePoints = sqliteTable('shopping_price_points', {
  id: text('id').primaryKey(),
  listingId: text('listing_id').notNull().references(() => shoppingListings.id, { onDelete: 'cascade' }),
  priceCents: integer('price_cents'),
  inStock: integer('in_stock', { mode: 'boolean' }).notNull(),
  via: text('via').notNull().default('direct'), // 'direct' | 'pricewatchpro' | 'backfill'
  observedAt: integer('observed_at', { mode: 'timestamp' }).notNull(),
}, t => ({ listingTimeIdx: index('shopping_price_points_listing_time_idx').on(t.listingId, t.observedAt) }))

// Per-user alert rules. listingId null = watch every listing of the product (alerts use
// the cheapest). Prices compared in the user's effective terms (their discounts applied)
// when useEffectivePrice is set.
export const shoppingWatches = sqliteTable('shopping_watches', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull().references(() => shoppingProducts.id, { onDelete: 'cascade' }),
  listingId: text('listing_id').references(() => shoppingListings.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['target_price', 'percent_drop', 'any_drop', 'back_in_stock'] }).notNull(),
  targetPriceCents: integer('target_price_cents'),
  percentDrop: real('percent_drop'),
  useEffectivePrice: integer('use_effective_price', { mode: 'boolean' }).notNull().default(true),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastFiredAt: integer('last_fired_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userProductIdx: index('shopping_watches_user_product_idx').on(t.userId, t.productId) }))

// Per-user per-retailer standing discounts ("Military 10%", "RedCard 5%"). Multiple
// active rows for one retailer compound in creation order; never stored into prices —
// effective prices are computed at read/alert time.
export const shoppingDiscounts = sqliteTable('shopping_discounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  retailer: text('retailer').notNull(),
  label: text('label').notNull(),
  percentOff: real('percent_off').notNull(),      // 0–100
  maxDiscountCents: integer('max_discount_cents'),
  notes: text('notes'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userRetailerIdx: index('shopping_discounts_user_retailer_idx').on(t.userId, t.retailer) }))

// Generic-adapter memory: the extraction strategy that last worked for a store host, so
// any-URL tracking pays the discovery ladder once per site, not per check (PriceBuddy's
// "tunable strategies" idea). Re-laddered after two consecutive failures.
export const shoppingHostStrategies = sqliteTable('shopping_host_strategies', {
  host: text('host').primaryKey(),
  strategy: text('strategy', { enum: ['jsonld', 'selector', 'llm'] }).notNull(),
  priceSelector: text('price_selector'),
  titleSelector: text('title_selector'),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
  failCount: integer('fail_count').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Per-user saved items for the Shop landing — favorites (starred, kept) and recents (browse
// history, pruned to the newest N). Per-user so they sync across a person's devices; a light
// snapshot of the item (not a tracked product) so it renders without a live scrape.
export const shoppingSaved = sqliteTable('shopping_saved', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['favorite', 'recent'] }).notNull(),
  retailer: text('retailer').notNull(),
  externalId: text('external_id').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  imageUrl: text('image_url'),
  priceCents: integer('price_cents'),
  wasPriceCents: integer('was_price_cents'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  itemUnique: unique().on(t.userId, t.kind, t.retailer, t.externalId),
  userKindIdx: index('shopping_saved_user_kind_idx').on(t.userId, t.kind),
}))

// Coding (Claude Code, via tmux): no app-level project/session tables. Each user gets
// one persistent sandboxed workspace directory (data/coding/users/<userId>/, see
// lib/codingServer.ts workspaceDirFor()); Claude Code manages its own session/config
// state within it natively, so there's nothing for us to track separately.

// ─── Clipper (generic "paste any video URL, watch it or save it offline") ──────
// One row per user save. Unlike YouTube's shared media_assets rendition (keyed by
// videoId across all users), each clip is a personal save — its media_assets row is
// keyed 1:1 by (sourceType='clip', sourceId=clips.id), never deduped across users.
export const clips = sqliteTable('clips', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceUrl: text('source_url').notNull(),
  extractor: text('extractor'),
  title: text('title').notNull().default(''),
  thumbnailUrl: text('thumbnail_url'),
  durationSeconds: integer('duration_seconds'),
  kind: text('kind', { enum: ['audio', 'video'] }).notNull().default('video'),
  status: text('status', { enum: ['pending', 'downloading', 'ready', 'failed'] }).notNull().default('pending'),
  assetId: text('asset_id'),
  sizeBytes: integer('size_bytes'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Videos hub: generic multi-source persistence ───────────────────────────────
// New sources (reddit/tiktok/vimeo) persist here with a `source` discriminator;
// YouTube deliberately stays in its native yt_* tables (wrap, never rewrite) and is
// mapped into these shapes by lib/videos/library.ts's aggregation layer.

// Followed creators on non-YouTube sources (subreddits, TikTok creators, Vimeo
// channels). Mirrors yt_subscriptions' role, including the auto-save automation.
export const videoFollows = sqliteTable('video_follows', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['reddit', 'tiktok', 'vimeo'] }).notNull(),
  kind: text('kind', { enum: ['creator', 'subreddit', 'channel'] }).notNull().default('creator'),
  externalId: text('external_id').notNull(),   // subreddit name, @handle, vimeo channel id
  title: text('title').notNull().default(''),
  handle: text('handle'),
  thumbnailUrl: text('thumbnail_url'),
  description: text('description'),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp' }),
  // Cross-source auto-save automation (mirrors yt_subscriptions.auto_save*): new
  // uploads from this creator are downloaded automatically, pruned to keep-N.
  autoSave: integer('auto_save', { mode: 'boolean' }).notNull().default(false),
  autoSaveKind: text('auto_save_kind', { enum: ['audio', 'video'] }).notNull().default('video'),
  autoSaveKeep: integer('auto_save_keep'),     // null → global default
  // Delete this creator's auto-saved offline copies once fully watched (in-app completed
  // flag; independent of any Plex library policy — see lib/videos/offlineSweep.ts).
  removeWatched: integer('remove_watched', { mode: 'boolean' }).notNull().default(false),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userSourceExternalUnique: unique().on(t.userId, t.source, t.externalId) }))

// Feed cache for followed creators' uploads (mirrors yt_videos' role for the poller).
export const videoItems = sqliteTable('video_items', {
  id: text('id').primaryKey(),
  source: text('source', { enum: ['reddit', 'tiktok', 'vimeo'] }).notNull(),
  externalId: text('external_id').notNull(),   // provider-native video id
  followId: text('follow_id').references(() => videoFollows.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  creatorId: text('creator_id'),
  creatorName: text('creator_name'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  durationSec: integer('duration_sec'),
  viewsText: text('views_text'),                // pre-formatted, e.g. "4.9M views" (snapshot at poll time)
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  metaJson: text('meta_json'),                 // provider extras (v.redd.it urls, permalink…)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({ sourceExternalUnique: unique().on(t.source, t.externalId) }))

// Playback position for non-YouTube sources (yt_watch_state stays authoritative for YouTube).
export const videoWatchState = sqliteTable('video_watch_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['reddit', 'tiktok', 'vimeo'] }).notNull(),
  videoId: text('video_id').notNull(),
  positionSec: real('position_sec').notNull().default(0),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userSourceVideoUnique: unique().on(t.userId, t.source, t.videoId) }))

// Per-user download refs for non-YouTube sources (mirrors yt_downloads). The bytes
// live in the shared blob store via media_assets keyed (source, videoId, kind, format),
// so two household users saving the same TikTok share one blob.
export const videoSaves = sqliteTable('video_saves', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['reddit', 'tiktok', 'vimeo'] }).notNull(),
  videoId: text('video_id').notNull(),
  title: text('title').notNull().default(''),
  kind: text('kind', { enum: ['audio', 'video'] }).notNull().default('video'),
  status: text('status', { enum: ['pending', 'downloading', 'ready', 'failed'] }).notNull().default('pending'),
  assetId: text('asset_id'),
  sizeBytes: integer('size_bytes'),
  maxHeight: integer('max_height'),
  thumbnailUrl: text('thumbnail_url'),
  creatorName: text('creator_name'),
  durationSec: integer('duration_sec'),
  sourceUrl: text('source_url'),               // canonical URL the download job feeds to yt-dlp
  // True when written by follow auto-save (rolling keep-N prune eligible), like yt_downloads.auto.
  auto: integer('auto', { mode: 'boolean' }).notNull().default(false),
  isAdult: integer('is_adult', { mode: 'boolean' }).notNull().default(false),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userSourceVideoKindUnique: unique().on(t.userId, t.source, t.videoId, t.kind) }))

// ─── Videos Create studio ────────────────────────────────────────────────────────
// Projects are EDL JSON documents (versioned; validated by lib/videostudio/edl.ts).
// Media-bin items own their bytes via media_assets(sourceType='studio'); assets any
// project references are pinned against GC through studio_project_assets.

export const studioProjects = sqliteTable('studio_projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  edlJson: text('edl_json').notNull(),
  durationSec: real('duration_sec').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Bin items the studio itself owns: uploads, mic recordings, imported generations, and
// finished exports. Personal (never cross-user deduped at the asset layer, like clips);
// the blob layer still dedups identical bytes.
export const studioMedia = sqliteTable('studio_media', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  origin: text('origin', { enum: ['upload', 'recording', 'generated', 'export'] }).notNull(),
  title: text('title').notNull().default(''),
  description: text('description'),
  kind: text('kind', { enum: ['video', 'audio', 'image'] }).notNull().default('video'),
  assetId: text('asset_id'),                    // → mediaAssets.id once ready
  status: text('status', { enum: ['pending', 'processing', 'ready', 'failed'] }).notNull().default('pending'),
  durationSec: real('duration_sec'),
  width: integer('width'),
  height: integer('height'),
  // JSON context: {imageId} for generated imports, {projectId, preset, edlSnapshot} for exports.
  sourceMeta: text('source_meta'),
  // Set = "shared with household": other members see this video in their My Videos Plex
  // library (under the owner's show) and in shared surfaces. Null = private to the owner.
  sharedAt: integer('shared_at', { mode: 'timestamp' }),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// GC pin rows: re-diffed from the EDL's asset ids on every project save. Protects
// yt/clip/video-save assets used in a timeline even if their library ref is removed;
// deleting the project cascades these away and unpins naturally.
export const studioProjectAssets = sqliteTable('studio_project_assets', {
  projectId: text('project_id').notNull().references(() => studioProjects.id, { onDelete: 'cascade' }),
  assetId: text('asset_id').notNull(),
}, t => ({ pk: unique().on(t.projectId, t.assetId) }))

// ─── Storage locations (generic, content-type agnostic) ────────────────────────
// A named filesystem root — local or a network/UNC path — the app can store real
// content under. Distinct from `storage.user_data_root` (paths.ts's single default
// data root, untouched by this): a content type only leaves that default root when
// explicitly assigned one of these via `contentTypeStorage`.
export const storageLocations = sqliteTable('storage_locations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Which storage location owns a given content type's real files. Row absent (or
// storageLocationId null) = that content type stays on the default app data root,
// exactly like today. contentType is a free-form key ('youtube', later 'podcasts' |
// 'music' | 'audiobooks') rather than an enum so new content types don't need a
// migration to participate.
export const contentTypeStorage = sqliteTable('content_type_storage', {
  contentType: text('content_type').primaryKey(),
  storageLocationId: text('storage_location_id').references(() => storageLocations.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Plex-only concern, deliberately separate from storageLocations itself: how Plex's
// own OS process sees the SAME bytes a storage location's `path` points at from the
// app's side (e.g. app sees `\\server\share`, Plex sees `/mnt/share`). Only consulted
// when registering a Plex library section's `location` or calling the targeted-refresh
// API — never used for the app's own reads/writes.
export const plexPathMappings = sqliteTable('plex_path_mappings', {
  id: text('id').primaryKey(),
  storageLocationId: text('storage_location_id').notNull()
    .references(() => storageLocations.id, { onDelete: 'cascade' }).unique(),
  plexPath: text('plex_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// ─── Plex per-user library provisioning ────────────────────────────────────────
// One row per (user, content type) once a private Plex "show" library has been
// created and shared to only that user's Plex account. `sharedServerId` is the id
// returned by Plex's shared_servers API, needed to revoke/update the share later.
export const plexLibrarySections = sqliteTable('plex_library_sections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  plexSectionKey: text('plex_section_key'),
  plexMachineIdentifier: text('plex_machine_identifier'),
  sharedServerId: text('shared_server_id'),
  rootAbsPath: text('root_abs_path'),
  status: text('status', { enum: ['pending', 'provisioning', 'ready', 'error'] }).notNull().default('pending'),
  error: text('error'),
  // Per-library sync policy (mirrors Plex's own download options). `syncMode: 'recent'`
  // trims the Plex TREE to the newest N per show — it never deletes the underlying saves
  // (channel keep-N pruning owns that). `removeWatched` is the Plex-style delete-after-
  // watching: a fully-played episode is removed from the tree AND its save row deleted
  // (never offered for 'mine' — own creations aren't downloads).
  syncMode: text('sync_mode', { enum: ['all', 'recent'] }).notNull().default('all'),
  syncRecentCount: integer('sync_recent_count'),      // null → DEFAULT_SYNC_RECENT_COUNT when mode='recent'
  removeWatched: integer('remove_watched', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userContentTypeUnique: unique().on(t.userId, t.contentType) }))

// Playlists / Watch-Later / Liked → native Plex Collections (a cross-cutting shelf tag
// applied to episodes that already live under their real channel-show — never a duplicate
// show/season; see project plan §"how do collections contribute"). One row per source.
export const plexCollections = sqliteTable('plex_collections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  sourceType: text('source_type', { enum: ['playlist', 'collection'] }).notNull(),
  sourceId: text('source_id').notNull(),   // ytPlaylists.id, or 'watch-later' | 'liked'
  plexCollectionTitle: text('plex_collection_title'),
  plexRatingKey: text('plex_rating_key'),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userSourceUnique: unique().on(t.userId, t.contentType, t.sourceType, t.sourceId) }))

// ─── YouTube → Plex export tree tracking ────────────────────────────────────────
// One Plex "show" per (user, channel, variant) — 'shorts' is a SEPARATE show from 'main'
// so Shorts never mix into the main channel's per-year episode grid. Kept apart from
// ytSubscriptions (a subscription can exist with no Plex export at all, and this needs
// per-user folder/NFO bookkeeping fields that don't belong on the shared catalog).
export const ytPlexShows = sqliteTable('yt_plex_shows', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  variant: text('variant', { enum: ['main', 'shorts'] }).notNull().default('main'),
  title: text('title').notNull(),
  folderRelPath: text('folder_rel_path').notNull(),   // relative to this user's content root
  nfoHash: text('nfo_hash'),                          // detects "channel metadata changed, rewrite tvshow.nfo"
  nfoWrittenAt: integer('nfo_written_at', { mode: 'timestamp' }),
  postersWrittenAt: integer('posters_written_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userChannelVariantUnique: unique().on(t.userId, t.channelId, t.variant) }))

// One row per (user, video) placed into that user's Plex tree — tracks a lifecycle
// orthogonal to ytDownloads ("is this saved offline"): "is this in this user's Plex
// library," which fields matter for NFO/asset freshness, and (once cutting lands) which
// SponsorBlock category set produced the rendition actually placed.
export const ytPlexEpisodes = sqliteTable('yt_plex_episodes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: text('video_id').notNull(),
  showId: text('show_id').notNull().references(() => ytPlexShows.id, { onDelete: 'cascade' }),
  seasonYear: integer('season_year').notNull(),       // upload year; 0 for the flat Shorts season
  // MMDD-derived by default (date-sortable, human-readable), bumped by 1 on same-day collision
  // within the (showId, seasonYear) pair — this column is the source of truth for that check.
  episodeNumber: integer('episode_number').notNull(),
  sourceAssetId: text('source_asset_id'),             // media_assets.id of the original (uncut) rendition
  cutFormatKey: text('cut_format_key'),                // derived media_assets.format when a cut rendition exists
  cutCategoriesHash: text('cut_categories_hash'),
  cutSegmentsJson: text('cut_segments_json'),
  relPath: text('rel_path'),                          // placed file's path, relative to this user's content root
  nfoWrittenAt: integer('nfo_written_at', { mode: 'timestamp' }),
  thumbWrittenAt: integer('thumb_written_at', { mode: 'timestamp' }),
  srtWrittenAt: integer('srt_written_at', { mode: 'timestamp' }),
  status: text('status', { enum: ['pending', 'cutting', 'placing', 'ready', 'failed'] }).notNull().default('pending'),
  error: text('error'),
  plexRefreshedAt: integer('plex_refreshed_at', { mode: 'timestamp' }),
  // Plex's ratingKey for this placed episode, learned lazily by the watched sweep's
  // basename match — makes subsequent sweeps a cheap id lookup instead of a path match.
  plexRatingKey: text('plex_rating_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userVideoUnique: unique().on(t.userId, t.videoId) }))

// ─── Videos hub → Plex export tree tracking (generic sources) ──────────────────
// The non-YouTube twin of ytPlexShows/ytPlexEpisodes, one pair of tables for every
// hub source ('tiktok' | 'vimeo' | 'reddit' | 'mine') distinguished by `source`.
// Kept separate from the yt_* tables on purpose: those carry SponsorBlock cut columns
// and shorts-variant semantics that don't generalize, and reusing them would put the
// shipped YouTube export at migration risk for zero benefit.
//
// creatorKey per source: follow externalId (tiktok/vimeo), normalized subreddit
// ('r-AskReddit', never 'r/AskReddit' — '/' is a path separator) for reddit, and the
// OWNER's userId for 'mine' (shows = household members; a shared studio video appears
// in every member's My Videos library under the sharer's show).
export const videoPlexShows = sqliteTable('video_plex_shows', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),                   // 'tiktok' | 'vimeo' | 'reddit' | 'mine'
  creatorKey: text('creator_key').notNull(),
  title: text('title').notNull(),
  folderRelPath: text('folder_rel_path').notNull(),   // relative to this user's content root
  nfoHash: text('nfo_hash'),                          // "creator metadata changed, rewrite tvshow.nfo"
  nfoWrittenAt: integer('nfo_written_at', { mode: 'timestamp' }),
  postersWrittenAt: integer('posters_written_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userSourceCreatorUnique: unique().on(t.userId, t.source, t.creatorKey) }))

// One row per (user, source, video) placed into that user's per-source Plex tree.
// videoId is the provider externalId — or studio_media.id for 'mine'. sourceAssetId is
// the media_assets row actually placed (base OR enhanced rendition); a mismatch against
// the freshly-resolved rendition is what triggers a re-place after an enhance completes.
export const videoPlexEpisodes = sqliteTable('video_plex_episodes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  videoId: text('video_id').notNull(),
  showId: text('show_id').notNull().references(() => videoPlexShows.id, { onDelete: 'cascade' }),
  seasonYear: integer('season_year').notNull(),
  // MMDD-derived, bumped by 1 on same-day collision within (showId, seasonYear) —
  // same scheme as ytPlexEpisodes so filenames stay date-sortable.
  episodeNumber: integer('episode_number').notNull(),
  sourceAssetId: text('source_asset_id'),
  relPath: text('rel_path'),                          // placed file's path, relative to this user's content root
  plexRatingKey: text('plex_rating_key'),             // learned lazily by the watched sweep
  nfoWrittenAt: integer('nfo_written_at', { mode: 'timestamp' }),
  thumbWrittenAt: integer('thumb_written_at', { mode: 'timestamp' }),
  srtWrittenAt: integer('srt_written_at', { mode: 'timestamp' }),
  status: text('status', { enum: ['pending', 'placing', 'ready', 'failed'] }).notNull().default('pending'),
  error: text('error'),
  plexRefreshedAt: integer('plex_refreshed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({ userSourceVideoUnique: unique().on(t.userId, t.source, t.videoId) }))

// ─── Notes (household knowledge base) ─────────────────────────────────────────
// Markdown reference notes: appliance install gotchas, homelab runbooks, project
// research, measurements. ownerId null = household-shared (visible to everyone,
// admin-managed — same convention as bookmarks); non-null = personal. Content lives
// ONLY here; other apps (Home Inventory device sheet) surface notes via note_links.
// Companion reads notes through note_chunks recall (lib/notes/recall.ts) and writes
// through the remember tool's capture classification (tools/memory.ts).

export const notebooks = sqliteTable('notebooks', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }), // null = household-shared (admin-managed)
  name: text('name').notNull(),
  icon: text('icon'),
  color: text('color'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }), // null = household-shared
  notebookId: text('notebook_id').references(() => notebooks.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  body: text('body').notNull().default(''),            // markdown
  // Denormalized space-joined tag names, maintained by routes/notes.ts on every tag
  // change purely so the notes_fts triggers index tags without extra FTS plumbing.
  tagsText: text('tags_text').notNull().default(''),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  source: text('source', { enum: ['user', 'companion'] }).notNull().default('user'),
  // Audit only (shared notes must survive their creator's deletion).
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  ownerUpdatedIdx: index('notes_owner_updated_idx').on(t.ownerId, t.updatedAt),
}))

// ownerId null = shared-scope tag (rendered for every member); non-null = personal.
export const noteTags = sqliteTable('note_tags', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
})

export const noteItemTags = sqliteTable('note_item_tags', {
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => noteTags.id, { onDelete: 'cascade' }),
}, t => ({ pk: primaryKey({ columns: [t.noteId, t.tagId] }) }))

// Polymorphic link from a note to an app entity (no FK on targetId by design).
export const noteLinks = sqliteTable('note_links', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  targetType: text('target_type', { enum: ['device', 'bookmark'] }).notNull(),
  targetId: text('target_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  targetIdx: index('note_links_target_idx').on(t.targetType, t.targetId),
  noteIdx: index('note_links_note_idx').on(t.noteId),
}))

// Embedded chunks of title+body (nomic via Ollama; JSON float array — docChunks
// convention), rebuilt after each content change. Powers companion recall and the
// global-search semantic fallback. Rows absent when embeddings were unavailable at
// save time — consumers degrade to FTS.
export const noteChunks = sqliteTable('note_chunks', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  text: text('text').notNull(),
  embedding: text('embedding'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  noteIdx: index('note_chunks_note_idx').on(t.noteId),
}))
