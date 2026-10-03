# Progress

Status: living; checked against the code on 2026-10-03.

For one learner in one course, Braivo reports where they stand on each objective: not started, learning, retained, or due for review, with how likely they are to recall it ([product.md](../product.md), core job 5). Content owners read it in the console, from a course overview that counts standings per member and per objective, the latter showing knowledge gaps across learners; learners read their own as a summary in the learn app. The report comes from the same replay that chooses the learner's next activity, so it explains selection rather than restating it ("Explainable decisions").

## Rules

- **progress-1:** A report may be read by the learner themselves or by an `owner` or `admin` of the course's organization, and only about a member of that organization. Anyone else, other members included, gets the same answer as for a missing course. `apps/server/application/learner-progress.test.ts`, `apps/server/api/app.test.ts`
- **progress-2:** A refusal confirms nothing: a missing course answers like one the reader may not read, and a learner outside the organization like an ID nobody has. The reader is authorized before the learner is looked up, so a refused reader cannot tell a member from a stranger. `apps/server/application/learner-progress.test.ts`, `apps/server/application/learner-in-course.test.ts`
- **progress-3:** On an organization's own domain, only that organization's courses report; on an unknown host, none ([white-label](white-label.md)). `apps/server/application/learner-in-course.test.ts`
- **progress-4:** The report lists every objective of the course, by title, in content order, those not started included; a course with no objectives reports an empty list. `apps/server/application/learner-progress.test.ts`
- **progress-5:** What the report calls due is what selection would review: whatever selection chooses appears in the report as the reason. A retained objective also carries when it falls due, past or future: when selection's rule starts to hold. `apps/server/learning/assess.test.ts`, `apps/server/application/learner-progress.test.ts`
- **progress-6:** A report describes one moment; evidence dated after it does not count. Nothing is stored: every read recomputes. `apps/server/application/learner-progress.test.ts`
- **progress-7:** Every progress answer, a report's or an overview's, refusals included, carries `Cache-Control: private, no-store`. `apps/server/api/app.test.ts`
- **progress-8:** A learner sees counts by standing that open into each objective by title; if their report cannot be read, the summary is left out and practice goes on. When the report holds a retained objective not yet due, a caught-up learner is told which falls due next, and when, in their local time rounded up to the minute. `apps/learn/routes.test.tsx`
- **progress-9:** The console never pairs one organization's course with another's learners: it reads nothing about a course until the course is in the organization's own listing, and shows any refusal as not found. `apps/console/routes.test.tsx`
- **progress-10:** A learner who also studies at another organization is reported from this organization's objectives alone: evidence recorded there neither appears in the report nor changes it, and who may read either report is progress-1. `apps/server/application/learner-progress.test.ts`, `apps/server/application/course-progress.test.ts`
- **progress-11:** A course's overview lists every member of its organization, by name, with their objectives counted by standing: not started, learning, retained, and due for review, adding up to the course's. Each count is what that learner's report shows at the same moment, and each learner links to their report. `apps/server/application/course-progress.test.ts`, `apps/console/routes.test.tsx`
- **progress-12:** Only an `owner` or `admin` of the course's organization reads its overview; a member, the learner included, reads their own report alone. A refused reader, a missing course, and a host that does not reach it get one answer, as in progress-2 and progress-3. `apps/server/application/course-progress.test.ts`, `apps/server/api/app.test.ts`
- **progress-13:** The overview also lists every objective of the course, by title, in content order, with its learners counted by the same four standings, adding up to the members; for each standing, summing the objective rows equals summing the learner rows. A course with no objectives lists none. `apps/server/application/course-progress.test.ts`, `apps/console/routes.test.tsx`

## Boundaries

- The estimates, phases, and what "due" means belong to the [learning model](learning-model.md); this area names and shows them.
- Who belongs to an organization, and so to its courses, is [access](access.md).
- Not here yet: history over time, or the evidence behind a standing (see Gaps).

## Decisions

- [ADR 0007](../adr/0007-one-learning-model.md): one active model, so a report is recomputed rather than stored.
- [ADR 0009](../adr/0009-evidence-read-whole.md): a report replays the learner's evidence at the course's organization, never narrowed to the course.
- [ADR 0010](../adr/0010-hono-http-layer.md): the reader comes from the session, the learner from the path; the body is the use case's report, serialized.
- [ADR 0018](../adr/0018-sign-in-and-invitations.md): membership is enrollment, so every member appears in every course.
- [ADR 0032](../adr/0032-learner-history.md): one history per learner, recorded and read per organization.

## Gaps

| Gap                                                                | Impact                                                                                                   | Next step                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "Learning" covers both one failure and many                        | A learner stuck on an objective looks like one who just started                                          | Open question for the learning model: a failure or evidence count per standing         |
| No explanation behind a standing: no evidence history              | "Explainable decisions" is unmet for content owners                                                      | Read a learner's evidence per objective                                                |
| A report is always at the request's `now`                          | No trend or before/after view                                                                            | Open question: accept an instant, which replay already supports                        |
| The console's course page lists every organization member, unpaged | A long list has no search; administrators count as learners in both tables, since anyone may be learning | Page and search the list, or list course participants once enrollment or activity says |

## Entry points

`apps/server/application/learner-progress.ts` (a learner's report), `apps/server/application/learner-in-course.ts` (load shared with selection), `apps/server/application/course-progress.ts` (a course's overview), `apps/console/routes/_signed-in/$organizationSlug/courses/$courseId/index.tsx` (console overview), `apps/learn/routes/_signed-in/courses/$courseId.tsx` (learner summary), `apps/console/routes/_signed-in/$organizationSlug/courses/$courseId/learners/$learnerId.tsx` (console report).
