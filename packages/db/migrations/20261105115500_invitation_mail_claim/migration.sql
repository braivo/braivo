CREATE TABLE "invitation_mail_claim" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invitation_mail_claim_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"organization_id" text,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "invitation_mail_claim_email_claimed_at_idx" ON "invitation_mail_claim" ("email","claimed_at");--> statement-breakpoint
CREATE INDEX "invitation_mail_claim_organization_id_claimed_at_idx" ON "invitation_mail_claim" ("organization_id","claimed_at");--> statement-breakpoint
CREATE INDEX "invitation_mail_claim_claimed_at_idx" ON "invitation_mail_claim" ("claimed_at");--> statement-breakpoint
ALTER TABLE "invitation_mail_claim" ADD CONSTRAINT "invitation_mail_claim_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL;