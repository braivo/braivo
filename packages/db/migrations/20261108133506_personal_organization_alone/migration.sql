-- A personal organization admits no one but its owner, and no invitation at all
-- (docs/adr/0060-personal-organization-is-one-accounts.md), whichever writer
-- tries: Better Auth's invitations, acceptance, and add-member, Braivo's
-- make-owner, and any added later. Writers refuse first, in words; this holds
-- the ones that do not. The organization's `personal_owner_id` never changes,
-- so reading it needs no lock.
CREATE FUNCTION braivo_refuse_personal_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "organization"
    WHERE "id" = NEW."organization_id" AND "personal_owner_id" <> NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'PERSONAL_ORGANIZATION: a personal organization has no member but its owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'member_personal_organization_owner_only';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "member_personal_organization_owner_only"
  BEFORE INSERT OR UPDATE OF "organization_id", "user_id" ON "member"
  FOR EACH ROW EXECUTE FUNCTION braivo_refuse_personal_member();--> statement-breakpoint
CREATE FUNCTION braivo_refuse_personal_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "organization"
    WHERE "id" = NEW."organization_id" AND "personal_owner_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PERSONAL_ORGANIZATION: a personal organization takes no invitation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invitation_personal_organization_none';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "invitation_personal_organization_none"
  BEFORE INSERT OR UPDATE OF "organization_id" ON "invitation"
  FOR EACH ROW EXECUTE FUNCTION braivo_refuse_personal_invitation();
