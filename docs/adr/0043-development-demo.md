# 0043: A demo per worktree, in a database it created and marked, prepared once

Status: proposed (2026-10-12)

## Context

Exercising Braivo as an administrator, a teacher, and a learner needs an organization with people, a course, and a group. Building one by hand takes a dozen steps, and the development database a contributor already has (`DATABASE_URL`) holds their own work, which no tool should touch. `seedOrganization` (`packages/db/testing.ts`) suits suites, not people: it clears an organization's learning data and replaces its memberships each time. Worktrees already test against databases of their own ([ADR 0014](0014-worktree-setup.md)), but share the development database and ports.

## Decision

**`bun run dev:demo` serves a worktree's demo: a classroom in a PostgreSQL database and a storage directory of its own, prepared on first launch and kept across launches.** `dev:demo:verify` reports its state without changing it, `dev:demo --migrate` applies pending migrations to it before serving it, and `dev:demo:reset --environment ENVIRONMENT_ID` deletes it. The classroom is a fixture, `apps/server/fixtures/classroom.ts`, built through the use cases the apps call and seedable by tests too; the environment, `tooling/dev-demo/environment.ts`, and the commands, `tooling/dev-demo/cli.ts`, are development tooling. How to use it: [the demo guide](../guides/demo.md).

**Ownership is a random ID, never a name or a path.** The first launch checks the target accepts the connection and may create databases, then writes `.dev-demo/environment.json` (the ID, worktree, database, storage, ports, auth secret, and PostgreSQL target; mode 0600, one file so no half of it outlives the other) by renaming a finished directory into place, so racing launches agree on one. It creates `braivo_demo_<id>` and, in one transaction, its marker `dev_demo.environment` (ID, worktree, storage, state, scenario version, anchor, handles), outside Braivo's schema and migrations. The storage directory holds a file naming the ID. Settings copied from another worktree or malformed, a `.dev-demo` that is a link, a different target, a database without the marker or with another's, and storage that is a link or unmarked are refused, never adopted, served, or deleted.

**The target is chosen once, explicitly.** `BRAIVO_DEMO_DATABASE_URL` names a database on a loopback PostgreSQL to connect through, with no `host` parameter to redirect it; never `DATABASE_URL`. It is persisted at creation, and a different value later is refused.

**One lock, which every writing operation requires.** A PostgreSQL session advisory lock on the target, keyed by the ID: preparing, migrating, and resetting take it as an argument and check it is still held before every step that writes, and a launch holds it for as long as it serves. PostgreSQL releases it when the connection ends, so a crashed holder leaves no stale lock; one whose connection was cut writes nothing more, and a launch that loses it stops its servers. Migrating and resetting also require no connection to the demo's database and nothing listening on its ports, over IPv4 or IPv6, so servers that outlived their launcher still block them.

**States, not a recovery engine.** A new demo is `initializing` until it is migrated, seeded, and its baseline checked through the apps' use cases, then `ready`, which the marker's table refuses without the anchor and handles it was seeded with. A demo left `initializing` is refused until reset. Migrating needs no state of its own: Drizzle applies every pending migration in one transaction, so an interrupted `--migrate` leaves them pending, and launches refuse them as before. A ready demo launches as it is, edits and practice kept, once its storage is checked: present and marked, never recreated, as its data may name files that were in it. Pending migrations stop a launch until `--migrate`; migrations this checkout lacks, or a different scenario version, stop it until the contributor keeps the old checkout or resets. The scenario version changes only when an existing demo can no longer serve as the baseline. What the contributor deleted of the baseline is theirs to delete: verify notes it, and does not fail.

**Reset checks everything, then deletes in an order a rerun finishes.** The ID confirmed, the database neither the development nor a test one, its marker the demo's, `.dev-demo/` holding only the demo's files, storage owned, nothing connected or listening: then the database, the storage, the settings, the directory. Each step tolerates an earlier reset's, so a reset interrupted before the settings go is finished by running it again; one interrupted after them leaves an empty `.dev-demo/` to delete.

**The server runs on the demo's settings alone.** Children get an allowlisted environment (`PATH`, `HOME`, and a few others) plus the demo's database, secret, `BRAIVO_URL`, port, and storage, and the server runs with `bun --no-env-file`, so no mail server, AI key, Google client, or bucket is used: sign-in codes are logged, as on any loopback installation ([ADR 0033](0033-email-over-smtp.md)). The apps' dev servers still load `.env` as their configurations do; their proxy reads `BRAIVO_URL` and `PORT`, which `loadEnv` lets the demo's values override. `BRAIVO_URL` is the console's on `127.0.0.1`, not `localhost`. Ports are fixed at 3100, 5183, and 5184, beside `bun run dev`'s; two worktrees' demos collide and the second refuses to start. Each child runs in a process group of its own, which the launch stops whole on Ctrl-C, on a child's exit, or on losing its lock.

## Alternatives rejected

- **Reusing `seedOrganization` or the development database.** It clears and replaces what a contributor made; the point is a demo kept until deliberately reset.
- **A default target such as `postgres://localhost/postgres`.** Localhost can be a tunnel to a server that is not disposable; creating databases needs the contributor's choice.
- **Keeping the demo's settings in `tmp/`.** It is scratch space, cleared freely; losing the secret and target there would strand the database. `local/` is shared by every worktree.
- **The environment in the server package.** It manages files, locks, and processes of a development machine, nothing the server runs; only the classroom uses the server's use cases.
- **A lock file.** It goes stale when a process dies, and recovering it safely needs the checks the database lock makes unnecessary.
- **Seeding in one transaction to make preparation retryable.** The use cases and Better Auth each take a pool, not a transaction; an interrupted preparation is rare, and nothing in it is worth keeping, so resetting it is simpler.
- **Patching a demo up to a new scenario, or reconciling migration histories.** Either guesses at a contributor's edits; refusing and saying what to do does not.
- **A console hostname of its own, such as `demo.localhost`, to keep its cookies apart.** Logged sign-in codes are allowed only on a loopback `BRAIVO_URL` (`localhost`, `127.0.0.1`, `[::1]`); widening that is a product decision, not the demo's. `127.0.0.1` already is one.
- **Different ports per worktree.** Not needed yet; persisted ports leave room for it.
- **`.braivo/demo/` instead of `.dev-demo/`.** A namespace with one tenant, and a name a product CLI may want in users' projects; a nested path would also make the rename into place and reset manage a shared parent.

## Consequences

- A demo is local to its worktree and target: `.dev-demo/` is gitignored and never copied by worktree setup. Removing a worktree without resetting its demo leaves its database for a manual `dropdb`, as a test database's.
- Reset requires the ID typed, or `--environment` matching it; a new launch then makes a new ID and secret, so old sessions stop working.
- Cookies ignore ports but not hosts: the demo's console, on `127.0.0.1`, keeps its sign-in apart from `bun run dev`'s on `localhost`. One browser profile still holds one sign-in per host, so each persona needs its own.
- Google sign-in and the learn domain's HTTPS handoff do not run locally (access spec, gaps); learners sign in by code at `fernwood.localhost:5183`. On the console's dev server, its links to a `.localhost` learn domain keep the hostname and path but use HTTP and the learn app's port, `BRAIVO_LEARN_PORT` (the demo's, or `bun run dev`'s 5173), so they open and copy `http://fernwood.localhost:5183/…`, shown without the scheme as in production; other hostnames and a build's links are HTTPS, and the server's host checks are unchanged.
- A launcher killed outright leaves its servers running; migrating and resetting refuse until they are stopped.
