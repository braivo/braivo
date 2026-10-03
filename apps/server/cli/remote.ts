// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// By its public name, as the apps import it: these commands are a client of
// Braivo like any other, not a part of the server they happen to ship with.
import { type BraivoClient, createClient } from "@braivo/server/client";

import {
  type Credentials,
  deleteCredentials,
  loadCredentials,
  readServer,
  saveCredentials,
} from "./credentials.ts";

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

/**
 * Signs in to the installation at `address` and saves the token at `path`.
 * Refuses while one is saved: replacing it would leave that session live and
 * out of `logout`'s reach, where a running `braivo mcp` may still use it.
 */
export async function login(path: string, address: string, io: Io): Promise<Credentials> {
  const server = readServer(address);
  const saved = await loadCredentials(path);
  if (saved) throw new Error(`Already signed in to ${saved.server}. Run \`braivo logout\` first.`);

  const credentials = { server, token: await signIn(server, io) };
  await saveCredentials(path, credentials);
  return credentials;
}

/**
 * Signs the saved token's session out on the server, then deletes the file.
 * Resolves to the installation signed out of, or `undefined` when nothing was
 * saved; a session already ended counts as signed out. The file goes only once
 * the server confirms: forgetting a live token leaves every copy of it working.
 */
export async function logout(
  path: string,
  fetch: typeof globalThis.fetch,
): Promise<string | undefined> {
  const credentials = await loadCredentials(path);
  if (!credentials) return undefined;

  try {
    const response = await fetch(`${readServer(credentials.server)}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.token}` },
    });
    if (!response.ok) throw new Error(`Braivo answered ${response.status} signing out.`);
    // Better Auth answers success even when deleting the session failed, so
    // only a token that no longer signs in proves it.
    if (await whoAmI(credentials, fetch)) throw new Error("The session is still signed in.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not sign out of ${credentials.server}: ${reason}\nThe token may still work. Run \`braivo logout\` again, or delete ${path} to forget it on this machine only.`,
    );
  }

  try {
    await deleteCredentials(path);
  } catch (error) {
    // `login` refuses while the file is here, so say the session is already over.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Signed out of ${credentials.server}, but could not delete ${path}: ${reason}\nDelete it before signing in again.`,
    );
  }
  return credentials.server;
}

/** The account a token signs in as, or `undefined` when it has expired or been signed out. */
export async function whoAmI(
  credentials: Credentials,
  fetch: typeof globalThis.fetch,
): Promise<{ email: string } | undefined> {
  // Never renews: probing a sign-out that failed would extend the session.
  const response = await fetch(
    `${readServer(credentials.server)}/api/auth/get-session?disableRefresh=true`,
    {
      headers: { authorization: `Bearer ${credentials.token}` },
    },
  );
  if (!response.ok) throw new Error(`Braivo answered ${response.status} checking the session.`);

  // Only `null` is signed out: `logout` deletes the token on it.
  const session = (await response.json()) as { user?: { email?: unknown } } | null;
  if (session === null) return undefined;
  const email = session.user?.email;
  if (typeof email !== "string") throw new Error("Braivo answered an unexpected session.");
  return { email };
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
