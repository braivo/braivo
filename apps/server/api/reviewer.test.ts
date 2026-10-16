// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A reviewer's password (ADR 0018, access-1): it signs in only an account the
// operator lists and set one for, and nothing over HTTP makes, changes, or
// resets one.

import { runMigrations } from "@braivo/db";
import { account, user } from "@braivo/db/schema/auth";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vite-plus/test";

import { removeReviewerPassword, setReviewerPassword } from "../auth/index.ts";
import { baseUrl, connectionString, createTestApi } from "./testing.ts";

const run = crypto.randomUUID();
const reviewerEmail = `api-test-reviewer-${run}@example.com`;
const password = "a reviewer's password, long enough";
const { database, auth, api, signUp, signUpAs } = createTestApi({
  // As the operator writes it; listed lowercased (`config.ts`).
  reviewerEmails: new Set([reviewerEmail]),
});

/** A JSON request to Better Auth from a page on `origin`, the console's by default. */
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    body: JSON.stringify(body),
  });

const signIn = (email: string, tried = password, headers: Record<string, string> = {}) =>
  post("/sign-in/email", { email, password: tried }, headers);

/** The session `cookie` holds, or `null`. */
async function sessionOf(cookie: string) {
  const answered = await api.request("/api/auth/get-session", { headers: { cookie } });
  return ((await answered.json()) as { user: { email: string } } | null)?.user.email ?? null;
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((set) => set.split(";", 1)[0])
    .join("; ");

describe.skipIf(!connectionString)("a reviewer's password", () => {
  test("signs in a listed account the operator set it for, as its email is typed", async () => {
    await runMigrations(connectionString ?? "");
    await signUpAs(reviewerEmail, "Reviewer");
    await setReviewerPassword(auth, { email: reviewerEmail, password });

    const signedIn = await signIn(reviewerEmail.toUpperCase());

    expect(signedIn.status).toBe(200);
    expect(await sessionOf(cookieOf(signedIn))).toBe(reviewerEmail);
  });

  test("refuses a wrong password, and an unlisted account's password, alike", async () => {
    // A password row the operator's command did not make, as if inserted.
    const unlisted = await signUp();
    await database.insert(account).values({
      id: crypto.randomUUID(),
      userId: unlisted.id,
      accountId: unlisted.id,
      providerId: "credential",
      password: await (await auth.$context).password.hash(password),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const answers = [await signIn(reviewerEmail, `${password}!`), await signIn(unlisted.email)];

    expect(answers.map((answer) => answer.status)).toEqual([401, 401]);
    const bodies = await Promise.all(answers.map((answer) => answer.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(answers.every((answer) => answer.headers.getSetCookie().length === 0)).toBe(true);
  });

  test("answers a password of any length alike, listed or not", async () => {
    const unlisted = await signUp();
    for (const tried of ["x".repeat(129), "x".repeat(3), ""]) {
      const answers = [await signIn(reviewerEmail, tried), await signIn(unlisted.email, tried)];
      const [listed, other] = await Promise.all(
        answers.map(async (answer) => ({ status: answer.status, body: await answer.text() })),
      );
      expect(listed).toEqual(other);
    }
  });

  test("is refused from another site, or as a form, as a code's sign-in is", async () => {
    const foreign = await signIn(reviewerEmail, password, { origin: "https://evil.example" });
    // A form, which a page elsewhere may post without asking; Better Auth takes one here.
    const form = await api.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: reviewerEmail, password }).toString(),
    });

    expect([foreign.status, form.status]).toEqual([403, 403]);
  });

  test("allows ten tries a minute from one client address, then refuses", async () => {
    const limited = createTestApi({ reviewerEmails: new Set([reviewerEmail]) });
    (await limited.auth.$context).rateLimit.enabled = true;
    const from = `10.${crypto.getRandomValues(new Uint8Array(3)).join(".")}`;
    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const answered = await limited.api.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl, "x-forwarded-for": from },
        body: JSON.stringify({ email: reviewerEmail, password: "wrong" }),
      });
      statuses.push(answered.status);
    }

    expect(statuses).toEqual([...Array(10).fill(401), 429]);
  });

  test("is never made, set, changed, reset, or checked over HTTP", async () => {
    const signedIn = cookieOf(await signIn(reviewerEmail));
    const someone = await signUp();
    const asked = await Promise.all([
      post("/sign-up/email", { email: someone.email, password, name: "Someone" }),
      post("/request-password-reset", { email: reviewerEmail }),
      post("/reset-password", { newPassword: password, token: "token" }),
      api.request("/api/auth/reset-password/token?callbackURL=/"),
      post(
        "/change-password",
        { currentPassword: password, newPassword: `${password}!` },
        {
          cookie: signedIn,
        },
      ),
      post("/set-password", { newPassword: password }, { cookie: someone.cookie }),
      post("/verify-password", { password }, { cookie: signedIn }),
      post("/unlink-account", { providerId: "credential" }, { cookie: signedIn }),
    ]);

    expect(asked.map((answer) => answer.status)).toEqual(Array(8).fill(404));
    // Neither the account signed in by code nor the reviewer's password changed.
    expect((await signIn(someone.email)).status).toBe(401);
    expect((await signIn(reviewerEmail)).status).toBe(200);
  });

  test("removed, signs in no more, and its sessions end", async () => {
    const signedIn = cookieOf(await signIn(reviewerEmail));

    expect(await removeReviewerPassword(auth, reviewerEmail)).toBe(true);

    expect(await sessionOf(signedIn)).toBeNull();
    expect((await signIn(reviewerEmail)).status).toBe(401);
    expect(await removeReviewerPassword(auth, reviewerEmail)).toBe(false);
  });

  test("removed when already gone, still ends the account's sessions", async () => {
    await setReviewerPassword(auth, { email: reviewerEmail, password });
    const left = cookieOf(await signIn(reviewerEmail));
    // Its password gone some other way, its session left.
    const [{ id }] = (await database
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, reviewerEmail))) as [{ id: string }];
    await database.delete(account).where(eq(account.userId, id));

    expect(await removeReviewerPassword(auth, reviewerEmail)).toBe(false);

    expect(await sessionOf(left)).toBeNull();
  });

  test("is set only for an account that exists, and long enough", async () => {
    await expect(
      setReviewerPassword(auth, { email: `nobody-${run}@example.com`, password }),
    ).rejects.toThrow("No account uses");
    await expect(
      setReviewerPassword(auth, { email: reviewerEmail, password: "short" }),
    ).rejects.toThrow("at least 16 characters");
  });
});

describe.skipIf(!connectionString)("without reviewers", () => {
  test("no password signs in, whatever is stored", async () => {
    const unlisted = createTestApi();
    const someone = await unlisted.signUp();
    await setReviewerPassword(unlisted.auth, { email: someone.email, password });

    const answered = await unlisted.api.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: someone.email, password }),
    });

    expect(answered.status).not.toBe(200);
    expect(answered.headers.getSetCookie()).toEqual([]);
  });
});
