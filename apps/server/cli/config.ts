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

export type ServeConfig = AuthConfig & {
  port: number;
  /** Where uploaded files are kept, or nowhere: an installation may do without them. */
  files?: FilesConfig;
  /** The model that drafts courses, or none: content owners' own agents can draft instead. */
  ai?: {
    apiKey: string;
    model: string;
    organizations: "all" | ReadonlySet<string>;
    monthlyLimit?: number;
  };
};

/** Anthropic's balance of quality and cost for drafting; `BRAIVO_AI_MODEL` overrides it. */
const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * A directory on this machine, or an S3-compatible bucket — R2, Google Cloud
 * Storage, MinIO, S3 — whose endpoint and keys Bun's S3 client reads from its
 * own variables: `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
 * `S3_REGION` (docs/adr/0028-original-files.md).
 */
export type FilesConfig = { directory: string } | { bucket: string };

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
  return {
    ...readAuthConfig(environment),
    port: readPort(environment, "PORT"),
    ...readFiles(environment, "BRAIVO_FILES"),
    ...readAi(environment),
  };
}

/**
 * `BRAIVO_AI_ORGANIZATIONS`: unset lets every organization spend the key, since
 * the operator creates every one (docs/adr/0018-sign-in-and-invitations.md);
 * otherwise only the comma-separated IDs it lists. Set but naming none — an
 * empty value a deployment template left — is refused rather than read as
 * unset, which would open the operator's credits to every organization; so is
 * `*`, which reads as "all" but would match no ID.
 */
function readAiOrganizations(value: string | undefined): "all" | ReadonlySet<string> {
  if (value === undefined) return "all";
  const listed = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (listed.length === 0 || listed.includes("*")) {
    throw new Error(
      "BRAIVO_AI_ORGANIZATIONS lists the IDs of the organizations that may use ANTHROPIC_API_KEY, comma-separated; leave it unset to let every organization.",
    );
  }
  return new Set(listed);
}

/**
 * An Anthropic key turns server-side drafting on (docs/adr/0029-server-drafting.md);
 * without one, drafting answers 501 and content owners draft with their own agents.
 */
function readAi(environment: Environment): { ai?: ServeConfig["ai"] } {
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return {};
  const model = environment.BRAIVO_AI_MODEL?.trim() || DEFAULT_MODEL;

  const organizations = readAiOrganizations(environment.BRAIVO_AI_ORGANIZATIONS);
  const limit = environment.BRAIVO_AI_MONTHLY_LIMIT?.trim();
  if (limit === undefined || limit === "") return { ai: { apiKey, model, organizations } };
  const monthlyLimit = Number(limit);
  if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1) {
    throw new Error(
      `BRAIVO_AI_MONTHLY_LIMIT must be a whole number of requests, at least 1, got "${limit}".`,
    );
  }
  return { ai: { apiKey, model, organizations, monthlyLimit } };
}

/**
 * `s3://<bucket>`, or an absolute path. Not a relative one, which would put
 * files wherever the process happened to start, and move them when it started
 * somewhere else. Unset or blank stores no files.
 */
function readFiles(environment: Environment, name: string): { files?: FilesConfig } {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") return {};

  if (value.startsWith("s3://")) {
    const bucket = value.slice("s3://".length).replace(/\/$/, "");
    // S3's naming rule, which R2 and Google Cloud Storage keep to as well.
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error(`${name} must name a bucket as s3://<bucket>, got "${value}".`);
    }
    return { files: { bucket } };
  }
  if (!value.startsWith("/")) {
    throw new Error(`${name} must be s3://<bucket> or an absolute path, got "${value}".`);
  }
  return { files: { directory: value } };
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
