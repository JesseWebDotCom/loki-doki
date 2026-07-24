import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import * as schema from './schema'

export const dbPath = process.env.DATABASE_URL ?? resolve(import.meta.dir, '../../../data/app.db')
mkdirSync(dirname(dbPath), { recursive: true })

// Staged restore swap. Admin → Storage → Backups verifies a snapshot and copies it to
// `<db>.restore-pending`, then restarts the server; the actual swap happens here, before
// the Database is opened, so no live connection ever sees it. The replaced database is
// kept alongside as `<db>.pre-restore` (with its WAL, under matching sidecar names) so a
// bad restore is recoverable by hand. Any failure mid-swap rolls back to the old file.
const restorePendingPath = `${dbPath}.restore-pending`
if (existsSync(restorePendingPath)) {
  const keepPath = `${dbPath}.pre-restore`
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(keepPath + suffix)) rmSync(keepPath + suffix)
      if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, keepPath + suffix)
    }
    renameSync(restorePendingPath, dbPath)
    console.warn('[backup] restored database snapshot; previous database kept at', keepPath)
  } catch (err) {
    console.warn('[backup] restore swap failed, keeping the current database:', err instanceof Error ? err.message : err)
    try {
      if (!existsSync(dbPath) && existsSync(keepPath)) {
        for (const suffix of ['', '-wal', '-shm']) {
          if (existsSync(keepPath + suffix)) renameSync(keepPath + suffix, dbPath + suffix)
        }
      }
      rmSync(restorePendingPath, { force: true })
    } catch { /* boot continues with whatever state is on disk */ }
  }
}

export const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
// WAL's recommended durability: fsync at checkpoints, not on every commit. Removes a per-write
// fsync (multi-row write loops were paying one fsync'd commit per row); WAL still recovers on
// crash — only a power loss in the sub-second window before a checkpoint can lose the last txns.
sqlite.exec('PRAGMA synchronous = NORMAL;')
// Wait up to 5s for a lock instead of failing instantly with SQLITE_BUSY (WAL still
// serializes writers, and our boot migrations + request handlers can contend).
sqlite.exec('PRAGMA busy_timeout = 5000;')

export const db = drizzle(sqlite, { schema })

/** Flatten an Error and its `cause` chain into one searchable string. */
function errorChainText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 6; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      cur = (cur as { cause?: unknown }).cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(' | ')
}

function addColumn(table: string, column: string, definition: string) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch (err) {
    // The common (expected) case is the column already existing from a prior boot or
    // from the migrator. Only that is safe to ignore. Anything else (e.g. a typo in the
    // definition, a missing table) is a real bug we must surface, but it must NOT crash
    // boot, so we log and continue rather than rethrow.
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('duplicate column name')) {
      console.warn('[migrations] addColumn failed:', `${table}.${column}`, err)
    }
  }
}

