# 0022: A content owner's tools sign in through the device flow and act as them

Status: accepted (2026-09-24)

## Context

Content owners want to prepare material with the AI they already run — a desktop Claude, Codex, or Grok — rather than pay for it in Braivo's cloud ([ADR 0020](0020-source-content.md)). That work reaches Braivo through a CLI, or an MCP server the desktop agent starts, calling the same HTTP API the console does. The API authenticated only a browser session cookie, which neither has.

What such a tool needs is to act _as the person running it_: add their sources, cite, author tasks, in the organizations they administer, with nothing they could not do in the console. A credential of its own, with its own permissions, would be a second authorization model to keep in step with memberships and roles.

Better Auth ships the device authorization grant (RFC 8628) and a bearer plugin. Its API-key plugin is a separate package.

## Decision

- **The device flow.** `braivo` asks `POST /api/auth/device/code` for a code as client `braivo-cli`, shows the content owner a short code and a link, and polls `POST /api/auth/device/token`. The content owner opens the link in their signed-in browser and approves; the poll then answers a session token. It is how `gh auth login` works, and it never puts a password in a terminal or an agent's context.
- **The token is a session, for Braivo's API on its origin.** Sent as `Authorization: Bearer`, Braivo's routes resolve it through Better Auth like any session cookie. The tool is the person, with exactly their memberships and roles; a learner who approves a code gets a learner's token. Nothing in `application` changes.
- **Only on the installation's host, and never to manage the account.** A request carrying `Authorization` to any other host — a learn domain — is refused before anything reads it ([ADR 0004](0004-one-application-origin.md): a learn domain serves its learn app and nothing else, and will hold learner sessions of its own, [ADR 0018](0018-sign-in-and-invitations.md)); so are the device flow and the console's `/api/organizations` routes there, whatever the credential. Of Better Auth's own endpoints a token reaches three: `get-session` and `organization/list`, which tell a tool who it is and where it may work, and `sign-out`, which ends its own session; managing the account — approving another device, changing an email — takes the person in their browser. Nothing answers a token with a cookie, not even its session's renewal, which would carry it past these limits. Scoped credentials wait for a caller that is not a person.
- **Known clients only.** `DEVICE_CLIENTS` lists `braivo-cli`, which the MCP server is a command of. The approval page names the client, and an ID Braivo does not know is refused rather than shown to someone deciding whether to trust it.
- **Short-lived codes.** A code expires after ten minutes: it is typed moments after it is shown, and a pending code is what device-code phishing — getting someone to approve a code an attacker started — needs to stay alive.
- **Approved in the console.** The link the CLI shows is `/device?user_code=…` (`device` is a reserved slug), a console page under its signed-in layout: it names the program asking and the code, warns against approving a code someone else sent, and offers Approve and Deny. Better Auth's own `/api/auth/device` is the JSON endpoint behind it, not a page.
- **Polling is paced by the flow, not the rate limiter.** `/device/token` is exempt from Better Auth's generic limit, which in production would cut off a CLI polling at its advertised five seconds after about eight minutes — sooner for teachers behind one school address. The flow answers `slow_down` to a poll within a code's interval by itself, and a device code is 40 random characters.

## Alternatives rejected

- **API keys** a content owner creates in the console. A second credential with its own lifetime and scopes, a copy-paste step that tends to leave keys in shell history and agent transcripts, and a separate package. Worth revisiting for callers with no person behind them.
- **Username and password in the CLI.** Puts a password in a terminal, and cannot work with single sign-on once it exists.

## Consequences

- The token lives as long as a browser session and is revoked the same way, by signing that session out: `braivo logout` does, and deletes the saved file only once the server confirms the token no longer signs in. Losing it is losing a signed-in browser.
- Bearer writes to Braivo's API pass the forged-write checks unchanged: they send no `Origin`, and JSON or a file's own media type rather than one a form could send; a browser cannot attach an `Authorization` header cross-origin without a preflight this server does not answer.
- The CLI is the server's own `braivo`, with commands that speak only HTTP — to Braivo's API through `@braivo/server/client`, to Better Auth's endpoints directly: `login <url>` runs the flow and keeps the token in `$XDG_CONFIG_HOME/braivo/credentials.json` (default `~/.config`), readable by its owner only, and the other commands use it. It refuses while a token is saved, since replacing one would leave its session out of `logout`'s reach. One program rather than a second one of the same name, as the architecture's `cli` module allows; it ships standalone as a compiled file ([ADR 0027](0027-standalone-cli.md)). It sends a token only over `https`, or `http` to this machine. The OS keychain is a later refinement.
- A caller acting as no person — an LMS backend posting evidence — has no credential. That needs its own decision, likely API keys scoped to an organization.
- `device_code` is Better Auth's table, generated into `schema/auth.ts` like the rest ([ADR 0006](0006-better-auth.md)).
