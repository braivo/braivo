#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { createDatabase, runMigrations } from "@braivo/db";

import { registerLearnDomain } from "../application/index.ts";
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
import { readAuthConfig, readDatabaseUrl, readServeConfig } from "../config.ts";
import { logMail, type SendMail, smtpMail } from "../mail/index.ts";
import { createServer } from "../server.ts";
import { bucketStore, directoryStore } from "../storage/index.ts";

/** For the operator's commands, which make no one sign in. */
const sendsNoMail: SendMail = () => Promise.reject(new Error("This command sends no email."));

const USAGE = `Usage: bun apps/server/cli/index.ts <command>

Running an installation (a content owner's commands are braivo's):
  config check  Check the environment serve reads, printing its first problem;
                silent when there is none. Reaches no database.
  db migrate    Apply committed database migrations.
  organization create --name <name> --slug <slug> --owner <email>
                Create an organization owned by an existing account.
  organization add-member --slug <slug> --email <email> [--role member|author|admin]
                Add an existing account as a learner (member, the default),
                an author of its content (author), or an administrator (admin).
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
                (ChatGPT, Claude: docs/guides/deployment.md); random
                otherwise.
  oauth-client remove --client-id <id>
                Remove a client and its connections: at once, /mcp refuses
                its access tokens and refreshing refuses its refresh tokens.
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
