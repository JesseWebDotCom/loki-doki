CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`icon` text,
	`category` text DEFAULT 'Other' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
