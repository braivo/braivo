# 0027: `braivo` ships as one compiled file per platform, installed by one command

Status: accepted (2026-09-24)

## Context

A teacher preparing material on their own machine signs in, adds sources, and lets a desktop agent start `braivo mcp` ([ADR 0022](0022-machine-access.md), [ADR 0023](0023-mcp-server.md)). Running `braivo` took a clone of this repository, Bun, and a path into it in the agent's configuration: steps for a developer, not a teacher.

## Decision

- **The content owner's program, apart from the server.** `braivo` is `packages/cli`: `login`, `logout`, `sources add`, and `mcp`, each speaking only HTTP to an installation, its tools from `@braivo/server/mcp`. The operator's commands (`serve`, `db migrate`, `organization …`) stay the server's, `apps/server/cli/index.ts`, run from Braivo's source or container image beside its migrations.
- **`bun build --compile` of that entry point.** One file with Bun's runtime embedded, nothing else to install. `bun run build` builds this machine's as `packages/cli/dist/braivo`; `--version` answers the release, or `development`.
- **Released from a version tag.** `.github/workflows/cli.yml` cross-compiles for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64` on one runner, starts each build on its own system, and only then attaches them, with the installers, to the tag's GitHub release, as a prerelease; it then installs that release on Linux, macOS, and Windows as a content owner would, and only then makes it the latest, the one the installers fetch.
- **Installed by a script the release carries.** `curl -fsSL https://braivo.app/install.sh | bash`, or `irm https://braivo.app/install.ps1 | iex` on Windows, both redirects to the latest release's copy. Each fetches the build for the machine into a per-user directory (`~/.local/bin`; `%LOCALAPPDATA%\Programs\Braivo`, added to the user's Path), starts it, and only then replaces the one installed; running it again updates. `BRAIVO_VERSION` picks a tag. Anything beyond placing the file belongs in `braivo`, where it is tested. `packages/cli/install.test.ts` runs `install.sh` against stand-ins for the network and the machine.
- **Bundled whole, and tested so.** Bundling reorders module initialization, which once crashed every command on start; `packages/cli/build.test.ts` runs the bundled CLI, so a load order that breaks it fails a test rather than a release.

## Alternatives rejected

- **The server's entry point compiled whole** (replaced): it carried `serve` and `db migrate` without the migrations the latter needs, and the server's dependencies into every content owner's file.
- **Checksums beside the files.** Fetched from the same release over the same HTTPS, they catch no tampering a signature would; signing waits with code signing, below.
- **Homebrew, winget, npm, or a self-update command.** More channels to keep in step before anyone asks; the script already updates.

## Consequences

- Tens of megabytes per file, nearly all runtime. Acceptable for a tool installed once.
- Linux builds are glibc: Alpine gets none until someone asks for Bun's `-musl` targets. Windows on Arm runs the x64 build emulated.
- Unsigned: Windows SmartScreen and a browser-downloaded file on macOS warn. `curl` avoids macOS's quarantine; code signing waits for a paying customer's IT department to ask.
- `braivo.app/install.sh` and `install.ps1` are redirects kept by Braivo Cloud, outside this repository; the scripts work from the release's own URL without them.
