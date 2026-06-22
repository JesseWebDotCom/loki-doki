CREATE TABLE `analysis_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`path` text,
	`result` text,
	`model` text NOT NULL,
	`tasks` text NOT NULL DEFAULT '[]',
	`state` text NOT NULL DEFAULT 'building',
	`error` text,
	`created_at` integer NOT NULL
);
