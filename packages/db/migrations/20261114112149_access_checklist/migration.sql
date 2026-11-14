CREATE TABLE "project_access_checklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"tool_link_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text,
	CONSTRAINT "project_access_checklist_item_key" UNIQUE("project_id","user_id","tool_link_id","kind")
);
--> statement-breakpoint
CREATE INDEX "project_access_checklist_workspace_id_idx" ON "project_access_checklist" ("workspace_id");--> statement-breakpoint
ALTER TABLE "project_access_checklist" ADD CONSTRAINT "project_access_checklist_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_access_checklist" ADD CONSTRAINT "project_access_checklist_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_access_checklist" ADD CONSTRAINT "project_access_checklist_GCNWfM0rCf2U_fkey" FOREIGN KEY ("tool_link_id") REFERENCES "project_tool_links"("id") ON DELETE CASCADE;