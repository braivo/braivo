// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The installation `braivo` signed in to, and the session token the device
 * flow gave it (docs/adr/0022-machine-access.md). One at a time: signing in
 * again takes `braivo logout` first.
 */
export type Credentials = { server: string; token: string };

/**
 * The origin of the installation at `value`, or an error saying why a token may
 * not be sent there. `https` only, except on this machine: a session token sent
 * over plain HTTP anywhere else can be read by anyone on the way.
 *
 * Applied to a saved address as well as a typed one, since the file it is read
 * from can be edited by hand.
 */
export function readServer(value: string): string {
  const url = URL.parse(value.trim());
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`"${value}" is not a Braivo address, such as https://braivo.example.com.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) {
    throw new Error(`Braivo at ${url.origin} must be reached over https.`);
  }
  return url.origin;
}

/**
 * Where credentials are kept: `$XDG_CONFIG_HOME/braivo`, or `~/.config/braivo`.
 * A file rather than the OS keychain, readable only by its owner — the same
 * protection a browser gives its cookies on disk.
 */
export function credentialsPath(environment: Record<string, string | undefined>): string {
  const base = environment.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "braivo", "credentials.json");
}

/**
 * Writes the token into a new file only its owner can read, then renames it
 * over the old one: overwriting in place would keep the old file's permissions,
 * and a file left readable by others would show them the token until it was
 * tightened. The rename replaces it whole, so nobody reads half of one either.
 */
export async function saveCredentials(path: string, credentials: Credentials): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `mode` applies only to a directory `mkdir` creates.
  await chmod(directory, 0o700);

  const draft = join(directory, `.credentials-${crypto.randomUUID()}.json`);
  try {
    // `wx`: created here, never an existing file, so `mode` is what it gets.
    await writeFile(draft, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(draft, path);
  } catch (error) {
    await rm(draft, { force: true });
    throw error;
  }
}

/** Forgets the saved credentials; nothing to forget is not an error. */
export async function deleteCredentials(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** The saved credentials, or `undefined` when none are saved. */
export async function loadCredentials(path: string): Promise<Credentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  // Deleting it is the way out: `braivo login` refuses while a file is here.
  const notCredentials = new Error(
    `${path} is not a Braivo credentials file. Delete it to sign in.`,
  );
  let parsed: Partial<Credentials> | null;
  try {
    parsed = JSON.parse(raw) as Partial<Credentials> | null;
  } catch {
    throw notCredentials;
  }
  const { server, token } = parsed ?? {};
  if (typeof server !== "string" || typeof token !== "string") throw notCredentials;
  return { server: readServer(server), token };
}
