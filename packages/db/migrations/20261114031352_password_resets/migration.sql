CREATE TABLE "password_reset_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL CONSTRAINT "password_reset_links_token_hash_key" UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
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
CREATE INDEX "password_reset_links_user_id_idx" ON "password_reset_links" ("user_id");--> statement-breakpoint
ALTER TABLE "password_reset_links" ADD CONSTRAINT "password_reset_links_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "password_reset_links" ADD CONSTRAINT "password_reset_links_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;