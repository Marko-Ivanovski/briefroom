CREATE TABLE "record_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL,
	"project_id" uuid,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"via" text NOT NULL,
	"agent" text,
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
CREATE INDEX "record_history_record_idx" ON "record_history" ("workspace_id","table_name","record_id","at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "record_history" ADD CONSTRAINT "record_history_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_history" ADD CONSTRAINT "record_history_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;