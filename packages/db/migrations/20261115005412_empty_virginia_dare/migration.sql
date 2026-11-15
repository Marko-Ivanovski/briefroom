CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL,
	"project_id" uuid,
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"tool" text NOT NULL,
	"item_type" text,
	"item_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
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
CREATE INDEX "usage_events_workspace_at_idx" ON "usage_events" ("workspace_id","at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;