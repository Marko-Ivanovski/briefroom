CREATE TABLE "cli_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" text NOT NULL CONSTRAINT "cli_logins_code_key" UNIQUE,
	"poll_token_hash" text NOT NULL CONSTRAINT "cli_logins_poll_token_hash_key" UNIQUE,
	"device_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"workspace_id" text,
	"token_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text
);
--> statement-breakpoint
CREATE INDEX "cli_logins_expires_at_idx" ON "cli_logins" ("expires_at");--> statement-breakpoint
ALTER TABLE "cli_logins" ADD CONSTRAINT "cli_logins_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD CONSTRAINT "cli_logins_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;