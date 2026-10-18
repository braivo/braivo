# 0047: Structured items in shapes Braivo defines, converted into keyed tasks by Braivo

Status: accepted (2026-10-18). Builds on [ADR 0046](0046-material-in-steps.md); would amend [ADR 0024](0024-idempotent-authoring.md) for keyed tasks and [ADR 0015](0015-tasks.md) for task pictures and for deleting tasks no learner could have met, with the changes that implement them.

## Context

Much material already holds its questions and answers: exam banks, past papers, quizzes, vocabulary lists, flashcard decks, worksheets with an answer key. A driving-theory bank, for one, is hundreds of groups of numbered true/false statements, most groups about a picture, some statements identical in words with opposite answers.

Converting such material by hand through the authoring API works, and the import experiments showed where it breaks: an assistant retyping thousands of statements spends hundreds of thousands of output tokens and can drop a negation while quoting correctly; a re-import revives what the owner corrected or retired unless the importer keeps its own record, which a hosted assistant cannot; and nothing in Braivo knows which statements belong together, share a picture, or contradict each other. Parsing a format is particular to it and belongs to the owner's tools or Braivo's AI ([ADR 0046](0046-material-in-steps.md)); turning a known structure into good practice is the same every time, and quality depends on it.

## Decision

- **Items, in a few shapes Braivo defines.** A snapshot may hold items of one shape, under a published, versioned JSON Schema; each shape maps onto a task kind Braivo already grades and has one deterministic converter. The first is the **statement group**: a key, an optional topic and lead-in, its pictures, and one or more statements, each with a key, text, and a true/false answer. Next, when real material needs them: the **choice question** (one correct option) onto `choice`, and the **card** (a prompt and its accepted answers: a word and its translations, a gap and the key's word) onto `typed`. Questions no task kind grades (matching, ordering, open answers) are reported and left out; material without its own answers is drafted ([ADR 0029](0029-server-drafting.md)).
- **Every field is proved where it is printed.** Each field a learner reads or grading uses carries its own quote in the snapshot's text, so a question and an answer key on different pages, or options in a table, are each proved. A field's text is not written separately: it is its quote, or a marked run within it, so it cannot drift from the source; the quote may include context to be unique (an item number, a key's heading). An answer the material does not print converts only if the owner supplies it in the preview, marked as theirs; a lead-in the material does not print is marked as the owner's too. Every conversion's citations follow [ADR 0021](0021-citations.md)'s rules, and an item that cannot is refused by name, never cut down.
- **Braivo validates before converting.** The schema, unique keys, every quote located once, every picture checked. Blocking, until the owner resolves it or leaves the item out: a field outside its quote, pictures not checked, a picture without its text alternative, a statement mentioning a picture in a group without one. Findings for a person: identical statements with opposite answers, shown with their pictures. A check answers counts and a few findings of each kind, not the content. Matching the source proves the words, not the answer key, which stays the owner's to review.
- **Groups map to objectives by a reviewed mapping**: one objective per group by default, splittable by the owner or their agent, each keyed and named in review; an objective already made under its key keeps its stored title, a newly proposed one reported, not applied; a later mapping never moves a task to another objective ([ADR 0015](0015-tasks.md)), it reports the conflict. One true/false success is half luck, so converted practice promises no exam readiness; a task kind showing several statements at once is a separate decision.
- **Preview, apply, then publish.** Preview reports what an apply would do, item by item, as counts with details on demand, and writes no content. Apply writes exactly the previewed input, refusing anything changed since, in batches, resumably; what it writes waits unpublished, whoever applies, and nothing from an unfinished apply can be published by any route. Publishing is the console's separate step ([ADR 0039](0039-published-in-the-console.md)). Discarding an unfinished apply rolls back what only it made and nobody touched since, never recording a rejection; whatever the owner touched stays theirs. Removals are never inferred: a partial selection, or an item missing from a new snapshot, retires nothing.
- **A task key names a lineage.** A task may carry a key, a namespace for the material and its purpose (not its edition) and the item's own ID, unique in the organization across the task, its corrections, and retirement. A lineage has at most one published task and one waiting. Re-sending a keyed task compares what a learner meets and grading uses, not citations, and answers one outcome:

  | Lineage now                                    | Same content | New content                                       |
  | ---------------------------------------------- | ------------ | ------------------------------------------------- |
  | Unknown key                                    | —            | `added` (waiting, if a tool sent it)              |
  | Waiting only, written by a tool, untouched     | `unchanged`  | `corrected`: replaces the waiting task            |
  | Waiting only, written or edited in the console | `unchanged`  | `conflict`: the owner's work is not replaced      |
  | Published, nothing waiting                     | `unchanged`  | `correction-waiting`, published only by the owner |
  | Published, a correction waiting                | `unchanged`  | `conflict`                                        |
  | Retired                                        | `declined`   | `retired`                                         |

  Content the owner withdrew before, as a task or a correction, is `declined` whatever the lineage's state now. Withdrawing a waiting correction retires only it; retiring the published task, or a never-published one, retires the lineage. Nothing the owner corrected, edited, or retired is overwritten or revived by an import. So a re-import of a corrected or newer edition needs no importer's record: Braivo remembers what the owner decided. Unkeyed tasks keep content identity ([ADR 0024](0024-idempotent-authoring.md)).

- **A lineage is not mastery.** A correction keeps the objective and learners' evidence, as today; when an answer or rule changes, the owner decides whether it still teaches the same objective. Nothing resets learners' history automatically.
- **Pictures on tasks.** A task may show derived images, each with a text alternative written for that task: what a sighted learner takes from the picture, stated accurately. A task no text can stand in for fairly is marked and cannot be published until the owner gives an accessible alternative or leaves it out. A learner fetches a picture only through Braivo, only while the course is open to them, for a published task or their own attempt; never an original ([ADR 0028](0028-original-files.md)). A picture is kept while a task or attempt names it; until pictures ship, picture items are left out and listed.
- **What the material answers is converted; what it does not is authored.** A vocabulary list with translations converts as cards. Vocabulary drawn from material that supplies no meanings — the words of a question bank — needs judgment and is written through the task endpoints with keys, by Braivo's drafter or the owner's agent, each task citing where the word occurs.
- **Where it runs.** Validation and conversion are pure functions in `content`, shared by the server and the CLI, which checks offline. The console and MCP preview and apply over snapshots already in Braivo; no tool takes items inline.

## Alternatives rejected

- **Agents writing every task through the authoring API**: the tokens, retyping errors, and memoryless re-imports the experiments measured. Kept for what needs judgment.
- **Per-format converters on Braivo's servers**, a mapping designer, or a general item shape: formats are unbounded and belong to the owner's tools; shapes are few, each with one converter.
- **One quote per item**, or a field's text written beside its quote: an answer key elsewhere would be unprovable, and a copy is one more place a word can drop.
- **One group, one objective, always**: a group can test several things.
- **Publishing on apply**: a summary of thousands of statements is not a review of their answers.
- **Converting vocabulary from words alone**: the converter would invent meanings and distractors.
- **An edition in the key**, or **keys from text**: the next edition, or a corrected statement, would start a new lineage.
- **Citations in the keyed comparison**: every statement of a newer edition would become a correction.
- **Retiring items missing from a new snapshot**: a sample, a filter, or a parser bug would retire the owner's content.
- **A text alternative bound never to reveal the answer**: a learner who cannot see would be assessed on less.
- **Pictures at public links**: a link outlives the access that granted it.

## Consequences

- A picture-heavy bank converts its text-only groups first, the rest once pictures ship; a newer edition under the same key namespace keeps unchanged items, holds changed ones for review, and keeps retired ones retired.
- Keys enter the authoring spec, its endpoints, and MCP's `author_tasks`; tasks record whether the console wrote or edited them.
- The schema is proved against more than one kind of material (a worksheet with an answer key, a vocabulary list, a multiple-choice quiz) before it is frozen.
