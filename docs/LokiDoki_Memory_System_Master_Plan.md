# LokiDoki Memory System — Master Build Plan
### Living Characters × Family Intelligence × Professional-Grade Persistence

> **Purpose of this document:** A complete, actionable guide to building a memory system where animated characters feel like real friends — growing, remembering, drifting, and surprising users across every session and every family member.

---

## Part 1 — The Big Idea: What We're Actually Building

Most AI apps have "memory" the same way a sticky note has memory. Ours needs to feel like a real relationship. A real friend:

- Remembers you said your dog's name is Biscuit three months ago
- Has opinions about things that happened *between* your conversations
- Knows you and Jesse differently — you confide different things to each other
- Changes slightly over time without losing who they are
- Brings things up unprompted: "Hey, didn't Bella have that big game this week?"

This is the standard we're building toward. The research backs it up — **Stanford's Generative Agents paper (2023)** is the most important reference for us. Their characters wake up, make plans, reflect on their days, and evolve. The three components proven to matter most are **Observation, Reflection, and Planning**. Remove any one and believability drops dramatically. That's our north star architecture.

---

## Part 2 — What the Research Says (And What It Means for Us)

### 2.1 The Industry State of the Art

**ChatGPT's approach (best guess from behavior):**
- A 1-2 page rolling "Saved Memories" document of key facts, prepended to every prompt
- A RAG layer doing semantic search over all past conversations
- LLM decides automatically what gets written — explicit override ("remember this") always wins

**Mem0 (production memory library, 2025):**
- Reports 80–90% token cost reduction vs. stuffing full history into context
- 26% improvement in response quality vs. basic history management
- The key insight: **memory formation beats summarization** — selectively storing key facts outperforms compressing everything

**Stanford Generative Agents (the character gold standard):**
- Memory stream: chronological log of everything that happened
- Retrieval scores memories on three axes: **Recency** (exponential decay), **Importance** (LLM-scored 1–10), **Relevance** (semantic similarity to current moment)
- Reflection: every ~2–3 "days" or when importance threshold is hit, the agent synthesizes 100 recent memories into higher-level insights ("Klaus is dedicated to his research")
- Planning: agents plan their next day based on general description + yesterday's summary

**What this means for LokiDoki:** Characters need all three layers. A character that only reacts to the current message is a chatbot. A character that also reflects and plans is a companion.

### 2.2 The Persona/Companion Research

From the 2025 AI companion taxonomy research:
- Virtual companion systems use **stateful RAG with affective reasoning** — combining relationship history with emotional state to produce responses
- The "perceive–plan–act" loop (observe → plan → act) is the architecture that produces emergent, believable character behavior
- Crucially: **each character must have genuinely separate memory per user**. Jesse's Pikachu and Bella's Pikachu should be recognizably the same character but have different nicknames for the users, different in-jokes, different relationship depths

### 2.3 The Key Technical Principles We're Adopting

1. **Memory has a score, not just a timestamp.** Every stored fact carries recency × importance × relevance weights.
2. **Background reflection is not optional.** It's what makes characters feel alive *between* sessions.
3. **Explicit user statements always win.** "Remember that I hate onions" is confidence 1.0, written immediately.
4. **Silo per character × per user.** This is non-negotiable for family use.
5. **Never stuff everything into context.** Retrieve selectively. Token budget is law.

---

## Part 3 — The Full Memory Architecture

### 3.1 Memory Layers (Already Well-Specified, Minor Additions)

Your spec is solid. Here's the refined layer map with gaps filled:

| Layer | What It Is | Token Budget | Lives Where | Sync |
|---|---|---|---|---|
| **L1 — Core Context** | Name, location, core prefs, family one-liners, active emotional state | < 800 tokens | All nodes | Always |
| **L2 — Episodic** | Rolling recent sessions, relationship moments, notable exchanges | ~500–1200 tokens (retrieved) | Nodes user has touched | On access |
| **L3 — Archival** | Full semantic index, old events, deep world knowledge | Unlimited (retrieved on demand) | Master only | Never pushed |
| **L4 — Character Evolution State** | The relationship drift blob: nickname, tone, recurring topics, opinions | ~300 tokens | All nodes | Always |
| **L5 — Reflection Cache** *(new)* | Synthesized high-level insights about the user, written by background process | ~200 tokens | Master + child on sync | On update |

