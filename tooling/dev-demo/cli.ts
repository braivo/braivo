// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The worktree's demo: a populated Braivo to sign in to as an administrator,
 * an author, a teacher, or a learner, kept apart from the development database and every
 * other worktree's demo (docs/guides/demo.md, docs/adr/0043-development-demo.md).
 *
 *   bun run dev:demo [--migrate]                prepare it if new (or migrate it), then serve it
 *   bun run dev:demo:verify                     report its state, changing nothing
 *   bun run dev:demo:reset [--environment ID]   delete it, its ID confirmed
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { PERSONAS } from "../../apps/server/fixtures/classroom.ts";
import {
  assertStorage,
  consoleUrl,
  type Demo,
  DemoRefused,
  describeDatabase,
  incompatibilities,
  inspectDemo,
  learnUrl,
  lockDemo,
  type Marker,
  missingBaseline,
  portInUse,
  prepareDemo,
  readDemo,
  readOrCreateDemo,
  resetDemo,
  serverEnvironment,
} from "./environment.ts";

const ROOT = join(import.meta.dirname, "../..");

/**
 * What a child inherits: enough to find its tools and draw its output, never
 * this shell's Braivo, mail, Google, AI, or storage settings, nor `.env`'s,
 * which Bun loaded into this process.
 */
const INHERITED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
];

/** The demo's settings over the few inherited variables a process needs to run. */
export function childEnvironment(
  demo: Demo,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    ...serverEnvironment(demo),
    // For the console's links to the learn app; the server reads none of it.
    BRAIVO_LEARN_PORT: String(demo.ports.learn),
  };
}

async function launch(migrate: boolean): Promise<number> {
  const started = performance.now();
  const demo = await readOrCreateDemo(ROOT, process.env);
  const lock = await lockDemo(demo);
  try {
    const marker = await prepareDemo(lock, { migrate, now: new Date() });
    for (const port of Object.values(demo.ports)) {
      if (await portInUse(port)) {
        throw new DemoRefused(
          `Port ${port} is in use, probably by another worktree's demo: every demo serves on the same ports. Stop that one first.`,
        );
      }
    }
    console.log(`Prepared in ${((performance.now() - started) / 1000).toFixed(1)} s. Starting…\n`);
    return await serve(demo, lock.lost, () => printDemo(demo, marker));
  } finally {
    await lock.release();
  }
}

/**
 * Runs the server and both apps until one stops, one does not listen within
 * a minute, the lock's connection is lost, or this process is asked to stop;
 * then stops what it started, and only that. `ready` runs once all three
 * listen: on ports checked free before they started, so theirs.
 */
async function serve(demo: Demo, lockLost: Promise<Error>, ready: () => void): Promise<number> {
  // Before anything starts, so a signal while starting still stops it all.
  // Children do not share this terminal's group, so Ctrl-C reaches only this.
  const stopped = new Promise<string>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve(""));
  });
  const environment = childEnvironment(demo, process.env);
  const vite = join(ROOT, "node_modules/.bin/vp");
  const commands = [
    {
      name: "server",
      // Without Bun's `.env` loading, which would add what `environment` leaves out.
      command: [process.execPath, "--no-env-file", "--watch", "apps/server/cli/index.ts", "serve"],
      cwd: ROOT,
    },
    ...(["learn", "console"] as const).map((app) => ({
      name: app,
      // Under Node, as `vp` is; its `loadEnv` lets these variables override `.env`'s.
      // On IPv4, where `consoleUrl` and `fernwood.localhost` both reach it.
      command: [
        vite,
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(demo.ports[app]),
        "--strictPort",
      ],
      cwd: join(ROOT, "apps", app),
    })),
  ];
  const children: { name: string; process: Bun.Subprocess }[] = [];
  try {
    for (const { name, command, cwd } of commands) {
      children.push({
        name,
        process: Bun.spawn(command, {
          cwd,
          env: environment,
          // A process group of its own, so stopping it reaches what it started
          // too: `vp` runs Vite in a child, which outlives a signal to `vp` alone.
          detached: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      });
    }
  } catch (error) {
    await Promise.all(children.map(({ process: child }) => stopGroup(child.pid)));
    throw error;
  }

  let serving = true;
  const listening = waitUntilListening(Object.values(demo.ports), () => serving).then(
    (listening) => {
      if (!serving) return "";
      if (!listening) return "Not every server listened within a minute, so the demo stops.";
      ready();
      return new Promise<string>(() => {});
    },
  );
  const reason = await Promise.race([
    stopped,
    listening,
    lockLost.then((error) => `The demo's lock was lost (${error.message}), so it stops.`),
    ...children.map(async ({ name, process: child }) => {
      const code = await child.exited;
      return `The ${name} stopped (exit code ${code}), so the demo stops.`;
    }),
  ]);

  serving = false;
  await Promise.all(children.map(({ process: child }) => stopGroup(child.pid)));
  if (reason) console.error(reason);
  return reason ? 1 : 0;
}

/**
 * Whether every port answers within a minute, while `serving`: the servers
 * are up, not merely started. Gives up as soon as serving stops.
 */
async function waitUntilListening(ports: number[], serving: () => boolean): Promise<boolean> {
  for (let waited = 0; waited < 60_000 && serving(); waited += 250) {
    if ((await Promise.all(ports.map(portInUse))).every(Boolean)) return true;
    await Bun.sleep(250);
  }
  return false;
}

/**
 * Stops a process group this launch started, and only that: asked first,
 * killed if it still runs after five seconds.
 */
async function stopGroup(leader: number): Promise<void> {
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-leader, name);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; // The group is gone.
      throw error;
    }
  };
  signal("SIGTERM");
  for (let waited = 0; waited < 5_000; waited += 100) {
    if (!signal(0)) return;
    await Bun.sleep(100);
  }
  signal("SIGKILL");
}

