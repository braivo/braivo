// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import { createDatabase, runMigrations } from "@braivo/db";
import { aiRequest, oauthClient, oauthClientResource } from "@braivo/db/schema";
import { account, session, user } from "@braivo/db/schema/auth";
import { seedOrganization } from "@braivo/db/testing";
import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vite-plus/test";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

/**
 * The operator's command, run as from a clone, with only `env` beside `PATH`,
 * and `stdin` piped in, or nothing.
 */
async function run(args: string[], env: Record<string, string> = {}, stdin = "") {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: new Blob([stdin]),
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
  test("check serve's environment, silent unless it names a problem", async () => {
    const env = {
      DATABASE_URL: "postgres://localhost/braivo",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BRAIVO_URL: "http://localhost:5174",
    };
    const valid = await run(["config", "check"], env);
    const invalid = await run(["config", "check"], { ...env, BETTER_AUTH_SECRET: "" });

    expect(valid).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(invalid).toEqual({ stdout: "", stderr: "BETTER_AUTH_SECRET is not set.\n", code: 1 });
  });

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

  test("ask for the email of a reviewer left out, and take a password from stdin alone", async () => {
    const left = await run(["reviewer", "set-password"]);
    const inArgv = await run([
      "reviewer",
      "set-password",
      "--email",
      "a@example.com",
      "--password",
      "x",
    ]);

    expect([left.code, inArgv.code]).toEqual([1, 1]);
    expect(left.stderr).toContain("reviewer set-password --email <email> [--password-stdin]");
  });

  test("ask for the email of a member left out", async () => {
    const { stderr, code } = await run(["organization", "add-member", "--slug", "acme"]);

    expect(code).toBe(1);
    expect(stderr).toContain("organization add-member --slug <slug> --email <email>");
  });
});

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("the server's commands, on a database", () => {
  test("report AI requests by kind, model, and prompt, with outcomes and what drafts kept", async () => {
    await runMigrations(connectionString ?? "");
    const database = createDatabase(connectionString ?? "");
    const organizationId = "cli-test-ai-report";
    const other = "cli-test-ai-report-other";
    const at = (day: string) => new Date(`2026-10-${day}T12:00:00.000Z`);
    const row = (
      organization: string,
      day: string,
      fields: Partial<typeof aiRequest.$inferInsert> = {},
    ) => ({
      id: crypto.randomUUID(),
      organizationId: organization,
      kind: "draft",
      createdAt: at(day),
      model: "claude-sonnet-5",
      promptVersion: "aaaaaaaaaaaa",
      ...fields,
    });
    const drafted = (proposed: number, kept: number, refusals: Record<string, number>) => ({
      outcome: "succeeded",
      counts: {
        proposed: { objectives: proposed, tasks: proposed * 2 },
        kept: { objectives: kept, tasks: kept * 2 },
        refusals,
      },
    });
    try {
      for (const id of [organizationId, other]) {
        await seedOrganization(database, { organizationId: id, learnerIds: [], at: at("01") });
      }
      await database.insert(aiRequest).values([
        // Before --since: left out.
        row(organizationId, "01", drafted(1, 1, {})),
        row(organizationId, "10", drafted(10, 8, { "quote-ambiguous": 3, "task-invalid": 1 })),
        row(organizationId, "11", drafted(6, 3, { "quote-ambiguous": 2, "quote-missing": 2 })),
        // Proposed nothing: no share of nothing.
        row(organizationId, "11", drafted(0, 0, {})),
        row(organizationId, "12", { outcome: "failed", failure: "timeout" }),
        row(organizationId, "12", { outcome: "aborted" }),
        row(organizationId, "12", {}),
        row(organizationId, "13", { promptVersion: "bbbbbbbbbbbb", ...drafted(4, 4, {}) }),
        row(organizationId, "13", {
          kind: "read",
          outcome: "succeeded",
          counts: {
            pages: 3,
            blankEntries: 0,
          },
        }),
        // Recorded before the ledger knew its model, and never completed.
        row(organizationId, "14", { kind: "read", model: null, promptVersion: null }),
        // Another organization's: in the whole installation's report only.
        row(other, "14", { outcome: "failed", failure: "provider-error" }),
      ]);

      const env = { DATABASE_URL: connectionString ?? "" };
      const report = await run(
        ["ai", "report", "--since", "2026-10-02", "--organization", organizationId],
        env,
      );
      expect(report).toMatchObject({ code: 0, stderr: "" });
      expect(report.stdout).toBe(
        [
          `AI requests since 2026-10-02 (UTC), ${organizationId}:`,
          "",
          "kind   model            prompt          requests  succeeded  failed     aborted  unknown  kept objectives  kept tasks   top refusals",
          "draft  claude-sonnet-5  aaaaaaaaaaaa    6         3          timeout 1  1        1        11/16 (69%)      22/32 (69%)  quote-ambiguous 5, quote-missing 2, task-invalid 1",
          "draft  claude-sonnet-5  bbbbbbbbbbbb    1         1          0          0        0        4/4 (100%)       8/8 (100%)",
          "read   claude-sonnet-5  aaaaaaaaaaaa    1         1          0          0        0",
          "read   (not recorded)   (not recorded)  1         0          0          0        1",
          "",
          "Kept: passed Braivo's checks; not accepted by the owner, nor a judgement of quality. A refused task may count under two refusals.",
          "",
        ].join("\n"),
      );

      const everyone = await run(["ai", "report", "--since", "2026-10-02"], env);
      expect(everyone.stdout).toContain("AI requests since 2026-10-02 (UTC), all organizations:");
      expect(everyone.stdout).toContain("provider-error 1");

      expect(await run(["ai", "report", "--organization", "no-such-organization"], env)).toEqual({
        code: 1,
        stdout: "",
        stderr: "No organization has the slug no-such-organization.\n",
      });
      expect((await run(["ai", "report", "--since", "October"], env)).code).toBe(1);
    } finally {
      await database.delete(aiRequest).where(eq(aiRequest.organizationId, organizationId));
      await database.delete(aiRequest).where(eq(aiRequest.organizationId, other));
      await database.$client.end();
    }
  });

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

  // Slow: four commands, each a process hashing a password.
  test("set a reviewer's password, random or from stdin, then remove it and its sessions", async () => {
    await runMigrations(connectionString ?? "");
    const env = {
      DATABASE_URL: connectionString ?? "",
      BETTER_AUTH_SECRET: "cli-test-secret-that-is-long-enough",
      BRAIVO_URL: "https://cli-test.example.com",
    };
    const id = crypto.randomUUID();
    const email = `cli-test-reviewer-${id}@example.com`;
    const database = createDatabase(connectionString ?? "");
    const stored = async () =>
      (
        await database
          .select({ password: account.password })
          .from(account)
          .where(and(eq(account.userId, id), eq(account.providerId, "credential")))
      ).map((row) => row.password!);
    try {
      const now = new Date();
      await database.insert(user).values({
        id,
        email,
        name: "Reviewer",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await database.insert(session).values({
        id,
        userId: id,
        token: id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: now,
        updatedAt: now,
      });

      const generated = await run(["reviewer", "set-password", "--email", email], env);
      expect(generated).toMatchObject({ code: 0, stderr: "" });
      // Alone on the last line, to copy.
      const shown = generated.stdout.trim().split("\n").at(-1)!;
      expect(shown.length).toBeGreaterThanOrEqual(16);
      const [first] = await stored();
      expect(await verifyPassword({ hash: first!, password: shown })).toBe(true);

      const short = await run(
        ["reviewer", "set-password", "--email", email, "--password-stdin"],
        env,
        "short\n",
      );
      expect(short.code).toBe(1);
      expect(short.stderr).toContain("at least 16 characters");
      const chosen = "a reviewer's password, long enough";
      const piped = await run(
        ["reviewer", "set-password", "--email", email, "--password-stdin"],
        env,
        `${chosen}\n`,
      );
      expect(piped).toMatchObject({ code: 0, stderr: "" });
      expect(piped.stdout).not.toContain(chosen);
      const replaced = await stored();
      expect(replaced).toHaveLength(1);
      expect(await verifyPassword({ hash: replaced[0]!, password: chosen })).toBe(true);

      const removed = await run(["reviewer", "remove-password", "--email", email], env);
      expect(removed.code).toBe(0);
      expect(await stored()).toEqual([]);
      expect(await database.select().from(session).where(eq(session.userId, id))).toEqual([]);
      expect((await run(["reviewer", "remove-password", "--email", email], env)).code).toBe(1);
    } finally {
      try {
        await database.delete(user).where(eq(user.id, id));
      } finally {
        await database.$client.end();
      }
    }
  }, 30_000);
});
