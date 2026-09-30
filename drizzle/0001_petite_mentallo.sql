PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`can_annotate` integer DEFAULT true NOT NULL,
	`raised_hand` integer DEFAULT false NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_members`("id", "room_id", "name", "role", "can_annotate", "raised_hand", "removed", "created_at") SELECT "id", "room_id", "name", "role", "can_annotate", "raised_hand", "removed", "created_at" FROM `members`;--> statement-breakpoint
DROP TABLE `members`;--> statement-breakpoint
ALTER TABLE `__new_members` RENAME TO `members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `members_room_idx` ON `members` (`room_id`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `annotations_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
