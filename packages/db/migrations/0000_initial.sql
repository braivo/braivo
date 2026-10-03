CREATE TYPE "public"."learner_evidence_outcome" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_domain" (
	"hostname" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "organization_domain_hostname_lowercase" CHECK ("organization_domain"."hostname" = lower("organization_domain"."hostname"))
);
--> statement-breakpoint
CREATE TABLE "learner_handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"hostname" text NOT NULL,
	"return_path" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"user_id" text,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learner_handoff_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "learner_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"hostname" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_request" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" text NOT NULL,
	"learner_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "attempt_learner_id_organization_id_id_pk" PRIMARY KEY("learner_id","organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"key" text,
	CONSTRAINT "course_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "course_objective" (
	"organization_id" text NOT NULL,
	"course_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "course_objective_course_id_objective_id_pk" PRIMARY KEY("course_id","objective_id")
);
--> statement-breakpoint
CREATE TABLE "file" (
	"organization_id" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_organization_id_sha256_pk" PRIMARY KEY("organization_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "learner_evidence" (
	"id" text NOT NULL,
	"learner_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"outcome" "learner_evidence_outcome" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "learner_evidence_learner_id_organization_id_id_pk" PRIMARY KEY("learner_id","organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "objective" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"key" text,
	CONSTRAINT "objective_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "objective_citation" (
	"organization_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"source_id" text NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	CONSTRAINT "objective_citation_objective_id_source_id_start_end_pk" PRIMARY KEY("objective_id","source_id","start","end")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"url" text,
	"language" text,
	"timing" jsonb,
	"pagination" jsonb,
	"original" text,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "task_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_citation" (
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_id" text NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	CONSTRAINT "task_citation_task_id_source_id_start_end_pk" PRIMARY KEY("task_id","source_id","start","end")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_domain" ADD CONSTRAINT "organization_domain_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_handoff" ADD CONSTRAINT "learner_handoff_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_handoff" ADD CONSTRAINT "learner_handoff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_session" ADD CONSTRAINT "learner_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_session" ADD CONSTRAINT "learner_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_objective" ADD CONSTRAINT "course_objective_course_fk" FOREIGN KEY ("organization_id","course_id") REFERENCES "public"."course"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_objective" ADD CONSTRAINT "course_objective_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "public"."objective"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_evidence" ADD CONSTRAINT "learner_evidence_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_evidence" ADD CONSTRAINT "learner_evidence_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "public"."objective"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective" ADD CONSTRAINT "objective_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_citation" ADD CONSTRAINT "objective_citation_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "public"."objective"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_citation" ADD CONSTRAINT "objective_citation_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."source"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_original_fk" FOREIGN KEY ("organization_id","original") REFERENCES "public"."file"("organization_id","sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "public"."objective"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_citation" ADD CONSTRAINT "task_citation_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_citation" ADD CONSTRAINT "task_citation_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."source"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domain_organization_idx" ON "organization_domain" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "learner_handoff_expires_at_idx" ON "learner_handoff" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "learner_session_expires_at_idx" ON "learner_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "learner_session_user_id_idx" ON "learner_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "learner_session_organization_id_idx" ON "learner_session" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_request_organization_created_idx" ON "ai_request" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "attempt_learner_task_idx" ON "attempt" USING btree ("learner_id","task_id","at");--> statement-breakpoint
CREATE INDEX "course_organization_idx" ON "course" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "course_organization_key_uidx" ON "course" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "course_objective_position_uidx" ON "course_objective" USING btree ("course_id","position");--> statement-breakpoint
CREATE INDEX "learner_evidence_replay_idx" ON "learner_evidence" USING btree ("learner_id","organization_id","at","id");--> statement-breakpoint
CREATE INDEX "objective_organization_idx" ON "objective" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "objective_organization_key_uidx" ON "objective" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "objective_citation_source_idx" ON "objective_citation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_organization_idx" ON "source" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_organization_digest_uidx" ON "source" USING btree ("organization_id","digest");--> statement-breakpoint
CREATE INDEX "task_objective_idx" ON "task" USING btree ("objective_id","created_at","id");--> statement-breakpoint
CREATE INDEX "task_citation_source_idx" ON "task_citation" USING btree ("source_id");