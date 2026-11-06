ALTER TABLE "attempt" ADD COLUMN "reviewed_teaching" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_citation" ADD COLUMN "published_at" timestamp with time zone;