/**
 * Shared API type declarations.
 *
 * Kept in their own file so `api.ts` (which holds the SSE parser and
 * the actual fetch wrappers) stays under the 250-line CLAUDE.md ceiling.
 * Importing types from a sibling module also makes it cheap to mock the
 * fetch layer in tests without dragging the type surface along.
 */

export interface PipelineEvent {
  phase: string;
  status: string;
  // Loose by design: callers `as`-cast into the per-phase shapes below.
  // The phase enum is too small to bother with discriminated unions
  // when the components already do the narrowing themselves.
  data: any;
}

export interface AskInfo {
  ask_id: string;
  intent: string;
  distilled_query: string;
}

export interface SentimentInfo {
  sentiment?: string;
  concern?: string;
}

export interface AugmentationData {
  latency_ms: number;
  context_messages: number;
  relevant_facts: number;
  past_messages: number;
}

export interface MicroFastLaneData {
  hit: boolean;
  near_miss?: boolean;
  category: string;
  similarity: number;
  template: string;
  latency_ms: number;
}

export interface DecompositionData {
  model: string;
  latency_ms: number;
  is_course_correction: boolean;
  reasoning_complexity: "fast" | "thinking" | string;
  asks: AskInfo[];
  sentiment?: SentimentInfo;
}

export interface RoutingLogEntry {
  ask_id: string;
  intent: string;
  status: "success" | "failed" | "no_skill" | "disabled" | string;
  skill_id?: string | null;
  mechanism: string | null;
  latency_ms: number;
  source_url?: string | null;
  mechanism_log?: Array<Record<string, unknown>>;
  disabled_reason?: string | null;
  missing_config?: string[];
}

export interface RoutingData {
  skills_resolved: number;
  skills_failed: number;
  routing_log: RoutingLogEntry[];
  latency_ms: number;
}

export interface SourceInfo {
  url: string;
  title: string;
}

export interface SynthesisData {
  response: string;
  model: string;
  latency_ms: number;
  tone: string;
  sources?: SourceInfo[];
  platform: string;
  /** Optional short summary for TTS — overrides `response` for audio
   * playback when present. Used when the on-screen response is rich
   * (e.g. a wall of showtimes) and reading every line is annoying. */
  spoken_text?: string;
  /** DB id of the stored assistant message — used by feedback buttons. */
  assistant_message_id?: number;
}

/**
 * PR1: facts have a richer shape than before. The legacy ``fact`` field
 * is preserved for compatibility with the existing MemoryPage UI, which
 * we are NOT redesigning in this PR.
 */
