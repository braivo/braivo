// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Everything the process entry point reads from the environment, and every rule
 * about what those values may be.
 *
 * Taken as a plain record rather than from `process.env`, so the rules are
 * testable without a subprocess. Each failure names its variable, and refusing
 * to start beats starting quietly wrong: an empty `PORT` coerced to 0 serves on
 * a random free port and announces a URL nobody can reach it at.
 */
export type AuthConfig = {
  databaseUrl: string;
  secret: string;
  baseUrl: string;
};

export type ServeConfig = AuthConfig & { port: number };

const DEFAULT_PORT = 3000;

/** Better Auth's own stated minimum. */
const MINIMUM_SECRET_LENGTH = 32;

type Environment = Record<string, string | undefined>;

export function readDatabaseUrl(environment: Environment): string {
  return required(environment, "DATABASE_URL");
}

export function readAuthConfig(environment: Environment): AuthConfig {
  return {
    databaseUrl: readDatabaseUrl(environment),
    secret: readSecret(environment, "BETTER_AUTH_SECRET"),
    baseUrl: readUrl(environment, "BRAIVO_URL"),
  };
}

export function readServeConfig(environment: Environment): ServeConfig {
  return { ...readAuthConfig(environment), port: readPort(environment, "PORT") };
}

/**
 * Whitespace counts as unset, as it does for `PORT` below: `NAME=` and a stray
 * space is a setting someone meant to make, and none of these values can be
 * blank. Without it the secret passes outright, thirty-two spaces being
 * thirty-two characters.
 */
function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is not set.`);
  return value;
}

/**
 * Better Auth only warns below its stated minimum, and a warning scrolls past on
 * a self-hosted install nobody is watching while the sessions signed meanwhile
 * are already out there.
 *
 * A length, not a strength: thirty-one random characters are fine and
 * thirty-two repeated ones are not, and nothing here can tell them apart.
 */
function readSecret(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (value.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MINIMUM_SECRET_LENGTH} characters, got ${value.length}.`,
    );
  }
  return value;
}

/**
 * Validated here rather than left to fail inside Better Auth, which throws only
 * after the server has already announced itself as listening.
 */
function readUrl(environment: Environment, name: string): string {
  const value = required(environment, name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${value}".`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http or https URL, got "${value}".`);
  }

  // Braivo serves `/api` from the root of this origin while Better Auth builds
  // its paths from the same value, so a base URL carrying a path makes the two
  // disagree — under `http://host/learn`, every `/api/auth/*` request 404s. Said
  // rather than quietly dropped, since it is a misunderstanding, not a shape.
  const bare =
    (parsed.pathname === "/" || parsed.pathname === "") &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.username === "" &&
    parsed.password === "";
  if (!bare) {
    throw new Error(
      `${name} must be a bare origin such as https://learn.example.com, got "${value}".`,
    );
  }

  // The origin rather than the input: `new URL` tolerates surrounding
  // whitespace and odd casing, and Better Auth parses the value again without
  // tolerating either.
  return parsed.origin;
}

/**
 * Unset or blank means the default; anything else must be a real port. `Number`
 * turns `""` into 0 and `"80.5"` into a non-integer, both of which Bun accepts
 * in its own way and neither of which the operator meant.
 */
function readPort(environment: Environment, name: string): number {
  const value = environment[name];
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a whole number between 1 and 65535, got "${value}".`);
  }
  return port;
}
