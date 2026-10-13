#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { createMcpServer } from "@braivo/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { credentialsPath, loadCredentials } from "./credentials.ts";
import { login, logout, remoteClient, whoAmI } from "./remote.ts";
import { addSourceFromFile } from "./sources.ts";

/**
 * The release, `--define`d by `.github/workflows/cli.yml` from its tag; unset
 * when run from source or built locally.
 */
declare const BRAIVO_VERSION: string | undefined;

const USAGE = `Usage: braivo <command>

Working with a Braivo installation, as yourself:
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
  --version     Print which release this is.
`;

/**
 * The process entry point is the one place that reads the environment, so the
 * modules below it take their dependencies as arguments and stay testable.
 */
async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(`braivo ${typeof BRAIVO_VERSION === "string" ? BRAIVO_VERSION : "development"}`);
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
