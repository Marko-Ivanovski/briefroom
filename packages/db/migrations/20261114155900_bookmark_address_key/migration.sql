DROP INDEX "workspace_bookmarks_remote_key";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_bookmarks_remote_key" ON "workspace_bookmarks" ("user_id","remote_base_url","remote_workspace_id");