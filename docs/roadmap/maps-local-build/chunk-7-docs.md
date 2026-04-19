# Chunk 7 — Documentation + supersede offline-maps chunk 8a

## Goal

Close the plan cleanly. Replace `docs/maps-dist.md` (the 8a self-host
guide, now obsolete) with `docs/maps-build.md` (the local-build
story). Update the offline-maps plan's NOTE section to reference this
plan. Mark sub-chunk 8a in the offline-maps rollup as `superseded`.

This chunk is documentation-only. Zero code changes.

## Files

- `docs/maps-dist.md` — delete.
- `docs/maps-build.md` — new. One page: "How LokiDoki Maps actually work offline." Covers data flow (Geofabrik → tippecanoe → PMTiles + valhalla_build_tiles → routing tiles + FTS5 → geocoder), per-region sizes + build times, toolchain locations, the Valhalla lazy lifecycle, what users see in the admin panel.
- `docs/roadmap/offline-maps/PLAN.md` — `NOTE` block pointing at this plan: "Install pipeline rewritten by docs/roadmap/maps-local-build/. UI from chunks 1–7 stays."
- `docs/roadmap/offline-maps/chunk-8-deferrals-rollup.md` — flip sub-chunk 8a row to `superseded — maps-local-build` with a link. Leave 8b–8g untouched (those are still open).
- `docs/roadmap/maps-local-build/PLAN.md` — flip chunk 7 row to `done` + the commit SHA as the final action of this chunk.

## Actions

1. Write `docs/maps-build.md`. Sections:
   - **What happens when you click Install** — phase-by-phase walk.
   - **Per-region sizes + build times** — reuse the PLAN.md footprint table.
   - **Where the tools live** — `data/tools/tippecanoe/`, `data/tools/valhalla/`; how the bootstrap step fetches them.
   - **Why Valhalla turns on and off** — the lazy lifecycle from chunk 6.
   - **Troubleshooting** — "Toolchain missing" (re-run bootstrap), "Out of memory" (region too big for this device), "Build stuck" (how to read tippecanoe stderr), "Cancelled install" (state cleanup).
2. `rm docs/maps-dist.md`. Verify no inbound references:
   `grep -r maps-dist.md` must return zero.
3. Edit `offline-maps/PLAN.md`'s NOTE section. Keep it short — one paragraph + link.
4. Edit `offline-maps/chunk-8-deferrals-rollup.md`:
   - Sub-chunk 8a row → `| 8a | Chunk-6 deferral — install artifact host + dist override | superseded | [maps-local-build](../maps-local-build/PLAN.md) |`.
   - Append a short `## Superseded by` block inside the 8a section explaining why (one paragraph).
5. Flip this plan's chunk 7 row to `done` + SHA.

## Verify

```bash
test ! -f docs/maps-dist.md
test -f docs/maps-build.md
grep -r "maps-dist.md" docs/ lokidoki/ frontend/ && exit 1 || echo "clean"
grep -q "maps-local-build" docs/roadmap/offline-maps/PLAN.md
grep -q "superseded" docs/roadmap/offline-maps/chunk-8-deferrals-rollup.md
```

All five assertions must pass.

## Commit message

```
docs(maps): maps-build.md replaces maps-dist.md; 8a superseded

Writes docs/maps-build.md describing the local-build install flow
end-to-end. Deletes the sub-chunk-8a self-host guide it replaces.
Annotates the offline-maps plan's NOTE section and flips chunk 8a
in the deferrals rollup to "superseded" with a pointer here.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 7.
```

## Deferrals section (append as you discover)

*(empty — this chunk is the closure.)*
