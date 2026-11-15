ALTER TABLE "cli_logins" ADD COLUMN "start_ip" text;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "start_user_agent" text;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "approved_session_id" text;