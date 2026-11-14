-- Test only. Applied by the test database helper when BRIEFROOM_TESTKIT=1, never by the migrator.
CREATE TABLE IF NOT EXISTS "testkit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
	"project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
	"text" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text
);
CREATE INDEX IF NOT EXISTS "testkit_notes_workspace_id_idx" ON "testkit_notes" ("workspace_id");
