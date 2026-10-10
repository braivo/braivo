// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { registerLearnDomain } from "../application/index.ts";
import {
  baseUrl,
  connectionString,
  createTestApi,
  learnerSessionOn,
  type Signed,
} from "./testing.ts";

// Every route's admission, in one table per host: what it answers to each
// credential, to forged writes, and to oversized bodies, and whether that
// answer is kept out of shared caches. Each route's own tests check the
// refusals its author thought of; this checks that no route lost one, which is
// what a guard dropped while moving or factoring routes would do. A changed
// cell is a change in observable behaviour, to review as one; refactors leave
// every cell as it is. Which of several refusals wins is not itself contract
// (access.md), so a cell may change on purpose without the spec changing.
//
// Every guard runs before the use case, so nothing here needs content: path
// parameters name nothing, and an admitted request is refused by its parser
// (400) or its use case (403, 404, 501), which is enough to tell it was let in.

const { database, api, signUp } = createTestApi();
const organizationId = "policy-test-org";
const siblingOrganizationId = "policy-test-other-org";
const learnOrigin = "https://policy-test.example.com";
/** Another organization's learn domain, and a sibling of the first. */
const siblingOrigin = "https://policy-test-other.example.com";

/** Every route `createApi` registers, Better Auth's mount by a few of its own, and a path it does not. */
const routes = [
  "GET  /api/auth/get-session",
  "GET  /api/auth/organization/list",
  "POST /api/auth/email-otp/send-verification-otp",
  "POST /api/auth/sign-in/email-otp",
  "POST /api/auth/sign-in/social",
  "POST /api/auth/sign-out",
  "GET  /api/sign-in-settings",
  "GET  /api/session/sign-in",
  "GET  /api/session/handoff",
  "GET  /api/session",
  "POST /api/session/sign-out",
  "GET  /api/handoffs/:handoffId",
  "POST /api/handoffs/:handoffId",
  "GET  /api/organization",
  "GET  /api/courses",
  "GET  /api/courses/:courseId/next",
  "GET  /api/courses/:courseId/activity",
  "POST /api/courses/:courseId/attempts",
  "GET  /api/courses/:courseId/learners/:learnerId/progress",
  "GET  /api/courses/:courseId/progress",
  "GET  /api/organizations",
  "GET  /api/organization-setup",
  "POST /api/organization-setup",
  "GET  /api/organizations/:organizationId/members",
  "POST /api/organizations/:organizationId/learners/:learnerId/evidence",
  "GET  /api/organizations/:organizationId/objectives",
  "POST /api/organizations/:organizationId/objectives",
  "POST /api/organizations/:organizationId/tasks",
  "POST /api/organizations/:organizationId/tasks/retire",
  "GET  /api/organizations/:organizationId/courses",
  "POST /api/organizations/:organizationId/courses",
  "GET  /api/organizations/:organizationId/courses/:courseId",
  "POST /api/organizations/:organizationId/citations",
  "GET  /api/organizations/:organizationId/objectives/:objectiveId/citations",
  "GET  /api/organizations/:organizationId/objectives/:objectiveId/tasks",
  "GET  /api/organizations/:organizationId/sources",
  "POST /api/organizations/:organizationId/sources",
  "GET  /api/organizations/:organizationId/sources/:sourceId",
  "POST /api/organizations/:organizationId/sources/:sourceId/draft",
  "POST /api/organizations/:organizationId/files",
  "GET  /api/organizations/:organizationId/files/:fileId",
  "POST /api/organizations/:organizationId/files/:fileId/text",
  "GET  /api/nowhere",
];

/** Routes that end the session they are sent with, so each of their cells gets a new one. */
const endingSession = new Set(["POST /api/auth/sign-out", "POST /api/session/sign-out"]);

/**
 * What a request carries besides its route: `account` is an account's session
 * cookie, `bearer` the same session as a tool's token, `learner` a learn
 * domain's learner session. `foreign` and `sibling` are JSON writes another
 * page could make in a browser holding the host's session, the account's or
 * the learner's: from another site, and from another organization's learn
 * domain (same-site when both are subdomains of one domain, so the cookie goes
 * along). The rest carry no credential, so a refusal there shows its check
 * runs before the session's 401: `form` is a form's content type, which every
 * write refuses; `file` is a file's, which JSON writes refuse and the upload
 * lets through; `limit` is the smallest body refused as too large.
 */
const columns = [
  "none",
  "account",
  "bearer",
  "learner",
  "foreign",
  "sibling",
  "form",
  "file",
  "limit",
] as const;
type Column = (typeof columns)[number];
type Credentials = { cookie: string; token: string; learnerCookie: string };

