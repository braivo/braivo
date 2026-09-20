# 0001: Split licensing, copyleft core and permissive SDK

Status: superseded by [ADR 0002](0002-agpl-only.md) (2026-09-16)

## Context

`braivo` is the public platform, and Braivo Cloud is the managed service built on it. Two audiences touch the code for different reasons, and a single license serves them badly:

- Developers embed Braivo in their own apps, LMSs, and internal tools. Anything copyleft in that client code is a hard blocker for most of them.
- Anyone can otherwise take the core and run it as a competing hosted service without contributing back, which is the main risk a public core carries for a managed-service business.

## Decision

- `packages/braivo` (core, server, CLI) is **AGPL-3.0-only**. Its network-use clause is what a permissive license or plain GPL would not cover: an operator who modifies Braivo and offers it to users over a network must offer those users the complete corresponding source of the version they are using.
- `packages/sdk` is **Apache-2.0**. Client code crosses the network boundary into someone else's application, so it must impose no copyleft, and Apache-2.0 adds an explicit patent grant.
- A **commercial license** for the core is available from the copyright holder (hello@braivo.app) for those who cannot comply with the AGPL. This is what makes AGPL viable rather than exclusionary.
- Licensing lives per package, not at the repository root, because the two licenses differ.

## Consequences

- Integrating with Braivo never requires an AGPL or commercial license: the boundary developers depend on is the HTTP API and the Apache-2.0 SDK. Keep it that way — moving functionality developers need to embed out of `packages/sdk` and into the AGPL core would break this promise.
- Selling commercial licenses requires the copyright holder to hold rights to all of the code. Before accepting outside contributions, adopt a CLA; a DCO alone does not grant relicensing rights.
- Braivo Cloud's own code depends on `braivo` and is not published. It is covered by the copyright holder's own rights, not by the AGPL grant, so its source stays closed.
- New packages state their license explicitly; there is no repository-wide default to fall back on.
