# Chunk 11 — Skills Phase 3: Finish V1 Ports

**Source:** `docs/v2-skills-design.md` Phase 3.
**Prereqs:** C07 (Skills Runtime Wiring).

---

## Goal

Close the feature holes where v1 had meaningful functionality and v2 has none or partial.

---

## Work Items

1. Break provider-specific implementations into standalone packages (jokes, weather, movies, web search, smart-home).
2. Reintroduce `search_web` as a first-class v2 capability using the DDG adapter.
3. Restore relationship/family-query surface (`lookup_relationship`, `list_family`) backed by real people DB.
4. Restore movie detail/search (`lookup_movie`, `search_movies`) — TMDB preferred, Wiki fallback.
5. Expand TV surface with episode-oriented features.
6. Decide: `weather_owm` retired permanently or added as alternate provider?

---

## Gate Checklist

- [ ] Every meaningful v1 surface ported, replaced, or explicitly retired
- [ ] No v1 skill in "mystery missing" state
- [ ] Multi-provider domains have separate standalone skills
