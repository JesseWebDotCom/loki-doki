import { ChangeEvent, FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createAvatar } from "@dicebear/core"
import * as dicebearCollections from "@dicebear/collection"
import {
  ArrowUpDown,
  ArrowUp,
  ArrowUpCircle,
  CircleAlert,
  CircleCheckBig,
  Clapperboard,
  ChevronDown,
  Camera,
  Ellipsis,
  FileText,
  KeyRound,
  LoaderCircle,
  Bug,
  LogOut,
  Menu,
  MessageSquarePlus,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  Upload,
  Smile,
  Scan,
  User,
  Eye,
  EyeOff,
  Ear,
  EarOff,
  Download,
  X,
  Plus,
  Server,
  Maximize2,
  Minimize2,
  Monitor,
  MessageSquare,
} from "lucide-react"

import { CharacterContext, type CharacterOptions } from "@/character-editor/context/CharacterContext"
import { VoiceContext } from "@/character-editor/context/VoiceContext"
import { AudioContext } from "@/character-editor/context/AudioContext"
import AnimatedCharacter from "@/character-editor/components/AnimatedCharacter"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/character-editor/components/ui/dropdown-menu"

import { Button } from "@/components/ui/button"
import { AssistantMessageCard } from "@/components/assistant-message-card"
import { AppSidebar } from "@/components/app-sidebar"
import { CharacterQuickSwitcher } from "@/components/character-quick-switcher"
import { MemoryManagementPanel } from "@/components/memory-management-panel"
import { createBargeInMonitor } from "@/barge-in"
import { ChatComposer } from "@/components/chat-composer"
import { WakewordSignalVisualizer } from "@/components/wakeword-signal-visualizer"
import { ChatMessageList, JumpToLatest } from "@/components/chat-message-list"
import { LiveCameraPreview } from "@/components/live-camera-preview"
import { PersonRegistrationPanel } from "@/components/person-registration-panel"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PendingDocument, PendingImage, PendingVideo, prepareDocumentUpload, prepareImageUpload, prepareVideoUpload } from "@/media"
import { Select } from "@/components/ui/select"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  createWakewordMonitor,
  createPushToTalkRecorder,
  createPushToTalkRecognizer,
  listVoiceOutputOptions,
  prepareSpeechText,
  primeAudioPlayback,
  recordPushToTalkSample,
  speakText,
  stopSpeaking,
  supportsVoiceInput,
  supportsVoiceOutput,
  supportsPushToTalkRecording,
} from "@/voice"
import { VoicePipeline } from "@/services/voice-pipeline"
import { cn } from "@/lib/utils"
import { applyThemeAttributes, fallbackThemePresets, resolveThemeMode, type ThemeMode, type ThemePresetId, type ThemePresetSummary } from "@/theme"

type VoiceTelemetry = {
  pipelineStatus: "idle" | "connecting" | "streaming" | "speaking" | "error"
  currentViseme: string
  requestedAtMs: number | null
  firstChunkAtMs: number | null
  playbackStartAtMs: number | null
  completedAtMs: number | null
}

type VADTelemetry = {
  isSpeaking: boolean
  speechFrames: number
  silenceFrames: number
  capturing: boolean
  rms: number
  peak: number
}

type LiveTranscriptionPayload = {
  sequence: number
  is_final: boolean
  transcript: string
}

type WakewordDebugResult = {
  status: "idle" | "running" | "detected" | "not_detected" | "error"
  detail: string
  score: number
  startedAtMs: number | null
  finishedAtMs: number | null
}

type WakewordTelemetry = {
  peak: number
  rms: number
  speechLevel: number
  wakewordScore: number
}

function formatVoiceLatency(startMs: number | null, endMs: number | null): string {
  if (startMs === null || endMs === null) {
    return " -- "
  }
  return ` ${Math.max(0, endMs - startMs).toFixed(0)}ms`
}

type UserRecord = {
  id: string
  username: string
  display_name: string
  is_admin?: boolean
}

type ChatSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
  last_message_at: string | null
  message_count: number
}

type ChatMessage = {
  role: "user" | "assistant"
  content: string
  created_at?: string
  pending?: boolean
  debug?: {
    startedAtMs?: number
    durationMs?: number
  }
  meta?: {
    request_type: string
    route: string
    reason: string
    turn_id?: string
    voice_summary?: string
    response_style?: string
    response_style_debug?: {
      selected_style?: string
      scores?: Record<string, number>
      factors?: Array<{
        source?: string
        style?: string
        weight?: number
        detail?: string
      }>
    }
    skill_route?: {
      outcome: string
      reason: string
      candidate?: {
        skill_id: string
        action: string
      } | null
    }
    execution?: {
      provider: string
      backend: string
      model: string
      acceleration: string
    }
    skill_result?: {
      skill: string
      action: string
    }
    rendered_response?: {
      summary: string
      metadata: Record<string, unknown>
    }
    prompt_debug?: {
      prompt_hash?: string
      cache_hit?: boolean
      character_id?: string | null
      care_profile_id?: string
    }
    memory_debug?: {
      used?: boolean
      session_applied?: boolean
      long_term_applied?: boolean
      session_preview?: string
      long_term_preview?: string
    }
    card?: {
      type: string
      title?: string
      detail?: string
    }
  }
}

type BootstrapDetails = {
  app_name: string
  profile: string
  allow_signup: boolean
  models: {
    llm_fast: string
    llm_thinking: string
    function_model: string
    vision_model: string
    stt_model: string
    tts_voice: string
    wake_word: string
    image_gen_model?: string
    image_gen_lcm_lora?: string
  }
}

type Capability = {
  key: string
  label: string
  status: "ok" | "warn" | "error"
  detail: string
}

type HealthPayload = {
  ok: boolean
  profile: string
  app_name: string
  capabilities: Capability[]
}

type SettingsPayload = {
  theme_preset_id: ThemePresetId
  theme_mode: ThemeMode
  effective_theme_preset_id: ThemePresetId
  effective_theme_mode: ThemeMode
  theme_locked: boolean
  theme_admin_override_enabled: boolean
  theme_admin_override_preset_id: ThemePresetId
  theme_admin_override_mode: ThemeMode
  available_themes: ThemePresetSummary[]
  debug_mode: boolean
  is_admin: boolean
  chats: ChatSummary[]
  active_chat_id: string
  history: ChatMessage[]
  voice_reply_enabled: boolean
  voice_source: "browser" | "piper"
  browser_voice_uri: string
  piper_voice_id: string
  barge_in_enabled: boolean
  wakeword_enabled: boolean
  wakeword_model_id: string
  wakeword_threshold: number
  care_profile_id: string
  care_profile_label: string
  character_enabled: boolean
  active_character_id: string
  assigned_character_id: string
  can_select_character: boolean
  user_prompt: string
  base_prompt_hash: string
  admin_prompt: string
  blocked_topics: string[]
  character_customizations: Record<string, string>
  account_default_character_id: string
  character_feature_enabled: boolean
  care_profiles: CareProfile[]
  characters: CharacterDefinition[]
}

type CareProfile = {
  id: string
  label: string
  tone: string
  vocabulary: string
  sentence_length: string
  response_style: string
  blocked_topics: string[]
  safe_messaging: boolean
  max_response_tokens: number
  builtin: boolean
}

type CharacterDefinition = {
  id: string
  name: string
  version: string
  source: string
  system_prompt: string
  default_voice: string
  default_voice_download_url: string
  default_voice_config_download_url: string
  default_voice_source_name: string
  default_voice_config_source_name: string
  wakeword_model_id: string
  wakeword_download_url: string
  wakeword_source_name: string
  download_url?: string
  meta_url?: string
  logo: string
  description: string
  teaser?: string
  phonetic_spelling?: string
  identity_key?: string
  domain?: string
  behavior_style?: string
  preferred_response_style?: string
  voice_model?: string
  character_editor?: Record<string, unknown>
  installed: boolean
  enabled: boolean
  builtin: boolean
}

type CharacterEditorDraft = {
  name: string
  description: string
  teaser: string
  phonetic_spelling: string
  logo: string
  system_prompt: string
  identity_key: string
  domain: string
  behavior_style: string
  preferred_response_style: string
  voice_model: string
  character_editor: Record<string, unknown>
  default_voice: string
  default_voice_download_url: string
  default_voice_config_download_url: string
  default_voice_source_name: string
  default_voice_config_source_name: string
  default_voice_upload_data_url: string
  default_voice_config_upload_data_url: string
  wakeword_model_id: string
  wakeword_download_url: string
  wakeword_source_name: string
  wakeword_upload_data_url: string
}

type CharacterPackage = {
  format: string
  character: Record<string, unknown>
}

type CharacterEditorBundle = {
  character_id?: string
  identity_key: string
  logo_data_url?: string
  manifest?: {
    primary_name?: string
    domain?: string
    identity_key?: string
    teaser?: string
    phonetic_spelling?: string
    behavior_style?: string
    voice_model?: string
    preferred_response_style?: string
    wakeword_model?: string
  }
  editor_state?: {
    character_id?: string
    name?: string
    description?: string
    teaser?: string
    phonetic_spelling?: string
    style?: string
    seed?: string
    persona_prompt?: string
    preferred_response_style?: string
    voice_model?: string
    default_voice_source_name?: string
    default_voice_config_source_name?: string
    default_voice_upload_data_url?: string
    default_voice_config_upload_data_url?: string
    wakeword_model_id?: string
    wakeword_source_name?: string
    wakeword_upload_data_url?: string
    [key: string]: unknown
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function slugifyCharacterId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const next = value.filter((entry): entry is string => typeof entry === "string")
  return next.length ? next : undefined
}

function buildCharacterEditorLogo(characterEditor: Record<string, unknown>, fallbackName: string, fallbackStyle: string) {
  const editorState = asRecord(characterEditor.editor_state)
  if (!editorState) {
    return ""
  }

  const styleId = typeof editorState.style === "string" && editorState.style.trim() ? editorState.style : fallbackStyle || "avataaars"
  const selectedCollection =
    ({
      avataaars: dicebearCollections.avataaars,
      bottts: dicebearCollections.bottts,
      toonHead: dicebearCollections.toonHead,
    } as Record<string, Parameters<typeof createAvatar>[0]>)[styleId] || dicebearCollections.avataaars

  const avatarOptions: Record<string, unknown> = {
    seed:
      (typeof editorState.seed === "string" && editorState.seed.trim()) ||
      (typeof editorState.name === "string" && editorState.name.trim()) ||
      fallbackName ||
      "Character",
    flip: editorState.flip === true,
    rotate: typeof editorState.rotate === "number" ? editorState.rotate : 0,
    radius: typeof editorState.radius === "number" ? editorState.radius : 0,
    scale: 100,
  }

  const keyedArrays = [
    "top",
    "accessories",
    "accessoriesColor",
    "clothing",
    "clothingGraphic",
    "clothesColor",
    "eyebrows",
    "eyes",
    "facialHair",
    "facialHairColor",
    "hairColor",
    "hatColor",
    "mouth",
    "skinColor",
  ] as const

  for (const key of keyedArrays) {
    const values = asStringArray(editorState[key])
    if (values && values[0] !== "seed") {
      avatarOptions[key] = values
    }
  }

  const svg = createAvatar(selectedCollection, avatarOptions).toString()
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

function buildPersistedCharacterEditorMetadata(draft: CharacterEditorDraft) {
  const nextCharacterEditor = { ...(draft.character_editor || {}) }
  const existingEditorState = sanitizeCharacterEditorState(asRecord(nextCharacterEditor.editor_state) || {})
  const nextStyle = typeof existingEditorState.style === "string" && existingEditorState.style.trim()
    ? existingEditorState.style
    : "avataaars"

  nextCharacterEditor.editor_state = {
    ...existingEditorState,
    preferred_response_style: draft.preferred_response_style || "balanced",
    wakeword_model_id: draft.wakeword_model_id || "",
    style: nextStyle,
  }

  return nextCharacterEditor
}

function buildCharacterEditorLaunchState(character: CharacterDefinition, draft: CharacterEditorDraft | null) {
  const existingEditorState = asRecord(character.character_editor)?.editor_state as Record<string, unknown> | undefined
  const resolvedName = draft?.name || character.name || "Character"
  const resolvedStyle =
    (typeof existingEditorState?.style === "string" && existingEditorState.style.trim()) ||
    characterEditorStyle(character)

  return {
    ...(existingEditorState || {}),
    character_id: character.id,
    name: resolvedName,
    identity_key: draft?.identity_key || character.identity_key || character.id,
    description: draft?.description || character.description || "",
    teaser: draft?.teaser || character.teaser || "",
    phonetic_spelling: draft?.phonetic_spelling || character.phonetic_spelling || "",
    persona_prompt: draft?.system_prompt || character.behavior_style || character.system_prompt || "",
    preferred_response_style: draft?.preferred_response_style || character.preferred_response_style || "balanced",
    voice_model: draft?.default_voice || character.voice_model || character.default_voice || "en-us-lessac-medium.onnx",
    wakeword_model_id: draft?.wakeword_model_id || character.wakeword_model_id || "",
    style: resolvedStyle,
    seed:
      (typeof existingEditorState?.seed === "string" && existingEditorState.seed.trim()) ||
      resolvedName,
  }
}

function buildCharacterEditorDraft(character: CharacterDefinition): CharacterEditorDraft {
  return {
    name: character.name,
    description: character.description,
    teaser: character.teaser || "",
    phonetic_spelling: character.phonetic_spelling || "",
    logo: character.logo || "",
    system_prompt: character.system_prompt || "",
    identity_key: character.identity_key || "",
    domain: character.domain || "",
    behavior_style: character.behavior_style || character.system_prompt || "",
    preferred_response_style: character.preferred_response_style || "balanced",
    voice_model: character.voice_model || character.default_voice || "",
    character_editor: { ...(character.character_editor || {}) },
    default_voice: character.default_voice || "",
    default_voice_download_url: character.default_voice_download_url || "",
    default_voice_config_download_url: character.default_voice_config_download_url || "",
    default_voice_source_name: character.default_voice_source_name || "",
    default_voice_config_source_name: character.default_voice_config_source_name || "",
    default_voice_upload_data_url: "",
    default_voice_config_upload_data_url: "",
    wakeword_model_id: character.wakeword_model_id || "",
    wakeword_download_url: character.wakeword_download_url || "",
    wakeword_source_name: character.wakeword_source_name || "",
    wakeword_upload_data_url: "",
  }
}


function characterEditorStyle(character: Pick<CharacterDefinition, "character_editor" | "domain">) {
  const editorState = asRecord(asRecord(character.character_editor)?.editor_state)
  const style = typeof editorState?.style === "string" ? editorState.style.trim() : ""
  return style || "avataaars"
}

function getCharacterEditorBaseUrl() {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/character-editor/editor`
  }
  return "/character-editor/editor"
}

function buildCharacterEditorUrl(
  params: URLSearchParams,
  themePresetId: ThemePresetId,
  themeMode: ThemeMode
): string {
  params.set("theme_preset", themePresetId)
  params.set("theme_mode", themeMode)
  return `${getCharacterEditorBaseUrl()}${params.toString() ? `?${params.toString()}` : ""}`
}

const REDUNDANT_CHARACTER_EDITOR_STATE_KEYS = new Set([
  "character_id",
  "name",
  "identity_key",
  "description",
  "teaser",
  "phonetic_spelling",
  "persona_prompt",
  "voice_model",
])

function sanitizeCharacterEditorState(editorState: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!editorState) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(editorState).filter(([key]) => (
      !key.endsWith("_upload_data_url")
      && !REDUNDANT_CHARACTER_EDITOR_STATE_KEYS.has(key)
    ))
  )
}

function serializeEditorState(editorState: Record<string, unknown> | null | undefined): string {
  const sanitized = sanitizeCharacterEditorState(editorState)
  if (!Object.keys(sanitized).length) {
    return ""
  }
  try {
    return JSON.stringify(sanitized)
  } catch {
    return ""
  }
}

type AdminAccountPayload = {
  id: string
  name: string
  default_character_id: string
  character_feature_enabled: boolean
  core_safety_prompt: string
  account_policy_prompt: string
  auto_update_skills: boolean
}

type PromptPolicyPayload = {
  account_id: string
  core_safety_prompt: string
  account_policy_prompt: string
  proactive_chatter_enabled: boolean
}

type ContextField = {
  key: string
  label: string
  type: "text" | "textarea" | "select" | "number"
  scope: "shared" | "account"
  placeholder: string
  help_text: string
  required: boolean
  default_value: unknown
  options: Array<{ value: string; label: string }>
}

type SkillAccount = {
  id: string
  config: Record<string, unknown>
  label: string
  context: Record<string, unknown>
  enabled: boolean
  is_default: boolean
  health_status: string
  health_detail: string
}

type InstalledSkill = {
  skill_id: string
  version: string
  title: string
  domain: string
  description: string
  logo: string
  enabled: boolean
  system: boolean
  load_type: string
  health_status: string
  health_detail: string
  last_used_at: string | null
  accounts: SkillAccount[]
  shared_context_fields: ContextField[]
  account_context_fields: ContextField[]
  shared_context: Record<string, unknown>
}

type AvailableSkill = {
  id: string
  title: string
  latest_version: string
  description: string
  domains: string[]
  platforms: string[]
  account_mode: string
  logo_url: string
  download_url: string
  meta_url: string
  installed: boolean
}

type CatalogRepositoryInfo = {
  title: string
  description: string
  repo_url: string
  source_repo_url: string
  index_url: string
}

type SkillCatalogEntry = {
  id: string
  title: string
  description: string
  version: string
  logo: string
  installed: boolean
  enabled: boolean
  system: boolean
  health_status: string
  health_detail: string
  domains: string[]
  load_type: string
  account_count: number
}

type SkillsPayload = {
  installed: InstalledSkill[]
  available: AvailableSkill[]
  repository: CatalogRepositoryInfo
  updated_count?: number
  updated_ids?: string[]
}

type AdminUserRecord = {
  id: string
  username: string
  display_name: string
  created_at: string
  is_admin: boolean
  care_profile_id: string
  character_enabled: boolean
  assigned_character_id: string
  can_select_character: boolean
  admin_prompt: string
  blocked_topics: string[]
  compiled_base_prompt: string
  compiled_prompt_hash: string
  theme_preset_id: ThemePresetId
  theme_mode: ThemeMode
  theme_admin_override_enabled: boolean
  theme_admin_override_preset_id: ThemePresetId
  theme_admin_override_mode: ThemeMode
  effective_theme_preset_id: ThemePresetId
  effective_theme_mode: ThemeMode
  theme_locked: boolean
}

type AdminUsersPayload = {
  users: AdminUserRecord[]
}

type SkillRouteDecision = {
  outcome: string
  reason: string
  candidate: {
    skill_id: string
    action: string
    score: number
    reason: string
    extracted_entities: Record<string, unknown>
  } | null
  alternatives: Array<{
    skill_id: string
    action: string
    score: number
    reason: string
  }>
}

type SkillTestPayload = {
  route: SkillRouteDecision
  message: ChatMessage | null
  timing_ms: number
  context: {
    profile: string
    username: string
    display_name: string
    shared_contexts: Record<string, Record<string, unknown>>
    accounts?: Record<string, Array<{ id: string; label: string; enabled: boolean; is_default: boolean }>>
  }
  result?: {
    ok: boolean
    skill_id: string
    action: string
    reply: string
  } | null
}

type PromptLabPayload = {
  user: UserRecord
  profile: string
  elapsed_ms: number
  timings: {
    context_build_ms: number
    skill_route_ms: number
    skill_execute_ms: number
    render_ms: number
    total_ms: number
  }
  route: {
    request_type: string
    route: string
    reason: string
  }
  skill_route: SkillRouteDecision
  skill_execution: {
    route: SkillRouteDecision | null
    message: ChatMessage | null
    result: Record<string, unknown> | null
  } | null
  response: {
    text: string
    summary: string
    metadata: Record<string, unknown>
  }
  execution: {
    provider: string
    backend: string
    model: string
    acceleration: string
  }
  character: {
    id: string | null
    enabled: boolean
  }
  care_profile: {
    id: string
    label: string
  }
  layers: Record<PromptLabLayerKey, string>
  compiler_messages: Array<{ role: string; content: string }>
  compiled_prompt: string
  prompt_debug: {
    prompt_hash?: string
    cache_hit?: boolean
    character_id?: string | null
    care_profile_id?: string
    llm_used?: boolean
    llm_messages?: Array<{ role: string; content: string }>
    policy_blocked?: boolean
    blocked_topics?: string[]
    enabled_layers?: Record<string, boolean>
  }
}

type PromptLabCompilePayload = {
  user: UserRecord
  profile: string
  timing_ms: number
  prompt_hash: string
  compiled_prompt: string
  layers: Record<PromptLabLayerKey, string>
  enabled_layers: Record<PromptLabLayerKey, boolean>
  compiler_messages: Array<{ role: string; content: string }>
  character: {
    id: string | null
    enabled: boolean
  }
  care_profile: {
    id: string
    label: string
  }
}

type RuntimeMetricsPayload = {
  app_name: string
  profile: string
  overview: {
    nodes_total: number
    nodes_connected: number
    users_total: number
  }
  system: {
    cpu: {
      load_percent: number
      cpu_count: number
    }
    memory: {
      used_bytes: number
      total_bytes: number
      used_percent: number
    }
    disk: {
      used_bytes: number
      total_bytes: number
      used_percent: number
      path: string
    }
  }
  storage: Array<{
    key: string
    label: string
    path: string
    exists: boolean
    size_bytes: number
  }>
  resources: Array<{
    key: string
    label: string
    cpu_percent: number
    memory_percent: number
    memory_used_bytes: number
    memory_total_bytes: number
    disk_percent: number
    disk_used_bytes: number
    disk_total_bytes: number
    detail: string
  }>
  processes: Array<{
    label: string
    kind: string
    running: boolean
    pid: number | null
    cpu_percent: number
    memory_bytes: number
    command: string
  }>
}

type PiperVoice = {
  id: string
  label: string
  language: string
  quality: string
  description: string
  installed: boolean
  synthesis_ready: boolean
}

type AdminVoiceRecord = PiperVoice & {
  custom?: boolean
  curated?: boolean
  gender: string
  source_url: string
  config_url: string
  model_source_name: string
  config_source_name: string
  model_path: string
  config_path: string
  characters: Array<{
    character_id: string
    character_name: string
  }>
}

type PiperCatalogStatus = {
  source_url: string
  fetched_at: number
  voice_count: number
  used_cache: boolean
  stale: boolean
}

type CustomVoiceEditorDraft = {
  voice_id: string
  label: string
  description: string
  model_url: string
  config_url: string
  language: string
  quality: string
  gender: string
}

type CatalogTab = "installed" | "available" | "all"

type VoicesPayload = {
  voice_source: "browser" | "piper"
  browser_voice_uri: string
  piper_voice_id: string
  reply_enabled: boolean
  barge_in_enabled: boolean
  piper: {
    status: {
      binary_ready: boolean
      binary_path: string
      installed_voices: string[]
      selected_voice_installed: boolean
    }
    catalog: PiperVoice[]
  }
}

type WakewordSource = {
  id: string
  label: string
  model_path: string
  phrases: string[]
  installed: boolean
}

type PromptLabLayerKey =
  | "core_safety_prompt"
  | "account_policy_prompt"
  | "admin_prompt"
  | "care_profile_prompt"
  | "character_prompt"
  | "character_custom_prompt"
  | "user_prompt"

const PROMPT_LAB_LAYER_OPTIONS: Array<{ id: PromptLabLayerKey; label: string }> = [
  { id: "core_safety_prompt", label: "Core Safety" },
  { id: "account_policy_prompt", label: "Account Policy" },
  { id: "admin_prompt", label: "Admin Override" },
  { id: "care_profile_prompt", label: "Care Profile" },
  { id: "user_prompt", label: "User Prompt" },
  { id: "character_custom_prompt", label: "Character Custom" },
  { id: "character_prompt", label: "Character" },
]

const PROMPT_EXAMPLES = {
  accountPolicy:
    "Example: Never claim to have completed a real-world action unless a tool or skill confirmed it. Prefer concise household-assistant responses and avoid long preambles.",
  adminOverride:
    "Example: Speak to Jesse in a calm, reassuring tone. Avoid sarcasm. When giving reminders, put the most important action in the first sentence.",
  userPrompt:
    "Example: Call me Jesse. Keep answers short unless I ask for detail. If you suggest plans, include one simple next step.",
  characterCustom:
    "Example: For this character, lean a little more playful and upbeat, but stay grounded and practical when answering questions.",
} as const

type WakewordPayload = {
  enabled: boolean
  model_id: string
  threshold: number
  sources: WakewordSource[]
  status: {
    ready: boolean
    detail: string
    engine_available: boolean
    model_id: string
    source: WakewordSource | null
  }
}

type DebugLogSection = {
  key: string
  label: string
  path: string
  exists: boolean
  lines: string[]
}

type DebugLogsPayload = {
  sections: DebugLogSection[]
}

type ChatStatePayload = {
  chats: ChatSummary[]
  active_chat_id: string
  history: ChatMessage[]
}

const tokenKey = "lokidoki.token"
const currentUserKey = "lokidoki.current_user_id"
const HEALTH_POLL_MS = 15000

function sidebarStateKey(userId: string): string {
  return `lokidoki.sidebar.collapsed.${userId}`
}

function defaultChatTitleFromMessage(message: string): string {
  const cleaned = message.trim().replace(/\s+/g, " ")
  if (!cleaned) {
    return "New chat"
  }
  return cleaned.length > 60 ? `${cleaned.slice(0, 57).trimEnd()}...` : cleaned
}

class RequestError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function fetchJson<T>(url: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new RequestError(payload.detail || "Request failed.", response.status)
  }
  return payload as T
}

function openExternalUrl(url: string) {
  if (!url) {
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

async function streamChat(
  message: string,
  chatId: string,
  token: string,
  performanceProfileId: string,
  handlers: {
    onMeta: (meta: ChatMessage["meta"]) => void
    onDelta: (delta: string) => void
    onDone: (message: ChatMessage) => void
  }
): Promise<void> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message, chat_id: chatId, performance_profile_id: performanceProfileId }),
  })
  if (!response.ok || !response.body) {
    let detail = "Request failed."
    try {
      const payload = await response.json()
      detail = payload.detail || detail
    } catch {
      detail = response.statusText || detail
    }
    throw new Error(detail)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      const event = JSON.parse(trimmed)
      if (event.type === "meta") {
        handlers.onMeta(event.meta)
      } else if (event.type === "delta") {
        handlers.onDelta(String(event.delta || ""))
      } else if (event.type === "done") {
        handlers.onDone(event.message as ChatMessage)
      } else if (event.type === "error") {
        throw new Error(event.detail || "Streaming request failed.")
      }
    }
    if (done) {
      break
    }
  }
}

async function analyzeImage(
  image: PendingImage,
  prompt: string,
  chatId: string,
  token: string
): Promise<ChatMessage> {
  const payload = await fetchJson<{ message: ChatMessage }>(
    "/api/image/analyze",
    {
      method: "POST",
      body: JSON.stringify({
        image_data_url: image.dataUrl,
        prompt,
        filename: image.name,
        chat_id: chatId,
      }),
    },
    token
  )
  return payload.message
}

async function analyzeVideo(video: PendingVideo, prompt: string, chatId: string, token: string): Promise<ChatMessage> {
  const payload = await fetchJson<{ message: ChatMessage }>(
    "/api/video/analyze",
    {
      method: "POST",
      body: JSON.stringify({
        frame_data_urls: video.frameDataUrls,
        prompt,
        filename: video.name,
        chat_id: chatId,
      }),
    },
    token
  )
  return payload.message
}

function skillHealthTone(status: string): string {
  if (status === "ok") {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
  }
  if (status === "error") {
    return "border-rose-400/30 bg-rose-400/10 text-rose-100"
  }
  return "border-amber-400/30 bg-amber-400/10 text-amber-100"
}

function skillHealthLabel(status: string): string {
  if (status === "ok") {
    return "Healthy"
  }
  if (status === "error") {
    return "Needs Attention"
  }
  return "Not Tested"
}

function sortSkills(skills: SkillCatalogEntry[], sortKey: string): SkillCatalogEntry[] {
  const next = [...skills]
  next.sort((left, right) => {
    if (sortKey === "name") {
      return left.title.localeCompare(right.title)
    }
    if (sortKey === "domain") {
      return `${left.domains.join(",")}:${left.title}`.localeCompare(`${right.domains.join(",")}:${right.title}`)
    }
    if (sortKey === "health") {
      const rank = (value: string) => (value === "ok" ? 0 : value === "unknown" ? 1 : 2)
      return rank(left.health_status) - rank(right.health_status) || left.title.localeCompare(right.title)
    }
    if (sortKey === "installed") {
      return Number(Boolean(right.installed)) - Number(Boolean(left.installed)) || left.title.localeCompare(right.title)
    }
    return (
      Number(Boolean(right.system)) - Number(Boolean(left.system))
      || Number(Boolean(right.installed)) - Number(Boolean(left.installed))
      || left.title.localeCompare(right.title)
    )
  })
  return next
}

async function analyzeDocument(document: PendingDocument, prompt: string, chatId: string, token: string): Promise<ChatMessage> {
  const payload = await fetchJson<{ message: ChatMessage }>(
    "/api/document/analyze",
    {
      method: "POST",
      body: JSON.stringify({
        document_text: document.text,
        prompt,
        filename: document.name,
        chat_id: chatId,
      }),
    },
    token
  )
  return payload.message
}

async function runPushToTalkChat(
  audioBase64: string,
  mimeType: string,
  chatId: string,
  token: string
): Promise<{ transcript: string; message: ChatMessage }> {
  return fetchJson<{ transcript: string; message: ChatMessage }>(
    "/api/voice/chat",
    {
      method: "POST",
      body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType, chat_id: chatId, response_style: "brief" }),
    },
    token
  )
}

async function retrySmartChat(assistantIndex: number, chatId: string, token: string): Promise<ChatMessage> {
  const payload = await fetchJson<{ message: ChatMessage }>(
    "/api/chat/retry-smart",
    {
      method: "POST",
      body: JSON.stringify({ assistant_index: assistantIndex, chat_id: chatId }),
    },
    token
  )
  return payload.message
}

function AuthPanel({
  allowSignup,
  authMode,
  authError,
  onSubmit,
  onToggle,
}: {
  allowSignup: boolean
  authMode: "login" | "register"
  authError: string
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onToggle: () => void
}) {
  const passwordAutocomplete = authMode === "login" ? "current-" + "password" : "new-" + "password"

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/45 backdrop-blur-sm">
      <Card className="w-[min(460px,calc(100vw-24px))] border-[var(--line)] bg-[var(--card)]/96 p-6 text-[var(--foreground)] shadow-[var(--shadow-strong)]">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-start gap-3">
            <img alt="LokiDoki logo" className="h-11 w-11 rounded-2xl bg-[var(--panel)] p-1.5" src="/lokidoki-logo.svg" />
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">LokiDoki</p>
              <h2 className="mt-2 text-2xl font-semibold text-[var(--foreground)]">
                {authMode === "login" ? "Sign in" : "Create account"}
              </h2>
            </div>
          </div>
          <div className="rounded-full border border-[var(--line)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted-foreground)]">
            Local auth
          </div>
        </div>
        <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="grid gap-2">
            <label className="text-sm text-[var(--muted-foreground)]">Username</label>
            <Input autoComplete="username" className="border-[var(--line)] bg-[var(--input)] text-[var(--foreground)]" name="username" required />
          </div>
          {authMode === "register" ? (
            <div className="grid gap-2">
              <label className="text-sm text-[var(--muted-foreground)]">Display name</label>
              <Input autoComplete="nickname" className="border-[var(--line)] bg-[var(--input)] text-[var(--foreground)]" name="display_name" required />
            </div>
          ) : null}
          <div className="grid gap-2">
            <label className="text-sm text-[var(--muted-foreground)]">Password</label>
            <Input
              autoComplete={passwordAutocomplete}
              className="border-[var(--line)] bg-[var(--input)] text-[var(--foreground)]"
              name="password"
              type="password"
              required
            />
          </div>
          {authError ? <p className="text-sm text-rose-300">{authError}</p> : null}
          <Button className="w-full rounded-2xl px-4 py-3 text-sm font-semibold" type="submit">
            {authMode === "login" ? "Sign in" : "Create account"}
          </Button>
          {allowSignup ? (
            <Button className="h-auto justify-start px-0 text-sm text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]" onClick={onToggle} type="button" variant="ghost">
              {authMode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
            </Button>
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">Self-signup is disabled for this install.</p>
          )}
        </form>
      </Card>
    </div>
  )
}

function catalogMatchesSearch(search: string, values: Array<string | undefined | null>): boolean {
  const normalized = search.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  return values.some((value) => String(value || "").toLowerCase().includes(normalized))
}

function CatalogLogo({
  label,
  src,
}: {
  label: string
  src?: string
}) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "LK"
  return src ? (
    <img alt={`${label} logo`} className="h-11 w-11 rounded-2xl border border-[var(--line)] bg-[var(--panel)] object-cover" src={src} />
  ) : (
    <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--panel)] text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
      {initials}
    </div>
  )
}

function fallbackCharacterTeaser(character: Pick<CharacterDefinition, "teaser" | "description" | "name">) {
  const teaser = String(character.teaser || "").trim()
  if (teaser) {
    return teaser
  }
  const description = String(character.description || "").trim()
  if (description) {
    return description
  }
  return `${character.name} character`
}

function CatalogTabs({
  activeTab,
  counts,
  onChange,
  tabs,
}: {
  activeTab: CatalogTab
  counts: Record<CatalogTab, number>
  onChange: (tab: CatalogTab) => void
  tabs?: CatalogTab[]
}) {
  const visibleTabs = tabs || ["installed", "available", "all"]
  return (
    <TabsList variant="line">
      {visibleTabs.map((tab) => (
        <TabsTrigger
          active={activeTab === tab}
          key={tab}
          onClick={() => onChange(tab)}
          className="text-xs capitalize"
          variant="line"
        >
          {tab} ({counts[tab]})
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

function voiceMatchesKindFilter(voice: AdminVoiceRecord, kind: string): boolean {
  if (kind === "all") {
    return true
  }
  if (kind === "custom") {
    return Boolean(voice.custom)
  }
  if (kind === "recommended") {
    return Boolean(voice.curated) && !voice.custom
  }
  if (kind === "standard") {
    return !voice.custom && !voice.curated
  }
  return true
}

function sortVoices(voices: AdminVoiceRecord[], sortKey: string): AdminVoiceRecord[] {
  const next = [...voices]
  next.sort((left, right) => {
    if (sortKey === "name") {
      return left.label.localeCompare(right.label)
    }
    if (sortKey === "language") {
      return `${left.language}:${left.label}`.localeCompare(`${right.language}:${right.label}`)
    }
    if (sortKey === "quality") {
      return `${left.quality}:${left.label}`.localeCompare(`${right.quality}:${right.label}`)
    }
    if (sortKey === "installed") {
      return Number(Boolean(right.installed)) - Number(Boolean(left.installed)) || left.label.localeCompare(right.label)
    }
    return (
      Number(Boolean(right.curated)) - Number(Boolean(left.curated))
      || Number(Boolean(right.installed)) - Number(Boolean(left.installed))
      || left.label.localeCompare(right.label)
    )
  })
  return next
}

function regionFlag(languageCode: string): string {
  const region = languageCode.split("_")[1] || ""
  if (!/^[A-Z]{2}$/.test(region)) {
    return ""
  }
  return String.fromCodePoint(...region.split("").map((character) => 127397 + character.charCodeAt(0)))
}

function voiceLocaleLabel(languageCode: string): string {
  if (!languageCode || languageCode === "custom") {
    return "Custom locale"
  }
  try {
    const [language, region] = languageCode.split("_")
    const languageNames = new Intl.DisplayNames(["en"], { type: "language" })
    const regionNames = new Intl.DisplayNames(["en"], { type: "region" })
    const languageLabel = languageNames.of(language) || languageCode
    const regionLabel = region ? regionNames.of(region) || region : ""
    return regionLabel ? `${languageLabel} (${regionLabel})` : languageLabel
  } catch {
    return languageCode
  }
}

function voiceLanguageOptionLabel(languageCode: string): string {
  const flag = regionFlag(languageCode)
  const locale = voiceLocaleLabel(languageCode)
  if (!languageCode || languageCode === "custom") {
    return locale
  }
  return `${flag ? `${flag} ` : ""}${locale} (${languageCode})`
}

function formatVoiceQuality(quality: string): string {
  if (!quality || quality === "custom") {
    return "Custom quality"
  }
  return quality.replace("_", "-")
}

function AdminModal({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean
  title: string
  description: string
  onClose: () => void
  children: ReactNode
}) {
  if (!open) {
    return null
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-[28px] border border-[var(--line)] bg-[var(--card)]/98 shadow-[0_30px_80px_rgba(0,0,0,0.45)]" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--line)] bg-[var(--card)]/95 px-5 py-4 backdrop-blur">
          <div>
            <div className="text-xl font-semibold text-[var(--foreground)]">{title}</div>
            <div className="mt-1 text-sm text-[var(--muted-foreground)]">{description}</div>
          </div>
          <Button className="h-9 w-9 rounded-full p-0" onClick={onClose} type="button" variant="outline">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export default function App() {
  const [activeView, setActiveView] = useState<"assistant" | "settings" | "admin">("assistant")
  const [assistantTab, setAssistantTab] = useState<"chat" | "talk">("chat")
  const [isCharacterVisible, setIsCharacterVisible] = useState(() => localStorage.getItem("ld_character_visible") !== "false")
  const [characterDisplayMode, setCharacterDisplayMode] = useState<"full" | "head" | "fullscreen">(() => (localStorage.getItem("ld_character_mode") as any) || "head")

  useEffect(() => {
    localStorage.setItem("ld_character_visible", String(isCharacterVisible))
  }, [isCharacterVisible])

  useEffect(() => {
    localStorage.setItem("ld_character_mode", characterDisplayMode)
  }, [characterDisplayMode])

  const [bootstrap, setBootstrap] = useState<BootstrapDetails | null>(null)
  const [health, setHealth] = useState<HealthPayload | null>(null)
  const [isHealthOpen, setIsHealthOpen] = useState(false)
  const [isCameraPreviewOpen, setIsCameraPreviewOpen] = useState(false)
  const [token, setToken] = useState<string>(() => localStorage.getItem(tokenKey) || "")
  const [isAuthHydrating, setIsAuthHydrating] = useState<boolean>(() => Boolean(localStorage.getItem(tokenKey)))
  const [user, setUser] = useState<UserRecord | null>(null)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState(() => localStorage.getItem("ld_active_chat_id") || "")
  useEffect(() => {
    localStorage.setItem("ld_active_chat_id", activeChatId)
  }, [activeChatId])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState("")
  const [performanceProfileId, setPerformanceProfileId] = useState("fast")
  const [authMode, setAuthMode] = useState<"login" | "register">("login")
  const [authError, setAuthError] = useState("")
  const [chatError, setChatError] = useState("")
  const [chatSearch, setChatSearch] = useState("")
  const [themePresetId, setThemePresetId] = useState<ThemePresetId>("familiar")
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark")
  const [effectiveThemePresetId, setEffectiveThemePresetId] = useState<ThemePresetId>("familiar")
  const [effectiveThemeMode, setEffectiveThemeMode] = useState<ThemeMode>("dark")
  const [themeLocked, setThemeLocked] = useState(false)
  const [availableThemes, setAvailableThemes] = useState<ThemePresetSummary[]>(fallbackThemePresets)
  const [debugMode, setDebugMode] = useState(false)
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const [debugLogs, setDebugLogs] = useState<DebugLogsPayload | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)
  const [selectedImage, setSelectedImage] = useState<PendingImage | null>(null)
  const [selectedVideo, setSelectedVideo] = useState<PendingVideo | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<PendingDocument | null>(null)
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false)
  const [copiedDebugTarget, setCopiedDebugTarget] = useState("")
  const [debugNow, setDebugNow] = useState(() => Date.now())
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isVoiceListening, setIsVoiceListening] = useState(false)
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null)
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(() => localStorage.getItem("ld_voice_reply_enabled") !== "false")
  const [voiceSource, setVoiceSource] = useState<"browser" | "piper">(() => (localStorage.getItem("ld_voice_source") as any) || "browser")

  useEffect(() => {
    localStorage.setItem("ld_voice_reply_enabled", String(voiceReplyEnabled))
    if (!voiceReplyEnabled) {
      stopSpeaking()
      stopAudioReply()
    }
  }, [voiceReplyEnabled])

  useEffect(() => {
    localStorage.setItem("ld_voice_source", voiceSource)
  }, [voiceSource])

  const [subtitlesEnabled, setSubtitlesEnabled] = useState(() => localStorage.getItem("ld_subtitles_enabled") !== "false")
  useEffect(() => {
    localStorage.setItem("ld_subtitles_enabled", String(subtitlesEnabled))
  }, [subtitlesEnabled])

  const [speakingWordIndex, setSpeakingWordIndex] = useState<number | null>(null)
  const [bargeInEnabled, setBargeInEnabled] = useState(false)
  const [voiceOptions, setVoiceOptions] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("")
  const [selectedPiperVoiceId, setSelectedPiperVoiceId] = useState("en_US-lessac-medium")
  const [piperVoices, setPiperVoices] = useState<PiperVoice[]>([])
  const [piperStatus, setPiperStatus] = useState<VoicesPayload["piper"]["status"] | null>(null)
  const [adminVoices, setAdminVoices] = useState<AdminVoiceRecord[]>([])
  const [adminVoiceCatalogStatus, setAdminVoiceCatalogStatus] = useState<PiperCatalogStatus | null>(null)
  const [customVoiceIdDraft, setCustomVoiceIdDraft] = useState("")
  const [customVoiceLabelDraft, setCustomVoiceLabelDraft] = useState("")
  const [customVoiceUrlDraft, setCustomVoiceUrlDraft] = useState("")
  const [customVoiceConfigUrlDraft, setCustomVoiceConfigUrlDraft] = useState("")
  const [customVoiceModelDataUrlDraft, setCustomVoiceModelDataUrlDraft] = useState("")
  const [customVoiceConfigDataUrlDraft, setCustomVoiceConfigDataUrlDraft] = useState("")
  const [customVoiceModelSourceNameDraft, setCustomVoiceModelSourceNameDraft] = useState("")
  const [customVoiceConfigSourceNameDraft, setCustomVoiceConfigSourceNameDraft] = useState("")
  const [customVoiceDescriptionDraft, setCustomVoiceDescriptionDraft] = useState("")
  const [customVoiceLanguageDraft, setCustomVoiceLanguageDraft] = useState("")
  const [customVoiceQualityDraft, setCustomVoiceQualityDraft] = useState("")
  const [customVoiceGenderDraft, setCustomVoiceGenderDraft] = useState("")
  const [adminVoiceSearch, setAdminVoiceSearch] = useState("")
  const [adminVoiceTab, setAdminVoiceTab] = useState<CatalogTab>("installed")
  const [adminVoiceLanguageFilter, setAdminVoiceLanguageFilter] = useState("all")
  const [adminVoiceQualityFilter, setAdminVoiceQualityFilter] = useState("all")
  const [adminVoiceKindFilter, setAdminVoiceKindFilter] = useState("all")
  const [adminVoiceSort, setAdminVoiceSort] = useState("recommended")
  const [isAdminVoiceModalOpen, setIsAdminVoiceModalOpen] = useState(false)
  const [editingCustomVoiceId, setEditingCustomVoiceId] = useState("")
  const [customVoiceEditorDraft, setCustomVoiceEditorDraft] = useState<CustomVoiceEditorDraft | null>(null)
  const [isRefreshingVoiceCatalog, setIsRefreshingVoiceCatalog] = useState(false)
  const [expandedAdminVoiceDetails, setExpandedAdminVoiceDetails] = useState<Record<string, boolean>>({})
  const [wakewordEnabled, setWakewordEnabled] = useState(false)
  const [wakewordThreshold, setWakewordThreshold] = useState(0.35)
  const [wakewordModelId, setWakewordModelId] = useState("loki_doki")
  const [wakewordSources, setWakewordSources] = useState<WakewordSource[]>([])
  const [wakewordRuntime, setWakewordRuntime] = useState<WakewordPayload["status"] | null>(null)

  // Native Fullscreen Bridge
  useEffect(() => {
    if (characterDisplayMode === "fullscreen" && isCharacterVisible) {
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen().catch(() => {})
      }
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  }, [characterDisplayMode, isCharacterVisible])

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && characterDisplayMode === "fullscreen") {
        setCharacterDisplayMode("head")
      }
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [characterDisplayMode])

  const [wakewordEchoCancellationEnabled, setWakewordEchoCancellationEnabled] = useState(true)
  const [wakewordNoiseSuppressionEnabled, setWakewordNoiseSuppressionEnabled] = useState(true)
  const [wakewordAutoGainControlEnabled, setWakewordAutoGainControlEnabled] = useState(true)
  const [wakewordDebugResult, setWakewordDebugResult] = useState<WakewordDebugResult>({
    status: "idle",
    detail: "Run a short wakeword test and say the phrase once.",
    score: 0,
    startedAtMs: null,
    finishedAtMs: null,
  })
  const [wakewordDebugEvents, setWakewordDebugEvents] = useState<string[]>([])
  const [wakewordTelemetry, setWakewordTelemetry] = useState<WakewordTelemetry>({
    peak: 0,
    rms: 0,
    speechLevel: 0,
    wakewordScore: 0,
  })
  const [characterEnabled, setCharacterEnabled] = useState(true)
  const [activeCharacterId, setActiveCharacterId] = useState(() => localStorage.getItem("ld_active_character_id") || "lokidoki")
  const [assignedCharacterId, setAssignedCharacterId] = useState("")

  useEffect(() => {
    localStorage.setItem("ld_active_character_id", activeCharacterId)
  }, [activeCharacterId])

  const [canSelectCharacter, setCanSelectCharacter] = useState(true)
  const [userPromptText, setUserPromptText] = useState("")
  const [careProfileId, setCareProfileId] = useState("standard")
  const [careProfiles, setCareProfiles] = useState<CareProfile[]>([])
  const [characters, setCharacters] = useState<CharacterDefinition[]>([])
  const [characterCatalogRepository, setCharacterCatalogRepository] = useState<CatalogRepositoryInfo | null>(null)
  const [adminCharacterDrafts, setAdminCharacterDrafts] = useState<Record<string, CharacterEditorDraft>>({})
  const [adminCharacterSearch, setAdminCharacterSearch] = useState("")
  const [adminCharacterTab, setAdminCharacterTab] = useState<CatalogTab>("installed")
  const [isCharacterEditorOpen, setIsCharacterEditorOpen] = useState(false)
  const [characterEditorUrl, setCharacterEditorUrl] = useState(getCharacterEditorBaseUrl())
  const characterImportInputRef = useRef<HTMLInputElement | null>(null)
  const [characterCustomizations, setCharacterCustomizations] = useState<Record<string, string>>({})
  const [savedCharacterCustomizations, setSavedCharacterCustomizations] = useState<Record<string, string>>({})
  const characterSettingsLoadedRef = useRef(false)
  const [characterStatus, setCharacterStatus] = useState("")
  const [savedUserPromptText, setSavedUserPromptText] = useState("")
  const [adminAccount, setAdminAccount] = useState<AdminAccountPayload | null>(null)
  const [adminPromptPolicy, setAdminPromptPolicy] = useState<PromptPolicyPayload | null>(null)
  const [adminCareProfiles, setAdminCareProfiles] = useState<CareProfile[]>([])
  const [adminRuntimeMetrics, setAdminRuntimeMetrics] = useState<RuntimeMetricsPayload | null>(null)
  const [careProfileDraft, setCareProfileDraft] = useState<CareProfile>({
    id: "custom",
    label: "Custom",
    tone: "",
    vocabulary: "standard",
    sentence_length: "medium",
    response_style: "balanced",
    blocked_topics: [],
    safe_messaging: true,
    max_response_tokens: 160,
    builtin: false,
  })
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([])
  const [skillCatalogRepository, setSkillCatalogRepository] = useState<CatalogRepositoryInfo | null>(null)
  const [skillContextDrafts, setSkillContextDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const [skillAccountContextDrafts, setSkillAccountContextDrafts] = useState<Record<string, Record<string, Record<string, unknown>>>>({})
  const [skillNewAccountLabels, setSkillNewAccountLabels] = useState<Record<string, string>>({})
  const [skillNewAccountDefaults, setSkillNewAccountDefaults] = useState<Record<string, boolean>>({})
  const [skillContextStatusBySkill, setSkillContextStatusBySkill] = useState<Record<string, string>>({})
  const [skillProbe, setSkillProbe] = useState("what's the weather in Milford, CT today")
  const [skillRouteDecision, setSkillRouteDecision] = useState<SkillRouteDecision | null>(null)
  const [isSkillMutationPending, setIsSkillMutationPending] = useState(false)
  const [testingSkillAccountId, setTestingSkillAccountId] = useState("")
  const [isSkillInspectPending, setIsSkillInspectPending] = useState(false)
  const [isSkillTestPending, setIsSkillTestPending] = useState(false)
  const [savingSkillId, setSavingSkillId] = useState("")
  const [profileDisplayNameDraft, setProfileDisplayNameDraft] = useState("")
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState("")
  const [newPasswordDraft, setNewPasswordDraft] = useState("")
  const [profileStatus, setProfileStatus] = useState("")
  const [adminUserCharacterDrafts, setAdminUserCharacterDrafts] = useState<Record<string, { care_profile_id: string; character_enabled: boolean; assigned_character_id: string; can_select_character: boolean; admin_prompt: string }>>({})
  const [adminUserThemeDrafts, setAdminUserThemeDrafts] = useState<Record<string, { theme_admin_override_enabled: boolean; theme_admin_override_preset_id: ThemePresetId; theme_admin_override_mode: ThemeMode }>>({})
  const [settingsRecognitionTab, setSettingsRecognitionTab] = useState<"facial" | "vocal">("facial")
  const [activeSettingsSection, setActiveSettingsSection] = useState<"general" | "recognition" | "appearance" | "voice" | "wakeword" | "memory">("general")
  const [activeAdminSection, setActiveAdminSection] = useState<"dashboard" | "general" | "users" | "care_profiles" | "prompt_lab" | "voices" | "skills" | "characters">("dashboard")
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    const storedUserId = localStorage.getItem(currentUserKey)
    return storedUserId ? localStorage.getItem(sidebarStateKey(storedUserId)) === "1" : false
  })
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const [isCharacterMenuOpen, setIsCharacterMenuOpen] = useState(false)
  const [isCharacterSyncPending, setIsCharacterSyncPending] = useState(false)
  const [pendingCharacterName, setPendingCharacterName] = useState("")
  const [openChatMenuId, setOpenChatMenuId] = useState("")
  const [chatMenuAnchor, setChatMenuAnchor] = useState<"header" | "sidebar">("header")
  const [renamingChatId, setRenamingChatId] = useState("")
  const [renameChatTitle, setRenameChatTitle] = useState("")
  const [adminUsers, setAdminUsers] = useState<AdminUserRecord[]>([])
  const [adminUserSearch, setAdminUserSearch] = useState("")
  const [adminSkillSearch, setAdminSkillSearch] = useState("")
  const [adminSkillTab, setAdminSkillTab] = useState<"catalog" | "test">("catalog")
  const [adminSkillCatalogTab, setAdminSkillCatalogTab] = useState<CatalogTab>("installed")
  const [adminSkillDomainFilter, setAdminSkillDomainFilter] = useState("all")
  const [adminSkillHealthFilter, setAdminSkillHealthFilter] = useState("all")
  const [adminSkillKindFilter, setAdminSkillKindFilter] = useState("all")
  const [adminSkillSort, setAdminSkillSort] = useState("recommended")
  const [isAdminSkillModalOpen, setIsAdminSkillModalOpen] = useState(false)
  const [isRefreshingSkills, setIsRefreshingSkills] = useState(false)
  const [expandedSkillDetails, setExpandedSkillDetails] = useState<Record<string, boolean>>({})
  const [userPasswordDrafts, setUserPasswordDrafts] = useState<Record<string, string>>({})
  const [adminNotice, setAdminNotice] = useState("")
  const [skillTestResult, setSkillTestResult] = useState<SkillTestPayload | null>(null)
  const [skillTestError, setSkillTestError] = useState("")
  const [promptLabUserId, setPromptLabUserId] = useState("")
  const [promptLabMessage, setPromptLabMessage] = useState("Explain today's plan and tell me if I have anything weather-related to know.")
  const [promptLabUseSkills, setPromptLabUseSkills] = useState(true)
  const [promptLabLayers, setPromptLabLayers] = useState<Record<PromptLabLayerKey, boolean>>({
    core_safety_prompt: true,
    account_policy_prompt: true,
    admin_prompt: true,
    care_profile_prompt: true,
    character_prompt: true,
    character_custom_prompt: true,
    user_prompt: true,
  })
  const [promptLabLayerDrafts, setPromptLabLayerDrafts] = useState<Record<PromptLabLayerKey, string>>({
    core_safety_prompt: "",
    account_policy_prompt: "",
    admin_prompt: "",
    care_profile_prompt: "",
    character_prompt: "",
    character_custom_prompt: "",
    user_prompt: "",
  })
  const [promptLabDraftsLoaded, setPromptLabDraftsLoaded] = useState(false)
  const [promptLabResult, setPromptLabResult] = useState<PromptLabPayload | null>(null)
  const [promptLabCompilePreview, setPromptLabCompilePreview] = useState<PromptLabCompilePayload | null>(null)
  const [promptLabError, setPromptLabError] = useState("")
  const [isPromptLabPending, setIsPromptLabPending] = useState(false)
  const [isWakewordMonitoring, setIsWakewordMonitoring] = useState(false)
  const [isInstallingVoice, setIsInstallingVoice] = useState(false)
  const [isPreviewingVoice, setIsPreviewingVoice] = useState(false)
  const [previewingAdminVoiceId, setPreviewingAdminVoiceId] = useState("")
  const [isVoiceReplyPending, setIsVoiceReplyPending] = useState(false)
  const [pendingSpeechMessageKey, setPendingSpeechMessageKey] = useState("")
  const [speakingMessageKey, setSpeakingMessageKey] = useState("")
  const [isBargeInCapturing, setIsBargeInCapturing] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState("")
  const [voiceTelemetry, setVoiceTelemetry] = useState<VoiceTelemetry>({
    pipelineStatus: "idle",
    currentViseme: "closed",
    requestedAtMs: null,
    firstChunkAtMs: null,
    playbackStartAtMs: null,
    completedAtMs: null,
  })
  const [vadTelemetry, setVadTelemetry] = useState<VADTelemetry>({
    isSpeaking: false,
    speechFrames: 0,
    silenceFrames: 0,
    capturing: false,
    rms: 0,
    peak: 0,
  })
  const [retryingAssistantIndex, setRetryingAssistantIndex] = useState(-1)
  const messageViewportRef = useRef<HTMLDivElement | null>(null)
  const rightPaneScrollRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const documentInputRef = useRef<HTMLInputElement | null>(null)
  const forceScrollRef = useRef(true)
  const recognizerRef = useRef<ReturnType<typeof createPushToTalkRecognizer> | null>(null)
  const recorderRef = useRef<ReturnType<typeof createPushToTalkRecorder> | null>(null)
  const wakewordMonitorRef = useRef<ReturnType<typeof createWakewordMonitor> | null>(null)
  const wakewordDebugMonitorRef = useRef<ReturnType<typeof createWakewordMonitor> | null>(null)
  const wakewordDebugTimeoutRef = useRef<number | null>(null)
  const bargeInMonitorRef = useRef<ReturnType<typeof createBargeInMonitor> | null>(null)
  const lastSpokenMessageRef = useRef("")
  const suppressAutoVoiceReplyRef = useRef(false)
  const audioReplyRef = useRef<HTMLAudioElement | null>(null)
  const audioReplyUrlRef = useRef<string>("")
  const voicePipelineRef = useRef<VoicePipeline | null>(null)
  const speechRequestRef = useRef<number>(0)
  const speechAbortRef = useRef<AbortController | null>(null)
  const voiceRequestStartedAtRef = useRef<number | null>(null)
  const liveTranscriptionRequestRef = useRef(0)
  const liveTranscriptionAppliedRef = useRef(0)
  const wakewordDetectInFlightRef = useRef(false)
  const wakewordCaptureInFlightRef = useRef(false)
  const bargeInCaptureInFlightRef = useRef(false)

  useEffect(() => {
    const allowedOrigins = new Set([window.location.origin])

    const handleCharacterEditorMessage = (event: MessageEvent) => {
      if (!allowedOrigins.has(event.origin)) {
        return
      }
      const payload = event.data as { source?: string; type?: string; action?: "save" | "publish"; bundle?: CharacterEditorBundle } | null
      if (!payload || payload.source !== "loki-doki-character-editor" || payload.type !== "character-editor-action" || !payload.bundle) {
        return
      }
      void importCharacterEditorBundle(payload.bundle, payload.action === "publish")
    }

    window.addEventListener("message", handleCharacterEditorMessage)
    return () => window.removeEventListener("message", handleCharacterEditorMessage)
  }, [token, user, characters, adminCharacterDrafts])

  useEffect(() => {
    applyThemeAttributes(effectiveThemePresetId, effectiveThemeMode)
  }, [effectiveThemeMode, effectiveThemePresetId])

  useEffect(() => {
    if (effectiveThemeMode !== "auto") {
      return
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const syncSystemTheme = () => applyThemeAttributes(effectiveThemePresetId, "auto")
    syncSystemTheme()
    media.addEventListener("change", syncSystemTheme)
    return () => media.removeEventListener("change", syncSystemTheme)
  }, [effectiveThemeMode, effectiveThemePresetId])

  useEffect(() => {
    if (!isCharacterEditorOpen) {
      return
    }
    try {
      const url = new URL(characterEditorUrl, typeof window !== "undefined" ? window.location.origin : "http://localhost")
      url.searchParams.set("theme_preset", effectiveThemePresetId)
      url.searchParams.set("theme_mode", effectiveThemeMode)
      const nextUrl = `${url.pathname}${url.search}`
      if (nextUrl !== characterEditorUrl) {
        setCharacterEditorUrl(nextUrl)
      }
    } catch {
      // Ignore malformed interim editor URLs and keep the current value.
    }
  }, [characterEditorUrl, effectiveThemeMode, effectiveThemePresetId, isCharacterEditorOpen])

  const suggestions = [
    "Build a Raspberry Pi assistant",
    "Summarize the local system status",
    "Help me wire push-to-talk voice",
    "Analyze an image I upload",
  ]
  const settingsSections: Array<{ id: "general" | "recognition" | "appearance" | "voice" | "wakeword" | "memory"; label: string; detail: string }> = [
    { id: "general", label: "General", detail: "Profile, account, and character defaults" },
    { id: "recognition", label: "Recognition", detail: "Facial and future vocal enrollment" },
    { id: "memory", label: "Memory", detail: "Inspect active chat, personal, and household memory" },
    { id: "appearance", label: "Appearance", detail: "Theme and debug tools" },
    { id: "voice", label: "Voice", detail: "Reply voice and preview" },
    { id: "wakeword", label: "Wakeword", detail: "Hands-free listening" },
  ]
  const adminSections: Array<{ id: "dashboard" | "general" | "users" | "care_profiles" | "prompt_lab" | "voices" | "skills" | "characters"; label: string; detail: string }> = [
    { id: "dashboard", label: "Dashboard", detail: "Nodes, users, and live system usage" },
    { id: "general", label: "General", detail: "Install defaults and prompt policy" },
    { id: "users", label: "Users", detail: "Accounts, access, care profiles, and passwords" },
    { id: "care_profiles", label: "Care Profiles", detail: "Create, inspect, and edit response profiles" },
    { id: "prompt_lab", label: "Prompt Lab", detail: "Test prompts as users and inspect orchestration" },
    { id: "voices", label: "Voices", detail: "Installed Piper voices, usage, and custom sources" },
    { id: "characters", label: "Characters", detail: "Character catalog and availability" },
    { id: "skills", label: "Skills", detail: "Installs, routing, and configuration" },
  ]

  const overviewRows = [
    { label: "Fast model", value: bootstrap?.models.llm_fast || "Loading…" },
    { label: "Thinking model", value: bootstrap?.models.llm_thinking || "Loading…" },
    { label: "Function model", value: bootstrap?.models.function_model || "Loading…" },
    { label: "Vision model", value: bootstrap?.models.vision_model || "Loading…" },
    { label: "Image Gen", value: bootstrap?.models.image_gen_model || "Loading…" },
    { label: "STT", value: bootstrap?.models.stt_model || "Loading…" },
    { label: "TTS", value: bootstrap?.models.tts_voice || "Loading…" },
  ]
  const activeChat = chats.find((chat) => chat.id === activeChatId) || null
  const filteredChats = chats.filter((chat) => chat.title.toLowerCase().includes(chatSearch.trim().toLowerCase()))

  async function refreshHealth() {
    try {
      const payload = await fetchJson<HealthPayload>("/api/health")
      const filteredCapabilities =
        payload.profile === "pi_hailo"
          ? payload.capabilities
          : payload.capabilities.filter((item) => !item.key.startsWith("hailo_"))
      setHealth({ ...payload, capabilities: filteredCapabilities })
    } catch {
      setHealth(null)
    }
  }

  async function transcribePushToTalk(activeToken: string, audioBase64: string, mimeType: string): Promise<string> {
    const payload = await fetchJson<{ transcript: string }>(
      "/api/voice/transcribe",
      {
        method: "POST",
        body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType }),
      },
      activeToken
    )
    return payload.transcript
  }

  async function refreshVoices(activeToken: string) {
    const payload = await fetchJson<VoicesPayload>("/api/voices", {}, activeToken)
    setVoiceReplyEnabled(payload.reply_enabled)
    setVoiceSource(payload.voice_source)
    setSelectedVoiceURI(payload.browser_voice_uri)
    setSelectedPiperVoiceId(payload.piper_voice_id)
    setBargeInEnabled(payload.barge_in_enabled)
    setPiperVoices(payload.piper.catalog)
    setPiperStatus(payload.piper.status)
  }

  async function refreshWakeword(activeToken: string) {
    const payload = await fetchJson<WakewordPayload>("/api/wakeword", {}, activeToken)
    setWakewordEnabled(payload.enabled)
    setWakewordModelId(payload.model_id)
    setWakewordSources(payload.sources)
    setWakewordRuntime(payload.status)
  }

  async function createChat(activeToken: string) {
    stopSpeaking()
    stopAudioReply()
    setVoiceStatus("")
    const payload = await fetchJson<ChatStatePayload & { chat: ChatSummary }>(
      "/api/chats",
      { method: "POST", body: JSON.stringify({}) },
      activeToken
    )
    forceScrollRef.current = true
    setChats(payload.chats)
    setActiveChatId(payload.active_chat_id)
    setMessages(payload.history)
    markLatestAssistantAsSeen(payload.history)
    setPrompt("")
    setChatSearch("")
    setChatError("")
    setOpenChatMenuId("")
    setRenamingChatId("")
    setIsMobileSidebarOpen(false)
    setActiveView("assistant")
    setAssistantTab("chat")
  }

  async function selectChat(chatId: string, activeToken: string) {
    stopSpeaking()
    stopAudioReply()
    setVoiceStatus("")
    if (!chatId || chatId === activeChatId) {
      setIsMobileSidebarOpen(false)
      return
    }
    const payload = await fetchJson<ChatStatePayload>(`/api/chats/${chatId}/select`, { method: "POST" }, activeToken)
    forceScrollRef.current = true
    setChats(payload.chats)
    setActiveChatId(payload.active_chat_id)
    setMessages(payload.history)
    markLatestAssistantAsSeen(payload.history)
    setPrompt("")
    setChatError("")
    setOpenChatMenuId("")
    setRenamingChatId("")
    setIsMobileSidebarOpen(false)
    setActiveView("assistant")
    setAssistantTab("chat")
  }

  async function renameChat(chatId: string, title: string, activeToken: string) {
    const payload = await fetchJson<ChatStatePayload & { chat: ChatSummary }>(
      `/api/chats/${chatId}`,
      { method: "PATCH", body: JSON.stringify({ title }) },
      activeToken
    )
    setChats(payload.chats)
    setActiveChatId(payload.active_chat_id)
    setMessages(payload.history)
    markLatestAssistantAsSeen(payload.history)
    setOpenChatMenuId("")
    setRenamingChatId("")
  }

  async function deleteChat(chatId: string, activeToken: string) {
    stopSpeaking()
    stopAudioReply()
    setVoiceStatus("")
    const payload = await fetchJson<ChatStatePayload>(
      `/api/chats/${chatId}`,
      { method: "DELETE" },
      activeToken
    )
    forceScrollRef.current = true
    setChats(payload.chats)
    setActiveChatId(payload.active_chat_id)
    setMessages(payload.history)
    markLatestAssistantAsSeen(payload.history)
    setOpenChatMenuId("")
    setRenamingChatId("")
    setPrompt("")
    setChatError("")
  }

  function syncActiveChatFromHistory(history: ChatMessage[]) {
    if (!activeChatId) {
      return
    }
    const firstUserMessage = history.find((message) => message.role === "user" && message.content.trim())?.content || ""
    setChats((current) => {
      const active = current.find((chat) => chat.id === activeChatId)
      if (!active) {
        return current
      }
      const nextTitle =
        active.title === "New chat" && firstUserMessage
          ? defaultChatTitleFromMessage(firstUserMessage)
          : active.title
      const updated = {
        ...active,
        title: nextTitle,
        message_count: history.length,
        last_message_at: new Date().toISOString(),
      }
      return [updated, ...current.filter((chat) => chat.id !== activeChatId)]
    })
  }

  function markLatestAssistantAsSeen(history: ChatMessage[]) {
    const latestAssistantIndex = [...history]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find((entry) => entry.message.role === "assistant" && !entry.message.pending)?.index
    lastSpokenMessageRef.current =
      latestAssistantIndex === undefined ? "" : speechMessageKey(history[latestAssistantIndex], latestAssistantIndex)
  }

  async function refreshSkills(activeToken: string) {
    const payload = await fetchJson<SkillsPayload>("/api/skills", {}, activeToken)
    setInstalledSkills(payload.installed)
    setAvailableSkills(payload.available)
    setSkillCatalogRepository(payload.repository)
    setSkillContextDrafts(
      payload.installed.reduce<Record<string, Record<string, unknown>>>((accumulator, skill) => {
        accumulator[skill.skill_id] = { ...skill.shared_context }
        return accumulator
      }, {})
    )
    setSkillAccountContextDrafts(
      payload.installed.reduce<Record<string, Record<string, Record<string, unknown>>>>((accumulator, skill) => {
        accumulator[skill.skill_id] = skill.accounts.reduce<Record<string, Record<string, unknown>>>((accountAccumulator, account) => {
          accountAccumulator[account.id] = { ...account.context }
          return accountAccumulator
        }, {})
        return accumulator
      }, {})
    )
  }

  async function updateAllSkills() {
    if (!token) return
    setIsRefreshingSkills(true)
    try {
      const payload = await fetchJson<SkillsPayload>("/api/skills/update", { method: "POST" }, token)
      setInstalledSkills(payload.installed)
      setAdminNotice(`Successfully updated ${payload.updated_count || 0} skills.`)
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Skill updates failed.")
    } finally {
      setIsRefreshingSkills(false)
    }
  }

  async function updateSkill(skillId: string) {
    if (!token) return
    setIsRefreshingSkills(true)
    try {
      await fetchJson(`/api/skills/${skillId}/update`, { method: "POST" }, token)
      await refreshSkills(token)
      setAdminNotice("Skill updated.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Skill update failed.")
    } finally {
      setIsRefreshingSkills(false)
    }
  }

  async function refreshAdminUsers(activeToken: string) {
    const payload = await fetchJson<AdminUsersPayload>("/api/admin/users", {}, activeToken)
    setAdminUsers(payload.users)
    setPromptLabUserId((current) => {
      if (current && payload.users.some((item) => item.id === current)) {
        return current
      }
      return payload.users[0]?.id || ""
    })
    setAdminUserCharacterDrafts((current) => {
      const next = { ...current }
      for (const item of payload.users) {
        next[item.id] = {
          care_profile_id: item.care_profile_id || "standard",
          character_enabled: item.character_enabled,
          assigned_character_id: item.assigned_character_id || "",
          can_select_character: item.can_select_character,
          admin_prompt: item.admin_prompt || "",
        }
      }
      return next
    })
    setAdminUserThemeDrafts((current) => {
      const next = { ...current }
      for (const item of payload.users) {
        next[item.id] = {
          theme_admin_override_enabled: item.theme_admin_override_enabled,
          theme_admin_override_preset_id: item.theme_admin_override_preset_id,
          theme_admin_override_mode: item.theme_admin_override_mode,
        }
      }
      return next
    })
  }

  async function refreshCharacterSettings(activeToken: string) {
    const payload = await fetchJson<SettingsPayload>("/api/settings/character", {}, activeToken)
    setCharacterEnabled(payload.character_enabled)
    setActiveCharacterId(payload.active_character_id)
    setAssignedCharacterId(payload.assigned_character_id)
    setCanSelectCharacter(payload.can_select_character)
    setUserPromptText(payload.user_prompt)
    setSavedUserPromptText(payload.user_prompt)
    setCareProfileId(payload.care_profile_id)
    setCareProfiles(payload.care_profiles)
    setCharacters(payload.characters)
    setAdminCharacterDrafts(() => {
      const next: Record<string, CharacterEditorDraft> = {}
      for (const character of payload.characters) {
        next[character.id] = buildCharacterEditorDraft(character)
      }
      return next
    })
    setCharacterCustomizations(payload.character_customizations)
    setSavedCharacterCustomizations(payload.character_customizations)
    characterSettingsLoadedRef.current = true
  }

  async function refreshAdminCharacterData(activeToken: string) {
    const [account, promptPolicy, profiles, characterCatalog] = await Promise.all([
      fetchJson<AdminAccountPayload>("/api/admin/account", {}, activeToken),
      fetchJson<PromptPolicyPayload>("/api/admin/prompt-policy", {}, activeToken),
      fetchJson<{ profiles: CareProfile[] }>("/api/admin/care-profiles", {}, activeToken),
      fetchJson<{ installed: CharacterDefinition[]; available: CharacterDefinition[]; repository: CatalogRepositoryInfo }>("/api/characters", {}, activeToken),
    ])
    setAdminAccount(account)
    setAdminPromptPolicy(promptPolicy)
    setAdminCareProfiles(profiles.profiles)
    setCareProfileDraft((current) => current.id === "custom" && profiles.profiles.length > 0 ? profiles.profiles[0] : current)
    setCharacters(characterCatalog.available)
    setCharacterCatalogRepository(characterCatalog.repository)
    setAdminCharacterDrafts(() => {
      const next: Record<string, CharacterEditorDraft> = {}
      for (const character of characterCatalog.available) {
        next[character.id] = buildCharacterEditorDraft(character)
      }
      return next
    })
  }

  async function refreshAdminVoices(activeToken: string) {
    const payload = await fetchJson<{ voices: AdminVoiceRecord[]; catalog_status: PiperCatalogStatus }>("/api/admin/voices", {}, activeToken)
    setAdminVoices(payload.voices)
    setAdminVoiceCatalogStatus(payload.catalog_status)
  }

  async function refreshAdminRuntimeMetrics(activeToken: string) {
    const payload = await fetchJson<RuntimeMetricsPayload>("/api/admin/runtime-metrics", {}, activeToken)
    setAdminRuntimeMetrics(payload)
  }

  async function warmSelectedVoice(activeToken: string): Promise<void> {
    await fetchJson("/api/voices/warm", { method: "POST" }, activeToken)
  }

  function speechMessageKey(message: ChatMessage, index: number): string {
    const turnId = String(message.meta?.turn_id || "").trim()
    if (turnId) {
      return turnId
    }
    return `${index}:${message.role}:${message.content}`
  }

  function speakableMessageText(message: ChatMessage): string {
    const preferred = String(message.meta?.voice_summary || "").trim()
    if (preferred) {
      return preferred
    }
    return message.content
  }

  function openChatMenu(chatId: string, anchor: "header" | "sidebar") {
    const isSameMenu = openChatMenuId === chatId && chatMenuAnchor === anchor
    setChatMenuAnchor(anchor)
    setOpenChatMenuId(isSameMenu ? "" : chatId)
  }

  function beginRenamingChat(chat: ChatSummary | null) {
    if (!chat) {
      return
    }
    setIsSidebarCollapsed(false)
    setIsMobileSidebarOpen(true)
    setRenamingChatId(chat.id)
    setRenameChatTitle(chat.title)
    setOpenChatMenuId("")
  }

  function formatSeconds(milliseconds: number): string {
    return `${(milliseconds / 1000).toFixed(2)}s`
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B"
    }
    const units = ["B", "KB", "MB", "GB", "TB"]
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    const fractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1
    return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
  }

  function metricBarWidth(percent: number): string {
    const clamped = Math.max(0, Math.min(percent, 100))
    return `${clamped}%`
  }

  function promptLabBottleneck(result: PromptLabPayload): { label: string; durationMs: number } {
    const entries = [
      { label: "Prompt compile", durationMs: result.timings.context_build_ms },
      { label: "Skill route", durationMs: result.timings.skill_route_ms },
      { label: "Skill execute", durationMs: result.timings.skill_execute_ms },
      { label: "Final render", durationMs: result.timings.render_ms },
    ]
    return entries.reduce((current, item) => (item.durationMs > current.durationMs ? item : current), entries[0])
  }

  function togglePromptLabLayer(layer: PromptLabLayerKey) {
    setPromptLabLayers((current) => ({ ...current, [layer]: !current[layer] }))
  }

  async function refreshPromptLabCompilePreview(nextUserId?: string) {
    const userId = nextUserId || promptLabUserId
    if (!token || !userId) {
      setPromptLabCompilePreview(null)
      return
    }
    const layerOverrides = promptLabDraftsLoaded ? promptLabLayerDrafts : {}
    const payload = await fetchJson<PromptLabCompilePayload>(
      "/api/admin/prompt-lab/compile",
      {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          enabled_layers: promptLabLayers,
          layer_overrides: layerOverrides,
        }),
      },
      token
    )
    setPromptLabCompilePreview(payload)
    setPromptLabLayerDrafts(payload.layers)
    setPromptLabDraftsLoaded(true)
  }

  async function refreshPromptLabAfterPromptChange(targetUserId?: string) {
    const userId = targetUserId || promptLabUserId
    if (!token || !userId) {
      return
    }
    try {
      await refreshPromptLabCompilePreview(userId)
    } catch {
      setPromptLabCompilePreview(null)
      setPromptLabDraftsLoaded(false)
    }
  }

  function promptLabPreviewMessage(result: PromptLabPayload): ChatMessage {
    const skillResult = result.skill_execution?.result || {}
    return {
      role: "assistant",
      content: result.response.text,
      debug: {
        durationMs: result.elapsed_ms,
      },
      meta: {
        request_type: result.route.request_type,
        route: result.route.route,
        reason: result.route.reason,
        execution: result.execution,
        skill_result:
          typeof skillResult.skill === "string" && typeof skillResult.action === "string"
            ? { skill: skillResult.skill, action: skillResult.action }
            : undefined,
        rendered_response: {
          summary: result.response.summary,
          metadata: result.response.metadata,
        },
        prompt_debug: {
          prompt_hash: result.prompt_debug.prompt_hash,
          cache_hit: result.prompt_debug.cache_hit,
          character_id: result.prompt_debug.character_id,
          care_profile_id: result.prompt_debug.care_profile_id,
        },
      },
    }
  }

  function interruptCurrentVoiceReply(statusMessage = "Interrupted.") {
    stopSpeaking()
    stopAudioReply()
    setVoiceStatus(statusMessage)
  }

  function ensureAudioReplyElement(): HTMLAudioElement {
    if (audioReplyRef.current) {
      return audioReplyRef.current
    }
    const audio = new Audio()
    audio.autoplay = false
    audio.preload = "auto"
    ;(audio as any).playsInline = true
    audio.onended = () => {
      setIsVoiceReplyPending(false)
      setPendingSpeechMessageKey("")
      setSpeakingMessageKey("")
      setVoiceStatus("Voice reply complete.")
      if (audioReplyUrlRef.current) {
        URL.revokeObjectURL(audioReplyUrlRef.current)
        audioReplyUrlRef.current = ""
      }
      audio.removeAttribute("src")
    }
    audioReplyRef.current = audio
    return audio
  }

  async function primePiperPlayback(): Promise<void> {
    await voicePipelineRef.current?.prepare()
  }

  function stopAudioReply(abandonRequest = true, clearSpeechState = true) {
    if (abandonRequest) {
      speechAbortRef.current?.abort()
      speechAbortRef.current = null
      speechRequestRef.current += 1
    }
    setIsVoiceReplyPending(false)
    if (clearSpeechState) {
      setPendingSpeechMessageKey("")
      setSpeakingMessageKey("")
    }
    if (audioReplyRef.current) {
      audioReplyRef.current.pause()
      audioReplyRef.current.removeAttribute("src")
      audioReplyRef.current.load()
    }
    if (audioReplyUrlRef.current) {
      URL.revokeObjectURL(audioReplyUrlRef.current)
      audioReplyUrlRef.current = ""
    }
    voicePipelineRef.current?.stopSpeech()
  }

  useEffect(() => {
    voicePipelineRef.current = new VoicePipeline({
      onVisemeChange: (viseme) => {
        window.dispatchEvent(new CustomEvent("viseme", { detail: viseme }))
        setVoiceTelemetry((current) => ({ ...current, currentViseme: viseme }))
      },
      onStatusChange: (status) => {
        setVoiceTelemetry((current) => ({ ...current, pipelineStatus: status }))
      },
      onFirstChunk: () => {
        setVoiceTelemetry((current) => ({
          ...current,
          firstChunkAtMs: current.firstChunkAtMs ?? performance.now(),
        }))
      },
      onPlaybackStart: () => {
        setVoiceTelemetry((current) => ({
          ...current,
          playbackStartAtMs: current.playbackStartAtMs ?? performance.now(),
        }))
      },
      onSpeechStart: () => {
        setPendingSpeechMessageKey("")
        setIsVoiceReplyPending(true)
      },
      onSpeechEnd: () => {
        setIsVoiceReplyPending(false)
        setPendingSpeechMessageKey("")
        setSpeakingMessageKey("")
        setVoiceStatus("Voice reply complete.")
        setVoiceTelemetry((current) => ({
          ...current,
          completedAtMs: performance.now(),
        }))
      },
      onError: (message) => {
        setIsVoiceReplyPending(false)
        setPendingSpeechMessageKey("")
        setSpeakingMessageKey("")
        setVoiceStatus(message)
      },
    })
    return () => {
      void voicePipelineRef.current?.destroy()
    }
  }, []);

  useEffect(() => {
    const handleVAD = (event: Event) => {
      const detail = (event as CustomEvent<VADTelemetry>).detail
      if (!detail) {
        return
      }
      setVadTelemetry(detail)
    }
    window.addEventListener("voice-vad", handleVAD as EventListener)
    return () => window.removeEventListener("voice-vad", handleVAD as EventListener)
  }, [])

  async function speakWithPiper(
    text: string,
    messageKey?: string,
    requestId?: number,
    signal?: AbortSignal,
    voiceId?: string
  ): Promise<"played" | "blocked"> {
    if (!token) {
      return "blocked";
    }
    stopSpeaking();
    stopAudioReply(false, false);
    setIsVoiceReplyPending(true);
    setVoiceStatus("Streaming speech...");
    setSpeakingMessageKey(messageKey || "");
    voiceRequestStartedAtRef.current = performance.now()
    setVoiceTelemetry({
      pipelineStatus: "connecting",
      currentViseme: "closed",
      requestedAtMs: voiceRequestStartedAtRef.current,
      firstChunkAtMs: null,
      playbackStartAtMs: null,
      completedAtMs: null,
    })

    if (!voicePipelineRef.current) return "blocked";

    try {
      await voicePipelineRef.current.startSpeech({
        text,
        token,
        voiceId,
        signal,
      })
      return "played";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setIsVoiceReplyPending(false);
        setSpeakingMessageKey("");
        return "blocked";
      }
      setIsVoiceReplyPending(false);
      setSpeakingMessageKey("");
      setVoiceStatus(error instanceof Error ? error.message : "Piper streaming failed.");
      return "blocked";
    }
  }

  async function replayAssistantVoice(message: ChatMessage): Promise<"played" | "blocked" | "browser"> {
    const spokenText = prepareSpeechText(speakableMessageText(message))
    if (!spokenText) {
      setVoiceStatus("Nothing speakable was found in this response.")
      return "blocked"
    }
    setVoiceStatus("")
    await primeAudioPlayback()
    await primePiperPlayback()
    if (voiceSource === "browser") {
      stopAudioReply(false, false)
      setIsVoiceReplyPending(true)
      speakText(spokenText, selectedVoiceURI, {
        onStart: () => {
          window.dispatchEvent(new CustomEvent("viseme", { detail: "open" }))
        },
        onEnd: () => {
          setIsVoiceReplyPending(false)
          window.dispatchEvent(new CustomEvent("viseme", { detail: "closed" }))
        },
        onError: () => {
          setIsVoiceReplyPending(false)
          window.dispatchEvent(new CustomEvent("viseme", { detail: "closed" }))
        }
      })
      return "browser"
    }
    return speakWithPiper(spokenText)
  }

  function activeCharacterPiperVoiceId(): string {
    if (!characterEnabled) {
      return ""
    }
    const activeCharacter = characters.find((character) => character.id === activeCharacterId) || null
    return String(activeCharacter?.default_voice || "").trim()
  }

  async function runRecordedVoiceTurn(
    activeToken: string,
    audioBase64: string,
    mimeType: string,
    listeningStatus: string,
    failedStatus: string
  ) {
    const startedAtMs = Date.now()
    const createdAt = new Date(startedAtMs).toISOString()
    const pendingAssistantMessage: ChatMessage = {
      role: "assistant",
      content: "",
      created_at: createdAt,
      pending: true,
      debug: {
        startedAtMs,
      },
    }
    setIsSubmitting(true)
    setVoiceStatus("")
    setChatError("")
    setMessages((current) => [...current, pendingAssistantMessage])
    forceScrollRef.current = true
    setIsPinnedToBottom(true)
    try {
      if (!activeChatId) {
        setMessages((current) => current.slice(0, -1))
        return
      }
      const { transcript, message } = await runPushToTalkChat(audioBase64, mimeType, activeChatId, activeToken)
      setVoiceStatus(`Heard: ${transcript}`)
      const completedAssistantMessage = {
        ...message,
        created_at: message.created_at || createdAt,
        pending: false,
        debug: {
          startedAtMs,
          durationMs: Date.now() - startedAtMs,
        },
      }
      setMessages((current) => [
        ...current.slice(0, -1),
        { role: "user", content: transcript, created_at: createdAt },
        completedAssistantMessage,
      ])
      syncActiveChatFromHistory([
        ...messages,
        { role: "user", content: transcript, created_at: createdAt },
        completedAssistantMessage,
      ])
    } catch (error) {
      setMessages((current) => current.slice(0, -1))
      setChatError(error instanceof Error ? error.message : failedStatus)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function requestLiveTranscript(
    activeToken: string,
    payload: { audioBase64: string; mimeType: string; sequence: number; isFinal: boolean }
  ) {
    const requestId = ++liveTranscriptionRequestRef.current
    try {
      const response = await fetchJson<LiveTranscriptionPayload>(
        "/api/voice/transcribe/live",
        {
          method: "POST",
          body: JSON.stringify({
            audio_base64: payload.audioBase64,
            mime_type: payload.mimeType,
            sequence: payload.sequence,
            is_final: payload.isFinal,
          }),
        },
        activeToken
      )
      if (requestId < liveTranscriptionRequestRef.current) {
        return
      }
      if (response.sequence < liveTranscriptionAppliedRef.current) {
        return
      }
      liveTranscriptionAppliedRef.current = response.sequence
      if (response.transcript.trim()) {
        setVoiceStatus(`${response.is_final ? "Final" : "Hearing"}: ${response.transcript}`)
      }
    } catch {
      // Keep live transcription best-effort so final submit still works.
    }
  }

  function resetLiveTranscriptionState() {
    liveTranscriptionAppliedRef.current = 0
    liveTranscriptionRequestRef.current = 0
  }

  function resetWakewordTelemetry() {
    setWakewordTelemetry({
      peak: 0,
      rms: 0,
      speechLevel: 0,
      wakewordScore: 0,
    })
  }

  const wakewordCaptureOptions = {
    echoCancellation: wakewordEchoCancellationEnabled,
    noiseSuppression: wakewordNoiseSuppressionEnabled,
    autoGainControl: wakewordAutoGainControlEnabled,
  }

  useEffect(() => {
    fetchJson<BootstrapDetails>("/api/bootstrap").then(setBootstrap).catch(() => setBootstrap(null))
  }, [])

  useEffect(() => {
    void refreshHealth()
    const timer = window.setInterval(() => {
      void refreshHealth()
    }, HEALTH_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!token) {
      setUser(null)
      setChats([])
      setActiveChatId("")
      setMessages([])
      setCharacterCatalogRepository(null)
      setSkillCatalogRepository(null)
      setAdminRuntimeMetrics(null)
      setIsAuthHydrating(false)
      forceScrollRef.current = true
      stopSpeaking()
      stopAudioReply()
      wakewordMonitorRef.current?.stop()
      bargeInMonitorRef.current?.stop()
      return
    }
    localStorage.setItem(tokenKey, token)
    Promise.all([
      fetchJson<{ user: UserRecord }>("/api/auth/me", {}, token),
      fetchJson<SettingsPayload>("/api/settings", {}, token),
      fetchJson<VoicesPayload>("/api/voices", {}, token),
      fetchJson<WakewordPayload>("/api/wakeword", {}, token),
      fetchJson<SkillsPayload>("/api/skills", {}, token),
    ])
      .then(([me, settings, voices, wakeword, skills]) => {
        const nextSidebarCollapsed = localStorage.getItem(sidebarStateKey(me.user.id)) === "1"
        localStorage.setItem(currentUserKey, me.user.id)
        setIsSidebarCollapsed(nextSidebarCollapsed)
        setUser(me.user)
        setProfileDisplayNameDraft(me.user.display_name)
        setIsAuthHydrating(false)
        setAuthError("")
        setIsProfileMenuOpen(false)
        setOpenChatMenuId("")
        setThemePresetId(settings.theme_preset_id)
        setThemeMode(settings.theme_mode)
        setEffectiveThemePresetId(settings.effective_theme_preset_id)
        setEffectiveThemeMode(settings.effective_theme_mode)
        setThemeLocked(settings.theme_locked)
        setAvailableThemes(settings.available_themes?.length ? settings.available_themes : fallbackThemePresets)
        setDebugMode(settings.debug_mode)
        forceScrollRef.current = true
        setChats(settings.chats)
        setActiveChatId(settings.active_chat_id)
        setMessages(settings.history)
        setCharacterEnabled(settings.character_enabled)
        setActiveCharacterId(settings.active_character_id)
        setAssignedCharacterId(settings.assigned_character_id)
        setCanSelectCharacter(settings.can_select_character)
        setUserPromptText(settings.user_prompt)
        setCareProfileId(settings.care_profile_id)
        setCareProfiles(settings.care_profiles)
        setCharacters(settings.characters)
        setCharacterCustomizations(settings.character_customizations)
        setVoiceReplyEnabled(voices.reply_enabled)
        setVoiceSource(voices.voice_source)
        setSelectedVoiceURI(voices.browser_voice_uri)
        setSelectedPiperVoiceId(voices.piper_voice_id)
        setBargeInEnabled(settings.barge_in_enabled)
        setPiperVoices(voices.piper.catalog)
        setPiperStatus(voices.piper.status)
        setWakewordEnabled(wakeword.enabled)
        setWakewordModelId(wakeword.model_id)
        setWakewordSources(wakeword.sources)
        setWakewordRuntime(wakeword.status)
        setInstalledSkills(skills.installed)
        setAvailableSkills(skills.available)
        setSkillContextDrafts(
          skills.installed.reduce<Record<string, Record<string, unknown>>>((accumulator, skill) => {
            accumulator[skill.skill_id] = { ...skill.shared_context }
            return accumulator
          }, {})
        )
        setSkillAccountContextDrafts(
          skills.installed.reduce<Record<string, Record<string, Record<string, unknown>>>>((accumulator, skill) => {
            accumulator[skill.skill_id] = skill.accounts.reduce<Record<string, Record<string, unknown>>>((accountAccumulator, account) => {
              accountAccumulator[account.id] = { ...account.context }
              return accountAccumulator
            }, {})
            return accumulator
          }, {})
        )
        const latestAssistantIndex = [...settings.history]
          .map((message, index) => ({ message, index }))
          .reverse()
          .find((entry) => entry.message.role === "assistant")?.index
        lastSpokenMessageRef.current =
          latestAssistantIndex === undefined ? "" : speechMessageKey(settings.history[latestAssistantIndex], latestAssistantIndex)
        if (voices.reply_enabled && voices.voice_source === "piper" && voices.piper.status.selected_voice_installed) {
          void warmSelectedVoice(token)
        }
        if (me.user.is_admin) {
          void refreshAdminUsers(token).catch(() => setAdminUsers([]))
          void refreshAdminVoices(token).catch(() => setAdminVoices([]))
          void refreshAdminCharacterData(token).catch(() => {
            setAdminAccount(null)
            setAdminPromptPolicy(null)
            setAdminCareProfiles([])
          })
          void refreshAdminRuntimeMetrics(token).catch(() => setAdminRuntimeMetrics(null))
        } else {
          setAdminRuntimeMetrics(null)
        }
      })
      .catch((error) => {
        if (error instanceof RequestError && error.status === 401) {
          setToken("")
          localStorage.removeItem(tokenKey)
        }
        setIsAuthHydrating(false)
      })
  }, [token])

  useEffect(() => {
    if (!user?.id) {
      return
    }
    localStorage.setItem(sidebarStateKey(user.id), isSidebarCollapsed ? "1" : "0")
  }, [isSidebarCollapsed, user?.id])

  useEffect(() => {
    if (!token || !user?.is_admin || activeView !== "admin" || activeAdminSection !== "dashboard") {
      return
    }
    void refreshAdminRuntimeMetrics(token).catch(() => setAdminRuntimeMetrics(null))
    const timer = window.setInterval(() => {
      void refreshAdminRuntimeMetrics(token).catch(() => setAdminRuntimeMetrics(null))
    }, HEALTH_POLL_MS)
    return () => window.clearInterval(timer)
  }, [activeAdminSection, activeView, token, user?.is_admin])

  useEffect(() => {
    if (!token || !user?.is_admin || activeView !== "admin" || activeAdminSection !== "voices") {
      return
    }
    void refreshAdminVoices(token).catch(() => setAdminVoices([]))
  }, [activeAdminSection, activeView, token, user?.is_admin])

  useEffect(() => {
    if (activeView !== "admin" || activeAdminSection !== "characters") {
      setIsCharacterEditorOpen(false)
    }
  }, [activeAdminSection, activeView])

  useEffect(() => {
    if (!token || !promptLabUserId) {
      setPromptLabCompilePreview(null)
      setPromptLabDraftsLoaded(false)
      return
    }
    setPromptLabDraftsLoaded(false)
    void refreshPromptLabCompilePreview(promptLabUserId).catch(() => {
      setPromptLabCompilePreview(null)
      setPromptLabDraftsLoaded(false)
    })
  }, [token, promptLabUserId])

  useEffect(() => {
    if (!isProfileMenuOpen && !isCharacterMenuOpen && !openChatMenuId) {
      return
    }
    const handlePointerDown = () => {
      setIsProfileMenuOpen(false)
      setIsCharacterMenuOpen(false)
      setOpenChatMenuId("")
    }
    window.addEventListener("pointerdown", handlePointerDown)
    return () => window.removeEventListener("pointerdown", handlePointerDown)
  }, [isCharacterMenuOpen, openChatMenuId, isProfileMenuOpen])

  useEffect(() => {
    if (activeView !== "settings" && activeView !== "admin") {
      return
    }
    const target = rightPaneScrollRef.current
    if (!target) {
      return
    }
    window.requestAnimationFrame(() => {
      target.scrollTo({ top: 0, behavior: "auto" })
    })
  }, [activeAdminSection, activeSettingsSection, activeView])

  useEffect(() => {
    if (!supportsVoiceOutput()) {
      return
    }
    const loadVoices = () => {
      const nextVoices = listVoiceOutputOptions()
      setVoiceOptions(nextVoices)
      if (!nextVoices.some((voice) => voice.voiceURI === selectedVoiceURI)) {
        const fallbackVoice = nextVoices.find((voice) => voice.default) || nextVoices[0]
        const fallbackURI = fallbackVoice?.voiceURI || ""
        setSelectedVoiceURI(fallbackURI)
      }
    }
    loadVoices()
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices)
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices)
    }
  }, [selectedVoiceURI])

  useEffect(() => {
    return () => {
      recognizerRef.current?.stop()
      recorderRef.current?.stop()
      wakewordMonitorRef.current?.stop()
      wakewordDebugMonitorRef.current?.stop()
      if (wakewordDebugTimeoutRef.current !== null) {
        window.clearTimeout(wakewordDebugTimeoutRef.current)
      }
      bargeInMonitorRef.current?.stop()
      stopSpeaking()
      stopAudioReply()
    }
  }, [])

  useEffect(() => {
    if (!token || !user || !wakewordEnabled) {
      wakewordMonitorRef.current?.stop()
      resetWakewordTelemetry()
      return
    }
    if (isCharacterSyncPending || isSubmitting || isVoiceListening || isVoiceReplyPending || Boolean(speakingMessageKey) || !wakewordRuntime?.ready) {
      wakewordMonitorRef.current?.stop()
      resetWakewordTelemetry()
      return
    }
    if (!wakewordMonitorRef.current) {
      wakewordMonitorRef.current = createWakewordMonitor(
        ({ audioBase64, sampleRate }) => {
          if (wakewordDetectInFlightRef.current || wakewordCaptureInFlightRef.current || !token) {
            return
          }
          wakewordDetectInFlightRef.current = true
          void fetchJson<{ detected: boolean; score: number; ready: boolean; detail: string; model_id: string }>(
            "/api/wakeword/detect",
            {
              method: "POST",
              body: JSON.stringify({ audio_base64: audioBase64, sample_rate: sampleRate }),
            },
            token
          )
            .then((payload) => {
              setWakewordTelemetry((current) => ({
                ...current,
                wakewordScore: Math.max(current.wakewordScore * 0.7, payload.score || 0),
              }))
              if (!payload.ready) {
                wakewordMonitorRef.current?.stop()
                setWakewordRuntime((current) => ({
                  ready: false,
                  detail: payload.detail,
                  engine_available: current?.engine_available ?? false,
                  model_id: payload.model_id,
                  source: current?.source ?? null,
                }))
                setVoiceStatus(payload.detail)
                return
              }
              if (!payload.detected || wakewordCaptureInFlightRef.current) {
                return
              }
              wakewordCaptureInFlightRef.current = true
              wakewordMonitorRef.current?.stop()
              setVoiceStatus("Wakeword detected. Listening...")
              return recordPushToTalkSample()
                .then(({ audioBase64: commandAudio, mimeType }) => {
                  const startedAtMs = Date.now()
                  const createdAt = new Date(startedAtMs).toISOString()
                  setIsSubmitting(true)
                  if (!activeChatId) {
                    return Promise.resolve()
                  }
                  return runPushToTalkChat(commandAudio, mimeType, activeChatId, token).then(({ transcript, message }) => {
                    const nextHistory = [
                      ...messages,
                      { role: "user", content: transcript, created_at: createdAt } as ChatMessage,
                      {
                        ...message,
                        created_at: message.created_at || createdAt,
                        pending: false,
                        debug: {
                          startedAtMs,
                          durationMs: Date.now() - startedAtMs,
                        },
                      } as ChatMessage,
                    ]
                    setVoiceStatus(`Heard: ${transcript}`)
                    forceScrollRef.current = true
                    setIsPinnedToBottom(true)
                    setMessages(nextHistory)
                    syncActiveChatFromHistory(nextHistory)
                    void playMessageVoice(message, `msg-${message.created_at}`)
                  })
                })
                .catch((error) => {
                  setChatError(error instanceof Error ? error.message : "Wakeword command capture failed.")
                })
                .finally(() => {
                  wakewordCaptureInFlightRef.current = false
                  setIsSubmitting(false)
                })
            })
            .catch((error) => {
              wakewordMonitorRef.current?.stop()
              setVoiceStatus(error instanceof Error ? error.message : "Wakeword detection failed.")
            })
            .finally(() => {
              wakewordDetectInFlightRef.current = false
            })
        },
        (message) => setVoiceStatus(message),
        setIsWakewordMonitoring,
        {
          ...wakewordCaptureOptions,
          onTelemetry: ({ peak, rms, speechLevel }) => {
            setWakewordTelemetry((current) => ({
              ...current,
              peak,
              rms,
              speechLevel,
              wakewordScore: current.wakewordScore * 0.85,
            }))
          },
        }
      )
    }
    if (!wakewordMonitorRef.current?.isMonitoring()) {
      void wakewordMonitorRef.current?.start()
    }
    return () => {
      if (isSubmitting || isVoiceListening || isVoiceReplyPending || Boolean(speakingMessageKey) || !wakewordEnabled) {
        wakewordMonitorRef.current?.stop()
      }
    }
  }, [isCharacterSyncPending, isSubmitting, isVoiceListening, isVoiceReplyPending, speakingMessageKey, token, user, wakewordAutoGainControlEnabled, wakewordEchoCancellationEnabled, wakewordEnabled, wakewordNoiseSuppressionEnabled, wakewordRuntime?.ready])

  useEffect(() => {
    if (!token || !user || !bargeInEnabled || isSubmitting || isVoiceListening) {
      bargeInMonitorRef.current?.stop()
      return
    }
    if (!isVoiceReplyPending && !speakingMessageKey && !isBargeInCapturing) {
      bargeInMonitorRef.current?.stop()
      return
    }
    if (!bargeInMonitorRef.current) {
      bargeInMonitorRef.current = createBargeInMonitor(
        ({ audioBase64, mimeType }) => {
          if (!token || bargeInCaptureInFlightRef.current) {
            return
          }
          bargeInCaptureInFlightRef.current = true
          setIsBargeInCapturing(true)
          setVoiceStatus("Barge-in detected. Transcribing...")
          void runRecordedVoiceTurn(token, audioBase64, mimeType, "Transcribing interruption...", "Barge-in capture failed.")
            .finally(() => {
              bargeInCaptureInFlightRef.current = false
              setIsBargeInCapturing(false)
            })
        },
        (message) => {
          setIsBargeInCapturing(false)
          setVoiceStatus(message)
        },
        (monitoring) => {
          if (!monitoring) {
            setIsBargeInCapturing(false)
          }
        },
        {
          onSpeechStart: () => {
            resetLiveTranscriptionState()
            setIsBargeInCapturing(true)
            interruptCurrentVoiceReply("Barge-in detected. Listening...")
          },
          onInterimSample: ({ audioBase64, mimeType, isFinal }) => {
            if (!token || bargeInCaptureInFlightRef.current) {
              return
            }
            void requestLiveTranscript(token, {
              audioBase64,
              mimeType,
              sequence: liveTranscriptionRequestRef.current + 1,
              isFinal,
            })
          },
        }
      )
    }
    if (!bargeInMonitorRef.current?.isMonitoring()) {
      void bargeInMonitorRef.current?.start()
    }
    return () => {
      if (!isVoiceReplyPending && !speakingMessageKey && !isBargeInCapturing) {
        bargeInMonitorRef.current?.stop()
      }
    }
  }, [bargeInEnabled, isBargeInCapturing, isSubmitting, isVoiceListening, isVoiceReplyPending, speakingMessageKey, token, user])

  async function playMessageVoice(message: ChatMessage, messageKey: string) {
    if (!voiceReplyEnabled) {
      setVoiceStatus("Voice output is currently muted.");
      return;
    }
    try {
      const spokenText = prepareSpeechText(speakableMessageText(message))
      if (!spokenText) {
        setVoiceStatus("Nothing speakable was found in this response.")
        return
      }
      if (speakingMessageKey === messageKey || pendingSpeechMessageKey === messageKey) {
        stopSpeaking()
        stopAudioReply()
        setVoiceStatus("Speech stopped.")
        return
      }
      speechAbortRef.current?.abort()
      const requestId = speechRequestRef.current + 1
      speechRequestRef.current = requestId
      const abortController = new AbortController()
      speechAbortRef.current = abortController
      setPendingSpeechMessageKey(messageKey)
      await primeAudioPlayback()
      if (speechRequestRef.current !== requestId || abortController.signal.aborted) {
        return
      }
      await primePiperPlayback()
      if (speechRequestRef.current !== requestId || abortController.signal.aborted) {
        return
      }
      const characterPiperVoiceId = activeCharacterPiperVoiceId()
      const shouldUseCharacterPiper = Boolean(characterPiperVoiceId)
      if (voiceSource === "browser" && !shouldUseCharacterPiper) {
        stopAudioReply(false, false)
        if (speechRequestRef.current !== requestId || abortController.signal.aborted) {
          return
        }
        setPendingSpeechMessageKey("")
        setSpeakingMessageKey(messageKey)
        setVoiceStatus("Speaking...")
        speakText(spokenText, selectedVoiceURI, {
          onStart: () => {
            if (speechRequestRef.current !== requestId || abortController.signal.aborted) {
              stopSpeaking()
              return
            }
            setPendingSpeechMessageKey("")
            setSpeakingMessageKey(messageKey)
            setSpeakingWordIndex(0)
            setVoiceStatus("Speaking...")
          },
          onWord: (index) => {
            if (speechRequestRef.current === requestId) {
              setSpeakingWordIndex(index)
            }
          },
          onEnd: () => {
            if (speechRequestRef.current !== requestId) {
              return
            }
            setPendingSpeechMessageKey("")
            setSpeakingMessageKey("")
            setSpeakingWordIndex(null)
            setVoiceStatus("Voice reply complete.")
          },
          onError: (message) => {
            if (speechRequestRef.current !== requestId) {
              return
            }
            setPendingSpeechMessageKey("")
            setSpeakingMessageKey("")
            setSpeakingWordIndex(null)
            setVoiceStatus(message)
          },
        })
        return
      }
      setVoiceStatus("Preparing voice reply...")
      await speakWithPiper(
        spokenText,
        messageKey,
        requestId,
        abortController.signal,
        shouldUseCharacterPiper ? characterPiperVoiceId : undefined
      )
    } catch (error) {
      setPendingSpeechMessageKey("")
      if (error instanceof DOMException && error.name === "AbortError") {
        return
      }
      throw error
    }
  }

  useEffect(() => {
    if (suppressAutoVoiceReplyRef.current) {
      return
    }
    const latestAssistantEntry = [...messages]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find((entry) => entry.message.role === "assistant" && !entry.message.pending)
    if (!voiceReplyEnabled || !latestAssistantEntry?.message.content) {
      return
    }
    const nextSpeechKey = speechMessageKey(latestAssistantEntry.message, latestAssistantEntry.index)
    if (nextSpeechKey === lastSpokenMessageRef.current) {
      return
    }
    lastSpokenMessageRef.current = nextSpeechKey
    void playMessageVoice(latestAssistantEntry.message, nextSpeechKey).catch((error) => {
      setVoiceStatus(error instanceof Error ? error.message : "Piper reply failed.")
    })
  }, [activeCharacterId, characterEnabled, characters, messages, selectedVoiceURI, token, voiceReplyEnabled, voiceSource, speakingMessageKey])

  useEffect(() => {
    if (!debugMode) {
      setIsDebugOpen(false)
      return
    }
    const hasPending = messages.some((message) => message.pending && message.role === "assistant")
    if (!hasPending) {
      return
    }
    const timer = window.setInterval(() => setDebugNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [debugMode, messages])

  async function refreshDebugLogs() {
    if (!token || !user?.is_admin) {
      return
    }
    try {
      const payload = await fetchJson<DebugLogsPayload>("/api/debug/logs", {}, token)
      setDebugLogs(payload)
    } catch {
      setDebugLogs(null)
    }
  }

  async function updateAdminUserRole(userId: string, isAdmin: boolean) {
    if (!token) {
      return
    }
    const payload = await fetchJson<AdminUsersPayload>(
      `/api/admin/users/${userId}/role`,
      {
        method: "POST",
        body: JSON.stringify({ is_admin: isAdmin }),
      },
      token
    )
    setAdminUsers(payload.users)
    setAdminNotice("User permissions updated.")
  }

  async function updateAdminUserPassword(userId: string) {
    if (!token || !userPasswordDrafts[userId]?.trim()) {
      return
    }
    await fetchJson(
      `/api/admin/users/${userId}/password`,
      {
        method: "POST",
        body: JSON.stringify({ password: userPasswordDrafts[userId].trim() }),
      },
      token
    )
    setUserPasswordDrafts((current) => ({ ...current, [userId]: "" }))
    setAdminNotice("Password updated.")
  }

  async function deleteAdminUserById(userId: string) {
    if (!token) {
      return
    }
    const payload = await fetchJson<AdminUsersPayload>(
      `/api/admin/users/${userId}`,
      { method: "DELETE" },
      token
    )
    setAdminUsers(payload.users)
    setAdminNotice("User deleted.")
  }

  async function copyToClipboard(text: string, target: string) {
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement("textarea")
        textarea.value = text
        textarea.setAttribute("readonly", "true")
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        textarea.style.pointerEvents = "none"
        document.body.appendChild(textarea)
        textarea.select()
        textarea.setSelectionRange(0, textarea.value.length)
        const copied = document.execCommand("copy")
        document.body.removeChild(textarea)
        if (!copied) {
          throw new Error("Clipboard copy failed.")
        }
      }
      setCopiedDebugTarget(target)
      window.setTimeout(() => {
        setCopiedDebugTarget((current) => (current === target ? "" : current))
      }, 1500)
    } catch {
      setCopiedDebugTarget("")
    }
  }

  function sectionLogText(section: DebugLogSection): string {
    const lines = section.exists && section.lines.length > 0 ? section.lines.join("\n") : "No log output yet."
    return `${section.label}\n${section.path}\n\n${lines}`
  }

  async function copyAllDebugLogs() {
    if (!debugLogs) {
      return
    }
    const text = debugLogs.sections.map((section) => sectionLogText(section)).join("\n\n" + "-".repeat(48) + "\n\n")
    await copyToClipboard(text, "all")
  }

  async function copyDebugSection(section: DebugLogSection) {
    await copyToClipboard(sectionLogText(section), section.key)
  }

  useEffect(() => {
    if (!isDebugOpen || !debugMode) {
      return
    }
    void refreshDebugLogs()
    const timer = window.setInterval(() => {
      void refreshDebugLogs()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [debugMode, isDebugOpen, token, user?.is_admin])

  useEffect(() => {
    const viewport = messageViewportRef.current
    if (!viewport) {
      return
    }
    if (forceScrollRef.current || isPinnedToBottom) {
      viewport.scrollTop = viewport.scrollHeight
      forceScrollRef.current = false
      setIsPinnedToBottom(true)
    }
  }, [messages, isPinnedToBottom])

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError("")
    const formData = new FormData(event.currentTarget)
    const payload =
      authMode === "login"
        ? {
            username: String(formData.get("username") || ""),
            password: String(formData.get("password") || ""),
          }
        : {
            username: String(formData.get("username") || ""),
            display_name: String(formData.get("display_name") || ""),
            password: String(formData.get("password") || ""),
          }
    try {
      const response = await fetchJson<{ access_token: string; user: UserRecord }>(
        authMode === "login" ? "/api/auth/login" : "/api/auth/register",
        { method: "POST", body: JSON.stringify(payload) }
      )
      localStorage.setItem(currentUserKey, response.user.id)
      setIsSidebarCollapsed(localStorage.getItem(sidebarStateKey(response.user.id)) === "1")
      setIsAuthHydrating(false)
      setToken(response.access_token)
      setUser(response.user)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.")
    }
  }

  async function sendPrompt(messageOverride?: string) {
    const normalizedPrompt = typeof messageOverride === "string" ? messageOverride.trim() : prompt.trim()
    if (
      (!normalizedPrompt && !selectedImage && !selectedVideo && !selectedDocument)
      || !token
      || !activeChatId
      || isCharacterSyncPending
    ) {
      return
    }
    if (isVoiceReplyPending || speakingMessageKey) {
      interruptCurrentVoiceReply("Listening...")
    }
    void primePiperPlayback()
    if (voiceReplyEnabled && voiceSource === "piper") {
      void warmSelectedVoice(token).catch(() => undefined)
    }
    const userContent =
      normalizedPrompt ||
      (selectedImage
        ? `Analyze image: ${selectedImage.name}`
        : selectedVideo
          ? `Analyze video: ${selectedVideo.name}`
          : selectedDocument
            ? `Analyze document: ${selectedDocument.name}`
          : "")
    const createdAt = new Date().toISOString()
    const nextMessage: ChatMessage = { role: "user", content: userContent, created_at: createdAt }
    const startedAtMs = Date.now()
    const placeholder: ChatMessage = {
      role: "assistant",
      content: "",
      created_at: createdAt,
      pending: true,
      debug: { startedAtMs },
    }
    setIsSubmitting(true)
    setChatError("")
    setIsAttachmentMenuOpen(false)
    forceScrollRef.current = true
    setIsPinnedToBottom(true)
    setMessages((current) => [...current, nextMessage, placeholder])
    const outgoing = normalizedPrompt
    const outgoingImage = selectedImage
    const outgoingVideo = selectedVideo
    const outgoingDocument = selectedDocument
    setPrompt("")
    setSelectedImage(null)
    setSelectedVideo(null)
    setSelectedDocument(null)
    try {
      if (outgoingImage) {
        const message = await analyzeImage(outgoingImage, outgoing, activeChatId, token)
        const nextHistory = [...messages, nextMessage, { ...message, created_at: message.created_at || new Date().toISOString(), pending: false }]
        setMessages((current) => {
          const next = [...current]
          const lastIndex = next.length - 1
          if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
            next[lastIndex] = {
              ...message,
              created_at: message.created_at || next[lastIndex].created_at || new Date().toISOString(),
              pending: false,
              debug: {
                startedAtMs,
                durationMs: Date.now() - startedAtMs,
              },
            }
          }
          return next
        })
        syncActiveChatFromHistory(nextHistory)
        return
      }
      if (outgoingVideo) {
        const message = await analyzeVideo(outgoingVideo, outgoing, activeChatId, token)
        const nextHistory = [...messages, nextMessage, { ...message, created_at: message.created_at || new Date().toISOString(), pending: false }]
        setMessages((current) => {
          const next = [...current]
          const lastIndex = next.length - 1
          if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
            next[lastIndex] = {
              ...message,
              created_at: message.created_at || next[lastIndex].created_at || new Date().toISOString(),
              pending: false,
              debug: {
                startedAtMs,
                durationMs: Date.now() - startedAtMs,
              },
            }
          }
          return next
        })
        syncActiveChatFromHistory(nextHistory)
        return
      }
      if (outgoingDocument) {
        const message = await analyzeDocument(outgoingDocument, outgoing, activeChatId, token)
        const nextHistory = [...messages, nextMessage, { ...message, created_at: message.created_at || new Date().toISOString(), pending: false }]
        setMessages((current) => {
          const next = [...current]
          const lastIndex = next.length - 1
          if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
            next[lastIndex] = {
              ...message,
              created_at: message.created_at || next[lastIndex].created_at || new Date().toISOString(),
              pending: false,
              debug: {
                startedAtMs,
                durationMs: Date.now() - startedAtMs,
              },
            }
          }
          return next
        })
        syncActiveChatFromHistory(nextHistory)
        return
      }
      await streamChat(outgoing, activeChatId, token, performanceProfileId, {
        onMeta: (meta) => {
          setMessages((current) => {
            const next = [...current]
            const lastIndex = next.length - 1
            if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
              next[lastIndex] = { ...next[lastIndex], meta }
            }
            return next
          })
        },
        onDelta: (delta) => {
          setMessages((current) => {
            const next = [...current]
            const lastIndex = next.length - 1
            if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
              next[lastIndex] = {
                ...next[lastIndex],
                content: next[lastIndex].content + delta,
                pending: true,
              }
            }
            return next
          })
        },
        onDone: (message) => {
          const completedAt = message.created_at || new Date().toISOString()
          const completedMessage = {
            ...message,
            created_at: completedAt,
            pending: false,
            debug: {
              startedAtMs,
              durationMs: Date.now() - startedAtMs,
            },
          }
          setMessages((current) => {
            const next = [...current]
            const lastIndex = next.length - 1
            if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
              next[lastIndex] = completedMessage
            }
            return next
          })
          syncActiveChatFromHistory([...messages, nextMessage, completedMessage])
        },
      })
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Message failed.")
      setMessages((current) => current.slice(0, -2))
      setPrompt(outgoing)
      setSelectedImage(outgoingImage || null)
      setSelectedVideo(outgoingVideo || null)
      setSelectedDocument(outgoingDocument || null)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function submitChat(event: FormEvent) {
    event.preventDefault()
    await sendPrompt()
  }

  async function retryAssistantWithSmartModel(assistantIndex: number) {
    if (!token || !activeChatId || assistantIndex <= 0 || messages[assistantIndex]?.role !== "assistant") {
      return
    }
    const previousMessages = [...messages]
    const startedAtMs = Date.now()
    const placeholder: ChatMessage = {
      role: "assistant",
      content: "",
      created_at: new Date(startedAtMs).toISOString(),
      pending: true,
      debug: { startedAtMs },
    }
    suppressAutoVoiceReplyRef.current = true
    if (isVoiceReplyPending || speakingMessageKey) {
      interruptCurrentVoiceReply("Retrying with smart model...")
    }
    setRetryingAssistantIndex(assistantIndex)
    setChatError("")
    forceScrollRef.current = true
    setIsPinnedToBottom(true)
    setMessages([...previousMessages.slice(0, assistantIndex), placeholder])
    try {
      const message = await retrySmartChat(assistantIndex, activeChatId, token)
      const completedMessage = {
        ...message,
        created_at: message.created_at || new Date().toISOString(),
        pending: false,
        debug: {
          startedAtMs,
          durationMs: Date.now() - startedAtMs,
        },
      }
      suppressAutoVoiceReplyRef.current = false
      lastSpokenMessageRef.current = ""
      setMessages([
        ...previousMessages.slice(0, assistantIndex),
        completedMessage,
      ])
      syncActiveChatFromHistory([...previousMessages.slice(0, assistantIndex), completedMessage])
    } catch (error) {
      suppressAutoVoiceReplyRef.current = false
      setMessages(previousMessages)
      setChatError(error instanceof Error ? error.message : "Retry failed.")
    } finally {
      setRetryingAssistantIndex(-1)
    }
  }

  async function persistVoicePreferences(next: {
    voiceReplyEnabled?: boolean
    voiceSource?: "browser" | "piper"
    browserVoiceURI?: string
    piperVoiceId?: string
    bargeInEnabled?: boolean
  }) {
    const nextReplyEnabled = next.voiceReplyEnabled ?? voiceReplyEnabled
    const nextVoiceSource = next.voiceSource ?? voiceSource
    const nextBrowserVoiceURI = next.browserVoiceURI ?? selectedVoiceURI
    const nextPiperVoiceId = next.piperVoiceId ?? selectedPiperVoiceId
    const nextBargeInEnabled = next.bargeInEnabled ?? bargeInEnabled
    setVoiceReplyEnabled(nextReplyEnabled)
    setVoiceSource(nextVoiceSource)
    setSelectedVoiceURI(nextBrowserVoiceURI)
    setSelectedPiperVoiceId(nextPiperVoiceId)
    setBargeInEnabled(nextBargeInEnabled)
    if (!nextReplyEnabled) {
      stopSpeaking()
      stopAudioReply()
    }
    if (!token) {
      return
    }
    const payload = await fetchJson<SettingsPayload>(
      "/api/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          theme_preset_id: themePresetId,
          theme_mode: themeMode,
          voice_reply_enabled: nextReplyEnabled,
          voice_source: nextVoiceSource,
          browser_voice_uri: nextBrowserVoiceURI,
          piper_voice_id: nextPiperVoiceId,
          barge_in_enabled: nextBargeInEnabled,
        }),
      },
      token
    )
    setThemePresetId(payload.theme_preset_id)
    setThemeMode(payload.theme_mode)
    setEffectiveThemePresetId(payload.effective_theme_preset_id)
    setEffectiveThemeMode(payload.effective_theme_mode)
    setThemeLocked(payload.theme_locked)
    setAvailableThemes(payload.available_themes?.length ? payload.available_themes : fallbackThemePresets)
    setVoiceReplyEnabled(payload.voice_reply_enabled)
    setVoiceSource(payload.voice_source)
    setSelectedVoiceURI(payload.browser_voice_uri)
    setSelectedPiperVoiceId(payload.piper_voice_id)
    setBargeInEnabled(payload.barge_in_enabled)
    await refreshVoices(token)
  }

  async function persistWakewordPreferences(next: {
    enabled?: boolean
    modelId?: string
    threshold?: number
  }) {
    const nextEnabled = next.enabled ?? wakewordEnabled
    const nextModelId = next.modelId ?? wakewordModelId
    const nextThreshold = next.threshold ?? wakewordThreshold
    setWakewordEnabled(nextEnabled)
    setWakewordModelId(nextModelId)
    setWakewordThreshold(nextThreshold)
    if (!token) {
      return
    }
    const payload = await fetchJson<WakewordPayload>(
      "/api/wakeword",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: nextEnabled,
          model_id: nextModelId,
          threshold: nextThreshold,
        }),
      },
      token
    )
    setWakewordEnabled(payload.enabled)
    setWakewordModelId(payload.model_id)
    setWakewordThreshold(payload.threshold)
    setWakewordSources(payload.sources)
    setWakewordRuntime(payload.status)
  }

  function appendWakewordDebugEvent(message: string) {
    const timestamp = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    setWakewordDebugEvents((current) => [`${timestamp} · ${message}`, ...current].slice(0, 8))
  }

  function stopWakewordDebugTest() {
    wakewordDebugMonitorRef.current?.stop()
    if (wakewordDebugTimeoutRef.current !== null) {
      window.clearTimeout(wakewordDebugTimeoutRef.current)
      wakewordDebugTimeoutRef.current = null
    }
  }

  async function startWakewordDebugTest() {
    if (!token) {
      return
    }
    stopWakewordDebugTest()
    setWakewordDebugEvents([])
    const startedAtMs = Date.now()
    let peakScore = 0
    let checkedChunks = 0
    setWakewordDebugResult({
      status: "running",
      detail: "Listening for about 5 seconds. Say the wakeword naturally once.",
      score: 0,
      startedAtMs,
      finishedAtMs: null,
    })
    appendWakewordDebugEvent(`Test started with model ${wakewordModelId}.`)
    resetWakewordTelemetry()
    const monitor = createWakewordMonitor(
      ({ audioBase64, sampleRate }) => {
        checkedChunks += 1
        void fetchJson<{ detected: boolean; score: number; ready: boolean; detail: string; model_id: string }>(
          "/api/wakeword/detect",
          {
            method: "POST",
            body: JSON.stringify({ audio_base64: audioBase64, sample_rate: sampleRate }),
          },
          token
        )
          .then((payload) => {
            peakScore = Math.max(peakScore, payload.score || 0)
            setWakewordTelemetry((current) => ({
              ...current,
              wakewordScore: Math.max(current.wakewordScore * 0.7, payload.score || 0),
            }))
            setWakewordDebugResult((current) => ({
              ...current,
              score: peakScore,
              detail: payload.detail,
            }))
            if (!payload.ready) {
              appendWakewordDebugEvent(payload.detail)
              setWakewordDebugResult({
                status: "error",
                detail: payload.detail,
                score: peakScore,
                startedAtMs,
                finishedAtMs: Date.now(),
              })
              stopWakewordDebugTest()
              return
            }
            if (payload.detected) {
              appendWakewordDebugEvent(`Detected with score ${payload.score.toFixed(3)}.`)
              setWakewordDebugResult({
                status: "detected",
                detail: "Wakeword detected successfully.",
                score: payload.score,
                startedAtMs,
                finishedAtMs: Date.now(),
              })
              stopWakewordDebugTest()
            }
          })
          .catch((error) => {
            const detail = error instanceof Error ? error.message : "Wakeword test failed."
            appendWakewordDebugEvent(detail)
            setWakewordDebugResult({
              status: "error",
              detail,
              score: peakScore,
              startedAtMs,
              finishedAtMs: Date.now(),
            })
            stopWakewordDebugTest()
          })
      },
      (message) => {
        appendWakewordDebugEvent(message)
        setWakewordDebugResult({
          status: "error",
          detail: message,
          score: peakScore,
          startedAtMs,
          finishedAtMs: Date.now(),
        })
        stopWakewordDebugTest()
      },
      () => {},
      {
        ...wakewordCaptureOptions,
        onTelemetry: ({ peak, rms, speechLevel }) => {
          setWakewordTelemetry((current) => ({
            ...current,
            peak,
            rms,
            speechLevel,
            wakewordScore: current.wakewordScore * 0.85,
          }))
        },
      }
    )
    if (!monitor) {
      setWakewordDebugResult({
        status: "error",
        detail: "Wakeword testing is unavailable in this browser.",
        score: 0,
        startedAtMs,
        finishedAtMs: Date.now(),
      })
      return
    }
    wakewordDebugMonitorRef.current = monitor
    await monitor.start()
    wakewordDebugTimeoutRef.current = window.setTimeout(() => {
      appendWakewordDebugEvent(`Test ended after checking ${checkedChunks} chunks. Peak score ${peakScore.toFixed(3)}.`)
      setWakewordDebugResult({
        status: "not_detected",
        detail: checkedChunks > 0
          ? `No detection during the test window. Peak score ${peakScore.toFixed(3)}.`
          : "No usable audio chunks were captured during the test.",
        score: peakScore,
        startedAtMs,
        finishedAtMs: Date.now(),
      })
      stopWakewordDebugTest()
    }, 5000)
  }

  function toggleVoiceReply() {
    void persistVoicePreferences({ voiceReplyEnabled: !voiceReplyEnabled })
    setVoiceStatus("")
  }

  function handleVoiceSelection(nextVoiceURI: string) {
    void persistVoicePreferences({ browserVoiceURI: nextVoiceURI })
    setVoiceStatus("")
    stopSpeaking()
  }

  function handleVoiceSourceChange(nextSource: "browser" | "piper") {
    void persistVoicePreferences({ voiceSource: nextSource })
    setVoiceStatus("")
    stopSpeaking()
    stopAudioReply()
    if (nextSource === "piper") {
      if (token) {
        void warmSelectedVoice(token).catch(() => undefined)
      }
      const nextVoice = piperVoices.find((voice) => voice.id === selectedPiperVoiceId)
      if (user?.is_admin && nextVoice && !nextVoice.installed) {
        void installPiperVoiceById(selectedPiperVoiceId)
      }
    }
  }

  function handlePiperVoiceChange(nextVoiceId: string) {
    void persistVoicePreferences({ piperVoiceId: nextVoiceId })
    setVoiceStatus("")
    stopSpeaking()
    stopAudioReply()
    if (token) {
      void warmSelectedVoice(token).catch(() => undefined)
    }
    const nextVoice = piperVoices.find((voice) => voice.id === nextVoiceId)
    if (user?.is_admin && nextVoice && !nextVoice.installed) {
      void installPiperVoiceById(nextVoiceId)
    }
  }

  async function installPiperVoiceById(voiceId: string) {
    if (!token) {
      return
    }
    setIsInstallingVoice(true)
    setVoiceStatus("")
    try {
      await fetchJson(
        "/api/voices/piper/install",
        {
          method: "POST",
          body: JSON.stringify({ voice_id: voiceId }),
        },
        token
      )
      await refreshVoices(token)
      if (user?.is_admin) {
        await refreshAdminVoices(token)
      }
      setVoiceStatus("Piper voice installed.")
    } catch (error) {
      setVoiceStatus(error instanceof Error ? error.message : "Piper voice install failed.")
    } finally {
      setIsInstallingVoice(false)
    }
  }

  function resetCustomVoiceDrafts() {
    setCustomVoiceIdDraft("")
    setCustomVoiceLabelDraft("")
    setCustomVoiceUrlDraft("")
    setCustomVoiceConfigUrlDraft("")
    setCustomVoiceModelDataUrlDraft("")
    setCustomVoiceConfigDataUrlDraft("")
    setCustomVoiceModelSourceNameDraft("")
    setCustomVoiceConfigSourceNameDraft("")
    setCustomVoiceDescriptionDraft("")
    setCustomVoiceLanguageDraft("")
    setCustomVoiceQualityDraft("")
    setCustomVoiceGenderDraft("")
  }

  async function installCustomVoice() {
    if (!token) {
      return
    }
    const hasUploads = Boolean(customVoiceModelDataUrlDraft || customVoiceConfigDataUrlDraft)
    const hasUrls = Boolean(customVoiceUrlDraft.trim() || customVoiceConfigUrlDraft.trim())
    if (!customVoiceIdDraft.trim() || !customVoiceLabelDraft.trim()) {
      setAdminNotice("Custom voice id and label are required.")
      return
    }
    if (!hasUploads && !customVoiceUrlDraft.trim()) {
      setAdminNotice("Provide a model URL or upload a model file.")
      return
    }
    if (hasUploads && (!customVoiceModelDataUrlDraft || !customVoiceConfigDataUrlDraft)) {
      setAdminNotice("Upload both the Piper model and config files.")
      return
    }
    setIsInstallingVoice(true)
    try {
      const payload = await fetchJson<{ voices: AdminVoiceRecord[] }>(
        "/api/admin/voices/custom",
        {
          method: "POST",
          body: JSON.stringify({
            voice_id: customVoiceIdDraft.trim(),
            label: customVoiceLabelDraft.trim(),
            model_url: customVoiceUrlDraft.trim(),
            config_url: customVoiceConfigUrlDraft.trim(),
            model_data_url: customVoiceModelDataUrlDraft,
            config_data_url: customVoiceConfigDataUrlDraft,
            model_source_name: customVoiceModelSourceNameDraft,
            config_source_name: customVoiceConfigSourceNameDraft,
            description: customVoiceDescriptionDraft.trim(),
            language: customVoiceLanguageDraft.trim(),
            quality: customVoiceQualityDraft.trim(),
            gender: customVoiceGenderDraft.trim(),
          }),
        },
        token
      )
      setAdminVoices(payload.voices)
      await refreshVoices(token)
      resetCustomVoiceDrafts()
      setIsAdminVoiceModalOpen(false)
      setAdminNotice("Custom voice installed.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Custom voice install failed.")
    } finally {
      setIsInstallingVoice(false)
    }
  }

  async function reinstallAdminVoice(voiceId: string) {
    if (!token) {
      return
    }
    setIsInstallingVoice(true)
    try {
      const payload = await fetchJson<{ voices: AdminVoiceRecord[] }>(
        `/api/admin/voices/${voiceId}/reinstall`,
        { method: "POST" },
        token
      )
      setAdminVoices(payload.voices)
      await refreshVoices(token)
      setAdminNotice("Voice reinstalled.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Voice reinstall failed.")
    } finally {
      setIsInstallingVoice(false)
    }
  }

  async function removeAdminVoice(voiceId: string) {
    if (!token) {
      return
    }
    setIsInstallingVoice(true)
    try {
      const payload = await fetchJson<{ voices: AdminVoiceRecord[] }>(
        `/api/admin/voices/${voiceId}`,
        { method: "DELETE" },
        token
      )
      setAdminVoices(payload.voices)
      await refreshVoices(token)
      setAdminNotice("Voice removed.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Voice remove failed.")
    } finally {
      setIsInstallingVoice(false)
    }
  }

  async function refreshAdminVoiceCatalog() {
    if (!token) {
      return
    }
    setIsRefreshingVoiceCatalog(true)
    try {
      const payload = await fetchJson<{ voices: AdminVoiceRecord[]; catalog_status: PiperCatalogStatus }>(
        "/api/admin/voices/catalog/refresh",
        { method: "POST" },
        token
      )
      setAdminVoices(payload.voices)
      setAdminVoiceCatalogStatus(payload.catalog_status)
      await refreshVoices(token)
      setAdminNotice("Piper catalog refreshed.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Piper catalog refresh failed.")
    } finally {
      setIsRefreshingVoiceCatalog(false)
    }
  }

  async function previewAdminVoice(voiceId: string, label: string) {
    if (!token) {
      return
    }
    setPreviewingAdminVoiceId(voiceId)
    setVoiceStatus(`Preparing ${label} preview...`)
    try {
      stopSpeaking()
      stopAudioReply(false, false)
      await primeAudioPlayback()
      await primePiperPlayback()
      const response = await fetch(`/api/admin/voices/${voiceId}/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: `${label}. LokiDoki voice preview.` }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.detail || "Voice preview failed.")
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      if (audioReplyUrlRef.current) {
        URL.revokeObjectURL(audioReplyUrlRef.current)
      }
      audioReplyUrlRef.current = url
      const audio = ensureAudioReplyElement()
      audio.src = url
      audio.currentTime = 0
      try {
        await audio.play()
        setVoiceStatus(`${label} preview playing.`)
      } catch (error) {
        if (error instanceof DOMException) {
          setVoiceStatus("Preview audio is ready, but this browser blocked autoplay. Use Preview voice once in Settings to unlock audio.")
          return
        }
        throw error
      }
    } catch (error) {
      setVoiceStatus(error instanceof Error ? error.message : "Voice preview failed.")
    } finally {
      setPreviewingAdminVoiceId("")
    }
  }

  function beginEditingCustomVoice(voice: AdminVoiceRecord) {
    setEditingCustomVoiceId(voice.id)
    setCustomVoiceEditorDraft({
      voice_id: voice.id,
      label: voice.label,
      description: voice.description || "",
      model_url: voice.source_url || "",
      config_url: voice.config_url || "",
      language: voice.language === "custom" ? "" : voice.language,
      quality: voice.quality === "custom" ? "" : voice.quality,
      gender: voice.gender || "",
    })
  }

  async function saveCustomVoiceEditor() {
    if (!token || !customVoiceEditorDraft || !editingCustomVoiceId) {
      return
    }
    setIsInstallingVoice(true)
    try {
      const payload = await fetchJson<{ voices: AdminVoiceRecord[]; catalog_status: PiperCatalogStatus }>(
        `/api/admin/voices/${editingCustomVoiceId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            label: customVoiceEditorDraft.label,
            description: customVoiceEditorDraft.description,
            model_url: customVoiceEditorDraft.model_url,
            config_url: customVoiceEditorDraft.config_url,
            language: customVoiceEditorDraft.language,
            quality: customVoiceEditorDraft.quality,
            gender: customVoiceEditorDraft.gender,
          }),
        },
        token
      )
      setAdminVoices(payload.voices)
      setAdminVoiceCatalogStatus(payload.catalog_status)
      setEditingCustomVoiceId("")
      setCustomVoiceEditorDraft(null)
      setAdminNotice("Custom voice updated.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Custom voice update failed.")
    } finally {
      setIsInstallingVoice(false)
    }
  }

  function resetAdminVoiceFilters() {
    setAdminVoiceSearch("")
    setAdminVoiceLanguageFilter("all")
    setAdminVoiceQualityFilter("all")
    setAdminVoiceKindFilter("all")
    setAdminVoiceSort("recommended")
    setAdminVoiceTab("all")
  }

  function resetAdminSkillFilters() {
    setAdminSkillSearch("")
    setAdminSkillCatalogTab("all")
    setAdminSkillDomainFilter("all")
    setAdminSkillHealthFilter("all")
    setAdminSkillKindFilter("all")
    setAdminSkillSort("recommended")
  }

  function toggleSkillDetails(skillId: string) {
    setExpandedSkillDetails((current) => ({ ...current, [skillId]: !current[skillId] }))
  }

  function toggleAdminVoiceDetails(voiceId: string) {
    setExpandedAdminVoiceDetails((current) => ({ ...current, [voiceId]: !current[voiceId] }))
  }

  function handleVoiceTranscript(transcript: string) {
    setVoiceStatus(`Heard: ${transcript}`)
    setPrompt(transcript)
    void sendPrompt(transcript)
  }

  function togglePushToTalk() {
    if (!user || isSubmitting) {
      return
    }
    if (isVoiceReplyPending || speakingMessageKey) {
      interruptCurrentVoiceReply("Listening...")
    }
    void primeAudioPlayback()
    void primePiperPlayback()
    if (supportsPushToTalkRecording()) {
      if (!token) {
        return
      }
      if (!recorderRef.current) {
        recorderRef.current = createPushToTalkRecorder(
          ({ audioBase64, mimeType }) => {
            resetLiveTranscriptionState()
            void runRecordedVoiceTurn(token, audioBase64, mimeType, "Transcribing...", "Push-to-talk failed.")
          },
          ({ audioBase64, mimeType, sequence, isFinal }) => {
            void requestLiveTranscript(token, { audioBase64, mimeType, sequence, isFinal })
          },
          (message) => {
            setIsVoiceListening(false)
            setChatError(message)
          },
          setIsVoiceListening,
          setRecordingStream
        )
      }
      if (recorderRef.current?.isRecording()) {
        setVoiceStatus("Transcribing...")
        recorderRef.current.stop()
        return
      }
      setChatError("")
      setVoiceStatus("Listening...")
      void recorderRef.current?.start()
      return
    }
    if (supportsVoiceInput()) {
      if (isVoiceListening) {
        recognizerRef.current?.stop()
        setVoiceStatus("Stopped listening.")
        return
      }
      if (!recognizerRef.current) {
        recognizerRef.current = createPushToTalkRecognizer(
          handleVoiceTranscript,
          (message) => {
            setIsVoiceListening(false)
            setChatError(message)
          },
          setIsVoiceListening
        )
      }
      setChatError("")
      setVoiceStatus("Listening...")
      recognizerRef.current?.start()
      return
    }
    setChatError(
      window.isSecureContext
        ? "Push-to-talk is unavailable in this browser."
        : "Push-to-talk needs microphone capture, which browsers block on remote HTTP pages. Open LokiDoki at http://127.0.0.1:7860 on that device, or use HTTPS on the Pi (for example a Tailscale-served address)."
    )
  }

  async function previewSelectedVoice() {
    const previewText = "LokiDoki voice preview."
    setIsPreviewingVoice(true)
    setVoiceStatus("Preparing voice preview...")
    try {
      if (token && voiceSource === "piper") {
        await warmSelectedVoice(token)
      }
      const result = await replayAssistantVoice({
        role: "assistant",
        content: previewText,
        meta: {
          request_type: "voice_preview",
          route: "voice_preview",
          reason: "Local voice preview playback.",
          voice_summary: previewText,
        },
      })
      if (result !== "blocked") {
        setVoiceStatus(result === "browser" ? "Browser voice preview started." : "Voice preview playing.")
      }
    } catch (error) {
      setVoiceStatus(error instanceof Error ? error.message : "Voice preview failed.")
    } finally {
      setIsPreviewingVoice(false)
    }
  }

  async function persistTheme(next: { presetId?: ThemePresetId; mode?: ThemeMode }) {
    const nextPresetId = next.presetId ?? themePresetId
    const nextMode = next.mode ?? themeMode
    setThemePresetId(nextPresetId)
    setThemeMode(nextMode)
    setEffectiveThemePresetId(nextPresetId)
    setEffectiveThemeMode(nextMode)
    if (!token) {
      return
    }
    const payload = await fetchJson<SettingsPayload>(
      "/api/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          theme_preset_id: nextPresetId,
          theme_mode: nextMode,
          voice_reply_enabled: voiceReplyEnabled,
          voice_source: voiceSource,
          browser_voice_uri: selectedVoiceURI,
          piper_voice_id: selectedPiperVoiceId,
          barge_in_enabled: bargeInEnabled,
        }),
      },
      token
    )
    setThemePresetId(payload.theme_preset_id)
    setThemeMode(payload.theme_mode)
    setEffectiveThemePresetId(payload.effective_theme_preset_id)
    setEffectiveThemeMode(payload.effective_theme_mode)
    setThemeLocked(payload.theme_locked)
    setAvailableThemes(payload.available_themes?.length ? payload.available_themes : fallbackThemePresets)
  }

  async function persistCharacterSettings(partial?: Partial<SettingsPayload>): Promise<SettingsPayload | null> {
    if (!token) {
      return null
    }
    setCharacterStatus("Saving character settings...")
    try {
      const payload = await fetchJson<SettingsPayload>(
        "/api/settings/character",
        {
          method: "PUT",
          body: JSON.stringify({
            character_enabled: partial?.character_enabled ?? characterEnabled,
            active_character_id: partial?.active_character_id ?? activeCharacterId,
            user_prompt: partial?.user_prompt ?? userPromptText,
            care_profile_id: partial?.care_profile_id ?? careProfileId,
            character_customizations: partial?.character_customizations ?? characterCustomizations,
          }),
        },
        token
      )
      setCharacterEnabled(payload.character_enabled)
      setActiveCharacterId(payload.active_character_id)
      setUserPromptText(payload.user_prompt)
      setCareProfileId(payload.care_profile_id)
      setCareProfiles(payload.care_profiles)
      setCharacters(payload.characters)
      setCharacterCustomizations(payload.character_customizations)
      if (user?.is_admin && activeView === "admin") {
        await refreshAdminUsers(token)
        if (activeAdminSection === "prompt_lab") {
          await refreshPromptLabAfterPromptChange(user.id)
        }
      }
      setCharacterStatus("Character settings saved.")
      return payload
    } catch (error) {
      setCharacterStatus(error instanceof Error ? error.message : "Character settings save failed.")
      return null
    }
  }

  function openCharacterSettingsPanel() {
    setActiveView("settings")
    setActiveSettingsSection("general")
    setIsMobileSidebarOpen(false)
    setIsProfileMenuOpen(false)
    setIsCharacterMenuOpen(false)
  }

  async function handleCharacterSwitch(characterId: string) {
    if (!token || isCharacterSyncPending || characterId === activeCharacterId) {
      setIsCharacterMenuOpen(false)
      return
    }
    const nextCharacter = characters.find((character) => character.id === characterId) || null
    setIsCharacterSyncPending(true)
    setPendingCharacterName(nextCharacter?.name || "")
    setIsCharacterMenuOpen(false)
    setCharacterStatus(`Compiling ${nextCharacter?.name || "character"}...`)
    try {
      const payload = await persistCharacterSettings({ active_character_id: characterId } as Partial<SettingsPayload>)
      if (!payload) {
        await refreshCharacterSettings(token).catch(() => undefined)
      }
    } finally {
      setIsCharacterSyncPending(false)
      setPendingCharacterName("")
    }
  }

  async function persistProfileSettings() {
    if (!token) {
      return
    }
    setProfileStatus("Saving profile...")
    try {
      const payload = await fetchJson<{ ok: boolean; user: UserRecord }>(
        "/api/settings/profile",
        {
          method: "PUT",
          body: JSON.stringify({
            display_name: profileDisplayNameDraft,
            current_password: currentPasswordDraft || undefined,
            new_password: newPasswordDraft || undefined,
          }),
        },
        token
      )
      setUser(payload.user)
      setProfileDisplayNameDraft(payload.user.display_name)
      setCurrentPasswordDraft("")
      setNewPasswordDraft("")
      setProfileStatus("Profile saved.")
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : "Profile update failed.")
    }
  }

  async function persistGeneralSettings() {
    await persistProfileSettings()
    await persistCharacterSettings()
  }

  async function persistAdminUserCharacterSettings(userId: string) {
    if (!token) {
      return
    }
    const draft = adminUserCharacterDrafts[userId]
    if (!draft) {
      return
    }
    try {
      await fetchJson(
        `/api/admin/users/${userId}/character`,
        {
          method: "PUT",
          body: JSON.stringify({
            care_profile_id: draft.care_profile_id,
            character_enabled: draft.character_enabled,
            assigned_character_id: draft.assigned_character_id,
            can_select_character: draft.can_select_character,
          }),
        },
        token
      )
      await fetchJson(
        `/api/admin/users/${userId}/prompt-overrides`,
        {
          method: "PUT",
          body: JSON.stringify({
            admin_prompt: draft.admin_prompt,
            blocked_topics: [],
          }),
        },
        token
      )
      await refreshAdminUsers(token)
      await refreshPromptLabAfterPromptChange(userId)
      setAdminNotice("User settings saved.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "User settings save failed.")
    }
  }

  async function persistAdminUserThemeSettings(userId: string) {
    if (!token) {
      return
    }
    const draft = adminUserThemeDrafts[userId]
    if (!draft) {
      return
    }
    try {
      const payload = await fetchJson<AdminUsersPayload>(
        `/api/admin/users/${userId}/theme`,
        {
          method: "PUT",
          body: JSON.stringify(draft),
        },
        token
      )
      setAdminUsers(payload.users)
      setAdminUserThemeDrafts((current) => {
        const next = { ...current }
        for (const item of payload.users) {
          next[item.id] = {
            theme_admin_override_enabled: item.theme_admin_override_enabled,
            theme_admin_override_preset_id: item.theme_admin_override_preset_id,
            theme_admin_override_mode: item.theme_admin_override_mode,
          }
        }
        return next
      })
      setAdminNotice("Theme override saved.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Theme override save failed.")
    }
  }

  async function recompileAdminUserPrompt(userId: string) {
    if (!token) {
      return
    }
    try {
      await fetchJson(
        `/api/admin/users/${userId}/compile-prompt`,
        {
          method: "POST",
        },
        token
      )
      await refreshAdminUsers(token)
      await refreshPromptLabAfterPromptChange(userId)
      setAdminNotice("Compact prompt recompiled.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Prompt recompile failed.")
    }
  }

  async function persistAdminAccountSettings(nextAccount: AdminAccountPayload) {
    if (!token) {
      return
    }
    try {
      const payload = await fetchJson<AdminAccountPayload>(
        "/api/admin/account",
        {
          method: "PUT",
          body: JSON.stringify({
            name: nextAccount.name,
            default_character_id: nextAccount.default_character_id,
            character_feature_enabled: nextAccount.character_feature_enabled,
            auto_update_skills: nextAccount.auto_update_skills,
          }),
        },
        token
      )
      setAdminAccount(payload)
      await refreshAdminUsers(token)
      await refreshCharacterSettings(token)
      await refreshPromptLabAfterPromptChange()
      setAdminNotice("Account settings saved.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Account settings save failed.")
    }
  }

  async function persistAdminPromptPolicy(nextPolicy: PromptPolicyPayload) {
    if (!token) {
      return
    }
    try {
      const payload = await fetchJson<PromptPolicyPayload>(
        "/api/admin/prompt-policy",
        {
          method: "PUT",
          body: JSON.stringify({
            core_safety_prompt: nextPolicy.core_safety_prompt,
            account_policy_prompt: nextPolicy.account_policy_prompt,
            proactive_chatter_enabled: nextPolicy.proactive_chatter_enabled,
          }),
        },
        token
      )
      setAdminPromptPolicy(payload)
      await refreshAdminUsers(token)
      await refreshPromptLabAfterPromptChange()
      setAdminNotice("Prompt policy saved.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Prompt policy save failed.")
    }
  }

  function updateCharacterDraft(characterId: string, updates: Partial<CharacterEditorDraft>) {
    setAdminCharacterDrafts((current) => ({
      ...current,
      [characterId]: {
        name: current[characterId]?.name || "",
        description: current[characterId]?.description || "",
        teaser: current[characterId]?.teaser || "",
        phonetic_spelling: current[characterId]?.phonetic_spelling || "",
        logo: current[characterId]?.logo || "",
        system_prompt: current[characterId]?.system_prompt || "",
        identity_key: current[characterId]?.identity_key || "",
        domain: current[characterId]?.domain || "",
        behavior_style: current[characterId]?.behavior_style || "",
        preferred_response_style: current[characterId]?.preferred_response_style || "balanced",
        voice_model: current[characterId]?.voice_model || "",
        character_editor: current[characterId]?.character_editor || {},
        default_voice: current[characterId]?.default_voice || "",
        default_voice_download_url: current[characterId]?.default_voice_download_url || "",
        default_voice_config_download_url: current[characterId]?.default_voice_config_download_url || "",
        default_voice_source_name: current[characterId]?.default_voice_source_name || "",
        default_voice_config_source_name: current[characterId]?.default_voice_config_source_name || "",
        default_voice_upload_data_url: current[characterId]?.default_voice_upload_data_url || "",
        default_voice_config_upload_data_url: current[characterId]?.default_voice_config_upload_data_url || "",
        wakeword_model_id: current[characterId]?.wakeword_model_id || "",
        wakeword_download_url: current[characterId]?.wakeword_download_url || "",
        wakeword_source_name: current[characterId]?.wakeword_source_name || "",
        wakeword_upload_data_url: current[characterId]?.wakeword_upload_data_url || "",
        ...updates,
      },
    }))
  }

  async function persistAdminCharacterDraft(characterId: string) {
    if (!token) {
      return
    }
    const character = characters.find((entry) => entry.id === characterId)
    const draft = adminCharacterDrafts[characterId]
    if (!character || !draft || !character.installed) {
      return
    }
    try {
      const payload = await fetchJson<{ character: CharacterDefinition; installed: CharacterDefinition[]; available: CharacterDefinition[] }>(
        `/api/characters/${characterId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: draft.name,
            description: draft.description,
            teaser: draft.teaser,
            phonetic_spelling: draft.phonetic_spelling,
            logo: draft.logo,
            system_prompt: draft.system_prompt,
            identity_key: draft.identity_key,
            domain: draft.domain,
            behavior_style: draft.behavior_style,
            preferred_response_style: draft.preferred_response_style,
            voice_model: draft.voice_model,
            default_voice: draft.default_voice,
            default_voice_download_url: draft.default_voice_download_url,
            default_voice_config_download_url: draft.default_voice_config_download_url,
            default_voice_source_name: draft.default_voice_source_name,
            default_voice_config_source_name: draft.default_voice_config_source_name,
            default_voice_upload_data_url: draft.default_voice_upload_data_url,
            default_voice_config_upload_data_url: draft.default_voice_config_upload_data_url,
            wakeword_model_id: draft.wakeword_model_id,
            wakeword_download_url: draft.wakeword_download_url,
            wakeword_source_name: draft.wakeword_source_name,
            wakeword_upload_data_url: draft.wakeword_upload_data_url,
            character_editor: buildPersistedCharacterEditorMetadata(draft),
          }),
        },
        token
      )
      setCharacters(payload.available)
      setAdminCharacterDrafts(() => {
        const next: Record<string, CharacterEditorDraft> = {}
        for (const item of payload.available) {
          next[item.id] = buildCharacterEditorDraft(item)
        }
        return next
      })
      await refreshCharacterSettings(token)
      if (user?.is_admin) {
        await refreshAdminCharacterData(token)
        await refreshAdminUsers(token)
        await refreshPromptLabAfterPromptChange()
      }
      setAdminNotice(`Character "${payload.character.name}" settings saved.`)
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character settings save failed.")
    }
  }

  async function readLogoFile(file: File): Promise<string> {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
      reader.onerror = () => reject(new Error("Logo upload failed."))
      reader.readAsDataURL(file)
    })
  }

  async function readTextFile(file: File): Promise<string> {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
      reader.onerror = () => reject(new Error("File upload failed."))
      reader.readAsText(file)
    })
  }

  async function handleCustomVoiceUpload(kind: "model" | "config", event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) {
      return
    }
    try {
      const dataUrl = await readLogoFile(file)
      if (kind === "model") {
        setCustomVoiceModelDataUrlDraft(dataUrl)
        setCustomVoiceModelSourceNameDraft(file.name)
        setCustomVoiceUrlDraft("")
      } else {
        setCustomVoiceConfigDataUrlDraft(dataUrl)
        setCustomVoiceConfigSourceNameDraft(file.name)
        setCustomVoiceConfigUrlDraft("")
      }
      setAdminNotice(`Custom voice ${kind} loaded.`)
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : `Custom voice ${kind} upload failed.`)
    }
  }

  async function installCharacter(characterId: string) {
    if (!token) {
      return
    }
    try {
      await fetchJson("/api/characters/install", {
        method: "POST",
        body: JSON.stringify({ character_id: characterId }),
      }, token)
      await refreshCharacterSettings(token)
      if (user?.is_admin) {
        await refreshAdminCharacterData(token)
        await refreshAdminUsers(token)
        await refreshPromptLabAfterPromptChange()
      }
      setAdminNotice("Character catalog refreshed.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character install failed.")
    }
  }

  async function exportCharacter(character: CharacterDefinition) {
    if (!token) {
      return
    }
    try {
      const payload = await fetchJson<{ package: CharacterPackage }>(`/api/characters/${character.id}/export`, {}, token)
      const blob = new Blob([JSON.stringify(payload.package, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${character.id}.lokidoki-character.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setAdminNotice("Character exported.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character export failed.")
    }
  }

  async function publishCharacter(character: CharacterDefinition) {
    if (!token) {
      return
    }
    try {
      const payload = await fetchJson<{
        published: {
          repo_path: string
          source_dir: string
          manifest_path: string
          published_package_path: string
        }
      }>(
        `/api/characters/${character.id}/publish`,
        {
          method: "POST",
        },
        token
      )
      setAdminNotice(`Published "${character.name}" to loki-doki-characters: ${payload.published.source_dir}`)
      await refreshAdminCharacterData(token)
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character publish failed.")
    }
  }

  async function handleCharacterImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || !token) {
      return
    }
    try {
      const text = await readTextFile(file)
      const parsed = JSON.parse(text) as CharacterPackage
      const payload = await fetchJson<{ installed: CharacterDefinition[]; available: CharacterDefinition[] }>(
        "/api/characters/import",
        {
          method: "POST",
          body: JSON.stringify({ package: parsed }),
        },
        token
      )
      setCharacters(payload.available)
      setAdminCharacterDrafts(() => {
        const next: Record<string, CharacterEditorDraft> = {}
        for (const character of payload.available) {
          next[character.id] = buildCharacterEditorDraft(character)
        }
        return next
      })
      await refreshCharacterSettings(token)
      if (user?.is_admin) {
        await refreshAdminCharacterData(token)
        await refreshAdminUsers(token)
        await refreshPromptLabAfterPromptChange()
      }
      setAdminNotice("Character imported.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character import failed.")
    }
  }

  async function createCharacterDraft() {
    openCharacterEditor()
  }

  function buildCharacterImportPackage(bundle: CharacterEditorBundle): CharacterPackage {
    const resolvedCharacterId = (bundle.character_id || "").trim()
    const existingCharacter = characters.find((entry) => entry.id === resolvedCharacterId) || null
    const existingDraft = existingCharacter ? adminCharacterDrafts[existingCharacter.id] || null : null
    const uploadedVoiceModel = bundle.editor_state?.default_voice_upload_data_url?.trim() || ""
    const uploadedVoiceConfig = bundle.editor_state?.default_voice_config_upload_data_url?.trim() || ""
    const uploadedVoiceSourceName = bundle.editor_state?.default_voice_source_name?.trim() || ""
    const uploadedVoiceConfigSourceName = bundle.editor_state?.default_voice_config_source_name?.trim() || ""
    const resolvedId =
      resolvedCharacterId ||
      slugifyCharacterId(
        [
          bundle.editor_state?.name?.trim() ||
          bundle.manifest?.primary_name?.trim() ||
          "character",
          bundle.manifest?.identity_key?.trim() ||
          bundle.identity_key ||
          "lokidoki",
        ].join("_")
      )
    const resolvedName =
      bundle.manifest?.primary_name?.trim() ||
      bundle.editor_state?.name?.trim() ||
      existingDraft?.name?.trim() ||
      existingCharacter?.name ||
      "New Character"
    const resolvedPrompt =
      bundle.manifest?.behavior_style?.trim() ||
      bundle.editor_state?.persona_prompt?.trim() ||
      existingDraft?.system_prompt?.trim() ||
      existingCharacter?.system_prompt ||
      "You are a LokiDoki character created in the character editor. Respond clearly, warmly, and stay in character."
    const resolvedPreferredResponseStyle =
      bundle.manifest?.preferred_response_style?.trim() ||
      bundle.editor_state?.preferred_response_style?.trim() ||
      existingDraft?.preferred_response_style?.trim() ||
      existingCharacter?.preferred_response_style?.trim() ||
      "balanced"
    const resolvedVoice =
      bundle.manifest?.voice_model?.trim() ||
      bundle.editor_state?.voice_model?.trim() ||
      existingDraft?.default_voice?.trim() ||
      existingCharacter?.default_voice ||
      ""
    const resolvedDomain = bundle.manifest?.domain?.trim() || bundle.identity_key?.trim() || "lokidoki"
    const resolvedStyle = bundle.editor_state?.style?.trim() || "avataaars"
    const resolvedDescription =
      bundle.editor_state?.description?.trim() ||
      existingDraft?.description?.trim() ||
      existingCharacter?.description ||
      `DiceBear-based LokiDoki character created in the character editor (${resolvedDomain}).`
    const resolvedTeaser =
      bundle.editor_state?.teaser?.trim() ||
      bundle.manifest?.teaser?.trim() ||
      existingDraft?.teaser?.trim() ||
      existingCharacter?.teaser ||
      ""
    const resolvedPhoneticSpelling =
      bundle.editor_state?.phonetic_spelling?.trim() ||
      bundle.manifest?.phonetic_spelling?.trim() ||
      existingDraft?.phonetic_spelling?.trim() ||
      existingCharacter?.phonetic_spelling ||
      ""

    return {
      format: "lokidoki-character-package",
      character: {
        id: resolvedId,
        name: resolvedName,
        version: existingCharacter?.version || "2.0.0",
        description: resolvedDescription,
        teaser: resolvedTeaser,
        phonetic_spelling: resolvedPhoneticSpelling,
        logo: bundle.logo_data_url || existingDraft?.logo || existingCharacter?.logo || "/lokidoki-logo.svg",
        system_prompt: resolvedPrompt,
        identity_key: (bundle.manifest?.identity_key || bundle.identity_key || resolvedId).trim() || resolvedId,
        domain: resolvedDomain,
        behavior_style: resolvedPrompt,
        preferred_response_style: resolvedPreferredResponseStyle,
        voice_model: resolvedVoice,
        default_voice: resolvedVoice,
        default_voice_download_url: existingDraft?.default_voice_download_url || existingCharacter?.default_voice_download_url || "",
        default_voice_config_download_url:
          existingDraft?.default_voice_config_download_url || existingCharacter?.default_voice_config_download_url || "",
        default_voice_source_name:
          uploadedVoiceSourceName || existingDraft?.default_voice_source_name || existingCharacter?.default_voice_source_name || "",
        default_voice_config_source_name:
          uploadedVoiceConfigSourceName || existingDraft?.default_voice_config_source_name || existingCharacter?.default_voice_config_source_name || "",
        default_voice_upload_data_url: uploadedVoiceModel || existingDraft?.default_voice_upload_data_url || "",
        default_voice_config_upload_data_url: uploadedVoiceConfig || existingDraft?.default_voice_config_upload_data_url || "",
        wakeword_model_id:
          bundle.editor_state?.wakeword_model_id?.trim() ||
          bundle.manifest?.wakeword_model?.trim() ||
          existingDraft?.wakeword_model_id ||
          existingCharacter?.wakeword_model_id ||
          "",
        wakeword_download_url: existingDraft?.wakeword_download_url || existingCharacter?.wakeword_download_url || "",
        wakeword_source_name:
          bundle.editor_state?.wakeword_source_name?.trim() ||
          existingDraft?.wakeword_source_name ||
          existingCharacter?.wakeword_source_name ||
          "",
        wakeword_upload_data_url: bundle.editor_state?.wakeword_upload_data_url?.trim() || "",
        enabled: existingCharacter?.enabled ?? true,
        capabilities: {
          editor: "character_editor",
          renderer: "dicebear",
          domain: resolvedStyle,
        },
        character_editor: {
          source: "loki-doki-character-editor",
          exported_at: new Date().toISOString(),
          editor_state: bundle.editor_state || {},
        },
      },
    }
  }

  async function importCharacterEditorBundle(bundle: CharacterEditorBundle, publishAfterSave = false) {
    if (!token) {
      return
    }
    try {
      const selectedVoiceId = String(
        bundle.manifest?.voice_model?.trim() ||
        bundle.editor_state?.voice_model?.trim() ||
        ""
      ).trim()
      if (selectedVoiceId) {
        let selectedVoice = adminVoices.find((voice) => voice.id === selectedVoiceId) || null
        if (!selectedVoice && user?.is_admin) {
          const voicePayload = await fetchJson<{ voices: AdminVoiceRecord[] }>("/api/admin/voices", {}, token)
          setAdminVoices(voicePayload.voices)
          selectedVoice = voicePayload.voices.find((voice) => voice.id === selectedVoiceId) || null
        }
        if (selectedVoice && !selectedVoice.installed) {
          setAdminNotice(`Installing voice "${selectedVoice.label}" before save...`)
          if (selectedVoice.custom) {
            if (!selectedVoice.source_url.trim()) {
              throw new Error(`Voice "${selectedVoice.label}" is not installed locally and cannot be auto-installed because it was uploaded from local files.`)
            }
            const voicePayload = await fetchJson<{ voices: AdminVoiceRecord[] }>(
              `/api/admin/voices/${selectedVoice.id}/reinstall`,
              { method: "POST" },
              token
            )
            setAdminVoices(voicePayload.voices)
          } else {
            await fetchJson<{ ok: boolean; voice_id: string }>(
              "/api/voices/piper/install",
              {
                method: "POST",
                body: JSON.stringify({ voice_id: selectedVoice.id }),
              },
              token
            )
            if (user?.is_admin) {
              const voicePayload = await fetchJson<{ voices: AdminVoiceRecord[] }>("/api/admin/voices", {}, token)
              setAdminVoices(voicePayload.voices)
            }
          }
          await refreshVoices(token)
        }
      }
      const existingCharacterId = (bundle.character_id || "").trim()
      const existingCharacter = existingCharacterId
        ? characters.find((entry) => entry.id === existingCharacterId) || null
        : null
      const payload = existingCharacter
        ? await fetchJson<{ character: CharacterDefinition; installed: CharacterDefinition[]; available: CharacterDefinition[] }>(
            `/api/characters/${existingCharacter.id}`,
            {
              method: "PUT",
              body: JSON.stringify({
                name:
                  bundle.editor_state?.name?.trim() ||
                  bundle.manifest?.primary_name?.trim() ||
                  existingCharacter.name,
                description:
                  bundle.editor_state?.description?.trim() ||
                  existingCharacter.description ||
                  "",
                teaser:
                  bundle.editor_state?.teaser?.trim() ||
                  existingCharacter.teaser ||
                  "",
                phonetic_spelling:
                  bundle.editor_state?.phonetic_spelling?.trim() ||
                  bundle.manifest?.phonetic_spelling?.trim() ||
                  existingCharacter.phonetic_spelling ||
                  "",
                logo: bundle.logo_data_url || existingCharacter.logo || "",
                system_prompt:
                  bundle.editor_state?.persona_prompt?.trim() ||
                  existingCharacter.system_prompt ||
                  "",
                identity_key:
                  bundle.manifest?.identity_key?.trim() ||
                  existingCharacter.identity_key ||
                  existingCharacter.id,
                domain:
                  bundle.manifest?.domain?.trim() ||
                  bundle.identity_key?.trim() ||
                  existingCharacter.domain ||
                  "lokidoki",
                behavior_style:
                  bundle.manifest?.behavior_style?.trim() ||
                  bundle.editor_state?.persona_prompt?.trim() ||
                  existingCharacter.behavior_style ||
                  existingCharacter.system_prompt ||
                  "",
                preferred_response_style:
                  bundle.manifest?.preferred_response_style?.trim() ||
                  bundle.editor_state?.preferred_response_style?.trim() ||
                  adminCharacterDrafts[existingCharacter.id]?.preferred_response_style ||
                  existingCharacter.preferred_response_style ||
                  "balanced",
                voice_model:
                  bundle.manifest?.voice_model?.trim() ||
                  bundle.editor_state?.voice_model?.trim() ||
                  existingCharacter.voice_model ||
                  existingCharacter.default_voice ||
                  "",
                default_voice:
                  bundle.editor_state?.voice_model?.trim() ||
                  existingCharacter.default_voice ||
                  "",
                wakeword_model_id:
                  bundle.editor_state?.wakeword_model_id?.trim() ||
                  existingCharacter.wakeword_model_id ||
                  "",
                wakeword_source_name:
                  bundle.editor_state?.wakeword_source_name?.trim() ||
                  existingCharacter.wakeword_source_name ||
                  "",
                wakeword_upload_data_url:
                  bundle.editor_state?.wakeword_upload_data_url?.trim() ||
                  "",
                character_editor: {
                  ...(existingCharacter.character_editor || {}),
                  source: "loki-doki-character-editor",
                  exported_at: new Date().toISOString(),
                  editor_state: bundle.editor_state || {},
                },
              }),
            },
            token
          )
        : await fetchJson<{ character: CharacterDefinition; installed: CharacterDefinition[]; available: CharacterDefinition[] }>(
            "/api/characters/import",
            {
              method: "POST",
              body: JSON.stringify({ package: buildCharacterImportPackage(bundle) }),
            },
            token
          )
      setCharacters(payload.available)
      setAdminCharacterDrafts(() => {
        const next: Record<string, CharacterEditorDraft> = {}
        for (const character of payload.available) {
          next[character.id] = buildCharacterEditorDraft(character)
        }
        return next
      })
      await refreshCharacterSettings(token)
      if (user?.is_admin) {
        await refreshAdminCharacterData(token)
        await refreshAdminUsers(token)
        await refreshPromptLabAfterPromptChange()
      }
      setAdminCharacterSearch(payload.character.name)
      const nextDraft = buildCharacterEditorDraft(payload.character)
      const params = new URLSearchParams()
      params.set("embedded", "1")
      params.set("character_id", payload.character.id)
      params.set("identity_key", payload.character.identity_key || payload.character.id)
      params.set("style", characterEditorStyle(payload.character))
      params.set("name", nextDraft.name || payload.character.name)
      params.set("description", nextDraft.description || payload.character.description || "")
      params.set("teaser", nextDraft.teaser || payload.character.teaser || "")
      params.set("phonetic_spelling", nextDraft.phonetic_spelling || payload.character.phonetic_spelling || "")
      params.set("persona_prompt", nextDraft.system_prompt || payload.character.behavior_style || payload.character.system_prompt || "")
      params.set("preferred_response_style", nextDraft.preferred_response_style || payload.character.preferred_response_style || "balanced")
      params.set("voice_model", nextDraft.default_voice || payload.character.voice_model || payload.character.default_voice || "en-us-lessac-medium.onnx")
      const serializedEditorState = serializeEditorState(asRecord(payload.character.character_editor)?.editor_state as Record<string, unknown> | undefined)
      if (serializedEditorState) {
        params.set("editor_state", serializedEditorState)
      }
      setCharacterEditorUrl(buildCharacterEditorUrl(params, effectiveThemePresetId, effectiveThemeMode))
      setIsCharacterEditorOpen(true)
      if (publishAfterSave) {
        await publishCharacter(payload.character)
      } else {
        setAdminNotice(`Character "${payload.character.name}" saved.`)
      }
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character save failed.")
    }
  }

  function openCharacterEditor(characterId?: string) {
    const character = characterId ? characters.find((entry) => entry.id === characterId) || null : null
    const draft = character ? adminCharacterDrafts[character.id] || null : null
    const params = new URLSearchParams()
    params.set("embedded", "1")
    if (character) {
      params.set("character_id", character.id)
      params.set("identity_key", character.identity_key || character.id)
      params.set("style", characterEditorStyle(character))
      params.set("name", draft?.name || character.name)
      params.set("description", draft?.description || character.description || "")
      params.set("teaser", draft?.teaser || character.teaser || "")
      params.set("phonetic_spelling", draft?.phonetic_spelling || character.phonetic_spelling || "")
      params.set("persona_prompt", draft?.system_prompt || character.behavior_style || character.system_prompt || "")
      params.set("preferred_response_style", draft?.preferred_response_style || character.preferred_response_style || "balanced")
      params.set("voice_model", draft?.default_voice || character.voice_model || character.default_voice || "en-us-lessac-medium.onnx")
      const serializedEditorState = serializeEditorState(buildCharacterEditorLaunchState(character, draft))
      if (serializedEditorState) {
        params.set("editor_state", serializedEditorState)
      }
    }
    const url = buildCharacterEditorUrl(params, effectiveThemePresetId, effectiveThemeMode)
    setActiveView("admin")
    setActiveAdminSection("characters")
    setCharacterEditorUrl(url)
    setIsCharacterEditorOpen(true)
  }

  async function persistCareProfile() {
    if (!token) {
      return
    }
    try {
      const payload = await fetchJson<{ profile: CareProfile; profiles: CareProfile[] }>(
        "/api/admin/care-profiles",
        {
          method: "PUT",
          body: JSON.stringify({
            ...careProfileDraft,
            blocked_topics: careProfileDraft.blocked_topics,
          }),
        },
        token
      )
      setAdminCareProfiles(payload.profiles)
      setCareProfiles(payload.profiles)
      setCareProfileDraft(payload.profile)
      await refreshAdminUsers(token)
      await refreshPromptLabAfterPromptChange()
      setAdminNotice("Care profile saved.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Care profile save failed.")
    }
  }

  async function toggleCharacterCatalogEntry(characterId: string, enabled: boolean) {
    if (!token) {
      return
    }
    try {
      await fetchJson(`/api/characters/${characterId}/${enabled ? "enable" : "disable"}`, { method: "POST" }, token)
      await refreshCharacterSettings(token)
      if (user?.is_admin) {
        await refreshAdminCharacterData(token)
        await refreshAdminUsers(token)
        await refreshPromptLabAfterPromptChange()
      }
      setAdminNotice(`Character ${enabled ? "enabled" : "disabled"}.`)
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character update failed.")
    }
  }

  async function deleteCharacter(characterId: string, name: string) {
    if (!token || !window.confirm(`Delete character "${name}"?`)) {
      return
    }
    try {
      const payload = await fetchJson<{ installed: CharacterDefinition[]; available: CharacterDefinition[] }>(
        `/api/characters/${characterId}`,
        { method: "DELETE" },
        token
      )
      setCharacters(payload.available)
      setAdminCharacterDrafts(() => {
        const next: Record<string, CharacterEditorDraft> = {}
        for (const character of payload.available) {
          next[character.id] = buildCharacterEditorDraft(character)
        }
        return next
      })
      await refreshCharacterSettings(token)
      if (user?.is_admin) {
        await refreshAdminCharacterData(token)
        await refreshAdminUsers(token)
        await refreshPromptLabAfterPromptChange()
      }
      setAdminNotice(`Character "${name}" deleted.`)
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Character delete failed.")
    }
  }

  function updateSkillContextDraft(skillId: string, key: string, value: unknown) {
    setSkillContextDrafts((current) => ({
      ...current,
      [skillId]: {
        ...(current[skillId] || {}),
        [key]: value,
      },
    }))
  }

  function updateSkillAccountContextDraft(skillId: string, accountId: string, key: string, value: unknown) {
    setSkillAccountContextDrafts((current) => ({
      ...current,
      [skillId]: {
        ...(current[skillId] || {}),
        [accountId]: {
          ...((current[skillId] || {})[accountId] || {}),
          [key]: value,
        },
      },
    }))
  }

  function updateSkillNewAccountLabel(skillId: string, value: string) {
    setSkillNewAccountLabels((current) => ({
      ...current,
      [skillId]: value,
    }))
  }

  function updateSkillNewAccountDefault(skillId: string, value: boolean) {
    setSkillNewAccountDefaults((current) => ({
      ...current,
      [skillId]: value,
    }))
  }

  async function persistSkillContext(skillId: string) {
    setSkillContextStatusBySkill((current) => ({ ...current, [skillId]: "" }))
    if (!token) {
      return
    }
    setSavingSkillId(skillId)
    try {
      const payload = await fetchJson<{ ok: boolean; values: Record<string, unknown> }>(
        `/api/skills/${skillId}/context`,
        {
          method: "POST",
          body: JSON.stringify({
            values: skillContextDrafts[skillId] || {},
          }),
        },
        token
      )
      setSkillContextDrafts((current) => ({
        ...current,
        [skillId]: payload.values,
      }))
      setSkillContextStatusBySkill((current) => ({ ...current, [skillId]: "Skill context saved." }))
      await refreshSkills(token)
    } catch (error) {
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skillId]: error instanceof Error ? error.message : "Skill context save failed.",
      }))
      throw error
    } finally {
      setSavingSkillId("")
    }
  }

  async function installSkill(skillId: string) {
    if (!token) {
      return
    }
    setIsSkillMutationPending(true)
    setChatError("")
    try {
      await fetchJson<{ ok: boolean }>("/api/skills/install", {
        method: "POST",
        body: JSON.stringify({ skill_id: skillId }),
      }, token)
      await refreshSkills(token)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Skill install failed.")
    } finally {
      setIsSkillMutationPending(false)
    }
  }

  async function refreshAdminSkills() {
    if (!token) {
      return
    }
    setIsRefreshingSkills(true)
    try {
      await refreshSkills(token)
    } finally {
      setIsRefreshingSkills(false)
    }
  }

  async function uninstallSkill(skillId: string) {
    if (!token) {
      return
    }
    setIsSkillMutationPending(true)
    try {
      await fetchJson(`/api/skills/${skillId}`, { method: "DELETE" }, token)
      await refreshSkills(token)
      setAdminNotice("Skill uninstalled.")
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Skill uninstall failed.")
    } finally {
      setIsSkillMutationPending(false)
    }
  }

  async function persistSkillAccountContext(skill: InstalledSkill, account: SkillAccount) {
    if (!token) {
      return
    }
    setIsSkillMutationPending(true)
    try {
      await fetchJson<{ ok: boolean; accounts: SkillAccount[] }>(
        `/api/skills/${skill.skill_id}/accounts`,
        {
          method: "POST",
          body: JSON.stringify({
            account_id: account.id,
            label: account.label,
            config: account.config,
            context: (skillAccountContextDrafts[skill.skill_id] || {})[account.id] || {},
            enabled: account.enabled,
            is_default: account.is_default,
          }),
        },
        token
      )
      await refreshSkills(token)
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: `${skill.title} account context saved.`,
      }))
    } catch (error) {
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: error instanceof Error ? error.message : "Account context save failed.",
      }))
    } finally {
      setIsSkillMutationPending(false)
    }
  }

  async function createSkillAccount(skill: InstalledSkill) {
    if (!token) {
      return
    }
    const label = (skillNewAccountLabels[skill.skill_id] || "").trim()
    if (!label) {
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: "Enter an account label first.",
      }))
      return
    }
    setIsSkillMutationPending(true)
    try {
      await fetchJson<{ ok: boolean; accounts: SkillAccount[] }>(
        `/api/skills/${skill.skill_id}/accounts`,
        {
          method: "POST",
          body: JSON.stringify({
            label,
            config: {},
            context: (skillAccountContextDrafts[skill.skill_id] || {}).__new__ || {},
            enabled: true,
            is_default: Boolean(skillNewAccountDefaults[skill.skill_id]),
          }),
        },
        token
      )
      setSkillNewAccountLabels((current) => ({ ...current, [skill.skill_id]: "" }))
      setSkillNewAccountDefaults((current) => ({ ...current, [skill.skill_id]: false }))
      setSkillAccountContextDrafts((current) => ({
        ...current,
        [skill.skill_id]: {
          ...(current[skill.skill_id] || {}),
          __new__: {},
        },
      }))
      await refreshSkills(token)
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: `${skill.title} account saved.`,
      }))
    } catch (error) {
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: error instanceof Error ? error.message : "Account create failed.",
      }))
    } finally {
      setIsSkillMutationPending(false)
    }
  }

  async function makeSkillAccountDefault(skill: InstalledSkill, account: SkillAccount) {
    if (!token) {
      return
    }
    setIsSkillMutationPending(true)
    try {
      await fetchJson<{ ok: boolean; accounts: SkillAccount[] }>(
        `/api/skills/${skill.skill_id}/accounts`,
        {
          method: "POST",
          body: JSON.stringify({
            account_id: account.id,
            label: account.label,
            config: account.config,
            context: (skillAccountContextDrafts[skill.skill_id] || {})[account.id] || account.context,
            enabled: account.enabled,
            is_default: true,
          }),
        },
        token
      )
      await refreshSkills(token)
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: `${account.label} is now the default account.`,
      }))
    } catch (error) {
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: error instanceof Error ? error.message : "Default account update failed.",
      }))
    } finally {
      setIsSkillMutationPending(false)
    }
  }

  async function testSkillAccountConnection(skill: InstalledSkill, account: SkillAccount) {
    if (!token) {
      return
    }
    setTestingSkillAccountId(account.id)
    setSkillContextStatusBySkill((current) => ({ ...current, [skill.skill_id]: "" }))
    try {
      const payload = await fetchJson<{ ok: boolean; result: { detail: string }; installed: InstalledSkill[] }>(
        `/api/skills/${skill.skill_id}/accounts/${account.id}/test`,
        { method: "POST" },
        token
      )
      setInstalledSkills(payload.installed)
      setSkillContextDrafts(
        payload.installed.reduce<Record<string, Record<string, unknown>>>((accumulator, installedSkill) => {
          accumulator[installedSkill.skill_id] = { ...installedSkill.shared_context }
          return accumulator
        }, {})
      )
      setSkillAccountContextDrafts(
        payload.installed.reduce<Record<string, Record<string, Record<string, unknown>>>>((accumulator, installedSkill) => {
          accumulator[installedSkill.skill_id] = installedSkill.accounts.reduce<Record<string, Record<string, unknown>>>((accountAccumulator, item) => {
            accountAccumulator[item.id] = { ...item.context }
            return accountAccumulator
          }, {})
          return accumulator
        }, {})
      )
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: payload.result.detail || `${account.label} test completed.`,
      }))
    } catch (error) {
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: error instanceof Error ? error.message : "Connection test failed.",
      }))
    } finally {
      setTestingSkillAccountId("")
    }
  }

  async function testSkill(skill: InstalledSkill) {
    const targetAccount = skill.accounts.find((account) => account.is_default) || skill.accounts[0] || null
    if (skill.account_context_fields.length > 0) {
      if (!targetAccount) {
        setExpandedSkillDetails((current) => ({ ...current, [skill.skill_id]: true }))
        setSkillContextStatusBySkill((current) => ({
          ...current,
          [skill.skill_id]: "Add and save an account before testing this skill.",
        }))
        return
      }
      await testSkillAccountConnection(skill, targetAccount)
      return
    }
    setAdminSkillTab("test")
    setSkillRouteDecision(null)
    setSkillTestResult(null)
    setSkillTestError("")
    setSkillProbe(skill.skill_id === "weather" ? "what's the weather in Milford, CT today?" : `test ${skill.title}`)
  }

  async function saveSkillDetails(skill: InstalledSkill) {
    setSkillContextStatusBySkill((current) => ({ ...current, [skill.skill_id]: "" }))
    if (!token) {
      return
    }
    try {
      if (skill.shared_context_fields.length > 0) {
        await persistSkillContext(skill.skill_id)
      }
      if (skill.account_context_fields.length > 0) {
        for (const account of skill.accounts) {
          await persistSkillAccountContext(skill, account)
        }
      }
      setExpandedSkillDetails((current) => ({ ...current, [skill.skill_id]: false }))
      setSkillContextStatusBySkill((current) => ({
        ...current,
        [skill.skill_id]: `${skill.title} saved.`,
      }))
    } catch {
      // The nested save helpers already publish the error state we want.
    }
  }

  async function toggleSkillEnabled(skillId: string, enabled: boolean) {
    if (!token) {
      return
    }
    setIsSkillMutationPending(true)
    setChatError("")
    try {
      await fetchJson<{ ok: boolean }>(`/api/skills/${skillId}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
      }, token)
      await refreshSkills(token)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Skill update failed.")
    } finally {
      setIsSkillMutationPending(false)
    }
  }

  async function inspectSkillRoute() {
    if (!token || !skillProbe.trim()) {
      return
    }
    setIsSkillInspectPending(true)
    setChatError("")
    setSkillTestError("")
    try {
      const payload = await fetchJson<SkillRouteDecision>("/api/skills/inspect-route", {
        method: "POST",
        body: JSON.stringify({ message: skillProbe }),
      }, token)
      setSkillRouteDecision(payload)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Skill route inspection failed.")
    } finally {
      setIsSkillInspectPending(false)
    }
  }

  async function testSkillRoute() {
    if (!token || !skillProbe.trim()) {
      return
    }
    setIsSkillTestPending(true)
    setChatError("")
    setSkillTestError("")
    setSkillTestResult(null)
    try {
      const payload = await fetchJson<SkillTestPayload>(
        "/api/skills/test",
        {
          method: "POST",
          body: JSON.stringify({ message: skillProbe.trim() }),
        },
        token
      )
      setSkillTestResult(payload)
    } catch (error) {
      setSkillTestError(error instanceof Error ? error.message : "Skill test failed.")
    } finally {
      setIsSkillTestPending(false)
    }
  }

  async function runPromptLab() {
    if (!token || !promptLabUserId || !promptLabMessage.trim()) {
      return
    }
    setIsPromptLabPending(true)
    setPromptLabError("")
    try {
      const payload = await fetchJson<PromptLabPayload>(
        "/api/admin/prompt-lab",
        {
          method: "POST",
          body: JSON.stringify({
            user_id: promptLabUserId,
            message: promptLabMessage.trim(),
            use_skills: promptLabUseSkills,
            enabled_layers: promptLabLayers,
            layer_overrides: promptLabLayerDrafts,
          }),
        },
        token
      )
      setPromptLabResult(payload)
    } catch (error) {
      setPromptLabError(error instanceof Error ? error.message : "Prompt lab failed.")
      setPromptLabResult(null)
    } finally {
      setIsPromptLabPending(false)
    }
  }

  async function persistDebugMode(nextDebugMode: boolean) {
    setDebugMode(nextDebugMode)
    setIsDebugOpen(nextDebugMode)
    if (!token) {
      return
    }
    const payload = await fetchJson<SettingsPayload>(
      "/api/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          theme_preset_id: themePresetId,
          theme_mode: themeMode,
          debug_mode: nextDebugMode,
          voice_reply_enabled: voiceReplyEnabled,
          voice_source: voiceSource,
          browser_voice_uri: selectedVoiceURI,
          piper_voice_id: selectedPiperVoiceId,
          barge_in_enabled: bargeInEnabled,
        }),
      },
      token
    )
    setDebugMode(payload.debug_mode)
    setIsDebugOpen((current) => (payload.debug_mode ? current || nextDebugMode : false))
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }
    event.preventDefault()
    if ((!prompt.trim() && !selectedImage && !selectedVideo && !selectedDocument) || !token || isSubmitting || isCharacterSyncPending) {
      return
    }
    void sendPrompt()
  }

  async function handleImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      const prepared = await prepareImageUpload(file)
      setSelectedImage(prepared)
      setSelectedVideo(null)
      setSelectedDocument(null)
      setIsAttachmentMenuOpen(false)
      setChatError("")
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Image upload failed.")
    } finally {
      event.target.value = ""
    }
  }

  async function handleVideoSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      const prepared = await prepareVideoUpload(file)
      setSelectedVideo(prepared)
      setSelectedImage(null)
      setSelectedDocument(null)
      setIsAttachmentMenuOpen(false)
      setChatError("")
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Video upload failed.")
    } finally {
      event.target.value = ""
    }
  }

  async function handleDocumentSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      const prepared = await prepareDocumentUpload(file)
      setSelectedDocument(prepared)
      setSelectedImage(null)
      setSelectedVideo(null)
      setIsAttachmentMenuOpen(false)
      setChatError("")
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Document upload failed.")
    } finally {
      event.target.value = ""
    }
  }

  function handleMessageScroll() {
    const viewport = messageViewportRef.current
    if (!viewport) {
      return
    }
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    setIsPinnedToBottom(distanceFromBottom < 120)
  }

  function jumpToLatest() {
    const viewport = messageViewportRef.current
    if (!viewport) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
    forceScrollRef.current = false
    setIsPinnedToBottom(true)
  }

  const errorCapabilities = health?.capabilities.filter((item) => item.status === "error") || []
  const warnCapabilities = health?.capabilities.filter((item) => item.status === "warn") || []
  const topIssues = [...errorCapabilities, ...warnCapabilities].slice(0, 3)
  const primaryIssue = topIssues[0]
  const selectedPiperVoice = piperVoices.find((voice) => voice.id === selectedPiperVoiceId) || null
  const selectedCharacter = characters.find((item) => item.id === activeCharacterId) || null

  const characterContextValue = useMemo(() => ({
    options: {
      style: (selectedCharacter?.character_editor as any)?.editor_state?.style || "avataaars",
      seed: (selectedCharacter?.character_editor as any)?.editor_state?.seed || selectedCharacter?.name || "Character",
      flip: (selectedCharacter?.character_editor as any)?.editor_state?.flip || false,
      rotate: (selectedCharacter?.character_editor as any)?.editor_state?.rotate || 0,
      scale: (selectedCharacter?.character_editor as any)?.editor_state?.scale || 100,
      radius: (selectedCharacter?.character_editor as any)?.editor_state?.radius || 0,
      backgroundColor: (selectedCharacter?.character_editor as any)?.editor_state?.backgroundColor || ["transparent"],
      backgroundType: (selectedCharacter?.character_editor as any)?.editor_state?.backgroundType || ["solid"],
      backgroundRotation: (selectedCharacter?.character_editor as any)?.editor_state?.backgroundRotation || [0],
      ...((selectedCharacter?.character_editor as any)?.editor_state || {}),
    } as CharacterOptions,
    setOptions: () => {},
    updateOption: () => {},
    resetToSeed: () => {},
    loadManifest: async () => {},
    saveManifest: async () => true,
    brain: { value: "active", matches: () => false } as any,
    sendToBrain: () => {},
  }), [selectedCharacter])

  const voiceContextValue = useMemo(() => ({
    speak: () => {},
    isSpeaking: voiceTelemetry.pipelineStatus === "speaking" || isVoiceReplyPending,
    viseme: voiceTelemetry.currentViseme,
    stop: () => {},
    status: "connected" as const,
    registerVisemeListener: (cb: (v: string) => void) => {
      const handleViseme = (e: any) => cb(e.detail)
      window.addEventListener("viseme", handleViseme)
      return () => window.removeEventListener("viseme", handleViseme)
    },
    testSpeech: () => {},
  }), [voiceTelemetry.pipelineStatus, isVoiceReplyPending])

  const audioContextValue = useMemo(() => ({
    isListening: wakewordTelemetry.wakewordScore > 0,
    status: (wakewordTelemetry.wakewordScore > 0 ? "listening" : "idle") as any,
    errorMessage: null,
    permissionState: "granted" as const,
    lastAction: null,
    frequencyData: null,
    volume: wakewordTelemetry.rms,
    peakVolume: wakewordTelemetry.peak,
    viseme: "closed",
    isSpeaking: wakewordTelemetry.speechLevel > 0.5,
    startListening: async () => {},
    stopListening: () => {},
    sensitivity: 0.5,
    setSensitivity: () => {},
    voiceIsolation: false,
    setVoiceIsolation: () => {},
    reflexesEnabled: true,
    setReflexesEnabled: () => {},
  }), [wakewordTelemetry])
  const themeCatalog = (availableThemes.length ? availableThemes : fallbackThemePresets).slice().sort((left, right) => {
    const order: Record<ThemePresetId, number> = {
      familiar: 0,
      studio: 1,
      minimal: 2,
      amoled: 3,
    }
    return order[left.id] - order[right.id]
  })
  const resolvedEffectiveThemeMode = resolveThemeMode(effectiveThemeMode)
  const selectedThemeSummary = themeCatalog.find((preset) => preset.id === themePresetId) ?? themeCatalog[0]
  const modePreviewPalette =
    selectedThemeSummary && resolveThemeMode(themeMode) === "light"
      ? selectedThemeSummary.preview.light
      : selectedThemeSummary.preview.dark
  const isWorkspaceView = activeView === "settings" || activeView === "admin"
  const shellSidebarWidth = isWorkspaceView ? "0px" : isSidebarCollapsed ? "64px" : "288px"
  const settingsContentClass = cn(
    "mx-auto w-full",
    activeSettingsSection === "memory"
      ? "max-w-[1200px]"
      : activeSettingsSection === "appearance"
        ? "max-w-[1320px]"
        : "max-w-[880px]"
  )
  const adminContentClass = cn(
    "mx-auto w-full",
    activeAdminSection === "characters" && isCharacterEditorOpen
      ? "max-w-full"
      : activeAdminSection === "characters" || activeAdminSection === "skills" || activeAdminSection === "prompt_lab"
      ? "max-w-[1380px]"
      : activeAdminSection === "dashboard" || activeAdminSection === "users"
        ? "max-w-[1240px]"
        : "max-w-[980px]"
  )
  const sharedCharacterChoices = [
    ...(selectedCharacter ? [selectedCharacter] : []),
    ...characters.filter((item) => item.enabled && item.id !== activeCharacterId),
  ]
  const settingsCharacterChoices = characters.filter((item) => item.enabled || item.id === activeCharacterId)
  const normalizedAdminUserSearch = adminUserSearch.trim().toLowerCase()
  const filteredAdminUsers = adminUsers.filter((item) =>
    !normalizedAdminUserSearch
      || item.username.toLowerCase().includes(normalizedAdminUserSearch)
      || item.display_name.toLowerCase().includes(normalizedAdminUserSearch)
  )
  const normalizedSkillSearch = adminSkillSearch.trim().toLowerCase()
  const skillCatalogEntries: SkillCatalogEntry[] = [
    ...installedSkills.map((skill) => ({
      id: skill.skill_id,
      title: skill.title,
      description: skill.description,
      version: skill.version,
      logo: skill.logo,
      installed: true,
      enabled: skill.enabled,
      system: skill.system,
      health_status: skill.health_status,
      health_detail: skill.health_detail,
      domains: [skill.domain],
      load_type: skill.load_type,
      account_count: skill.accounts.length,
    })),
    ...availableSkills
      .filter((skill) => !installedSkills.some((installed) => installed.skill_id === skill.id))
      .map((skill) => ({
        id: skill.id,
        title: skill.title,
        description: skill.description,
        version: skill.latest_version,
        logo: skill.logo_url,
        installed: false,
        enabled: false,
        system: false,
        health_status: "unknown",
        health_detail: "Not installed yet.",
        domains: skill.domains,
        load_type: "lazy",
        account_count: 0,
      })),
  ]
  const skillCounts: Record<CatalogTab, number> = {
    installed: skillCatalogEntries.filter((skill) => skill.installed).length,
    available: skillCatalogEntries.filter((skill) => !skill.installed).length,
    all: skillCatalogEntries.length,
  }
  const skillDomainOptions = [...new Set(skillCatalogEntries.flatMap((skill) => skill.domains).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  const filteredSkillEntries = sortSkills(
    skillCatalogEntries.filter((skill) => {
      if (adminSkillCatalogTab === "installed" && !skill.installed) {
        return false
      }
      if (adminSkillCatalogTab === "available" && skill.installed) {
        return false
      }
      if (!catalogMatchesSearch(adminSkillSearch, [skill.title, skill.id, skill.description, skill.domains.join(", ")])) {
        return false
      }
      if (adminSkillDomainFilter !== "all" && !skill.domains.includes(adminSkillDomainFilter)) {
        return false
      }
      if (adminSkillHealthFilter !== "all" && skill.health_status !== adminSkillHealthFilter) {
        return false
      }
      if (adminSkillKindFilter === "system" && !skill.system) {
        return false
      }
      if (adminSkillKindFilter === "integration" && skill.system) {
        return false
      }
      if (adminSkillKindFilter === "accounted" && skill.account_count === 0) {
        return false
      }
      return true
    }),
    adminSkillSort
  )
  const filteredInstalledSkills = installedSkills.filter((skill) => filteredSkillEntries.some((entry) => entry.id === skill.skill_id))
  const filteredAvailableSkills = availableSkills.filter((skill) => filteredSkillEntries.some((entry) => entry.id === skill.id))
  const adminSkillFiltersActive = Boolean(
    normalizedSkillSearch
    || adminSkillCatalogTab !== "all"
    || adminSkillDomainFilter !== "all"
    || adminSkillHealthFilter !== "all"
    || adminSkillKindFilter !== "all"
    || adminSkillSort !== "recommended"
  )
  const voiceLanguageOptions = [...new Set(adminVoices.map((voice) => voice.language).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  const voiceQualityOptions = [...new Set(adminVoices.map((voice) => voice.quality).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  const adminVoiceFilterMatches = (voice: AdminVoiceRecord): boolean => {
    if (adminVoiceLanguageFilter !== "all" && voice.language !== adminVoiceLanguageFilter) {
      return false
    }
    if (adminVoiceQualityFilter !== "all" && voice.quality !== adminVoiceQualityFilter) {
      return false
    }
    if (!voiceMatchesKindFilter(voice, adminVoiceKindFilter)) {
      return false
    }
    return catalogMatchesSearch(adminVoiceSearch, [
      voice.id,
      voice.label,
      voice.description,
      voice.language,
      voice.quality,
      voice.source_url,
      voice.config_url,
      voice.characters.map((character) => character.character_name).join(" "),
    ])
  }
  const filteredVoicePool = adminVoices.filter(adminVoiceFilterMatches)
  const voiceCounts: Record<CatalogTab, number> = {
    installed: filteredVoicePool.filter((voice) => voice.installed).length,
    available: filteredVoicePool.filter((voice) => !voice.installed).length,
    all: filteredVoicePool.length,
  }
  const filteredAdminVoices = sortVoices(filteredVoicePool.filter((voice) => (
    adminVoiceTab === "all" || (adminVoiceTab === "installed" ? voice.installed : !voice.installed)
  )), adminVoiceSort)
  const adminVoiceFiltersActive = Boolean(
    adminVoiceSearch.trim()
    || adminVoiceLanguageFilter !== "all"
    || adminVoiceQualityFilter !== "all"
    || adminVoiceKindFilter !== "all"
    || adminVoiceSort !== "recommended"
  )
  const voiceCatalogFetchedLabel =
    adminVoiceCatalogStatus && adminVoiceCatalogStatus.fetched_at > 0
      ? new Date(adminVoiceCatalogStatus.fetched_at * 1000).toLocaleString()
      : "Not synced yet"
  const characterCounts: Record<CatalogTab, number> = {
    installed: characters.filter((character) => character.installed).length,
    available: characters.filter((character) => !character.installed).length,
    all: characters.length,
  }
  const filteredAdminCharacters = characters.filter((character) => {
    const matchesTab = adminCharacterTab === "all" || (adminCharacterTab === "installed" ? character.installed : !character.installed)
    if (!matchesTab) {
      return false
    }
    const draft = adminCharacterDrafts[character.id]
    return catalogMatchesSearch(adminCharacterSearch, [
      character.id,
      draft?.name || character.name,
      draft?.description || character.description,
      character.source,
      draft?.default_voice || character.default_voice,
      draft?.wakeword_model_id || character.wakeword_model_id,
    ])
  })
  const healthTone = !health
    ? "checking"
    : errorCapabilities.length > 0
      ? "error"
      : warnCapabilities.length > 0
        ? "warn"
        : "ok"
  const canOpenHealth = healthTone === "checking" || topIssues.length > 0

  if (isAuthHydrating) {
    return (
      <div className="app-frame grid min-h-dvh place-items-center bg-[var(--background)] text-[var(--foreground)]">
        <div className="flex flex-col items-center gap-4">
          <img alt="LokiDoki logo" className="h-16 w-16 rounded-2xl bg-[var(--panel)] p-2" src="/lokidoki-logo.svg" />
          <div className="text-center">
            <div className="text-lg font-medium text-[var(--foreground)]">{bootstrap?.app_name || "LokiDoki"}</div>
            <div className="mt-1 text-sm text-[var(--muted-foreground)]">Restoring your session…</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="app-frame min-h-dvh bg-[var(--background)] text-[var(--foreground)]"
      data-theme-mode={resolvedEffectiveThemeMode}
      data-theme-preset={effectiveThemePresetId}
    >
      <div
        className={cn(
          "grid h-dvh overflow-hidden bg-[var(--panel)]",
          isWorkspaceView || (characterDisplayMode === "fullscreen" && isCharacterVisible) ? "grid-cols-1" : "grid-cols-1 md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]"
        )}
        style={!isWorkspaceView ? { ["--sidebar-width" as string]: shellSidebarWidth } : undefined}
      >
        {!isWorkspaceView && !(characterDisplayMode === "fullscreen" && isCharacterVisible) ? (
          <AppSidebar
            activeChatId={activeChatId}
            bootstrapAppName={bootstrap?.app_name || "LokiDoki"}
            chatMenuAnchor={chatMenuAnchor}
            debugMode={debugMode}
            filteredChats={filteredChats}
            isMobileSidebarOpen={isMobileSidebarOpen}
            isProfileMenuOpen={isProfileMenuOpen}
            isSidebarCollapsed={isSidebarCollapsed}
            openChatMenuId={openChatMenuId}
            renameChatTitle={renameChatTitle}
            renamingChatId={renamingChatId}
            user={user}
            onBeginRenamingChat={beginRenamingChat}
            onCloseMobileSidebar={() => setIsMobileSidebarOpen(false)}
            onCreateChat={() => {
              if (token) {
                void createChat(token).catch((error) => {
                  setChatError(error instanceof Error ? error.message : "Chat could not be created.")
                })
              }
            }}
            onDeleteChat={(chat) => {
              if (!token || !window.confirm(`Delete "${chat.title}"?`)) {
                return
              }
              void deleteChat(chat.id, token).catch((error) => {
                setChatError(error instanceof Error ? error.message : "Chat delete failed.")
              })
            }}
            onOpenChatMenu={openChatMenu}
            onRenameChatCancel={() => {
              setRenamingChatId("")
              setRenameChatTitle("")
            }}
            onRenameChatSubmit={(chatId) => {
              if (!token) {
                setRenamingChatId("")
                return
              }
              void renameChat(chatId, renameChatTitle, token).catch((error) => {
                setChatError(error instanceof Error ? error.message : "Chat rename failed.")
              })
            }}
            onRenameChatTitleChange={setRenameChatTitle}
            onSelectChat={(chatId) => {
              if (token) {
                void selectChat(chatId, token).catch((error) => {
                  setChatError(error instanceof Error ? error.message : "Chat could not be opened.")
                })
              }
            }}
            onSetActiveView={(view) => {
              setActiveView(view)
              if (view === "admin") {
                setActiveAdminSection("dashboard")
                setIsCharacterEditorOpen(false)
              }
              setIsMobileSidebarOpen(false)
              setIsProfileMenuOpen(false)
              setIsCharacterMenuOpen(false)
            }}
            onSignOut={() => {
              localStorage.removeItem(tokenKey)
              setUser(null)
              setToken("")
              setAuthError("")
              setIsAuthHydrating(false)
              setIsProfileMenuOpen(false)
              setIsCharacterMenuOpen(false)
            }}
            onToggleDebugMode={() => {
              void persistDebugMode(!debugMode)
              setIsProfileMenuOpen(false)
            }}
            onToggleProfileMenu={() => setIsProfileMenuOpen((current) => !current)}
            onToggleSidebarCollapsed={() => setIsSidebarCollapsed((current) => !current)}
          />
        ) : null}

        <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
          {!user ? (
            <AuthPanel
              allowSignup={Boolean(bootstrap?.allow_signup)}
              authError={authError}
              authMode={authMode}
              onSubmit={submitAuth}
              onToggle={() => setAuthMode((current) => (current === "login" ? "register" : "login"))}
            />
          ) : null}

          <header className={cn(
            "relative h-16 items-center justify-between border-b border-[var(--line)] bg-[var(--panel-strong)]/72 px-4 backdrop-blur sm:px-6 z-20",
            characterDisplayMode === "fullscreen" && isCharacterVisible ? "hidden" : "flex"
          )}>
            <div className="flex items-center gap-3">
              <Button
                className={cn("md:hidden", isWorkspaceView ? "hidden" : "")}
                onClick={() => setIsMobileSidebarOpen(true)}
                size="icon"
                tooltip="Open navigation"
                type="button"
                variant="ghost"
              >
                <Menu className="h-5 w-5" />
              </Button>
              {activeView === "assistant" ? (
                <CharacterQuickSwitcher
                  busy={isCharacterSyncPending}
                  characters={sharedCharacterChoices.map((character) => ({
                    ...character,
                    teaser: fallbackCharacterTeaser(character),
                  }))}
                  open={isCharacterMenuOpen}
                  pendingCharacterName={pendingCharacterName}
                  selectedCharacter={selectedCharacter ? {
                    ...selectedCharacter,
                    teaser: fallbackCharacterTeaser(selectedCharacter),
                  } : null}
                  onOpenCharacterSettings={openCharacterSettingsPanel}
                  onSelectCharacter={(characterId) => void handleCharacterSwitch(characterId)}
                  onToggle={() => {
                    if (!isCharacterSyncPending) {
                      setIsCharacterMenuOpen((current) => !current)
                    }
                  }}
                />
              ) : (
                <div className="workspace-view-badge text-sm font-medium">
                  <span className="max-w-[160px] truncate sm:max-w-none">
                    {activeView === "settings" ? "Settings" : "Administration"}
                  </span>
                </div>
              )}
              <button
                aria-expanded={isHealthOpen}
                aria-label="Open local service status"
                className={`flex items-center gap-2 border px-2.5 py-1 text-xs ${
                  healthTone === "ok"
                    ? "border-[var(--line)] bg-[var(--panel-strong)] text-[var(--foreground)]"
                    : healthTone === "warn"
                      ? "border-amber-900/70 bg-amber-950/30 text-amber-200"
                      : healthTone === "error"
                        ? "border-rose-900/70 bg-rose-950/30 text-rose-200"
                        : "border-[var(--line)] bg-[var(--panel-strong)] text-[var(--muted-foreground)]"
                } ${canOpenHealth ? "cursor-pointer hover:bg-[var(--input)]" : "cursor-default"}`}
                disabled={!canOpenHealth}
                onClick={() => {
                  if (canOpenHealth) {
                    setIsHealthOpen((current) => !current)
                  }
                }}
                type="button"
              >
                {healthTone === "ok" ? (
                  <CircleCheckBig className="h-3.5 w-3.5" />
                ) : healthTone === "checking" ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CircleAlert className="h-3.5 w-3.5" />
                )}
                <span>
                  <span className="hidden sm:inline">
                    {!health
                    ? "Checking"
                    : primaryIssue
                      ? `${topIssues.length} issue${topIssues.length === 1 ? "" : "s"}`
                      : "Local"}
                  </span>
                </span>
              </button>
            </div>

            {activeView === "assistant" ? (
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                <TabsList className="h-9">
                  <TabsTrigger
                    active={assistantTab === "chat"}
                    onClick={() => setAssistantTab("chat")}
                  >
                    Chat
                  </TabsTrigger>
                  <TabsTrigger
                    active={assistantTab === "talk"}
                    onClick={() => setAssistantTab("talk")}
                  >
                    Talk
                  </TabsTrigger>
                </TabsList>
              </div>
            ) : null}

            <div className="relative flex items-center gap-1 text-[var(--foreground)] sm:gap-2" onPointerDown={(event) => event.stopPropagation()}>
              {user?.is_admin && debugMode ? (
                <Button
                  className="h-9 gap-2 rounded-full border border-[var(--line)] bg-[var(--panel)] px-3 text-xs text-[var(--foreground)] shadow-[var(--shadow-soft)] hover:bg-[var(--input)]"
                  onClick={() => setIsDebugOpen((current) => !current)}
                  type="button"
                  variant="ghost"
                >
                  <Bug className="h-4 w-4" />
                  Logs
                </Button>
              ) : null}
              {!isWorkspaceView ? (
                <Button
                  className="h-8 w-8 border border-[var(--line)] bg-[var(--panel)]"
                  disabled={!activeChat}
                  onClick={() => {
                    if (activeChat) {
                      openChatMenu(activeChat.id, "header")
                    }
                  }}
                  size="icon"
                  tooltip={activeChat ? "Chat actions" : "No active chat"}
                  type="button"
                  variant="ghost"
                >
                  <Ellipsis className="h-4 w-4" />
                </Button>
              ) : null}
              {!isWorkspaceView && openChatMenuId === activeChatId && chatMenuAnchor === "header" && activeChat ? (
                <div
                  className="absolute right-0 top-[calc(100%+8px)] z-30 w-44 border border-[var(--line)] bg-[var(--panel-strong)]/98 p-2 shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--input)]" onClick={() => beginRenamingChat(activeChat)} type="button">
                    <Pencil className="h-4 w-4 text-[var(--muted-foreground)]" />
                    Rename chat
                  </button>
                  <button
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10"
                    onClick={() => {
                      if (!token || !window.confirm(`Delete "${activeChat.title}"?`)) {
                        return
                      }
                      void deleteChat(activeChat.id, token).catch((error) => {
                        setChatError(error instanceof Error ? error.message : "Chat delete failed.")
                      })
                    }}
                    type="button"
                  >
                    <Trash2 className="h-4 w-4 text-rose-300" />
                    Delete chat
                  </button>
                </div>
              ) : null}
            </div>
          </header>

          {isHealthOpen && canOpenHealth ? (
            <div className="absolute left-4 right-4 top-18 z-10 md:left-auto md:right-6 md:w-[380px]">
              <Card className="border-[var(--line)] bg-[var(--panel-strong)]/96 text-[var(--foreground)] shadow-2xl">
                <CardContent className="p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-[var(--foreground)]">Local Status</div>
                      <div className="text-xs text-[var(--muted-foreground)]">Profile {health?.profile || bootstrap?.profile || "mac"}</div>
                    </div>
                    <Button
                      className="h-8 rounded-lg px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--input)] hover:text-[var(--foreground)]"
                      onClick={() => void refreshHealth()}
                      type="button"
                      variant="ghost"
                    >
                      Refresh
                    </Button>
                    <Button
                      className="h-8 rounded-lg px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--input)] hover:text-[var(--foreground)]"
                      onClick={() => setIsHealthOpen(false)}
                      type="button"
                      variant="ghost"
                    >
                      Close
                    </Button>
                  </div>
                  {!health ? (
                    <div className="flex items-center gap-2 rounded-xl bg-[var(--input)] px-3 py-2 text-sm text-[var(--foreground)]">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Checking local services...
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {topIssues.map((issue) => (
                        <div key={issue.key} className="rounded-xl bg-[var(--input)] px-3 py-2">
                          <div className="text-sm font-medium text-[var(--foreground)]">{issue.label}</div>
                          <div className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">{issue.detail}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}


          {user?.is_admin && debugMode && isDebugOpen ? (
            <div className="absolute bottom-28 right-4 top-16 z-10 w-[min(460px,calc(100vw-32px))]">
              <Card className="flex h-full min-h-0 flex-col border-[var(--line)] bg-[var(--panel-strong)]/98 text-[var(--foreground)] shadow-2xl">
                <CardContent className="flex min-h-0 flex-1 flex-col p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-[var(--foreground)]">Debug Console</div>
                      <div className="text-xs text-[var(--muted-foreground)]">Live timings and local logs</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        className="h-8 rounded-lg px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--input)] hover:text-[var(--foreground)]"
                        onClick={() => void copyAllDebugLogs()}
                        type="button"
                        variant="ghost"
                      >
                        {copiedDebugTarget === "all" ? "Copied" : "Copy All"}
                      </Button>
                      <Button
                        className="h-8 rounded-lg px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--input)] hover:text-[var(--foreground)]"
                        onClick={() => void refreshDebugLogs()}
                        type="button"
                        variant="ghost"
                      >
                        Refresh
                      </Button>
                      <Button
                        className="h-8 rounded-lg px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--input)] hover:text-[var(--foreground)]"
                        onClick={() => setIsDebugOpen(false)}
                        type="button"
                        variant="ghost"
                      >
                        Close
                      </Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                    {!debugLogs ? (
                      <div className="rounded-xl bg-[var(--input)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
                        Loading debug logs...
                      </div>
                    ) : (
                      debugLogs.sections.map((section) => (
                        <div key={section.key} className="rounded-xl border border-[var(--line)] bg-[var(--input)]">
                          <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
                            <div className="text-sm font-medium text-[var(--foreground)]">{section.label}</div>
                            <Button
                              className="h-7 rounded-lg px-2 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
                              onClick={() => void copyDebugSection(section)}
                              type="button"
                              variant="ghost"
                            >
                              {copiedDebugTarget === section.key ? "Copied" : "Copy"}
                            </Button>
                          </div>
                          <div className="border-b border-[var(--line)] px-3 py-1 font-mono text-[10px] text-[var(--muted-foreground)]">
                            {section.path}
                          </div>
                          <div className="max-h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 text-[var(--muted-foreground)]">
                            {section.exists && section.lines.length > 0 ? (
                              section.lines.map((line, index) => <div key={`${section.key}-${index}`}>{line}</div>)
                            ) : (
                              <div>No log output yet.</div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {isCameraPreviewOpen ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
              <div className="w-full max-w-2xl">
                <Card className="border-[var(--line)] bg-[var(--card)]/96 text-[var(--foreground)] shadow-[var(--shadow-strong)]">
                  <CardContent className="space-y-4 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold">Live Camera Test</div>
                        <div className="text-xs text-[var(--muted-foreground)]">Quick browser camera preview for framing and permissions</div>
                      </div>
                      <Button className="h-8 rounded-lg px-2 text-xs" onClick={() => setIsCameraPreviewOpen(false)} type="button" variant="ghost">
                        Close
                      </Button>
                    </div>
                    <LiveCameraPreview token={token} />
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : null}

          {activeView === "assistant" ? (
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              {/* Only show toolbar here if character is NOT in fullscreen mode (otherwise overlay handles it) */}
              {characterDisplayMode !== "fullscreen" && (
                <div className="pointer-events-auto absolute right-6 top-6 z-50 flex items-center gap-2">
                  <div className="group flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-xl shadow-strong transition-all duration-500 hover:gap-2">
                    {/* Flyout Group */}
                    <div className={cn(
                      "flex items-center gap-1.5 overflow-hidden transition-all duration-300",
                      isCharacterVisible ? "w-0 opacity-0 group-hover:w-auto group-hover:opacity-100" : "hidden"
                    )}>
                      {/* Body Mode */}
                      <Button
                        className={cn(
                          "h-9 w-9 rounded-full transition-all",
                          characterDisplayMode === "full" ? "bg-[var(--accent)] text-black font-bold shadow-[0_0_15px_rgba(var(--accent-rgb),0.5)]" : "text-white/60 hover:bg-white/10 hover:text-white"
                        )}
                        onClick={() => setCharacterDisplayMode("full")}
                        size="icon"
                        tooltip="Body Mode"
                        variant="ghost"
                      >
                        <User className="h-5 w-5" />
                      </Button>

                      {/* Head Mode */}
                      <Button
                        className={cn(
                          "h-9 w-9 rounded-full transition-all",
                          characterDisplayMode === "head" ? "bg-[var(--accent)] text-black font-bold shadow-[0_0_15px_rgba(var(--accent-rgb),0.5)]" : "text-white/60 hover:bg-white/10 hover:text-white"
                        )}
                        onClick={() => setCharacterDisplayMode("head")}
                        size="icon"
                        tooltip="Head Mode"
                        variant="ghost"
                      >
                        <Scan className="h-5 w-5" />
                      </Button>

                      {/* Fullscreen Mode */}
                      <Button
                        className={cn("h-9 w-9 rounded-full transition-all text-white/60 hover:bg-white/10 hover:text-white")}
                        onClick={() => setCharacterDisplayMode("fullscreen")}
                        size="icon"
                        tooltip="Fullscreen Stage"
                        variant="ghost"
                      >
                        <Maximize2 className="h-5 w-5" />
                      </Button>

                      {/* Hide/Exit Button */}
                      <Button
                        className="h-9 w-9 rounded-full text-white/50 hover:bg-rose-500/20 hover:text-rose-400 transition-all"
                        onClick={(e) => { e.stopPropagation(); setIsCharacterVisible(false); }}
                        size="icon"
                        tooltip="Hide Character"
                        variant="ghost"
                      >
                        <X className="h-5 w-5" />
                      </Button>
                      <div className="mx-1 h-4 w-px bg-white/20" />
                    </div>

                    {/* Trigger Icon */}
                    <Button
                      className={cn("h-9 w-9 rounded-full transition-all duration-300", isCharacterVisible ? "bg-white/5 text-white group-hover:bg-transparent" : "bg-[var(--accent)] text-black font-bold shadow-[0_0_20px_rgba(var(--accent-rgb),0.3)]")}
                      onClick={() => !isCharacterVisible && setIsCharacterVisible(true)}
                      size="icon"
                      tooltip={isCharacterVisible ? "Stage Options (Hover)" : "Show Character"}
                      variant="ghost"
                    >
                      {!isCharacterVisible ? <Eye className="h-5 w-5" /> : (characterDisplayMode === "full" ? <User className="h-5 w-5" /> : <Scan className="h-5 w-5" />)}
                    </Button>

                    <div className="h-4 w-px bg-white/20" />

                    {/* Audio Toggle */}
                    <Button
                      className={cn("h-9 w-9 rounded-full transition-all duration-300", voiceReplyEnabled ? "text-[var(--accent)]" : "text-white/60 hover:bg-white/10 hover:text-white")}
                      onClick={() => setVoiceReplyEnabled((prev) => !prev)}
                      size="icon"
                      tooltip={voiceReplyEnabled ? "Mute Output" : "Unmute Output"}
                      variant="ghost"
                    >
                      {voiceReplyEnabled ? <Ear className="h-5 w-5" /> : <EarOff className="h-5 w-5" />}
                    </Button>
                  </div>
                </div>
              )}

              <div
                className={cn(
                  "flex min-h-0 flex-1 flex-col overflow-hidden transition-all duration-500",
                  characterDisplayMode === "fullscreen" && isCharacterVisible ? "opacity-0 pointer-events-none translate-y-4" : "opacity-100 translate-y-0"
                )}
              >
                {assistantTab === "chat" ? (
                  <>
                    <div
                      ref={messageViewportRef}
                      className="chat-scroll-region min-h-0 flex-1 overflow-y-auto overscroll-contain"
                      onScroll={handleMessageScroll}
                    >
                      <ChatMessageList
                        assistantCharacter={selectedCharacter}
                        debugMode={debugMode}
                        debugNow={debugNow}
                        getMessageKey={speechMessageKey}
                        messages={messages}
                        onPlayVoice={(message, messageKey) => void playMessageVoice(message, messageKey)}
                        onRetrySmart={(assistantIndex) => void retryAssistantWithSmartModel(assistantIndex)}
                        onSuggestionSelect={setPrompt}
                        overviewRows={overviewRows}
                        pendingSpeechMessageKey={pendingSpeechMessageKey}
                        retryingAssistantIndex={retryingAssistantIndex}
                        speakingMessageKey={speakingMessageKey}
                        suggestions={suggestions}
                        userDisplayName={user?.display_name}
                      />
                    </div>
                    <JumpToLatest onClick={jumpToLatest} visible={!isPinnedToBottom && messages.length > 0} />
                    <ChatComposer
                      chatError={chatError}
                      characterSyncLabel={characterStatus || `Compiling ${pendingCharacterName || "character"}...`}
                      characterName={selectedCharacter?.name || bootstrap?.app_name || "LokiDoki"}
                      documentInputRef={documentInputRef}
                      imageInputRef={imageInputRef}
                      isAttachmentMenuOpen={isAttachmentMenuOpen}
                      isCharacterSyncPending={isCharacterSyncPending}
                      isSubmitting={isSubmitting}
                      isVoiceListening={isVoiceListening}
                      isVoiceReplyPending={isVoiceReplyPending}
                      isWakewordMonitoring={isWakewordMonitoring}
                      onDocumentSelected={(event) => void handleDocumentSelection(event)}
                      onCloseAttachmentMenu={() => setIsAttachmentMenuOpen(false)}
                      onImageSelected={(event) => void handleImageSelection(event)}
                      onPromptChange={(event) => setPrompt(event.target.value)}
                      onPromptKeyDown={handlePromptKeyDown}
                      onRemoveDocument={() => setSelectedDocument(null)}
                      onRemoveImage={() => setSelectedImage(null)}
                      onRemoveVideo={() => setSelectedVideo(null)}
                      recordingStream={recordingStream}
                      onSubmit={submitChat}
                      onToggleAttachmentMenu={() => setIsAttachmentMenuOpen((current) => !current)}
                      onTogglePushToTalk={togglePushToTalk}
                      onVideoSelected={(event) => void handleVideoSelection(event)}
                      performanceProfileId={performanceProfileId}
                      onSelectProfile={setPerformanceProfileId}
                      prompt={prompt}
                      selectedDocument={selectedDocument}
                      selectedImage={selectedImage}
                      selectedPiperVoiceLabel={selectedPiperVoice?.label || "piper"}
                      selectedVideo={selectedVideo}
                      userReady={Boolean(user)}
                      videoInputRef={videoInputRef}
                      voiceReplyEnabled={voiceReplyEnabled}
                      voiceSource={voiceSource}
                      voiceStatus={voiceStatus}
                      wakewordEnabled={wakewordEnabled}
                      wakewordScore={wakewordTelemetry.wakewordScore}
                      wakewordSignalLevel={Math.max(wakewordTelemetry.peak, wakewordTelemetry.rms * 2.5)}
                      wakewordSpeechLevel={wakewordTelemetry.speechLevel}
                    />
                  </>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                    <div className="max-w-md space-y-4">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <Mic className="h-8 w-8" />
                      </div>
                      <h2 className="text-xl font-semibold text-[var(--foreground)]">Talk Tab Coming Soon</h2>
                      <p className="text-[var(--muted-foreground)]">
                        A hands-free, voice-first experience is being prepared for this space.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {isCharacterVisible && selectedCharacter && characterDisplayMode !== "fullscreen" && (
                <aside className="relative flex w-[360px] border-l xl:w-[420px] bg-[var(--panel-strong)]/20 animate-in slide-in-from-right-4 transition-all duration-500">
                  <div className="flex h-full w-full flex-1 flex-col overflow-hidden p-6 pt-16">
                    <CharacterContext.Provider value={characterContextValue}>
                      <VoiceContext.Provider value={voiceContextValue}>
                        <AudioContext.Provider value={audioContextValue}>
                          <AnimatedCharacter
                            stageScale={characterDisplayMode === "head" ? 1.2 : 1.0}
                            viewPreset={characterDisplayMode}
                          />
                        </AudioContext.Provider>
                      </VoiceContext.Provider>
                    </CharacterContext.Provider>
                  </div>
                </aside>
              )}

            </div>
          ) : activeView === "settings" ? (
            <div className="workspace-shell min-h-0 flex-1 overflow-hidden" ref={rightPaneScrollRef}>
              <div className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)] lg:grid-rows-1">
                <div className="workspace-nav h-auto space-y-3 overflow-x-auto px-3 py-3 lg:h-full lg:px-4 lg:py-4">
                  <div className="workspace-rail-card p-3">
                    <Button className="w-full justify-start gap-2 rounded-2xl px-3 text-sm" onClick={() => setActiveView("assistant")} type="button" variant="ghost">
                      <ArrowUpDown className="h-4 w-4 rotate-90" />
                      Back to chats
                    </Button>
                  </div>
                  <div className="px-3 py-2">
                    <div className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">Settings</div>
                    <div className="mt-1 text-sm text-[var(--muted-foreground)]">Personal preferences, appearance, voice, wakeword, and memory.</div>
                  </div>
                  {settingsSections.map((section) => (
                    <button
                      key={section.id}
                      className={cn("workspace-section-button", activeSettingsSection === section.id ? "is-active" : "")}
                      onClick={() => setActiveSettingsSection(section.id)}
                      type="button"
                    >
                      <div className="text-sm font-medium">{section.label}</div>
                      <div className="workspace-section-detail mt-1 text-xs">{section.detail}</div>
                    </button>
                  ))}
                </div>

                <div className="workspace-content min-h-0 overflow-y-auto px-4 py-4 sm:px-6 lg:px-10 lg:py-8 xl:px-12">
                  <div className={cn(settingsContentClass, "space-y-6")}>
                  {activeSettingsSection === "appearance" ? (
                    <Card className="workspace-panel text-[var(--foreground)]">
                      <CardContent className="space-y-6 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">Appearance</div>
                          <div className="mt-1 text-sm text-[var(--muted-foreground)]">Choose a full visual preset and a separate light, dark, or automatic mode.</div>
                        </div>
                        <div className="workspace-inline-panel p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="workspace-label">Theme Mode</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">
                                {themeLocked ? "An administrator is currently forcing your appearance." : "Mode applies across every theme preset."}
                              </div>
                            </div>
                            <div
                              className="inline-flex flex-wrap gap-2 rounded-full border p-1"
                              style={{
                                borderColor: `${modePreviewPalette.accent}33`,
                                background: `linear-gradient(180deg, ${modePreviewPalette.panel}, ${modePreviewPalette.background})`,
                                boxShadow: `inset 0 0 0 1px ${modePreviewPalette.accent}12`,
                              }}
                            >
                              {(["light", "dark", "auto"] as ThemeMode[]).map((mode) => (
                                <button
                                  key={mode}
                                  className="h-10 rounded-full px-4 text-xs capitalize transition-all"
                                  disabled={themeLocked}
                                  onClick={() => void persistTheme({ mode })}
                                  type="button"
                                  style={
                                    themeMode === mode
                                      ? {
                                          background: modePreviewPalette.accent,
                                          color: modePreviewPalette.text,
                                          border: `1px solid ${modePreviewPalette.accent}`,
                                          boxShadow: `0 10px 24px ${modePreviewPalette.accent}2f`,
                                        }
                                      : {
                                          background: "transparent",
                                          color: `${modePreviewPalette.text}bf`,
                                          border: `1px solid ${modePreviewPalette.accent}1f`,
                                        }
                                  }
                                >
                                  {mode}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                          {themeCatalog.map((preset) => {
                            const isActive = themePresetId === preset.id
                            const activePreview = resolvedEffectiveThemeMode === "light" ? preset.preview.light : preset.preview.dark
                            const previewFontFamily =
                              preset.id === "studio"
                                ? '"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif'
                                : 'var(--font-sans)'
                            const previewRadius =
                              preset.radius_label === "Instrument"
                                ? "22px"
                                : preset.radius_label === "Crisp"
                                  ? "14px"
                                  : preset.radius_label === "Clean"
                                    ? "16px"
                                    : "26px"
                            return (
                              <button
                                key={preset.id}
                                className={`theme-preview-card text-left ${isActive ? "is-active" : ""}`}
                                disabled={themeLocked}
                                onClick={() => void persistTheme({ presetId: preset.id })}
                                type="button"
                                style={{
                                  borderRadius: previewRadius,
                                  background: `linear-gradient(180deg, ${activePreview.background}, ${activePreview.panel})`,
                                  borderColor: isActive ? activePreview.accent : "color-mix(in srgb, var(--line) 92%, transparent)",
                                  color: activePreview.text,
                                  boxShadow: isActive
                                    ? `0 0 0 1px ${activePreview.accent}, 0 18px 40px rgba(0,0,0,0.28)`
                                    : "0 18px 40px rgba(0,0,0,0.2)",
                                }}
                              >
                                <div className="flex min-h-[4.5rem] items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-base font-semibold">{preset.name}</div>
                                    <div className="mt-1 text-sm" style={{ color: `${activePreview.text}bf` }}>{preset.description}</div>
                                  </div>
                                </div>
                                <div
                                  className="mt-3 min-h-[13rem] overflow-hidden border"
                                  style={{
                                    borderRadius: previewRadius,
                                    borderColor: `${activePreview.accent}44`,
                                    background: `linear-gradient(180deg, ${activePreview.background}, ${activePreview.panel})`,
                                    fontFamily: previewFontFamily,
                                  }}
                                >
                                  <div
                                    className="flex h-[13rem] min-w-0 flex-col"
                                    style={{
                                      color: activePreview.text,
                                    }}
                                  >
                                    <div
                                      className="flex items-center justify-between border-b px-3 py-2"
                                      style={{
                                        borderColor: `${activePreview.accent}22`,
                                        background: `${activePreview.panel}ee`,
                                      }}
                                    >
                                      <div className="text-[11px] font-semibold">LokiDoki</div>
                                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: `${activePreview.text}88` }}>{preset.font_label}</div>
                                    </div>
                                    <div className="flex min-w-0 flex-1 flex-col px-3 py-3">
                                      <div
                                        className="text-[15px] font-semibold"
                                      >
                                        How can I help?
                                      </div>
                                      <div className="mt-2 flex-1 space-y-2">
                                        <div
                                          className="ml-auto max-w-[68%] rounded-[16px] px-3 py-2 text-[11px]"
                                          style={{
                                            borderRadius: previewRadius,
                                            background: `${activePreview.accent}22`,
                                            border: `1px solid ${activePreview.accent}40`,
                                          }}
                                        >
                                          New chat
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <span
                                            className="inline-flex h-7 items-center rounded-full px-3 text-[11px] font-medium"
                                            style={{
                                              borderRadius: previewRadius,
                                              background: activePreview.accent,
                                              color: activePreview.background,
                                            }}
                                          >
                                            Button
                                          </span>
                                          <span
                                            className="inline-flex h-7 items-center rounded-full border px-3 text-[11px]"
                                            style={{
                                              borderRadius: previewRadius,
                                              borderColor: `${activePreview.accent}40`,
                                              color: `${activePreview.text}cc`,
                                              background: `${activePreview.panel}f0`,
                                            }}
                                          >
                                            Input
                                          </span>
                                        </div>
                                      </div>
                                      <div className="mt-2 border px-3 py-2 text-[11px]" style={{
                                        borderRadius: previewRadius,
                                        borderColor: `${activePreview.accent}2c`,
                                        background: `${activePreview.background}b8`,
                                        color: `${activePreview.text}aa`,
                                      }}>
                                        Message LokiDoki...
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                        {user?.is_admin ? (
                          <div className="workspace-inline-panel flex items-center justify-between gap-3 px-4 py-4">
                            <div>
                              <div className="text-sm font-medium text-[var(--foreground)]">Debug Mode</div>
                              <div className="mt-1 text-sm text-[var(--muted-foreground)]">Timings, route metadata, and local log viewer</div>
                            </div>
                            <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistDebugMode(!debugMode)} type="button" variant="outline">
                              {debugMode ? "On" : "Off"}
                            </Button>
                          </div>
                        ) : null}
                        {voiceStatus ? <div className="workspace-muted text-sm">{voiceStatus}</div> : null}
                        {user?.is_admin && debugMode ? (
                          <div className="workspace-inline-panel px-4 py-4 text-sm text-[var(--foreground)]">
                            <div className="workspace-label mb-3">Voice Telemetry</div>
                            <div className="grid gap-2 md:grid-cols-2">
                              <div>Pipeline: <span className="text-[var(--foreground)]">{voiceTelemetry.pipelineStatus}</span></div>
                              <div>Viseme: <span className="text-[var(--foreground)]">{voiceTelemetry.currentViseme}</span></div>
                              <div>
                                First chunk:
                                <span className="text-[var(--foreground)]">
                                  {formatVoiceLatency(voiceTelemetry.requestedAtMs, voiceTelemetry.firstChunkAtMs)}
                                </span>
                              </div>
                              <div>
                                Playback start:
                                <span className="text-[var(--foreground)]">
                                  {formatVoiceLatency(voiceTelemetry.requestedAtMs, voiceTelemetry.playbackStartAtMs)}
                                </span>
                              </div>
                              <div>
                                Total reply:
                                <span className="text-[var(--foreground)]">
                                  {formatVoiceLatency(voiceTelemetry.requestedAtMs, voiceTelemetry.completedAtMs)}
                                </span>
                              </div>
                              <div>VAD speaking: <span className="text-[var(--foreground)]">{vadTelemetry.isSpeaking ? "yes" : "no"}</span></div>
                              <div>VAD peak: <span className="text-[var(--foreground)]">{vadTelemetry.peak.toFixed(3)}</span></div>
                              <div>VAD rms: <span className="text-[var(--foreground)]">{vadTelemetry.rms.toFixed(3)}</span></div>
                              <div>Speech frames: <span className="text-[var(--foreground)]">{vadTelemetry.speechFrames}</span></div>
                              <div>Silence frames: <span className="text-[var(--foreground)]">{vadTelemetry.silenceFrames}</span></div>
                              <div>Capturing: <span className="text-[var(--foreground)]">{vadTelemetry.capturing ? "yes" : "no"}</span></div>
                            </div>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  ) : null}

                  {activeSettingsSection === "general" ? (
                    <Card className="workspace-panel text-[var(--foreground)]">
                      <CardContent className="space-y-4 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">General</div>
                          <div className="workspace-muted mt-1 text-sm">Profile details, password, and your default response behavior.</div>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-2">
                            <div className="workspace-label">Username</div>
                            <Input disabled value={user?.username || ""} />
                          </div>
                          <div className="space-y-2">
                            <div className="workspace-label">Display Name</div>
                            <Input onChange={(event) => setProfileDisplayNameDraft(event.target.value)} value={profileDisplayNameDraft} />
                          </div>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-2">
                            <div className="workspace-label">Current Password</div>
                            <Input onChange={(event) => setCurrentPasswordDraft(event.target.value)} type="password" value={currentPasswordDraft} />
                          </div>
                          <div className="space-y-2">
                            <div className="workspace-label">New Password</div>
                            <Input onChange={(event) => setNewPasswordDraft(event.target.value)} type="password" value={newPasswordDraft} />
                          </div>
                        </div>
                        <div className="workspace-inline-panel flex items-center justify-between gap-3 px-4 py-4">
                          <div>
                            <div className="text-sm font-medium text-[var(--foreground)]">Character Mode</div>
                            <div className="workspace-muted mt-1 text-sm">Turn character voice on or fall back to neutral LokiDoki responses.</div>
                          </div>
                          <Button
                            className="h-9 rounded-full px-3 text-xs"
                            onClick={() => {
                              const nextEnabled = !characterEnabled
                              setCharacterEnabled(nextEnabled)
                              void persistCharacterSettings({ character_enabled: nextEnabled } as Partial<SettingsPayload>)
                            }}
                            type="button"
                            variant="outline"
                          >
                            {characterEnabled ? "On" : "Off"}
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <div className="workspace-label">Active Character</div>
                          <CharacterQuickSwitcher
                            busy={isCharacterSyncPending}
                            characters={settingsCharacterChoices.map((character) => ({
                              ...character,
                              teaser: fallbackCharacterTeaser(character),
                            }))}
                            selectedCharacter={selectedCharacter ? {
                              ...selectedCharacter,
                              teaser: fallbackCharacterTeaser(selectedCharacter),
                            } : null}
                            open={isCharacterMenuOpen}
                            onToggle={() => {
                              if (!isCharacterSyncPending && !(assignedCharacterId && !canSelectCharacter)) {
                                setIsCharacterMenuOpen((current) => !current)
                              }
                            }}
                            onSelectCharacter={(characterId) => {
                              if (assignedCharacterId && !canSelectCharacter) {
                                return
                              }
                              setIsCharacterMenuOpen(false)
                              void handleCharacterSwitch(characterId)
                            }}
                            onOpenCharacterSettings={() => {
                              setIsCharacterMenuOpen(false)
                            }}
                            hideFooter
                            footerLabel=""
                            footerSubtitle=""
                            pendingCharacterName={pendingCharacterName}
                          />
                          {assignedCharacterId && !canSelectCharacter ? (
                            <div className="workspace-muted text-xs">This character is assigned by an administrator and selection is locked.</div>
                          ) : null}
                          {selectedCharacter ? <div className="workspace-muted text-sm">{selectedCharacter.description || `${selectedCharacter.name} character`}</div> : null}
                        </div>
                        <div className="space-y-2">
                          <div className="workspace-label">Global User Prompt</div>
                          <div className="workspace-muted text-sm">Applied across all responses, whether character mode is on or off.</div>
                          <Textarea
                            onChange={(event) => setUserPromptText(event.target.value)}
                            placeholder={PROMPT_EXAMPLES.userPrompt}
                            rows={3}
                            value={userPromptText}
                          />
                          <div className="workspace-muted text-xs">{PROMPT_EXAMPLES.userPrompt}</div>
                        </div>
                        <div className="space-y-2">
                          <div className="workspace-label">Character Custom Prompt</div>
                          <div className="workspace-muted text-sm">Only applies when this character is active and character mode is on.</div>
                          <Textarea
                            onChange={(event) =>
                              setCharacterCustomizations((current) => ({
                                ...current,
                                [activeCharacterId]: event.target.value,
                              }))
                            }
                            placeholder={PROMPT_EXAMPLES.characterCustom}
                            rows={4}
                            value={characterCustomizations[activeCharacterId] || ""}
                          />
                          <div className="workspace-muted text-xs">{PROMPT_EXAMPLES.characterCustom}</div>
                        </div>
                        <div className="workspace-inline-panel px-4 py-4">
                          <div className="text-sm font-medium text-[var(--foreground)]">Care Profile</div>
                          <div className="workspace-muted mt-1 text-sm">
                            {careProfiles.find((profile) => profile.id === careProfileId)?.label || careProfileId}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistGeneralSettings()} type="button" variant="outline">
                            Save General Settings
                          </Button>
                          {characterStatus ? <div className="workspace-muted text-sm">{characterStatus}</div> : null}
                          {profileStatus ? <div className="workspace-muted text-sm">{profileStatus}</div> : null}
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}

                  {activeSettingsSection === "memory" ? (
                    <MemoryManagementPanel
                      activeChatId={activeChatId}
                      activeCharacterId={activeCharacterId}
                      isAdmin={Boolean(user?.is_admin)}
                      token={token}
                    />
                  ) : null}

                  {activeSettingsSection === "recognition" ? (
                    <Card className="border-[var(--line)] bg-[var(--card)] text-[var(--foreground)] shadow-2xl">
                      <CardContent className="space-y-4 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">Recognition</div>
                          <div className="mt-1 text-sm text-[var(--muted-foreground)]">Each user manages their own recognition enrollment here.</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            className="h-9 rounded-full px-3 text-xs"
                            onClick={() => setSettingsRecognitionTab("facial")}
                            type="button"
                            variant={settingsRecognitionTab === "facial" ? "default" : "outline"}
                          >
                            Facial
                          </Button>
                          <Button
                            className="h-9 rounded-full px-3 text-xs"
                            onClick={() => setSettingsRecognitionTab("vocal")}
                            type="button"
                            variant={settingsRecognitionTab === "vocal" ? "default" : "outline"}
                          >
                            Vocal
                          </Button>
                        </div>
                        {settingsRecognitionTab === "facial" ? (
                          <PersonRegistrationPanel
                            embedded
                            initialName={user?.display_name || ""}
                            onClose={() => undefined}
                            showRegisteredList={false}
                            token={token}
                          />
                        ) : (
                          <div className="rounded-2xl border border-[var(--line)] bg-[var(--input)] p-4 text-sm text-[var(--muted-foreground)]">
                            Vocal recognition is coming soon.
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ) : null}

                  {activeSettingsSection === "voice" ? (
                    <Card className="border-[var(--line)] bg-[var(--card)] text-[var(--foreground)] shadow-2xl">
                      <CardContent className="space-y-4 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">Voice</div>
                          <div className="mt-1 text-sm text-[var(--muted-foreground)]">Browser voices or local Piper output for spoken replies. This only applies when character mode is off.</div>
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--input)] px-4 py-4">
                          <div>
                            <div className="text-sm font-medium text-[var(--foreground)]">Voice Reply</div>
                            <div className="mt-1 text-sm text-[var(--muted-foreground)]">Choose browser voices or local Piper output</div>
                          </div>
                          <Button className="h-9 rounded-full px-3 text-xs" onClick={toggleVoiceReply} type="button" variant="outline">
                            {voiceReplyEnabled ? "On" : "Off"}
                          </Button>
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--input)] px-4 py-4">
                          <div>
                            <div className="text-sm font-medium text-[var(--foreground)]">Barge-In</div>
                            <div className="mt-1 text-sm text-[var(--muted-foreground)]">Let you interrupt spoken replies with your voice. Off by default.</div>
                          </div>
                          <Button
                            className="h-9 rounded-full px-3 text-xs"
                            onClick={() => void persistVoicePreferences({ bargeInEnabled: !bargeInEnabled })}
                            type="button"
                            variant="outline"
                          >
                            {bargeInEnabled ? "On" : "Off"}
                          </Button>
                        </div>
                        {voiceReplyEnabled ? (
                          <div className="space-y-3">
                            <Select onChange={(event) => handleVoiceSourceChange(event.target.value as "browser" | "piper")} value={voiceSource}>
                              <option value="browser">Browser voices</option>
                              <option value="piper">Piper voices</option>
                            </Select>
                            {voiceSource === "browser" ? (
                              <Select
                                disabled={!supportsVoiceOutput() || voiceOptions.length === 0}
                                onChange={(event) => handleVoiceSelection(event.target.value)}
                                value={selectedVoiceURI}
                              >
                                {voiceOptions.length === 0 ? <option value="">No browser voices</option> : voiceOptions.map((voice) => (
                                  <option key={voice.voiceURI} value={voice.voiceURI}>
                                    {voice.name}{voice.default ? " (default)" : ""}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <Select onChange={(event) => handlePiperVoiceChange(event.target.value)} value={selectedPiperVoiceId}>
                                {piperVoices.length === 0 ? <option value="">No Piper voices found</option> : piperVoices.map((voice) => (
                                  <option key={voice.id} value={voice.id}>
                                    {voice.label} ({voice.quality})
                                  </option>
                                ))}
                              </Select>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                className="h-9 rounded-full px-3 text-xs"
                                disabled={isPreviewingVoice || isInstallingVoice}
                                onClick={() => void previewSelectedVoice()}
                                type="button"
                                variant="outline"
                              >
                                {isPreviewingVoice ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                                {isPreviewingVoice ? "Previewing..." : "Preview voice"}
                              </Button>
                              {selectedPiperVoice && voiceSource === "piper" && !selectedPiperVoice.installed && user?.is_admin ? (
                                <Button className="h-9 rounded-full px-3 text-xs" disabled={isInstallingVoice} onClick={() => void installPiperVoiceById(selectedPiperVoice.id)} type="button" variant="outline">
                                  {isInstallingVoice ? "Installing..." : "Install"}
                                </Button>
                              ) : null}
                              {isInstallingVoice ? <div className="text-sm text-[var(--muted-foreground)]">Installing voice…</div> : null}
                            </div>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  ) : null}

                  {activeSettingsSection === "wakeword" ? (
                    <Card className="border-[var(--line)] bg-[var(--card)] text-[var(--foreground)] shadow-2xl">
                      <CardContent className="space-y-4 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">Wakeword</div>
                          <div className="mt-1 text-sm text-[var(--muted-foreground)]">Hands-free local wakeword monitoring and model selection. This only applies when character mode is off.</div>
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--input)] px-4 py-4">
                          <div>
                            <div className="text-sm font-medium text-[var(--foreground)]">Wakeword</div>
                            <div className="mt-1 text-sm text-[var(--muted-foreground)]">Hands-free LokiDoki trigger using the local wakeword model</div>
                          </div>
                          <Button
                            className="h-9 rounded-full px-3 text-xs"
                            disabled={!wakewordRuntime?.ready && !wakewordEnabled}
                            onClick={() => void persistWakewordPreferences({ enabled: !wakewordEnabled })}
                            type="button"
                            variant="outline"
                          >
                            {wakewordEnabled ? "On" : "Off"}
                          </Button>
                        </div>
                        <Select
                          disabled={wakewordSources.length === 0}
                          onChange={(event) => void persistWakewordPreferences({ modelId: event.target.value })}
                          value={wakewordModelId}
                        >
                          {wakewordSources.length === 0 ? <option value="">No wakeword models installed</option> : wakewordSources.map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.label}
                            </option>
                          ))}
                        </Select>
                        <div className="rounded-2xl border border-[var(--line)] bg-[var(--input)] px-4 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-[var(--foreground)]">Detection threshold</div>
                              <div className="mt-1 text-sm text-[var(--muted-foreground)]">Lower values trigger more easily. If scores stay near zero, this helps us separate calibration issues from audio-capture issues.</div>
                            </div>
                            <div className="text-sm font-medium text-[var(--foreground)]">{wakewordThreshold.toFixed(2)}</div>
                          </div>
                          <input
                            className="mt-4 w-full accent-[var(--accent)]"
                            max={0.99}
                            min={0.05}
                            onChange={(event) => {
                              const nextValue = Number(event.target.value)
                              setWakewordThreshold(nextValue)
                            }}
                            onMouseUp={(event) => {
                              const nextValue = Number((event.target as HTMLInputElement).value)
                              void persistWakewordPreferences({ threshold: nextValue })
                            }}
                            onTouchEnd={(event) => {
                              const nextValue = Number((event.target as HTMLInputElement).value)
                              void persistWakewordPreferences({ threshold: nextValue })
                            }}
                            step={0.01}
                            type="range"
                            value={wakewordThreshold}
                          />
                          <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                            <span>0.05 sensitive</span>
                            <span>0.99 strict</span>
                          </div>
                        </div>
                        <div className="text-sm text-[var(--muted-foreground)]">
                          {wakewordRuntime?.detail || "Wakeword status unavailable."}
                        </div>
                        <div className="rounded-2xl border border-[var(--line)] bg-[var(--input)] p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-[var(--foreground)]">Debug / Test</div>
                              <div className="mt-1 text-sm text-[var(--muted-foreground)]">Run a 5 second manual test and inspect live wakeword scores.</div>
                            </div>
                            <Button
                              className="h-9 rounded-full px-3 text-xs"
                              disabled={wakewordDebugResult.status === "running" || !wakewordRuntime?.ready}
                              onClick={() => void startWakewordDebugTest()}
                              type="button"
                              variant="outline"
                            >
                              {wakewordDebugResult.status === "running" ? "Testing..." : "Run wakeword test"}
                            </Button>
                          </div>
                          <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3 text-sm text-[var(--foreground)]">
                              <span>Echo cancellation</span>
                              <input
                                checked={wakewordEchoCancellationEnabled}
                                className="h-4 w-4 accent-[var(--accent)]"
                                onChange={(event) => setWakewordEchoCancellationEnabled(event.target.checked)}
                                type="checkbox"
                              />
                            </label>
                            <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3 text-sm text-[var(--foreground)]">
                              <span>Noise suppression</span>
                              <input
                                checked={wakewordNoiseSuppressionEnabled}
                                className="h-4 w-4 accent-[var(--accent)]"
                                onChange={(event) => setWakewordNoiseSuppressionEnabled(event.target.checked)}
                                type="checkbox"
                              />
                            </label>
                            <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3 text-sm text-[var(--foreground)]">
                              <span>Auto gain control</span>
                              <input
                                checked={wakewordAutoGainControlEnabled}
                                className="h-4 w-4 accent-[var(--accent)]"
                                onChange={(event) => setWakewordAutoGainControlEnabled(event.target.checked)}
                                type="checkbox"
                              />
                            </label>
                          </div>
                          <div className="mt-4">
                            <WakewordSignalVisualizer
                              isActive={wakewordDebugResult.status === "running" || isWakewordMonitoring}
                              level={Math.max(wakewordTelemetry.peak, wakewordTelemetry.rms * 2.5)}
                              showLegend
                              speechLevel={wakewordTelemetry.speechLevel}
                              wakewordScore={wakewordTelemetry.wakewordScore}
                            />
                          </div>
                          <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Status</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">{wakewordDebugResult.status}</div>
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Peak Score</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">{wakewordDebugResult.score.toFixed(3)}</div>
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Phrase</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">{wakewordRuntime?.source?.phrases?.join(", ") || "Not available"}</div>
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Threshold</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">{wakewordThreshold.toFixed(2)}</div>
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Signal</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">{Math.max(wakewordTelemetry.peak, wakewordTelemetry.rms * 2.5).toFixed(3)}</div>
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Speech</div>
                              <div className="mt-1 text-sm text-[var(--foreground)]">{wakewordTelemetry.speechLevel.toFixed(3)}</div>
                            </div>
                          </div>
                          <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3 text-sm text-[var(--foreground)]">
                            {wakewordDebugResult.detail}
                          </div>
                          <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3">
                            <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Recent Events</div>
                            <div className="mt-2 space-y-1 text-sm text-[var(--muted-foreground)]">
                              {wakewordDebugEvents.length === 0 ? (
                                <div>No events yet.</div>
                              ) : (
                                wakewordDebugEvents.map((event) => <div key={event}>{event}</div>)
                              )}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : activeView === "admin" ? (
            <div className="workspace-shell min-h-0 flex-1 overflow-hidden" ref={rightPaneScrollRef}>
              <div className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)] lg:grid-rows-1">
                  <div className="workspace-nav h-auto space-y-3 overflow-x-auto px-3 py-3 lg:h-full lg:px-4 lg:py-4">
                    <div className="workspace-rail-card p-3">
                      <Button className="w-full justify-start gap-2 rounded-2xl px-3 text-sm" onClick={() => setActiveView("assistant")} type="button" variant="ghost">
                        <ArrowUpDown className="h-4 w-4 rotate-90" />
                        Exit admin
                      </Button>
                    </div>
                    <div className="px-3 py-2">
                      <div className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">Administration</div>
                      <div className="mt-1 text-sm text-[var(--muted-foreground)]">Users, policies, skills, voices, characters, and system controls.</div>
                    </div>
                    {adminSections.map((section) => (
                      <button
                        key={section.id}
                        className={cn("workspace-section-button", activeAdminSection === section.id ? "is-active" : "")}
                        onClick={() => setActiveAdminSection(section.id)}
                        type="button"
                      >
                        <div className="text-sm font-medium">{section.label}</div>
                        <div className="workspace-section-detail mt-1 text-xs">{section.detail}</div>
                      </button>
                    ))}
                  </div>

                  <div className="workspace-content min-h-0 overflow-y-auto px-4 py-4 sm:px-6 lg:px-10 lg:py-8 xl:px-12">
                  <div className={cn(adminContentClass, "space-y-6")}>

                  {activeAdminSection === "characters" && isCharacterEditorOpen ? (
                    <div className="flex min-h-[calc(100dvh-10rem)] flex-col gap-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-3xl font-semibold tracking-tight text-[var(--foreground)]">Character Editor</div>
                          <div className="mt-1 text-sm text-[var(--muted-foreground)]">
                            Edit the active character in the admin workspace while keeping navigation and character catalog context in view.
                          </div>
                        </div>
                        <Button className="h-9 rounded-full px-3 text-xs" onClick={() => setIsCharacterEditorOpen(false)} type="button" variant="outline">
                          Back To Characters
                        </Button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden rounded-[28px] border border-[var(--line)] bg-[var(--card)]/95 shadow-[var(--shadow-strong)]">
                        <iframe
                          allow="microphone"
                          className="h-full min-h-[calc(100dvh-17rem)] w-full bg-transparent"
                          src={characterEditorUrl}
                          title="Character Editor Full Admin Workspace"
                        />
                      </div>
                    </div>
                  ) : null}

                  {activeAdminSection === "dashboard" ? (
                    <div className="space-y-4">
                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="space-y-4 p-5 sm:p-6">
                          <div>
                            <div className="flex items-center gap-2 text-xl font-semibold">
                              <Server className="h-5 w-5 text-zinc-400" />
                              Dashboard
                            </div>
                            <div className="mt-1 text-sm text-zinc-500">Nodes, users, and live CPU, memory, and disk usage for the system, LokiDoki, and Ollama.</div>
                          </div>
                          {adminRuntimeMetrics ? (
                            <div className="space-y-4">
                              <div className="grid gap-3 md:grid-cols-2">
                                <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                                  <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Nodes</div>
                                  <div className="mt-2 text-2xl font-semibold text-zinc-100">
                                    {adminRuntimeMetrics.overview.nodes_connected} / {adminRuntimeMetrics.overview.nodes_total}
                                  </div>
                                  <div className="mt-1 text-xs text-zinc-500">Connected vs total nodes</div>
                                </div>
                                <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                                  <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Users</div>
                                  <div className="mt-2 text-2xl font-semibold text-zinc-100">{adminRuntimeMetrics.overview.users_total}</div>
                                  <div className="mt-1 text-xs text-zinc-500">Users on this LokiDoki install</div>
                                </div>
                              </div>
                              <div className="grid gap-3 xl:grid-cols-3">
                                {adminRuntimeMetrics.resources.map((resource) => (
                                  <div key={resource.key} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                                    <div className="text-sm font-semibold text-zinc-100">{resource.label}</div>
                                    <div className="mt-1 text-xs text-zinc-500">{resource.detail}</div>
                                    <div className="mt-4 space-y-3">
                                      <div className="space-y-1">
                                        <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-zinc-500">
                                          <span>CPU</span>
                                          <span className="text-zinc-100">{resource.cpu_percent.toFixed(1)}%</span>
                                        </div>
                                        <div className="relative h-10 overflow-hidden rounded-xl border border-white/8 bg-white/[0.03]">
                                          <div className="absolute inset-y-0 left-0 bg-cyan-400/20" style={{ width: metricBarWidth(resource.cpu_percent) }} />
                                        </div>
                                      </div>
                                      <div className="space-y-1">
                                        <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-zinc-500">
                                          <span>Memory</span>
                                          <span className="text-zinc-100">{resource.memory_percent.toFixed(1)}%</span>
                                        </div>
                                        <div className="relative h-10 overflow-hidden rounded-xl border border-white/8 bg-white/[0.03]">
                                          <div className="absolute inset-y-0 left-0 bg-violet-400/20" style={{ width: metricBarWidth(resource.memory_percent) }} />
                                        </div>
                                        <div className="text-xs text-zinc-500">{formatBytes(resource.memory_used_bytes)} of {formatBytes(resource.memory_total_bytes)}</div>
                                      </div>
                                      <div className="space-y-1">
                                        <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-zinc-500">
                                          <span>Disk</span>
                                          <span className="text-zinc-100">{resource.disk_percent.toFixed(1)}%</span>
                                        </div>
                                        <div className="relative h-10 overflow-hidden rounded-xl border border-white/8 bg-white/[0.03]">
                                          <div className="absolute inset-y-0 left-0 bg-rose-400/20" style={{ width: metricBarWidth(resource.disk_percent) }} />
                                        </div>
                                        <div className="text-xs text-zinc-500">{formatBytes(resource.disk_used_bytes)} of {formatBytes(resource.disk_total_bytes)}</div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                                <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Storage Footprint</div>
                                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                  {adminRuntimeMetrics.storage.map((bucket) => (
                                    <div key={bucket.key} className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-medium text-zinc-100">{bucket.label}</div>
                                        <div className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${bucket.exists ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                                          {bucket.exists ? formatBytes(bucket.size_bytes) : "Missing"}
                                        </div>
                                      </div>
                                      <div className="mt-2 break-words text-xs text-zinc-500">{bucket.path}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                                <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Tracked Processes</div>
                                <div className="mt-3 grid gap-3 lg:grid-cols-3">
                                  {adminRuntimeMetrics.processes.map((process) => (
                                    <div key={process.label} className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-medium text-zinc-100">{process.label}</div>
                                        <div className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${process.running ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                                          {process.running ? "Running" : "Idle"}
                                        </div>
                                      </div>
                                      <div className="mt-3 grid gap-1 text-sm text-zinc-300">
                                        <div>CPU: {process.cpu_percent.toFixed(1)}%</div>
                                        <div>Memory: {formatBytes(process.memory_bytes)}</div>
                                        <div>PID: {process.pid || "n/a"}</div>
                                      </div>
                                      {process.command ? <div className="mt-2 break-words text-xs text-zinc-500">{process.command}</div> : null}
                                    </div>
                                  ))}
                                </div>
                                <div className="mt-3 text-xs text-zinc-500">Disk path tracked: {adminRuntimeMetrics.system.disk.path}</div>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm text-zinc-500">Loading runtime metrics…</div>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {activeAdminSection === "general" ? (
                    <div className="space-y-4">
                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="space-y-4 p-5 sm:p-6">
                          <div>
                            <div className="text-xl font-semibold">System Defaults</div>
                            <div className="mt-1 text-sm text-zinc-500">Set the default character and the local node name for this LokiDoki installation.</div>
                          </div>
                          {adminAccount ? (
                            <div className="space-y-4">
                              <div className="space-y-2">
                                <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Node Name</div>
                                <Input
                                  onChange={(event) => setAdminAccount({ ...adminAccount, name: event.target.value })}
                                  placeholder="Kitchen display, office Pi, main Mac, etc."
                                  value={adminAccount.name}
                                />
                                <div className="text-sm text-zinc-500">
                                  This identifies this LokiDoki node. Today it is used as the local install name in the app, and later it will help distinguish nodes in a multi-node setup.
                                </div>
                              </div>
                              <div className="space-y-2">
                                <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Default Character</div>
                                <Select
                                  onChange={(event) => setAdminAccount({ ...adminAccount, default_character_id: event.target.value })}
                                  value={adminAccount.default_character_id}
                                >
                                  {characters.map((character) => (
                                    <option key={character.id} value={character.id}>
                                      {character.name}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                              <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistAdminAccountSettings(adminAccount)} type="button" variant="outline">
                                Save System Defaults
                              </Button>
                            </div>
                          ) : (
                            <div className="text-sm text-zinc-500">Loading system defaults…</div>
                          )}
                        </CardContent>
                      </Card>

                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="space-y-4 p-5 sm:p-6">
                          <div>
                            <div className="text-xl font-semibold">Prompt Policy</div>
                            <div className="mt-1 text-sm text-zinc-500">Global install-level prompt rules layered above characters and user prompts.</div>
                          </div>
                          {adminPromptPolicy ? (
                            <div className="space-y-3">
                              <div className="space-y-2">
                                <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Policy Prompt</div>
                                <div className="text-sm text-zinc-500">Install-wide rules that apply above characters and user prompts.</div>
                                <Textarea
                                  onChange={(event) => setAdminPromptPolicy({ ...adminPromptPolicy, account_policy_prompt: event.target.value })}
                                  placeholder={PROMPT_EXAMPLES.accountPolicy}
                                  rows={5}
                                  value={adminPromptPolicy.account_policy_prompt}
                                />
                                <div className="text-xs text-zinc-600">{PROMPT_EXAMPLES.accountPolicy}</div>
                              </div>
                              <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistAdminPromptPolicy(adminPromptPolicy)} type="button" variant="outline">
                                Save Prompt Policy
                              </Button>
                            </div>
                          ) : (
                            <div className="text-sm text-zinc-500">Loading prompt policy…</div>
                          )}
                        </CardContent>
                      </Card>

                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="space-y-4 p-5 sm:p-6">
                          <div>
                            <div className="text-xl font-semibold">Conversational Tone</div>
                            <div className="mt-1 text-sm text-zinc-500">Global behavior for conversational filler and helpfulness.</div>
                          </div>
                          {adminPromptPolicy ? (
                            <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
                              <div>
                                <div className="text-sm font-medium text-zinc-100">Proactive Chatter</div>
                                <div className="mt-1 text-sm text-zinc-500">Enable conversational filler and helpful follow-up questions for all users.</div>
                              </div>
                              <Button
                                className="h-9 rounded-full px-3 text-xs"
                                onClick={() => {
                                  if (!adminPromptPolicy) return
                                  const nextEnabled = !adminPromptPolicy.proactive_chatter_enabled
                                  const updated = { ...adminPromptPolicy, proactive_chatter_enabled: nextEnabled }
                                  setAdminPromptPolicy(updated)
                                  void persistAdminPromptPolicy(updated)
                                }}
                                type="button"
                                variant="outline"
                              >
                                {adminPromptPolicy.proactive_chatter_enabled ? "On" : "Off"}
                              </Button>
                            </div>
                          ) : (
                            <div className="text-sm text-zinc-500">Loading policy…</div>
                          )}
                        </CardContent>
                      </Card>

                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="space-y-4 p-5 sm:p-6">
                          <div>
                            <div className="text-xl font-semibold">Updates</div>
                            <div className="mt-1 text-sm text-zinc-500">Manage how skills and system components update.</div>
                          </div>
                          {adminAccount ? (
                            <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
                              <div>
                                <div className="text-sm font-medium text-zinc-100">Update Skills on Restart</div>
                                <div className="mt-1 text-sm text-zinc-500">Automatically check for and install skill updates when the LokiDoki server starts.</div>
                              </div>
                              <Button
                                className="h-9 rounded-full px-3 text-xs"
                                onClick={() => {
                                  if (!adminAccount) return
                                  const nextEnabled = !adminAccount.auto_update_skills
                                  const updated = { ...adminAccount, auto_update_skills: nextEnabled }
                                  setAdminAccount(updated)
                                  void persistAdminAccountSettings(updated)
                                }}
                                type="button"
                                variant="outline"
                              >
                                {adminAccount.auto_update_skills ? "On" : "Off"}
                              </Button>
                            </div>
                          ) : (
                            <div className="text-sm text-zinc-500">Loading update settings…</div>
                          )}
                        </CardContent>
                      </Card>

                    </div>
                  ) : null}

                  {activeAdminSection === "users" ? (
                    <div className="space-y-4">
                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="space-y-6 p-5 sm:p-6">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <div className="text-xl font-semibold">Users</div>
                              <div className="mt-1 text-sm text-zinc-500">Manage each user account: care profile, character access, admin rights, and password.</div>
                            </div>
                            <div className="w-full max-w-sm">
                              <Input onChange={(event) => setAdminUserSearch(event.target.value)} placeholder="Search users" value={adminUserSearch} />
                            </div>
                          </div>
                          {adminNotice ? <div className="text-sm text-zinc-500">{adminNotice}</div> : null}
                          <div className="space-y-3">
                            {filteredAdminUsers.map((item) => (
                              <div key={item.id} className="border border-white/8 bg-white/[0.03] px-4 py-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                  <div>
                                    <div className="text-sm font-medium text-zinc-100">{item.display_name}</div>
                                    <div className="mt-1 text-xs text-zinc-500">@{item.username}</div>
                                    <div className="mt-1 text-xs uppercase tracking-[0.14em] text-zinc-600">
                                      {item.is_admin ? "Admin" : "Standard user"}
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void updateAdminUserRole(item.id, !item.is_admin)} type="button" variant="outline">
                                      {item.is_admin ? "Remove Admin" : "Make Admin"}
                                    </Button>
                                    <Button className="h-8 rounded-full px-3 text-xs text-rose-200" onClick={() => void deleteAdminUserById(item.id)} type="button" variant="outline">
                                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                                      Delete
                                    </Button>
                                  </div>
                                </div>
                                <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                                  <div className="space-y-3">
                                <Select
                                  onChange={(event) =>
                                        setAdminUserCharacterDrafts((current) => ({
                                          ...current,
                                          [item.id]: {
                                            ...(current[item.id] || { care_profile_id: "standard", character_enabled: true, assigned_character_id: "", can_select_character: true, admin_prompt: "" }),
                                            care_profile_id: event.target.value,
                                          },
                                        }))
                                      }
                                      value={adminUserCharacterDrafts[item.id]?.care_profile_id || "standard"}
                                    >
                                      {adminCareProfiles.map((profile) => (
                                        <option key={profile.id} value={profile.id}>
                                          {profile.label}
                                        </option>
                                      ))}
                                    </Select>
                                    <Select
                                      onChange={(event) =>
                                        setAdminUserCharacterDrafts((current) => ({
                                          ...current,
                                          [item.id]: {
                                            ...(current[item.id] || { care_profile_id: "standard", character_enabled: true, assigned_character_id: "", can_select_character: true, admin_prompt: "" }),
                                            assigned_character_id: event.target.value,
                                          },
                                        }))
                                      }
                                      value={adminUserCharacterDrafts[item.id]?.assigned_character_id || ""}
                                    >
                                      <option value="">No forced assignment</option>
                                      {characters.filter((character) => character.enabled).map((character) => (
                                        <option key={character.id} value={character.id}>
                                          {character.name}
                                        </option>
                                      ))}
                                    </Select>
                                    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                                      <div className="text-sm text-zinc-300">Character access</div>
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        onClick={() =>
                                          setAdminUserCharacterDrafts((current) => ({
                                            ...current,
                                            [item.id]: {
                                              ...(current[item.id] || { care_profile_id: "standard", character_enabled: true, assigned_character_id: "", can_select_character: true, admin_prompt: "" }),
                                              character_enabled: !(current[item.id]?.character_enabled ?? true),
                                            },
                                          }))
                                        }
                                        type="button"
                                        variant="outline"
                                      >
                                        {adminUserCharacterDrafts[item.id]?.character_enabled ?? true ? "Allowed" : "Off"}
                                      </Button>
                                    </div>
                                    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                                      <div className="text-sm text-zinc-300">Can select a different character</div>
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        onClick={() =>
                                          setAdminUserCharacterDrafts((current) => ({
                                            ...current,
                                            [item.id]: {
                                              ...(current[item.id] || { care_profile_id: "standard", character_enabled: true, assigned_character_id: "", can_select_character: true, admin_prompt: "" }),
                                              can_select_character: !(current[item.id]?.can_select_character ?? true),
                                            },
                                          }))
                                        }
                                        type="button"
                                        variant="outline"
                                      >
                                        {adminUserCharacterDrafts[item.id]?.can_select_character ?? true ? "Allowed" : "Locked"}
                                      </Button>
                                    </div>
                                    <Textarea
                                      onChange={(event) =>
                                        setAdminUserCharacterDrafts((current) => ({
                                          ...current,
                                          [item.id]: {
                                            ...(current[item.id] || { care_profile_id: "standard", character_enabled: true, assigned_character_id: "", can_select_character: true, admin_prompt: "" }),
                                            admin_prompt: event.target.value,
                                          },
                                        }))
                                      }
                                      placeholder={PROMPT_EXAMPLES.adminOverride}
                                      rows={3}
                                      value={adminUserCharacterDrafts[item.id]?.admin_prompt || ""}
                                    />
                                    <div className="text-xs text-zinc-600">{PROMPT_EXAMPLES.adminOverride}</div>
                                    <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistAdminUserCharacterSettings(item.id)} type="button" variant="outline">
                                      Save User Settings
                                    </Button>
                                    <div className="space-y-3 rounded-[24px] border border-[var(--line)] bg-[var(--panel-strong)]/65 p-4">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                          <div className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Theme Override</div>
                                          <div className="mt-1 text-sm text-[var(--muted-foreground)]">
                                            Force a complete appearance preset and mode for this user.
                                          </div>
                                        </div>
                                        <Button
                                          className="h-8 rounded-full px-3 text-xs"
                                          onClick={() =>
                                            setAdminUserThemeDrafts((current) => ({
                                              ...current,
                                              [item.id]: {
                                                ...(current[item.id] || {
                                                  theme_admin_override_enabled: false,
                                                  theme_admin_override_preset_id: item.theme_admin_override_preset_id,
                                                  theme_admin_override_mode: item.theme_admin_override_mode,
                                                }),
                                                theme_admin_override_enabled: !(current[item.id]?.theme_admin_override_enabled ?? item.theme_admin_override_enabled),
                                              },
                                            }))
                                          }
                                          type="button"
                                          variant="outline"
                                        >
                                          {(adminUserThemeDrafts[item.id]?.theme_admin_override_enabled ?? item.theme_admin_override_enabled) ? "Forced" : "Use User Choice"}
                                        </Button>
                                      </div>
                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <Select
                                          disabled={!(adminUserThemeDrafts[item.id]?.theme_admin_override_enabled ?? item.theme_admin_override_enabled)}
                                          onChange={(event) =>
                                            setAdminUserThemeDrafts((current) => ({
                                              ...current,
                                              [item.id]: {
                                                ...(current[item.id] || {
                                                  theme_admin_override_enabled: item.theme_admin_override_enabled,
                                                  theme_admin_override_preset_id: item.theme_admin_override_preset_id,
                                                  theme_admin_override_mode: item.theme_admin_override_mode,
                                                }),
                                                theme_admin_override_preset_id: event.target.value as ThemePresetId,
                                              },
                                            }))
                                          }
                                          value={adminUserThemeDrafts[item.id]?.theme_admin_override_preset_id || item.theme_admin_override_preset_id}
                                        >
                                          {themeCatalog.map((preset) => (
                                            <option key={preset.id} value={preset.id}>
                                              {preset.name}
                                            </option>
                                          ))}
                                        </Select>
                                        <Select
                                          disabled={!(adminUserThemeDrafts[item.id]?.theme_admin_override_enabled ?? item.theme_admin_override_enabled)}
                                          onChange={(event) =>
                                            setAdminUserThemeDrafts((current) => ({
                                              ...current,
                                              [item.id]: {
                                                ...(current[item.id] || {
                                                  theme_admin_override_enabled: item.theme_admin_override_enabled,
                                                  theme_admin_override_preset_id: item.theme_admin_override_preset_id,
                                                  theme_admin_override_mode: item.theme_admin_override_mode,
                                                }),
                                                theme_admin_override_mode: event.target.value as ThemeMode,
                                              },
                                            }))
                                          }
                                          value={adminUserThemeDrafts[item.id]?.theme_admin_override_mode || item.theme_admin_override_mode}
                                        >
                                          <option value="light">Light</option>
                                          <option value="dark">Dark</option>
                                          <option value="auto">Auto</option>
                                        </Select>
                                      </div>
                                      <div className="text-xs text-[var(--muted-foreground)]">
                                        Effective appearance: {item.effective_theme_preset_id} / {item.effective_theme_mode}
                                      </div>
                                      <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistAdminUserThemeSettings(item.id)} type="button" variant="outline">
                                        Save Theme Override
                                      </Button>
                                    </div>
                                    <div className="space-y-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                                      <div className="flex items-center justify-between gap-3">
                                        <div>
                                          <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Compact Prompt</div>
                                          <div className="text-xs text-zinc-600">
                                            {item.compiled_prompt_hash ? `Hash ${item.compiled_prompt_hash.slice(0, 12)}` : "Not compiled yet"}
                                          </div>
                                        </div>
                                        <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void recompileAdminUserPrompt(item.id)} type="button" variant="outline">
                                          Recompile
                                        </Button>
                                      </div>
                                      <Textarea readOnly rows={6} value={item.compiled_base_prompt || ""} />
                                    </div>
                                  </div>
                                  <div className="space-y-3">
                                    <Input
                                      onChange={(event) => setUserPasswordDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                                      placeholder="Set a new password"
                                      type="password"
                                      value={userPasswordDrafts[item.id] || ""}
                                    />
                                    <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void updateAdminUserPassword(item.id)} type="button" variant="outline">
                                      <KeyRound className="mr-2 h-4 w-4" />
                                      Change Password
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {activeAdminSection === "care_profiles" ? (
                    <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                      <CardContent className="space-y-4 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">Care Profiles</div>
                          <div className="mt-1 text-sm text-zinc-500">Inspect built-ins and create or edit custom care profiles with explicit labeled fields.</div>
                        </div>
                        <div className="space-y-2">
                          {adminCareProfiles.map((profile) => (
                            <button
                              key={profile.id}
                              className="w-full rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-left"
                              onClick={() => setCareProfileDraft(profile)}
                              type="button"
                            >
                              <div className="text-sm font-medium text-zinc-100">{profile.label}</div>
                              <div className="mt-1 text-sm text-zinc-500">
                                {profile.tone || "No tone set"} · {profile.vocabulary} vocabulary · {profile.sentence_length} sentences · {profile.response_style} replies
                              </div>
                              <div className="mt-1 text-xs text-zinc-600">
                                Blocked topics: {profile.blocked_topics.length > 0 ? profile.blocked_topics.join(", ") : "none"}
                              </div>
                            </button>
                          ))}
                        </div>
                        <div className="grid gap-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Profile ID</div>
                            <Input onChange={(event) => setCareProfileDraft({ ...careProfileDraft, id: event.target.value })} placeholder="child_safe_custom" value={careProfileDraft.id} />
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Label</div>
                            <Input onChange={(event) => setCareProfileDraft({ ...careProfileDraft, label: event.target.value })} placeholder="Profile label" value={careProfileDraft.label} />
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Tone</div>
                            <Textarea onChange={(event) => setCareProfileDraft({ ...careProfileDraft, tone: event.target.value })} placeholder="warm, simple, encouraging" rows={2} value={careProfileDraft.tone} />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Vocabulary</div>
                              <Select onChange={(event) => setCareProfileDraft({ ...careProfileDraft, vocabulary: event.target.value })} value={careProfileDraft.vocabulary}>
                                <option value="simple">Simple</option>
                                <option value="standard">Standard</option>
                                <option value="advanced">Advanced</option>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Sentence Length</div>
                              <Select onChange={(event) => setCareProfileDraft({ ...careProfileDraft, sentence_length: event.target.value })} value={careProfileDraft.sentence_length}>
                                <option value="short">Short</option>
                                <option value="medium">Medium</option>
                                <option value="any">Any</option>
                              </Select>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Default Response Style</div>
                            <Select onChange={(event) => setCareProfileDraft({ ...careProfileDraft, response_style: event.target.value })} value={careProfileDraft.response_style}>
                              <option value="brief">Brief</option>
                              <option value="balanced">Balanced</option>
                              <option value="detailed">Detailed</option>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Blocked Topics</div>
                            <Input
                              onChange={(event) => setCareProfileDraft({ ...careProfileDraft, blocked_topics: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}
                              placeholder="violence, adult_content"
                              value={careProfileDraft.blocked_topics.join(", ")}
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Max Response Tokens</div>
                            <Input
                              onChange={(event) => setCareProfileDraft({ ...careProfileDraft, max_response_tokens: Number(event.target.value || 160) })}
                              placeholder="160"
                              type="number"
                              value={String(careProfileDraft.max_response_tokens)}
                            />
                          </div>
                          <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void persistCareProfile()} type="button" variant="outline">
                            Save Care Profile
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}

                  {activeAdminSection === "prompt_lab" ? (
                    <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                      <CardContent className="space-y-6 p-5 sm:p-6">
                        <div>
                          <div className="text-xl font-semibold">Prompt Lab</div>
                          <div className="mt-1 text-sm text-zinc-500">Run a one-off message as any user and inspect the rendered response, skill routing, timing, character, care profile, and final LLM messages.</div>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                          <div className="space-y-4 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                            <div className="space-y-2">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Run As User</div>
                              <Select
                                onChange={(event) => {
                                  setPromptLabUserId(event.target.value)
                                  setPromptLabResult(null)
                                }}
                                value={promptLabUserId}
                              >
                                <option value="">Select a user</option>
                                {adminUsers.map((item) => (
                                  <option key={`prompt-lab-${item.id}`} value={item.id}>
                                    {item.display_name} (@{item.username})
                                  </option>
                                ))}
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Message</div>
                              <Textarea onChange={(event) => setPromptLabMessage(event.target.value)} rows={6} value={promptLabMessage} />
                            </div>
                            <div className="space-y-2">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Skill Path</div>
                              <div className="flex flex-wrap gap-2">
                                <Button className="h-8 rounded-full px-3 text-xs" onClick={() => setPromptLabUseSkills(true)} type="button" variant={promptLabUseSkills ? "default" : "outline"}>
                                  Skills On
                                </Button>
                                <Button className="h-8 rounded-full px-3 text-xs" onClick={() => setPromptLabUseSkills(false)} type="button" variant={!promptLabUseSkills ? "default" : "outline"}>
                                  Skills Off
                                </Button>
                              </div>
                            </div>
                            <div className="space-y-2">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Prompt Layers</div>
                              <div className="flex flex-wrap gap-2">
                                {PROMPT_LAB_LAYER_OPTIONS.map(({ id, label }) => (
                                  <Button
                                    key={id}
                                    className="h-8 rounded-full px-3 text-xs"
                                    onClick={() => togglePromptLabLayer(id as PromptLabLayerKey)}
                                    type="button"
                                    variant={promptLabLayers[id] ? "default" : "outline"}
                                  >
                                    {label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Draft Layers</div>
                                <Button
                                  className="h-8 rounded-full px-3 text-xs"
                                  disabled={!promptLabUserId}
                                  onClick={() => void refreshPromptLabCompilePreview()}
                                  type="button"
                                  variant="outline"
                                >
                                  Recompile Draft
                                </Button>
                              </div>
                              <div className="space-y-3">
                                {PROMPT_LAB_LAYER_OPTIONS.map(({ id, label }) => (
                                  <div key={`draft-${id}`} className="space-y-2">
                                    <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</div>
                                    <Textarea
                                      onChange={(event) =>
                                        setPromptLabLayerDrafts((current) => ({
                                          ...current,
                                          [id]: event.target.value,
                                        }))
                                      }
                                      rows={id === "care_profile_prompt" ? 5 : 3}
                                      value={promptLabLayerDrafts[id] || ""}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                            <Button className="h-9 rounded-full px-3 text-xs" disabled={isPromptLabPending || !promptLabUserId || !promptLabMessage.trim()} onClick={() => void runPromptLab()} type="button" variant="outline">
                              {isPromptLabPending ? "Running..." : "Run Prompt Test"}
                            </Button>
                            {promptLabError ? (
                              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                                {promptLabError}
                              </div>
                            ) : null}
                          </div>

                          <div className="space-y-4">
                            {promptLabResult ? (
                              <>
                                <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
                                  <div className="text-sm font-medium text-zinc-100">Execution Summary</div>
                                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">User</div>
                                      <div className="mt-1 text-sm text-zinc-100">{promptLabResult.user.display_name}</div>
                                      <div className="text-xs text-zinc-500">@{promptLabResult.user.username}</div>
                                    </div>
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Elapsed</div>
                                      <div className="mt-1 text-sm text-zinc-100">{formatSeconds(promptLabResult.elapsed_ms)} total</div>
                                      <div className="text-xs text-zinc-500">{promptLabResult.execution.backend} · {promptLabResult.execution.model}</div>
                                    </div>
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Character</div>
                                      <div className="mt-1 text-sm text-zinc-100">{promptLabResult.character.id || "Neutral LokiDoki"}</div>
                                      <div className="text-xs text-zinc-500">{promptLabResult.character.enabled ? "Character layer on" : "Character layer off"}</div>
                                    </div>
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Care Profile</div>
                                      <div className="mt-1 text-sm text-zinc-100">{promptLabResult.care_profile.label}</div>
                                      <div className="text-xs text-zinc-500">{promptLabResult.care_profile.id}</div>
                                    </div>
                                  </div>
                                  <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                    <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Route</div>
                                    <div className="mt-1 text-sm text-zinc-100">{promptLabResult.route.request_type} → {promptLabResult.route.route}</div>
                                    <div className="mt-1 text-sm text-zinc-400">{promptLabResult.route.reason}</div>
                                  </div>
                                  <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                    <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Bottleneck</div>
                                    <div className="mt-1 text-sm text-zinc-100">
                                      {promptLabBottleneck(promptLabResult).label} · {formatSeconds(promptLabBottleneck(promptLabResult).durationMs)}
                                    </div>
                                    <div className="mt-1 text-xs text-zinc-500">Compare this with the timing breakdown below to see whether the slow part is skill work or the final render pass.</div>
                                  </div>
                                  <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                    <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Rendered Response</div>
                                    <div className="mt-2">
                                      <AssistantMessageCard
                                        debugNow={debugNow}
                                        message={promptLabPreviewMessage(promptLabResult)}
                                        messageKey={`prompt-lab:${promptLabResult.user.id}:${promptLabResult.elapsed_ms}`}
                                        onPlayVoice={(message, messageKey) => void playMessageVoice(message, messageKey)}
                                        pendingSpeechMessageKey={pendingSpeechMessageKey}
                                        showRuntimeDebug={true}
                                        speakingMessageKey={speakingMessageKey}
                                      />
                                    </div>
                                  </div>
                                </div>

                                <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
                                  <div className="text-sm font-medium text-zinc-100">Routing Trace</div>
                                  <div className="mt-1 text-sm text-zinc-500">This shows whether a skill ran before the final render pass and which cached prompt bundle was used.</div>
                                  <div className="mt-3 space-y-3">
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Timing Breakdown</div>
                                      <div className="mt-2 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                                        <div>Prompt compile: {formatSeconds(promptLabResult.timings.context_build_ms)}</div>
                                        <div>Skill route: {formatSeconds(promptLabResult.timings.skill_route_ms)}</div>
                                        <div>Skill execute: {formatSeconds(promptLabResult.timings.skill_execute_ms)}</div>
                                        <div>Final render: {formatSeconds(promptLabResult.timings.render_ms)}</div>
                                      </div>
                                    </div>
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Skill Route</div>
                                      <div className="mt-1 text-sm text-zinc-100">{promptLabResult.skill_route.outcome}</div>
                                      <div className="text-sm text-zinc-400">{promptLabResult.skill_route.reason}</div>
                                      {promptLabResult.skill_route.candidate ? (
                                        <div className="mt-2 text-xs text-zinc-500">
                                          Candidate: {promptLabResult.skill_route.candidate.skill_id}.{promptLabResult.skill_route.candidate.action}
                                        </div>
                                      ) : null}
                                    </div>
                                    {promptLabResult.skill_execution ? (
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                        <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Skill Output</div>
                                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-400">{JSON.stringify(promptLabResult.skill_execution.result, null, 2)}</pre>
                                      </div>
                                    ) : null}
                                    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Prompt Bundle</div>
                                      <div className="mt-2 text-xs text-zinc-400">
                                        Prompt hash: {promptLabResult.prompt_debug.prompt_hash || "n/a"} · Cache hit: {promptLabResult.prompt_debug.cache_hit ? "yes" : "no"}
                                      </div>
                                      {promptLabResult.prompt_debug.enabled_layers ? (
                                        <div className="mt-2 text-xs text-zinc-500">
                                          Layers: {Object.entries(promptLabResult.prompt_debug.enabled_layers).filter(([, enabled]) => enabled).map(([key]) => key).join(", ")}
                                        </div>
                                      ) : null}
                                      {promptLabResult.prompt_debug.policy_blocked ? (
                                        <div className="mt-2 text-xs text-amber-200">
                                          Policy blocked. Topics: {(promptLabResult.prompt_debug.blocked_topics || []).join(", ") || "none"}
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>

                                <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
                                  <div className="text-sm font-medium text-zinc-100">Compiled Prompt Preview</div>
                                  <div className="mt-1 text-sm text-zinc-500">This recompiles the current draft layer stack without saving it.</div>
                                  {promptLabCompilePreview ? (
                                    <div className="mt-4 space-y-3">
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-xs text-zinc-400">
                                        Prompt hash: {promptLabCompilePreview.prompt_hash} · Compile: {formatSeconds(promptLabCompilePreview.timing_ms)}
                                      </div>
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                        <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Compiled Prompt</div>
                                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">{promptLabCompilePreview.compiled_prompt}</pre>
                                      </div>
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                        <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Exact Compiler Prompt</div>
                                        <div className="mt-3 space-y-3">
                                          {promptLabCompilePreview.compiler_messages.map((message, index) => (
                                            <div key={`compiler-message-${index}`} className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">{message.role}</div>
                                              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">{message.content}</pre>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-sm text-zinc-400">
                                      Pick a user to load the current prompt layers, then edit and recompile the draft here.
                                    </div>
                                  )}
                                </div>

                                <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
                                  <div className="text-sm font-medium text-zinc-100">Final LLM Messages</div>
                                  <div className="mt-1 text-sm text-zinc-500">Each model call currently sends one cached system prompt plus one runtime user message. If no messages appear here, the reply stayed deterministic and never called the LLM.</div>
                                  {promptLabResult.prompt_debug.llm_used && promptLabResult.prompt_debug.llm_messages && promptLabResult.prompt_debug.llm_messages.length > 0 ? (
                                    <div className="mt-4 space-y-3">
                                      {promptLabResult.prompt_debug.llm_messages.map((message, index) => (
                                        <div key={`prompt-debug-${index}`} className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                          <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">{message.role}</div>
                                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">{message.content}</pre>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-sm text-zinc-400">
                                      No LLM prompt was used for this request. This usually means the response was local, policy-blocked, or fully deterministic.
                                    </div>
                                  )}
                                </div>
                              </>
                            ) : (
                              <div className="space-y-4">
                                <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
                                  <div className="text-sm font-medium text-zinc-100">Compiled Prompt Preview</div>
                                  <div className="mt-1 text-sm text-zinc-500">Load a user, edit the draft layers on this page, and recompile without saving any changes.</div>
                                  {promptLabCompilePreview ? (
                                    <div className="mt-4 space-y-3">
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-xs text-zinc-400">
                                        Prompt hash: {promptLabCompilePreview.prompt_hash} · Compile: {formatSeconds(promptLabCompilePreview.timing_ms)}
                                      </div>
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                        <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Compiled Prompt</div>
                                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">{promptLabCompilePreview.compiled_prompt}</pre>
                                      </div>
                                      <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                        <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Exact Compiler Prompt</div>
                                        <div className="mt-3 space-y-3">
                                          {promptLabCompilePreview.compiler_messages.map((message, index) => (
                                            <div key={`compiler-preview-${index}`} className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                                              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">{message.role}</div>
                                              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">{message.content}</pre>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="mt-4 rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-sm text-zinc-500">
                                      Pick a user to load prompt layers, or run a prompt test to inspect the full orchestration path.
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}

                  {activeAdminSection === "characters" && !isCharacterEditorOpen ? (
                    <div className="space-y-4">
                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="flex max-h-[calc(100dvh-13rem)] min-h-[28rem] flex-col gap-4 p-5 sm:p-6">
                          <input
                            ref={characterImportInputRef}
                            accept=".json"
                            className="hidden"
                            onChange={(event) => void handleCharacterImport(event)}
                            type="file"
                          />
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <div className="text-xl font-semibold">Character Catalog</div>
                              <div className="mt-1 text-sm text-zinc-500">
                                Search installed and available characters, then open a focused editor only when you need to change one.
                              </div>
                              {characterCatalogRepository ? (
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                                  <span>{characterCatalogRepository.description}</span>
                                  {characterCatalogRepository.repo_url ? (
                                    <Button
                                      className="h-7 rounded-full px-3 text-[11px]"
                                      onClick={() => openExternalUrl(characterCatalogRepository.repo_url)}
                                      type="button"
                                      variant="outline"
                                    >
                                      Open Repo
                                    </Button>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button className="h-9 rounded-full px-3 text-xs" onClick={() => openCharacterEditor()} type="button">
                                <Sparkles className="mr-2 h-3.5 w-3.5" />
                                New Character
                              </Button>
                              <Button className="h-9 rounded-full px-3 text-xs" onClick={() => characterImportInputRef.current?.click()} type="button" variant="outline">
                                <Upload className="mr-2 h-3.5 w-3.5" />
                                Import Character
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div className="w-full max-w-md">
                              <div className="relative">
                                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                                <Input
                                  className="pl-11"
                                  onChange={(event) => setAdminCharacterSearch(event.target.value)}
                                  placeholder="Search characters, prompts, voices, or wakewords"
                                  value={adminCharacterSearch}
                                />
                              </div>
                            </div>
                            <CatalogTabs activeTab={adminCharacterTab} counts={characterCounts} onChange={setAdminCharacterTab} />
                          </div>
                          <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
                            {filteredAdminCharacters.map((character) => {
                              const draft = adminCharacterDrafts[character.id]
                              const title = draft?.name || character.name
                              const description = draft?.description || character.description || "No description yet."
                              const phoneticSpelling = draft?.phonetic_spelling || character.phonetic_spelling || ""
                              return (
                                <div key={character.id} className="flex flex-col gap-4 rounded-[26px] border border-white/8 bg-white/[0.03] px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-start gap-3">
                                      <CatalogLogo label={title} src={draft?.logo} />
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <div className="truncate text-sm font-medium text-zinc-100">{title}</div>
                                          <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300">
                                            {character.builtin ? "Built-in" : character.installed ? (character.enabled ? "Installed" : "Disabled") : "Available"}
                                          </div>
                                          <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">
                                            {character.source}
                                          </div>
                                        </div>
                                        <div className="mt-1 text-xs text-zinc-500">{character.id} · {character.version}</div>
                                        {phoneticSpelling ? (
                                          <div className="mt-1 text-xs text-cyan-300">Pronounced: {phoneticSpelling}</div>
                                        ) : null}
                                        <div className="mt-2 line-clamp-2 text-sm text-zinc-400">{description}</div>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                          {draft?.default_voice ? (
                                            <div className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">Voice: {draft.default_voice}</div>
                                          ) : null}
                                          {draft?.wakeword_model_id ? (
                                            <div className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">Wakeword: {draft.wakeword_model_id}</div>
                                          ) : null}
                                          {!character.installed && character.meta_url ? (
                                            <div className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">Remote metadata</div>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                                    <Button className="h-8 rounded-full px-3 text-xs" onClick={() => openCharacterEditor(character.id)} type="button">
                                      <Sparkles className="mr-2 h-3.5 w-3.5" />
                                      Open Editor
                                    </Button>
                                    {character.installed ? (
                                      <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void publishCharacter(character)} type="button" variant="outline">
                                        <Upload className="mr-2 h-3.5 w-3.5" />
                                        Publish
                                      </Button>
                                    ) : null}
                                    {character.installed ? (
                                      <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void exportCharacter(character)} type="button" variant="outline">
                                        <Download className="mr-2 h-3.5 w-3.5" />
                                        Export
                                      </Button>
                                    ) : null}
                                    <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void installCharacter(character.id)} type="button" variant="outline">
                                      {character.installed ? "Reload" : "Install"}
                                    </Button>
                                    {!character.installed && character.meta_url ? (
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        onClick={() => openExternalUrl(character.meta_url || "")}
                                        type="button"
                                        variant="outline"
                                      >
                                        <FileText className="mr-2 h-3.5 w-3.5" />
                                        Metadata
                                      </Button>
                                    ) : null}
                                    {!character.installed && character.download_url ? (
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        onClick={() => openExternalUrl(character.download_url || "")}
                                        type="button"
                                        variant="outline"
                                      >
                                        <Download className="mr-2 h-3.5 w-3.5" />
                                        Package
                                      </Button>
                                    ) : null}
                                    {!character.builtin && character.installed ? (
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        onClick={() => void toggleCharacterCatalogEntry(character.id, !character.enabled)}
                                        type="button"
                                        variant="outline"
                                      >
                                        {character.enabled ? "Disable" : "Enable"}
                                      </Button>
                                    ) : null}
                                    {!character.builtin && character.installed ? (
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        onClick={() => void deleteCharacter(character.id, title)}
                                        type="button"
                                        variant="outline"
                                      >
                                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                                        Delete
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              )
                            })}
                            {filteredAdminCharacters.length === 0 ? (
                              <div className="rounded-[26px] border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-center text-sm text-zinc-500">
                                No characters match this filter yet.
                              </div>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {activeAdminSection === "voices" ? (
                    <div className="space-y-4">
                      <AdminModal
                        description="Update the label and saved metadata for one custom voice source."
                        onClose={() => {
                          setEditingCustomVoiceId("")
                          setCustomVoiceEditorDraft(null)
                        }}
                        open={Boolean(editingCustomVoiceId && customVoiceEditorDraft)}
                        title="Edit Custom Voice"
                      >
                        {customVoiceEditorDraft ? (
                          <div className="space-y-4">
                            <div className="grid gap-3 md:grid-cols-2">
                              <Input
                                onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, label: event.target.value } : current)}
                                placeholder="Display label"
                                value={customVoiceEditorDraft.label}
                              />
                              <Input
                                onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, gender: event.target.value } : current)}
                                placeholder="Gender or style label"
                                value={customVoiceEditorDraft.gender}
                              />
                            </div>
                            <Textarea
                              className="min-h-[100px]"
                              onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, description: event.target.value } : current)}
                              placeholder="Description"
                              value={customVoiceEditorDraft.description}
                            />
                            <div className="grid gap-3 md:grid-cols-2">
                              <Input
                                onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, language: event.target.value } : current)}
                                placeholder="Language code, for example en_US"
                                value={customVoiceEditorDraft.language}
                              />
                              <Input
                                onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, quality: event.target.value } : current)}
                                placeholder="Quality, for example medium"
                                value={customVoiceEditorDraft.quality}
                              />
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                              <Input
                                onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, model_url: event.target.value } : current)}
                                placeholder="Model .onnx URL"
                                value={customVoiceEditorDraft.model_url}
                              />
                              <Input
                                onChange={(event) => setCustomVoiceEditorDraft((current) => current ? { ...current, config_url: event.target.value } : current)}
                                placeholder="Config .onnx.json URL"
                                value={customVoiceEditorDraft.config_url}
                              />
                            </div>
                            <div className="flex flex-wrap justify-end gap-2 border-t border-white/8 pt-4">
                              <Button
                                className="h-9 rounded-full px-3 text-xs"
                                onClick={() => {
                                  setEditingCustomVoiceId("")
                                  setCustomVoiceEditorDraft(null)
                                }}
                                type="button"
                                variant="outline"
                              >
                                Cancel
                              </Button>
                              <Button className="h-9 rounded-full px-3 text-xs" disabled={isInstallingVoice} onClick={() => void saveCustomVoiceEditor()} type="button">
                                Save Changes
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </AdminModal>
                      <AdminModal
                        description="Install a custom Piper voice from URLs or upload both model and config files directly."
                        onClose={() => {
                          setIsAdminVoiceModalOpen(false)
                          resetCustomVoiceDrafts()
                        }}
                        open={isAdminVoiceModalOpen}
                        title="Add Custom Voice"
                      >
                        <div className="space-y-4">
                          <div className="grid gap-3 md:grid-cols-2">
                            <Input onChange={(event) => setCustomVoiceIdDraft(event.target.value)} placeholder="custom voice id" value={customVoiceIdDraft} />
                            <Input onChange={(event) => setCustomVoiceLabelDraft(event.target.value)} placeholder="Display label" value={customVoiceLabelDraft} />
                          </div>
                          <div className="grid gap-3 md:grid-cols-3">
                            <Input onChange={(event) => setCustomVoiceLanguageDraft(event.target.value)} placeholder="Language code, for example en_US" value={customVoiceLanguageDraft} />
                            <Input onChange={(event) => setCustomVoiceQualityDraft(event.target.value)} placeholder="Quality, for example medium" value={customVoiceQualityDraft} />
                            <Input onChange={(event) => setCustomVoiceGenderDraft(event.target.value)} placeholder="Gender or style label" value={customVoiceGenderDraft} />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <Input onChange={(event) => setCustomVoiceUrlDraft(event.target.value)} placeholder="Model .onnx URL" value={customVoiceUrlDraft} />
                            <Input onChange={(event) => setCustomVoiceConfigUrlDraft(event.target.value)} placeholder="Config .onnx.json URL (optional)" value={customVoiceConfigUrlDraft} />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <Input accept=".onnx" onChange={(event) => void handleCustomVoiceUpload("model", event)} type="file" />
                            <Input accept=".json,.onnx.json" onChange={(event) => void handleCustomVoiceUpload("config", event)} type="file" />
                          </div>
                          {(customVoiceModelSourceNameDraft || customVoiceConfigSourceNameDraft) ? (
                            <div className="text-xs text-zinc-500">
                              {customVoiceModelSourceNameDraft ? `Model upload: ${customVoiceModelSourceNameDraft}` : "Model upload: not set"} · {customVoiceConfigSourceNameDraft ? `Config upload: ${customVoiceConfigSourceNameDraft}` : "Config upload: not set"}
                            </div>
                          ) : null}
                          <Textarea
                            className="min-h-[100px]"
                            onChange={(event) => setCustomVoiceDescriptionDraft(event.target.value)}
                            placeholder="Optional description"
                            value={customVoiceDescriptionDraft}
                          />
                          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-4">
                            <div className="text-sm text-zinc-500">
                              Use separate model and config URLs or upload both files. Blank config URLs still fall back to the derived `.json` path when possible.
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button className="h-9 rounded-full px-3 text-xs" onClick={() => {
                                resetCustomVoiceDrafts()
                                setIsAdminVoiceModalOpen(false)
                              }} type="button" variant="outline">
                                Cancel
                              </Button>
                              <Button className="h-9 rounded-full px-3 text-xs" disabled={isInstallingVoice} onClick={() => void installCustomVoice()} type="button">
                                {isInstallingVoice ? "Working..." : "Add Custom Voice"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </AdminModal>
                      <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                        <CardContent className="flex max-h-[calc(100dvh-13rem)] min-h-[28rem] flex-col gap-4 p-5 sm:p-6">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xl font-semibold">Voices</div>
                              <div className="mt-1 text-xs text-zinc-500">
                                {adminVoiceCatalogStatus ? `${adminVoiceCatalogStatus.voice_count} standard voices cached` : "Loading Piper catalog"} · Synced {voiceCatalogFetchedLabel}
                                {adminVoiceCatalogStatus?.stale ? " · cached fallback" : ""}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="relative w-full min-w-[220px] max-w-[280px] flex-1">
                                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                                <Input
                                  className="pl-11"
                                  onChange={(event) => setAdminVoiceSearch(event.target.value)}
                                  placeholder="Search voices"
                                  value={adminVoiceSearch}
                                />
                              </div>
                              <div className="w-2" />
                              <Button
                                aria-label="Refresh voice catalog"
                                className="h-11 w-11 rounded-full p-0"
                                disabled={isRefreshingVoiceCatalog}
                                onClick={() => void refreshAdminVoiceCatalog()}
                                title="Refresh catalog"
                                type="button"
                                variant="outline"
                              >
                                <LoaderCircle className={`h-4 w-4 ${isRefreshingVoiceCatalog ? "animate-spin" : ""}`} />
                              </Button>
                              <Button
                                aria-label="Add custom voice"
                                className="h-11 w-11 rounded-full p-0"
                                onClick={() => setIsAdminVoiceModalOpen(true)}
                                title="Add custom voice"
                                type="button"
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                              <div className="flex justify-start">
                                <CatalogTabs activeTab={adminVoiceTab} counts={voiceCounts} onChange={setAdminVoiceTab} tabs={["installed", "all"]} />
                              </div>
                              <div className="flex flex-wrap justify-end gap-3">
                                <select
                                    className="flex h-11 w-full min-w-[180px] rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm text-zinc-100 lg:w-auto"
                                  onChange={(event) => setAdminVoiceLanguageFilter(event.target.value)}
                                  value={adminVoiceLanguageFilter}
                                >
                                  <option value="all">All languages</option>
                                  {voiceLanguageOptions.map((language) => (
                                    <option key={`admin-voice-language-${language}`} value={language}>{voiceLanguageOptionLabel(language)}</option>
                                  ))}
                                </select>
                                <select
                                  className="flex h-11 w-full min-w-[132px] rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm text-zinc-100 lg:w-auto"
                                  onChange={(event) => setAdminVoiceQualityFilter(event.target.value)}
                                  value={adminVoiceQualityFilter}
                                >
                                  <option value="all">All qualities</option>
                                  {voiceQualityOptions.map((quality) => (
                                    <option key={`admin-voice-quality-${quality}`} value={quality}>{quality}</option>
                                  ))}
                                </select>
                                <select
                                  className="flex h-11 w-full min-w-[132px] rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm text-zinc-100 lg:w-auto"
                                  onChange={(event) => setAdminVoiceKindFilter(event.target.value)}
                                  value={adminVoiceKindFilter}
                                >
                                  <option value="all">All types</option>
                                  <option value="recommended">Recommended</option>
                                  <option value="standard">Standard</option>
                                  <option value="custom">Custom</option>
                                </select>
                                {adminVoiceFiltersActive ? (
                                  <Button
                                    aria-label="Reset voice filters"
                                    className="h-11 w-11 rounded-full p-0"
                                    onClick={resetAdminVoiceFilters}
                                    title="Reset filters"
                                    type="button"
                                    variant="outline"
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                ) : null}
                                <div className="relative">
                                  <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                                  <select
                                    className="flex h-11 w-full min-w-[138px] rounded-2xl border border-white/10 bg-zinc-950 pl-10 pr-4 text-sm text-zinc-100 lg:w-auto"
                                    onChange={(event) => setAdminVoiceSort(event.target.value)}
                                    title="Sort voices"
                                    value={adminVoiceSort}
                                  >
                                    <option value="recommended">Recommended</option>
                                    <option value="name">Name</option>
                                    <option value="language">Language</option>
                                    <option value="quality">Quality</option>
                                    <option value="installed">Installed First</option>
                                  </select>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
                            {filteredAdminVoices.map((voice) => {
                              const voiceCanReinstall = !voice.custom || Boolean(voice.source_url.trim() || voice.config_url.trim())
                              const voiceCanPreview = voice.installed || !voice.custom || voiceCanReinstall
                              const usageLabel = `${voice.characters.length} character${voice.characters.length === 1 ? "" : "s"}`
                              return (
                                <div key={voice.id} className="flex flex-col gap-4 rounded-[26px] border border-white/8 bg-white/[0.03] px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-start gap-3">
                                      <CatalogLogo label={voice.label} />
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <div className="truncate text-sm font-medium text-zinc-100">{voice.label}</div>
                                          <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300">
                                            {regionFlag(voice.language)} {voiceLocaleLabel(voice.language)}
                                          </div>
                                          <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">
                                            {formatVoiceQuality(voice.quality)}
                                          </div>
                                          {voice.gender ? (
                                            <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">
                                              {voice.gender}
                                            </div>
                                          ) : null}
                                          <div className={`rounded-full border px-2.5 py-1 text-[11px] ${voice.custom ? "border-sky-400/30 bg-sky-400/10 text-sky-100" : "border-white/8 bg-white/[0.04] text-zinc-400"}`}>
                                            {voice.custom ? "Custom Voice" : voice.curated ? "Recommended Piper" : "Standard Piper"}
                                          </div>
                                          {voice.characters.length > 0 ? (
                                            <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">
                                              {usageLabel}
                                            </div>
                                          ) : null}
                                          <div className={`rounded-full border px-2.5 py-1 text-[11px] ${voice.installed ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-amber-400/30 bg-amber-400/10 text-amber-100"}`}>
                                            {voice.installed ? "Installed" : "Not Installed"}
                                          </div>
                                        </div>
                                        <div className="mt-2 line-clamp-2 text-sm text-zinc-400">{voice.description || "No description yet."}</div>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                          {voice.characters.map((character) => (
                                            <div key={`${voice.id}-${character.character_id}`} className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">
                                              {character.character_name}
                                            </div>
                                          ))}
                                        </div>
                                        {voice.characters.length === 0 ? (
                                          <div className="mt-3 text-xs text-zinc-500">Not assigned to any character yet.</div>
                                        ) : null}
                                        {expandedAdminVoiceDetails[voice.id] ? (
                                          <div className="mt-3 grid gap-1 text-xs text-zinc-500">
                                            <div>Voice id: {voice.id}</div>
                                            <div>Model: {voice.model_path || "Not installed locally"}</div>
                                            <div>Config: {voice.config_path || "Not installed locally"}</div>
                                            {voice.source_url ? <div className="break-all">Model source: {voice.source_url}</div> : null}
                                            {voice.config_url ? <div className="break-all">Config source: {voice.config_url}</div> : null}
                                            {voice.model_source_name ? <div>Uploaded model: {voice.model_source_name}</div> : null}
                                            {voice.config_source_name ? <div>Uploaded config: {voice.config_source_name}</div> : null}
                                            {voice.custom && !voiceCanReinstall ? <div>Local upload only. Reinstall requires re-uploading the files.</div> : null}
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex h-full flex-col items-end justify-between gap-2">
                                    <div className="flex flex-wrap items-center justify-end gap-2">
                                      {voice.custom ? (
                                        <Button className="h-8 rounded-full px-3 text-xs" onClick={() => beginEditingCustomVoice(voice)} type="button" variant="outline">
                                          <Pencil className="mr-2 h-3.5 w-3.5" />
                                          Edit
                                        </Button>
                                      ) : null}
                                      <Button
                                        className="h-8 rounded-full px-3 text-xs"
                                        disabled={!voiceCanPreview || previewingAdminVoiceId === voice.id}
                                        onClick={() => void previewAdminVoice(voice.id, voice.label)}
                                        type="button"
                                        variant="outline"
                                      >
                                        {previewingAdminVoiceId === voice.id ? "Previewing..." : "Preview"}
                                      </Button>
                                      {!voice.installed ? (
                                        <Button
                                          className="h-8 rounded-full px-3 text-xs"
                                          disabled={isInstallingVoice || (voice.custom && !voiceCanReinstall)}
                                          onClick={() => void (voice.custom ? reinstallAdminVoice(voice.id) : installPiperVoiceById(voice.id))}
                                          type="button"
                                          variant="outline"
                                        >
                                          Install
                                        </Button>
                                      ) : null}
                                      {voice.installed && voiceCanReinstall ? (
                                        <Button
                                          className="h-8 rounded-full px-3 text-xs"
                                          disabled={isInstallingVoice}
                                          onClick={() => void reinstallAdminVoice(voice.id)}
                                          type="button"
                                          variant="outline"
                                        >
                                          Reinstall
                                        </Button>
                                      ) : null}
                                      {voice.installed && voice.custom && !voiceCanReinstall ? (
                                        <div className="rounded-full border border-white/8 px-3 py-1 text-xs text-zinc-500">Local Only</div>
                                      ) : null}
                                      {voice.custom ? (
                                        <Button
                                          className="h-8 rounded-full px-3 text-xs text-rose-200"
                                          disabled={isInstallingVoice || voice.characters.length > 0}
                                          onClick={() => void removeAdminVoice(voice.id)}
                                          type="button"
                                          variant="outline"
                                        >
                                          Remove
                                        </Button>
                                      ) : null}
                                    </div>
                                    <Button
                                      aria-label={expandedAdminVoiceDetails[voice.id] ? "Hide technical details" : "Show technical details"}
                                      className="h-8 w-8 rounded-full p-0"
                                      onClick={() => toggleAdminVoiceDetails(voice.id)}
                                      title={expandedAdminVoiceDetails[voice.id] ? "Hide technical details" : "Show technical details"}
                                      type="button"
                                      variant="outline"
                                    >
                                      <FileText className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              )
                            })}
                            {filteredAdminVoices.length === 0 ? (
                              <div className="rounded-[26px] border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-center text-sm text-zinc-500">
                                No voices match this filter yet.
                              </div>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {activeAdminSection === "skills" ? (
                    <div className="space-y-4">
                      <AdminModal
                        description="Install a skill from the local repository index."
                        onClose={() => setIsAdminSkillModalOpen(false)}
                        open={isAdminSkillModalOpen}
                        title="Add Skill"
                      >
                        <div className="space-y-3">
                          {availableSkills.filter((skill) => !skill.installed).map((skill) => (
                            <div key={`skill-modal-${skill.id}`} className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3">
                                  <CatalogLogo label={skill.title} src={skill.logo_url} />
                                  <div>
                                    <div className="text-sm font-medium text-zinc-100">{skill.title}</div>
                                    <div className="mt-1 text-xs text-zinc-500">{skill.latest_version} · {skill.domains.join(", ")} · {skill.account_mode}</div>
                                    <div className="mt-2 text-sm text-zinc-400">{skill.description}</div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {skill.platforms.map((platform) => (
                                        <div key={`${skill.id}-modal-${platform}`} className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">{platform}</div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button className="h-8 rounded-full px-3 text-xs" disabled={isSkillMutationPending} onClick={() => void installSkill(skill.id)} type="button" variant="outline">
                                    Install
                                  </Button>
                                </div>
                              </div>
                            </div>
                          ))}
                          {availableSkills.filter((skill) => !skill.installed).length === 0 ? (
                            <div className="rounded-[22px] border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-center text-sm text-zinc-500">
                              No repository skills are waiting to be installed.
                            </div>
                          ) : null}
                        </div>
                      </AdminModal>
                    <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
                      <CardContent className="flex max-h-[calc(100dvh-13rem)] min-h-[28rem] flex-col gap-4 p-5 sm:p-6">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xl font-semibold">Skills</div>
                            <div className="mt-1 text-xs text-zinc-500">
                              {installedSkills.length} installed · {availableSkills.length} in repository · Read-only connection tests available when supported
                            </div>
                            {skillCatalogRepository ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                                <span>{skillCatalogRepository.description}</span>
                                {skillCatalogRepository.repo_url ? (
                                  <Button
                                    className="h-7 rounded-full px-3 text-[11px]"
                                    onClick={() => openExternalUrl(skillCatalogRepository.repo_url)}
                                    type="button"
                                    variant="outline"
                                  >
                                    Open Repo
                                  </Button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="relative w-full min-w-[220px] max-w-[280px] flex-1">
                              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                              <Input className="pl-11" onChange={(event) => setAdminSkillSearch(event.target.value)} placeholder="Search skills" value={adminSkillSearch} />
                            </div>
                            <div className="w-2" />
                            <Button
                              aria-label="Update all skills"
                              className="h-11 w-11 rounded-full p-0"
                              disabled={isRefreshingSkills}
                              onClick={() => void updateAllSkills()}
                              title="Update all skills"
                              type="button"
                              variant="outline"
                            >
                              <ArrowUpCircle className={`h-4 w-4 ${isRefreshingSkills ? "animate-spin" : ""}`} />
                            </Button>
                            <div className="w-2" />
                            <Button
                              aria-label="Refresh skills"
                              className="h-11 w-11 rounded-full p-0"
                              disabled={isRefreshingSkills}
                              onClick={() => void refreshAdminSkills()}
                              title="Refresh skills"
                              type="button"
                              variant="outline"
                            >
                              <LoaderCircle className={`h-4 w-4 ${isRefreshingSkills ? "animate-spin" : ""}`} />
                            </Button>
                            <Button
                              aria-label="Add skill"
                              className="h-11 w-11 rounded-full p-0"
                              onClick={() => setIsAdminSkillModalOpen(true)}
                              title="Add skill"
                              type="button"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button className="h-9 rounded-full px-3 text-xs" onClick={() => setAdminSkillTab(adminSkillTab === "test" ? "catalog" : "test")} type="button" variant={adminSkillTab === "test" ? "default" : "outline"}>
                              {adminSkillTab === "test" ? "Back To Catalog" : "Test Skill"}
                            </Button>
                          </div>
                        </div>
                        {adminSkillTab === "catalog" ? (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                              <div className="flex justify-start">
                                <CatalogTabs activeTab={adminSkillCatalogTab} counts={skillCounts} onChange={setAdminSkillCatalogTab} tabs={["installed", "all"]} />
                              </div>
                              <div className="flex flex-wrap justify-end gap-3">
                                <select
                                  className="flex h-11 w-full min-w-[180px] rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm text-zinc-100 lg:w-auto"
                                  onChange={(event) => setAdminSkillDomainFilter(event.target.value)}
                                  value={adminSkillDomainFilter}
                                >
                                  <option value="all">All domains</option>
                                  {skillDomainOptions.map((domain) => (
                                    <option key={`skill-domain-${domain}`} value={domain}>{domain}</option>
                                  ))}
                                </select>
                                <select
                                  className="flex h-11 w-full min-w-[132px] rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm text-zinc-100 lg:w-auto"
                                  onChange={(event) => setAdminSkillHealthFilter(event.target.value)}
                                  value={adminSkillHealthFilter}
                                >
                                  <option value="all">All health</option>
                                  <option value="ok">Healthy</option>
                                  <option value="unknown">Not tested</option>
                                  <option value="error">Needs attention</option>
                                </select>
                                <select
                                  className="flex h-11 w-full min-w-[132px] rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm text-zinc-100 lg:w-auto"
                                  onChange={(event) => setAdminSkillKindFilter(event.target.value)}
                                  value={adminSkillKindFilter}
                                >
                                  <option value="all">All types</option>
                                  <option value="integration">Integrations</option>
                                  <option value="system">System</option>
                                  <option value="accounted">Has accounts</option>
                                </select>
                                {adminSkillFiltersActive ? (
                                  <Button
                                    aria-label="Reset skill filters"
                                    className="h-11 w-11 rounded-full p-0"
                                    onClick={resetAdminSkillFilters}
                                    title="Reset filters"
                                    type="button"
                                    variant="outline"
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                ) : null}
                                <div className="relative">
                                  <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                                  <select
                                    className="flex h-11 w-full min-w-[138px] rounded-2xl border border-white/10 bg-zinc-950 pl-10 pr-4 text-sm text-zinc-100 lg:w-auto"
                                    onChange={(event) => setAdminSkillSort(event.target.value)}
                                    title="Sort skills"
                                    value={adminSkillSort}
                                  >
                                    <option value="recommended">Recommended</option>
                                    <option value="name">Name</option>
                                    <option value="domain">Domain</option>
                                    <option value="health">Health</option>
                                    <option value="installed">Installed First</option>
                                  </select>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : null}
                        {adminSkillTab === "catalog" ? (
                          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
                          {filteredInstalledSkills.map((skill) => (
                            <div key={`${skill.skill_id}-context`} className="flex flex-col gap-4 rounded-[26px] border border-white/8 bg-white/[0.03] px-4 py-4">
                              <div className="mb-4 flex items-start justify-between gap-4">
                                <div className="min-w-0 flex flex-1 items-start gap-3">
                                  <CatalogLogo label={skill.title} src={skill.logo} />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="text-sm font-medium text-zinc-100">{skill.title}</div>
                                      <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">{skill.version}</div>
                                      <div className={`rounded-full border px-2.5 py-1 text-[11px] ${skillHealthTone(skill.health_status)}`}>{skillHealthLabel(skill.health_status)}</div>
                                      <div className={`rounded-full border px-2.5 py-1 text-[11px] ${skill.enabled ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"}`}>
                                        {skill.enabled ? "Enabled" : "Disabled"}
                                      </div>
                                    </div>
                                    <div className="mt-2 text-sm text-zinc-400">{skill.description}</div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <div className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">Load: {skill.load_type}</div>
                                      <div className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">Accounts: {skill.accounts.length}</div>
                                    </div>
                                    <div className="mt-3 text-xs text-zinc-500">{skill.health_detail || "No health detail yet."}</div>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  {skill.shared_context_fields.length > 0 || skill.account_context_fields.length > 0 ? (
                                    <Button
                                      className="h-8 rounded-full px-3 text-xs"
                                      disabled={expandedSkillDetails[skill.skill_id] ? isSkillMutationPending || savingSkillId === skill.skill_id : false}
                                      onClick={() => void (expandedSkillDetails[skill.skill_id] ? saveSkillDetails(skill) : toggleSkillDetails(skill.skill_id))}
                                      type="button"
                                      variant="outline"
                                    >
                                      {expandedSkillDetails[skill.skill_id] ? (savingSkillId === skill.skill_id ? "Saving..." : "Save") : "Edit"}
                                    </Button>
                                  ) : null}
                                  <Button className="h-8 rounded-full px-3 text-xs" disabled={Boolean(testingSkillAccountId)} onClick={() => void testSkill(skill)} type="button" variant="outline">
                                    Test
                                  </Button>
                                  {!skill.system ? (
                                    <Button className="h-8 rounded-full px-3 text-xs" disabled={isSkillMutationPending} onClick={() => void toggleSkillEnabled(skill.skill_id, !skill.enabled)} type="button" variant="outline">
                                      {skill.enabled ? "Disable" : "Enable"}
                                    </Button>
                                  ) : (
                                    <div className="rounded-full border border-white/8 px-3 py-1 text-xs text-zinc-400">System</div>
                                  )}
                                  {!skill.system ? (
                                    <Button className="h-8 rounded-full px-3 text-xs text-rose-200" disabled={isSkillMutationPending} onClick={() => void uninstallSkill(skill.skill_id)} type="button" variant="outline">
                                      Uninstall
                                    </Button>
                                  ) : null}
                                  {availableSkills.find((s) => s.id === skill.skill_id && s.latest_version !== skill.version) ? (
                                    <Button
                                      className="h-8 rounded-full border-blue-400/30 bg-blue-400/10 px-3 text-xs text-blue-200 hover:bg-blue-400/20"
                                      disabled={isRefreshingSkills}
                                      onClick={() => void updateSkill(skill.skill_id)}
                                      type="button"
                                      variant="outline"
                                    >
                                      Update
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                              {expandedSkillDetails[skill.skill_id] && skill.shared_context_fields.length > 0 ? (
                                <div className="space-y-3 rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
                                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Shared Context</div>
                                  {skill.shared_context_fields.map((field) => (
                                    <div key={`${skill.skill_id}-${field.key}`} className="space-y-2">
                                      <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">{field.label}</div>
                                      {field.type === "textarea" ? (
                                        <Textarea onChange={(event) => updateSkillContextDraft(skill.skill_id, field.key, event.target.value)} placeholder={field.placeholder} rows={3} value={String((skillContextDrafts[skill.skill_id] || {})[field.key] ?? "")} />
                                      ) : field.type === "select" ? (
                                        <Select onChange={(event) => updateSkillContextDraft(skill.skill_id, field.key, event.target.value)} value={String((skillContextDrafts[skill.skill_id] || {})[field.key] ?? "")}>
                                          <option value="">Select…</option>
                                          {field.options.map((option) => (
                                            <option key={`${field.key}-${option.value}`} value={option.value}>
                                              {option.label}
                                            </option>
                                          ))}
                                        </Select>
                                      ) : (
                                        <Input onChange={(event) => updateSkillContextDraft(skill.skill_id, field.key, event.target.value)} placeholder={field.placeholder} type={field.type === "number" ? "number" : "text"} value={String((skillContextDrafts[skill.skill_id] || {})[field.key] ?? "")} />
                                      )}
                                      {field.help_text ? <div className="text-sm text-zinc-500">{field.help_text}</div> : null}
                                    </div>
                                  ))}
                                  <div className="flex flex-wrap items-center gap-3">
                                    <Button className="h-9 rounded-full px-3 text-xs" disabled={savingSkillId === skill.skill_id} onClick={() => void persistSkillContext(skill.skill_id).catch(() => undefined)} type="button" variant="outline">
                                      {savingSkillId === skill.skill_id ? "Saving..." : `Save ${skill.title} context`}
                                    </Button>
                                    {skillContextStatusBySkill[skill.skill_id] ? <div className="text-sm text-zinc-500">{skillContextStatusBySkill[skill.skill_id]}</div> : null}
                                  </div>
                                </div>
                              ) : null}
                              {expandedSkillDetails[skill.skill_id] && skill.account_context_fields.length > 0 ? (
                                <div className="mt-6 space-y-4 border-t border-white/8 pt-4">
                                  <div>
                                    <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Accounts</div>
                                    <div className="mt-1 text-sm text-zinc-500">Configure one or more instances for this skill. If only one exists, requests do not need a site name.</div>
                                  </div>
                                  {skill.accounts.map((account) => (
                                    <div key={`${skill.skill_id}-${account.id}`} className="space-y-3 rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
                                      <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                          <div className="flex flex-wrap items-center gap-2">
                                            <div className="text-sm font-medium text-zinc-100">{account.label}</div>
                                            <div className={`rounded-full border px-2.5 py-1 text-[11px] ${skillHealthTone(account.health_status)}`}>{skillHealthLabel(account.health_status)}</div>
                                            {account.is_default ? (
                                              <div className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-100">Default</div>
                                            ) : null}
                                          </div>
                                          <div className="mt-1 text-xs text-zinc-500">{account.health_detail || (account.is_default ? "Default account" : "Secondary account")}</div>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <Button className="h-8 rounded-full px-3 text-xs" disabled={testingSkillAccountId === account.id} onClick={() => void testSkillAccountConnection(skill, account)} type="button" variant="outline">
                                            {testingSkillAccountId === account.id ? "Testing..." : "Test connection"}
                                          </Button>
                                          {!account.is_default ? (
                                            <Button className="h-8 rounded-full px-3 text-xs" disabled={isSkillMutationPending} onClick={() => void makeSkillAccountDefault(skill, account)} type="button" variant="outline">
                                              Make default
                                            </Button>
                                          ) : null}
                                          <Button className="h-8 rounded-full px-3 text-xs" disabled={isSkillMutationPending} onClick={() => void persistSkillAccountContext(skill, account)} type="button" variant="outline">
                                            Save account
                                          </Button>
                                        </div>
                                      </div>
                                      {skill.account_context_fields.map((field) => (
                                        <div key={`${account.id}-${field.key}`} className="space-y-2">
                                          <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">{field.label}</div>
                                          {field.type === "textarea" ? (
                                            <Textarea onChange={(event) => updateSkillAccountContextDraft(skill.skill_id, account.id, field.key, event.target.value)} placeholder={field.placeholder} rows={3} value={String(((skillAccountContextDrafts[skill.skill_id] || {})[account.id] || {})[field.key] ?? "")} />
                                          ) : field.type === "select" ? (
                                            <Select onChange={(event) => updateSkillAccountContextDraft(skill.skill_id, account.id, field.key, event.target.value)} value={String(((skillAccountContextDrafts[skill.skill_id] || {})[account.id] || {})[field.key] ?? "")}>
                                              <option value="">Select…</option>
                                              {field.options.map((option) => (
                                                <option key={`${account.id}-${field.key}-${option.value}`} value={option.value}>
                                                  {option.label}
                                                </option>
                                              ))}
                                            </Select>
                                          ) : (
                                            <Input onChange={(event) => updateSkillAccountContextDraft(skill.skill_id, account.id, field.key, event.target.value)} placeholder={field.placeholder} type={field.type === "number" ? "number" : "text"} value={String(((skillAccountContextDrafts[skill.skill_id] || {})[account.id] || {})[field.key] ?? "")} />
                                          )}
                                          {field.help_text ? <div className="text-sm text-zinc-500">{field.help_text}</div> : null}
                                        </div>
                                      ))}
                                    </div>
                                  ))}
                                  <div className="space-y-3 border border-dashed border-white/10 bg-black/10 px-4 py-4">
                                    <div className="text-sm font-medium text-zinc-100">Add account</div>
                                    <Input onChange={(event) => updateSkillNewAccountLabel(skill.skill_id, event.target.value)} placeholder="home, work, office" value={skillNewAccountLabels[skill.skill_id] || ""} />
                                    <label className="flex items-center gap-2 text-sm text-zinc-400">
                                      <input checked={Boolean(skillNewAccountDefaults[skill.skill_id])} onChange={(event) => updateSkillNewAccountDefault(skill.skill_id, event.target.checked)} type="checkbox" />
                                      Set as default account
                                    </label>
                                    {skill.account_context_fields.map((field) => (
                                      <div key={`${skill.skill_id}-new-${field.key}`} className="space-y-2">
                                        <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">{field.label}</div>
                                        {field.type === "textarea" ? (
                                          <Textarea onChange={(event) => updateSkillAccountContextDraft(skill.skill_id, "__new__", field.key, event.target.value)} placeholder={field.placeholder} rows={3} value={String((((skillAccountContextDrafts[skill.skill_id] || {}).__new__ || {})[field.key]) ?? "")} />
                                        ) : field.type === "select" ? (
                                          <Select onChange={(event) => updateSkillAccountContextDraft(skill.skill_id, "__new__", field.key, event.target.value)} value={String((((skillAccountContextDrafts[skill.skill_id] || {}).__new__ || {})[field.key]) ?? "")}>
                                            <option value="">Select…</option>
                                            {field.options.map((option) => (
                                              <option key={`${skill.skill_id}-new-${field.key}-${option.value}`} value={option.value}>
                                                {option.label}
                                              </option>
                                            ))}
                                          </Select>
                                        ) : (
                                          <Input onChange={(event) => updateSkillAccountContextDraft(skill.skill_id, "__new__", field.key, event.target.value)} placeholder={field.placeholder} type={field.type === "number" ? "number" : "text"} value={String((((skillAccountContextDrafts[skill.skill_id] || {}).__new__ || {})[field.key]) ?? "")} />
                                        )}
                                        {field.help_text ? <div className="text-sm text-zinc-500">{field.help_text}</div> : null}
                                      </div>
                                    ))}
                                    <div>
                                      <Button className="h-9 rounded-full px-3 text-xs" disabled={isSkillMutationPending} onClick={() => void createSkillAccount(skill)} type="button" variant="outline">
                                        Add account
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ))}
                          {adminSkillCatalogTab === "all" ? filteredAvailableSkills.map((skill) => (
                            <div key={`${skill.id}-available`} className="flex flex-col gap-4 rounded-[26px] border border-white/8 bg-white/[0.03] px-4 py-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex flex-1 items-start gap-3">
                                  <CatalogLogo label={skill.title} src={skill.logo_url} />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="text-sm font-medium text-zinc-100">{skill.title}</div>
                                      <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300">{skill.id}</div>
                                      <div className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">{skill.latest_version}</div>
                                      <div className={`rounded-full border px-2.5 py-1 text-[11px] ${skillHealthTone("unknown")}`}>Available</div>
                                    </div>
                                    <div className="mt-2 text-sm text-zinc-400">{skill.description}</div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {skill.domains.map((domain) => (
                                        <div key={`${skill.id}-${domain}`} className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">{domain}</div>
                                      ))}
                                      {skill.platforms.map((platform) => (
                                        <div key={`${skill.id}-${platform}`} className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">{platform}</div>
                                      ))}
                                      <div className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-xs text-zinc-300">
                                        Account mode: {skill.account_mode}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button className="h-8 rounded-full px-3 text-xs" disabled={isSkillMutationPending || skill.installed} onClick={() => void installSkill(skill.id)} type="button" variant="outline">
                                    Install
                                  </Button>
                                </div>
                              </div>
                            </div>
                          )) : null}
                          {filteredInstalledSkills.length === 0 && filteredAvailableSkills.length === 0 ? (
                            <div className="rounded-[26px] border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-center text-sm text-zinc-500">
                              No skills match this filter yet.
                            </div>
                          ) : null}
                          </div>
                        ) : (
                          <div className="space-y-4">
                            <div>
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Skill Test Bench</div>
                              <div className="text-sm text-zinc-500">Run one message through the deterministic skill router and see the route, response, timing, and context used.</div>
                            </div>
                            <Textarea onChange={(event) => setSkillProbe(event.target.value)} rows={4} value={skillProbe} />
                            <div className="flex flex-wrap items-center gap-2">
                              <Button className="h-9 rounded-full px-3 text-xs" disabled={isSkillInspectPending || !skillProbe.trim()} onClick={() => void inspectSkillRoute()} type="button" variant="outline">
                                {isSkillInspectPending ? "Inspecting..." : "Inspect route"}
                              </Button>
                              <Button className="h-9 rounded-full px-3 text-xs" disabled={isSkillTestPending || !skillProbe.trim()} onClick={() => void testSkillRoute()} type="button" variant="outline">
                                {isSkillTestPending ? "Running..." : "Run skill test"}
                              </Button>
                            </div>
                            {skillTestError ? (
                              <div className="border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                                {skillTestError}
                              </div>
                            ) : null}
                            {skillRouteDecision ? (
                              <div className="border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-zinc-300">
                                <div className="font-medium text-zinc-100">Route</div>
                                <div className="mt-2 text-zinc-300">{skillRouteDecision.outcome}</div>
                                <div className="mt-1 text-zinc-400">{skillRouteDecision.reason}</div>
                                {skillRouteDecision.candidate ? <div className="mt-2 text-zinc-500">{skillRouteDecision.candidate.skill_id}.{skillRouteDecision.candidate.action}</div> : null}
                              </div>
                            ) : null}
                            {skillTestResult ? (
                              <div className="space-y-3">
                                <div className="border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-zinc-300">
                                  <div className="font-medium text-zinc-100">Execution</div>
                                  <div className="mt-2 text-zinc-400">Time to return: {skillTestResult.timing_ms.toFixed(2)} ms</div>
                                  <div className="mt-1 text-zinc-400">Profile: {skillTestResult.context.profile}</div>
                                </div>
                                <div className="border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-zinc-300">
                                  <div className="font-medium text-zinc-100">Context Used</div>
                                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-400">{JSON.stringify({
                                    shared_contexts: skillTestResult.context.shared_contexts,
                                    accounts: skillTestResult.context.accounts,
                                  }, null, 2)}</pre>
                                </div>
                                <div className="border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-zinc-300">
                                  <div className="font-medium text-zinc-100">Response</div>
                                  <div className="mt-2 whitespace-pre-wrap text-zinc-300">{skillTestResult.message?.content || "No skill execution response."}</div>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    </div>
                  ) : null}
                </div>
                </div>
                </div>
            </div>
          ) : null}
        </main>
      </div>

      {/* Global Cinematic Fullscreen Stage (Independent High-Z Layer) */}
      {isCharacterVisible && selectedCharacter && characterDisplayMode === "fullscreen" && (
        <div className="fixed inset-0 z-[150] flex h-dvh w-dvw flex-col overflow-hidden bg-black animate-in fade-in duration-500">
          <div className="pointer-events-auto absolute right-6 top-6 z-[160] flex items-center gap-2">
            <div className="group flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-xl shadow-strong transition-all duration-500 hover:gap-2">
              <div className="flex items-center gap-1.5 overflow-hidden transition-all duration-300 w-0 opacity-0 group-hover:w-auto group-hover:opacity-100">
                <Button
                  className={cn("h-9 w-9 rounded-full transition-all bg-[var(--accent)] text-black font-bold")}
                  onClick={() => setCharacterDisplayMode("full")}
                  size="icon" tooltip="Body Mode" variant="ghost"
                >
                  <User className="h-5 w-5" />
                </Button>
                <Button
                  className={cn("h-9 w-9 rounded-full transition-all text-white/60 hover:bg-white/10 hover:text-white")}
                  onClick={() => setCharacterDisplayMode("head")}
                  size="icon" tooltip="Head Mode" variant="ghost"
                >
                  <Scan className="h-5 w-5" />
                </Button>
                <Button
                  className="h-9 w-9 rounded-full text-white/50 hover:bg-rose-500/20 hover:text-rose-400 transition-all font-bold"
                  onClick={() => { setIsCharacterVisible(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }}
                  size="icon" tooltip="Exit Stage" variant="ghost"
                >
                  <X className="h-5 w-5" />
                </Button>
                <div className="mx-1 h-4 w-px bg-white/20" />
              </div>
              <Button
                className="h-9 w-9 rounded-full bg-[var(--accent)] text-black font-bold shadow-strong transition-all"
                onClick={() => setCharacterDisplayMode("head")}
                size="icon" tooltip="Exit Fullscreen" variant="ghost"
              >
                <Minimize2 className="h-5 w-5" />
              </Button>
              <div className="h-4 w-px bg-white/20" />
              <Button
                className={cn("h-9 w-9 rounded-full transition-all", voiceReplyEnabled ? "text-[var(--accent)]" : "text-white/60 hover:bg-white/10 hover:text-white")}
                onClick={() => setVoiceReplyEnabled((prev) => !prev)}
                size="icon" tooltip={voiceReplyEnabled ? "Mute" : "Unmute"} variant="ghost"
              >
                {voiceReplyEnabled ? <Ear className="h-5 w-5" /> : <EarOff className="h-5 w-5" />}
              </Button>
              <Button
                className={cn("h-9 w-9 rounded-full transition-all", subtitlesEnabled ? "bg-[var(--accent)] text-black font-bold" : "text-white/60 hover:bg-white/10 hover:text-white")}
                onClick={() => setSubtitlesEnabled((prev) => !prev)}
                size="icon" tooltip="Subtitles" variant="ghost"
              >
                <MessageSquare className="h-5 w-5" />
              </Button>
            </div>
          </div>

          <div className="flex h-full w-full flex-1 flex-col overflow-hidden items-center justify-center">
            <CharacterContext.Provider value={characterContextValue}>
              <VoiceContext.Provider value={voiceContextValue}>
                <AudioContext.Provider value={audioContextValue}>
                  <AnimatedCharacter stageScale={2.5} viewPreset="full" />
                </AudioContext.Provider>
              </VoiceContext.Provider>
            </CharacterContext.Provider>
          </div>

          {subtitlesEnabled && (
            <div className="pointer-events-none absolute inset-0 z-[155] flex flex-col items-center justify-end px-12 pb-16">
              <div className="relative flex w-full max-w-4xl flex-col items-center">
                <div className="absolute -bottom-12 left-1/2 h-32 w-64 -translate-x-1/2 rounded-full bg-[var(--accent)]/30 blur-[60px]" />
                <div className="w-full rounded-[40px] border border-white/10 bg-black/40 px-12 py-10 text-center backdrop-blur-2xl shadow-strong">
                  {messages.slice(-1).map((msg, idx) => {
                    const msgKey = speechMessageKey(msg, Math.max(0, messages.length - 1))
                    return (
                      <div key={idx} className="flex flex-col items-center gap-2">
                        <span className="mb-2 text-[10px] font-black uppercase tracking-[0.4em] text-white/40">{msg.role === "user" ? "You" : selectedCharacter?.name}</span>
                        <div className="flex flex-wrap justify-center text-2xl font-medium tracking-tight text-white/90 lg:text-3xl">
                          {msg.content.split(" ").map((word, wIdx) => (
                            <span key={wIdx} className={cn("mr-2 transition-all duration-300", msgKey === speakingMessageKey && wIdx === speakingWordIndex ? "scale-105 font-black text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]" : "opacity-60")}>
                              {word}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
