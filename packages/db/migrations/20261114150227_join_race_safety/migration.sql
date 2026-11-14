DELETE FROM "member" a USING "member" b WHERE a."organization_id" = b."organization_id" AND a."user_id" = b."user_id" AND a."id" <> b."id" AND (
	(CASE b."role" WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END) > (CASE a."role" WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END)
	OR ((CASE b."role" WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END) = (CASE a."role" WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END) AND (b."created_at", b."id") < (a."created_at", a."id"))
);--> statement-breakpoint
UPDATE "invite_links" SET "requires_approval" = true WHERE "role" = 'admin' AND NOT "requires_approval";--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_user_key" ON "member" ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_admin_needs_approval" CHECK ("role" <> 'admin' or "requires_approval");