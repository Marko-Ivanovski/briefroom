ALTER TABLE "project_tool_links" ADD COLUMN "position" integer;--> statement-breakpoint
UPDATE "project_tool_links" AS l SET "position" = n.pos FROM (SELECT "id", (row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") - 1)::integer AS pos FROM "project_tool_links") AS n WHERE l."id" = n."id";--> statement-breakpoint
ALTER TABLE "project_tool_links" ALTER COLUMN "position" SET NOT NULL;
