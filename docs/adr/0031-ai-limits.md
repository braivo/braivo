# 0031: Each AI request is recorded, and an operator may set an organization's monthly quota

Status: accepted (2026-09-24)

## Context

[ADR 0029](0029-server-drafting.md) lets every organization spend the operator's AI credits, or only those the operator names, and [ADR 0030](0030-server-extraction.md) put reading files under the same gate. Within an organization that may, nothing bounded the spending: a teacher drafting in a loop, or a script, could run up the operator's bill, and nobody could say who had spent what.

## Decision

- **A ledger.** Every request of the installation's model is a row in `ai_request`: the organization, what was asked (`read` or `draft`), who asked, and when. It cascades with its organization, whose limit it exists for.
- **Counted when asked, not when answered.** A request refused as invalid — a file the model cannot read, a source too long — is refused before it is counted, so it costs nothing. One the model then fails still counts: it is an attempt quota, some failures are billed and Braivo does not tell which, and retrying a failing model should not be free of the limit meant to bound it.
- **A monthly request quota, if the operator sets one.** `BRAIVO_AI_MONTHLY_LIMIT` is the number of requests each organization may make in a calendar month, UTC; unset, there is no cap and the ledger only records. A capped organization is answered 429, with `Retry-After` until the first of next month and an `error` saying when, and pointing to a desktop agent meanwhile.
- **Exact under concurrency.** Counting and recording are one transaction holding an advisory lock on the organization, so two requests racing for its last one cannot both have it.
- **Requests, not tokens.** A request's cost varies with its source — a photo or a 200,000-character chapter — so the quota bounds how often, not how much an operator pays; but a count is what an operator can reason about and a teacher can be told. Braivo Cloud meters tokens in its own billing, downstream.

## Consequences

- One limit for every organization. Per-organization limits — a paying school's larger allowance — are Braivo Cloud's plans, or a later setting when a self-hoster needs one.
- Nothing shows the ledger; an operator reads it from the database until a console page for it is wanted.
- Deleting an organization is refused while it has uploaded files ([ADR 0028](0028-original-files.md)), as with its other content; its ledger is deleted with it.