/**
 * One byte past `MAX_BODY_BYTES`, `MAX_SOURCE_BYTES`, and `MAX_FILE_BYTES`.
 * Declared rather than sent, since every limit reads the length a client
 * declares, and a 50 MB body per row is slow for nothing.
 */
const limits = [
  ["1MB", 1_000_001],
  ["10MB", 10_000_001],
  ["50MB", 50_000_001],
] as const;

let member!: Signed;

async function credentials(): Promise<Credentials> {
  const account = await signUp();
  return { ...account, learnerCookie: await learnerSessionOn(api, learnOrigin, member.cookie) };
}

/** The answer to one request: its status, then `*` if it lacks `Cache-Control: private, no-store`. */
async function send(route: string, origin: string, headers: Headers) {
  const [method = "", template = ""] = route.split(/\s+/);
  const path = template.replaceAll(/:\w+/g, "unknown");
  const response = await api.request(`${origin}${path}`, {
    method,
    headers,
    ...(method === "POST" && { body: "{}" }),
  });
  await response.body?.cancel();

  const cache = response.headers.get("cache-control");
  if (cache === "private, no-store") return String(response.status);
  if (cache === null) return `${response.status}*`;
  throw new Error(`${route} answered Cache-Control: ${cache}`);
}

/**
 * One cell: an answer, as `send` writes it; for `limit`, the smallest body
 * refused, or the answer to the largest if none was; `·` where a column means
 * nothing, since a GET has no body to forge or limit.
 */
async function cell(route: string, origin: string, column: Column, sent: Credentials) {
  const write = route.startsWith("POST");
  const browser = origin === baseUrl ? sent.cookie : sent.learnerCookie;
  const headers = new Headers(write ? { "content-type": "application/json" } : {});
  switch (column) {
    case "none":
      break;
    case "account":
    case "learner":
      headers.set("cookie", column === "account" ? sent.cookie : sent.learnerCookie);
      // A browser names the page's origin on a write; a tool names none.
      if (write) headers.set("origin", origin);
      break;
    case "bearer":
      headers.set("authorization", `Bearer ${sent.token}`);
      break;
    case "foreign":
    case "sibling":
      if (!write) return "·";
      headers.set("cookie", browser);
      headers.set("origin", column === "foreign" ? "https://elsewhere.example" : siblingOrigin);
      break;
    case "form":
      if (!write) return "·";
      headers.set("content-type", "text/plain");
      break;
    case "file":
      if (!write) return "·";
      headers.set("content-type", "application/pdf");
      break;
    case "limit": {
      if (!write) return "·";
      let answer = "";
      for (const [label, length] of limits) {
        headers.set("content-length", String(length));
        answer = await send(route, origin, headers);
        if (answer.startsWith("413")) return answer.replace("413", label);
      }
      return answer;
    }
    default:
      throw new Error(`Unhandled column: ${column satisfies never}`);
  }
  return send(route, origin, headers);
}

async function table(origin: string, shared: Credentials) {
  const lines = [`${"route".padEnd(75)}${columns.map((column) => column.padStart(8)).join("")}`];
  for (const route of routes) {
    const cells = [];
    for (const column of columns) {
      const sent = endingSession.has(route) ? await credentials() : shared;
      cells.push((await cell(route, origin, column, sent)).padStart(8));
    }
    lines.push(`${route.padEnd(75)}${cells.join("")}`);
  }
  return lines.map((line) => line.trimEnd()).join("\n");
}

/** Outside the database gate: the routing table alone, so a route added without a row fails here. */
test("has a row for every route the API registers", () => {
  // Middleware is registered for `ALL`; Better Auth's mount, one wildcard, is
  // probed by a few of its paths; and the last row is a path nothing serves.
  const registered = new Set(
    api.routes
      .filter(({ method }) => method !== "ALL")
      .map(({ method, path }) => `${method} ${path}`),
  );
  const listed = new Set(
    routes
      .filter((route) => !route.endsWith(" /api/nowhere"))
      .map((route) => route.replace(/\s+/, " ").replace(/ \/api\/auth\/.+/, " /api/auth/*")),
  );

  expect([...listed].sort()).toEqual([...registered].sort());
});

/**
 * The host gate's rule is any host but the installation's, not a registered
 * domain's, which the tables below use: an unknown host reaches no more. Before
 * any lookup, so this needs no database either.
 */
