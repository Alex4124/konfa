CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`page_count` integer NOT NULL,
	`pages` text NOT NULL,
	`page` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `documents_room_idx` ON `documents` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`room_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`open` integer DEFAULT false NOT NULL,
	`board_page` integer DEFAULT 0 NOT NULL,
	`board_pages` integer DEFAULT 1 NOT NULL,
	`board_collapsed` integer DEFAULT false NOT NULL,
	`doc_collapsed` integer DEFAULT false NOT NULL,
	`doc_id` text,
	`all_draw` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `members` ADD `board_draw` integer DEFAULT false NOT NULL;