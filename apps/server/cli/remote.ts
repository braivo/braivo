// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// By its public name, as the apps import it: these commands are a client of
// Braivo like any other, not a part of the server they happen to ship with.
import { type BraivoClient, createClient } from "@braivo/server/client";

import { type Credentials, readServer } from "./credentials.ts";

// The commands that address a remote Braivo installation over HTTP, as the
// content owner who signed in: what a desktop agent preparing material, or a
// person scripting it, runs on their own machine. HTTP only — no database, no
// `application` — so they work against any installation, Braivo Cloud included.

/** Braivo's device-flow client ID, which the server's allowlist names (ADR 0022). */
const CLIENT_ID = "braivo-cli";

/** RFC 8628's `slow_down`: add five seconds to the interval, for every later poll. */
const SLOW_DOWN_SECONDS = 5;

const EXPIRED = "The code expired before it was approved. Run `braivo login` again.";

type Io = {
  fetch: typeof globalThis.fetch;
  /** Where the code and link are shown to the person signing in. */
  print: (line: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
};

/**
 * Signs in through the device flow and resolves to the session token: shows a
 * code and the console link to approve it at, then polls until the content
 * owner approves or denies it there, or it expires.
 */
export async function signIn(server: string, io: Io): Promise<string> {
  const requested = await postJson(io.fetch, `${server}/api/auth/device/code`, {
    client_id: CLIENT_ID,
  });
  if (!requested.ok) {
    throw new Error(`Braivo at ${server} answered ${requested.status} when asked to sign in.`);
  }
  const code = (await requested.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };

  io.print(`Open ${code.verification_uri_complete}`);
  io.print(`and check that it shows ${code.user_code}, then approve.`);

  let interval = code.interval;
  // Counted in the waits themselves rather than read from a clock, so how long
  // this keeps trying is the code's lifetime however slow each poll is to answer.
  let waited = 0;
  for (;;) {
    if (waited >= code.expires_in) throw new Error(EXPIRED);
    await io.sleep(interval * 1000);
    waited += interval;

    let polled: Response;
    try {
      polled = await postJson(io.fetch, `${server}/api/auth/device/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: CLIENT_ID,
      });
    } catch {
      // A dropped connection or a timeout, while the code is still good: RFC
      // 8628 asks a client to poll less often after one, not to give up.
      interval += SLOW_DOWN_SECONDS;
      continue;
    }
    if (polled.ok) {
      const { access_token } = (await polled.json()) as { access_token: string };
      return access_token;
    }

    const { error } = (await polled.json().catch(() => ({}))) as { error?: string };
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += SLOW_DOWN_SECONDS;
      continue;
    }
    if (error === "access_denied") throw new Error("Sign-in was denied in the browser.");
    if (error === "expired_token") throw new Error(EXPIRED);
    throw new Error(`Braivo answered ${polled.status} (${error ?? "no reason"}) while signing in.`);
  }
}

/** The account a token signs in as, or `undefined` when it has expired or been signed out. */
export async function whoAmI(
  credentials: Credentials,
  fetch: typeof globalThis.fetch,
): Promise<{ email: string } | undefined> {
  const response = await fetch(`${readServer(credentials.server)}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  if (!response.ok) throw new Error(`Braivo answered ${response.status} checking the session.`);

  const session = (await response.json()) as { user: { email: string } } | null;
  return session?.user && { email: session.user.email };
}

/**
 * The organizations the signed-in person belongs to, from Better Auth, which
 * owns membership (ADR 0006): what everything else here is addressed by.
 */
export async function listOrganizations(
  credentials: Credentials,
  fetch: typeof globalThis.fetch,
): Promise<{ id: string; name: string; slug: string }[]> {
  const response = await fetch(`${readServer(credentials.server)}/api/auth/organization/list`, {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  if (!response.ok) {
    throw new Error(`Braivo answered ${response.status} listing your organizations.`);
  }

  const organizations = (await response.json()) as { id: string; name: string; slug: string }[];
  return organizations.map(({ id, name, slug }) => ({ id, name, slug }));
}

/**
 * Braivo's own client, reaching the signed-in installation as the signed-in
 * content owner: the same requests the console makes, with the token where the
 * console has its cookie.
 */
export function remoteClient(
  credentials: Credentials,
  fetch: typeof globalThis.fetch,
): BraivoClient {
  // Checked again here, whoever built the credentials: this is where the token
  // is attached, so it is the one place the rule cannot be skipped.
  const server = readServer(credentials.server);
  return createClient({
    fetch: ((path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.token}`);
      return fetch(new URL(path, server), { ...init, headers });
    }) as typeof globalThis.fetch,
  });
}

function postJson(fetch: typeof globalThis.fetch, url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
