// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Test support: what every provider's ID-token sign-in holds to (ADR 0062),
// run by each provider's suite through the mount, so none is proven by
// another's. Nothing here is part of the server's behaviour.

import { createHash } from "node:crypto";

import type { Database } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import { eq } from "drizzle-orm";
import { expect, test } from "vite-plus/test";

import type { Api } from "./app.ts";

/** What the contract needs of a provider's suite. */
export type IdTokenProvider = {
  provider: "google" | "apple";
  api: Api;
  database: Database;
  /** Stands in for the provider's keys, where Better Auth fetches them; before each test. */
  serveKeys: () => Promise<void>;
  /** A token for `claims`, valid but for what `broken` asks. */
  token: (
    claims: Record<string, unknown>,
    broken?: { issuer?: string; expiresIn?: string; forged?: boolean; audience?: string },
  ) => Promise<string>;
  /** A fresh address the provider signs in to an account. */
  newEmail: () => string;
};

/**
 * What the apps hand the provider as the nonce: the lowercase hex SHA-256 of
 * the raw nonce string's UTF-8 bytes (`api/index.ts`).
 */
export const hashed = (nonce: string) => createHash("sha256").update(nonce, "utf8").digest("hex");

/** Defines the contract's tests, inside the caller's `describe`. */
export function idTokenContract(p: IdTokenProvider) {
  const json = { "content-type": "application/json" };
  const newNonce = async () => {
    const response = await p.api.request("/api/sign-in/nonce", {
      method: "POST",
      headers: json,
      body: "{}",
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { nonce: string }).nonce;
  };
  const signIn = (idToken: Record<string, unknown>) =>
    p.api.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ provider: p.provider, idToken }),
    });
  const codeOf = async (response: Response) =>
    ((await response.clone().json()) as { code?: string }).code;
  /** Whether the answer set a session cookie with a value. */
  const setsSession = (response: Response) =>
    response.headers.getSetCookie().some((set) => /session_token=[^;]/.test(set));
  const accountOf = async (email: string) =>
    (await p.database.select().from(authTables.user).where(eq(authTables.user.email, email)))[0];
  /** Refused with `code`, nothing signed in, no account made for `email`. */
  const refused = async (response: Response, status: number, code: string, email?: string) => {
    expect(response.status).toBe(status);
    expect(await codeOf(response)).toBe(code);
    expect(setsSession(response)).toBe(false);
    if (email !== undefined) expect(await accountOf(email)).toBeUndefined();
  };

  test(`${p.provider}: signs in with a fresh nonce's hash as the claim, once`, async () => {
    await p.serveKeys();
    const nonce = await newNonce();
    const token = await p.token({ email: p.newEmail(), nonce: hashed(nonce) });
    const first = await signIn({ token, nonce });

    expect(first.status).toBe(200);
    expect(setsSession(first)).toBe(true);
    await refused(await signIn({ token, nonce }), 401, "NONCE_INVALID");
  });

  test(`${p.provider}: refuses a token without a nonce, or with one never issued`, async () => {
    await p.serveKeys();
    const email = p.newEmail();
    const token = await p.token({ email, nonce: hashed("made-up") });

    await refused(await signIn({ token }), 400, "NONCE_REQUIRED", email);
    await refused(await signIn({ token, nonce: "" }), 400, "NONCE_REQUIRED", email);
    await refused(await signIn({ token, nonce: "made-up" }), 401, "NONCE_INVALID", email);
  });

  test(`${p.provider}: refuses an expired nonce`, async () => {
    await p.serveKeys();
    const nonce = await newNonce();
    await p.database
      .update(authTables.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTables.verification.id, `sign-in-nonce:${hashed(nonce)}`));
    const email = p.newEmail();
    const token = await p.token({ email, nonce: hashed(nonce) });

    await refused(await signIn({ token, nonce }), 401, "NONCE_INVALID", email);
  });

  /** Nonce claims that are not the sent nonce's hash, given it and another issued one. */
  const wrongClaims: [string, (nonce: string, other: string) => { nonce?: string }][] = [
    // As a client choosing its own nonce would send.
    ["the raw nonce", (nonce) => ({ nonce })],
    ["another nonce's hash", (_, other) => ({ nonce: hashed(other) })],
    ["no nonce", () => ({})],
  ];
  test.each(wrongClaims)(
    `${p.provider}: refuses a claim of %s, spending the sent nonce`,
    async (_, claim) => {
      await p.serveKeys();
      const email = p.newEmail();
      const nonce = await newNonce();
      const token = await p.token({ email, ...claim(nonce, await newNonce()) });

      await refused(await signIn({ token, nonce }), 401, "INVALID_TOKEN", email);
      await refused(await signIn({ token, nonce }), 401, "NONCE_INVALID", email);
    },
  );

  test(`${p.provider}: ${p.provider === "apple" ? "accepts" : "refuses"} a claim that hashes the hash again`, async () => {
    // Apple's provider compares `exact-or-sha256`: harmless, as the raw nonce
    // is still redeemed once. Google's compares exactly.
    await p.serveKeys();
    const nonce = await newNonce();
    const email = p.newEmail();
    const token = await p.token({ email, nonce: hashed(hashed(nonce)) });
    const response = await signIn({ token, nonce });

    if (p.provider === "apple") expect(response.status).toBe(200);
    else await refused(response, 401, "INVALID_TOKEN", email);
  });

  test.each([
    ["another audience", { audience: "someone-elses-client" }],
    ["another issuer", { issuer: "https://evil.example" }],
    ["an expired token", { expiresIn: "-1m" }],
    ["a forged signature", { forged: true }],
  ])(`${p.provider}: refuses %s, spending its nonce`, async (_, broken) => {
    await p.serveKeys();
    const nonce = await newNonce();
    const email = p.newEmail();
    const token = await p.token({ email, nonce: hashed(nonce) }, broken);

    await refused(await signIn({ token, nonce }), 401, "INVALID_TOKEN", email);
    await refused(await signIn({ token, nonce }), 401, "NONCE_INVALID", email);
  });

  test(`${p.provider}: of two sign-ins carrying one nonce at once, exactly one is let through`, async () => {
    await p.serveKeys();
    const nonce = await newNonce();
    const token = await p.token({ email: p.newEmail(), nonce: hashed(nonce) });
    const answers = await Promise.all([signIn({ token, nonce }), signIn({ token, nonce })]);
    const statuses = answers.map((answer) => answer.status).sort((a, b) => a - b);

    expect(statuses).toEqual([200, 401]);
    await refused(
      answers.find((answer) => answer.status === 401)!,
      401,
      "NONCE_INVALID",
    );
  });
}
