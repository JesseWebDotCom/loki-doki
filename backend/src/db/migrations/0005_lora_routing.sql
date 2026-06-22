-- LoRA routing metadata: civitai_id, LLM-extracted when_to_use / example_requests / is_stylistic_lora

ALTER TABLE `image_loras` ADD `civitai_id` text;
ALTER TABLE `image_loras` ADD `when_to_use` text;
ALTER TABLE `image_loras` ADD `example_requests` text NOT NULL DEFAULT '[]';
ALTER TABLE `image_loras` ADD `is_stylistic_lora` integer NOT NULL DEFAULT 0;
