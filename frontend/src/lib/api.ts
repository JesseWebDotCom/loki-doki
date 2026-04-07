/**
 * HTTP and SSE client for the LokiDoki backend.
 *
 * The big thing in this file is `sendChatMessage`. The backend streams
 * `text/event-stream` from `/api/v1/chat`, and the parser used to drop
 * the final synthesis event whenever the last chunk arrived without a
 * trailing blank line. That regression cost us a real "where's my
 * answer?" UX bug — see `__tests__/api.test.ts` for the pin.
 *
 * The fix: when the reader closes, flush any partial event still in
 * the buffer instead of throwing it away. SSE per the spec dispatches
 * an event on a blank line, but a network/stream close is also a
 * dispatch boundary if a `data:` line is present.
 */
import type { PipelineEvent } from "./api-types";

export type {
  PipelineEvent,
  DecompositionData,
  RoutingData,
  RoutingLogEntry,
  SynthesisData,
  SourceInfo,
  Fact,
  PlatformInfo,
  SettingsData,
  AskInfo,
  SentimentInfo,
  Person,
  Relationship,
  ConflictCandidate,
  FactConflict,
  AmbiguityGroup,
  SilentConfirmation,
} from "./api-types";

const API_BASE = "/api/v1";

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Pull `data: {...}` JSON events out of an SSE buffer.
 *
 * Returns the list of events found AND the leftover buffer. The
 * leftover may contain a partial event (no trailing blank line yet);
 * the caller decides whether to keep buffering or flush.
 */
export function parseSseChunk(
  buffer: string,
): { events: PipelineEvent[]; rest: string } {
  const events: PipelineEvent[] = [];
  // SSE delimits events with a blank line ("\n\n" or "\r\n\r\n").
  const parts = buffer.split(/\r?\n\r?\n/);
  // Everything except the final segment is a complete event.
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const evt = parseSseEvent(part);
    if (evt) events.push(evt);
  }
  return { events, rest };
}

/**
 * Parse a single SSE event block (one or more lines, possibly with
 * `data:` prefix). Returns null if no usable JSON was found.
 */
export function parseSseEvent(block: string): PipelineEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      // Per spec, a single space after the colon is stripped.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    return JSON.parse(payload) as PipelineEvent;
  } catch {
    return null;
  }
}

/**
 * Stream a chat turn to the backend, invoking `onEvent` for every
 * pipeline event the server emits. Resolves when the stream ends.
 *
 * Critical: when the reader closes, we attempt to parse whatever is
 * left in the buffer as a final event. This is the SSE-final-chunk
 * regression the test in `__tests__/api.test.ts` pins.
 */
export async function sendChatMessage(
  message: string,
  onEvent: (event: PipelineEvent) => void,
  sessionId?: number,
  projectId?: number,
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId ?? null,
      project_id: projectId ?? null,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    if (done) {
      // Flush whatever is left. If the final event arrived without
      // a trailing blank line — which is exactly what the synthesis
      // "done" event does in practice — this is the only chance the
      // client gets to see it. THIS IS THE REGRESSION FIX.
      const tail = parseSseEvent(buffer);
      if (tail) onEvent(tail);
      break;
    }
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const evt of events) onEvent(evt);
  }
}

// ---------------------------------------------------------------------------
// JSON wrappers — thin and unsurprising.
// ---------------------------------------------------------------------------

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

export async function getSessionMessages(sessionId: string | number) {
  return getJson<{ session_id: number; messages: Array<Record<string, any>> }>(
    `/memory/sessions/${sessionId}/messages`,
  );
}

export async function getFacts(projectId?: number) {
  // The backend returns the new (subject/predicate/value) shape; we
  // alias `value` -> `fact` so the legacy MemoryPage UI keeps rendering.
  const qs = projectId != null ? `?project_id=${projectId}` : "";
  const r = await getJson<{ facts: Array<Record<string, any>> }>(`/memory/facts${qs}`);
  return {
    facts: r.facts.map((f) => ({
      ...f,
      fact: f.value ?? f.fact ?? "",
    })) as import("./api-types").Fact[],
  };
}

