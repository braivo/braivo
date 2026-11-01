CREATE TYPE "task_report_reason" AS ENUM('answer-correct', 'key-wrong', 'confusing', 'unsupported', 'other');--> statement-breakpoint
CREATE TABLE "task_report" (
	"learner_id" text,
	"organization_id" text,
	"attempt_id" text,
	"id" text NOT NULL CONSTRAINT "task_report_id_key" UNIQUE,
	"task_id" text NOT NULL,
	"reason" "task_report_reason" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" text,
	CONSTRAINT "task_report_pkey" PRIMARY KEY("learner_id","organization_id","attempt_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "task_report_learner_task_uidx" ON "task_report" ("learner_id","organization_id","task_id") WHERE "dismissed_at" is null;--> statement-breakpoint
CREATE INDEX "task_report_open_idx" ON "task_report" ("organization_id","task_id") WHERE "dismissed_at" is null;--> statement-breakpoint
ALTER TABLE "task_report" ADD CONSTRAINT "task_report_dismissed_by_user_id_fkey" FOREIGN KEY ("dismissed_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_report" ADD CONSTRAINT "task_report_attempt_fk" FOREIGN KEY ("learner_id","organization_id","attempt_id") REFERENCES "attempt"("learner_id","organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_report" ADD CONSTRAINT "task_report_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "task"("organization_id","id") ON DELETE RESTRICT;