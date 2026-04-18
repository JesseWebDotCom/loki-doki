# Roadmap — chunked plans

Detailed, independently-shippable plans for features on the
[main README roadmap](../../README.md#roadmap). Each plan is split
into chunks small enough to land on their own, with ship criteria and
size estimates per chunk so nothing is hidden behind a multi-week PR.

## Active plans

- **[Offline Maps](offline-maps/PLAN.md)** — let a user download a
  map region (state / country) and have the Maps page keep working
  without internet, with an Apple Maps–style UI on top. 7 chunks:
  PMTiles infrastructure → region-picker admin panel (independent
  street / satellite selection) → frontend tile rendering with Map /
  Satellite / Hybrid → left-rail + place-details card → offline
  FTS5 address search → Valhalla routing sidecar → Directions panel
  with alternatives + turn-by-turn. Street-only under 500 MB per
  state; satellite is 10-20× larger and opt-in per region; Valhalla
  routing tiles add ~0.5× PMTiles at state scale, ~7× at country
  scale.

## Conventions

Plans follow the **chunked-plan pattern** defined in [AGENTS.md
§Chunked Plan Pattern](../../AGENTS.md). Every non-trivial plan gets
its own directory `docs/roadmap/<slug>/` with:

- `PLAN.md` — goal, operating contract, status table, global context,
  NOTE log.
- `chunk-N-<slug>.md` — one file per chunk, each containing **Goal**,
  **Files**, **Actions**, **Verify**, **Commit message**, and
  **Deferrals**.

Each chunk runs in a fresh Claude Code session — the point is to keep
per-session context small. Small, self-contained tasks don't need a
plan at all; just do them.

When a chunk ships, flip its row in `PLAN.md` from `pending` to `done`
and paste the commit SHA. Don't delete completed chunks — the plan is
the audit trail.

## When to write a plan

A roadmap entry earns its own directory here when implementation will
span more than one focused PR, or when the design has enough branching
tradeoffs that a chat is going to forget them by next week. Quick
fixes and small features belong in commit messages or PR descriptions,
not here.
