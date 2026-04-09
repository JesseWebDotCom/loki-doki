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

export interface SettingsData {
  admin_prompt: string;
  user_prompt: string;
  piper_voice: string;
  stt_model: string;
  read_aloud: boolean;
}
