-- YouTube subscriptions, feed cache, downloads, and watch state

CREATE TABLE `yt_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL DEFAULT 'channel',   -- 'channel' | 'playlist'
  `external_id` text NOT NULL,             -- channel_id or playlist_id
  `title` text NOT NULL DEFAULT '',
  `handle` text,                            -- @handle if known
  `thumbnail_url` text,
  `last_fetched_at` integer,               -- timestamp: last RSS poll
  `added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `yt_sub_user_ext_idx` ON `yt_subscriptions`(`user_id`, `external_id`);
--> statement-breakpoint

CREATE TABLE `yt_videos` (
  `id` text PRIMARY KEY NOT NULL,          -- internal UUID
  `video_id` text NOT NULL UNIQUE,         -- YouTube video ID (11 chars)
  `subscription_id` text REFERENCES `yt_subscriptions`(`id`) ON DELETE SET NULL,
  `title` text NOT NULL DEFAULT '',
  `author` text NOT NULL DEFAULT '',
  `channel_id` text,
  `thumbnail_url` text,
  `published_at` integer,                  -- Unix ms
  `duration_sec` integer,
  `description` text,
  `summary` text,                          -- LLM-generated summary
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `yt_videos_sub_idx` ON `yt_videos`(`subscription_id`);
--> statement-breakpoint
CREATE INDEX `yt_videos_pub_idx` ON `yt_videos`(`published_at`);
--> statement-breakpoint

CREATE TABLE `yt_downloads` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `video_id` text NOT NULL,                -- YouTube video ID
  `title` text NOT NULL DEFAULT '',
  `kind` text NOT NULL DEFAULT 'audio',    -- 'audio' | 'video'
  `rel_path` text,                         -- relative to user data root
  `transcript_rel_path` text,             -- .vtt relative path
  `status` text NOT NULL DEFAULT 'pending', -- pending | downloading | ready | failed
  `size_bytes` integer,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `yt_dl_user_idx` ON `yt_downloads`(`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `yt_dl_user_vid_kind_idx` ON `yt_downloads`(`user_id`, `video_id`, `kind`);
--> statement-breakpoint

CREATE TABLE `yt_watch_state` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `video_id` text NOT NULL,
  `position_sec` real NOT NULL DEFAULT 0,
  `completed` integer NOT NULL DEFAULT 0,  -- boolean
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `yt_watch_user_vid_idx` ON `yt_watch_state`(`user_id`, `video_id`);