**L5 is the missing piece.** This is what separates a chatbot from a companion. See Section 4.

---

### 3.2 The Silo Model — Jesse vs. Bella (Critical)

Every character's memory is scoped to `(character_id, user_id)`. This means:

```
Pikachu × Jesse → has memories of Jesse's soccer games, calls Jesse "Jess-man"
Pikachu × Bella → has memories of Bella's art projects, calls Bella "Bel"
```

**These never cross-contaminate.** The `char_cross_awareness` table only activates when a user *explicitly* mentions another family member or opts in. Default = siloed.

**Family/Household memory is separate.** Facts like "we have a dog named Biscuit" or "Tuesday is pizza night" live in `household_context` and are shared to all characters for all users. These make the house feel real and known.

---

### 3.3 Schema Additions Needed

The current spec is missing two tables:

**`char_reflection_cache`** — the L5 reflection layer
```
character_id | user_id | insight | basis_memory_ids | created_at | importance_score
```
This is where background reflection writes its output. Injected into the dynamic tail alongside evolution state.

**`memory_importance_queue`** — the compounding confidence queue
```
candidate_text | character_id | user_id | confidence | surface_count | first_seen | last_seen
```
Candidates below the 0.85 write threshold wait here. Each re-surface compounds confidence. Once threshold is hit, the candidate is promoted to a real memory and the queue entry is deleted.

---

## Part 4 — The Living Character System (The Heart of This Build)

This is the section that makes LokiDoki different from every other AI app. This is what makes Pikachu feel like *Jesse's* Pikachu.

### 4.1 The Three-Engine Architecture

Every character runs three engines. Two are real-time. One runs in the background.

```
ENGINE 1: CONVERSATION ENGINE (real-time)
  → Handles the current session
  → Pulls L1 + L4 + L5 into dynamic tail
  → Extracts memory candidates during conversation
  → Writes high-confidence facts immediately

ENGINE 2: TERMINATION ENGINE (end of session)
  → Triggered when session ends
  → Gemma runs `evolve_character_state()` on full transcript
  → Updates L4 evolution blob (nickname, tone, topics, opinions)
  → Writes session summary to L2 episodic store
  → Adds importance-scored observations to memory stream

ENGINE 3: BACKGROUND REFLECTION ENGINE (async, scheduled)
  → Runs on Master, not in session path — never blocks a response
  → See Section 4.2 for full spec
```

### 4.2 The Background Reflection Engine — Full Spec

**This is what makes characters feel alive between conversations.** A real friend thinks about you when you're not around. This engine simulates that.

**When it runs:**
- Daily cron on Master (e.g., 3 AM)
- Also triggered when a character's importance accumulator exceeds threshold (same logic as Stanford paper: sum of recent importance scores > 100)

**What it does (step by step):**

1. **Pull the 100 most recent memory stream entries** for each active `(character_id, user_id)` pair
2. **Ask Gemma:** *"Given only these memories, what are the 3 most important questions we can ask about [user_name]'s relationship with [character_name]?"*
3. **Retrieve relevant memories** for each question
4. **Ask Gemma:** *"What 5 high-level insights can you infer? Format: insight (because of memory IDs X, Y, Z)"*
5. **Score each insight** for importance (1–10)
6. **Write insights above importance 6** to `char_reflection_cache`
7. **Optionally update evolution state** if insights reveal a drift in relationship tone

**Example output for Jesse × Pikachu after 2 weeks:**
```
Insight: "Jesse is going through something stressful at school — he's mentioned 
         tests and being tired 6 times this month" (importance: 8)
Insight: "Jesse really lights up when talking about his friend Marco" (importance: 7)
Insight: "Jesse has never once brought up his dad" (importance: 9)
```