// NOTE: This inline runMigrations() block is the AUTHORITATIVE source of truth for schema
// creation. The generated files under ./migrations are NOT all registered in the journal
// (the journal stops at 0016), so the Drizzle migrator does not apply newer migrations and
// also rolls back its whole batch if any single statement fails on a fresh DB. Therefore
// every new schema change (new table, new column, new index) MUST be mirrored here as an
// idempotent CREATE / addColumn, or it will silently never exist on a fresh install.
// Do not rely on the migrations/ dir; do not delete it either (kept for history).
export function runMigrations() {
  // A failed migration (e.g. column already exists from belt-and-suspenders
  // running in a prior hot-reload session) must NOT crash the server — the DB
  // is readable, and the belt-and-suspenders below will patch any gaps.
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, './migrations') })
  } catch (err) {
    // The migrator re-runs migrations whose tables/columns the belt-and-suspenders
    // CREATEs below already made — "already exists" is EXPECTED on every boot of an
    // existing DB and is not a problem. Only surface genuinely unexpected failures.
    //
    // The bun-sqlite migrator wraps the real SQLite error: err.message is just
    // "Failed to run the query '<sql>'", and the actual reason ("table X already
    // exists") lives in err.cause. Walk the whole cause chain so the benign case is
    // recognised and doesn't spam a scary warning on every boot.
    const msg = errorChainText(err)
    if (!/already exists|duplicate column/i.test(msg)) {
      console.warn('[db] migration warning (non-fatal):', msg)
    }
  }

  // ── One-time rename: Reader → Bookmarks (in-place, data preserved) ──────────────
  // The read-it-later "Reader" library was renamed to "Bookmarks". Rename its tables in
  // place (so existing saved items survive), dropping the dead legacy Organizr `bookmarks`
  // table first to free the name, and discarding the old FTS5 mirror (rebuilt under the new
  // name by the belt-and-suspenders block + backfill below). Guarded + idempotent: each step
  // only runs when the old name still exists and the new one does not. MUST run before the
  // CREATE TABLE IF NOT EXISTS block, or an empty `bookmarks` would shadow the real data.
  try {
    const tableExists = (name: string) =>
      sqlite.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) != null
    const hasColumn = (table: string, col: string) => {
      try {
        return (sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col)
      } catch { return false }
    }
    // Legacy Organizr bookmarks table is identifiable by its `label` column; the new library has none.
    if (tableExists('bookmarks') && hasColumn('bookmarks', 'label')) {
      // Preserve any not-yet-folded legacy bookmarks as Live links before dropping (data-safe;
      // prior boots already folded most via the now-removed standalone migration).
      if (tableExists('reader_items')) {
        sqlite.exec(`
          INSERT INTO reader_items
            (id, owner_id, source, type, url, title, favicon_url, category,
             use_proxy, use_embed, sort_order, status, archive_state,
             word_count, reading_mins, is_adult, created_at, updated_at)
          SELECT b.id, b.owner_id, 'bookmark', 'live', b.url, b.label, b.icon, b.category,
             b.use_proxy, b.use_embed, b.sort_order, 'unread', 'none',
             0, 0, 0, b.created_at, b.updated_at
          FROM bookmarks b
          WHERE NOT EXISTS (SELECT 1 FROM reader_items r WHERE r.id = b.id);
        `)
      }
      sqlite.exec(`DROP TABLE IF EXISTS bookmarks;`)
      console.warn('[migrations] folded + dropped dead legacy Organizr bookmarks table')
    }
    // Drop the old FTS mirror + triggers first so the table renames don't have to rewrite them.
    if (tableExists('reader_items_fts')) {
      sqlite.exec(`
        DROP TRIGGER IF EXISTS reader_items_ai;
        DROP TRIGGER IF EXISTS reader_items_ad;
        DROP TRIGGER IF EXISTS reader_items_au;
        DROP TABLE IF EXISTS reader_items_fts;
      `)
    }
    if (tableExists('reader_collections') && !tableExists('bookmark_collections')) {
      sqlite.exec(`ALTER TABLE reader_collections RENAME TO bookmark_collections;`)
    }
    if (tableExists('reader_tags') && !tableExists('bookmark_tags')) {
      sqlite.exec(`ALTER TABLE reader_tags RENAME TO bookmark_tags;`)
    }
    if (tableExists('reader_items') && !tableExists('bookmarks')) {
      sqlite.exec(`
        ALTER TABLE reader_items RENAME TO bookmarks;
        DROP INDEX IF EXISTS reader_items_owner_status_idx;
        DROP INDEX IF EXISTS reader_items_source_ref_idx;
        CREATE INDEX IF NOT EXISTS bookmarks_owner_status_idx ON bookmarks(owner_id, status);
        CREATE INDEX IF NOT EXISTS bookmarks_source_ref_idx ON bookmarks(source, source_ref);
      `)
      console.warn('[migrations] renamed reader_items → bookmarks')
    }
    if (tableExists('reader_item_tags') && !tableExists('bookmark_item_tags')) {
      sqlite.exec(`ALTER TABLE reader_item_tags RENAME TO bookmark_item_tags;`)
    }
    // Migrate stored identifiers that referenced the old "links" app id.
    sqlite.exec(`UPDATE app_settings SET key='app_feature.bookmarks' WHERE key='app_feature.links' AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key='app_feature.bookmarks');`)
    sqlite.exec(`UPDATE user_preferences SET value=replace(value,'"links"','"bookmarks"') WHERE key IN ('nav.pinned_apps','nav.recent_apps') AND value LIKE '%"links"%';`)
    // Move the on-disk archive directory to match BOOKMARK_ARCHIVE_ROOT (relative paths stay valid).
    const dataDir = dirname(dbPath)
    const oldArchive = join(dataDir, 'bookmark-archive')
    const newArchive = join(dataDir, 'bookmark-archive')
    if (existsSync(oldArchive) && !existsSync(newArchive)) {
      renameSync(oldArchive, newArchive)
      console.warn('[migrations] moved bookmark-archive → bookmark-archive')
    }
  } catch (err) {
    console.warn('[migrations] reader→bookmarks rename failed:', err instanceof Error ? err.message : err)
  }

  // Belt-and-suspenders: ensure tables exist even if the Drizzle migration runner
  // skips them. The migrator runs ALL migrations in a single transaction, so one
  // bad/ordered-wrong statement anywhere rolls the whole thing back and NOTHING is
  // created on a fresh DB. These idempotent CREATEs (matching the current schema)
  // are the real source of truth for a fresh install.

  // Core tables (mirror of migration 0000 plus later column additions).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT NOT NULL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      birthdate TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      avatar_url TEXT,
      dicebear_style TEXT,
      dicebear_seed TEXT,
      dicebear_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions(token_hash);
    CREATE TABLE IF NOT EXISTS profile_pins (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS profile_pins_user_id_unique ON profile_pins(user_id);
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      personality_prompt TEXT NOT NULL,
      backstory TEXT,
      voice_id TEXT,
      avatar_ref TEXT,
      renderer TEXT NOT NULL DEFAULT 'dicebear',
      style TEXT,
      seed TEXT,
      avatar_config TEXT,
      phonetic_name TEXT,
      reply_style TEXT NOT NULL DEFAULT 'balanced',
      tts_voice TEXT,
      wake_word_model_id TEXT,
      wake_word_phrase TEXT,
      speech_rate REAL,
      expressiveness REAL,
      content_dials TEXT,
      category TEXT,
      created_by TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      published INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS characters_slug_unique ON characters(slug);
    CREATE TABLE IF NOT EXISTS character_user_grants (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'on',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS character_user_grants_unique ON character_user_grants(user_id, character_id);
    CREATE TABLE IF NOT EXISTS voice_samples (
      id TEXT NOT NULL PRIMARY KEY,
      character_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      duration_seconds INTEGER,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_characters (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      nickname TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_characters_user_id_character_id_unique ON user_characters(user_id, character_id);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      character_id TEXT,
      project_id TEXT,
      title TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      memory_processed_through INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT,
      character_id TEXT,
      entity_id TEXT,
      text TEXT NOT NULL,
      source_text TEXT,
      category TEXT NOT NULL DEFAULT 'fact',
      tier TEXT NOT NULL DEFAULT 'episodic',
      status TEXT NOT NULL DEFAULT 'active',
      embedding TEXT,
      importance INTEGER NOT NULL DEFAULT 5,
      pinned INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      character_id TEXT,
      conversation_id TEXT,
      summary TEXT NOT NULL,
      embedding TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_preferences_user_id_key_unique ON user_preferences(user_id, key);
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT NOT NULL PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_key_unique ON app_settings(key);

    CREATE TABLE IF NOT EXISTS download_jobs (
      id TEXT NOT NULL PRIMARY KEY,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      variant_key TEXT,
      domain TEXT NOT NULL,
      size_class TEXT NOT NULL,
      label TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 4,
      next_eligible_at INTEGER,
      last_error TEXT,
      progress TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // Memory v2: entities + new columns on memories/conversations
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT,
      character_id TEXT,
      name TEXT NOT NULL,
      kind TEXT DEFAULT 'person' NOT NULL,
      aliases TEXT DEFAULT '[]' NOT NULL,
      importance INTEGER DEFAULT 5 NOT NULL,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    )
  `)
  addColumn('memories', 'entity_id', 'TEXT')
  addColumn('memories', 'tier', `TEXT DEFAULT 'episodic' NOT NULL`)
  addColumn('memories', 'status', `TEXT DEFAULT 'active' NOT NULL`)
  addColumn('memories', 'last_used_at', 'INTEGER')
  addColumn('conversations', 'memory_processed_through', 'INTEGER')
  addColumn('messages', 'sources', 'TEXT')  // JSON citation sources, so chips survive reload (#8)

  // Projects
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      description TEXT,
      instructions TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  addColumn('conversations', 'project_id', 'TEXT')

  // File conversions
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      input_name TEXT NOT NULL,
      output_name TEXT NOT NULL,
      input_format TEXT NOT NULL,
      output_format TEXT NOT NULL,
      family TEXT NOT NULL,
      engine TEXT NOT NULL,
      rel_path TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      input_bytes INTEGER,
      output_bytes INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_conversions_user_id ON conversions(user_id);
  `)

  // Device-to-device drops (ephemeral; files at data/drops/<id>, swept by TTL)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS file_drops (
      id TEXT NOT NULL PRIMARY KEY,
      sender_user_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      sender_label TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_device_id TEXT,
      kind TEXT NOT NULL,
      file_name TEXT,
      mime TEXT,
      size_bytes INTEGER,
      rel_path TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_file_drops_target ON file_drops(target_user_id, status);
  `)

  // Image generation + LoRA system
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS generated_images (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      seed INTEGER,
      width INTEGER NOT NULL DEFAULT 1024,
      height INTEGER NOT NULL DEFAULT 1024,
      steps INTEGER NOT NULL DEFAULT 20,
      guidance REAL NOT NULL DEFAULT 3.5,
      model_id TEXT,
      state TEXT NOT NULL DEFAULT 'building',
      failure_reason TEXT,
      path TEXT,
      step_current INTEGER,
      lora_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS image_lora_categories (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS image_lora_categories_name ON image_lora_categories(name);
    CREATE TABLE IF NOT EXISTS image_loras (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category_id TEXT,
      source_url TEXT,
      author TEXT,
      base_families TEXT NOT NULL DEFAULT '["flux"]',
      sha256 TEXT,
      size_bytes INTEGER,
      file_path TEXT NOT NULL,
      trigger_tokens TEXT NOT NULL DEFAULT '[]',
      default_weight REAL NOT NULL DEFAULT 1.0,
      min_weight REAL NOT NULL DEFAULT 0.0,
      max_weight REAL NOT NULL DEFAULT 2.0,
      enabled INTEGER NOT NULL DEFAULT 1,
      thumbnail_url TEXT,
      style_label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (category_id) REFERENCES image_lora_categories(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS image_lora_user_category_grants (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'on',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES image_lora_categories(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS image_lora_user_category_grants_unique
      ON image_lora_user_category_grants(user_id, category_id);
    CREATE TABLE IF NOT EXISTS image_lora_user_lora_grants (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      lora_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'on',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (lora_id) REFERENCES image_loras(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS image_lora_user_lora_grants_unique
      ON image_lora_user_lora_grants(user_id, lora_id);
  `)

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tool_global_config (
      id TEXT NOT NULL PRIMARY KEY,
      tool_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tool_global_config_unique
      ON tool_global_config(tool_id, key);
    CREATE TABLE IF NOT EXISTS tool_user_config (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tool_user_config_unique
      ON tool_user_config(user_id, tool_id, key);
    CREATE TABLE IF NOT EXISTS tool_user_permissions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tool_user_permissions_unique
      ON tool_user_permissions(user_id, tool_id);
    CREATE TABLE IF NOT EXISTS ha_user_grants (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      area_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ha_user_grants_unique
      ON ha_user_grants(user_id, domain, area_id);
  `)

  // One-time: security entities (locks + entry covers) moved to an explicit-only
  // 'security' pseudo-domain grant — wildcards no longer cover them. Copy existing
  // lock grants to security grants so nobody silently loses door access. Flag-guarded
  // so an admin who later revokes a security grant doesn't have it resurrected.
  try {
    const done = sqlite.query(`SELECT 1 FROM app_settings WHERE key='migr.ha_security_grants'`).get()
    if (!done) {
      sqlite.exec(`
        INSERT OR IGNORE INTO ha_user_grants (id, user_id, domain, area_id, created_at)
          SELECT lower(hex(randomblob(16))), user_id, 'security', area_id, created_at
          FROM ha_user_grants WHERE domain = 'lock';
      `)
      sqlite.exec(`INSERT OR IGNORE INTO app_settings (id, key, value, updated_at) VALUES (lower(hex(randomblob(16))), 'migr.ha_security_grants', '"done"', ${Date.now()});`)
      console.warn('[migrations] copied HA lock grants → security grants')
    }
  } catch (err) {
    console.warn('[migrations] ha security grant migration failed:', err instanceof Error ? err.message : err)
  }

  // One-time: vision model swapped to Google's QAT checkpoint (gemma3:4b → gemma3:4b-it-qat).
  // Same footprint, near-bf16 quality. Only rewrite the setting when it still holds the exact
  // old tag, so an admin who deliberately picked a different vision model is left untouched.
  // Values in app_settings are JSON-encoded, hence the quoted match/replacement.
  try {
    const done = sqlite.query(`SELECT 1 FROM app_settings WHERE key='migr.vision_gemma3_qat'`).get()
    if (!done) {
      sqlite.exec(`UPDATE app_settings SET value='"gemma3:4b-it-qat"', updated_at=${Date.now()} WHERE key='vision_model' AND value='"gemma3:4b"';`)
      sqlite.exec(`INSERT OR IGNORE INTO app_settings (id, key, value, updated_at) VALUES (lower(hex(randomblob(16))), 'migr.vision_gemma3_qat', '"done"', ${Date.now()});`)
      console.warn('[migrations] migrated vision model gemma3:4b → gemma3:4b-it-qat (QAT)')
    }
  } catch (err) {
    console.warn('[migrations] vision QAT migration failed:', err instanceof Error ? err.message : err)
  }

  // Music Studio: source-fetch state (added after the table shipped — belt-and-suspenders).
  addColumn('music_studio_tracks', 'source_status', "TEXT NOT NULL DEFAULT 'ready'")
  addColumn('music_studio_tracks', 'source_error', 'TEXT')
  addColumn('music_studio_tracks', 'cover_rel_path', 'TEXT')
  // Karaoke reuse: the source videoId (dedup stem separation) + origin tag (hide karaoke
  // tracks from the Studio library list).
  addColumn('music_studio_tracks', 'source_video_id', 'TEXT')
  addColumn('music_studio_tracks', 'origin', "TEXT NOT NULL DEFAULT 'studio'")
  addColumn('music_studio_tracks', 'last_used_at', 'INTEGER')
  // Lyric forced-alignment: re-times LRCLIB lines to this track's actual vocals stem.
  addColumn('music_studio_tracks', 'lyrics_align_status', "TEXT NOT NULL DEFAULT 'none'")
  addColumn('music_studio_tracks', 'lyrics_json', 'TEXT')
  addColumn('music_studio_tracks', 'lyrics_align_error', 'TEXT')

  // LoRA routing columns (from migration 0005 — belt-and-suspenders for DBs created via inline SQL)
  addColumn('music_stations', 'category', 'TEXT')
  addColumn('music_stations', 'loading_messages', 'TEXT')
  addColumn('music_stations', 'source_ref', 'TEXT')
  // Legacy movie/show stations stashed their origin tag in `description` (hidden from the
  // UI). Move it to the dedicated column so `description` is free for real text.
  try {
    sqlite.exec(`UPDATE music_stations SET source_ref = description, description = NULL WHERE source_ref IS NULL AND description LIKE 'source:%'`)
    // Retire em/en dashes from existing auto-built station titles (e.g. "Title — Original Score")
    // and descriptions ("… Tenet — its themes …" → comma).
    sqlite.exec(`UPDATE music_stations SET name = REPLACE(REPLACE(REPLACE(name, ' — ', ' - '), ' – ', ' - '), ' ― ', ' - ') WHERE source_ref IS NOT NULL AND (name LIKE '% — %' OR name LIKE '% – %' OR name LIKE '% ― %')`)
    sqlite.exec(`UPDATE music_stations SET description = REPLACE(REPLACE(REPLACE(description, ' — ', ', '), ' – ', ', '), ' ― ', ', ') WHERE source_ref IS NOT NULL AND description IS NOT NULL AND (description LIKE '% — %' OR description LIKE '% – %' OR description LIKE '% ― %')`)
  } catch { /* table may not exist yet on a brand-new DB */ }
  // Same dash cleanup for auto-built podcast shows ("Title — Deep Dive", "… — Episode by Episode").
  try {
    sqlite.exec(`UPDATE podcast_shows SET name = REPLACE(REPLACE(REPLACE(name, ' — ', ' - '), ' – ', ' - '), ' ― ', ' - ') WHERE (source IN ('app', 'suggested') OR source_ref IS NOT NULL) AND (name LIKE '% — %' OR name LIKE '% – %' OR name LIKE '% ― %')`)
    sqlite.exec(`UPDATE podcast_shows SET description = REPLACE(REPLACE(REPLACE(description, ' — ', ', '), ' – ', ', '), ' ― ', ', ') WHERE (source IN ('app', 'suggested') OR source_ref IS NOT NULL) AND description IS NOT NULL AND (description LIKE '% — %' OR description LIKE '% – %' OR description LIKE '% ― %')`)
  } catch { /* table may not exist yet on a brand-new DB */ }
  addColumn('image_loras', 'civitai_id', 'TEXT')
  addColumn('image_loras', 'when_to_use', 'TEXT')
  addColumn('image_loras', 'example_requests', `TEXT NOT NULL DEFAULT '[]'`)
  addColumn('image_loras', 'is_stylistic_lora', 'INTEGER NOT NULL DEFAULT 0')
  // From migration 0007 — the one image-table ALTER with no inline fallback. The
  // migrator rolls back the whole batch on a fresh DB (0005/0007 ALTER tables no
  // migration creates), so this column must be (re)added here or it's missing.
  addColumn('generated_images', 'pipeline', `TEXT NOT NULL DEFAULT 'txt2img'`)

  // ZIM archives
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS zim_archives (
      id TEXT NOT NULL PRIMARY KEY,
      source_id TEXT NOT NULL,
      variant_key TEXT NOT NULL DEFAULT 'default',
      kiwix_book_name TEXT,
      file_path TEXT,
      file_size_bytes INTEGER,
      zim_date TEXT,
      downloaded_at INTEGER,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS zim_archives_source_id ON zim_archives(source_id);
  `)
  addColumn('zim_archives', 'verified_at', 'INTEGER')  // corrupt-check timestamp (existing DBs)

  // Voice subsystem (migration 0009 — belt-and-suspenders for DBs created via inline SQL)
  addColumn('characters', 'tts_voice', 'TEXT')
  addColumn('characters', 'wake_word_model_id', 'TEXT')
  addColumn('characters', 'speech_rate', 'REAL')
  addColumn('characters', 'expressiveness', 'REAL')  // prosody swing 0–1; null = default
  // Content-policy: per-character content config (dials + candor) as JSON
  addColumn('characters', 'content_dials', 'TEXT')
  // Companion Store category key (e.g. 'everyday', 'mature'); null = uncategorized
  addColumn('characters', 'category', 'TEXT')

  // DiceBear user avatars (migration 0010)
  addColumn('users', 'dicebear_style', 'TEXT')
  addColumn('users', 'dicebear_seed', 'TEXT')
  addColumn('users', 'dicebear_config', 'TEXT')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wake_word_catalog (
      id TEXT NOT NULL PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'trained',
      asset_path TEXT,
      default_threshold REAL,
      character_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
  `)
  // Held-out validation accuracy captured at train time (quality signal shown in the UI).
  addColumn('wake_word_catalog', 'accuracy', 'REAL')

  // Maps subsystem (migration 0015 — belt-and-suspenders for DBs created via inline SQL)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS map_regions (
      id TEXT NOT NULL PRIMARY KEY,
      region_id TEXT NOT NULL,
      street INTEGER NOT NULL DEFAULT 1,
      install_status TEXT NOT NULL DEFAULT 'pending',
      phase TEXT,
      street_installed INTEGER NOT NULL DEFAULT 0,
      valhalla_installed INTEGER NOT NULL DEFAULT 0,
      pbf_installed INTEGER NOT NULL DEFAULT 0,
      geocoder_installed INTEGER NOT NULL DEFAULT 0,
      openaddresses_installed INTEGER NOT NULL DEFAULT 0,
      geocoder_schema_version INTEGER NOT NULL DEFAULT 2,
      bytes_on_disk TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      installed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS map_regions_region_id ON map_regions(region_id);
  `)
  // dem_installed / landcover_installed added after the initial maps migration
  // (hillshade DEM + satellite landcover raster artifacts).
  addColumn('map_regions', 'dem_installed', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('map_regions', 'landcover_installed', 'INTEGER NOT NULL DEFAULT 0')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS maps_saved_pins (
      pin_id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT,
      label TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      color TEXT NOT NULL,
      place_ref_json TEXT,
      notes TEXT,
      collection_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maps_poi_enrichments (
      place_id TEXT NOT NULL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      subtitle TEXT NOT NULL DEFAULT '',
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      phone TEXT,
      website TEXT,
      menu_url TEXT,
      last_attempt_at TEXT NOT NULL,
      last_success_at TEXT,
      menu_attempt_at TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // Owner scoping for saved pins (IDOR fix, existing DBs). Pins predating this column
  // keep a null user_id and become invisible/unowned, which is acceptable.
  addColumn('maps_saved_pins', 'user_id', 'TEXT')

  // Vision analysis (migration 0016)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS analysis_results (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      path TEXT,
      result TEXT,
      model TEXT NOT NULL,
      tasks TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'building',
      error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  // Music app — saved tracks (client-rendered MIDI in v1; future-proofed for
  // server-side neural engines + stem separation, see schema.ts musicTracks).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS music_tracks (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'track',
      engine TEXT NOT NULL DEFAULT 'midi-offline',
      style_id TEXT,
      bpm INTEGER,
      key_name TEXT,
      source_name TEXT,
      prompt TEXT,
      meta_json TEXT,
      duration_sec REAL,
      state TEXT NOT NULL DEFAULT 'ready',
      failure_reason TEXT,
      step_current INTEGER,
      parent_track_id TEXT,
      path TEXT,
      is_adult INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_tracks_user_id ON music_tracks(user_id);
    CREATE INDEX IF NOT EXISTS idx_music_tracks_parent ON music_tracks(parent_track_id);

    CREATE TABLE IF NOT EXISTS music_studio_tracks (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      source_rel_path TEXT,
      duration_sec REAL,
      source_status TEXT NOT NULL DEFAULT 'ready',
      source_error TEXT,
      cover_rel_path TEXT,
      stem_status TEXT NOT NULL DEFAULT 'none',
      stem_model TEXT,
      stems_json TEXT,
      stem_error TEXT,
      analysis_status TEXT NOT NULL DEFAULT 'none',
      bpm REAL,
      key_label TEXT,
      beats_json TEXT,
      chords_json TEXT,
      analysis_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_studio_user ON music_studio_tracks(user_id);

    CREATE TABLE IF NOT EXISTS music_studio_tutorials (
      id TEXT NOT NULL PRIMARY KEY,
      track_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      thumbnail_url TEXT,
      duration_sec INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (track_id) REFERENCES music_studio_tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS music_studio_tutorials_track_video_idx ON music_studio_tutorials(track_id, video_id);

    CREATE TABLE IF NOT EXISTS music_studio_tabs (
      id TEXT NOT NULL PRIMARY KEY,
      track_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      instrument TEXT,
      source_rel_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      tab_error TEXT,
      align_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (track_id) REFERENCES music_studio_tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_studio_tabs_track ON music_studio_tabs(track_id);

    CREATE TABLE IF NOT EXISTS music_resolve (
      key TEXT NOT NULL PRIMARY KEY,
      video_id TEXT,
      title TEXT,
      artist TEXT,
      duration_sec INTEGER,
      score REAL,
      resolved_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_stations (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      ai_prompt TEXT NOT NULL DEFAULT '',
      seed_type TEXT NOT NULL DEFAULT 'prompt',
      seed_value TEXT,
      icon_path TEXT,
      banner_path TEXT,
      accent TEXT,
      dj_mode TEXT NOT NULL DEFAULT 'full',
      visibility TEXT NOT NULL DEFAULT 'private',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_adult INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      category TEXT,
      loading_messages TEXT,
      source_ref TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_stations_user ON music_stations(user_id);

    CREATE TABLE IF NOT EXISTS music_playlists (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cover_path TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_playlists_user ON music_playlists(user_id);

    CREATE TABLE IF NOT EXISTS music_playlist_tracks (
      id TEXT NOT NULL PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      mbid TEXT,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration_sec INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (playlist_id) REFERENCES music_playlists(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_pl_tracks_playlist ON music_playlist_tracks(playlist_id);

    CREATE TABLE IF NOT EXISTS music_favorites (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      title TEXT,
      artist TEXT,
      mbid TEXT,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_music_fav_user_kind_ref ON music_favorites(user_id, kind, ref_id);

    CREATE TABLE IF NOT EXISTS music_history (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      mbid TEXT,
      title TEXT NOT NULL,
      artist TEXT,
      station_id TEXT,
      position_sec REAL NOT NULL DEFAULT 0,
      played_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_history_user ON music_history(user_id, played_at);

    CREATE TABLE IF NOT EXISTS music_offline_stations (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      name TEXT NOT NULL,
      accent TEXT,
      dj_mode TEXT NOT NULL DEFAULT 'full',
      icon_path TEXT,
      banner_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      track_total INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_music_offline_stations_user_station ON music_offline_stations(user_id, station_id);

    CREATE TABLE IF NOT EXISTS music_offline_station_tracks (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_offline_tracks_station ON music_offline_station_tracks(user_id, station_id, position);

    CREATE TABLE IF NOT EXISTS music_dj_cache (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      position TEXT NOT NULL,
      from_video_id TEXT,
      to_video_id TEXT,
      text TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_dj_cache_station ON music_dj_cache(user_id, station_id);

    -- Live internet radio: saved real-world stations (the user's radio library) and
    -- timed recordings captured from live streams via the download-jobs queue.
    CREATE TABLE IF NOT EXISTS music_radio_stations (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      station_uuid TEXT,
      name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      homepage TEXT,
      favicon TEXT,
      tags TEXT,
      country TEXT,
      language TEXT,
      codec TEXT,
      bitrate INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_music_radio_stations_user_url ON music_radio_stations(user_id, stream_url);

    CREATE TABLE IF NOT EXISTS music_radio_recordings (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      station_id TEXT,
      station_name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      codec TEXT,
      title TEXT NOT NULL,
      requested_sec INTEGER NOT NULL,
      duration_sec REAL,
      rel_path TEXT,
      size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS music_radio_recordings_user_idx ON music_radio_recordings(user_id);

    CREATE TABLE IF NOT EXISTS music_local_folders (
      id TEXT NOT NULL PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'admin',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at INTEGER,
      last_scan_status TEXT NOT NULL DEFAULT 'idle',
      last_scan_error TEXT,
      track_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_local_tracks (
      id TEXT NOT NULL PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES music_local_folders(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT,
      album_artist TEXT,
      album TEXT,
      track_no INTEGER,
      disc_no INTEGER,
      year INTEGER,
      genre TEXT,
      duration_sec REAL,
      codec TEXT,
      container TEXT,
      bitrate INTEGER,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      browser_playable INTEGER NOT NULL DEFAULT 1,
      has_embedded_art INTEGER NOT NULL DEFAULT 0,
      folder_art_path TEXT,
      mbid TEXT,
      mb_album_id TEXT,
      mb_artist_id TEXT,
      advisory INTEGER,
      norm_title TEXT NOT NULL,
      norm_artist TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS music_local_tracks_norm_idx ON music_local_tracks(norm_artist, norm_title);
    CREATE INDEX IF NOT EXISTS music_local_tracks_mbid_idx ON music_local_tracks(mbid);
    CREATE INDEX IF NOT EXISTS music_local_tracks_album_idx ON music_local_tracks(album_artist, album);

    CREATE TABLE IF NOT EXISTS music_plex_tracks (
      rating_key TEXT NOT NULL PRIMARY KEY,
      machine_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      album_rating_key TEXT,
      artist_rating_key TEXT,
      track_no INTEGER,
      disc_no INTEGER,
      year INTEGER,
      duration_sec REAL,
      codec TEXT,
      container TEXT,
      bitrate INTEGER,
      part_key TEXT,
      thumb TEXT,
      parent_thumb TEXT,
      grandparent_thumb TEXT,
      mbid TEXT,
      norm_title TEXT NOT NULL,
      norm_artist TEXT NOT NULL,
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS music_plex_tracks_norm_idx ON music_plex_tracks(norm_artist, norm_title);
    CREATE INDEX IF NOT EXISTS music_plex_tracks_mbid_idx ON music_plex_tracks(mbid);
    CREATE INDEX IF NOT EXISTS music_plex_tracks_album_idx ON music_plex_tracks(artist, album);

    CREATE TABLE IF NOT EXISTS music_track_audio (
      ref TEXT NOT NULL PRIMARY KEY,
      lufs REAL,
      true_peak_db REAL,
      codec TEXT,
      bitrate_kbps INTEGER,
      sample_rate INTEGER,
      channels INTEGER,
      duration_sec REAL,
      peaks BLOB,
      scanned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_track_features (
      ref TEXT NOT NULL PRIMARY KEY,
      source TEXT,
      title TEXT,
      artist TEXT,
      duration_sec REAL,
      bpm REAL,
      key_label TEXT,
      energy REAL,
      valence REAL,
      danceability REAL,
      aggressiveness REAL,
      acousticness REAL,
      tags_json TEXT,
      embedding BLOB,
      model_version TEXT,
      status TEXT NOT NULL,
      error TEXT,
      analyzed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_ratings (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      title TEXT,
      artist TEXT,
      stars INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_music_ratings_user_ref ON music_ratings(user_id, ref);

    CREATE TABLE IF NOT EXISTS music_moments (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      at_sec INTEGER NOT NULL,
      emoji TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_track_advisory (
      ref TEXT NOT NULL PRIMARY KEY,
      explicit INTEGER,
      source TEXT NOT NULL,
      title TEXT,
      artist TEXT,
      checked_at INTEGER NOT NULL
    );

    -- Kid-safe media: cached topical-classification verdict per media item (videos +
    -- podcast episodes), keyed by (source, item_id). categories_json is a JSON
    -- Record<DialKey, level>. See lib/media/classify.ts.
    CREATE TABLE IF NOT EXISTS media_classification (
      source TEXT NOT NULL,
      item_id TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source, item_id)
    );
  `)

  // Per-profile music protections ({explicit, unknown, lyrics, maskTitles} JSON; null =
  // defaults derived from the profile's profanity dial).
  addColumn('content_profiles', 'music_json', 'TEXT')
  // Kid-safe media: per-profile video ({adult,unknown,restrictedMode}) and podcast
  // ({explicit,unknown}) protections (null = derived from dials), plus the master toggle.
  addColumn('content_profiles', 'video_json', 'TEXT')
  addColumn('content_profiles', 'podcast_json', 'TEXT')
  addColumn('content_profiles', 'kid_safe_media', 'INTEGER NOT NULL DEFAULT 0')
  // Parental-advisory columns on podcasts (null=unknown, 0=clean, 1=explicit).
  addColumn('podcast_shows', 'explicit', 'INTEGER')
  addColumn('podcast_episodes', 'explicit', 'INTEGER')

  // Offline music: media type a station was downloaded as (audio | video | both).
  addColumn('music_offline_stations', 'media', "TEXT NOT NULL DEFAULT 'audio'")
  // Station "cover song" ({videoId,title,artist} of the last built queue's lead track) —
  // resolves to real album art on station cards.
  addColumn('music_stations', 'cover_track_json', 'TEXT')
  // History fidelity for stats/rails/Replay: track length (position_sec already records how
  // far the listener got - the progress beacon keeps it fresh on skip/end/unload).
  addColumn('music_history', 'duration_sec', 'REAL')
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_music_history_user_played ON music_history(user_id, played_at);`)
  // Playlist kinds: manual (default) | magic (AI vibe recipe in rules_json) | smart
  // (rules re-evaluated on read, no persisted track rows).
  addColumn('music_playlists', 'kind', "TEXT NOT NULL DEFAULT 'manual'")
  addColumn('music_playlists', 'rules_json', 'TEXT')
  addColumn('music_playlists', 'generated_at', 'INTEGER')

  // Content-addressable blob store + media assets (app-wide dedup of offlined media).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT NOT NULL PRIMARY KEY,
      rel_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime TEXT,
      status TEXT NOT NULL DEFAULT 'staging',
      last_accessed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT NOT NULL PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'youtube',
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      format TEXT NOT NULL,
      height INTEGER,
      blob_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      size_bytes INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_assets_src_idx ON media_assets(source_type, source_id, kind, format);
    CREATE INDEX IF NOT EXISTS media_assets_blob_idx ON media_assets(blob_hash);
  `)
  // yt_downloads becomes the per-user REFERENCE into media_assets (shared bytes).
  addColumn('yt_downloads', 'asset_id', 'TEXT')

  // Home inventory subsystem v2 — extra columns + links table
  addColumn('home_devices', 'description', 'TEXT')
  addColumn('home_devices', 'owner', 'TEXT')
  addColumn('home_devices', 'specs', 'TEXT')
  addColumn('home_devices', 'manufactured_date', 'TEXT')
  addColumn('home_devices', 'main_photo_id', 'TEXT')
  addColumn('home_device_files', 'source', "TEXT NOT NULL DEFAULT 'user'")
  addColumn('home_device_files', 'comment', 'TEXT')
  addColumn('home_devices', 'raw_label_text', 'TEXT')

  // Back-fill homeDeviceFiles for devices that have photo_path but no image file entry.
  // Wrapped: the home_* tables are created later in this function, so on a fresh/empty DB
  // they do not exist yet and there is nothing to back-fill. Must never abort boot.
  try { sqlite.exec(`
    INSERT OR IGNORE INTO home_device_files (id, device_id, label, file_path, file_type, source, size_bytes, uploaded_by, created_at)
    SELECT
      lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || '4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
      hd.id,
      'Device photo',
      hd.photo_path,
      'image',
      'user',
      0,
      hd.added_by,
      hd.created_at
    FROM home_devices hd
    WHERE hd.photo_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM home_device_files hdf
        WHERE hdf.device_id = hd.id AND hdf.file_type = 'image'
      )
  `) } catch { /* fresh DB: home_* tables not created yet, nothing to back-fill */ }

  // Back-fill main_photo_id for devices that have photo_path but no main_photo_id set
  try { sqlite.exec(`
    UPDATE home_devices
    SET main_photo_id = (
      SELECT id FROM home_device_files
      WHERE device_id = home_devices.id AND file_type = 'image'
      ORDER BY created_at ASC LIMIT 1
    )
    WHERE photo_path IS NOT NULL AND main_photo_id IS NULL
  `) } catch { /* fresh DB: home_* tables not created yet, nothing to back-fill */ }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS home_device_links (
      id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES home_devices(id) ON DELETE CASCADE
    );
  `)

  // Home inventory subsystem v1
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS home_devices (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      location TEXT,
      photo_path TEXT,
      purchase_date TEXT,
      purchase_price REAL,
      purchase_store TEXT,
      warranty_expires TEXT,
      warranty_notes TEXT,
      support_url TEXT,
      support_phone TEXT,
      manual_path TEXT,
      manual_url TEXT,
      manual_fetched_at INTEGER,
      manual_text TEXT,
      notes TEXT,
      lookup_status TEXT NOT NULL DEFAULT 'pending',
      lookup_queued_at INTEGER,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS home_service_log (
      id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL,
      technician TEXT,
      cost REAL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES home_devices(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS home_device_files (
      id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      label TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT 'other',
      size_bytes INTEGER,
      uploaded_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES home_devices(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  // Adult content privacy (migration 0017)
  addColumn('image_loras', 'is_adult', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('generated_images', 'is_adult', 'INTEGER NOT NULL DEFAULT 0')

  // Notifications (migration 0017)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS notifications_read_at_idx ON notifications(read_at);
  `)

  // YouTube client (migration 0018)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS yt_subscriptions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'channel',
      external_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      handle TEXT,
      thumbnail_url TEXT,
      description TEXT,
      last_fetched_at INTEGER,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS yt_sub_user_ext_idx ON yt_subscriptions(user_id, external_id);
    CREATE TABLE IF NOT EXISTS yt_videos (
      id TEXT NOT NULL PRIMARY KEY,
      video_id TEXT NOT NULL UNIQUE,
      subscription_id TEXT REFERENCES yt_subscriptions(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      channel_id TEXT,
      thumbnail_url TEXT,
      published_at INTEGER,
      duration_sec INTEGER,
      description TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS yt_videos_sub_idx ON yt_videos(subscription_id);
    CREATE INDEX IF NOT EXISTS yt_videos_pub_idx ON yt_videos(published_at);
    CREATE TABLE IF NOT EXISTS yt_downloads (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'audio',
      rel_path TEXT,
      transcript_rel_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      size_bytes INTEGER,
      max_height INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS yt_dl_user_idx ON yt_downloads(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS yt_dl_user_vid_kind_idx ON yt_downloads(user_id, video_id, kind);
    CREATE TABLE IF NOT EXISTS yt_watch_state (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL,
      position_sec REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS yt_watch_user_vid_idx ON yt_watch_state(user_id, video_id);
    CREATE TABLE IF NOT EXISTS yt_collections (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      collection TEXT NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      author TEXT,
      channel_id TEXT,
      duration_sec INTEGER,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS yt_collections_user_col_vid_idx ON yt_collections(user_id, collection, video_id);

    CREATE TABLE IF NOT EXISTS yt_playlists (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_yt_playlists_user ON yt_playlists(user_id);

    CREATE TABLE IF NOT EXISTS yt_playlist_videos (
      id TEXT NOT NULL PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      channel_id TEXT,
      duration_sec INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (playlist_id) REFERENCES yt_playlists(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_yt_pl_videos_playlist ON yt_playlist_videos(playlist_id);

    CREATE TABLE IF NOT EXISTS yt_playlist_download_batches (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      playlist_id TEXT REFERENCES yt_playlists(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      max_height INTEGER,
      video_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_yt_pl_dl_batches_user ON yt_playlist_download_batches(user_id);
  `)
  // Channel-page cache (meta + first page of videos) — instant loads + stale-on-failure
  // so a transient InnerTube error never leaves a channel showing zero videos.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS yt_channel_cache (
      channel_id TEXT NOT NULL PRIMARY KEY,
      meta_json TEXT,
      videos_json TEXT NOT NULL DEFAULT '[]',
      continuation TEXT,
      fetched_at INTEGER NOT NULL
    );
  `)
  // Read-through artwork cache (thumbnails/avatars/banners). Bytes on disk under
  // data/yt-image-cache/<url_hash>; rows track freshness + subscribed-ness for the
  // 24h evict (non-subscribed) / re-validate (subscribed) maintenance pass.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS yt_image_cache (
      url_hash TEXT NOT NULL PRIMARY KEY,
      url TEXT NOT NULL,
      file_path TEXT,
      content_type TEXT,
      etag TEXT,
      last_modified TEXT,
      subscribed INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER,
      fetched_at INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS yt_image_cache_sub_idx ON yt_image_cache(subscribed);
  `)
  // Resolution the video was saved at (for the offline quality badge) — existing DBs.
  addColumn('yt_downloads', 'max_height', 'INTEGER')
  // Channel/playlist "about" text, resolved via yt-dlp — existing DBs.
  addColumn('yt_subscriptions', 'description', 'TEXT')
  // Subscription auto-save automation (off by default) + rolling keep-N override.
  addColumn('yt_subscriptions', 'auto_save', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('yt_subscriptions', 'auto_save_kind', `TEXT NOT NULL DEFAULT 'video'`)
  addColumn('yt_subscriptions', 'auto_save_keep', 'INTEGER')
  addColumn('yt_subscriptions', 'remove_watched', 'INTEGER NOT NULL DEFAULT 0')
  // Per-subscription "auto-transcribe new uploads" pref (Whisper fallback, captions first).
  addColumn('yt_subscriptions', 'auto_transcribe', 'INTEGER NOT NULL DEFAULT 0')
  // Thumbnail snapshot for non-YouTube collection rows (yt cards derive theirs from videoId).
  addColumn('yt_collections', 'thumbnail_url', 'TEXT')
  // Last full back-catalog reconcile (closes the RSS 15-item-window data-loss gap).
  addColumn('yt_subscriptions', 'last_reconciled_at', 'INTEGER')
  // Marks downloads written by auto-save (only these are eligible for keep-N pruning).
  addColumn('yt_downloads', 'auto', 'INTEGER NOT NULL DEFAULT 0')
  // Marks transient music prefetch-cache refs (download-ahead for gapless play; rolling keep-N).
  addColumn('yt_downloads', 'prefetch', 'INTEGER NOT NULL DEFAULT 0')
  // Which app saved the ref ('youtube'|'music'); the YouTube Saved tab filters out music saves.
  // Without this column the /downloads query (ne(origin,'music')) renders bad SQL and 500s.
  addColumn('yt_downloads', 'origin', "TEXT NOT NULL DEFAULT 'youtube'")
  // Channel avatar URL resolved + warmed at save time so Offline cards show real logos
  // (not just a letter) even for non-subscribed channels — existing DBs.
  addColumn('yt_videos', 'channel_thumb', 'TEXT')

  // Linked YouTube account (TV-client OAuth device flow) + provenance columns so account
  // sync can own its mirrored rows without clobbering hand-added ones.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS yt_accounts (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      channel_title TEXT,
      channel_handle TEXT,
      channel_avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sync_subscriptions INTEGER NOT NULL DEFAULT 1,
      sync_watch_later INTEGER NOT NULL DEFAULT 1,
      sync_liked INTEGER NOT NULL DEFAULT 1,
      push_enabled INTEGER NOT NULL DEFAULT 1,
      last_sync_at INTEGER,
      last_sync_error TEXT,
      connected_at INTEGER NOT NULL
    );
  `)
  addColumn('yt_subscriptions', 'source', "TEXT NOT NULL DEFAULT 'local'")
  addColumn('yt_collections', 'source', "TEXT NOT NULL DEFAULT 'local'")

  // Podcast shows, episodes, suggestions, playback state (migration 0019)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS podcast_shows (
      id TEXT NOT NULL PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      cover_rel_path TEXT,
      style TEXT NOT NULL DEFAULT 'recap',
      schedule_json TEXT,
      segments_json TEXT NOT NULL DEFAULT '[]',
      hosts_json TEXT NOT NULL DEFAULT '[]',
      stinger_json TEXT,
      cast_json TEXT,
      visibility TEXT NOT NULL DEFAULT 'personal',
      source TEXT NOT NULL DEFAULT 'user',
      source_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id TEXT NOT NULL PRIMARY KEY,
      show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      audio_rel_path TEXT,
      duration_sec INTEGER,
      chapters_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      generated_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS podcast_suggestions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      template_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      style TEXT NOT NULL DEFAULT 'recap',
      segments_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_suggestion_user_key ON podcast_suggestions(user_id, template_key);
    CREATE TABLE IF NOT EXISTS podcast_watch_state (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      position_sec REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_watch_state_unique ON podcast_watch_state(user_id, episode_id);
  `)
  // script_json was added to podcast_episodes after the table's initial inline CREATE above;
  // back-fill it for existing DBs (the generate pipeline writes the rendered script here).
  addColumn('podcast_episodes', 'script_json', 'TEXT')
  // LLM-written per-episode "show notes"; added after the table's initial inline CREATE.
  addColumn('podcast_episodes', 'description', 'TEXT')
  addColumn('podcast_shows', 'source_ref', 'TEXT')
  // Internal per-show cast/personas + evolving life beats (added after initial CREATE).
  addColumn('podcast_shows', 'cast_json', 'TEXT')
  // Auto-generate an episode when the source subscription gets a new video (off by default).
  addColumn('podcast_shows', 'auto_generate', 'INTEGER NOT NULL DEFAULT 0')
  // Target episode length in minutes (null = use style default: ~7–12 min depending on style).
  addColumn('podcast_shows', 'target_minutes', 'INTEGER')
  // segments_json was added to podcast_suggestions after its initial inline CREATE; back-fill
  // for DBs created before this column existed (the suggestions route reads/writes it).
  addColumn('podcast_suggestions', 'segments_json', `TEXT NOT NULL DEFAULT '[]'`)

  // Real podcast subscriptions (source='rss'): feed identity + conditional-GET state on the
  // show, RSS enclosure/publish metadata on episodes.
  addColumn('podcast_shows', 'feed_url', 'TEXT')
  addColumn('podcast_shows', 'artwork_url', 'TEXT')
  addColumn('podcast_shows', 'author', 'TEXT')
  addColumn('podcast_shows', 'link', 'TEXT')
  addColumn('podcast_shows', 'categories_json', 'TEXT')
  addColumn('podcast_shows', 'feed_etag', 'TEXT')
  addColumn('podcast_shows', 'feed_last_modified', 'TEXT')
  addColumn('podcast_shows', 'feed_fetched_at', 'INTEGER')
  addColumn('podcast_shows', 'feed_error', 'TEXT')
  addColumn('podcast_episodes', 'guid', 'TEXT')
  addColumn('podcast_episodes', 'enclosure_url', 'TEXT')
  addColumn('podcast_episodes', 'enclosure_type', 'TEXT')
  addColumn('podcast_episodes', 'enclosure_bytes', 'INTEGER')
  addColumn('podcast_episodes', 'image_url', 'TEXT')
  addColumn('podcast_episodes', 'link', 'TEXT')
  addColumn('podcast_episodes', 'published_at', 'INTEGER')
  addColumn('podcast_episodes', 'asset_id', 'TEXT')
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS podcast_shows_feed_idx ON podcast_shows(feed_url);
    CREATE INDEX IF NOT EXISTS podcast_episodes_guid_idx ON podcast_episodes(show_id, guid);

    -- Per-user membership in an RSS show; the show row itself is shared household-wide.
    CREATE TABLE IF NOT EXISTS podcast_subscriptions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
      auto_download INTEGER NOT NULL DEFAULT 0,
      auto_download_keep INTEGER,
      notify INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_subscriptions_user_show ON podcast_subscriptions(user_id, show_id);
    CREATE INDEX IF NOT EXISTS podcast_subscriptions_show_idx ON podcast_subscriptions(show_id);

    -- Per-user offline refs over the shared blob store (ytDownloads pattern); gcSweep pins on these.
    CREATE TABLE IF NOT EXISTS podcast_downloads (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      auto INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_downloads_user_ep ON podcast_downloads(user_id, episode_id);
    CREATE INDEX IF NOT EXISTS podcast_downloads_asset_idx ON podcast_downloads(asset_id);
  `)

  // Episode source links — which YouTube videos fed each episode (reverse "featured in podcasts").
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS podcast_episode_sources (
      id TEXT NOT NULL PRIMARY KEY,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL DEFAULT 'youtube',
      source_id TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS podcast_ep_sources_ep_idx ON podcast_episode_sources(episode_id);
    CREATE INDEX IF NOT EXISTS podcast_ep_sources_src_idx ON podcast_episode_sources(source_type, source_id);
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_ep_sources_unique ON podcast_episode_sources(episode_id, source_type, source_id);
    -- Hot-path lookups: episodes by show (every episode list), shows by owner (shows list).
    CREATE INDEX IF NOT EXISTS podcast_episodes_show_idx ON podcast_episodes(show_id);
    CREATE INDEX IF NOT EXISTS podcast_shows_owner_idx ON podcast_shows(owner_user_id);
  `)

  // Podcast player pack: Podcasting 2.0 chapters cache columns + per-show playback
  // settings, server-persisted Up Next queue, bookmarks, and saved episode filters.
  addColumn('podcast_episodes', 'chapters_url', 'TEXT')
  addColumn('podcast_episodes', 'chapters_fetched_at', 'INTEGER')
  // The parental-advisory addColumns earlier in this function run BEFORE the podcast
  // tables' CREATEs, so on a fresh DB they no-op and the columns end up missing (any
  // select of episode.explicit then fails). Re-run them here, after the CREATEs.
  addColumn('podcast_shows', 'explicit', 'INTEGER')
  addColumn('podcast_episodes', 'explicit', 'INTEGER')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS podcast_show_settings (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
      speed REAL,
      skip_intro_sec INTEGER NOT NULL DEFAULT 0,
      skip_outro_sec INTEGER NOT NULL DEFAULT 0,
      trim_silence INTEGER,
      voice_boost INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_show_settings_user_show ON podcast_show_settings(user_id, show_id);

    CREATE TABLE IF NOT EXISTS podcast_queue (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_queue_user_ep ON podcast_queue(user_id, episode_id);
    CREATE INDEX IF NOT EXISTS podcast_queue_user_pos_idx ON podcast_queue(user_id, position);

    CREATE TABLE IF NOT EXISTS podcast_bookmarks (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      position_sec REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS podcast_bookmarks_user_idx ON podcast_bookmarks(user_id);
    CREATE INDEX IF NOT EXISTS podcast_bookmarks_episode_idx ON podcast_bookmarks(episode_id);

    CREATE TABLE IF NOT EXISTS podcast_episode_filters (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rules_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS podcast_episode_filters_user_idx ON podcast_episode_filters(user_id);
  `)

  // NOTE: the legacy Organizr-style bookmarks CREATE that used to live here was removed.
  // The unified Bookmarks library (formerly Reader) is now created in the belt-and-suspenders
  // block below (search for "CREATE TABLE IF NOT EXISTS bookmarks"). Keeping the old schema
  // here would win the race on a fresh install and create a table with the wrong columns.

  // Time / Clock app: world-clock locations, alarms, timer presets (migration 0020)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS clock_locations (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      timezone TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clock_locations_user_id ON clock_locations(user_id);
    CREATE TABLE IF NOT EXISTS clock_alarms (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'Alarm',
      hour INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      repeat_days TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      tone TEXT NOT NULL DEFAULT 'builtin:radar',
      tone_name TEXT,
      announce INTEGER NOT NULL DEFAULT 1,
      snooze_minutes INTEGER NOT NULL DEFAULT 9,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clock_alarms_user_id ON clock_alarms(user_id);
    CREATE TABLE IF NOT EXISTS clock_timers (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'Timer',
      duration_sec INTEGER NOT NULL,
      tone TEXT NOT NULL DEFAULT 'builtin:beacon',
      tone_name TEXT,
      announce INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clock_timers_user_id ON clock_timers(user_id);
    CREATE TABLE IF NOT EXISTS clock_timer_runs (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'Timer',
      tone TEXT NOT NULL DEFAULT 'builtin:beacon',
      tone_name TEXT,
      announce INTEGER NOT NULL DEFAULT 1,
      duration_sec INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      remaining_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clock_timer_runs_user_id ON clock_timer_runs(user_id);
  `)

  // Feeds (RSS reader) + Bookmarks (read-it-later library). Created in FK-dependency order.
  // The journal stops before these, so this inline block is the authoritative schema.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS feed_folders (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feeds (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'rss',
      url TEXT,
      query TEXT,
      title TEXT NOT NULL DEFAULT '',
      favicon_url TEXT,
      site_url TEXT,
      folder_id TEXT REFERENCES feed_folders(id) ON DELETE SET NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      notify INTEGER NOT NULL DEFAULT 0,
      etag TEXT,
      last_modified TEXT,
      last_fetched_at INTEGER,
      last_error TEXT,
      poll_interval_sec INTEGER,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_unique ON feeds(user_id, url);
    CREATE INDEX IF NOT EXISTS feeds_user_idx ON feeds(user_id);
    CREATE INDEX IF NOT EXISTS feeds_system_idx ON feeds(is_system);
    CREATE TABLE IF NOT EXISTS feed_items (
      id TEXT NOT NULL PRIMARY KEY,
      feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT,
      url TEXT,
      author TEXT,
      summary TEXT,
      content_html TEXT,
      image_url TEXT,
      published_at INTEGER,
      fetched_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feed_items_feed_guid_unique ON feed_items(feed_id, guid);
    CREATE INDEX IF NOT EXISTS feed_items_feed_pub_idx ON feed_items(feed_id, published_at);
    CREATE INDEX IF NOT EXISTS feed_items_pub_idx ON feed_items(published_at);
    CREATE TABLE IF NOT EXISTS feed_item_state (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
      read INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feed_item_state_unique ON feed_item_state(user_id, item_id);
    CREATE INDEX IF NOT EXISTS feed_item_state_saved_idx ON feed_item_state(user_id, saved);
    CREATE INDEX IF NOT EXISTS feed_item_state_read_idx ON feed_item_state(user_id, read);
    CREATE TABLE IF NOT EXISTS feed_interests (
      user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      interests_text TEXT,
      likes_json TEXT NOT NULL DEFAULT '[]',
      hides_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feed_item_scores (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      score REAL,
      reason TEXT,
      scored_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feed_item_scores_unique ON feed_item_scores(user_id, item_id);

    CREATE TABLE IF NOT EXISTS bookmark_collections (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmark_tags (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'bookmark',
      source_ref TEXT,
      type TEXT NOT NULL DEFAULT 'live',
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      byline TEXT,
      site_name TEXT,
      favicon_url TEXT,
      excerpt TEXT,
      content_html TEXT,
      content_text TEXT,
      word_count INTEGER NOT NULL DEFAULT 0,
      reading_mins INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unread',
      archive_state TEXT NOT NULL DEFAULT 'none',
      archive_error TEXT,
      read_at INTEGER,
      use_proxy INTEGER NOT NULL DEFAULT 0,
      use_embed INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'Other',
      collection_id TEXT REFERENCES bookmark_collections(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      auto_update INTEGER NOT NULL DEFAULT 0,
      auto_update_interval_mins INTEGER,
      alert_on_change INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      last_checked_at INTEGER,
      content_changed_at INTEGER,
      screenshot_path TEXT,
      snapshot_path TEXT,
      og_image_path TEXT,
      is_adult INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookmarks_owner_status_idx ON bookmarks(owner_id, status);
    CREATE INDEX IF NOT EXISTS bookmarks_source_ref_idx ON bookmarks(source, source_ref);
    CREATE TABLE IF NOT EXISTS bookmark_item_tags (
      item_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES bookmark_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS bookmark_snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      captured_at INTEGER NOT NULL,
      title TEXT,
      content_html TEXT,
      content_text TEXT,
      word_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      changed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS bookmark_snapshots_bookmark_idx ON bookmark_snapshots(bookmark_id, captured_at);

    -- FTS5 over bookmarks (external-content), kept in sync by triggers. url is indexed
    -- so domain searches (e.g. amazon) match a saved link by its address, not just title.
    CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
      title, excerpt, content_text, url,
      content='bookmarks', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
      INSERT INTO bookmarks_fts(rowid, title, excerpt, content_text, url)
        VALUES (new.rowid, new.title, new.excerpt, new.content_text, new.url);
    END;
    CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
      INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, excerpt, content_text, url)
        VALUES ('delete', old.rowid, old.title, old.excerpt, old.content_text, old.url);
    END;
    CREATE TRIGGER IF NOT EXISTS bookmarks_au AFTER UPDATE ON bookmarks BEGIN
      INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, excerpt, content_text, url)
        VALUES ('delete', old.rowid, old.title, old.excerpt, old.content_text, old.url);
      INSERT INTO bookmarks_fts(rowid, title, excerpt, content_text, url)
        VALUES (new.rowid, new.title, new.excerpt, new.content_text, new.url);
    END;
  `)

  // Backfill bookmarks_fts from existing rows. The belt-and-suspenders CREATE above makes the
  // FTS mirror but its triggers only fire on FUTURE writes — so after a fresh create OR the
  // Reader→Bookmarks rename (which dropped the old mirror), existing rows are unindexed until we
  // 'rebuild'. Guarded/idempotent: only runs when the mirror is empty but the table has rows.
  try {
    const ftsCount = (sqlite.query(`SELECT count(*) AS c FROM bookmarks_fts`).get() as { c: number }).c
    const rowCount = (sqlite.query(`SELECT count(*) AS c FROM bookmarks`).get() as { c: number }).c
    if (ftsCount === 0 && rowCount > 0) {
      sqlite.exec(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild');`)
      console.warn(`[migrations] backfilled bookmarks_fts (${rowCount} rows)`)
    }
  } catch (err) {
    console.warn('[migrations] bookmarks_fts backfill failed:', err instanceof Error ? err.message : err)
  }

  // icon/color added to bookmark_collections after its initial inline CREATE; back-fill for
  // existing DBs so the collection editor (name/icon/color) can read/write them.
  addColumn('bookmark_collections', 'icon', 'TEXT')
  addColumn('bookmark_collections', 'color', 'TEXT')

  // Auto-update / change-monitoring columns added to bookmarks after its initial inline
  // CREATE; back-fill for existing DBs (see lib/bookmarks/autoUpdate.ts + archive.ts).
  addColumn('bookmarks', 'auto_update', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('bookmarks', 'auto_update_interval_mins', 'INTEGER')
  addColumn('bookmarks', 'alert_on_change', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('bookmarks', 'content_hash', 'TEXT')
  addColumn('bookmarks', 'last_checked_at', 'INTEGER')
  addColumn('bookmarks', 'content_changed_at', 'INTEGER')

  // Archiver-depth columns (PDF / page-media / archive.org fallback) added after the initial
  // CREATE; back-fill for existing DBs (see lib/bookmarks/archive.ts + render.ts).
  addColumn('bookmarks', 'pdf_path', 'TEXT')
  addColumn('bookmarks', 'media_path', 'TEXT')
  addColumn('bookmarks', 'capture_media', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('bookmarks', 'archive_org_url', 'TEXT')

  // Watch conditions (scoped change monitoring — lib/bookmarks/watch.ts).
  addColumn('bookmarks', 'watch_selector', 'TEXT')
  addColumn('bookmarks', 'watch_mode', `TEXT NOT NULL DEFAULT 'any_change'`)
  addColumn('bookmarks', 'watch_keyword', 'TEXT')
  addColumn('bookmarks', 'watch_threshold', 'REAL')
  addColumn('bookmarks', 'last_watch_value', 'TEXT')
  addColumn('bookmark_snapshots', 'watch_value', 'TEXT')

  // Bookmark content chunks for semantic search (schema.ts bookmarkChunks).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bookmark_chunks (
      id TEXT NOT NULL PRIMARY KEY,
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookmark_chunks_bookmark_idx ON bookmark_chunks(bookmark_id);
  `)

  // Bookmark highlights & notes (schema.ts bookmarkHighlights).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bookmark_highlights (
      id TEXT NOT NULL PRIMARY KEY,
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'highlight',
      quote TEXT NOT NULL DEFAULT '',
      prefix TEXT NOT NULL DEFAULT '',
      suffix TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'yellow',
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookmark_highlights_bookmark_idx ON bookmark_highlights(bookmark_id, user_id);
  `)

  // ── Linkwarden-parity columns (nesting, sharing, RSS, pinned, uploads) ──────────
  // Nested sub-collections + public sharing + RSS auto-ingest on collections.
  addColumn('bookmark_collections', 'parent_id', 'TEXT')
  addColumn('bookmark_collections', 'is_public', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('bookmark_collections', 'public_slug', 'TEXT')
  addColumn('bookmark_collections', 'rss_url', 'TEXT')
  addColumn('bookmark_collections', 'rss_auto_tag', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('bookmark_collections', 'rss_last_fetch', 'INTEGER')
  // Pinned + uploaded-file (pdf/image) bookmarks.
  addColumn('bookmarks', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('bookmarks', 'content_kind', `TEXT NOT NULL DEFAULT 'link'`)
  addColumn('bookmarks', 'upload_path', 'TEXT')

  // Collection collaborators (schema.ts bookmarkCollectionMembers).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bookmark_collection_members (
      id TEXT NOT NULL PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES bookmark_collections(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookmark_collection_members_idx ON bookmark_collection_members(collection_id, user_id);
    CREATE INDEX IF NOT EXISTS bookmark_collection_members_user_idx ON bookmark_collection_members(user_id);
  `)

  // Multi-voice narration (schema.ts narrationSessions/narrationSpeakers/narrationTurns).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS narration_sessions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'paste',
      source_ref TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'detecting',
      detection_method TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS narration_sessions_user_idx ON narration_sessions(user_id);
    CREATE TABLE IF NOT EXISTS narration_speakers (
      id TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES narration_sessions(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      normalized_key TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      speech_rate REAL NOT NULL DEFAULT 1.0,
      order_index INTEGER NOT NULL DEFAULT 0,
      is_narrator INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, normalized_key)
    );
    CREATE INDEX IF NOT EXISTS narration_speakers_session_idx ON narration_speakers(session_id);
    CREATE TABLE IF NOT EXISTS narration_turns (
      id TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES narration_sessions(id) ON DELETE CASCADE,
      speaker_id TEXT NOT NULL REFERENCES narration_speakers(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS narration_turns_session_idx ON narration_turns(session_id, turn_index);
  `)

  // Books (schema.ts books/bookChapters/bookLibrary/bookProgress).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT NOT NULL PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      narrator TEXT,
      series_name TEXT,
      series_index REAL,
      description TEXT,
      language TEXT,
      cover_url TEXT,
      published_year INTEGER,
      content_type TEXT NOT NULL DEFAULT 'book',
      isbn TEXT,
      source_type TEXT NOT NULL DEFAULT 'upload',
      source_ref TEXT,
      metadata_json TEXT,
      added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS books_source_ref_unique ON books(source_type, source_ref);
    CREATE TABLE IF NOT EXISTS book_chapters (
      id TEXT NOT NULL PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      epub_href TEXT,
      audio_start_sec REAL,
      audio_end_sec REAL,
      word_count INTEGER,
      external_audio_url TEXT,
      external_audio_duration_sec REAL
    );
    CREATE INDEX IF NOT EXISTS book_chapters_book_idx ON book_chapters(book_id, idx);
    CREATE TABLE IF NOT EXISTS book_library (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ready',
      added_at INTEGER NOT NULL,
      UNIQUE(user_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS book_progress (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'reading',
      epub_cfi TEXT,
      percent REAL NOT NULL DEFAULT 0,
      audio_position_sec REAL,
      audio_chapter_idx INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS media_progress (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      position_sec REAL NOT NULL DEFAULT 0,
      duration_sec REAL,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, asset_type, asset_id)
    );
    CREATE TABLE IF NOT EXISTS video_moments (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      at_sec INTEGER NOT NULL,
      emoji TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS video_moments_video ON video_moments(source, video_id);
    CREATE TABLE IF NOT EXISTS video_votes (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      playlist_id TEXT NOT NULL,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, playlist_id, source, video_id)
    );
    CREATE TABLE IF NOT EXISTS media_segments (
      id TEXT NOT NULL PRIMARY KEY,
      source TEXT NOT NULL,
      media_id TEXT NOT NULL,
      type TEXT NOT NULL,
      start_sec INTEGER NOT NULL,
      end_sec INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_segments_media ON media_segments(source, media_id);
    CREATE TABLE IF NOT EXISTS video_folders (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_folder_members (
      id TEXT NOT NULL PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES video_folders(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(folder_id, source, external_id)
    );
    CREATE TABLE IF NOT EXISTS video_embeddings (
      id TEXT NOT NULL PRIMARY KEY,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      segment INTEGER NOT NULL,
      start_sec INTEGER,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source, video_id, segment)
    );
    CREATE TABLE IF NOT EXISTS video_watch_time (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0,
      UNIQUE(user_id, day)
    );
    CREATE TABLE IF NOT EXISTS video_transcripts (
      id TEXT NOT NULL PRIMARY KEY,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      segments_json TEXT,
      segment_count INTEGER,
      requested_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source, video_id)
    );
    CREATE TABLE IF NOT EXISTS video_allowlist (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT,
      thumbnail_url TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, source, kind, external_id)
    );
    CREATE TABLE IF NOT EXISTS book_indexers (
      id TEXT NOT NULL PRIMARY KEY,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT,
      password TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_projects (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      source_book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
      result_book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
      title TEXT,
      prompt_json TEXT,
      style_profile_json TEXT,
      story_bible_json TEXT,
      outline_json TEXT,
      covered_summary_json TEXT,
      status TEXT NOT NULL DEFAULT 'drafting_bible',
      current_chapter_idx INTEGER NOT NULL DEFAULT 0,
      target_chapter_count INTEGER,
      target_words_per_chapter INTEGER,
      cover_image_id TEXT,
      job_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS book_projects_user_idx ON book_projects(user_id);
    CREATE TABLE IF NOT EXISTS book_project_chapters (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES book_projects(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      title TEXT,
      draft_text TEXT,
      word_count INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      is_sample INTEGER NOT NULL DEFAULT 0,
      original_chapter_id TEXT REFERENCES book_chapters(id) ON DELETE SET NULL,
      alternate_text TEXT,
      diff_status TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS book_project_chapters_project_idx ON book_project_chapters(project_id, idx);
  `)
  addColumn('book_chapters', 'external_audio_url', 'TEXT')
  addColumn('books', 'content_type', "TEXT NOT NULL DEFAULT 'book'")
  addColumn('book_chapters', 'external_audio_duration_sec', 'REAL')
  addColumn('book_progress', 'audio_chapter_idx', 'INTEGER')
  // Kid-safe request/approval gating: a 'requested' book_library row awaits admin approval.
  addColumn('book_library', 'requested_at', 'INTEGER')
  addColumn('book_library', 'approved_by_user_id', 'TEXT')
  // Reading stats.
  addColumn('book_progress', 'started_at', 'INTEGER')
  addColumn('book_progress', 'finished_at', 'INTEGER')
  addColumn('book_progress', 'elapsed_sec', 'INTEGER NOT NULL DEFAULT 0')
  // KOReader sync + smart shelves.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS book_sync_users (
      username TEXT NOT NULL PRIMARY KEY,
      key_hash TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_sync_progress (
      username TEXT NOT NULL,
      document TEXT NOT NULL,
      progress TEXT NOT NULL,
      percentage REAL NOT NULL DEFAULT 0,
      device TEXT,
      device_id TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(username, document)
    );
    CREATE TABLE IF NOT EXISTS book_shelves (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT,
      rules_json TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS book_shelves_user_idx ON book_shelves(user_id);
  `)

  // FTS5 over the shared books catalog (external-content), kept in sync by triggers.
  // Powers the global-search books provider (Cmd+K) — title/author/description of any
  // catalog title someone in the household has saved.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      title, author, description,
      content='books', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
      INSERT INTO books_fts(rowid, title, author, description)
        VALUES (new.rowid, new.title, new.author, new.description);
    END;
    CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, title, author, description)
        VALUES ('delete', old.rowid, old.title, old.author, old.description);
    END;
    CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, title, author, description)
        VALUES ('delete', old.rowid, old.title, old.author, old.description);
      INSERT INTO books_fts(rowid, title, author, description)
        VALUES (new.rowid, new.title, new.author, new.description);
    END;
  `)
  // Backfill books_fts — triggers only fire on FUTURE writes. Guarded/idempotent.
  try {
    const booksFtsCount = (sqlite.query(`SELECT count(*) AS c FROM books_fts`).get() as { c: number }).c
    const booksRowCount = (sqlite.query(`SELECT count(*) AS c FROM books`).get() as { c: number }).c
    if (booksFtsCount === 0 && booksRowCount > 0) {
      sqlite.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild');`)
      console.warn(`[migrations] backfilled books_fts (${booksRowCount} rows)`)
    }
  } catch (err) {
    console.warn('[migrations] books_fts backfill failed:', err instanceof Error ? err.message : err)
  }

  // News categories: feed_folders doubles as the News category table. Back-fill slug/locked
  // for existing DBs, and relax user_id to nullable (shared/built-in categories have userId=null).
  addColumn('feed_folders', 'slug', 'TEXT')
  addColumn('feed_folders', 'locked', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('pronunciations', 'pack_id', 'TEXT')
  // Offline DJ: switch from pre-rendered WAV to on-demand generation. Clear stale audio rows
  // (the old text/rel_path columns remain in the DB but are no longer written). New rows store
  // context only; audio is synthesised fresh at playback so pronunciation/voice changes apply.
  try { sqlite.exec(`DELETE FROM music_dj_cache`) } catch {}
  addColumn('music_dj_cache', 'genre', 'TEXT')
  addColumn('music_dj_cache', 'station_name', 'TEXT')
  addColumn('music_dj_cache', 'track_name', 'TEXT')
  addColumn('music_dj_cache', 'artist_name', 'TEXT')
  addColumn('music_dj_cache', 'next_track_name', 'TEXT')
  addColumn('music_dj_cache', 'next_artist_name', 'TEXT')
  addColumn('music_dj_cache', 'style', 'TEXT')
  addColumn('music_dj_cache', 'facts', 'TEXT')
  try {
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS feed_folders_slug_unique ON feed_folders(slug);`)
  } catch (err) {
    console.warn('[migrations] feed_folders slug index failed:', err instanceof Error ? err.message : err)
  }
  // SQLite cannot ALTER COLUMN to drop NOT NULL, so rebuild the table once if user_id is still
  // NOT NULL (older installs). Guarded + idempotent: only fires while the constraint persists.
  try {
    const cols = sqlite.query(`PRAGMA table_info(feed_folders);`).all() as Array<{ name: string; notnull: number }>
    const userIdCol = cols.find((c) => c.name === 'user_id')
    if (userIdCol && userIdCol.notnull === 1) {
      sqlite.exec('PRAGMA foreign_keys = OFF;')
      sqlite.exec(`
        CREATE TABLE feed_folders_new (
          id TEXT NOT NULL PRIMARY KEY,
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          slug TEXT,
          locked INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        INSERT INTO feed_folders_new (id, user_id, name, slug, locked, sort_order, created_at)
          SELECT id, user_id, name, slug, locked, sort_order, created_at FROM feed_folders;
        DROP TABLE feed_folders;
        ALTER TABLE feed_folders_new RENAME TO feed_folders;
        CREATE UNIQUE INDEX IF NOT EXISTS feed_folders_slug_unique ON feed_folders(slug);
      `)
      sqlite.exec('PRAGMA foreign_keys = ON;')
      console.warn('[migrations] rebuilt feed_folders with nullable user_id')
    }
  } catch (err) {
    try { sqlite.exec('PRAGMA foreign_keys = ON;') } catch {}
    console.warn('[migrations] feed_folders rebuild failed:', err instanceof Error ? err.message : err)
  }

  // (The legacy Organizr-bookmarks → Live-links fold now happens inside the Reader→Bookmarks
  //  rename block above, before the old table is dropped.)

  // Hot-path indexes for foreign-key / scope lookups. All idempotent (IF NOT EXISTS),
  // so they are safe to (re)run on every boot. Mirror any new index here too.
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_character_id ON memories(character_id);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);
    CREATE INDEX IF NOT EXISTS idx_entities_character_id ON entities(character_id);
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_user_id ON memory_episodes(user_id);
    CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON generated_images(user_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_results_user_id ON analysis_results(user_id);
    CREATE INDEX IF NOT EXISTS idx_yt_videos_channel_id ON yt_videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_voice_samples_character_id ON voice_samples(character_id);
    CREATE INDEX IF NOT EXISTS idx_maps_saved_pins_user_id ON maps_saved_pins(user_id);
  `)

  // Content profiles (named per-category content ceilings, assigned to users)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS content_profiles (
      id TEXT NOT NULL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      dials TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // Frigate camera integration
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS frigate_events (
      id TEXT NOT NULL PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      camera TEXT,
      event_id TEXT,
      label TEXT,
      sub_label TEXT,
      plate TEXT,
      plate_name TEXT,
      zones TEXT,
      severity TEXT,
      title TEXT,
      description TEXT,
      score REAL,
      snapshot_url TEXT,
      clip_url TEXT,
      announce INTEGER NOT NULL DEFAULT 0,
      spoken INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_frigate_events_created_at ON frigate_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_frigate_events_announce ON frigate_events(announce, spoken);
  `)
  // Lazily-populated nomic embedding of the event text, for natural-language footage search.
  addColumn('frigate_events', 'embedding', 'TEXT')

  // Physical Pod devices (ESP32 voice satellites). Each is bound to a user (and
  // optional companion + wake word) and authenticates the Wyoming gateway socket
  // with a long-lived token. See plans/hardware-devices/pod-wyoming-architecture.md.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      character_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'pod',
      wake_word TEXT,
      hwid TEXT,
      model TEXT,
      token_hash TEXT,
      pairing_code TEXT,
      pairing_expires_at INTEGER,
      capabilities TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash_unique ON devices(token_hash);
    CREATE INDEX IF NOT EXISTS devices_user_id ON devices(user_id);
  `)
  // hwid: a device's stable hardware id (MAC), used by the one-tap "Claim" flow so a
  // re-claimed (factory-reset) screenless Pod rebinds its existing row instead of
  // creating a duplicate. Added for existing DBs.
  addColumn('devices', 'hwid', 'TEXT')
  // model: the device-catalog id (e.g. 'atom-echo') used to show make/model + art.
  addColumn('devices', 'model', 'TEXT')

  // Device setting groups: a built-in "Default" profile holds the baseline settings;
  // admin-created groups override specific keys (inheriting the rest from Default).
  // Each device belongs to exactly one group (group_id null → Default). Settings are
  // pushed to devices over the gateway, so changing one re-deploys live.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS device_groups (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `)
  // group_id: which device_groups row a device belongs to (null → built-in Default).
  addColumn('devices', 'group_id', 'TEXT')
  addColumn('devices', 'area_id', 'TEXT')   // HA area for room-context ("here") resolution
  // Seed the built-in Default group with the baseline settings (idempotent).
  sqlite.exec(`
    INSERT OR IGNORE INTO device_groups (id, name, is_default, settings, created_at)
    VALUES ('default', 'Default', 1, '{"dimEnabled":false,"dimPercent":30,"dimAfterS":60,"responseLength":"inherit"}',
            CAST(strftime('%s','now') AS INTEGER) * 1000);
  `)

  // ── Tab5 modular slot-based dashboard (Admin → Devices → Layouts/Sounds) ──────
  // Named layout templates (3×3 slot grid + theme tokens + sound pack), swappable
  // sound packs, and synthesised chime recipes. Built-in rows are seeded by
  // lib/pod/deviceStudio.ensureBuiltins() at boot (and their WAVs rendered there).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS device_layout_templates (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      grid TEXT NOT NULL DEFAULT '3x3',
      theme TEXT NOT NULL DEFAULT '{}',
      widgets TEXT NOT NULL DEFAULT '[]',
      sound_pack_id TEXT,
      volume REAL NOT NULL DEFAULT 0.7,
      alarm_volume REAL NOT NULL DEFAULT 1,
      sound_overrides TEXT NOT NULL DEFAULT '{}',
      alarm_tone_id TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_sound_packs (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      events TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_chimes (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'earcon',
      loop INTEGER NOT NULL DEFAULT 0,
      recipe TEXT NOT NULL DEFAULT '{}',
      wav_sha TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // A screen device's assigned layout template + optional per-device theme/volume tweak.
  addColumn('devices', 'layout_template_id', 'TEXT')
  addColumn('devices', 'layout_overrides', 'TEXT')
  // Centralised alarms can target specific devices and pick a device tone from the
  // shared chime library (distinct from the existing browser `tone`).
  addColumn('clock_alarms', 'tone_id', 'TEXT')
  addColumn('clock_alarms', 'targets', 'TEXT')

  // Partial-reply persistence: replies cut off by cancel or a mid-stream failure
  // are saved with truncated=1 instead of being discarded.
  addColumn('messages', 'truncated', 'INTEGER NOT NULL DEFAULT 0')

  // Structured persona: JSON string[] of example lines in the character's voice.
  addColumn('characters', 'persona_examples', 'TEXT')

  // Tool-result note behind an assistant reply — folded into LLM history on later
  // turns so follow-ups see what the tools actually returned.
  addColumn('messages', 'tool_note', 'TEXT')

  // Rolling in-conversation summary (covers messages older than the live window).
  addColumn('conversations', 'summary', 'TEXT')
  addColumn('conversations', 'summary_through', 'INTEGER')

  // Embedded chunks of oversized attached documents (RAG retrieval instead of
  // hard truncation at the stuffing budget).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES chat_documents(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_document_chunks_conv ON chat_document_chunks(conversation_id);
  `)

  // Generic read-through lookup cache (property/people scrapers and future tools).
  // data holds the JSON result ("null" = cached negative); expires_at is epoch ms.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lookup_cache (
      key TEXT NOT NULL PRIMARY KEY,
      namespace TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lookup_cache_namespace ON lookup_cache(namespace);
    CREATE INDEX IF NOT EXISTS idx_lookup_cache_expires ON lookup_cache(expires_at);
  `)

  // Per-user enable overrides for on-disk markdown skills (see schema.ts skillEnabled).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS skill_enabled (
      user_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'user_toggle',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, skill_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  // Voice memos — recorded audio + best-effort transcript (Phase 3).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS voice_memos (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      transcript TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_voice_memos_user ON voice_memos(user_id, created_at);
  `)

  // Media compat transcode cache — on-demand browser-safe renditions of stored files.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS media_compat_cache (
      id TEXT NOT NULL PRIMARY KEY,
      src_path TEXT NOT NULL,
      variant TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      probe_json TEXT,
      out_ext TEXT NOT NULL DEFAULT 'mp4',
      progress_pct INTEGER,
      size_bytes INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_served_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_media_compat_src ON media_compat_cache(src_path, variant);
  `)

  // Document RAG — project file attachments + embedded chunks (Phase 5).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_documents (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      blob_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id);

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT NOT NULL PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB,
      loc TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES project_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_document_chunks_project ON document_chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id);

    CREATE TABLE IF NOT EXISTS generated_documents (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT,
      conversation_id TEXT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      preset TEXT,
      markdown TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_generated_documents_user ON generated_documents(user_id, created_at);
  `)

  // Chat document attachments + TTS pronunciation lexicon.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_documents (
      id TEXT NOT NULL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_documents_conversation ON chat_documents(conversation_id);

    CREATE TABLE IF NOT EXISTS chat_document_edits (
      id TEXT NOT NULL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      edited_filename TEXT NOT NULL,
      instruction TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_document_edits_conversation ON chat_document_edits(conversation_id);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      message_id TEXT,
      type TEXT NOT NULL,
      language TEXT,
      title TEXT NOT NULL,
      current_content TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS artifacts_user_idx ON artifacts(user_id);
    CREATE INDEX IF NOT EXISTS artifacts_conversation_idx ON artifacts(conversation_id);

    CREATE TABLE IF NOT EXISTS artifact_versions (
      id TEXT NOT NULL PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS artifact_versions_artifact_idx ON artifact_versions(artifact_id);

    CREATE TABLE IF NOT EXISTS pronunciation_packs (
      id TEXT NOT NULL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      app_key TEXT,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pronunciations (
      id TEXT NOT NULL PRIMARY KEY,
      pack_id TEXT REFERENCES pronunciation_packs(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      replacement TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_watchlist (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      title TEXT NOT NULL,
      poster_url TEXT,
      subtitle TEXT,
      status TEXT NOT NULL DEFAULT 'want',
      plex_rating_key TEXT,
      plex_synced_at INTEGER,
      deleted_at INTEGER,
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_watchlist_unique ON media_watchlist(user_id, media_type, ref_id);
    CREATE TABLE IF NOT EXISTS show_watched_episodes (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tvmaze_id INTEGER NOT NULL,
      episode_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      number INTEGER,
      watched_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS show_watched_episodes_unique ON show_watched_episodes(user_id, episode_id);
    CREATE TABLE IF NOT EXISTS media_requests (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      poster_url TEXT,
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      pipeline TEXT NOT NULL,
      external_id TEXT,
      origin TEXT NOT NULL DEFAULT 'app',
      status TEXT NOT NULL DEFAULT 'requested',
      progress REAL,
      plex_rating_key TEXT,
      plex_deep_link TEXT,
      notified_at INTEGER,
      last_checked_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_requests_unique ON media_requests(user_id, media_type, ref_id);
    CREATE INDEX IF NOT EXISTS media_requests_status_idx ON media_requests(status);
  `)

  // Plex account-Watchlist mirror columns — added after the table exists (existing DBs).
  addColumn('media_watchlist', 'plex_rating_key', 'TEXT')
  addColumn('media_watchlist', 'plex_synced_at', 'INTEGER')
  addColumn('media_watchlist', 'deleted_at', 'INTEGER')

  // Controller layout templates — named button-grid presets assigned to screen
  // devices (parallel to device_layout_templates for the display side). Built-in templates
  // ship with dynamic data resolved at push time.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS controller_layout_templates (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      grid_rows INTEGER NOT NULL DEFAULT 3,
      grid_cols INTEGER NOT NULL DEFAULT 5,
      pages_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  addColumn('devices', 'controller_layout_template_id', 'TEXT')
  addColumn('devices', 'controller_layout_overrides', 'TEXT')
  addColumn('devices', 'orientation', 'INTEGER NOT NULL DEFAULT 0')
  // Pod display mode: explicit user-set mode per device (activity/status/sleeping/display).
  // Null means the ambient clock/weather 'display' view (legacy default).
  addColumn('devices', 'display_mode', 'TEXT')

  // ── Unified screen deck (collapses display-layout / controller-layout / screen-mode
  // into one "ordered deck of screens per device", shared between Admin → Devices and the
  // new Settings → Devices; see schema.ts `screens` / `deviceScreens` for the full design) ──
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS screens (
      id TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      renderer TEXT NOT NULL DEFAULT 'jpeg',
      params TEXT NOT NULL DEFAULT '{}',
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_screens (
      id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      screen_id TEXT,
      kind TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS device_screens_device_idx ON device_screens(device_id, position);
  `)
  // Admin-only locks gating the OWNER's Settings → Devices editor (Admin is never gated).
  addColumn('devices', 'lock_screen_selection', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('devices', 'lock_screen_config', 'INTEGER NOT NULL DEFAULT 0')
  // Audio/alarm bundle moved OFF the per-screen layout template onto the device (it's a
  // device-global concern — see schema.ts comment). Old template columns stay untouched;
  // seedDeviceDecks() (lib/pod/screenDeck.ts, called at boot) backfills these from the
  // device's current layout template the first time it runs.
  addColumn('devices', 'sound_pack_id', 'TEXT')
  addColumn('devices', 'sound_volume', 'REAL')
  addColumn('devices', 'alarm_volume', 'REAL')
  addColumn('devices', 'sound_overrides', "TEXT NOT NULL DEFAULT '{}'")
  addColumn('devices', 'alarm_tone_id', 'TEXT')

  // Web Push subscriptions (VAPID) — see schema.ts pushSubscriptions / lib/push.ts.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh_key TEXT NOT NULL,
      auth_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
  `)

  // Notification delivery layer — see schema.ts notificationChannels/notificationDeliveries
  // and lib/notify/. priority/dedupe_key power the dispatcher's routing + idempotency.
  addColumn('notifications', 'priority', `TEXT NOT NULL DEFAULT 'normal'`)
  addColumn('notifications', 'dedupe_key', 'TEXT')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      address TEXT NOT NULL,
      label TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      verify_code TEXT,
      verify_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT NOT NULL PRIMARY KEY,
      notification_id TEXT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status, user_id);
  `)

  // Shopping / price tracker — see schema.ts shoppingProducts…shoppingHostStrategies.
  // Products/listings/history are household-wide; watches/discounts are per-user.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS shopping_products (
      id TEXT NOT NULL PRIMARY KEY,
      title TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      gtin TEXT,
      image_url TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shopping_products_gtin_idx ON shopping_products(gtin);
    CREATE TABLE IF NOT EXISTS shopping_listings (
      id TEXT NOT NULL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES shopping_products(id) ON DELETE CASCADE,
      retailer TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      image_url TEXT,
      price_cents INTEGER,
      was_price_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'USD',
      in_stock INTEGER,
      match_confidence TEXT NOT NULL DEFAULT 'manual',
      active INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      last_changed_at INTEGER,
      last_error TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(retailer, external_id)
    );
    CREATE INDEX IF NOT EXISTS shopping_listings_product_idx ON shopping_listings(product_id);
    CREATE TABLE IF NOT EXISTS shopping_price_points (
      id TEXT NOT NULL PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES shopping_listings(id) ON DELETE CASCADE,
      price_cents INTEGER,
      in_stock INTEGER NOT NULL,
      via TEXT NOT NULL DEFAULT 'direct',
      observed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shopping_price_points_listing_time_idx ON shopping_price_points(listing_id, observed_at);
    CREATE TABLE IF NOT EXISTS shopping_watches (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES shopping_products(id) ON DELETE CASCADE,
      listing_id TEXT REFERENCES shopping_listings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target_price_cents INTEGER,
      percent_drop REAL,
      use_effective_price INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shopping_watches_user_product_idx ON shopping_watches(user_id, product_id);
    CREATE TABLE IF NOT EXISTS shopping_discounts (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      retailer TEXT NOT NULL,
      label TEXT NOT NULL,
      percent_off REAL NOT NULL,
      max_discount_cents INTEGER,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shopping_discounts_user_retailer_idx ON shopping_discounts(user_id, retailer);
    CREATE TABLE IF NOT EXISTS shopping_host_strategies (
      host TEXT NOT NULL PRIMARY KEY,
      strategy TEXT NOT NULL,
      price_selector TEXT,
      title_selector TEXT,
      last_success_at INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shopping_saved (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      retailer TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      image_url TEXT,
      price_cents INTEGER,
      was_price_cents INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, kind, retailer, external_id)
    );
    CREATE INDEX IF NOT EXISTS shopping_saved_user_kind_idx ON shopping_saved(user_id, kind);
  `)

  // Product detail-page enrichment (description + star rating) — see schema.ts shoppingListings.
  addColumn('shopping_listings', 'description', 'TEXT')
  addColumn('shopping_listings', 'rating_value', 'REAL')
  addColumn('shopping_listings', 'rating_count', 'INTEGER')

  // Clipper: generic "paste any video URL" saver (see schema.ts clips).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      extractor TEXT,
      title TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT,
      duration_seconds INTEGER,
      kind TEXT NOT NULL DEFAULT 'video',
      status TEXT NOT NULL DEFAULT 'pending',
      asset_id TEXT,
      size_bytes INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS clips_user_idx ON clips(user_id, created_at);
  `)

  // Coding app: superseded by one persistent per-user tmux+Claude Code workspace
  // directory (lib/codingServer.ts) instead of app-tracked project/session rows:
  // Claude Code manages its own sessions/config natively (~/.claude inside each
  // user's workspace HOME). Drop the short-lived tables from the earlier design
  // (never shipped/committed).
  sqlite.exec(`
    DROP TABLE IF EXISTS coding_sessions;
    DROP TABLE IF EXISTS coding_projects;
  `)

  // Network protection / DNS filtering (see schema.ts dnsDevices/dnsRules; lib/dns)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dns_devices (
      ip TEXT NOT NULL PRIMARY KEY,
      label TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT 'default',
      last_seen_at INTEGER,
      queries INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dns_rules (
      id TEXT NOT NULL PRIMARY KEY,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      profile TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dns_rules_domain_idx ON dns_rules(domain);
  `)

  // Routines (see schema.ts routines/routineRuns; lib/routines/engine.ts)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger TEXT NOT NULL,
      actions TEXT NOT NULL,
      created_via TEXT NOT NULL DEFAULT 'app',
      last_run_at INTEGER,
      last_result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT NOT NULL PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      fired_by TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS routine_runs_routine_idx ON routine_runs(routine_id, started_at);
    -- Learned methods: reusable multi-step procedures the companion saves and later
    -- RAG-recalls. user_id NULL = household-wide; otherwise owned by that user.
    CREATE TABLE IF NOT EXISTS methods (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL,
      embedding TEXT,
      created_via TEXT NOT NULL DEFAULT 'companion',
      uses INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS methods_user_idx ON methods(user_id);
  `)

  // Backups (see schema.ts backups; Admin → Storage → Backups)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      destination_path TEXT NOT NULL,
      db_file_name TEXT,
      db_size_bytes INTEGER,
      files_synced INTEGER,
      files_bytes INTEGER,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
  `)

  // Storage Locations + Plex export (see schema.ts storageLocations/contentTypeStorage/
  // plexPathMappings/plexLibrarySections; plan at ~/.claude/plans/compiled-toasting-lovelace.md).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_locations (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_type_storage (
      content_type TEXT NOT NULL PRIMARY KEY,
      storage_location_id TEXT REFERENCES storage_locations(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plex_path_mappings (
      id TEXT NOT NULL PRIMARY KEY,
      storage_location_id TEXT NOT NULL UNIQUE REFERENCES storage_locations(id) ON DELETE CASCADE,
      plex_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plex_library_sections (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      plex_section_key TEXT,
      plex_machine_identifier TEXT,
      shared_server_id TEXT,
      root_abs_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, content_type)
    );
    CREATE TABLE IF NOT EXISTS plex_collections (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      plex_collection_title TEXT,
      plex_rating_key TEXT,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, content_type, source_type, source_id)
    );
  `)

  // Blob store becomes storage-location-aware (see lib/storage/contentRoots.ts) — null
  // (all pre-existing rows) means "default data root," unchanged behavior.
  addColumn('blobs', 'storage_location_id', 'TEXT')

  // Persist which InnerTube channel tab a video came from (see schema.ts ytVideos.tab) —
  // unlocks the Plex export's separate Shorts show without re-deriving it from duration alone.
  addColumn('yt_videos', 'tab', 'TEXT')

  // View count (raw text; displayed via fmtViews) so Offline/Feed/History cards and the watch
  // page show views like the live discovery cards do. Populated by the channel reconcile scan
  // and lazily by the watch route on first resolve.
  addColumn('yt_videos', 'views', 'TEXT')

  // YouTube → Plex export tree tracking (see schema.ts ytPlexShows/ytPlexEpisodes).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS yt_plex_shows (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL,
      folder_rel_path TEXT NOT NULL,
      nfo_hash TEXT,
      nfo_written_at INTEGER,
      posters_written_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, channel_id, variant)
    );
    CREATE TABLE IF NOT EXISTS yt_plex_episodes (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL,
      show_id TEXT NOT NULL REFERENCES yt_plex_shows(id) ON DELETE CASCADE,
      season_year INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      source_asset_id TEXT,
      cut_format_key TEXT,
      cut_categories_hash TEXT,
      cut_segments_json TEXT,
      rel_path TEXT,
      nfo_written_at INTEGER,
      thumb_written_at INTEGER,
      srt_written_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      plex_refreshed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, video_id)
    );
  `)

  // Videos hub → Plex export (see schema.ts videoPlexShows/videoPlexEpisodes): the generic
  // twin of the yt_plex_* tables for tiktok/vimeo/reddit/mine sources.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS video_plex_shows (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      creator_key TEXT NOT NULL,
      title TEXT NOT NULL,
      folder_rel_path TEXT NOT NULL,
      nfo_hash TEXT,
      nfo_written_at INTEGER,
      posters_written_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, source, creator_key)
    );
    CREATE TABLE IF NOT EXISTS video_plex_episodes (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      show_id TEXT NOT NULL REFERENCES video_plex_shows(id) ON DELETE CASCADE,
      season_year INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      source_asset_id TEXT,
      rel_path TEXT,
      plex_rating_key TEXT,
      nfo_written_at INTEGER,
      thumb_written_at INTEGER,
      srt_written_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      plex_refreshed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, source, video_id)
    );
  `)

  // Per-library sync policy (all / most-recent-N / remove-watched) — see schema.ts
  // plexLibrarySections. Defaults preserve today's behavior (sync everything, keep forever).
  addColumn('plex_library_sections', 'sync_mode', "TEXT NOT NULL DEFAULT 'all'")
  addColumn('plex_library_sections', 'sync_recent_count', 'INTEGER')
  addColumn('plex_library_sections', 'remove_watched', 'INTEGER NOT NULL DEFAULT 0')

  // Watched sweep learns each placed episode's Plex ratingKey lazily (basename match once,
  // id lookup afterwards) — see schema.ts ytPlexEpisodes.plexRatingKey.
  addColumn('yt_plex_episodes', 'plex_rating_key', 'TEXT')

  // "Smart Description" (see schema.ts ytVideos.descriptionClean) — LLM-cleaned description,
  // or the transcript summary when the real description is mostly sponsor/ad content.
  addColumn('yt_videos', 'description_clean', 'TEXT')

  // Numeric engagement counts from yt-dlp metadata (views is legacy TEXT display data) —
  // feed the Plex export's show-level audience rating (like/view ratio).
  addColumn('yt_videos', 'like_count', 'INTEGER')
  addColumn('yt_videos', 'view_count', 'INTEGER')

  // Videos hub: generic multi-source persistence (see schema.ts videoFollows/videoItems/
  // videoWatchState/videoSaves; plan at ~/.claude/plans/valiant-skipping-fiddle.md).
  // YouTube stays in yt_*; these tables carry reddit/tiktok/vimeo with a source column.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS video_follows (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'creator',
      external_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      handle TEXT,
      thumbnail_url TEXT,
      description TEXT,
      is_adult INTEGER NOT NULL DEFAULT 0,
      last_fetched_at INTEGER,
      auto_save INTEGER NOT NULL DEFAULT 0,
      auto_save_kind TEXT NOT NULL DEFAULT 'video',
      auto_save_keep INTEGER,
      added_at INTEGER NOT NULL,
      UNIQUE(user_id, source, external_id)
    );
    CREATE TABLE IF NOT EXISTS video_items (
      id TEXT NOT NULL PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      follow_id TEXT REFERENCES video_follows(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      creator_id TEXT,
      creator_name TEXT,
      url TEXT,
      thumbnail_url TEXT,
      duration_sec INTEGER,
      published_at INTEGER,
      is_adult INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(source, external_id)
    );
    CREATE INDEX IF NOT EXISTS video_items_follow_idx ON video_items(follow_id, published_at);
  `)
  addColumn('video_items', 'views_text', 'TEXT')
  addColumn('video_follows', 'remove_watched', 'INTEGER NOT NULL DEFAULT 0')
  // Per-follow "auto-transcribe new uploads" pref (Whisper fallback, captions first).
  addColumn('video_follows', 'auto_transcribe', 'INTEGER NOT NULL DEFAULT 0')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS video_watch_state (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      position_sec REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, source, video_id)
    );
    CREATE TABLE IF NOT EXISTS video_saves (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'video',
      status TEXT NOT NULL DEFAULT 'pending',
      asset_id TEXT,
      size_bytes INTEGER,
      max_height INTEGER,
      thumbnail_url TEXT,
      creator_name TEXT,
      duration_sec INTEGER,
      source_url TEXT,
      auto INTEGER NOT NULL DEFAULT 0,
      is_adult INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, source, video_id, kind)
    );
    CREATE INDEX IF NOT EXISTS video_saves_user_idx ON video_saves(user_id, created_at);
  `)

  // Cross-source collections/playlists: YouTube rows keep the default; new sources tag
  // theirs. Named video_source because yt_collections.source already means local-vs-google
  // account-sync ownership. (The existing unique constraints can't gain video_source
  // without a table rebuild — IDs across sources can't realistically collide; accept it.)
  addColumn('yt_collections', 'video_source', "TEXT NOT NULL DEFAULT 'youtube'")
  addColumn('yt_playlist_videos', 'video_source', "TEXT NOT NULL DEFAULT 'youtube'")
  // YouTube thumbnails are derived from videoId at render time; every other source's
  // thumbnail is an arbitrary provider URL that has to be stored to display it.
  addColumn('yt_playlist_videos', 'thumbnail_url', 'TEXT')

  // Watch-history hygiene: Music-station plays share the YouTube player but belong to
  // the Music app (see schema.ts ytWatchState.origin). Retro-tag rows whose video only
  // exists as a music-origin/prefetch download so they leave the Videos history.
  addColumn('yt_watch_state', 'origin', "TEXT NOT NULL DEFAULT 'youtube'")
  sqlite.exec(`
    UPDATE yt_watch_state SET origin = 'music' WHERE origin = 'youtube' AND video_id IN (
      SELECT video_id FROM yt_downloads WHERE origin = 'music' OR prefetch = 1
    ) AND video_id NOT IN (SELECT video_id FROM yt_collections)
  `)

  // Videos Create studio (see schema.ts studioProjects/studioMedia/studioProjectAssets).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      edl_json TEXT NOT NULL,
      duration_sec REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_media (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'video',
      asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      source_meta TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_media_user_idx ON studio_media(user_id, created_at);
    CREATE TABLE IF NOT EXISTS studio_project_assets (
      project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL,
      UNIQUE(project_id, asset_id)
    );
  `)

  // Studio "share with household" flag — shared videos appear in other members' My Videos
  // Plex library under the owner's show (see schema.ts studioMedia.sharedAt). Must run
  // AFTER the studio_media CREATE above so a fresh install gets the column too.
  addColumn('studio_media', 'shared_at', 'INTEGER')

  // Editable display metadata for Videos → Mine items (rename / describe from the card).
  // studio_media already has `title`; generated clips fall back to their prompt when title is null.
  addColumn('studio_media', 'description', 'TEXT')
  addColumn('generated_images', 'title', 'TEXT')
  addColumn('generated_images', 'description', 'TEXT')

  // Notes app (see schema.ts notebooks/notes/noteTags/noteItemTags/noteLinks/noteChunks).
  // owner_id NULL = household-shared (admin-managed), same convention as bookmarks.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      notebook_id TEXT REFERENCES notebooks(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags_text TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'user',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_owner_updated_idx ON notes(owner_id, updated_at);
    CREATE TABLE IF NOT EXISTS note_tags (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_item_tags (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES note_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS note_links (
      id TEXT NOT NULL PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_links_target_idx ON note_links(target_type, target_id);
    CREATE INDEX IF NOT EXISTS note_links_note_idx ON note_links(note_id);
    CREATE TABLE IF NOT EXISTS note_chunks (
      id TEXT NOT NULL PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_chunks_note_idx ON note_chunks(note_id);

    -- FTS5 over notes (external-content), kept in sync by triggers. tags_text is the
    -- denormalized tag names column so tag words match without joining note_item_tags.
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, body, tags_text,
      content='notes', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, body, tags_text)
        VALUES (new.rowid, new.title, new.body, new.tags_text);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body, tags_text)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags_text);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body, tags_text)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags_text);
      INSERT INTO notes_fts(rowid, title, body, tags_text)
        VALUES (new.rowid, new.title, new.body, new.tags_text);
    END;
  `)

  // Backfill notes_fts from existing rows — triggers only fire on FUTURE writes, so a
  // mirror created against a populated table starts empty. Guarded/idempotent.
  try {
    const notesFtsCount = (sqlite.query(`SELECT count(*) AS c FROM notes_fts`).get() as { c: number }).c
    const notesRowCount = (sqlite.query(`SELECT count(*) AS c FROM notes`).get() as { c: number }).c
    if (notesFtsCount === 0 && notesRowCount > 0) {
      sqlite.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild');`)
      console.warn(`[migrations] backfilled notes_fts (${notesRowCount} rows)`)
    }
  } catch (err) {
    console.warn('[migrations] notes_fts backfill failed:', err instanceof Error ? err.message : err)
  }

  // News reader "AI summary" cache (feed_items.summary is the RSS-provided teaser/
  // description - a different field - so the AI-generated TL;DR gets its own column).
  addColumn('feed_items', 'ai_summary', 'TEXT')

  // LLM-extracted related-search topics for the watch page's topic-grouped "Related"
  // shelves (see schema.ts ytVideos.relatedTopics).
  addColumn('yt_videos', 'related_topics', 'TEXT')

  // Admin System console: homelab machine registry + audit log (see schema.ts
  // homelabHosts / adminAuditLog). Secret columns hold ciphertext only (lib/secrets.ts).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS homelab_hosts (
      id TEXT NOT NULL PRIMARY KEY,
      label TEXT NOT NULL,
      hostname TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ssh_port INTEGER,
      ssh_user TEXT,
      ssh_auth TEXT,
      ssh_secret TEXT,
      vnc_port INTEGER,
      vnc_secret TEXT,
      rdp_port INTEGER,
      rdp_user TEXT,
      rdp_secret TEXT,
      rdp_security TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at);
  `)

  // Remote app: machine ownership/scope (null user_id = shared) + organization columns, plus
  // folders and snippets. Additive columns on the existing homelab_hosts table.
  addColumn('homelab_hosts', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE')
  addColumn('homelab_hosts', 'folder_id', 'TEXT')
  addColumn('homelab_hosts', 'favorite', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('homelab_hosts', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS remote_folders (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      parent_id TEXT,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_snippets (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // Interest engine: "Suggested for you" impression/dismissal state (see schema.ts
  // suggestionImpressions). Profiles and candidate pools live in lookup_cache, not tables.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS suggestion_impressions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      ref TEXT NOT NULL,
      creator_id TEXT,
      creator_name TEXT,
      title TEXT,
      shown_count INTEGER NOT NULL DEFAULT 0,
      last_shown_at INTEGER,
      dismissed_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, domain, ref)
    );
    CREATE INDEX IF NOT EXISTS suggestion_impressions_user_domain_idx ON suggestion_impressions(user_id, domain);
  `)

  // Music intelligence: cached "Mixes For You" per user + Family Blend definitions
  // (see schema.ts musicMixes / musicBlends).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS music_mixes (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      subtitle TEXT,
      tracks_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      UNIQUE(user_id, key)
    );
    CREATE TABLE IF NOT EXISTS music_blends (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      match_percent INTEGER,
      refreshed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // Family audio controls: per-profile allowlist/blocklist, time budgets, quiet hours,
  // volume cap, usage ledger, guardrail events, weekly parent digests (see schema.ts
  // familyAudio* tables and lib/family/audioPolicy.ts).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS family_audio_settings (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      allowlist_only INTEGER NOT NULL DEFAULT 0,
      daily_audio_minutes INTEGER,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      max_volume_percent INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_audio_entries (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      list TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      alt_ref TEXT,
      label TEXT NOT NULL,
      added_by TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, list, kind, ref)
    );
    CREATE INDEX IF NOT EXISTS family_audio_entries_user_idx ON family_audio_entries(user_id);
    CREATE TABLE IF NOT EXISTS family_audio_usage (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      medium TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, day, medium)
    );
    CREATE INDEX IF NOT EXISTS family_audio_usage_day_idx ON family_audio_usage(day);
    CREATE TABLE IF NOT EXISTS family_audio_events (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS family_audio_events_user_created_idx ON family_audio_events(user_id, created_at);
    CREATE TABLE IF NOT EXISTS family_audio_digests (
      id TEXT NOT NULL PRIMARY KEY,
      week_start TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL DEFAULT '{}',
      summary TEXT,
      created_at INTEGER NOT NULL
    );
  `)

  // Lyric translations: cached LLM output per (track, language) so a song is translated
  // once for the whole household (see schema.ts lyricTranslations).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lyric_translations (
      id TEXT NOT NULL PRIMARY KEY,
      track_key TEXT NOT NULL,
      lang TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      lines TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(track_key, lang)
    );
  `)

  // Listening Together: persisted player-device names + Family Jam shared queue
  // (schema.ts playerDevices / musicJams / musicJamItems, lib/together/, routes/together.ts).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS player_devices (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS music_jams (
      id TEXT NOT NULL PRIMARY KEY,
      host_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      host_name TEXT NOT NULL,
      host_device_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Family Jam',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS music_jam_items (
      id TEXT NOT NULL PRIMARY KEY,
      jam_id TEXT NOT NULL REFERENCES music_jams(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      thumbnail TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      added_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      added_by_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS music_jam_items_jam_pos_idx ON music_jam_items(jam_id, position);
  `)

  // Portability pack: Podcasting 2.0 credits/funding/soundbites on the podcast tables,
  // plus the scrobble outbox and gPodder-compatible sync state (see schema.ts).
  addColumn('podcast_shows', 'persons_json', 'TEXT')
  addColumn('podcast_shows', 'funding_json', 'TEXT')
  addColumn('podcast_episodes', 'persons_json', 'TEXT')
  addColumn('podcast_episodes', 'soundbites_json', 'TEXT')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scrobble_queue (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service TEXT NOT NULL DEFAULT 'listenbrainz',
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scrobble_queue_status_idx ON scrobble_queue(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS scrobble_queue_user_idx ON scrobble_queue(user_id);
    CREATE TABLE IF NOT EXISTS gpodder_devices (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      caption TEXT,
      type TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS gpodder_subscription_log (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feed_url TEXT NOT NULL,
      action TEXT NOT NULL,
      device_id TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gpodder_sub_log_user_ts_idx ON gpodder_subscription_log(user_id, timestamp);
    CREATE TABLE IF NOT EXISTS gpodder_episode_actions (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT,
      podcast_url TEXT NOT NULL,
      episode_url TEXT NOT NULL,
      action TEXT NOT NULL,
      position_sec INTEGER,
      started_sec INTEGER,
      total_sec INTEGER,
      action_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gpodder_episode_actions_user_at_idx ON gpodder_episode_actions(user_id, action_at);
  `)

  // ── AI-native podcast listening: transcripts, AI insights, snips, search ──
  // Podcasting 2.0 <podcast:transcript> URL + MIME from the feed (lazily fetched).
  addColumn('podcast_episodes', 'transcript_url', 'TEXT')
  addColumn('podcast_episodes', 'transcript_type', 'TEXT')
  // Per-user "auto-transcribe new episodes" subscription pref.
  addColumn('podcast_subscriptions', 'auto_transcribe', 'INTEGER NOT NULL DEFAULT 0')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS podcast_transcripts (
      id TEXT NOT NULL PRIMARY KEY,
      episode_id TEXT NOT NULL UNIQUE REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      format TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      segments_json TEXT,
      segment_count INTEGER,
      requested_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS podcast_episode_ai (
      id TEXT NOT NULL PRIMARY KEY,
      episode_id TEXT NOT NULL UNIQUE REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      summary TEXT,
      takeaways_json TEXT,
      chapters_generated INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS podcast_snips (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      start_sec REAL NOT NULL DEFAULT 0,
      end_sec REAL NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      summary TEXT,
      transcript_text TEXT NOT NULL,
      note_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS podcast_snips_user_idx ON podcast_snips(user_id);
    CREATE INDEX IF NOT EXISTS podcast_snips_episode_idx ON podcast_snips(episode_id);

    -- FTS5 over transcript windows (merged segments), maintained by lib/podcast/
    -- transcripts.ts on every transcript save (delete-by-episode then insert). Not an
    -- external-content mirror: the canonical segments live in podcast_transcripts'
    -- segments_json, and search results re-join podcast_episodes so rows for deleted
    -- episodes simply never surface.
    CREATE VIRTUAL TABLE IF NOT EXISTS podcast_transcript_fts USING fts5(
      text, episode_id UNINDEXED, show_id UNINDEXED, start_sec UNINDEXED, end_sec UNINDEXED
    );
  `)

  // ── Podcast ad skipping: LLM ad-scan results + user corrections ──
  // skip_ads shipped briefly as NOT NULL DEFAULT 0; it is now a nullable tri-state
  // (null = inherit the global podcasts.skipAds preference, 0/1 = per-show override),
  // matching trim_silence / voice_boost. The feature is new, so no meaningful values
  // exist yet: drop the NOT NULL column and re-add it nullable. Idempotent (only the
  // first boot after this change finds a NOT NULL column to rebuild).
  {
    const col = (sqlite.query(`PRAGMA table_info(podcast_show_settings)`).all() as Array<{ name: string; notnull: number }>)
      .find(c => c.name === 'skip_ads')
    if (col && col.notnull === 1) {
      try { sqlite.exec('ALTER TABLE podcast_show_settings DROP COLUMN skip_ads') } catch { /* re-add below */ }
    }
  }
  addColumn('podcast_show_settings', 'skip_ads', 'INTEGER')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS podcast_ad_scans (
      id TEXT NOT NULL PRIMARY KEY,
      episode_id TEXT NOT NULL UNIQUE REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      segments_json TEXT,
      segment_count INTEGER,
      model TEXT,
      requested_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS podcast_ad_reports (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      start_sec REAL NOT NULL DEFAULT 0,
      end_sec REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS podcast_ad_reports_episode_idx ON podcast_ad_reports(episode_id);
    CREATE TABLE IF NOT EXISTS podcast_ad_fingerprints (
      id TEXT NOT NULL PRIMARY KEY,
      show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
      sig TEXT NOT NULL,
      fp BLOB NOT NULL,
      frames INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(show_id, sig)
    );
    CREATE INDEX IF NOT EXISTS podcast_ad_fingerprints_show_idx ON podcast_ad_fingerprints(show_id);
    CREATE TABLE IF NOT EXISTS podcast_show_sponsors (
      id TEXT NOT NULL PRIMARY KEY,
      show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(show_id, name)
    );
    CREATE INDEX IF NOT EXISTS podcast_show_sponsors_show_idx ON podcast_show_sponsors(show_id);

    CREATE TABLE IF NOT EXISTS podcast_moments (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      at_sec INTEGER NOT NULL,
      emoji TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS podcast_moments_episode_idx ON podcast_moments(episode_id);
  `)

  // Apple iCloud (M1: per-member account connections; calendar/mail tables land in M2/M4)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS icloud_accounts (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      apple_id TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      caldav_home_url TEXT,
      caldav_status TEXT NOT NULL DEFAULT 'unprobed',
      imap_status TEXT NOT NULL DEFAULT 'unprobed',
      last_probe_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, apple_id)
    );
  `)

  // Apple iCloud M2: calendar sync (calendars, master events, expanded occurrences)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS icloud_calendars (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      color_hex TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      ctag TEXT,
      sync_token TEXT,
      last_sync_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, url)
    );
    CREATE TABLE IF NOT EXISTS icloud_events (
      id TEXT NOT NULL PRIMARY KEY,
      calendar_id TEXT NOT NULL REFERENCES icloud_calendars(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      href TEXT NOT NULL,
      etag TEXT,
      summary TEXT,
      location TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      starts_at INTEGER,
      ends_at INTEGER,
      rrule INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      raw_ics TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(calendar_id, href)
    );
    CREATE INDEX IF NOT EXISTS icloud_events_calendar_idx ON icloud_events(calendar_id);
    CREATE TABLE IF NOT EXISTS icloud_event_occurrences (
      id TEXT NOT NULL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES icloud_events(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      location TEXT
    );
    CREATE INDEX IF NOT EXISTS icloud_occurrences_start_idx ON icloud_event_occurrences(starts_at);
    CREATE INDEX IF NOT EXISTS icloud_occurrences_user_start_idx ON icloud_event_occurrences(user_id, starts_at);
  `)

  // Apple iCloud M4: IMAP mail ingestion (folder cursors, headers-level index, sender stats)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS icloud_mail_folders (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      folder TEXT NOT NULL,
      uid_validity INTEGER,
      last_seen_uid INTEGER NOT NULL DEFAULT 0,
      last_sweep_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, folder)
    );
    CREATE TABLE IF NOT EXISTS icloud_mail_messages (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      from_address TEXT,
      from_name TEXT,
      subject TEXT,
      snippet TEXT,
      received_at INTEGER NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0,
      answered INTEGER NOT NULL DEFAULT 0,
      list_unsubscribe TEXT,
      auth_results TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(account_id, folder, uid)
    );
    CREATE INDEX IF NOT EXISTS icloud_mail_account_received_idx ON icloud_mail_messages(account_id, received_at);
    CREATE TABLE IF NOT EXISTS icloud_mail_verdicts (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      message_row_id TEXT NOT NULL REFERENCES icloud_mail_messages(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL,
      method TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS icloud_mail_verdicts_msg_idx ON icloud_mail_verdicts(account_id, message_row_id, created_at);
    CREATE TABLE IF NOT EXISTS icloud_contacts (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      href TEXT NOT NULL,
      etag TEXT,
      uid TEXT,
      full_name TEXT,
      org TEXT,
      emails TEXT,
      phones TEXT,
      birthday_month INTEGER,
      birthday_day INTEGER,
      birthday_year INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, href)
    );
    CREATE TABLE IF NOT EXISTS icloud_mail_extracts (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      message_row_id TEXT NOT NULL REFERENCES icloud_mail_messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      vendor TEXT NOT NULL,
      title TEXT,
      tracking_number TEXT,
      status TEXT,
      amount TEXT,
      event_date INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(message_row_id, kind)
    );
    CREATE INDEX IF NOT EXISTS icloud_mail_extracts_kind_date_idx ON icloud_mail_extracts(kind, event_date);
    CREATE TABLE IF NOT EXISTS icloud_sender_stats (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      sender_address TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 0,
      replied_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      UNIQUE(account_id, sender_address)
    );
  `)

  // ── Doki TV: linear channels (plans/doki-tv.md) ─────────────────────────────
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tv_channels (
      id TEXT NOT NULL PRIMARY KEY,
      number INTEGER NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      tagline TEXT,
      kind TEXT NOT NULL,
      glyph TEXT NOT NULL,
      color TEXT NOT NULL,
      color_dark TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'everyone',
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(number),
      UNIQUE(slug)
    );
    CREATE TABLE IF NOT EXISTS tv_schedule (
      id TEXT NOT NULL PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES tv_channels(id) ON DELETE CASCADE,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      block_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      art TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tv_schedule_channel_time_idx ON tv_schedule(channel_id, start_at);
    CREATE TABLE IF NOT EXISTS tv_segments (
      id TEXT NOT NULL PRIMARY KEY,
      channel_id TEXT REFERENCES tv_channels(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      path TEXT,
      duration_sec INTEGER,
      air_date INTEGER,
      meta TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tv_segments_channel_status_idx ON tv_segments(channel_id, status);
  `)
}
