// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Everything the server reads from the environment, and every rule about what
 * those values may be. Every host reads `readServerConfig`'s part; `serve` the
 * rest too.
 *
 * Passed in rather than read from `process.env`, so the rules are testable
 * without a subprocess. Each failure names its variable, and refusing
 * to start beats starting quietly wrong: an empty `PORT` coerced to 0 serves on
 * a random free port and announces a URL nobody can reach it at.
 */

/** What the server needs from any host; databases, files, and mail are the host's own. */
export type ServerConfig = {
  secret: string;
  baseUrl: string;
  /** The model that reads files and drafts courses, or none: content owners' own agents can instead. */
  ai?: {
    apiKey: string;
    model: string;
    organizations: "all" | ReadonlySet<string>;
    monthlyLimit?: number;
  };
  /** Google's OAuth client, offering "Continue with Google", or none: email codes alone. */
  google?: { clientId: string; clientSecret: string };
  /**
   * The domain under which anyone signed in may set up an organization, served
   * at `<slug>.<selfServeDomain>`, or none: the operator creates every one (ADR 0018).
   */
  selfServeDomain?: string;
};

export type ServeConfig = ServerConfig & {
  databaseUrl: string;
  port: number;
  /**
   * The one address to listen on, or every one. A server logging sign-in codes
   * listens on its loopback hostname alone, so nobody else can ask for them.
   */
  hostname?: string;
  /** How sign-in codes reach people: an SMTP server, or this server's log. */
  mail: { url: string; from: string } | "log";
  /** Where uploaded files are kept, or nowhere: an installation may do without them. */
  files?: FilesConfig;
};

/** Anthropic's balance of quality and cost for the server's AI; `BRAIVO_AI_MODEL` overrides it. */
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

/** The variables Braivo reads. */
type VariableName =
  | "DATABASE_URL"
  | "BETTER_AUTH_SECRET"
  | "BRAIVO_URL"
  | "PORT"
  | "BRAIVO_SMTP_URL"
  | "BRAIVO_MAIL_FROM"
  | "BRAIVO_FILES"
  | "ANTHROPIC_API_KEY"
  | "BRAIVO_AI_MODEL"
  | "BRAIVO_AI_ORGANIZATIONS"
  | "BRAIVO_AI_MONTHLY_LIMIT"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "BRAIVO_SELF_SERVE_DOMAIN";

/**
 * A Worker's `env`, bindings beside the variables, or `process.env`, which
 * TypeScript takes only as the record: Bun declares none of these variables.
 */
type Environment =
  | Readonly<Record<string, string | undefined>>
  | { readonly [Name in VariableName]?: string | undefined };

export function readDatabaseUrl(environment: Environment): string {
  return required(environment, "DATABASE_URL");
}

/** For the operator's commands, which need the database and Better Auth but serve nothing. */
export type AuthConfig = { databaseUrl: string; secret: string; baseUrl: string };

export function readAuthConfig(environment: Environment): AuthConfig {
  return {
    databaseUrl: readDatabaseUrl(environment),
    secret: readSecret(environment, "BETTER_AUTH_SECRET"),
    baseUrl: readUrl(environment, "BRAIVO_URL"),
  };
}

export function readServerConfig(environment: Environment): ServerConfig {
  const selfServe = readSelfServeDomain(environment);
  const ai = readAi(environment);
  // Unlisted, anyone's new organization would spend the key.
  if (selfServe.selfServeDomain && ai.ai?.organizations === "all") {
    throw new Error(
      "BRAIVO_AI_ORGANIZATIONS is not set: with BRAIVO_SELF_SERVE_DOMAIN anyone may create an organization, so list the IDs of the organizations that may use ANTHROPIC_API_KEY.",
    );
  }
  return {
    secret: readSecret(environment, "BETTER_AUTH_SECRET"),
    baseUrl: readUrl(environment, "BRAIVO_URL"),
    ...ai,
    ...readGoogle(environment),
    ...selfServe,
  };
}

