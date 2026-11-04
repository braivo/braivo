CREATE TABLE "learner_history_state" (
	"learner_id" text,
	"organization_id" text,
	"epoch" integer NOT NULL,
	"erased_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learner_history_state_pkey" PRIMARY KEY("learner_id","organization_id")
);
--> statement-breakpoint
CREATE INDEX "learner_history_state_organization_id_idx" ON "learner_history_state" ("organization_id");--> statement-breakpoint
ALTER TABLE "learner_history_state" ADD CONSTRAINT "learner_history_state_learner_id_user_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_history_state" ADD CONSTRAINT "learner_history_state_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;