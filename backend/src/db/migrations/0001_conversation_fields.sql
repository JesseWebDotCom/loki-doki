ALTER TABLE `conversations` ADD COLUMN `pinned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD COLUMN `updated_at` integer;
