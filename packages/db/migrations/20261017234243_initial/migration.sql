CREATE TYPE "learner_evidence_outcome" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
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
	"id" text PRIMARY KEY,
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
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY,
	"token" text UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL UNIQUE,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}'::text[],
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_domain" (
	"hostname" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_id" bigint,
	CONSTRAINT "organization_domain_hostname_lowercase" CHECK ("hostname" = lower("hostname"))
);
--> statement-breakpoint
CREATE TABLE "organization_domain_claim" (
	"hostname" text PRIMARY KEY,
	"id" bigint UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "organization_domain_claim_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_domain_claim_hostname_lowercase" CHECK ("hostname" = lower("hostname"))
);
--> statement-breakpoint
CREATE TABLE "learner_handoff" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"hostname" text NOT NULL,
	"return_path" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"user_id" text,
	"code_hash" text UNIQUE,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learner_session" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"hostname" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learner_sign_in_code" (
	"hostname" text,
	"email" text,
	"organization_id" text NOT NULL,
	"code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learner_sign_in_code_pkey" PRIMARY KEY("hostname","email")
);
--> statement-breakpoint
CREATE TABLE "ai_request" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" text,
	"learner_id" text,
	"organization_id" text,
	"task_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "attempt_pkey" PRIMARY KEY("learner_id","organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"key" text,
	"number" integer NOT NULL,
	"url_label" text,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "course_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "course_objective" (
	"organization_id" text NOT NULL,
	"course_id" text,
	"objective_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "course_objective_pkey" PRIMARY KEY("course_id","objective_id")
);
--> statement-breakpoint
CREATE TABLE "file" (
	"organization_id" text,
	"sha256" text,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_pkey" PRIMARY KEY("organization_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "learner_evidence" (
	"id" text,
	"learner_id" text,
	"organization_id" text,
	"objective_id" text NOT NULL,
	"outcome" "learner_evidence_outcome" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "learner_evidence_pkey" PRIMARY KEY("learner_id","organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "objective" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"key" text,
	CONSTRAINT "objective_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "objective_citation" (
	"organization_id" text NOT NULL,
	"objective_id" text,
	"source_id" text,
	"start" integer,
	"end" integer,
	CONSTRAINT "objective_citation_pkey" PRIMARY KEY("objective_id","source_id","start","end")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text PRIMARY KEY,
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
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"replaces_task_id" text,
	CONSTRAINT "task_organization_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_citation" (
	"organization_id" text NOT NULL,
	"task_id" text,
	"source_id" text,
	"start" integer,
	"end" integer,
	CONSTRAINT "task_citation_pkey" PRIMARY KEY("task_id","source_id","start","end")
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" ("user_code");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauth_access_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauth_client" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauth_client_resource" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauth_client_resource" ("resource_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauth_refresh_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauth_refresh_token" ("authorization_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "organization_domain_organization_idx" ON "organization_domain" ("organization_id","registered_at");--> statement-breakpoint
CREATE INDEX "organization_domain_claim_organization_idx" ON "organization_domain_claim" ("organization_id","claimed_at");--> statement-breakpoint
CREATE INDEX "learner_handoff_expires_at_idx" ON "learner_handoff" ("expires_at");--> statement-breakpoint
CREATE INDEX "learner_session_expires_at_idx" ON "learner_session" ("expires_at");--> statement-breakpoint
CREATE INDEX "learner_session_user_id_idx" ON "learner_session" ("user_id");--> statement-breakpoint
CREATE INDEX "learner_session_organization_id_idx" ON "learner_session" ("organization_id");--> statement-breakpoint
CREATE INDEX "learner_sign_in_code_expires_at_idx" ON "learner_sign_in_code" ("expires_at");--> statement-breakpoint
CREATE INDEX "learner_sign_in_code_organization_id_idx" ON "learner_sign_in_code" ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_request_organization_created_idx" ON "ai_request" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "attempt_learner_task_idx" ON "attempt" ("learner_id","task_id","at");--> statement-breakpoint
CREATE INDEX "course_organization_idx" ON "course" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "course_organization_key_uidx" ON "course" ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "course_organization_number_uidx" ON "course" ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "course_objective_position_uidx" ON "course_objective" ("course_id","position");--> statement-breakpoint
CREATE INDEX "learner_evidence_replay_idx" ON "learner_evidence" ("learner_id","organization_id","at","id");--> statement-breakpoint
CREATE INDEX "objective_organization_idx" ON "objective" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "objective_organization_key_uidx" ON "objective" ("organization_id","key");--> statement-breakpoint
CREATE INDEX "objective_citation_source_idx" ON "objective_citation" ("source_id");--> statement-breakpoint
CREATE INDEX "source_organization_idx" ON "source" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_organization_digest_uidx" ON "source" ("organization_id","digest");--> statement-breakpoint
CREATE INDEX "task_replaces_task_idx" ON "task" ("replaces_task_id");--> statement-breakpoint
CREATE INDEX "task_objective_idx" ON "task" ("objective_id","created_at","id");--> statement-breakpoint
CREATE INDEX "task_citation_source_idx" ON "task_citation" ("source_id");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_dn2L1gs9Dolm_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_domain" ADD CONSTRAINT "organization_domain_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_domain_claim" ADD CONSTRAINT "organization_domain_claim_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_handoff" ADD CONSTRAINT "learner_handoff_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_handoff" ADD CONSTRAINT "learner_handoff_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_session" ADD CONSTRAINT "learner_session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_session" ADD CONSTRAINT "learner_session_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_sign_in_code" ADD CONSTRAINT "learner_sign_in_code_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_learner_id_user_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "task"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "course_objective" ADD CONSTRAINT "course_objective_course_fk" FOREIGN KEY ("organization_id","course_id") REFERENCES "course"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_objective" ADD CONSTRAINT "course_objective_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "objective"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "learner_evidence" ADD CONSTRAINT "learner_evidence_learner_id_user_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learner_evidence" ADD CONSTRAINT "learner_evidence_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "objective"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "objective" ADD CONSTRAINT "objective_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "objective_citation" ADD CONSTRAINT "objective_citation_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "objective"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "objective_citation" ADD CONSTRAINT "objective_citation_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "source"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_original_fk" FOREIGN KEY ("organization_id","original") REFERENCES "file"("organization_id","sha256") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_objective_fk" FOREIGN KEY ("organization_id","objective_id") REFERENCES "objective"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_replaces_task_fk" FOREIGN KEY ("organization_id","replaces_task_id") REFERENCES "task"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task_citation" ADD CONSTRAINT "task_citation_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "task"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task_citation" ADD CONSTRAINT "task_citation_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "source"("organization_id","id") ON DELETE RESTRICT;