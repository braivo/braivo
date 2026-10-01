# 0005: PostgreSQL and Drizzle, with committed SQL migrations

Status: accepted (2026-09-16)

## Context

Braivo is a self-hostable product, so the schema and the migrations needed to run it belong in this repository, not in Braivo Cloud's own code. What is needed is a relational database, a TypeScript query layer, and schema changes that are reviewable in a pull request and replayable by an existing installation.

The domain model is not designed yet. Choosing storage does not require choosing tables.

## Decision

Use **PostgreSQL** with **Drizzle ORM**. Define the current schema in TypeScript; generate migrations with Drizzle Kit; commit the generated directory in full, including Drizzle's metadata.

It all lives in `packages/db` ([ADR 0003](0003-workspace-layout.md)), while the queries stay with the server code that asks them.

```text
packages/db/
├── drizzle.config.ts
├── migrations/              # committed in full, including meta/
├── schema/                  # auth.ts is Better Auth's CLI output; the rest is Braivo's
├── database.ts
└── migrate.ts
```

The schema is source; migrations are its committed history, so they sit beside it rather than inside it. Nothing is published, so "the installed package location" below means wherever the code runs from.

Two audiences, two commands:

- Maintainers run `bun run db:generate`, **read the generated SQL**, and commit schema and migration together. Correct generated SQL only where the resulting database still matches the TypeScript schema. Backfills and transformations every installation must run are custom migrations, except a structural backfill (below); an environment-specific repair is an operational script, not something every future installation replays. Structural DDL the TypeScript schema cannot express is an exception to justify, not the normal escape hatch, because it makes the TypeScript schema stop being the whole schema. Drizzle's snapshots are never hand-edited: they are what the next diff is computed against.
- Installations run `braivo db migrate` (`bun run db:migrate` from a checkout, [ADR 0002](0002-agpl-only.md)), which applies committed migrations through `drizzle-orm`'s migrator. Drizzle Kit stays a devDependency and is never part of a deployment.

A **structural backfill** may go into the generated migration whose constraint it makes valid. It is structural when it exists only to satisfy the new schema and derives every value deterministically from relational data already valid in the database, as when a new required column is filled from a row each record already references. Drizzle Kit adds such a column `NOT NULL` at once, which fails on any existing row, and does not always order its statements runnably; splitting and reordering them around the backfill keeps one schema change in one migration, where three would leave two snapshots of a schema no code uses. It requires:

- a comment at the top of the migration saying what was changed by hand;
- a database built through the migration chain with the same columns, constraints, and indexes as one built from a migration generated afresh from the schema, hand-written exceptions aside. `drizzle-kit generate` answering "No schema changes" is not this check: it compares snapshots, never the SQL;
- the upgrade tested from the preceding migration, on rows the backfill must fill.

A custom or staged migration stays right for a backfill that carries a judgment (converting content, recomputing values, calling a model) or is too large for one transaction.

`drizzle-kit push` is not part of the workflow. It changes a database without leaving a committed migration, so Braivo-owned schema in a persistent database changes only through committed migrations applied by `braivo db migrate`.

Applied migrations are recorded in `drizzle.__braivo_migrations`, with both the table and its schema set explicitly rather than left to Drizzle's defaults, so Braivo's history cannot collide with that of another Drizzle application sharing the database — an application Braivo is embedded in, or later Braivo Cloud.

`braivo db migrate` resolves its migrations directory from the installed package location, never from the working directory the CLI was invoked in. Keeping the operation behind Braivo's own command leaves room to add compatibility checks or replace the machinery without changing deployment instructions.

Schema follows implemented domain requirements. No tables are defined in advance of the behavior that needs them, because names like `knowledge_estimate` would make unresolved domain questions look settled — whether estimates are stored, computed, or derived from evidence is exactly what is still open.

Whichever codebase defines a database object owns its migrations. Any change to a `braivo` table, column, index, or constraint is made by a migration in `braivo`, even when a Braivo Cloud requirement motivates it. Braivo Cloud's own code creates its own tables; where it shares a database with Braivo, those tables may reference `braivo`'s by foreign key.

The scaffolding above lands with the first real table, not before; this ADR precedes the implementation.

## Consequences

- `braivo db migrate` applies pending migrations in one transaction (Drizzle's migrator does), so a schema change and its structural backfill apply together or not at all. SQL run by other means has whatever atomicity that gives it.
- PostgreSQL and Drizzle become implementation dependencies of `braivo`. Self-hosting requires a PostgreSQL instance.
- Generated migrations must be read before they are committed. Drizzle Kit diffs schema snapshots, which cannot tell a rename from a drop plus an add, so it asks; answering that prompt and accepting the resulting DDL, destructive statements included, is the maintainer's call.
- Drizzle Kit generates forward migrations only. Rollback is handled deliberately when a migration carries meaningful risk, not by a generated down file.
- The migrations are ordinary SQL and stay readable and executable without the ORM, but switching migration tooling later would still require reconciling applied-migration history, whose bookkeeping differs per tool.
- If Braivo Cloud ever needs a column on a `braivo` table, that is a signal to decide whether the concept belongs to the product — not a reason for its own code to alter the table from its own migrations. Tenant storage stays undecided ([ADR 0006](0006-better-auth.md) records the identity model that decision will build on).