export async function searchFacts(q: string) {
  return getJson<{
    query: string;
    results: Array<{ fact: string; score: number; subject?: string }>;
  }>(`/memory/facts/search?q=${encodeURIComponent(q)}`);
}

export async function getSessions() {
  const r = await getJson<{ sessions: Array<number | string>; details?: any[] }>(
    "/memory/sessions",
  );
  return { sessions: r.sessions.map(String), details: r.details };
}

export async function deleteSession(sessionId: string | number) {
  const r = await fetch(`${API_BASE}/chat/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`/chat/sessions/${sessionId}: ${r.status}`);
  return (await r.json()) as { status: string };
}

export async function updateSession(
  sessionId: string | number,
  update: { title?: string; project_id?: number },
) {
  const r = await fetch(`${API_BASE}/chat/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!r.ok) throw new Error(`/chat/sessions/${sessionId}: ${r.status}`);
  return (await r.json()) as { status: string };
}

export interface ProjectRecord {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  icon_color: string;
  created_at?: string;
}

export interface ProjectInput {
  name: string;
  description: string;
  prompt: string;
  icon: string;
  icon_color: string;
}

export async function getProjects() {
  return getJson<{ projects: ProjectRecord[] }>("/projects");
}

export async function createProject(project: ProjectInput) {
  return postJson<{ id: number; status: string }>("/projects", project);
}

export async function updateProject(id: number, project: ProjectInput) {
  const r = await fetch(`${API_BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  if (!r.ok) throw new Error(`/projects/${id}: ${r.status}`);
  return (await r.json()) as { status: string };
}

export async function deleteProject(id: number) {
  const r = await fetch(`${API_BASE}/projects/${id}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`/projects/${id}: ${r.status}`);
  return (await r.json()) as { status: string };
}

export async function clearChatMemory() {
  // PR1: persistent storage; clearing is deferred. Keep the function
  // alive so callers compile, but it's a no-op against the real API.
  return { status: "noop" };
}

// --- PR3: people / relationships / conflicts ----------------------------

export async function getPeople() {
  return getJson<{ people: import("./api-types").Person[] }>("/memory/people");
}

export async function getPersonDetail(id: number) {
  return getJson<{
    person: import("./api-types").Person;
    facts: Array<Record<string, any>>;
  }>(`/memory/people/${id}`);
}

export async function mergePeople(sourceId: number, intoId: number) {
  return postJson<{ merged: boolean; source_id: number; into_id: number }>(
    `/memory/people/${sourceId}/merge`,
    { into_id: intoId },
  );
}

export async function getRelationships() {
  return getJson<{ relationships: import("./api-types").Relationship[] }>(
    "/memory/relationships",
  );
}

export async function getFactConflicts() {
  return getJson<{ conflicts: import("./api-types").FactConflict[] }>(
    "/memory/facts/conflicts",
  );
}

export async function confirmFact(id: number) {
  return postJson<{ id: number; confidence: number }>(
    `/memory/facts/${id}/confirm`,
    {},
  );
}

export async function rejectFact(id: number) {
  return postJson<{ ok: boolean }>(`/memory/facts/${id}/reject`, {});
}

