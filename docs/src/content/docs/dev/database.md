---
title: Database & Schema
description: SQLite schema overview, tables, relationships, and the inline migration approach.
sidebar:
  order: 10
---

## Engine

**SQLite** via Bun's built-in `bun:sqlite` + **Drizzle ORM**. PostgreSQL is supported as an optional override via the `DATABASE_URL` env var.

The database is opened in `backend/src/db/index.ts`. On a default install the file lives at `data/app.db` (relative to the repo root), with `journal_mode = WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`.

The full schema is defined in a single file, `backend/src/db/schema.ts` (one file, not a `schema/` directory). All tables are declared with `sqliteTable(...)`.

---

## Migration Approach

There are two layers, run belt-and-suspenders:

1. **`backend/src/db/schema.ts`** is the Drizzle schema (table types used by queries).
2. **`runMigrations()` in `backend/src/db/index.ts`** is the *authoritative* runtime migrator. It runs on every boot and issues idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN` statements (via an `addColumn()` helper that swallows `duplicate column name`).

The generated SQL files under `backend/src/db/migrations/` exist but are **not** the source of truth: the journal stops at `0016`, so the Drizzle migrator does not apply newer migrations on a fresh DB. Every new table, column, or index **must** be mirrored as an idempotent statement inside `runMigrations()` or it will never exist on a fresh install.

Do **not** rely on `bun run db:generate` / `drizzle-kit` to ship a change. Edit `schema.ts` and add the matching idempotent statement to `runMigrations()`.

---

## Tables by Subsystem

The schema declares ~50 tables. Grouped by area:

### Auth & users
| Table | Purpose |
|---|---|
| `users` | User accounts (username, role) |
| `sessions` | Session tokens (SHA-256 `token_hash`, `expires_at`) |
| `profile_pins` | Argon2id PIN hashes per profile |
| `user_preferences` | Per-user key/value preferences (nav, home layout, highlights, etc.) |
| `app_settings` | App-wide key/value settings (selected models, installed-component ledger, pepper) |

### Chat, memory & projects
| Table | Purpose |
|---|---|
| `conversations` | Chat sessions |
| `messages` | Individual messages (role, content, tool calls/results) |
| `projects` | Project grouping for conversations |
| `entities` | Extracted entities for memory |
| `memories` | Long-term memories (embeddings) |
| `memory_episodes` | Episodic memory records |

### Companions & voice
| Table | Purpose |
|---|---|
| `characters` | Companion definitions (personality, avatar config, voice, category) |
| `character_user_grants` | Per-user companion access |
| `user_characters` | Active/owned companion state per user |
| `voice_samples` | Recorded voice samples (cloning / F5) |
| `wake_word_catalog` | Trained wake-word models |

### Tools & permissions
| Table | Purpose |
|---|---|
| `tool_global_config` | Admin-level tool enablement/config |
| `tool_user_config` | Per-user tool config |
| `tool_user_permissions` | Per-user tool grants |
| `ha_user_grants` | Per-user Home Assistant control scopes |

### Image generation
| Table | Purpose |
|---|---|
| `generated_images` | Generated image records (prompt, params, `is_adult`, path) |
| `image_lora_categories` | LoRA category taxonomy |
| `image_loras` | LoRA metadata (trigger tokens, `when_to_use`, `is_adult`) |
| `image_lora_user_category_grants` | Per-user category access |
| `image_lora_user_lora_grants` | Per-user LoRA access |
| `analysis_results` | VLM vision-analysis output (structured JSON) |

### Music
| Table | Purpose |
|---|---|
| `music_tracks` | Generated/stored music tracks |

### Offline library, maps & bookmarks
| Table | Purpose |
|---|---|
| `zim_archives` | ZIM archive registry (path, category, enabled) |
| `map_regions` | Map region registry (bounds, pmtiles/routing paths) |
| `maps_saved_pins` | User-saved map pins |
| `maps_poi_enrichments` | Enriched POI metadata |
| `bookmarks` | Global (admin) + personal bookmarks (`user_id` null = global) |

### Home inventory
| Table | Purpose |
|---|---|
| `home_devices` | Tracked devices/appliances (make, model, serial, location, warranty) |
| `home_service_log` | Service/maintenance records |
| `home_device_files` | Cached manuals/files per device |
| `home_device_links` | Links per device |

### YouTube & podcasts
| Table | Purpose |
|---|---|
| `yt_subscriptions` | Channel subscriptions |
| `yt_videos` | Cached video metadata |
| `yt_channel_cache` | Channel metadata cache |
| `yt_downloads` | Downloaded video records |
| `yt_watch_state` | Per-user watch progress |
| `yt_collections` | DB-backed video collections |
| `podcast_shows` | Podcast show definitions |
| `podcast_episodes` | Generated/imported episodes |
| `podcast_episode_sources` | Source links per episode (reverse-link to YouTube) |
| `podcast_suggestions` | Suggested episode topics |
| `podcast_watch_state` | Per-user listen progress |

### System
| Table | Purpose |
|---|---|
| `download_jobs` | Durable background download/install queue (see [Boot & Feature System](../boot-features/)) |
| `notifications` | User/admin notifications (`user_id` null = admin-targeted) |

---

## Conventions

- Schema lives in a single file: `backend/src/db/schema.ts`.
- All tables are `sqliteTable(...)`; the Drizzle dialect is `bun-sqlite`.
- Many key/value needs are served by `app_settings` (app-wide) and `user_preferences` (per-user) rather than dedicated tables.
- Add a new table or column by editing `schema.ts` **and** mirroring it as an idempotent statement in `runMigrations()`.
