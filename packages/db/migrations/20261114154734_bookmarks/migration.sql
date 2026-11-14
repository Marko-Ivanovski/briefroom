CREATE TABLE "workspace_bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"remote_base_url" text NOT NULL,
	"remote_install_id" text NOT NULL,
	"remote_workspace_id" text NOT NULL,
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
CREATE INDEX "workspace_bookmarks_user_id_idx" ON "workspace_bookmarks" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_bookmarks_remote_key" ON "workspace_bookmarks" ("user_id","remote_install_id","remote_workspace_id");--> statement-breakpoint
ALTER TABLE "workspace_bookmarks" ADD CONSTRAINT "workspace_bookmarks_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;