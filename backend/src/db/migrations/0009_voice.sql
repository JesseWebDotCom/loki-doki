ALTER TABLE `characters` ADD `tts_voice` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `wake_word_model_id` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `speech_rate` real;--> statement-breakpoint
CREATE TABLE `wake_word_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text DEFAULT 'trained' NOT NULL,
	`asset_path` text,
	`default_threshold` real,
	`character_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
