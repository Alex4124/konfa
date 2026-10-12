CREATE TABLE `account_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_sessions_account_idx` ON `account_sessions` (`account_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`nickname` text NOT NULL,
	`nickname_key` text NOT NULL,
	`email` text NOT NULL,
	`email_key` text NOT NULL,
	`email_verified_at` integer,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_nickname_key_idx` ON `accounts` (`nickname_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_key_idx` ON `accounts` (`email_key`);--> statement-breakpoint
CREATE TABLE `auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_sessions` (
	`room_id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`planned_start_at` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedule_sessions_schedule_idx` ON `schedule_sessions` (`schedule_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`start_date` text NOT NULL,
	`start_time` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`timezone` text NOT NULL,
	`recurrence` text NOT NULL,
	`weekdays` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`active_room_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedules_owner_idx` ON `schedules` (`owner_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `schedule_id` text REFERENCES schedules(id);