-- Changed by hand (ADR 0005, structural backfill): `number` is added nullable,
-- existing courses numbered 1000, 1001, … within each organization in ID
-- order, then made required. Numbers allocated afterwards are random.
ALTER TABLE "course" ADD COLUMN "number" integer;--> statement-breakpoint
UPDATE "course" SET "number" = "numbered"."number" FROM (
	SELECT "id", 999 + row_number() OVER (PARTITION BY "organization_id" ORDER BY "id") AS "number" FROM "course"
) AS "numbered" WHERE "course"."id" = "numbered"."id";--> statement-breakpoint
ALTER TABLE "course" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "url_label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "course_organization_number_uidx" ON "course" ("organization_id","number");
