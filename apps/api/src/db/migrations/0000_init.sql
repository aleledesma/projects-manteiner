CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`suspended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_installation_id_unique` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_github_installations_user` ON `github_installations` (`user_id`);--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`auth_type` text NOT NULL,
	`label` text,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`auth_tag` blob NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`last_four` text,
	`status` text DEFAULT 'active' NOT NULL,
	`verified_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_credentials_user_provider` ON `provider_credentials` (`user_id`,`provider_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text,
	`github_repo_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`primary_language` text,
	`html_url` text NOT NULL,
	`linked_at` integer NOT NULL,
	`unlinked_at` integer,
	`last_run_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repositories_user_github_repo` ON `repositories` (`user_id`,`github_repo_id`);--> statement-breakpoint
CREATE INDEX `idx_repos_user` ON `repositories` (`user_id`) WHERE "repositories"."unlinked_at" is null;--> statement-breakpoint
CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_run` ON `run_artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_events_run` ON `run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `run_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`finding_key` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`effort` text,
	`confidence` text,
	`title` text NOT NULL,
	`description` text,
	`recommendation` text,
	`locations_json` text,
	`references_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_findings_run` ON `run_findings` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_findings_key` ON `run_findings` (`finding_key`);--> statement-breakpoint
CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`evidence_json` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_steps_run_seq` ON `run_steps` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_steps_run` ON `run_steps` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`audit_type` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`agent_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`commit_sha` text,
	`base_branch` text,
	`container_id` text,
	`opencode_session_id` text,
	`result_json` text,
	`health_score` integer,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`headline` text,
	`pr_number` integer,
	`pr_url` text,
	`pr_branch` text,
	`error_code` text,
	`error_message` text,
	`tokens_input` integer,
	`tokens_output` integer,
	`cost_usd` real,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_runs_repo_time` ON `runs` (`repository_id`,"queued_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runs_user_time` ON `runs` (`user_id`,"queued_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runs_active` ON `runs` (`status`) WHERE "runs"."status" in ('queued','preparing','cloning','running','collecting','publishing_pr','generating_report');--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_model_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`small_model_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_preferences_global` ON `user_model_preferences` (`user_id`) WHERE "user_model_preferences"."repository_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_preferences_repository` ON `user_model_preferences` (`user_id`,`repository_id`) WHERE "user_model_preferences"."repository_id" is not null;--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL,
	`github_login` text NOT NULL,
	`name` text,
	`email` text,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);