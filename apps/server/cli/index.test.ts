// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import { createDatabase, runMigrations } from "@braivo/db";
import { oauthClient, oauthClientResource } from "@braivo/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vite-plus/test";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

/** The operator's command, run as from a clone, with only `env` beside `PATH`. */
async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("the server's commands", () => {
  test("ask for the hostname of a learn domain left out", async () => {
    const { stderr, code } = await run(["organization", "add-domain", "--slug", "acme"]);

    expect(code).toBe(1);
    expect(stderr).toContain("organization add-domain --slug <slug> --hostname <hostname>");
  });

  test("ask for the redirect URI of a client left out", async () => {
    const { stderr, code } = await run(["oauth-client", "add", "--name", "Claude"]);

    expect(code).toBe(1);
    expect(stderr).toContain("oauth-client add --name <name> --redirect-uri <uri>...");
  });

  test("ask for the email of a member left out", async () => {
    const { stderr, code } = await run(["organization", "add-member", "--slug", "acme"]);

    expect(code).toBe(1);
    expect(stderr).toContain("organization add-member --slug <slug> --email <email>");
  });
});

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("the server's commands, on a database", () => {
  test("register a remote MCP client with several callbacks, then remove it", async () => {
    await runMigrations(connectionString ?? "");
    const env = {
      DATABASE_URL: connectionString ?? "",
      BETTER_AUTH_SECRET: "cli-test-secret-that-is-long-enough",
      BRAIVO_URL: "https://cli-test.example.com",
    };
    const callbacks = ["https://client.example/callback", "http://localhost/callback"];

    const added = await run(
      [
        "oauth-client",
        "add",
        "--name",
        "Claude",
        ...callbacks.flatMap((uri) => ["--redirect-uri", uri]),
      ],
      env,
    );
    expect(added).toMatchObject({ code: 0, stderr: "" });
    // The ID alone on the last line, to copy.
    const clientId = added.stdout.trim().split("\n").at(-1)!;
    const database = createDatabase(connectionString ?? "");
    try {
      const [stored] = await database
        .select()
        .from(oauthClient)
        .where(eq(oauthClient.clientId, clientId));
      expect(stored?.redirectUris).toEqual(callbacks);
      expect(
        await database
          .select()
          .from(oauthClientResource)
          .where(eq(oauthClientResource.clientId, clientId)),
      ).toMatchObject([{ resourceId: "https://cli-test.example.com/mcp" }]);

      const removed = await run(["oauth-client", "remove", "--client-id", clientId], env);
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain(
        `Removed ${clientId} from https://cli-test.example.com/mcp.`,
      );
      expect(
        await database.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)),
      ).toEqual([]);
      expect((await run(["oauth-client", "remove", "--client-id", clientId], env)).code).toBe(1);
    } finally {
      try {
        // Left by a failure above, not by a pass, which removed it.
        await database.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
      } finally {
        await database.$client.end();
      }
    }
  });
});
