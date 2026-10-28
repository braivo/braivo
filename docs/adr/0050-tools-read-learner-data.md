# 0050: An organization decides whether tools read its learners' data, off by default

Status: accepted (2026-10-28). Applies on top of [ADR 0022](0022-machine-access.md) and [ADR 0045](0045-remote-mcp.md): it narrows what a token or a connection reads, never widens it.

## Context

A teacher's tool acts as the teacher ([ADR 0022](0022-machine-access.md)): whatever they may read in the console, their `braivo` session token reads too, and an AI connected at `/mcp` will once it has `braivo:progress` ([ADR 0045](0045-remote-mcp.md)). When an AI reads a course's progress or a roster, learners' names and learning history reach that AI's provider. Whether that is acceptable is the school's decision, not each teacher's.

Braivo cannot tell what is behind a credential: Claude, Codex, a script, or `curl` all present a token. So the line is drawn between a person's browser and any tool, with AI the main reason for it. With the setting on, the school trusts its teachers' choice of AI; Braivo does not check, and does not claim to check, which provider reads the answer.

## Decision

- **One setting per organization, off by default:** whether tools read its learners' data, for every organization, existing ones included. Other policies (per teacher, per provider, per course, authoring through tools) wait until a school asks for one.
- **What it gates:** while off, a request made as a tool reads nothing that names or reports on other members of the organization: a course's overview and another member's report, refused as a missing course is (progress-2), and the member list and groups, and changing a group, whose answer lists its people, refused `403`. That is the line ADR 0045 draws for `braivo:progress`. A learner's own report is theirs to read through any tool: the setting does not apply to it, every other check still does. Writes that answer no one's data, creating a group or recording evidence, stay open to tools; their refusals may still tell whether an ID is a member, since the setting keeps learners' data out of answers, not every inference from a refusal.
- **Tool or browser, from the credential.** The guards resolve which credential acted, a browser's session, a device-flow token, or a connection, and hand the use case an access kind, `browser` or `tool` (a token and a connection alike), beside the user ID. A request carrying `Authorization` is a tool's whatever cookie it also carries, as for publishing ([ADR 0039](0039-published-in-the-console.md)), and acts as the token's person. Each gated use case takes it required, never defaulted, and calls one shared check, `mayReadLearnerData`, against the organization owning what is read: a new route over a gated use case inherits the rule, a new use case calls the check. A connection's scope stays a separate check.
- **Read on every request.** The stored value, never a cached one, so switching it off refuses a token's next request, even one issued before.
- **A column of Braivo's own on `organization`,** `tools_read_learner_data`, a non-null boolean defaulting to `false`, declared as a Better Auth additional field that its API takes no input for (`input: false`), so its organization update, open to any `owner` or `admin` from any credential, cannot change it. Declared there because Better Auth's tables are generated from its config ([ADR 0006](0006-better-auth.md)).
- **Changed by an `owner` or `admin`, from a browser alone,** at the console's organization settings: a tool cannot grant itself access. One switch, saying what turns on: tools these people connect read learners' names, progress, and learning history, which may reach the tool's AI provider. No operator command: the school decides, not the operator.

## Alternatives rejected

- **Better Auth's `metadata`:** free text that Better Auth's own organization update writes, past Braivo's rules on who changes the setting and how.
- **Checking in the routes:** a new route over the same use case would forget it; MCP reaches the same use cases in-process.
- **Telling AI tools from other tools:** Braivo cannot; a token says nothing true about what holds it.
- **On by default, or on for existing organizations:** a school would learn its data had left only afterwards.
- **A cache of the setting:** switching it off must hold at the next request, and the read is one indexed row.

## Consequences

- With the setting off, no tool reads others' data through the API, an administrator's CLI included; the console is unaffected. `braivo:progress` applies on top of it.
- Each gated use case takes the access kind, so every caller, tests and fixtures included, says how it came.
