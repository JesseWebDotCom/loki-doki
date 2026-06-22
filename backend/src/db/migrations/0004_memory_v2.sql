-- Memory system v2: entities table, tier/status/entityId/lastUsedAt on memories,
-- memoryProcessedThrough on conversations.

CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`character_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'person' NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`importance` integer DEFAULT 5 NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `entity_id` text;--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `tier` text DEFAULT 'episodic' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD COLUMN `memory_processed_through` integer;
