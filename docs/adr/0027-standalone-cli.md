# 0027: `braivo` ships as one compiled file per platform

Status: accepted (2026-09-24)

## Context

A teacher preparing material on their own machine signs in, adds sources, and lets a desktop agent start `braivo mcp` ([ADR 0022](0022-machine-access.md), [ADR 0023](0023-mcp-server.md)). Running `braivo` took a clone of this repository, Bun, and a path into it in the agent's configuration: steps for a developer, not a teacher.

## Decision

- **`bun build --compile` of the same entry point.** The standalone `braivo` is `apps/server/cli/index.ts` with Bun's runtime embedded: one file, no install. Not a second, smaller program: ADR 0022 made the CLI the server's own, and its commands for a remote installation speak only HTTP.
- **Released from a version tag.** `.github/workflows/cli.yml` cross-compiles for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64` on one runner, starts the Linux build to prove it runs, and attaches all five to the tag's GitHub release. `bun run build` builds the local platform's as `apps/server/dist/braivo`.
- **Content owners' commands, not an operator's.** `login`, `sources add`, and `mcp` work anywhere. `serve` is in the file too, but `db migrate` needs the committed migrations beside it, which the bundle does not carry; it says so and points to Braivo's source or container image, where operators run both.
- **The MCP SDK loads when `mcp` runs, not before.** Imported statically, the bundle evaluated the SDK before zod, which better-auth loads lazily, had initialized, and every command crashed on start. `cli/build.test.ts` runs the bundled CLI, so a load order that breaks it fails a test rather than a release.

## Consequences

- Tens of megabytes per file, nearly all runtime. Acceptable for a tool installed once; a smaller one would be a separate program without the server, which nothing yet needs.
- Unsigned: Windows SmartScreen and a browser-downloaded file on macOS warn. `curl` avoids macOS's quarantine; code signing waits for a paying customer's IT department to ask.
- Embedding migrations would let the file serve a whole installation. Bun's embedded files are not a directory Drizzle's migrator can read, so that waits for an operator who wants a single file over a container.
