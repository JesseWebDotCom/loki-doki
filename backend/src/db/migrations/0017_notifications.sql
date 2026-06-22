CREATE TABLE `notifications` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text REFERENCES `users`(`id`) ON DELETE CASCADE,
  `type` text NOT NULL,
  `payload` text NOT NULL DEFAULT '{}',
  `read_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_user_id_idx` ON `notifications`(`user_id`);
--> statement-breakpoint
CREATE INDEX `notifications_read_at_idx` ON `notifications`(`read_at`);
