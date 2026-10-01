CREATE TABLE `share_requests` (
	`member_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `share_requests_room_status_idx` ON `share_requests` (`room_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_approved_share_per_room_idx` ON `share_requests` (`room_id`) WHERE "share_requests"."status" IN ('approved', 'active');