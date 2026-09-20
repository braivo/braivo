// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The database a Braivo installation runs on: its client, and the migrations
// that shape it. Tables are imported from `@braivo/db/schema`, and queries live
// with the code that asks them — this package stores learning data but holds no
// learning behaviour and imports nothing from the domain, so that the schema can
// change without dragging the domain along.
// See docs/adr/0005-postgresql-drizzle.md and docs/adr/0003-workspace-layout.md.

export type { Database } from "./database.ts";
export { createDatabase } from "./database.ts";
export { runMigrations } from "./migrate.ts";