export interface Fact {
  id?: number;
  fact: string;            // alias of `value` for the legacy UI
  value?: string;
  subject?: string;
  /** 'self' (the user) | 'person' (FK people) | 'entity' (named thing) */
  subject_type?: "self" | "person" | "entity" | string;
  subject_ref_id?: number | null;
  predicate?: string;
  /** Memory taxonomy: fact | preference | event | advice | relationship */
  kind?: "fact" | "preference" | "event" | "advice" | "relationship" | string;
  category: string;
  confidence?: number;
  effective_confidence?: number;
  observation_count?: number;
  last_observed_at?: string;
  status?: "active" | "ambiguous" | "pending" | "rejected" | "superseded" | string;
  ambiguity_group_id?: number | null;
  source_message_id?: number | null;
  /** When this claim became true (defaults to insert time). */
  valid_from?: string;
  /** When this claim was superseded; null = currently true. */
  valid_to?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AmbiguityGroup {
  id: number;
  raw_name: string;
  candidate_person_ids: number[];
  created_at?: string;
}

export interface SilentConfirmation {
  fact_id: number;
  subject: string;
  predicate: string;
  value: string;
  status: string;
  person_id?: number | null;
  ambiguity_group_id?: number | null;
  contradiction_action?: string;
  previous_value?: string | null;
}

/** PR3 people / relationships / conflicts. */
export interface Person {
  id: number;
  name: string;
  created_at?: string;
  fact_count?: number;
  bucket?: "family" | "friends" | "work" | "other" | string;
  living_status?: "living" | "deceased" | "unknown" | string;
  birth_date?: string | null;
  death_date?: string | null;
  relationship_state?: "active" | "former" | "unknown" | string;
  interaction_preference?: "normal" | "avoid" | string;
  visibility_level?: "hidden" | "summary" | "full" | string;
  linked_user_id?: number | null;
  linked_username?: string | null;
  preferred_photo_url?: string | null;
  birthday?: string | null;
}

export interface PeopleEdge {
  id: number;
  from_person_id: number;
  from_person_name: string;
  to_person_id: number;
  to_person_name: string;
  edge_type: string;
  confidence: number;
  start_date?: string | null;
  end_date?: string | null;
  provenance?: string;
}

export interface PersonMedia {
  id: number;
  original_filename: string;
  file_url?: string | null;
  medium_url?: string | null;
  thumbnail_url?: string | null;
  created_at?: string;
}

export interface ReconcileCandidate {
  id: number;
  name: string;
  birth_date?: string | null;
  bucket?: string;
  living_status?: string;
  relationship_state?: string;
  interaction_preference?: string;
  linked_user_id?: number | null;
  linked_username?: string | null;
  preferred_photo_url?: string | null;
  fact_count?: number;
  event_count?: number;
  media_count?: number;
  edge_count?: number;
  owner_user_id: number;
}

export interface ReconcileGroup {
  label: string;
  suggested_target_id: number;
  suggestion_reason: string;
  candidates: ReconcileCandidate[];
}

export interface Relationship {
  id: number;
  relation: string;
  confidence: number;
  created_at?: string;
  person_id: number;
  person_name: string;
}

export interface ConflictCandidate {
  id: number;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  updated_at?: string;
}

export interface FactConflict {
  subject: string;
  predicate: string;
  candidates: ConflictCandidate[];
}

export interface PlatformInfo {
  platform: string;
  fast_model: string;
  thinking_model: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  parameter_size: string;
  quantization: string;
  family: string;
  modified_at: string;
}

export interface LoadedModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string;
}

export interface TraceStep {
  name: string;
  status: string;
  timing_ms: number;
  details: Record<string, unknown>;
}

export interface PipelineRunResponse {
  normalized: {
    raw_text: string;
    cleaned_text: string;
    lowered_text: string;
  };
  signals: {
    interaction_signal: string;
    tone_signal: string;
    urgency: string;
    confidence: number;
  };
  fast_lane: {
    matched: boolean;
    capability?: string | null;
    response_text?: string | null;
    reason?: string | null;
  };
  parsed: {
    token_count: number;
    tokens: string[];
    sentences: string[];
    parser?: string;
    entities?: Array<[string, string]>;
    noun_chunks?: string[];
  };
  chunks: Array<{
    text: string;
    index: number;
    role: string;
    span_start?: number;
    span_end?: number;
  }>;
  extractions: Array<{
    chunk_index: number;
    references: string[];
    predicates: string[];
    subject_candidates: string[];
    entities?: Array<[string, string]>;
  }>;
  routes: Array<{
    chunk_index: number;
    capability: string;
    confidence: number;
    matched_text: string;
  }>;
  implementations: Array<{
    chunk_index: number;
    capability: string;
    handler_name: string;
    implementation_id: string;
    priority: number;
    candidate_count: number;
  }>;
  resolutions: Array<{
    chunk_index: number;
    resolved_target: string;
    source: string;
    confidence: number;
    context_value?: string | null;
    candidate_values?: string[];
    params?: Record<string, unknown>;
    unresolved?: string[];
    notes?: string[];
  }>;
  executions: Array<{
    chunk_index: number;
    capability: string;
    output_text: string;
    success?: boolean;
    error?: string | null;
    attempts?: number;
    handler_name?: string;
    raw_result?: Record<string, unknown>;
  }>;
  request_spec: {
    trace_id: string;
    original_request: string;
    chunks: Array<{
      text: string;
      role: string;
      capability: string;
      confidence: number;
      handler_name: string;
      implementation_id: string;
      candidate_count: number;
      params: Record<string, unknown>;
      result: Record<string, unknown>;
      success: boolean;
      error?: string | null;
      unresolved: string[];
    }>;
    supporting_context: string[];
    context: Record<string, unknown>;
    runtime_version: number;
    llm_used?: boolean;
    llm_reason?: string | null;
    llm_model?: string | null;
  };
  response: {
    output_text: string;
  };
  trace: {
    steps: TraceStep[];
  };
  trace_summary: {
    total_timing_ms: number;
    slowest_step_name: string;
    slowest_step_timing_ms: number;
    step_count: number;
  };
}