export async function patchFact(
  id: number,
  patch: Partial<{
    value: string;
    predicate: string;
    subject: string;
    subject_ref_id: number | null;
    subject_type: string;
    status: string;
  }>,
) {
  const r = await fetch(`${API_BASE}/memory/facts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`/memory/facts/${id}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function deleteFact(id: number) {
  const r = await fetch(`${API_BASE}/memory/facts/${id}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`/memory/facts/${id}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function createPerson(name: string) {
  return postJson<{ id: number; name: string }>("/memory/people", { name });
}

export async function renamePerson(id: number, name: string) {
  const r = await fetch(`${API_BASE}/memory/people/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`/memory/people/${id}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function deletePerson(id: number) {
  const r = await fetch(`${API_BASE}/memory/people/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`/memory/people/${id}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function addRelationship(personId: number, relation: string) {
  return postJson<{ id: number }>(
    `/memory/people/${personId}/relationships`,
    { relation },
  );
}

export async function setPrimaryRelationship(personId: number, relation: string) {
  const r = await fetch(`${API_BASE}/memory/people/${personId}/primary-relationship`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relation }),
  });
  if (!r.ok) throw new Error(`/memory/people/${personId}/primary-relationship: ${r.status}`);
  return (await r.json()) as { id: number };
}

export async function deleteRelationship(relId: number) {
  const r = await fetch(`${API_BASE}/memory/relationships/${relId}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`/memory/relationships/${relId}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function getAmbiguityGroups() {
  return getJson<{ groups: import("./api-types").AmbiguityGroup[] }>(
    "/memory/ambiguity_groups",
  );
}

export async function resolveAmbiguityGroup(groupId: number, personId: number) {
  return postJson<{ ok: boolean }>(
    `/memory/ambiguity_groups/${groupId}/resolve`,
    { person_id: personId },
  );
}

export async function getPlatformInfo() {
  return getJson<import("./api-types").PlatformInfo>("/chat/platform");
}

export async function getSettings() {
  return getJson<import("./api-types").SettingsData>("/settings");
}

// ---- skills config -------------------------------------------------------

export interface SkillConfigField {
  key: string;
  type: "string" | "secret" | "number" | "integer" | "boolean";
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface SkillConfigSchema {
  global: SkillConfigField[];
  user: SkillConfigField[];
}

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  intents: string[];
  examples: string[];
  config_schema: SkillConfigSchema;
  // For secret fields, the value is { _set: boolean }; otherwise the raw value.
  global: Record<string, unknown>;
  user: Record<string, unknown>;
  // Combined effective state. True only when admin toggle, user
  // toggle, and required-config check all pass. Disabled skills are
  // skipped by the orchestrator at chat time.
  enabled: boolean;
  // True when required config is satisfied — independent of toggles.
  config_ok: boolean;
  missing_required: string[];
  // Why the skill is disabled, if it is. Null when enabled.
  disabled_reason: "global_toggle" | "user_toggle" | "config" | null;
  // Raw admin/user manual switches.
  toggle: { global: boolean; user: boolean };
}

export async function listSkills() {
  return getJson<{ skills: SkillSummary[] }>("/skills");
}

export async function setSkillGlobal(
  skillId: string,
  key: string,
  value: unknown,
) {
  const r = await fetch(`${API_BASE}/skills/${skillId}/config/global`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error(`set global ${skillId}.${key}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function setSkillUser(
  skillId: string,
  key: string,
  value: unknown,
) {
  const r = await fetch(`${API_BASE}/skills/${skillId}/config/user`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error(`set user ${skillId}.${key}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function deleteSkillUser(skillId: string, key: string) {
  const r = await fetch(
    `${API_BASE}/skills/${skillId}/config/user/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`delete user ${skillId}.${key}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function setSkillToggleGlobal(skillId: string, enabled: boolean) {
  const r = await fetch(`${API_BASE}/skills/${skillId}/toggle/global`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`toggle global ${skillId}: ${r.status}`);
  return (await r.json()) as { ok: boolean; enabled: boolean };
}

export async function setSkillToggleUser(skillId: string, enabled: boolean) {
  const r = await fetch(`${API_BASE}/skills/${skillId}/toggle/user`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`toggle user ${skillId}: ${r.status}`);
  return (await r.json()) as { ok: boolean; enabled: boolean };
}

export async function deleteSkillGlobal(skillId: string, key: string) {
  const r = await fetch(
    `${API_BASE}/skills/${skillId}/config/global/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`delete global ${skillId}.${key}: ${r.status}`);
  return (await r.json()) as { ok: boolean };
}

export async function saveSettings(settings: import("./api-types").SettingsData) {
  return postJson<{ status: string }>("/settings", settings);
}
