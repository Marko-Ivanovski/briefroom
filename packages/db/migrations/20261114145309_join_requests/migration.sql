CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL,
	"invite_id" uuid,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text,
	CONSTRAINT "join_requests_role_valid" CHECK ("role" in ('admin', 'member')),
	CONSTRAINT "join_requests_status_valid" CHECK ("status" in ('pending', 'approved', 'declined'))
);
--> statement-breakpoint
CREATE INDEX "join_requests_workspace_id_idx" ON "join_requests" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_one_pending_per_user" ON "join_requests" ("workspace_id","user_id") WHERE "status" = 'pending';--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_invite_id_invite_links_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "invite_links"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;