CREATE TABLE "apple_link" (
	"id_hash" text PRIMARY KEY,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"refresh_token" text,
	"refresh_token_client_id" text,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refresh_token_client_id" text;--> statement-breakpoint
CREATE INDEX "apple_link_expires_at_idx" ON "apple_link" ("expires_at");--> statement-breakpoint
CREATE INDEX "apple_link_email_idx" ON "apple_link" ("email");--> statement-breakpoint
CREATE INDEX "apple_link_subject_idx" ON "apple_link" ("subject");