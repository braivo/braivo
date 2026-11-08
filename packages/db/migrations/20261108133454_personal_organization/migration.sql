ALTER TABLE "organization" ADD COLUMN "personal_owner_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_personal_owner_id_key" UNIQUE("personal_owner_id");--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_personal_owner_id_user_id_fkey" FOREIGN KEY ("personal_owner_id") REFERENCES "user"("id") ON DELETE RESTRICT;