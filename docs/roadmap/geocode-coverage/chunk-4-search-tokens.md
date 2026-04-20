# Chunk 4 — Search tokenizer hardening + OA/OSM dedup

## Goal

After this chunk, the search tokenizer drops US state abbreviations
and common English address-stopwords from the FTS query before
matching, and OA-derived rows that point at the same parcel as an OSM
row are deduped at merge time. The user query
*"500 Nyala Farms Road in CT"* matches the OA parcel cleanly even
though no row contains the literal token `"in"` or the literal token
`"CT"`. Duplicate hits at the same address from OA + OSM collapse to
the single best-ranked entry.

This is the chunk that makes the typed query feel "Apple-Maps-like"
rather than "raw SQL FTS5-like."

## Files

- `lokidoki/maps/geocode/fts_search.py` — extend `_tokenise()` to
  filter out:
  - US state abbreviations (`{"al","ak",...}`, full 50 + DC).
  - Common positional stopwords: `{"in","at","on","near","by","of",
    "the"}`.
  - Pure punctuation tokens (already handled, keep).
  Add a separate function `_dedup_results(results)` that merges
  rows within ~25 m of each other sharing housenumber + street; the
  highest-score entry wins, with OA-source as the tiebreaker (OA is
  parcel-accurate, OSM building centroids drift). Wire into
  `merge_results()` invocation in `search()`.
- `lokidoki/maps/geocode/__init__.py` — extend `merge_results()` to
  delegate the dedup decision to a callable, defaulting to the new
  `_dedup_results`. Or — simpler — call `_dedup_results` after
  `merge_results` in `search()`. Pick whichever keeps the function
  count lowest.
- `tests/unit/test_geocode_fts_search.py` — extend with three new
  tests:
  - `test_state_abbrev_does_not_break_match` — query
    `"main st in CT"` against the existing fixture returns the
    Hartford row.
  - `test_stopword_in_does_not_block_match` — query
    `"main st"` and `"main st in"` return identical hits.
  - `test_dedup_collapses_oa_and_osm_at_same_parcel` — synth two
    rows at coords ~10 m apart with same housenumber + street;
    assert only one survives the dedup.

Read-only:
- `lokidoki/maps/geocode/__init__.py` — `merge_results` shape +
  `haversine_km`.

## Actions

1. **Define the stopword + state set** at module top:
   ```python
   _US_STATE_ABBREV = frozenset({
       "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id",
       "il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms",
       "mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok",
       "or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv",
       "wi","wy","dc",
   })
   _ADDRESS_STOPWORDS = frozenset({
       "in","at","on","near","by","of","the",
   })
   ```
   Keep `_US_STATE_ABBREV` immutable so the test imports stay cheap.
2. **Extend `_tokenise()`.** After the cleaning step:
   ```python
   low = cleaned.lower()
   if low in _US_STATE_ABBREV or low in _ADDRESS_STOPWORDS:
       continue
   ```
   The "in" token doubles as Indiana's abbrev — we accept that
   tradeoff (an Indianapolis search still resolves through the
   "indianapolis" token, and the city is in `place=*` rows).
3. **Implement `_dedup_results`.** Group by
   `(housenumber.lower(), street.lower())`; within each group, drop
   any row within `_DEDUP_RADIUS_KM = 0.025` (~25 m) of the
   group's top-scored row. Tie-breaker prefers `place_id`
   prefixed `oa:` (OpenAddresses). Pure street-name groups (no
   housenumber) skip dedup — they're city / settlement rows and
   carry meaningfully distinct coords.
4. **Wire it.** Apply `_dedup_results` in `search()` after
   `merge_results`, before the `limit` slice. Keep the BM25 +
   proximity scoring untouched.
5. **Tests as listed.** Use `tmp_path` + the existing
   `_emit` / `osmium.SimpleWriter` fixture pattern.

## Verify

```
uv run pytest tests/unit/test_geocode_fts_search.py \
              tests/unit/test_geocode_api.py -q \
  && uv run python -c "from lokidoki.maps.geocode.fts_search import _tokenise; \
        toks = _tokenise('500 nyala farms road in CT'); \
        assert 'ct' not in toks and 'in' not in toks, toks; \
        assert 'nyala' in toks and 'farms' in toks and '500' in toks, toks; \
        print('OK tokens:', toks)"
```

## Commit message

```
feat(maps): drop state abbrevs + stopwords from FTS query, dedup OA/OSM hits

Tightens fts_search._tokenise so "500 Nyala Farms Road in CT" no
longer requires "in" and "ct" to literally appear in any indexed
row, and adds a 25m dedup pass that collapses OA parcel rows and
OSM building rows pointing at the same address into one hit (OA
wins ties — parcel-centroid accuracy over building-polygon drift).

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 4.
```

## Deferrals

(Empty.)
