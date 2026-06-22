import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema'

const dbPath = process.env.DATABASE_URL ?? resolve(import.meta.dir, '../../../data/app.db')
mkdirSync(dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
// Wait up to 5s for a lock instead of failing instantly with SQLITE_BUSY (WAL still
// serializes writers, and our boot migrations + request handlers can contend).
sqlite.exec('PRAGMA busy_timeout = 5000;')

export const db = drizzle(sqlite, { schema })

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
    console.warn('[db] migration warning (non-fatal):', err instanceof Error ? err.message : err)
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

  // LoRA routing columns (from migration 0005 — belt-and-suspenders for DBs created via inline SQL)
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
  `)

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
  // Last full back-catalog reconcile (closes the RSS 15-item-window data-loss gap).
  addColumn('yt_subscriptions', 'last_reconciled_at', 'INTEGER')
  // Marks downloads written by auto-save (only these are eligible for keep-N pruning).
  addColumn('yt_downloads', 'auto', 'INTEGER NOT NULL DEFAULT 0')

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
  // segments_json was added to podcast_suggestions after its initial inline CREATE; back-fill
  // for DBs created before this column existed (the suggestions route reads/writes it).
  addColumn('podcast_suggestions', 'segments_json', `TEXT NOT NULL DEFAULT '[]'`)

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

  // Bookmarks (Organizr-style links). Only ever created by migrations 0011-0013, which
  // are in the rolled-back batch — so without this inline CREATE every bookmarks endpoint
  // throws "no such table: bookmarks" on a fresh install. owner_id null = admin/global.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT,
      category TEXT NOT NULL DEFAULT 'Other',
      sort_order INTEGER NOT NULL DEFAULT 0,
      use_proxy INTEGER NOT NULL DEFAULT 0,
      use_embed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

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
}
