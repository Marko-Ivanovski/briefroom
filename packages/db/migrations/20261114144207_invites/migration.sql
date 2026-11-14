CREATE TABLE "invite_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL,
	"token_hash" text NOT NULL CONSTRAINT "invite_links_token_hash_key" UNIQUE,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text,
	CONSTRAINT "invite_links_role_valid" CHECK ("role" in ('admin', 'member')),
	CONSTRAINT "invite_links_max_uses_positive" CHECK ("max_uses" is null or "max_uses" > 0)
);
--> statement-breakpoint
CREATE INDEX "invite_links_workspace_id_idx" ON "invite_links" ("workspace_id");--> statement-breakpoint
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;