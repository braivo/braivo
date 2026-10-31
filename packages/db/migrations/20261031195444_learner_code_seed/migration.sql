ALTER TABLE "learner_sign_in_code" ADD COLUMN "code_seed" text;--> statement-breakpoint
ALTER TABLE "learner_sign_in_code" DROP COLUMN "code_hash";