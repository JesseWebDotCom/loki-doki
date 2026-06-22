CREATE TABLE IF NOT EXISTS `map_regions` (
  `id` text PRIMARY KEY NOT NULL,
  `region_id` text NOT NULL,
  `street` integer NOT NULL DEFAULT 1,
  `install_status` text NOT NULL DEFAULT 'pending',
  `phase` text,
  `street_installed` integer NOT NULL DEFAULT 0,
  `valhalla_installed` integer NOT NULL DEFAULT 0,
  `pbf_installed` integer NOT NULL DEFAULT 0,
  `geocoder_installed` integer NOT NULL DEFAULT 0,
  `openaddresses_installed` integer NOT NULL DEFAULT 0,
  `geocoder_schema_version` integer NOT NULL DEFAULT 2,
  `bytes_on_disk` text NOT NULL DEFAULT '{}',
  `last_error` text,
  `installed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `map_regions_region_id` ON `map_regions` (`region_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `maps_saved_pins` (
  `pin_id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `lat` real NOT NULL,
  `lon` real NOT NULL,
  `color` text NOT NULL,
  `place_ref_json` text,
  `notes` text,
  `collection_id` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `maps_poi_enrichments` (
  `place_id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL DEFAULT '',
  `subtitle` text NOT NULL DEFAULT '',
  `lat` real NOT NULL,
  `lon` real NOT NULL,
  `category` text NOT NULL DEFAULT '',
  `phone` text,
  `website` text,
  `menu_url` text,
  `last_attempt_at` text NOT NULL,
  `last_success_at` text,
  `menu_attempt_at` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
