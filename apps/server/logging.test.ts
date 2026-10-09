// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// What the server logs when something fails: what went wrong, never the
// personal data the failure carried.

import { inspect } from "node:util";

import { createDatabase, runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { DrizzleQueryError } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { createApi } from "./api/app.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./api/testing.ts";
import { createAuth } from "./auth/index.ts";
import { describeError, describeLogCall } from "./logging.ts";

const email = "sentinel-learner@example.com";
const sourceText = "Sentinel source text only its owner may read.";
const token = "SentinelToken0123456789abcdefABCDEF";

/** As pg's: the statement's values in its message. */
class DatabaseError extends Error {
  code = "23514";
}

function databaseError(values: unknown[]) {
  return new DatabaseError(`violates check constraint, values ${values.join(", ")}`);
}

describe("describeError", () => {
  test("names each class down the causes, with its code, and nothing else", () => {
    const error = new DrizzleQueryError(
      'insert into "source" …',
      [email, sourceText],
      databaseError([token]),
    );

    const described = describeError(error);

    expect(described).toBe("DrizzleQueryError < DatabaseError 23514");
  });

  test("withholds a code that could be a value, and the error's own name", () => {
    const coded = (code: string) => Object.assign(new Error(), { code });

    expect(describeError(Object.assign(coded(email), { name: email }))).toBe("Error");
    expect(describeError(coded("123456"))).toBe("Error");
    expect(describeError(coded("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"))).toBe("Error");
    expect(describeError(coded("ECONNREFUSED"))).toBe("Error ECONNREFUSED");
    expect(describeError(email)).toBe("string");
  });
});

describe("describeLogCall", () => {
  test("describes errors and withholds every string, words alone included", () => {
    expect(describeLogCall("Failed to run background task:", [databaseError([email])])).toBe(
      "DatabaseError 23514",
    );
    expect(describeLogCall(databaseError([token]), [{ email }])).toBe("DatabaseError 23514");
    expect(describeLogCall(sourceText, [sourceText])).toBe("message withheld");
    // As Better Auth logs a failed OAuth identity: the error described, the rest withheld.
    expect(
      describeLogCall("Unable to derive provider account identity", [
        { providerId: email, error: databaseError([token]) },
      ]),
    ).toBe("DatabaseError 23514");
  });
});

/** Requires TEST_DATABASE_URL: the failures are real requests' failures. */
describe.skipIf(!connectionString)("a failure's log", () => {
  const { database, auth, signUp } = createTestApi();
  const organizationId = "logging-test-org";
  let teacher!: Signed;

  /** Every pool opened here, closed after. */
  const opened: ReturnType<typeof createDatabase>[] = [];
  function openDatabase(url: string) {
    const opening = createDatabase(url);
    opened.push(opening);
    return opening;
  }
  afterAll(() => Promise.all(opened.map((each) => each.$client.end())));

  /** Every call to the console's five logging methods: its one argument, or all of them. */
  let logged: unknown[] = [];
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    teacher = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [teacher.id],
      at: new Date(),
    });
  });
  beforeAll(() => {
    for (const level of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args.length === 1 ? args[0] : args);
      });
    }
  });
  afterAll(() => vi.restoreAllMocks());
  afterEach(() => {
    logged = [];
  });

  function expectNothingPersonal() {
    // Not JSON, which prints an error as `{}`; nothing cut short or hidden.
    const all = inspect(logged, {
      depth: null,
      maxArrayLength: Infinity,
      maxStringLength: Infinity,
      customInspect: false,
    });
    for (const sentinel of [email, sourceText, token]) expect(all).not.toContain(sentinel);
  }

  /** A database where no table is found, so every query fails as PostgreSQL's. */
  function tablelessDatabase() {
    const url = new URL(connectionString ?? "");
    url.searchParams.set("options", "-c search_path=logging_test_nothing_here");
    return openDatabase(url.href);
  }

  test("an API failure logs its route and error, not the source text", async () => {
    // Storing the source fails as a check constraint would, values and all.
    const failingDatabase = openDatabase(connectionString ?? "");
    const query = failingDatabase.$client.query.bind(failingDatabase.$client) as (
      ...args: unknown[]
    ) => unknown;
    let insertValues: unknown[] = [];
    failingDatabase.$client.query = ((
      config: { text?: string },
      values: unknown[],
      ...rest: unknown[]
    ) => {
      if (!config.text?.startsWith('insert into "source"')) return query(config, values, ...rest);
      insertValues = values;
      return Promise.reject(databaseError(values));
    }) as typeof failingDatabase.$client.query;
    const api = createApi({ auth, database: failingDatabase, baseUrl });

    const response = await api.request(`/api/organizations/${organizationId}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, cookie: teacher.cookie },
      body: JSON.stringify({ title: "Sentinel", text: sourceText }),
    });

    expect(insertValues).toContain(sourceText);
    expect(response.status).toBe(500);
    expect(logged).toEqual([
      {
        message: "Request failed",
        method: "POST",
        route: "/api/organizations/:organizationId/sources",
        error: "DrizzleQueryError < DatabaseError 23514",
      },
    ]);
    expectNothingPersonal();
  });

  test("a session lookup failing logs no token", async () => {
    const tableless = tablelessDatabase();
    const failingAuth = createAuth({
      database: tableless,
      secret: "logging-test-secret-that-is-long-enough",
      baseURL: baseUrl,
      sendMail: async () => {},
    });
    const api = createApi({ auth: failingAuth, database: tableless, baseUrl });

    const response = await api.request("/api/organizations", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(500);
    expect(logged).toEqual([
      "[Better Auth] DrizzleQueryError < DatabaseError 42P01",
      {
        message: "Request failed",
        method: "GET",
        route: "/api/organizations",
        error: "APIError",
      },
    ]);
    expectNothingPersonal();
  });

  test("a sign-in failing in Better Auth logs no email", async () => {
    const tableless = tablelessDatabase();
    const failingAuth = createAuth({
      database: tableless,
      secret: "logging-test-secret-that-is-long-enough",
      baseURL: baseUrl,
      sendMail: async () => {},
    });
    const api = createApi({ auth: failingAuth, database: tableless, baseUrl });

    const response = await api.request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email, type: "sign-in" }),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(logged).toEqual([
      {
        message: "Request failed",
        method: "POST",
        route: "/api/auth/*",
        error: "DrizzleQueryError < DatabaseError 42P01",
      },
    ]);
    expectNothingPersonal();
  });

  test("a refused callback URL is not logged with its query", async () => {
    const response = await createApi({ auth, database, baseUrl }).request(
      "/api/auth/sign-in/social",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({
          provider: "google",
          callbackURL: `https://evil.example/?token=${token}`,
        }),
      },
    );

    expect(response.status).toBe(403);
    expectNothingPersonal();
  });

  test("a callback's error is not logged", async () => {
    const google = { clientId: "logging-test", clientSecret: "logging-test" };
    const googleAuth = createAuth({
      database,
      secret: "logging-test-secret-that-is-long-enough",
      baseURL: baseUrl,
      sendMail: async () => {},
      google,
    });
    const api = createApi({ auth: googleAuth, database, baseUrl });

    const response = await api.request(
      `/api/auth/callback/google?error=${encodeURIComponent(sourceText)}`,
    );

    expect(response.status).toBe(302);
    expect(logged).toEqual(["[Better Auth] message withheld"]);
    expectNothingPersonal();
  });

  test("a failed mail send logs no recipient", async () => {
    // As Nodemailer refuses a recipient: the address in its message and its fields.
    const unsent = Object.assign(
      new Error(`Can't send mail - all recipients were rejected: 550 5.1.1 <${email}>`),
      { code: "EENVELOPE", rejected: [email] },
    );
    const refusingAuth = createAuth({
      database,
      secret: "logging-test-secret-that-is-long-enough",
      baseURL: baseUrl,
      sendMail: async () => {
        throw unsent;
      },
    });
    const api = createApi({ auth: refusingAuth, database, baseUrl });

    const response = await api.request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: `${crypto.randomUUID()}-${email}`, type: "sign-in" }),
    });

    expect(response.status).toBe(503);
    expect(logged).toEqual(["[Better Auth] Error EENVELOPE"]);
    expectNothingPersonal();
  });
});
