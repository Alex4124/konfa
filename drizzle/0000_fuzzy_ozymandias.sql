CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`share_id` text NOT NULL,
	`author_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `annotations_share_idx` ON `annotations` (`room_id`,`share_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`can_annotate` integer DEFAULT false NOT NULL,
	`raised_hand` integer DEFAULT false NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `members_room_idx` ON `members` (`room_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_room_time_idx` ON `messages` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`object_key` text NOT NULL,
	`egress_id` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`expires_at` integer,
	`last_checked_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recordings_room_idx` ON `recordings` (`room_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`host_secret_hash` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`active_share_id` text,
	`active_share_owner` text,
	`recording_id` text,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`creator_hash` text
);
--> statement-breakpoint
CREATE INDEX `rooms_creator_time_idx` ON `rooms` (`creator_hash`,`created_at`);