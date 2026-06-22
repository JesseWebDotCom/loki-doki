CREATE TABLE IF NOT EXISTS podcast_shows (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  cover_rel_path TEXT,
  style TEXT NOT NULL DEFAULT 'recap',
  schedule_json TEXT,
  segments_json TEXT NOT NULL DEFAULT '[]',
  hosts_json TEXT NOT NULL DEFAULT '[]',
  stinger_json TEXT,
  visibility TEXT NOT NULL DEFAULT 'personal',
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS podcast_episodes (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  audio_rel_path TEXT,
  duration_sec INTEGER,
  chapters_json TEXT,
  script_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  generated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS podcast_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  style TEXT NOT NULL DEFAULT 'recap',
  segments_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, template_key)
);

CREATE TABLE IF NOT EXISTS podcast_watch_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  position_sec REAL NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, episode_id)
);
