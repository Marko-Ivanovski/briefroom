CREATE TABLE "workspace_removals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
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
CREATE UNIQUE INDEX "workspace_removals_workspace_user_key" ON "workspace_removals" ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "workspace_removals" ADD CONSTRAINT "workspace_removals_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_removals" ADD CONSTRAINT "workspace_removals_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;