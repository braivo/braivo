#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { createDatabase, runMigrations } from "@braivo/db";

import { registerLearnDomain } from "../application/index.ts";
import { addMember, createAuth, createOrganization } from "../auth/index.ts";
import { readAuthConfig, readDatabaseUrl, readServeConfig } from "../config.ts";
import { logMail, type SendMail, smtpMail } from "../mail/index.ts";
import { createServer } from "../server.ts";
import { bucketStore, directoryStore } from "../storage/index.ts";
import { credentialsPath, loadCredentials } from "./credentials.ts";
import { login, logout, remoteClient, whoAmI } from "./remote.ts";
import { addSourceFromFile } from "./sources.ts";

/** For the operator's commands, which make no one sign in. */
const sendsNoMail: SendMail = () => Promise.reject(new Error("This command sends no email."));

const USAGE = `Usage: braivo <command>

Running an installation:
  db migrate    Apply committed database migrations.
  organization create --name <name> --slug <slug> --owner <email>
                Create an organization owned by an existing account.
  organization add-member --slug <slug> --email <email> [--role member|admin]
                Add an existing account as a learner (member, the default)
                or an administrator (admin).
  organization add-domain --slug <slug> --hostname <hostname>
                Register <hostname> for the organization's learn app, the
                one it is named by from now on, its earlier ones still
                serving; DNS, TLS, and routing it here are set up outside
                Braivo.
  serve         Serve the HTTP API.

Working with one, as yourself:
  login <url>   Sign in to the Braivo at <url>, approving in your browser.
  logout        Sign out, ending the saved token's session, and forget it.
  sources add <file | -> --organization <slug> [--title <title>]
                [--url <link>] [--language <tag>] [--original <file>]
                [--first-page <number>]
                Add a file's text, or standard input's, as a source;
                a .vtt or .srt caption file as a timed transcript,
                and text with form feeds, as pdftotext writes it, by page,
                numbered from 1, or from the first one's number in the book;
                --original uploads the file the text is from, kept with it.
  mcp           Serve Braivo as MCP tools over stdio, for a desktop agent.
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
      const as = added.role === "admin" ? "an administrator" : "a learner";
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

  if (argv.length === 2 && argv[0] === "login") {
    const credentials = await login(credentialsPath(process.env), argv[1]!, {
      fetch,
      print: (line) => console.log(line),
      sleep: (milliseconds) => Bun.sleep(milliseconds),
    });

    const user = await whoAmI(credentials, fetch);
    console.log(`Signed in to ${credentials.server} as ${user?.email ?? "an unknown account"}.`);
    return 0;
  }

  if (argv.length === 1 && argv[0] === "logout") {
    const server = await logout(credentialsPath(process.env), fetch);
    console.log(server ? `Signed out of ${server}.` : "Not signed in.");
    return 0;
  }

  if (argv.length === 1 && argv[0] === "mcp") {
    // Standard output is the protocol's alone: anything else printed there
    // would corrupt it, so failures go to standard error and the exit code.
    const credentials = await loadCredentials(credentialsPath(process.env));
    if (!credentials) throw new Error("Not signed in. Run `braivo login <url>` first.");

    // Loaded only here. Statically imported, the MCP SDK runs before zod has
    // initialized in `bun build --compile`'s bundle, and every command crashes
    // (docs/adr/0027-standalone-cli.md).
    const { createMcpServer, StdioServerTransport } = await import("./mcp.ts");
    const server = createMcpServer(remoteClient(credentials, fetch));
    await server.connect(new StdioServerTransport());
    // Returning does not end the process: the open standard input keeps it alive.
    return 0;
  }

  if (argv[0] === "sources" && argv[1] === "add") {
    // Strict, so a misspelt option is an error rather than a source added
    // without the link or language it was meant to carry.
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        organization: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
        language: { type: "string" },
        original: { type: "string" },
        "first-page": { type: "string" },
      },
    });
    const [file] = positionals;
    if (positionals.length !== 1 || file === undefined || values.organization === undefined) {
      console.error(USAGE);
      return 1;
    }

    const credentials = await loadCredentials(credentialsPath(process.env));
    if (!credentials) throw new Error("Not signed in. Run `braivo login <url>` first.");

    const sourceId = await addSourceFromFile({
      client: remoteClient(credentials, fetch),
      organizationSlug: values.organization,
      file,
      title: values.title,
      url: values.url,
      language: values.language,
      original: values.original,
      firstPage: values["first-page"],
      readStdin: () => Bun.stdin.text(),
      warn: (message) => console.error(message),
    });
    // Alone on stdout, so a script or an agent can capture it.
    console.log(sourceId);
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