export interface DependencyStatus {
  key: string;
  label: string;
  version: string;
  status: string;
  running: boolean;
  detail: string;
}

export interface PhaseStatus {
  id: string;
  label: string;
  title: string;
  status: string;
  completed: string[];
  remaining: string[];
}

export interface MemoryTier {
  tier: number;
  name: string;
  title: string;
  storage: string;
  landing_phase: string;
}

export interface MemorySlotSpec {
  name: string;
  tier: number;
  char_budget: number;
  always_present: boolean;
  landing_phase: string;
}

export interface MemoryActivePhase {
  id: string;
  label: string;
  title: string;
  status: string;
  summary: string;
  deliverables: string[];
}

export interface MemoryPhaseEntry {
  id: string;
  label: string;
  title: string;
  status: string;
}

export interface MemoryStatus {
  active_phase: MemoryActivePhase;
  phases: MemoryPhaseEntry[];
  tiers: MemoryTier[];
  slots: {
    specs: MemorySlotSpec[];
    worst_case_total_chars: number;
  };
  scaffolding: {
    module: string;
    submodules: string[];
    fixtures: string[];
    regression_row_id: string;
  };
}

export interface PipelineStatusResponse {
  current_focus: string;
  phases: PhaseStatus[];
  dependencies: DependencyStatus[];
  memory?: MemoryStatus;
}

export interface MemoryFactRow {
  id: number;
  owner_user_id: number;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  status: string;
  observation_count: number;
  source_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryPersonRow {
  id: number;
  owner_user_id: number;
  name: string | null;
  handle: string | null;
  provisional: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryRelationshipRow {
  id: number;
  owner_user_id: number;
  person_id: number;
  relation_label: string;
  created_at: string;
}

export interface MemoryDumpResponse {
  owner_user_id: number;
  db_path: string;
  active_facts: MemoryFactRow[];
  superseded_facts: MemoryFactRow[];
  people: MemoryPersonRow[];
  relationships: MemoryRelationshipRow[];
  summary: {
    active_fact_count: number;
    superseded_fact_count: number;
    person_count: number;
    relationship_count: number;
  };
}

export interface MemoryResetResponse {
  owner_user_id: number;
  db_path: string;
  facts_cleared: number;
  people_cleared: number;
}

export interface SkillEntry {
  capability: string;
  description: string;
  examples: string[];
  selected_handler: string;
  selected_implementation_id: string;
  implementations: Array<{
    id: string;
    handler_name: string;
    priority: number;
    enabled: boolean;
  }>;
}

export interface DevSkillsResponse {
  skills: SkillEntry[];
}

export interface DevSkillRunResponse {
  capability: string;
  handler_name: string;
  implementation_id: string;
  selected_priority: number;
  message: string;
  params: Record<string, unknown>;
  resolved_target: string;
  timing_ms: number;
  execution: {
    success: boolean;
    output_text: string;
    error?: string | null;
    attempts: number;
    raw_result: Record<string, unknown>;
  };
}

export interface TrackedProcess {
  label: string;
  running: boolean;
  pid: number | null;
  cpu_percent: number;
  memory_bytes: number;
  command: string;
}

export interface StorageBucket {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  size_bytes: number;
}

export interface SystemMetrics {
  cpu: { load_percent: number; cores: number };
  memory: { used_bytes: number; total_bytes: number; used_percent: number };
  disk: { used_bytes: number; total_bytes: number; used_percent: number; path: string };
}

export interface SystemInfo {
  platform: string;
  fast_model: string;
  thinking_model: string;
  ollama_version: string;
  ollama_ok: boolean;
  internet_ok: boolean;
  available_models: OllamaModel[];
  loaded_models: LoadedModel[];
  system: SystemMetrics;
  processes: TrackedProcess[];
  storage: StorageBucket[];
}

export interface SettingsData {
  admin_prompt: string;
  user_prompt: string;
  piper_voice: string;
  stt_model: string;
  read_aloud: boolean;
  speech_rate: number;
  sentence_pause: number;
  normalize_text: boolean;
  log_level: string;
  relationship_aliases: Record<string, string[]>;
}