test("refuses the installation's API on an unregistered host too", async () => {
  const on = async (path: string, headers: Record<string, string> = {}) => {
    const response = await api.request(`https://unregistered.example${path}`, { headers });
    return `${response.status} ${response.headers.get("cache-control")}`;
  };

  expect(await on("/api/auth/get-session")).toBe("404 private, no-store");
  expect(await on("/api/organizations")).toBe("404 private, no-store");
  // Whatever it carries: not even a token's format is read.
  expect(await on("/api/nowhere", { authorization: "anything" })).toBe("401 private, no-store");
});

/**
 * Each answer's status; `*` marks one without `private, no-store`, `·` a
 * column that means nothing for a GET.
 */
const onInstallation = `
route                                                                          none account  bearer learner foreign sibling    form    file   limit
GET  /api/auth/get-session                                                      200     200     200     200       ·       ·       ·       ·       ·
GET  /api/auth/organization/list                                                401     200     403     401       ·       ·       ·       ·       ·
POST /api/auth/email-otp/send-verification-otp                                  400     400     403     400     403     403     403     403     1MB
POST /api/auth/sign-in/email-otp                                                400     400     403     400     403     403     403     403     1MB
POST /api/auth/sign-in/social                                                   400     400     403     400     403     403     403     403     1MB
POST /api/auth/sign-out                                                         200     200     200     200     403     403     415     415     1MB
GET  /api/sign-in-settings                                                      200     200     200     200       ·       ·       ·       ·       ·
GET  /api/session/sign-in                                                       404     404     404     404       ·       ·       ·       ·       ·
GET  /api/session/handoff                                                       404     404     404     404       ·       ·       ·       ·       ·
GET  /api/session                                                               401     200     200     401       ·       ·       ·       ·       ·
POST /api/session/sign-out                                                      204     204     403     204     403     403     403     403     204
GET  /api/handoffs/:handoffId                                                   404     404     404     404       ·       ·       ·       ·       ·
POST /api/handoffs/:handoffId                                                   401     404     403     401     403     403     403     403     401
GET  /api/organization                                                          404     404     404     404       ·       ·       ·       ·       ·
GET  /api/courses                                                               401     200     200     401       ·       ·       ·       ·       ·
GET  /api/courses/:courseId/next                                                401     404     404     401       ·       ·       ·       ·       ·
GET  /api/courses/:courseId/activity                                            401     404     404     401       ·       ·       ·       ·       ·
POST /api/courses/:courseId/attempts                                            401     400     400     401     403     403     403     403     1MB
GET  /api/courses/:courseId/learners/:learnerId/progress                        401     404     404     401       ·       ·       ·       ·       ·
GET  /api/courses/:courseId/progress                                            401     404     404     401       ·       ·       ·       ·       ·
GET  /api/organizations                                                         401     200     200     401       ·       ·       ·       ·       ·
GET  /api/organization-setup                                                    401     200     200     401       ·       ·       ·       ·       ·
POST /api/organization-setup                                                    401     404     404     401     403     403     403     403     1MB
GET  /api/organizations/:organizationId/members                                 401     403     403     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/learners/:learnerId/evidence            401     400     400     401     403     403     403     403     1MB
GET  /api/organizations/:organizationId/objectives                              401     403     403     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/objectives                              401     400     400     401     403     403     403     403     1MB
POST /api/organizations/:organizationId/tasks                                   401     400     400     401     403     403     403     403     1MB
POST /api/organizations/:organizationId/tasks/retire                            401     400     400     401     403     403     403     403     1MB
GET  /api/organizations/:organizationId/courses                                 401     403     403     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/courses                                 401     400     400     401     403     403     403     403     1MB
GET  /api/organizations/:organizationId/courses/:courseId                       401     403     403     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/citations                               401     400     400     401     403     403     403     403     1MB
GET  /api/organizations/:organizationId/objectives/:objectiveId/citations       401     403     403     401       ·       ·       ·       ·       ·
GET  /api/organizations/:organizationId/objectives/:objectiveId/tasks           401     403     403     401       ·       ·       ·       ·       ·
GET  /api/organizations/:organizationId/sources                                 401     403     403     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/sources                                 401     400     400     401     403     403     403     403    10MB
GET  /api/organizations/:organizationId/sources/:sourceId                       401     403     403     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/sources/:sourceId/draft                 401     501     501     401     403     403     403     403     1MB
POST /api/organizations/:organizationId/files                                   401     501     501     401     403     403     403     401    50MB
GET  /api/organizations/:organizationId/files/:fileId                           401     501     501     401       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/files/:fileId/text                      401     501     501     401     403     403     403     403     1MB
GET  /api/nowhere                                                               404     404     404     404       ·       ·       ·       ·       ·
`;

