# Chunk 14.5 — Fix Movie Routing + Session Context Flow

**Source:** Production bug report — "have you seen the movie invasion usa?" routes to direct_chat; "who's in it?" loses context.
**Prereqs:** C14 (refactor complete, pipeline phases working).

---

## Root Causes

### Bug 1: Movie queries route to direct_chat
The semantic router's example set for movie capabilities (`lookup_movie`, `search_movies`) uses only imperative phrasing ("tell me about", "look up", "what is"). Conversational phrasings ("have you seen", "who's in", "who was in") score below the ROUTE_FLOOR of 0.55.

### Bug 2: "who's in it?" loses movie context from previous turn
**Primary cause:** `chat.py` creates `session_id` (line 66) but does NOT pass it in the pipeline `context` dict (lines 91-99). So `ensure_session()` creates a brand-new memory session on every pipeline call. Session state (last_seen map) is never carried between turns.

**Secondary cause:** `lookup_movie` and `search_movies` are NOT in `MEDIA_CAPABILITIES` in `media_resolver.py`. Even if they were routed to, the media resolver wouldn't bind "it" to the recent movie.

---

## Fixes

### Fix 1: Pass session_id into pipeline context (chat.py)
Add `"session_id": session_id` to the context dict. This single-line fix enables the entire M4 session state chain: last_seen → recent_entities → media resolver → recent_context slot.

### Fix 2: Expand MEDIA_CAPABILITIES (media_resolver.py)
Add `lookup_movie` and `search_movies` to `MEDIA_CAPABILITIES` so the media resolver can bind pronouns like "it" to the most recent movie.

### Fix 3: Add conversational examples to movie capabilities (function_registry.json)
Add diverse phrasing examples:
- "have you seen [movie]", "who's in [movie]", "when did [movie] come out"
- "who stars in it", "what's that movie about", "who directed it"

### Fix 4: Write integration tests verifying both bugs are fixed
- Test that session_id flows through and last_seen persists between turns
- Test that movie queries with conversational phrasing route to movie capabilities
- Test that pronoun "it" resolves to the movie from the previous turn

---

## Gate Checklist
- [ ] "have you seen the movie inception" routes to lookup_movie (not direct_chat)
- [ ] Session state persists between pipeline calls with same session_id
- [ ] "who's in it?" after a movie discussion resolves the movie from context
- [ ] All existing tests pass (zero regressions)
