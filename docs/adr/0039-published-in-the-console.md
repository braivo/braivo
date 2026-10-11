# 0039: Courses and tasks a tool writes wait to be published in the console

Status: accepted (2026-10-11). Amends [ADR 0021](0021-citations.md), [ADR 0022](0022-machine-access.md), and [ADR 0029](0029-server-drafting.md).

## Context

The product's authoring loop is: a teacher drafts with the AI assistant they already use, then reviews and publishes the result in Braivo ([product.md](../product.md), core job 1). Today only half of it holds. A draft by Braivo's own model is reviewed in the console before anything is stored, but the authoring API, so `braivo mcp` and remote MCP alike, writes straight to learners ([authoring](../specs/authoring.md)): a new course is open to all of them at once, and a task added, corrected, or retired changes every course its objective is in. ADR 0029 rejected a publish step as a state machine no customer had asked for. An assistant's mistake, or instructions hidden in a source's text ([ADR 0023](0023-mcp-server.md), Consequences), then reaches learners unseen in Braivo.

An assistant's work arrives over many conversations, often in a course learners are already in ("add ten harder exercises"), and most teachers have no one else to review it: in a small school the person who asked is the only one who will look.

## Decision

- **A tool proposes; a person publishes.** What a token (the device flow's, remote MCP's) writes never changes what learners reach until someone publishes it in the console; in the console a person is reviewing, so accepting Braivo's draft publishes it, and a correction there takes the state of the task it replaces: published at once for a published task, still waiting for a waiting one. A draft's objectives are its own ([ADR 0029](0029-server-drafting.md), keys), so its tasks reach no course until its course, written last, exists. Courses and tasks carry the state, as what learners reach; objectives and citations are reached only through them.

  | A token…               | an unpublished one                                  | a published one                                                            |
  | ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
  | creates a course, task | it starts unpublished                               | —                                                                          |
  | corrects a task        | replaces it at once; the correction is unpublished  | the correction waits, the task offered until it is published, then retired |
  | retires a task         | at once: the assistant withdrawing its own proposal | refused, explained: retiring one is the console's                          |

  A published task has at most one waiting correction: another answers 409 unless it is the same, correcting the waiting one replaces it, for the same task, and correcting or retiring the task in the console retires its waiting correction too, the console saying so first. A twin ([ADR 0024](0024-idempotent-authoring.md)) answers only a write that would not publish more: a token's task may answer a published or waiting twin, saying which; a correction equal to another task the objective offers is refused, explained, as a duplicate.

- **Learners reach only what is published.** An unpublished course is left out of their listings, and its activity, attempts, and progress answer as for a course that does not exist; an unpublished task is neither offered nor graded in any course. Evidence is unchanged: it belongs to objectives, not to courses or their publication.
- **Publishing is a person's act in the console.** Only a browser session publishes; a token is refused, and no MCP tool publishes. Any owner or admin may publish, the one whose assistant wrote it included: review needs no second person. Publish takes the course and task IDs the page showed, all at once or nothing, so anything written since waits for the next look; an item no longer eligible, a waiting task since retired or a correction whose task is no longer offered, fails it, 409, and the page reloads. A task published serves every course its objective is in, so the confirmation names the other published ones.
- **Review shows what changed.** The organization's page lists what needs review, each item once, under its course or, for a task in none or several, its objective, so a teacher need not remember which chat wrote it. A teacher reads Needs review and Published, never draft or pending. A course's page puts its waiting work first: a new course whole, a published one's new tasks and its corrections beside the tasks they replace, each with its answer, explanation, and passages; then the course and its progress. A waiting task is corrected or retired there, one by one, then Publish; an unpublished course may be deleted, its arrangement only, the page saying that its objectives and tasks stay; its key stays taken, so a late retry under it is refused, explained, rather than bringing it back. Accepting Braivo's own draft reads Publish too: to a teacher, the two paths are one.
- **The agent says what remains.** Writing a course or a task answers whether it is published, as it stands, a keyed retry ([ADR 0024](0024-idempotent-authoring.md)) or a task's twin included; the MCP tools add the console's link, to the course or else to the organization's waiting list, and say in their descriptions that they cannot publish. A course's title and order cannot change, so restructuring an unpublished one is a new course under a new key, the old one deleted.
- **Final for now.** Nothing unpublishes yet; withdrawing a course would hide it from learners midway, not erase evidence. What exists when this lands is published.

## Alternatives rejected

- **Refusing a token's writes to anything published.** Simpler, but an assistant could then never extend or correct a course learners are in, the request teachers make most once a course exists.
- **Course-only publication.** A task added to a shared objective would reach a published course unreviewed.
- **Changesets**, one proposal of additions, corrections, and removals approved together: storage, identity mapping, and conflicts of their own, until teachers need several kinds of change approved as one.
- **A fingerprint of the course reviewed**, refusing Publish once anything changed: publishing the IDs shown leaves new work waiting instead of refusing the work reviewed.

## Open

- **Roles in a larger school.** Whether someone may author without publishing, or a second person must publish, waits for a school that asks, as authoring's narrower role does ([authoring](../specs/authoring.md), Gaps).
- **Checks before Publish.** If pilots show review is slow or misses errors, Braivo's own model could check a waiting answer key against its passages, at the installation's AI credits ([ADR 0031](0031-ai-limits.md)), helping the owner's review, not replacing it.
- **A tool proposing removals.** "Remove these five" needs a waiting retirement, a third kind of waiting work; until asked, the assistant proposes corrections or the teacher retires in the console.

## Consequences

- [ADR 0022](0022-machine-access.md) gains two acts, beside managing the account, that take the person's browser: publishing, and retiring a published task. No scopes or capabilities model: a token still has its person's memberships and roles. Remote MCP and a desktop agent alike cannot make their own work live; a client holding a browser session could, so publishing proves the credential, not that someone read it.
- ADR 0029's "a publish step would be a state machine no customer has asked for" is replaced: the product's own loop asks for it. It stays two states, published or not, with no workflow.
- Courses and tasks each record when they were published, as tasks record when they were retired; a waiting correction records the task it replaces.
- Editing an unpublished course's title and order is the review's first missing piece ([authoring](../specs/authoring.md), Gaps); hiding a course published by mistake is due before a pilot with real learners.
- Remote MCP ships after this, so nothing it writes is live on arrival.
- The authoring spec's "there is no draft state", the learner loop's spec, `braivo mcp`'s tools, and the console's "Open to every learner" notice change with it.
