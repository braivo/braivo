-- Generated, then split and reordered around structural backfills (ADR 0005):
-- as generated, it added the columns NOT NULL, and used them and task's new key
-- before creating them. The result matches the TypeScript schema. Evidence and
-- attempts record their organization (ADR 0032).
ALTER TABLE "learner_evidence" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "learner_evidence" SET "organization_id" = "objective"."organization_id" FROM "objective" WHERE "objective"."id" = "learner_evidence"."objective_id";--> statement-breakpoint
ALTER TABLE "learner_evidence" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "attempt" SET "organization_id" = "task"."organization_id" FROM "task" WHERE "task"."id" = "attempt"."task_id";--> statement-breakpoint
ALTER TABLE "attempt" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_key" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "learner_evidence" DROP CONSTRAINT "learner_evidence_objective_id_objective_id_fk";--> statement-breakpoint
ALTER TABLE "learner_evidence" ADD CONSTRAINT "learner_evidence_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "public"."objective"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_task_id_task_id_fk";--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_evidence" DROP CONSTRAINT "learner_evidence_learner_id_id_pk";--> statement-breakpoint
ALTER TABLE "learner_evidence" ADD CONSTRAINT "learner_evidence_learner_id_organization_id_id_pk" PRIMARY KEY("learner_id","organization_id","id");--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_learner_id_id_pk";--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_learner_id_organization_id_id_pk" PRIMARY KEY("learner_id","organization_id","id");--> statement-breakpoint
DROP INDEX "learner_evidence_replay_idx";--> statement-breakpoint
CREATE INDEX "learner_evidence_replay_idx" ON "learner_evidence" USING btree ("learner_id","organization_id","at","id");
