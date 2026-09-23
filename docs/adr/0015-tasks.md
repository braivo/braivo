# 0015: Immutable tasks, graded by Braivo on the learner's submission

Status: accepted (2026-09-23)

## Context

`learning` decides an objective and an intent, and evidence could be recorded only by an administrator posting graded outcomes. Nothing let a learner _do_ anything, so Braivo could not be experienced end to end: objective → activity → answer → grading → evidence → next objective.

Closing that loop needs content a learner answers, a record of the answer, a grader, and a way for a learner to submit without being able to grade themselves.

## Decision

- **A task** is one assessable item for one objective, stored as relational columns (ID, organization, objective, creation time) plus a JSON `body` whose shape the `content` module owns: one variant per kind, validated before storage. The first kind is `choice` — deterministic grading, so the loop closes without AI.
- **Tasks are immutable.** Correcting one means creating another. An attempt references its task instead of copying it, which is sound only because the task cannot change under it.
- **Braivo grades.** The learner posts a response to `POST /api/courses/:courseId/attempts`; the server grades it and writes the attempt and its evidence in one transaction. A learner may submit for themselves because they choose the answer, never the outcome. That is the whole guarantee: submissions are not bound to a served task, and a learner may answer again under a new ID. Enough for practice; assessment would need a server-issued binding, mechanism undecided. The administrator-only evidence endpoint remains for integrators who grade elsewhere.
- **The client names the attempt.** Its ID is unique per learner, so a retry after a lost answer is recognised and recorded once; the same ID with another task or response is a conflict. Evidence IDs are `attempt:<attemptId>:<objectiveId>`, one per objective an attempt assesses.
- **Content availability is eligibility.** `GET /api/courses/:courseId/activity` offers `learning` only objectives that have a task, then picks the objective's least recently attempted task. `GET …/next` stays the pure decision, for integrators who bring their own tasks.
- **The grade is recomputed, not stored.** Grading `choice` is a function of an immutable task and the stored response, and the outcome is in the evidence.

## Consequences

- One objective per task. A task that exercises several needs a grader answering per objective — one wrong step in a multi-step problem is not a failure on every objective it touches — and that is when a `task_objective` join table replaces the column.
- A replaced task must stop being offered while its attempts keep pointing at it, so it is retired rather than deleted: `task.retired_at`, set through `POST …/tasks/retire`. Evidence it already graded stands; correcting that is a separate decision, not taken.
- AI-graded kinds break the "recompute the grade" rule, since a model's verdict is not reproducible. They will store the grade and its provenance (model, prompt version) on the attempt when they arrive, and must grade once per attempt: today every retry grades before the insert decides which one wins, which is free for `choice` but not for a model call.
- A task serves every course its objective is in, since courses order objectives rather than own them ([ADR 0008](0008-courses-order-objectives.md)). Whether a task derived from one source applies wherever its objective does belongs to the source-linking and authoring design, not here.
- A course whose objectives have no tasks answers the activity route with 204 (`no-activity`), as for a caught-up learner: nothing to practise now.
