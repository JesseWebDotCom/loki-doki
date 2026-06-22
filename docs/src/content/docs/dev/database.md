---
title: Database & Schema
description: SQLite schema overview, tables, relationships, and Drizzle ORM conventions.
sidebar:
  order: 10
---

## Engine

**SQLite** via Bun's built-in `bun:sqlite` + **Drizzle ORM**. PostgreSQL supported as an optional override via `DATABASE_URL` env var.

Schema definitions live in `backend/src/db/schema/`. Migrations are managed by Drizzle.

---

## Tables by Subsystem

### Auth & Users
| Table | Purpose |
|---|---|
| `users` | User accounts (username, PIN hash, role) |
| `sessions` | HttpOnly session tokens |
| `user_preferences` | Per-user key/value preferences (JSON) |

### Chat
| Table | Purpose |
|---|---|
| `conversations` | Chat sessions (user, companion, title, created_at) |
| `messages` | Individual messages (role, content, tool calls/results) |
| `memories` | Long-term user memories (embedding, content, created_at) |

### Companions
| Table | Purpose |
|---|---|
| `characters` | Companion definitions (name, personality, avatar config, voice) |
| `character_grants` | Per-user companion access (join table) |

### Image Generation
| Table | Purpose |
|---|---|
| `imageLoras` | LoRA metadata (trigger tokens, when_to_use, category, is_adult) |
| `lora_grants` | Per-user LoRA access |
| `generated_images` | Generated image records (prompt, params, is_adult, path) |

### Voice
| Table | Purpose |
|---|---|
| `voice_settings` | App-wide and per-user voice preferences |

### Offline Library
| Table | Purpose |
|---|---|
| `zimArchives` | ZIM archive registry (path, name, category, enabled) |

### Maps
| Table | Purpose |
|---|---|
| `map_regions` | Region registry (name, bounds, pmtiles path, routing path) |

### Links
| Table | Purpose |
|---|---|
| `bookmarks` | Global + personal bookmarks (user_id null = global) |

### Home Inventory
| Table | Purpose |
|---|---|
| `inventory_items` | Devices/appliances (name, make, model, serial, location, warranty_expires) |
| `service_logs` | Maintenance/repair records per item |
| `inventory_manuals` | Cached PDF manual metadata |

### Home Control
| Table | Purpose |
|---|---|
| `ha_user_grants` | Per-user Home Assistant control grants: `(domain, area)` scopes, `*` = wildcard |

### Vision
| Table | Purpose |
|---|---|
| `analysis_results` | VLM analysis output (image path, structured JSON result) |

### Features
| Table | Purpose |
|---|---|
| `features` | Feature flag states (enabled/disabled per feature key) |
| `feature_installs` | Install status for boot components |

### Privacy
| Table | Purpose |
|---|---|
| `privacy_settings` | PIN hash, countdown duration, enabled flag |

---

## Drizzle Conventions

- Schema files: `backend/src/db/schema/*.ts`
- One file per subsystem (e.g. `chat.ts`, `imaging.ts`)
- All IDs: `text('id').$defaultFn(() => ulid())`, ULIDs, not auto-increment integers
- Timestamps: `text('created_at').$defaultFn(() => new Date().toISOString())`
- Run migrations: `bun run backend/src/db/migrate.ts`
