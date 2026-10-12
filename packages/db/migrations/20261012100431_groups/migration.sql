CREATE TYPE "group_role" AS ENUM('learner', 'teacher');--> statement-breakpoint
CREATE TABLE "group" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"key" text,
	"creation_digest" text NOT NULL,
	CONSTRAINT "group_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "group_course" (
	"organization_id" text NOT NULL,
	"group_id" text,
	"course_id" text,
	CONSTRAINT "group_course_pkey" PRIMARY KEY("group_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "group_member" (
	"organization_id" text NOT NULL,
	"group_id" text,
	"user_id" text,
	"role" "group_role" NOT NULL,
	CONSTRAINT "group_member_pkey" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "group_organization_idx" ON "group" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_organization_key_uidx" ON "group" ("organization_id","key");--> statement-breakpoint
CREATE INDEX "group_course_course_idx" ON "group_course" ("course_id");--> statement-breakpoint
CREATE INDEX "group_member_user_idx" ON "group_member" ("user_id","role");--> statement-breakpoint
ALTER TABLE "group" ADD CONSTRAINT "group_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_course" ADD CONSTRAINT "group_course_group_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "group"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_course" ADD CONSTRAINT "group_course_course_fk" FOREIGN KEY ("organization_id","course_id") REFERENCES "course"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_group_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "group"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "member"("organization_id","user_id") ON DELETE CASCADE;