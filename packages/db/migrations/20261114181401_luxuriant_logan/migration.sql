CREATE TABLE "workspace_modules" (
	"workspace_id" text,
	"module_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text,
	CONSTRAINT "workspace_modules_pkey" PRIMARY KEY("workspace_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "member_permissions" (
	"workspace_id" text,
	"user_id" text,
	"module_id" text,
	"key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text NOT NULL,
	"created_agent" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_via" text NOT NULL,
	"updated_agent" text,
	CONSTRAINT "member_permissions_pkey" PRIMARY KEY("workspace_id","user_id","module_id","key")
);
--> statement-breakpoint
ALTER TABLE "workspace_modules" ADD CONSTRAINT "workspace_modules_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member_permissions" ADD CONSTRAINT "member_permissions_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member_permissions" ADD CONSTRAINT "member_permissions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;