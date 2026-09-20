# 0002: AGPL-3.0-only for Braivo's code, with a commercial license, and no SDK package

Status: accepted (2026-09-16). Supersedes [ADR 0001](0001-licensing.md).

## Context

[ADR 0001](0001-licensing.md) split the repository in two: an AGPL core in `packages/braivo`, and an Apache-2.0 client in `packages/sdk` so developers could embed it without copyleft. That split cost more than it returned:

- The SDK could not import the server, so every request and response shape was written twice and kept in step by tests and by hand.
- Its only in-repository consumers are Braivo's own apps, which are AGPL anyway ([ADR 0003](0003-workspace-layout.md)).
- A developer integrating from outside does not need a client package to do it. The HTTP API is the documented contract, and a separate application does not become subject to Braivo's AGPL solely because it calls it.

`packages/braivo` had a reason of its own, to be published as an installable CLI. Nothing has been published, hosting is undecided, and a deployable server is an app rather than a library.

## Decision

- Every file Braivo writes is **AGPL-3.0-only**; code taken from shadcn/ui keeps its MIT license ([ADR 0012](0012-shadcn-preset.md)). The license texts are in `LICENSE`, and in `LICENSES/` for [REUSE](https://reuse.software).
- **The copyright holder is Konstantin Tarkus**, stated as `2026 Konstantin Tarkus`. The year is when a file was first written, and is not bumped on later edits.
- A **commercial license** is available from the copyright holder (hello@braivo.app) for anyone who cannot comply with the AGPL. It is a separate agreement rather than a grant made by these files, so the SPDX expression is `AGPL-3.0-only` and not a dual-license `OR`.
- **Braivo's source files carry their license** as a two-line header, so it stays attached to a file that is copied elsewhere:

  ```ts
  // SPDX-FileCopyrightText: 2026 Konstantin Tarkus
  // SPDX-License-Identifier: AGPL-3.0-only
  ```

  (`/* … */` in CSS, `#` in shell). `REUSE.toml` covers only what cannot or should not carry one — docs, JSON, markup, the lockfile, generated code a tool overwrites — and shadcn's files, which get no Braivo header so that they stay comparable with upstream. Source files are deliberately not listed there, so `bun run license:check` (`reuse lint`) fails for a new one without a header.

- **`packages/sdk` is gone.** Its client moved to `apps/server/api/client.ts` and is imported by the apps as `@braivo/server/client`. Its wire types are derived from the domain types (`api/types.ts`) instead of restated, and a test holds the client to type-only imports so that no server code reaches a browser bundle.
- **`packages/braivo` is gone.** Its modules and CLI entry point are `apps/server`, a private workspace app. Nothing is published, so `@braivo/db` is private too.

## Alternatives rejected

- **Licensing every file from `REUSE.toml` alone, with no headers.** Less to write, but REUSE recommends headers wherever a file can hold one, a file copied elsewhere would lose its license, and a catch-all entry licenses every new file silently, so nothing notices one written without a thought for its license.

## Consequences

- A separate application does not become subject to Braivo's AGPL solely because it communicates with Braivo over its HTTP API. Copying, modifying, or embedding Braivo's code is another matter: that takes the AGPL, or a commercial license.
- There is no client package for outside developers. If one is wanted, it is a new decision, including its license.
- The CLI is still called `braivo`, but it is run through `bun run serve` and `bun run db:migrate` rather than installed.
- Selling commercial licenses requires the copyright holder to hold the rights to all of the code. An outside contribution under the AGPL alone does not grant the right to relicense it, and a DCO does not either. How contributions will grant that right — a CLA, an assignment, or something else — is a decision of its own, to make before accepting any. SPDX headers say what a file is licensed under, not who may relicense it.
- Braivo Cloud's own code is not published, and uses `braivo`'s code under the copyright holder's rights rather than the AGPL grant. Code by anyone else — third-party code, or a future contributor's — stays under its own license unless those rights are obtained.