export function readServeConfig(environment: Environment): ServeConfig {
  const databaseUrl = readDatabaseUrl(environment);
  const server = readServerConfig(environment);
  const mail = readMail(environment, server.baseUrl);
  return {
    ...server,
    databaseUrl,
    port: readPort(environment, "PORT"),
    // `[::1]` is a URL's spelling; a socket takes `::1`.
    ...(mail === "log" && { hostname: new URL(server.baseUrl).hostname.replace(/^\[|\]$/g, "") }),
    mail,
    ...readFiles(environment, "BRAIVO_FILES"),
  };
}

/** Hosts only this machine reaches. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `BRAIVO_SMTP_URL` (`smtp://` or `smtps://`, credentials in the URL) and the
 * `BRAIVO_MAIL_FROM` it sends as. Unset, codes are written to the log, but only
 * while `BRAIVO_URL` is loopback: there, whoever reads the log is whoever signs
 * in. Anywhere else that would announce sent codes no one receives and put
 * live credentials in logs, so serving is refused (ADR 0033).
 */
function readMail(environment: Environment, baseUrl: string): ServeConfig["mail"] {
  const smtpUrl = environment.BRAIVO_SMTP_URL?.trim();
  if (!smtpUrl) {
    if (LOOPBACK.has(new URL(baseUrl).hostname)) return "log";
    throw new Error(
      "BRAIVO_SMTP_URL is not set: people sign in with codes sent by email, so an installation others reach must send it.",
    );
  }
  // With a host: Nodemailer would take a missing one as localhost. Not echoed
  // back, since the URL carries the SMTP password.
  const parsed = URL.canParse(smtpUrl) ? new URL(smtpUrl) : undefined;
  if (!parsed?.hostname || (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:")) {
    throw new Error("BRAIVO_SMTP_URL must be an smtp:// or smtps:// URL with a host.");
  }
  return { url: smtpUrl, from: required(environment, "BRAIVO_MAIL_FROM").trim() };
}

/**
 * `BRAIVO_AI_ORGANIZATIONS`: unset lets every organization spend the key, safe
 * while the operator creates every one, so self-serve requires it
 * (docs/adr/0018-sign-in-and-invitations.md); otherwise only the
 * comma-separated IDs it lists. Set but naming none — an
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
function readAi(environment: Environment): { ai?: ServerConfig["ai"] } {
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
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` offer signing in with Google
 * (ADR 0018): both or neither, since one alone is a deployment half done.
 */
function readGoogle(environment: Environment): { google?: ServerConfig["google"] } {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return {};
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together: set both to offer Google sign-in, or neither.",
    );
  }
  return { google: { clientId, clientSecret } };
}

/**
 * `BRAIVO_SELF_SERVE_DOMAIN`, a hostname such as `braivo.app` whose subdomains
 * the operator serves the learn app on, wildcard DNS and certificate included
 * (ADR 0018). Lowercased, as hosts are matched. Unset or blank turns self-serve off.
 */
function readSelfServeDomain(environment: Environment): { selfServeDomain?: string } {
  const value = environment.BRAIVO_SELF_SERVE_DOMAIN?.trim().toLowerCase();
  if (value === undefined || value === "") return {};
  // DNS labels, the last not a number, which makes an IP address; a URL's
  // host would also take `*` and `_`. One label will do: `localhost` serves
  // `<slug>.localhost` in development. Each hostname is checked in full at setup.
  const labels = value.split(".");
  if (
    // Room for a one-letter slug and its dot within a hostname's 253.
    value.length > 251 ||
    /^\d+$/.test(labels.at(-1) ?? "") ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(
      `BRAIVO_SELF_SERVE_DOMAIN must be a hostname such as braivo.app, got "${value}".`,
    );
  }
  return { selfServeDomain: value };
}

/**
 * `s3://<bucket>`, or an absolute path. Not a relative one, which would put
 * files wherever the process happened to start, and move them when it started
 * somewhere else. Unset or blank stores no files.
 */
function readFiles(environment: Environment, name: VariableName): { files?: FilesConfig } {
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
function required(environment: Environment, name: VariableName): string {
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
function readSecret(environment: Environment, name: VariableName): string {
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
function readUrl(environment: Environment, name: VariableName): string {
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
function readPort(environment: Environment, name: VariableName): number {
  const value = environment[name];
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a whole number between 1 and 65535, got "${value}".`);
  }
  return port;
}
