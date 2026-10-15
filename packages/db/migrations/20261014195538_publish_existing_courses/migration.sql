-- Custom (ADR 0005): what exists when publication lands is published
-- (ADR 0039), so every course this runs on reaches its learners as before.
-- Courses created afterwards wait unless a person creates them in the console.
UPDATE "course" SET "published_at" = now() WHERE "published_at" IS NULL;
