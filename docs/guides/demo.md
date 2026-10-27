# The development demo

A populated Braivo for this worktree: Fernwood School, with an administrator, an author, a teacher, and two learners who have practised, a short source-backed course, and a group. Sign in as any of them, exercise the real apps, and reset to the baseline when you choose. It never touches your development database, your test database, or another worktree's demo ([ADR 0043](../adr/0043-development-demo.md)).

## Launch

Requires a local PostgreSQL whose role may create databases (`createdb` works). Name a database on it to connect through, once, in `.env` or your shell; the demo creates its own database beside it:

```bash
echo 'BRAIVO_DEMO_DATABASE_URL=postgres://localhost/postgres' >> .env
bun run dev:demo
```

The first launch checks it can connect and create databases there, then creates the demo's own database, `braivo_demo_<id>`, migrates and seeds it, checks it, and serves it; later launches serve it as you left it. Once the servers listen, it prints:

```text
Braivo demo 9f3c1a7e5b20, scenario 3, seeded 2026-10-12T09:00:00.000Z
  Console  http://127.0.0.1:5184
  Learn    http://fernwood.localhost:5183
  Sign in with an email below; the server prints its code in the terminal running the demo ("Mail to …").
  As seeded:
    administrator admin@fernwood.example     Morgan Hale: owns Fernwood School: …
    author        author@fernwood.example    Riley Chen: prepares and publishes Fernwood's courses, …
    teacher       teacher@fernwood.example   Jordan Price: teaches Class A English: …
    sam           sam@fernwood.example       Sam Nowak: learns in Class A English: …
    zofia         zofia@fernwood.example     Zofia Wójcik: learns in Class A English: …
```

Rename the group or change a role, and the console shows your version; the list stays as seeded.

Sign in as anyone listed: enter the email, then the six-digit code from this terminal's log. The administrator, the author, and the teacher use the console; the learners sign in at the learn app's address. Use a separate browser profile or private window per person: one browser holds one sign-in per host. The demo's console is on `127.0.0.1`, so its sign-in stays apart from `bun run dev`'s on `localhost` (cookies ignore ports, not hosts).

The two learners practised in the hour before the demo was seeded, through the use cases the learn app calls (no browser), so they take different paths from there. Zofia answered each objective right the first time: caught up, with reviews falling due about a day later. Sam missed a greeting, typed one right when asked again, then missed a polite request: the learn app asks for it again next, this time typed, and shows the passage it comes from once answered. Their standings age with real time, as anyone's do.

To see practice reach a report: as a learner, answer a task; as the teacher, open **Groups**, then the course's **Progress**, and reload. To see what an author has ([ADR 0048](../adr/0048-author-role.md)): as the author, the console opens at **Courses**, with **Sources** beside it; they add material, review and publish, but find no Groups, Members, or other learners' progress. The console's links to where learners practise open the learn app at that address.

The demo serves 10 above each of the worktree's `bun run dev` ports (3010, 5183, and 5184 in the main checkout), so it runs beside them and beside other worktrees' demos. It keeps the ports it was created with: reset it to take new ones. Demos share cookies on `127.0.0.1` and `fernwood.localhost`, so use a browser profile per worktree's demo too. Ctrl-C stops the demo and only what it started.

## Check, migrate, reset

```bash
bun run dev:demo:verify                              # its state; changes nothing, running or not
bun run dev:demo --migrate                           # apply migrations this checkout added, then serve it
bun run dev:demo:reset --environment ENVIRONMENT_ID  # delete it; the next launch makes a new baseline
```

- **Pending migrations.** A launch stops and names them. Review them (a migration can change data), then `--migrate` applies them with the demo stopped, keeping your edits and practice.
- **Interrupted first launch.** The demo stays "not finished" and will not launch; reset it with the ID `verify` prints, then launch again.
- **Interrupted migration.** Nothing was applied: the migrations are still pending, and `--migrate` applies them.
- **Missing storage.** The launch refuses, as the data may name files that were there: restore `.dev-demo/storage/`, or reset.
- **Migrations this checkout lacks, or a new scenario.** The launch refuses: keep using the checkout that made the demo, or reset it for the new baseline. Nothing is reset or patched automatically.
- **A database without the demo's marker** (a crash right after creating it). Never adopted or dropped by the tools: inspect it, and `dropdb` it yourself if it is the demo's.
- **Wrong `BRAIVO_DEMO_DATABASE_URL` on the first launch.** Nothing is created: fix it and launch again.
- **An interrupted reset.** Run it again: it finishes what is left. If it then refuses `.dev-demo/` as incomplete, delete that empty directory.

Reset shows the database, ID, and storage it will delete, and needs that ID, the one `verify` prints: typed when asked, or `--environment`. It refuses while the demo runs, anything is connected to its database or listens on its ports, or `.dev-demo/` holds a file the demo did not put there. Afterwards old sign-ins stop working: close the demo's tabs.

## What it holds

Settings and secrets in `.dev-demo/environment.json` (gitignored, readable by you alone, never printed), uploaded files in `.dev-demo/storage/`, data in `braivo_demo_<id>`. The server runs on these alone, never `.env`: no mail server, AI key, Google client, or bucket reaches it. The apps' dev servers still load `.env`, but the demo's values override what their proxy reads from it, `BRAIVO_URL` and `PORT`. Remove a worktree's demo with reset before removing the worktree, or `dropdb` its database afterwards.

The classroom is a fixture, `apps/server/fixtures/classroom.ts`; `tooling/dev-demo/` creates, guards, and serves the demo ([ADR 0043](../adr/0043-development-demo.md)).