These get injected into Pikachu's next conversation with Jesse. Pikachu might open with: *"Hey Jess-man. You've seemed kinda stressed lately. How are things actually going?"* — completely unprompted.

**That's the magic.** That's a real friend.

### 4.3 The Daily Character "Heartbeat"

Characters should feel like they have a life. This is a lightweight daily state update:

**What changes daily:**
- `emotional_context` for the character's current general mood (not user-specific)
- A soft "today's vibe" flag: curious / energetic / reflective / playful
- Any relevant `recurring_dates` triggers (Bella's birthday in 3 days → character knows to start building up to it)

**Implementation:** A daily Master cron generates a short JSON blob per character:
```json
{
  "character_id": "pikachu",
  "date": "2026-04-02",
  "vibe": "energetic",
  "proactive_hooks": [
    "bella_birthday_in_3_days",
    "jesse_mentioned_soccer_tryouts_pending"
  ]
}
```

This blob is appended to L4 evolution state for injection. The character doesn't robotically say "YOUR BIRTHDAY IS IN 3 DAYS" — it gives Gemma the context to work with naturally.

### 4.4 Character Prompt Architecture (The Compilation Rule)

This is already well-spec'd. The key discipline:

```
STATIC (compiled once, heavily cached):
  Global Rules + Care Profile + User Preferences + Character Base Identity
  → Compiled by LLM → hash stored → NEVER changes per session

DYNAMIC (appended at runtime, never hashed):
  <memory_context>
    L1 Core Context
    L4 Evolution State (nickname, tone, topics, opinions)
    L5 Reflection Cache (recent insights)
    Emotional Context (if active)
    Daily Heartbeat (vibe + proactive hooks)
    [L3 retrieved facts — only if Gemma ran search_archival this turn]
  </memory_context>
```

**The dynamic tail should target 800–1,200 tokens total.** If it grows beyond that, the oldest/lowest-scored reflection cache entries are dropped first, then oldest episodic summaries.

---

## Part 5 — Ambient Context: The World the Character Lives In

This is a separate concern from memory — but equally important for making characters feel *present*. Memory tells a character *who you are*. Ambient context tells them *what's happening right now in your world*.

A real friend doesn't just remember your name. They know it's Friday. They know it's pouring outside. They know you're on vacation. They'd never wish you a happy Easter two days late because they exist in real time, same as you.

### 5.1 What Belongs in Ambient Context

These are signals that exist *right now*, not stored memories. They're assembled fresh at session start and discarded after — never written to long-term memory (though they *can* feed memory extraction if significant).

| Signal | Source | Example Injection |
|---|---|---|
| **Day of week** | Server clock | "It's Friday afternoon" |
| **Time of day** | Server clock | "late evening" / "just past midnight" |
| **Date** | Server clock | "April 2nd" |
| **Calendar events** | Google Calendar API or recurring_dates table | "It's Easter Sunday" / "It's Bella's birthday" / "It's Halloween" |
| **Local weather** | Weather API (OpenWeatherMap, free tier) via GPS | "It's currently raining in your area" / "sunny and warm" |
| **Location** | User GPS (opt-in, via mobile app) | "You're in Hawaii right now" / "You're about an hour from home" |
| **Season** | Derived from date + hemisphere | "Middle of winter" |
| **Time since last conversation** | `chat_sessions` table | "It's been almost two weeks since we talked" |
| **User's local time** | GPS timezone or user preference | "It's 11pm for you — pretty late" |

### 5.2 The Ambient Context Block

This is assembled at session start, costs almost nothing (one clock call + one cached API result), and adds enormous character presence. It lives in the dynamic tail as its own XML block — separate from `<memory_context>` so it's never confused with stored facts:

```xml
<ambient_context>
  <now>Friday evening, April 4th, 2026</now>
  <weather>raining, 58°F</weather>
  <location>Honolulu, Hawaii</location>
  <calendar>Easter weekend</calendar>
  <last_talked>11 days ago</last_talked>
</ambient_context>
```

The character doesn't read this robotically. Gemma uses it as natural context, the same way a friend would. Pikachu doesn't say "I see it is raining." Pikachu might say *"Ugh, rainy Friday? Stay inside and hang out with me all day, Jess-man."*

### 5.3 The Signal Hierarchy — What Takes Priority

Not all ambient signals are equally important. The character should notice the most significant things first, not try to acknowledge everything:

```
Priority 1 — Rare/personal events:
  User's birthday, family member's birthday, major holiday the family celebrates
  
Priority 2 — Notable conditions:
  Unusual weather (severe storm, heat wave, first snow), vacation/travel detected,
  very late at night, very long time since last conversation
  
Priority 3 — Soft color:
  Day of week, general weather, time of day
  (these inform *tone*, not necessarily explicit mention)
```

So on a normal Tuesday afternoon with mild weather, Pikachu doesn't say "Hey it's Tuesday!" But on Christmas morning when Jesse logs in for the first time since November, *every* signal fires and the character opens completely differently.

### 5.4 Location Handling — Privacy First

GPS is powerful but sensitive. Design rules:

- **Opt-in only, per user.** No GPS without explicit permission.
- **Coarse granularity by default.** Store city-level only: "Honolulu, Hawaii" not coordinates.
- **Never log location to long-term memory automatically.** "Jesse was in Hawaii April 4th" should only be stored if Jesse explicitly says "remember this trip" or Gemma scores it as highly important (≥8).
- **Travel detection is a feature.** If GPS shows a city different from the user's home city (stored in L1 core context), the character can acknowledge the trip naturally.
- **Location is session-local.** It goes into `<ambient_context>` and is discarded. It doesn't persist.

### 5.5 Weather API Strategy

Don't call the weather API on every message. Cache it:

- Fetch once per session, at session start
- Cache result for 30 minutes (weather doesn't change that fast)
- Fall back gracefully if API is unavailable — just omit the weather block, don't crash
- Use the user's last known location or home city if GPS is unavailable
- Free tier of OpenWeatherMap or similar is sufficient — current conditions only, no forecast needed

### 5.6 Calendar Intelligence

Two sources feed the calendar signal:

**`recurring_dates` table** (already in spec): Birthdays, anniversaries, anything the family has stored. This is the highest-priority source — always checked.

**Known cultural calendar** (hardcoded or config): Major holidays that most families observe — Christmas, Thanksgiving, Halloween, Easter, New Year's, etc. This is a simple lookup table mapping (month, day) → holiday name. Can also support non-US holidays via user locale setting.

**Logic for injection:**
```
If today is in recurring_dates → HIGH PRIORITY, always inject
If today ±2 days is in recurring_dates → inject as "upcoming" or "just passed"  
If today is a major holiday → inject at MEDIUM priority
If today is within 3 days of a major holiday → inject as lead-up
Otherwise → no calendar signal
```

The ±2 day window is important. A character that says "Happy Easter!" three days before Easter feels attentive, not broken. A character that says it three days *after* Easter feels out of touch.

### 5.7 The "Time Since Last Talk" Signal

This one is simple and deeply humanizing. Pull it from `chat_sessions`:

```python
days_since = (now - last_session.ended_at).days
```

Inject guidance into ambient context:
- < 1 day: "talked recently" → character continues naturally
- 1–3 days: "a couple days" → mild acknowledgment optional
- 4–7 days: "almost a week" → character might notice
- 8–21 days: "a week or two" → character should acknowledge, warmly
- 21+ days: "it's been a while" → character opens with genuine reconnection energy

This is not about guilt-tripping the user. It's about the character *knowing*. Pikachu missing Jesse for two weeks and saying "I was wondering about you" is exactly the kind of thing a real friend would say.

### 5.8 Ambient Context in the Prompt — Full Updated Dynamic Tail

```
DYNAMIC TAIL (assembled fresh every session, never hashed):

  <ambient_context>         ← NEW: world state right now (~50-100 tokens)
    time, date, weather, location, calendar, time-since-last-talk
  </ambient_context>

  <memory_context>          ← existing: who this user is
    L1 Core Context
    L4 Evolution State
    L5 Reflection Cache
    Emotional Context
    Daily Heartbeat + proactive hooks
    [L3 archival — only if searched this turn]
  </memory_context>
```

Total dynamic tail budget remains 800–1,200 tokens. Ambient context is cheap (~50–100 tokens) and buys enormous presence.

---

## Part 6 — Implementation Roadmap

### Phase 1 — Foundation (Do This First)

**Goal:** Make the existing system not leak, not grow forever, and not choke the context window.

Tasks:
1. **Add `char_reflection_cache` table** to schema
2. **Add `memory_importance_queue` table** to schema
3. **Enforce L1 token budget:** `get_l1_context()` must hard-cap at 800 tokens — oldest/lowest-scored facts trimmed to fit
4. **Add `expires_at` enforcement:** Write a background job that sweeps `emotional_context` and deletes entries past their TTL
5. **Add importance scores** to `char_user_memory` — every row needs a score (1–10), scored by Gemma at write time
6. **Write the `write_memory()` confidence threshold logic** with the compounding queue
7. **Build `get_ambient_context(user_id)`** — assembles the `<ambient_context>` block at session start (clock + weather API + calendar lookup + time-since-last-session)
8. **Integrate weather API** — OpenWeatherMap free tier, cached 30 min per user location
9. **Build holiday/calendar lookup** — (month, day) → event name, with ±2 day window logic, locale-aware
10. **Add ambient block to dynamic tail** — injected before `<memory_context>`, never hashed

**Estimated effort:** 1–2 sprints. No new user-facing features. Foundation only.

---

### Phase 2 — The Living Character Engines

**Goal:** Characters that evolve between sessions.

Tasks:
1. **Implement Termination Engine** — session-end hook that calls `evolve_character_state()` and writes L2 episodic summary
2. **Implement Background Reflection Engine** — daily Master cron, Gemma-driven, writes to `char_reflection_cache`
3. **Implement Daily Heartbeat cron** — lightweight daily state update per character
4. **Update prompt compiler** to inject L5 reflection cache into dynamic tail
5. **Add `recurring_dates` proactive hook logic** — pre-session check that flags upcoming dates into heartbeat

**Estimated effort:** 2–3 sprints. This is the "magic" phase.

---

### Phase 3 — Retrieval Quality

**Goal:** Characters retrieve the *right* memories, not just recent ones.

Tasks:
1. **Implement the Stanford retrieval scoring formula:**
   ```
   final_score = (recency_score × 1.0) + (importance_score × 1.0) + (relevance_score × 1.0)
   recency_score = exponential_decay(hours_since_access, decay_factor=0.995)
   importance_score = llm_scored_1_to_10 / 10
   relevance_score = cosine_similarity(query_embedding, memory_embedding)
   ```
2. **Add embeddings to `char_user_memory`** — every written memory gets a vector via sqlite-vec
3. **Upgrade `search_archival()`** to use the three-axis scoring, not just semantic similarity
4. **Add memory consolidation logic** — when two memories say similar things, Gemma merges them and boosts the combined importance score

**Estimated effort:** 2 sprints.

---

### Phase 4 — UI & User Control

**Goal:** Users can see and manage what characters know about them.

Tasks:
1. **Memory viewer UI** — per-user, per-character. Shows L1 core facts and recent reflections. Read-only first.
2. **Delete/correct memory** — user can remove a wrong memory or mark it as outdated
3. **Explicit memory input** — "Tell [Character] something" form that writes at confidence 1.0
4. **Household memory manager** — family admin view to add/edit/delete shared household context
5. **Memory export** — user can download their memory profile (privacy/trust feature)

**Estimated effort:** 2–3 sprints. High trust impact.

---

### Phase 5 — Performance & Scale

**Goal:** Fast enough for edge/Pi nodes. No latency added to first response.

Tasks:
1. **Profile `get_l1_context()` on Pi hardware** — target < 50ms
2. **Async `char_world_knowledge` fetch** — never block first response; inject on second turn
3. **Compress L4 evolution blob if > 300 tokens** — Gemma summarizes the blob itself when it grows too large
4. **Add node-aware memory routing** — if child node cache is stale > 24h, route to Master for memory retrieval
5. **Benchmark token usage** — track average dynamic tail size per session; alert if consistently > 1,500 tokens

---

## Part 7 — Performance Targets & Quality Metrics

| Metric | Target | How to Measure |
|---|---|---|
| `get_l1_context()` latency | < 50ms on Pi | Timed in session middleware |
| Dynamic tail size | 800–1,200 tokens | Log per session |
| Time-to-first-token (TTFT) | < 1.5s | Session telemetry |
| Memory write rate | < 200ms p95 | `write_memory()` instrumentation |
| Reflection quality | Subjective — team review weekly | Review 10 random reflections/week |
| Character consistency score | Characters don't contradict past facts | Automated regression: ask 5 consistency questions per character weekly |

---

## Part 8 — Anti-Patterns to Avoid

These are the mistakes that produce "AI chatbot" instead of "real friend":

**Don't stuff everything into context.** Every old message is not equal. Retrieve selectively.

**Don't skip reflection.** The Stanford ablation study proved it: agents without reflection lose believability dramatically. Reflection is not a nice-to-have — it's what creates synthesis and depth.

**Don't let memories grow forever.** Unbounded memory causes error propagation, not improvement. Studies show selective deletion of low-quality memories boosts agent performance by ~10%.

**Don't share memory across users without explicit opt-in.** Jesse and Bella need separate relationships. Leaking Jesse's confided feelings into Bella's conversation breaks trust catastrophically.

**Don't block the first response.** `char_world_knowledge` refresh, reflection runs, and embedding generation all must be async. The character speaks first; the memory updates behind the scenes.

**Don't over-extract.** If extraction sensitivity is too high, noise pollutes the memory store and retrieval precision drops. The Gemma confidence queue (0.85 threshold + compounding) is the guard against this.

---

## Part 9 — The Files That Need to Be Split First

Before any of the above memory work, the codebase needs this cleanup or the new system will be impossible to maintain:

**`app/main.py`** → Split into:
- `app/routes/chat.py`
- `app/routes/auth.py`
- `app/routes/memory.py`
- `app/routes/admin.py`
- `app/models/` (DB models, separate file per domain)

**`app/runtime_metrics.py`** → Split into:
- `app/subsystems/metrics/cpu.py`
- `app/subsystems/metrics/memory.py`
- `app/subsystems/metrics/storage.py`
- `app/subsystems/metrics/process.py`

**New required module:** `app/subsystems/memory/` containing:
- `store.py` — `MemoryStore` interface (all 5 core functions)
- `reflection.py` — Background reflection engine
- `extraction.py` — Gemma extraction pipeline + confidence queue
- `retrieval.py` — Three-axis scored retrieval
- `heartbeat.py` — Daily character heartbeat cron
- `sync.py` — `sync_delta()` for Master/Child replication

---

## Part 10 — Appendix — Key References

| Source | Why It Matters |
|---|---|
| **Generative Agents (Stanford, Park et al. 2023)** | The gold standard for living character memory. Observation + Reflection + Planning proven essential. Retrieval scoring formula. |
| **Mem0 (2025)** | Production evidence: memory formation beats summarization; 80–90% token reduction possible |
| **LangMem / LangGraph** | Conceptual model for confidence-threshold extraction and subconscious memory formation |
| **MemGPT / Letta** | OS-paradigm memory management — context window as RAM, external storage as disk |
| **PersonaMem-v2 (2025)** | Implicit personalization — characters learn preferences from natural conversation, not just explicit statements |
| **LokiDoki Memory Architecture Spec** | Our internal foundation — solid topology, extraction pipeline, and prompt compilation rules already in place |

---

*Last updated: April 2026 | Document owner: LokiDoki Core Team*
