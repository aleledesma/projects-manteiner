CREATE TABLE `github_install_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_github_install_states_expires` ON `github_install_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `github_user_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_user_installations_pair` ON `github_user_installations` (`user_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_github_user_installations_user` ON `github_user_installations` (`user_id`);--> statement-breakpoint
INSERT INTO `github_user_installations` (`id`, `user_id`, `installation_id`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `user_id`, `id`, `created_at`, `updated_at`
FROM `github_installations`;--> statement-breakpoint
CREATE TABLE `__new_github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`suspended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_github_installations`("id", "installation_id", "account_login", "account_type", "repository_selection", "suspended_at", "created_at", "updated_at") SELECT "id", "installation_id", "account_login", "account_type", "repository_selection", "suspended_at", "created_at", "updated_at" FROM `github_installations`;--> statement-breakpoint
DROP TABLE `github_installations`;--> statement-breakpoint
ALTER TABLE `__new_github_installations` RENAME TO `github_installations`;--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_installation_id_unique` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_github_installations_account` ON `github_installations` (`account_login`);
