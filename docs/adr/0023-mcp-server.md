# 0023: `braivo mcp` serves Braivo's API as tools, through the official SDK

Status: accepted (2026-09-24)

## Context

Content owners want to turn their material into a course with the AI they already pay for — a desktop Claude, Codex, or Grok — rather than with credits in Braivo's cloud ([ADR 0020](0020-source-content.md)). Those agents take tools over the Model Context Protocol. `braivo login` signs a content owner's own tools in as them ([ADR 0022](0022-machine-access.md)); what was missing is the tools.

## Decision

- **A command of the CLI.** `braivo mcp` serves over stdio, using the credentials `braivo login` saved. A desktop agent starts it as a subprocess; nothing listens on a port.
- **Tools are the API, one call each.** `list_organizations`, `add_source`, `cite_sources`, `author_tasks`, `create_course`, and the rest are each a call of `@braivo/server/client` as the signed-in person. The server decides nothing the API does not, so an agent is held to exactly the rules the console is, and a rule added to the API reaches it without a change here.
- **The citation check is the feedback loop.** The server's instructions tell the agent the workflow and that every quote is checked. When Braivo refuses a quote, the tool answers with Braivo's own reason as an error result — "Citation 2: the quote occurs more than once in the source; quote more of it" — which the agent reads and corrects, rather than a protocol failure it cannot. The client carries a 400's `{ "error" }` as `BraivoError.reason` for this.
- **The official TypeScript SDK**, `@modelcontextprotocol/sdk`, MIT-licensed, with Zod for tool schemas. The protocol is young and moving — capability negotiation, structured output, new transports — and the SDK is where those land first; a hand-written JSON-RPC loop would be less code at first and a standing obligation to track the spec by hand. Its dependencies are the server's, not the apps': the CLI ships with the server ([ADR 0022](0022-machine-access.md)), and nothing browser-side imports it.

## Consequences

- Drafting happens on the content owner's machine and at their cost; Braivo sees only the results, and verifies them. A draft by Braivo's own model ([ADR 0029](0029-server-drafting.md)) is accepted through the same endpoints.
- Tool inputs are validated twice: by the tool's schema, which catches a malformed call before a request is made, and by the API, which is the one that counts.
- A new task kind is a new variant in `content` and in `author_tasks`' schema.
- The server's `instructions` and tool descriptions are prompts, version-controlled beside the code that uses them, as the architecture asks.
- A content owner in several organizations names one per call; there is no "current organization" state to get wrong between calls.
- `read_source` hands the agent a source's text, which may carry instructions of its own — a transcript saying "ignore your task", say. Braivo cannot tell text from instruction, and does not try. What bounds the damage is that the agent acts as the content owner and nothing more, in organizations they already administer, over the same API and checks as the console; the agent's own client is where a person approves what it does.
