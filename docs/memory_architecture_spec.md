# LokiDoki Memory Architecture Specification

## 1. Core Topology: Master / Child Nodes

The memory system is explicitly designed for a multi-node environment, optimizing edge compute headroom.

*   **Master Node (Mac or Home Server):** Holds the complete SQLite database. Runs `sqlite-vec` for all semantic and vector searches. Is the source of truth for all memory layers.
*   **Child Nodes (pi_cpu, pi_hailo, mobile):** Hold a lightweight local cache (SQLite). They **do not** replicate the full DB or run local embedding indices.
*   **Sync Mechanism:** Watermark-based (`last_modified` + `node_id`). Child nodes send their watermark on connection and receive deltas. Master wins on core context writes; last-write wins on episodic.
*   **Routing Impact:** Memory staleness on child nodes acts as a signal to the Classic Router (e.g., extremely stale cache might defer execution to the Master node before selecting Gemma vs. Qwen).

---

## 2. Memory Layers

1.  **L1 — Core Context (Syncs to all relevant nodes):** 
    Small, injected directly into the system prompt. Contains: user name, location, core preferences, immediate family one-liners, and active emotional states. Target: < 800 tokens.
2.  **L2 — Episodic (Syncs to nodes the user has touched):**
    Rolling window of recent sessions. Injected when contextually relevant.
3.  **L3 — Archival (Master only, accessed via API):**
    Full `sqlite-vec` semantic index. The Gemma tool model queries the Master's `/memory/search` endpoint when deep context is needed mid-conversation.

---

## 3. Household Memory Schema

The foundational layer mapping the user's real-world environment and relationships.

1.  **`entities`**: People, places, orgs. (`id`, `name`, `type`, `summary`, `embedding`, `created_at`). High-importance entities map to L1; others live in L3.
2.  **`relationships`**: Edges between entities. (`entity_a`, `entity_b`, `relation_type`, `since`, `notes`). Flat join table for the family tree.
3.  **`events`**: Key life moments. (`date`, `title`, `notes`, `importance` [1-5], `embedding`). Linked to entities via `event_entities` join table with a `role` column.
4.  **`entity_traits`**: Ongoing key/value facts. (`entity_id`, `key`, `value`, `updated_at`, `confidence`). *Decay: Slow.* Re-weighted on confirmation; fades over months.
5.  **`recurring_dates`**: Birthdays, anniversaries. (`entity_id`, `label`, `month`, `day`, `remind_days_before`). *Decay: None.* Drives proactive L1 injections.
6.  **`household_context`**: Cross-user facts. (`key`, `value`, `updated_at`). Examples: pets, shared calendar routines. Syncs to all child nodes to make the agent feel "home-aware".
7.  **`emotional_context`**: Time-bounded states. (`entity_id`, `state`, `intensity`, `created_at`, `expires_at`, `last_confirmed_at`). *Decay: Fast.* Default 7-day TTL, reset upon user re-confirmation.

---

## 4. Character Memory Schema

The persona-specific layer that allows characters (personas) to form unique relationships, evolve, and retain siloed knowledge.

1.  **`characters`**: Base definition index. (`id`, `name`, `franchise`, `base_persona_prompt`). 
    *Note: Respects the `loki-doki-personas` boundary constraint. The base prompt here acts as a strict cache/reference to the `persona.json` filesystem content.*
2.  **`char_user_memory`**: Episodic and trait knowledge siloed to a specific character and user. (`character_id`, `user_id`, `key`, `value`, `confidence`, `source`). Syncs via L1 delta.
3.  **`char_world_knowledge`**: Franchise-specific real-world facts. (`character_id`, `fact`, `source` [web/user/canon], `fetched_at`, `expires_at`). Master-only.
    *   *Freshness Tweak:* While the spec dictates fetching at session start, this shouldn't block the *first* response to avoid latency. It should trigger asynchronously at session start (or via a daily Master cron) and is injected into the subsequent turn once fetched.
4.  **`char_evolution_state`**: The relationship drift layer. Stored as a JSON blob per `character_id` × `user_id`. Capped at ~300 tokens. Syncs to child nodes. Tracks:
    *   `nickname`: What the character calls the user.
    *   `tone`: Emotional register toward the user.
    *   `topics`: Recurring unprompted themes.
    *   `opinions`: Views the character has formed about the user.
    *   *Mechanism:* Fully automatic. Gemma extracts the session delta at termination and merges it into the blob.
5.  **`char_cross_awareness`**: User-scoped cross-character knowledge. (`user_id`, `char_a`, `char_b`, `fact`). 
    *   Default behavior is siloed. Only activates when a user explicitly mentions another character or opts in. Syncs fully as it is small and user-scoped.

---

## 5. The Extraction Pipeline

To prevent context pollution from STT errors or hallucinations, all memory extraction is heavily gated by the Gemma tool model.

*   **Extraction:** Gemma extracts candidate memories mid-conversation, assigning a confidence score.
*   **Direct Write:** Candidates with confidence `> 0.85` are written immediately.
*   **Passive Queue:** Candidates with confidence `< 0.85` are queued. If the fact surfaces again, the confidence compounds until it hits the write threshold.
*   **Explicit Override:** User statements (e.g., "Remember that...") are mathematically forced to `1.0` confidence and written immediately.
*   **Telemetry:** Every write is tagged with a `source` (extracted vs. explicit) and `node_id` for accurate Master/Child sync conflict resolution.

---

## 6. The MemoryStore Interface

The foundational API layer exposed by `app/subsystems/memory/`:

1.  `get_l1_context(user_id, character_id=None)`: Fast, local SQL cache retrieval for immediate prompt injection.
2.  `search_archival(query, user_id)`: Edge nodes call HTTP `/memory/search` on Master; Master executes local `sqlite-vec`.
3.  `write_memory(candidate, confidence)`: Handles the logic for threshold checks, direct writes, and the compounding queue.
4.  `sync_delta(node_id, watermark)`: Background process on child nodes parsing the latest Master writes.
5.  `evolve_character_state(user_id, character_id, session_transcript)`: Triggered at session end to update `char_evolution_state`.

---

## 7. Prompt Compilation & Dynamic Injection

**The Compilation Rule:** Dynamic memories (L1 Core, Emotional State, Evolution) are NEVER fed into the LLM prompt compiler. Doing so would break the `base_prompt_hash` and trigger an expensive LLM recompilation on every session.

**The Injection Mechanism:**
1. **The Static Identity (Compiled):** The `compiled_base_prompt` handles Global Rules + Care Profile + User Preferences + Character Base Identity. It is compiled once by the LLM and heavily cached.
2. **The Dynamic Tail (Appended):** At runtime, the Orchestrator requests the current L1 and Evolution state from the `MemoryStore`. It formats this as an XML `<memory_context>` block and mechanically appends it to the end of the `compiled_base_prompt`.
3. **L3 Archival Triggers:** Only if Gemma explicitly ran a `search_archival()` tool call during the current turn's analysis phase does the Orchestrator temporarily append `<retrieved_facts>` into the dynamic tail.

This separation ensures lightning-fast Time-To-First-Token without sacrificing deep personalization.
