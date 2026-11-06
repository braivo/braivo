#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { open, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { createDatabase, runMigrations } from "@braivo/db";

import {
  type AccountErasureCounts,
  type AiReportRow,
  eraseAccount,
  type ErasureCounts,
  type ErasureLog,
  eraseLearnerHistory,
  exportLearner,
  previewAccountErasure,
  previewHistoryErasure,
  previewOwnerPromotion,
  promoteToOwner,
  readAiReport,
  registerLearnDomain,
} from "../application/index.ts";
import {
  addMember,
  createAuth,
  createOrganization,
  generateReviewerPassword,
  registerOAuthClient,
  removeOAuthClient,
  removeReviewerPassword,
  setReviewerPassword,
} from "../auth/index.ts";
import {
  readAuthConfig,
  readDatabaseUrl,
  readErasureLogConfig,
  readServeConfig,
} from "../config.ts";
import { logMail, type SendMail, smtpMail } from "../mail/index.ts";
import { createServer } from "../server.ts";
import { bucketStore, directoryStore, durableDirectoryStore } from "../storage/index.ts";

/** For the operator's commands, which make no one sign in. */
const sendsNoMail: SendMail = () => Promise.reject(new Error("This command sends no email."));

const USAGE = `Usage: bun apps/server/cli/index.ts <command>

Running an installation (a content owner's commands are braivo's):
  ai report [--since <YYYY-MM-DD>] [--organization <slug>]
                Count the requests of the installation's AI since the date
                (UTC; this month's first by default), for one organization or
                all, by kind, model, and prompt version: how each went, and
                what drafts kept of what the model proposed. Reads no content.
  config check  Check the environment serve reads, printing its first problem;
                silent when there is none. Reaches no database.
  db migrate    Apply committed database migrations.
  organization create --name <name> --slug <slug> --owner <email>
                Create an organization owned by an existing account.
  organization add-member --slug <slug> --email <email> [--role member|author|admin]
                Add an existing account as a learner (member, the default),
                an author of its content (author), or an administrator (admin).
  organization make-owner --slug <slug> --email <email> [--yes]
                Make an existing member an owner too, on the organization's
                instruction: shows the database, the organization, the account,
                and its role, and asks for the slug typed back unless --yes.
                Never adds a member or removes an owner. No command demotes an owner.
  organization add-domain --slug <slug> --hostname <hostname>
                Register <hostname> for the organization's learn app, the
                one it is named by from now on, its earlier ones still
                serving; DNS, TLS, and routing it here are set up outside
                Braivo.
  oauth-client add --name <name> --redirect-uri <uri>... [--client-id <id>]
                Register a remote MCP client, public with PKCE, and print
                its ID; the only way in where client ID metadata documents
                are not fetched. One --redirect-uri per callback: HTTPS,
                or HTTP on the loopback, whose port may vary. --client-id
                sets the ID, such as a client's metadata document URL
                (ChatGPT, Claude: apps/docs/content/guides/deployment.mdx); random
                otherwise.
  oauth-client remove --client-id <id>
                Remove a client and its connections: at once, /mcp refuses
                its access tokens and refreshing refuses its refresh tokens.
  learner export --email <email> (--organization <slug> | --account) --out <file>
                Write the learner's data to <file>, a new file only you may
                read: what one organization holds (for that school), or the
                whole account's (for the account holder). JSON, in the
                format apps/docs/content/guides/deployment.mdx describes; reads only.
  learner erase-history --email <email> --organization <slug> [--end-membership] [--yes]
                Erase what one organization holds of the learner, for that
                school: shows the database, the account, and the counts, and
                asks for the slug typed back unless --yes. Old answers stay
                refused, and the erasure is logged to BRAIVO_ERASURE_LOG.
                --end-membership also ends their membership; otherwise their
                next answers start a fresh history.
  account erase --email <email> [--yes]
                Erase the account and every row referring to it or its email, for
                the account holder, each school listed having instructed:
                shows the database, the account, those schools, and the counts,
                and asks for the email typed back unless --yes. AI usage counts
                stay, with no user. Logged to BRAIVO_ERASURE_LOG. Refused for
                an organization's only owner. Finding nothing, it says so and
                succeeds.
  reviewer set-password --email <email> [--password-stdin]
                Let an existing account sign in with a password at
                /login?method=password, for an app directory's reviewer, while
                BRAIVO_REVIEWER_EMAILS lists it. Prints a random password
                once, or reads one from stdin (16 characters or more);
                replaces any it had.
  reviewer remove-password --email <email>
                Remove the account's password and end its sessions. Its
                connected AI apps remain: disconnect them in the console.
  serve         Serve the HTTP API.
`;

