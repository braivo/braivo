# 0021: Citations are quotes Braivo locates, stored as code-point ranges

Status: accepted (2026-09-23)

## Context

[ADR 0020](0020-source-content.md) stores a content owner's material as immutable text and names citations as what keeps derived content tied to it. Grounding has to be something Braivo checks, not something a proposer asserts: the proposer may be Braivo's own model, or a content owner's local Claude, Codex, or Grok working through a CLI or MCP server, and neither is trusted to be right about what a source says.

## Decision

- **A citation links an objective to a passage of a source.** Many to many: an objective taught by two textbooks cites both, which is how a second source reuses existing knowledge instead of duplicating it ([ADR 0008](0008-courses-order-objectives.md) makes objectives shared for the same reason).
- **A task cites the passages it was written from**, in `task_citation`, shaped and located the same way. Its citations arrive with the task in `POST …/tasks` and are written in the task's transaction, because a task is immutable ([ADR 0015](0015-tasks.md)): what it was grounded in is fixed when it is created, and one stored without its citations could never be given them. An objective's citations can grow as sources are added; a task's cannot. At most 10 per task — a question is written from a passage or two.
- **The caller sends a quote; Braivo finds it.** `content.locateQuote` matches whitespace loosely, since models and copy-paste reflow lines, and everything else exactly after NFC normalization. A quote that is not in the source is refused, whoever wrote it. That refusal is the citation check: it proves the passage is there and which one is meant, not that what cites it follows from it. That is the instructions' to ask for and the reviewer's to judge; a second model judging it would be another guess presented as a guarantee.
- **A quote must occur once.** An ambiguous quote is refused rather than resolved to its first occurrence, and the fix is to quote more. Prefix and suffix context, or an occurrence index, would let a caller point at one of several matches, but "quote more" is simpler, works the same for a person and a model, and makes every stored citation mean exactly one passage.
- **Stored as a range, in code points.** The source is immutable, so a range cannot drift, and it is what was verified. Code points rather than UTF-16 units, because that is what PostgreSQL's `substr` counts and what clients outside JavaScript count; the passage is read back without loading the whole text.
- **All or nothing, and idempotent.** A batch with one bad quote stores nothing, and a citation already stored is stored once, so a retrying agent never has to reason about partial writes.
- **A refused quote says why.** `POST …/citations` answers 400 with `{ "error": "Citation 1: the quote occurs more than once in the source; quote more of it." }`, and `POST …/tasks` the same with the task named: `"Task 2, citation 0: …"`. They explain themselves because their caller is often a model, and an explanation is what lets it correct itself. So do a task that is not a valid one ("Task 0 repeats option 0 as option 1; every option must differ") and a source Braivo cannot store, while a body not in the documented shape answers a bare 400, as the rest of the API does. `BraivoError.reason` carries the explanation to a client, and `braivo mcp` hands it to the agent ([ADR 0023](0023-mcp-server.md)).

## Proposals are not stored

ADR 0020 anticipated proposals as server state reviewed before acceptance. They are not: review happens where the draft is made — in the content owner's agent, or in the console ([ADR 0029](0029-server-drafting.md)) — and accepting a draft is two writes, defining the objective and then citing it. An objective left uncited because the second write failed is valid state (hand-written objectives have no citations) and the write can be retried.

Server-side proposals return when drafting runs asynchronously in Braivo, or when a draft must wait for someone other than its author to review it.

## Consequences

- Defining and citing are two requests, not one transaction.
- Citations cannot be removed through the API. Both references are restricted, so neither an objective nor a source with citations can be deleted either.
- Locating is a regular-expression scan of the source per citation, and a source may run to 10 MB, so one request asks Braivo to find at most 200 quotes; more go in several requests. An index over the source waits for a need.
- **A learner sees a task's passages after answering it**, in the grade: each quote with its source's title and link, and never before, since a passage could give the answer away. The quote and where it is from, not the source's text or positions, which stay a content owner's. A passage also names its moment in a video or its page in a book ([ADR 0025](0025-timed-transcripts.md), [ADR 0026](0026-paged-documents.md)).
