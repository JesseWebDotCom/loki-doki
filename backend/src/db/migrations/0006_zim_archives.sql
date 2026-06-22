-- ZIM offline archives — managed by kiwix-serve subprocess

CREATE TABLE IF NOT EXISTS `zim_archives` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL UNIQUE,
  `variant_key` text NOT NULL,
  `kiwix_book_name` text,
  `file_path` text,
  `file_size_bytes` integer,
  `zim_date` text,
  `downloaded_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
