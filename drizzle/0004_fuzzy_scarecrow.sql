CREATE TABLE `surface_revs` (
	`room_id` text NOT NULL,
	`share_id` text NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`room_id`, `share_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `pos` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `board_pos` real DEFAULT 0 NOT NULL;