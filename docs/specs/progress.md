# Progress

Status: living; checked against the code on 2026-10-07.

For one learner in one course, Braivo reports where they stand on each objective: not started, learning, retained, or due for review, with how likely they are to recall it ([product.md](../product.md), core job 5). Content owners read it in the console, from a course overview that counts standings per member and per objective, the latter showing knowledge gaps across learners; learners read their own as a summary in the learn app. A content owner's desktop agent reads both through `braivo mcp`. The report comes from the same replay that chooses the learner's next activity, so it explains selection rather than restating it ("Explainable decisions").

## Rules

- **progress-1:** A report may be read by the learner themselves or by an `owner` or `admin` of the course's organization, and only about a member of that organization. Anyone else, other members included, gets the same answer as for a missing course. `apps/server/application/learner-progress.test.ts`, `apps/server/api/app.test.ts`
- **progress-2:** A refusal confirms nothing: a missing course answers like one the reader may not read, and a learner outside the organization like an ID nobody has. The reader is authorized before the learner is looked up, so a refused reader cannot tell a member from a stranger. `apps/server/application/learner-progress.test.ts`, `apps/server/application/learner-in-course.test.ts`
- **progress-3:** On an organization's own domain, only that organization's courses report; on an unknown host, none ([white-label](white-label.md), white-label-4). `apps/server/application/learner-in-course.test.ts`
- **progress-4:** The report lists every objective of the course, by title, in content order, those not started included; a course with no objectives reports an empty list. `apps/server/application/learner-progress.test.ts`
- **progress-15:** For a course with no objectives, the console's report of a learner says so in place of the standings table. `apps/console/routes.test.tsx`
- **progress-5:** What the report calls due is what selection would review: whatever selection chooses appears in the report as the reason. A retained objective also carries when it falls due, past or future: when selection's rule starts to hold. `apps/server/learning/assess.test.ts`, `apps/server/application/learner-progress.test.ts`
- **progress-14:** Each objective in a report carries the evidence its standing was replayed from, oldest first and ties as replay orders them: each result's outcome and time, under progress-6 and progress-10, and nothing else; an objective not started carries none. The console counts it by outcome per objective, so one failure and many read apart, and lists it dated, newest first, on request. `apps/server/application/learner-progress.test.ts`, `apps/console/routes.test.tsx`
- **progress-6:** A report describes one moment; evidence dated after it does not count. Nothing is stored: every read recomputes. `apps/server/application/learner-progress.test.ts`
- **progress-7:** Every progress answer, a report's or an overview's, refusals included, carries `Cache-Control: private, no-store`. `apps/server/api/app.test.ts`
- **progress-8:** A learner sees counts by standing that open into each objective by title; if their report cannot be read, the summary is left out and practice goes on. When the report holds a retained objective not yet due, a caught-up learner is told which falls due next, and when, in their local time rounded up to the minute. `apps/learn/routes.test.tsx`
- **progress-9:** The console never pairs one organization's course with another's learners: it reads nothing about a course until finding it in the organization, and shows any refusal as not found. The overview reads the course through the organization; a learner's report looks for it in the organization's own listing. `apps/console/routes.test.tsx`
- **progress-10:** A learner who also studies at another organization is reported from this organization's objectives alone: evidence recorded there neither appears in the report nor changes it, and who may read either report is progress-1. `apps/server/application/learner-progress.test.ts`, `apps/server/application/course-progress.test.ts`
- **progress-11:** A course's overview lists every member of its organization, by name, with their objectives counted by standing: not started, learning, retained, and due for review, adding up to the course's. Each count is what that learner's report shows at the same moment, and each learner links to their report, which names the course and links back to it. `apps/server/application/course-progress.test.ts`, `apps/console/routes.test.tsx`
- **progress-12:** Only an `owner` or `admin` of the course's organization reads its overview; a member, the learner included, reads their own report alone. A refused reader and a missing course get one answer, as in progress-2. It is a console page, read on the installation's host alone: elsewhere it answers 401, as without a session. `apps/server/application/course-progress.test.ts`, `apps/server/api/app.test.ts`
- **progress-13:** The overview also lists every objective of the course, by title, in content order, with its learners counted by the same four standings, adding up to the members; for each standing, summing the objective rows equals summing the learner rows. A course with no objectives lists none. `apps/server/application/course-progress.test.ts`, `apps/console/routes.test.tsx`
- **progress-16:** `braivo mcp` serves the overview and a learner's report as the read-only tools `course_progress` and `learner_progress`, acting as whoever signed it in, under progress-1 and progress-12 and no rule of its own; a refusal reaches the agent as an error it can read. Each tool's description says that what it reads goes to the connected AI, and the server's instructions name what they send and ask the agent to call them only when asked. `apps/server/cli/mcp.test.ts`

## Boundaries

- The estimates, phases, and what "due" means belong to the [learning model](learning-model.md); this area names and shows them.
- Who belongs to an organization, and so to its courses, is [access](access.md).
- Not here yet: history over time (see Gaps).

## Decisions

- [ADR 0007](../adr/0007-one-learning-model.md): one active model, so a report is recomputed rather than stored.
- [ADR 0009](../adr/0009-evidence-read-whole.md): a report replays the learner's evidence at the course's organization, never narrowed to the course.
- [ADR 0010](../adr/0010-hono-http-layer.md): the reader comes from the session, the learner from the path; the body is the use case's report, serialized.
- [ADR 0018](../adr/0018-sign-in-and-invitations.md): membership is enrollment, so every member appears in every course.
- [ADR 0032](../adr/0032-learner-history.md): one history per learner, recorded and read per organization.

## Gaps

| Gap                                                                                                                                                             | Impact                                                                                                   | Next step                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "Learning" covers both one failure and many on the course overview                                                                                              | A stuck learner looks there like one who just started, until their own report is opened                  | Open question for the learning model: a failure or evidence count per standing                          |
| A report carries all evidence behind its course's objectives, which the learn app reads with every activity and does not show                                   | Its size grows with history, about 50 bytes per result                                                   | Leave it out of the learn app's read, or bound it, once measured to matter                              |
| A report is always at the request's `now`                                                                                                                       | No trend or before/after view                                                                            | Open question: accept an instant, which replay already supports                                         |
| A reader's tool, `braivo mcp` included, reads whatever the reader may: an organization cannot keep its learners' names and history from that tool's AI provider | A teacher, not the school, decides whether learners' data reaches an AI provider                         | An organization setting, off by default, that refuses a tool others' progress, checked in the use cases |
| The console's course page lists every organization member, unpaged                                                                                              | A long list has no search; administrators count as learners in both tables, since anyone may be learning | Page and search the list, or list course participants once enrollment or activity says                  |

## Entry points

`apps/server/application/learner-progress.ts` (a learner's report), `apps/server/application/learner-in-course.ts` (load shared with selection), `apps/server/application/course-progress.ts` (a course's overview), `apps/server/api/learning.ts` (the report's and the overview's routes), `apps/console/routes/_signed-in/$organizationSlug/courses/$courseId/index.tsx` (console overview), `apps/learn/routes/_signed-in/courses/$courseId.tsx` (learner summary), `apps/console/routes/_signed-in/$organizationSlug/courses/$courseId/learners/$learnerId.tsx` (console report).
