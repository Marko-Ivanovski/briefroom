CREATE TABLE "install" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"singleton" boolean DEFAULT true NOT NULL CONSTRAINT "install_singleton_key" UNIQUE,
	"owner_user_id" text,
	"setup_code_hash" text,
	"failed_setup_attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text,
	CONSTRAINT "install_singleton_true" CHECK ("singleton")
);
--> statement-breakpoint
ALTER TABLE "install" ADD CONSTRAINT "install_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;