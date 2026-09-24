CREATE TABLE "attempt" (
	"id" text NOT NULL,
	"learner_id" text NOT NULL,
	"task_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "attempt_learner_id_id_pk" PRIMARY KEY("learner_id","id")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "public"."objective"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_learner_task_idx" ON "attempt" USING btree ("learner_id","task_id","at");--> statement-breakpoint
CREATE INDEX "task_objective_idx" ON "task" USING btree ("objective_id","created_at","id");