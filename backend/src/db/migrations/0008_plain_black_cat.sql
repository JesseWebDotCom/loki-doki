ALTER TABLE `characters` ADD `renderer` text DEFAULT 'dicebear' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `style` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `seed` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `avatar_config` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `phonetic_name` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `reply_style` text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `published` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TABLE `character_user_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`character_id` text NOT NULL,
	`state` text DEFAULT 'on' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_user_grants_user_id_character_id_unique` ON `character_user_grants` (`user_id`,`character_id`);
