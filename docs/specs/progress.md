# Progress

Status: living; checked against the code on 2026-10-01.

For one learner in one course, Braivo reports where they stand on each objective: not started, learning, retained, or due for review, with how likely they are to recall it ([product.md](../product.md), core job 5). Content owners read it in the console; learners read their own as a summary in the learn app. The report comes from the same replay that chooses the learner's next activity, so it explains selection rather than restating it ("Explainable decisions").

## Rules

- **progress-1:** A report may be read by the learner themselves or by an `owner` or `admin` of the course's organization, and only about a member of that organization. Anyone else, other members included, gets the same answer as for a missing course. `apps/server/application/learner-progress.test.ts`, `apps/server/api/app.test.ts`
- **progress-2:** A refusal confirms nothing: a missing course answers like one the reader may not read, and a learner outside the organization like an ID nobody has. The reader is authorized before the learner is looked up, so a refused reader cannot tell a member from a stranger. `apps/server/application/learner-progress.test.ts`, `apps/server/application/learner-in-course.test.ts`
- **progress-3:** On an organization's own domain, only that organization's courses report; on an unknown host, none ([white-label](white-label.md)). `apps/server/application/learner-in-course.test.ts`
- **progress-4:** The report lists every objective of the course, by title, in content order, those not started included; a course with no objectives reports an empty list. `apps/server/application/learner-progress.test.ts`
- **progress-5:** What the report calls due is what selection would review: whatever selection chooses appears in the report as the reason. `apps/server/learning/assess.test.ts`, `apps/server/application/learner-progress.test.ts`
- **progress-6:** A report describes one moment; evidence dated after it does not count. Nothing is stored: every read recomputes. `apps/server/application/learner-progress.test.ts`
- **progress-7:** Every progress answer, refusals included, carries `Cache-Control: private, no-store`. `apps/server/api/app.test.ts`
- **progress-8:** A learner sees counts by standing that open into each objective by title; if their report cannot be read, the summary is left out and practice goes on. `apps/learn/routes.test.tsx`
- **progress-9:** The console never pairs one organization's course with another's learners: it reads nothing about a course until the course is in the organization's own listing, and shows any refusal as not found. `apps/console/routes.test.tsx`
- **progress-10:** A learner who also studies at another organization is reported from this organization's objectives alone: evidence recorded there neither appears in the report nor changes it, and who may read either report is progress-1. `apps/server/application/learner-progress.test.ts`

## Boundaries

- The estimates, phases, and what "due" means belong to the [learning model](learning-model.md); this area names and shows them.
- Who belongs to an organization, and so to its courses, is [access](access.md).
- Not here yet: anything across learners or objectives, history over time, or the evidence behind a standing (see Gaps).

## Decisions

- [ADR 0007](../adr/0007-one-learning-model.md): one active model, so a report is recomputed rather than stored.
- [ADR 0009](../adr/0009-evidence-read-whole.md): a report replays the learner's evidence at the course's organization, never narrowed to the course.
- [ADR 0010](../adr/0010-hono-http-layer.md): the reader comes from the session, the learner from the path; the body is the use case's report, serialized.
- [ADR 0018](../adr/0018-sign-in-and-invitations.md): membership is enrollment, so every member appears in every course.
- [ADR 0032](../adr/0032-learner-history.md): one history per learner, recorded and read per organization.

## Gaps

| Gap                                                                                                            | Impact                                                                                     | Next step                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| No per-course overview: the course page shows no standing per learner                                          | Finding who struggles means opening every learner; core job 5 is met one learner at a time | A course summary: per learner, counts by phase and due                                 |
| No knowledge gaps across learners: nothing reports, per objective, how many learners are learning, due, or new | "Knowledge gaps" in core job 5 is unmet                                                    | A per-objective aggregate over the course's members; measure replay cost first         |
| "Learning" covers both one failure and many                                                                    | A learner stuck on an objective looks like one who just started                            | Open question for the learning model: a failure or evidence count per standing         |
| No explanation behind a standing: no evidence history, no next due time                                        | "Explainable decisions" is unmet for content owners                                        | Read a learner's evidence per objective; show when an objective falls due              |
| A report is always at the request's `now`                                                                      | No trend or before/after view                                                              | Open question: accept an instant, which replay already supports                        |
| The console's course page lists organization members, capped at Better Auth's default of 100                   | Learners past the 100th cannot be found; roles show, but anyone may also be learning       | Page and search the list, or list course participants once enrollment or activity says |
| The console's "Last attempted" is the last evidence, which may be graded elsewhere                             | Mislabels evidence recorded through the API                                                | Rename to "Last evidence" or similar                                                   |

## Entry points

`apps/server/application/learner-progress.ts` (use case), `apps/server/application/learner-in-course.ts` (load shared with selection), `apps/learn/routes/_signed-in/courses/$courseId.tsx` (learner summary), `apps/console/routes/_signed-in/$organizationSlug/courses/$courseId/learners/$learnerId.tsx` (console report).