/**
 * Read-only: works with the demo stopped or running, and never repairs. Fails
 * when a launch would refuse; what the contributor deleted of the baseline is
 * noted, not failed.
 */
async function verify(): Promise<number> {
  const demo = readDemo(ROOT, process.env);
  if (!demo) {
    console.log("No demo in this worktree yet. `bun run dev:demo` creates one.");
    return 1;
  }
  const status = await inspectDemo(demo);
  const problems: string[] = [];
  const notes: string[] = [];
  switch (status.kind) {
    case "absent":
      problems.push(`its database does not exist: \`bun run dev:demo\` prepares it`);
      break;
    case "unowned":
    case "foreign":
      problems.push(`${demo.database} is not marked as this demo's: it is not treated as one`);
      break;
    case "initializing":
      problems.push(
        `preparing it did not finish: reset it (\`bun run dev:demo:reset --environment ${demo.id}\`), then launch again`,
      );
      break;
    case "ready": {
      const { marker, migrations } = status;
      problems.push(...incompatibilities(demo, marker, migrations));
      if (migrations.pending.length > 0) {
        problems.push(
          `migrations pending: ${migrations.pending.join(", ")}; \`bun run dev:demo --migrate\` applies them, then serves it`,
        );
      }
      try {
        assertStorage(demo);
      } catch (error) {
        problems.push((error as Error).message);
      }
      // Only on the schema and scenario this checkout knows, which its queries
      // and handles assume.
      if (problems.length === 0) {
        notes.push(...(await missingBaseline(demo, marker)));
        printDemo(demo, marker);
      }
    }
  }
  for (const note of notes) console.log(`Note: ${note}, since it was seeded.`);
  if (problems.length === 0) {
    console.log("Verified: ready to launch, or running.");
    return 0;
  }
  console.log(
    `Demo ${demo.id} (${describeDatabase(demo)}; files in ${demo.storage}) is not ready:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
  );
  return 1;
}

async function reset(confirmation: string | undefined): Promise<number> {
  const demo = readDemo(ROOT, process.env);
  if (!demo) {
    console.log("No demo in this worktree: nothing to reset.");
    return 0;
  }
  console.log(`Resetting deletes, for good:
  Environment  ${demo.id}
  Database     ${describeDatabase(demo)}
  Storage      ${demo.storage}
`);
  // Typed, never a generic yes: a script must name the demo it means to delete.
  const confirmed =
    confirmation ??
    (process.stdin.isTTY ? prompt("Type the environment ID to reset it:") : undefined);
  if (confirmed === undefined || confirmed === null) {
    throw new DemoRefused(`Confirm with --environment ${demo.id}. Nothing was changed.`);
  }
  const lock = await lockDemo(demo);
  try {
    await resetDemo(lock, { confirmed: confirmed.trim(), variables: process.env });
  } finally {
    await lock.release();
  }
  console.log(
    "Reset. Old sign-ins no longer work: close the demo's tabs, or use a fresh browser profile. `bun run dev:demo` prepares a new one.",
  );
  return 0;
}

function printDemo(demo: Demo, marker: Marker): void {
  const people = Object.entries(PERSONAS).map(
    ([persona, { email, name, scope }]) =>
      `    ${persona.padEnd(14)}${email.padEnd(27)}${name}: ${scope}`,
  );
  console.log(`
Braivo demo ${demo.id}, scenario ${marker.scenario}, seeded ${marker.anchor?.toISOString()}
  Console  ${consoleUrl(demo)}
  Learn    ${learnUrl(demo)}
  Sign in with an email below; the server prints its code in the terminal running the demo ("Mail to …").
  As seeded:
${people.join("\n")}
  Data     ${describeDatabase(demo)}; files in ${demo.storage}
`);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { migrate: { type: "boolean" }, environment: { type: "string" } },
  });
  const [command = "launch", ...rest] = positionals;
  if (rest.length > 0) throw new DemoRefused(`Unexpected "${rest.join(" ")}".`);
  if (command === "launch" && values.environment === undefined) {
    return launch(values.migrate ?? false);
  }
  if (command === "verify" && !values.migrate && values.environment === undefined) return verify();
  if (command === "reset" && !values.migrate) return reset(values.environment);
  throw new DemoRefused(
    "Usage: bun run dev:demo [--migrate] | dev:demo:verify | dev:demo:reset [--environment ID]",
  );
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof DemoRefused ? error.message : error);
    process.exitCode = 1;
  }
}