/**
 * The process entry point is the one place that reads the environment, so the
 * modules below it take their dependencies as arguments and stay testable. What
 * those values are allowed to be lives in `config.ts`, which is testable too.
 */
async function main(argv: readonly string[]): Promise<number> {
  // Matched whole rather than by prefix: a trailing word is a typo or an option
  // a command does not have, and serving anyway would answer `serve --port
  // 4000` by listening on a different port.
  if (argv.length === 2 && argv[0] === "config" && argv[1] === "check") {
    readServeConfig(process.env);
    return 0;
  }

  if (argv.length === 2 && argv[0] === "db" && argv[1] === "migrate") {
    await runMigrations(readDatabaseUrl(process.env));
    console.log("Migrations applied.");
    return 0;
  }

  if (argv[0] === "ai" && argv[1] === "report") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { since: { type: "string" }, organization: { type: "string" } },
    });
    const today = new Date();
    const since =
      values.since === undefined
        ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
        : new Date(`${values.since}T00:00:00.000Z`);
    if (
      Number.isNaN(since.getTime()) ||
      (values.since !== undefined && since.toISOString().slice(0, 10) !== values.since)
    ) {
      console.error(USAGE);
      return 1;
    }

    const database = createDatabase(readDatabaseUrl(process.env));
    try {
      const report = await readAiReport({ database, since, organizationSlug: values.organization });
      console.log(
        `AI requests since ${since.toISOString().slice(0, 10)} (UTC), ${values.organization ?? "all organizations"}:\n`,
      );
      console.log(report.length === 0 ? "None." : formatAiReport(report));
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "organization" && argv[1] === "create") {
    // Strict: an unknown option or a stray word throws, and is reported below.
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { name: { type: "string" }, slug: { type: "string" }, owner: { type: "string" } },
    });
    const { name, slug, owner } = values;
    if (!name || !slug || !owner) {
      console.error(USAGE);
      return 1;
    }

    const config = readAuthConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    try {
      const auth = createAuth({
        database,
        secret: config.secret,
        baseURL: config.baseUrl,
        sendMail: sendsNoMail,
      });
      const created = await createOrganization(auth, { name, slug, ownerEmail: owner });
      console.log(`Created ${created.name}, owned by ${owner}: ${config.baseUrl}/${created.slug}`);
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "organization" && argv[1] === "add-member") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        slug: { type: "string" },
        email: { type: "string" },
        role: { type: "string", default: "member" },
      },
    });
    const { slug, email, role } = values;
    if (!slug || !email) {
      console.error(USAGE);
      return 1;
    }

    const config = readAuthConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    try {
      const auth = createAuth({
        database,
        secret: config.secret,
        baseURL: config.baseUrl,
        sendMail: sendsNoMail,
      });
      const added = await addMember(auth, { slug, email, role });
      const as = { member: "a learner", author: "an author", admin: "an administrator" }[
        added.role
      ];
      console.log(`Added ${email} to ${added.organization.name} as ${as}.`);
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "organization" && argv[1] === "make-owner") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        slug: { type: "string" },
        email: { type: "string" },
        yes: { type: "boolean" },
      },
    });
    const { slug, email, yes } = values;
    if (!slug || !email) {
      console.error(USAGE);
      return 1;
    }

    const databaseUrl = readDatabaseUrl(process.env);
    const database = createDatabase(databaseUrl);
    try {
      const target = await previewOwnerPromotion({ database, slug, email });
      const { name } = target.organization;
      if (target.roles.includes("owner")) {
        console.log(`${target.email} is already an owner of ${name}. Nothing was changed.`);
        return 0;
      }
      const { host, pathname } = new URL(databaseUrl);
      console.log(`Database:     ${host}${pathname}`);
      console.log(`Organization: ${name} (${slug})`);
      console.log(`Account:      ${target.email} (${target.userId})`);
      console.log(`Role now:     ${target.roles.join(", ")}`);
      console.log(
        "An owner may delete the organization. This promotion cannot be undone without the database.",
      );
      if (!yes && (await typedBack(`Type ${slug} to make them an owner: `)) !== slug) {
        console.error("Not confirmed. Nothing was changed.");
        return 1;
      }
      const outcome = await promoteToOwner({ database, target });
      console.log(
        outcome === "made"
          ? `${target.email} is now an owner of ${name}.`
          : `${target.email} is already an owner of ${name}. Nothing was changed.`,
      );
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "organization" && argv[1] === "add-domain") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { slug: { type: "string" }, hostname: { type: "string" } },
    });
    const { slug, hostname } = values;
    if (!slug || !hostname) {
      console.error(USAGE);
      return 1;
    }

    // `organization create`'s environment, so operators set one; the secret goes unused.
    const config = readAuthConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    try {
      const domain = await registerLearnDomain({
        database,
        baseUrl: config.baseUrl,
        organizationSlug: slug,
        hostname,
      });
      console.log(`Registered ${domain.hostname} for ${domain.organization.name}.`);
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "oauth-client" && (argv[1] === "add" || argv[1] === "remove")) {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        "redirect-uri": { type: "string", multiple: true },
        "client-id": { type: "string" },
      },
    });
    const { name, "redirect-uri": redirectUris, "client-id": clientId } = values;
    const adding = argv[1] === "add";
    if (adding ? !name || !redirectUris : !clientId || name || redirectUris) {
      console.error(USAGE);
      return 1;
    }

    const config = readAuthConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    try {
      const auth = createAuth({
        database,
        secret: config.secret,
        baseURL: config.baseUrl,
        sendMail: sendsNoMail,
      });
      if (adding) {
        const added = await registerOAuthClient(auth, {
          name: name!,
          redirectUris: redirectUris!,
          clientId,
        });
        console.log(
          `Registered ${name!.trim()} for ${config.baseUrl}/mcp. Its client ID:\n${added.clientId}`,
        );
      } else if (await removeOAuthClient(auth, clientId!)) {
        console.log(
          `Removed ${clientId} from ${config.baseUrl}/mcp. Its connections can no longer reach /mcp, nor refresh their tokens.`,
        );
      } else {
        console.error(`No client is registered as ${clientId} for ${config.baseUrl}/mcp.`);
        return 1;
      }
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "learner" && argv[1] === "export") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        email: { type: "string" },
        organization: { type: "string" },
        account: { type: "boolean" },
        out: { type: "string" },
      },
    });
    const { email, organization, account, out } = values;
    // Exactly one scope, never a default: a school's request and the account
    // holder's disclose different things (docs/adr/0053-learners-data.md).
    if (!email || !out || (organization === undefined) === (account !== true)) {
      console.error(USAGE);
      return 1;
    }

    const databaseUrl = readDatabaseUrl(process.env);
    const database = createDatabase(databaseUrl);
    try {
      const exported = await exportLearner({
        database,
        email,
        scope: organization === undefined ? "account" : { organizationSlug: organization },
        at: new Date(),
      });
      await writeNewPrivateFile(out, `${JSON.stringify(exported, null, 2)}\n`);
      // Status to stderr, stdout left empty: nothing of the export lands in a
      // pipe or a log by mistake, and the file stays its only copy.
      const { host, pathname } = new URL(databaseUrl);
      const where = organization === undefined ? "the account" : organization;
      console.error(
        `Exported ${where}'s records of ${exported.learner.email} from ${host}${pathname} to ${out}.`,
      );
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "learner" && argv[1] === "erase-history") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        email: { type: "string" },
        organization: { type: "string" },
        "end-membership": { type: "boolean" },
        yes: { type: "boolean" },
      },
    });
    const { email, organization, "end-membership": endMembership = false, yes } = values;
    if (!email || !organization) {
      console.error(USAGE);
      return 1;
    }

    // Before anything is read: without its log, no erasure may even start.
    const log = openErasureLog();
    const databaseUrl = readDatabaseUrl(process.env);
    const database = createDatabase(databaseUrl);
    try {
      const {
        target,
        counts,
        epoch: current,
      } = await previewHistoryErasure({
        database,
        email,
        organizationSlug: organization,
      });
      const { host, pathname } = new URL(databaseUrl);
      console.log(`Database:     ${host}${pathname}`);
      console.log(`Account:      ${target.email} (${target.learnerId})`);
      console.log(`Organization: ${organization} (${target.organizationId})`);
      console.log(`History:      epoch ${current}`);
      console.log(`To erase:     ${formatCounts(counts)}`);
      console.log(`Membership:   ${endMembership ? "ended, with its groups" : "kept"}`);
      if (!yes && (await typedBack(`Type ${organization} to erase: `)) !== organization) {
        console.error("Not confirmed. Nothing was erased.");
        return 1;
      }

      const { recordId, epoch, removed } = await eraseLearnerHistory({
        database,
        target,
        endMembership,
        log,
      });
      console.log(`Erased:       ${formatCounts(removed)}`);
      console.log(`Membership:   ${removed.membership ? "ended" : "not changed"}`);
      console.log(`History epoch ${epoch}. Log record ${recordId}, done.`);
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "account" && argv[1] === "erase") {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { email: { type: "string" }, yes: { type: "boolean" } },
    });
    if (!values.email) {
      console.error(USAGE);
      return 1;
    }

    // Before anything is read: without its log, no erasure may even start.
    const log = openErasureLog();
    const databaseUrl = readDatabaseUrl(process.env);
    const database = createDatabase(databaseUrl);
    try {
      const { target, counts } = await previewAccountErasure({ database, email: values.email });
      const { host, pathname } = new URL(databaseUrl);
      console.log(`Database:     ${host}${pathname}`);
      console.log(
        target.userId === null
          ? `Account:      No account has ${target.email}.`
          : `Account:      ${target.email} (${target.userId})`,
      );
      // Nothing, and said so: that is not proof the person meant was erased, as
      // the address may be mistyped, so the register notes which it was.
      if (target.userId === null && Object.values(counts).every((rows) => rows === 0)) {
        console.log("Nothing to erase: no row names this address.");
        return 0;
      }
      for (const { slug, role, attempts, evidence } of target.organizations) {
        console.log(
          `School:       ${slug}: ${role ?? "no membership"}, attempts ${attempts}, evidence ${evidence}`,
        );
      }
      console.log(`To erase:     ${formatAccountCounts(counts)}`);
      console.log(`Kept:         ${formatKeptCounts(counts)}`);
      if (!values.yes && (await typedBack(`Type ${target.email} to erase: `)) !== target.email) {
        console.error("Not confirmed. Nothing was erased.");
        return 1;
      }

      const { recordId, removed } = await eraseAccount({ database, target, log });
      console.log(`Erased:       ${formatAccountCounts(removed)}`);
      console.log(`Log record ${recordId}, done.`);
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv[0] === "reviewer" && (argv[1] === "set-password" || argv[1] === "remove-password")) {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { email: { type: "string" }, "password-stdin": { type: "boolean" } },
    });
    const { email, "password-stdin": fromStdin } = values;
    const setting = argv[1] === "set-password";
    if (!email || (!setting && fromStdin)) {
      console.error(USAGE);
      return 1;
    }

    const config = readAuthConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    try {
      const auth = createAuth({
        database,
        secret: config.secret,
        baseURL: config.baseUrl,
        sendMail: sendsNoMail,
      });
      if (setting) {
        // Never an argument, which the shell's history and `ps` would keep.
        // Its line's end is not part of it.
        const password = fromStdin
          ? (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "")
          : generateReviewerPassword();
        await setReviewerPassword(auth, { email, password });
        console.log(
          `${email} signs in at ${config.baseUrl}/login?method=password while BRAIVO_REVIEWER_EMAILS lists it.`,
        );
        if (!fromStdin) console.log(`Its password, shown this once:\n${password}`);
      } else if (await removeReviewerPassword(auth, email)) {
        console.log(`Removed the password of ${email} and ended its sessions.`);
      } else {
        console.error(`${email} has no password; any sessions it had were ended.`);
        return 1;
      }
    } finally {
      await database.$client.end();
    }
    return 0;
  }

  if (argv.length === 1 && argv[0] === "serve") {
    const config = readServeConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    const { files } = config;
    const api = createServer({
      config,
      database,
      files:
        files === undefined
          ? undefined
          : "bucket" in files
            ? bucketStore(new Bun.S3Client({ bucket: files.bucket }))
            : directoryStore(files.directory),
      sendMail: config.mail === "log" ? logMail : smtpMail(config.mail),
    });

    const server = Bun.serve({ port: config.port, hostname: config.hostname, fetch: api.fetch });
    console.log(`Braivo listening on ${server.url.href}`);
    if (config.mail === "log") {
      console.log("BRAIVO_SMTP_URL is unset, so sign-in codes are written here.");
    }

    // Returning does not end the process: the listening socket keeps it alive.
    return 0;
  }

  // Asked for, so it goes to stdout and succeeds; anything else is a command
  // that does not exist, so it goes to stderr and fails.
  if (argv.length === 0) {
    console.log(USAGE);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

function formatCounts(counts: ErasureCounts): string {
  const { attempts, evidence, reports, sessions, handoffs, signInCodes, invitations } = counts;
  return `attempts ${attempts}, evidence ${evidence}, reports ${reports}, learner sessions ${sessions}, handoffs ${handoffs}, sign-in codes ${signInCodes}, invitations ${invitations}`;
}

/** The erasure log the environment names; throws if it names none. */
function openErasureLog(): ErasureLog {
  const { files, hmacKey } = readErasureLogConfig(process.env);
  return {
    hmacKey,
    store:
      "bucket" in files
        ? bucketStore(new Bun.S3Client({ bucket: files.bucket }))
        : durableDirectoryStore(files.directory),
  };
}

function formatAccountCounts(counts: AccountErasureCounts): string {
  return [
    `attempts ${counts.attempts}`,
    `evidence ${counts.evidence}`,
    `reports ${counts.reports}`,
    `memberships ${counts.memberships}`,
    `groups ${counts.groups}`,
    `fences ${counts.fences}`,
    `learner sessions ${counts.learnerSessions}`,
    `console sessions ${counts.consoleSessions}`,
    `sign-in methods ${counts.signInMethods}`,
    `connections ${counts.connections}`,
    `connection tokens ${counts.connectionTokens}`,
    `apps registered ${counts.registeredApps}`,
    `device codes ${counts.deviceCodes}`,
    `handoffs ${counts.handoffs}`,
    `invitations sent ${counts.invitationsSent}`,
    `invitations received ${counts.invitationsReceived}`,
    `invitation mail claims ${counts.mailClaims}`,
    `sign-in codes ${counts.signInCodes}`,
    `verification rows ${counts.verifications}`,
  ].join(", ");
}

function formatKeptCounts(counts: AccountErasureCounts): string {
  return `with no user: AI requests ${counts.aiRequests}, reports dismissed ${counts.reportsDismissed}, settings changed ${counts.settingsChanged}`;
}

/** The line typed in answer to `question`; empty if the input ends first. */
async function typedBack(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  // `question` never settles once input has ended, as a closed pipe's has.
  const ended = new Promise<string>((resolve) => lines.once("close", () => resolve("")));
  try {
    return (await Promise.race([lines.question(question), ended])).trim();
  } finally {
    lines.close();
  }
}

/** The report as a table, its columns as wide as their widest cell. */
function formatAiReport(report: readonly AiReportRow[]): string {
  const share = (kept: number, proposed: number) =>
    proposed === 0 ? `${kept}/0` : `${kept}/${proposed} (${Math.round((100 * kept) / proposed)}%)`;
  const listed = (counts: Iterable<[string, number]>) =>
    [...counts].map(([name, count]) => `${name} ${count}`).join(", ");
  const table = [
    [
      "kind",
      "model",
      "prompt",
      "requests",
      "succeeded",
      "failed",
      "aborted",
      "unknown",
      "kept objectives",
      "kept tasks",
      "top refusals",
    ],
    ...report.map((row) => [
      row.kind,
      row.model ?? "(not recorded)",
      row.promptVersion ?? "(not recorded)",
      String(row.requests),
      String(row.succeeded),
      listed(Object.entries(row.failed)) || "0",
      String(row.aborted),
      String(row.unknown),
      row.draftCounts
        ? share(row.draftCounts.kept.objectives, row.draftCounts.proposed.objectives)
        : "",
      row.draftCounts ? share(row.draftCounts.kept.tasks, row.draftCounts.proposed.tasks) : "",
      listed(row.refusals.slice(0, 3)),
    ]),
  ];
  const widths = table[0]!.map((_, column) =>
    Math.max(...table.map((cells) => cells[column]!.length)),
  );
  return table
    .map((cells) =>
      cells
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
    .concat(
      "\n\nKept: passed Braivo's checks; not accepted by the owner, nor a judgement of quality. A refused task may count under two refusals.",
    );
}

/**
 * Creates `path`, refusing one that exists, readable by the operator alone,
 * and removes it again if writing fails, so a partial export is never left.
 */
async function writeNewPrivateFile(path: string, contents: string): Promise<void> {
  const file = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? new Error(`${path} exists; name a new file.`) : error;
  });
  try {
    // The mode `open` takes is narrowed by the umask, never widened; set it whole.
    await file.chmod(0o600);
    await file.writeFile(contents);
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(path);
    throw error;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
