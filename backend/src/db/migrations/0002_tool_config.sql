CREATE TABLE IF NOT EXISTS `tool_global_config` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tool_global_config_tool_id_key_unique` ON `tool_global_config` (`tool_id`,`key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tool_user_config` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tool_user_config_user_id_tool_id_key_unique` ON `tool_user_config` (`user_id`,`tool_id`,`key`);
