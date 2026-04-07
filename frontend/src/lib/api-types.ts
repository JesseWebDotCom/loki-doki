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
  status: "success" | "failed" | "no_skill" | string;
  mechanism: string | null;
  latency_ms: number;
  source_url?: string | null;
  mechanism_log?: Array<Record<string, unknown>>;
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
  predicate?: string;
  category: string;
  confidence?: number;
  created_at?: string;
  updated_at?: string;
}

/** PR3 people / relationships / conflicts. */
export interface Person {
  id: number;
  name: string;
  created_at?: string;
  fact_count?: number;
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
