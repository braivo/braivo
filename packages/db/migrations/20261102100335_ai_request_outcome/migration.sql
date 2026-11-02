ALTER TABLE "ai_request" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_request" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "ai_request" ADD COLUMN "outcome" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_request" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "ai_request" ADD COLUMN "counts" jsonb;--> statement-breakpoint
ALTER TABLE "ai_request" ADD COLUMN "completed_at" timestamp with time zone;