/** The learn app's host, where only learner sessions count (ADR 0018). */
const onLearnDomain = `
route                                                                          none account  bearer learner foreign sibling    form    file   limit
GET  /api/auth/get-session                                                      404     404     401     404       ·       ·       ·       ·       ·
GET  /api/auth/organization/list                                                404     404     401     404       ·       ·       ·       ·       ·
POST /api/auth/email-otp/send-verification-otp                                  404     404     401     404     404     404     404     404     404
POST /api/auth/sign-in/email-otp                                                404     404     401     404     404     404     404     404     404
POST /api/auth/sign-in/social                                                   404     404     401     404     404     404     404     404     404
POST /api/auth/sign-out                                                         404     404     401     404     404     404     404     404     404
GET  /api/sign-in-settings                                                      404     404     401     404       ·       ·       ·       ·       ·
GET  /api/session/sign-in                                                       302     302     401     302       ·       ·       ·       ·       ·
GET  /api/session/handoff                                                       302     302     401     302       ·       ·       ·       ·       ·
GET  /api/session                                                               401     401     401     200       ·       ·       ·       ·       ·
POST /api/session/sign-out                                                      204     204     401     204     403     403     403     403     204
GET  /api/handoffs/:handoffId                                                   404     404     401     404       ·       ·       ·       ·       ·
POST /api/handoffs/:handoffId                                                   404     404     401     404     404     404     404     404     404
GET  /api/organization                                                          200     200     401     200       ·       ·       ·       ·       ·
GET  /api/courses                                                               401     401     401     200       ·       ·       ·       ·       ·
GET  /api/courses/:courseId/next                                                401     401     401     404       ·       ·       ·       ·       ·
GET  /api/courses/:courseId/activity                                            401     401     401     404       ·       ·       ·       ·       ·
POST /api/courses/:courseId/attempts                                            401     401     401     400     403     403     403     403     1MB
GET  /api/courses/:courseId/learners/:learnerId/progress                        401     401     401     404       ·       ·       ·       ·       ·
GET  /api/courses/:courseId/progress                                            401     401     401     401       ·       ·       ·       ·       ·
GET  /api/organizations                                                         404     404     401     404       ·       ·       ·       ·       ·
GET  /api/organization-setup                                                    404     404     401     404       ·       ·       ·       ·       ·
POST /api/organization-setup                                                    404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/members                                 404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/learners/:learnerId/evidence            404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/objectives                              404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/objectives                              404     404     401     404     404     404     404     404     404
POST /api/organizations/:organizationId/tasks                                   404     404     401     404     404     404     404     404     404
POST /api/organizations/:organizationId/tasks/retire                            404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/courses                                 404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/courses                                 404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/courses/:courseId                       404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/citations                               404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/objectives/:objectiveId/citations       404     404     401     404       ·       ·       ·       ·       ·
GET  /api/organizations/:organizationId/objectives/:objectiveId/tasks           404     404     401     404       ·       ·       ·       ·       ·
GET  /api/organizations/:organizationId/sources                                 404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/sources                                 404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/sources/:sourceId                       404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/sources/:sourceId/draft                 404     404     401     404     404     404     404     404     404
POST /api/organizations/:organizationId/files                                   404     404     401     404     404     404     404     404     404
GET  /api/organizations/:organizationId/files/:fileId                           404     404     401     404       ·       ·       ·       ·       ·
POST /api/organizations/:organizationId/files/:fileId/text                      404     404     401     404     404     404     404     404     404
GET  /api/nowhere                                                               404     404     401     404       ·       ·       ·       ·       ·
`;

describe.skipIf(!connectionString)("each route's admission", () => {
  let shared!: Credentials;

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    member = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [member.id],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    await testing.seedOrganization(database, {
      organizationId: siblingOrganizationId,
      learnerIds: [],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    for (const [organizationSlug, origin] of [
      [organizationId, learnOrigin],
      [siblingOrganizationId, siblingOrigin],
    ] as const) {
      await registerLearnDomain({
        database,
        baseUrl,
        organizationSlug,
        hostname: new URL(origin).hostname,
      });
    }
    shared = { ...member, learnerCookie: await learnerSessionOn(api, learnOrigin, member.cookie) };
  });

  test("on the installation's host", async () => {
    expect(await table(baseUrl, shared)).toBe(onInstallation.trim());
  });

  test("on a learn domain", async () => {
    expect(await table(learnOrigin, shared)).toBe(onLearnDomain.trim());
  });
});
