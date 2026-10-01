# 0024: Adding what is already there returns what is there

Status: accepted (2026-09-24)

## Context

Authoring is done by agents as often as by people: a desktop Claude through `braivo mcp` ([ADR 0023](0023-mcp-server.md)), a script through `braivo sources add`. Both retry — after a lost response, a timeout, a turn the agent repeats — and every authoring write created a new row each time. A retried `add_source` left two identical sources, and every citation after that had two places it might point.

Attempts and evidence already solve this with IDs the client chooses. That suits an app, which generates a UUID once per attempt. It suits a model poorly: it has to invent the ID, keep it, and send the same one again on retry, which is exactly the bookkeeping a retried turn loses.

## Decision

**Where a thing's identity is its content, adding the same content again returns the one already there.** No key to invent, nothing for the caller to remember: the retry is the same request, and it answers the same.

- **Sources.** A source is immutable text ([ADR 0020](0020-source-content.md)), so two with the same title, text, link, and language are the same source. `content.sourceDigest` hashes those fields (SHA-256 over their UTF-8 bytes, separated by a zero byte no field can hold), a unique index on `(organization, digest)` holds it, and `createSource` inserts or returns the row that is there, race-safe. The route answers 201 with the ID either way, so a retry cannot be told from the first request.
- A source that differs in anything, including only its language or its link, is another source, as a revision always was.
- **Tasks.** A task is the same task when it is for the same objective, asks the same thing — its body equal as values, so key order does not matter and option order does, since `answer` indexes it — and cites the same passages, as a set. Adding one returns the unretired twin's ID, and so does a task repeated within one batch. A retired twin does not count ([ADR 0017](0017-task-rest.md)): adding a retired task again is how to bring it back, so it is added anew.
- Tasks are matched by lookup, not by a stored digest: `createTasks` locks each objective it writes to for its transaction, reads that objective's unretired tasks and their passages, and compares. Retiring takes the same locks, so a task is never found as a live twin and retired before the adder answers with it. A digest column would need a canonical form of a `jsonb` body kept in step with PostgreSQL's; an objective has few tasks, so reading them costs little, and the lock is what makes the check race-safe without an index.

**Where identity is not content, the caller names it with a key.** Objectives and courses are not their content: "Greetings" taught in a Spanish course and in a French course are two objectives with one title, and merging them by title would conflate knowledge the learning model keeps apart.

- Each may carry a **key**, the caller's own name for it, unique within the organization: `es-greetings`, `unidad-1/numbers`. A slug — 1 to 128 lowercase letters, digits, and `. _ / -`, starting with a letter or digit — because a model makes one up from a title as easily as the title, and makes the same one again when it retries; lowercase so that two spellings cannot name two things.
- Sent again under its key, the same thing returns its ID: an objective with the same title, a course with the same title and the same objectives in the same order. Sent under a key already naming something else, it is refused — 409, explained — because a key that quietly came to mean two things would make every later retry ambiguous. A key repeated within one batch is one objective, on the same terms.
- Keys are optional. An objective or course without one is added every time; a person in the console needs no key, and an agent is asked for one by `braivo mcp`, whose instructions and tool schemas say to send the same key again on a retry.
- A unique index on `(organization, key)` holds it, nulls distinct, and the insert's `ON CONFLICT DO NOTHING` makes a writer racing on a key wait for and then read the other's row.
- The objectives route takes `{ "objectives": [{ "title", "key"? }] }` rather than `{ "titles": [...] }` with a parallel array of keys: a key belongs beside its title, and parallel arrays would be one misalignment away from naming the wrong objective.

## Consequences

- `braivo sources add`, `add_source`, `author_tasks`, and — given keys — `define_objectives` and `create_course` are safe to retry, and to re-run over a folder: unchanged files add nothing.
- A key cannot be changed or released through the API; renaming an objective's key, like editing its title, waits for a need.
- A task written by hand twice on purpose, word for word, is stored once. Nothing is lost: a learner practising it twice would only have been asked the same question twice.
- `persistence` computes the digest beside the insert, so no writer can skip it or disagree with it.
