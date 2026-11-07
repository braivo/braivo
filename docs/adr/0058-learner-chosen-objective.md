# 0058: A learner may choose an objective to practise, one extra question at a time when nothing calls for it

Status: accepted (2026-11-07)

## Context

Selection chooses what a learner practises next ([learning model](../specs/learning-model.md#selection-rule)), and the learn app follows it. A learner who wants to work on one topic, before a test or because it felt shaky, has no way to say so: where practice pauses, the standing list names each objective (progress-8) but leads nowhere. Product direction is one tap to what the model chose, with the learner free to choose otherwise.

Most objectives a learner would choose at a pause need no attention. Caught up means every objective with a task is retained and not due; at the day's limit, every started one is; and inside a run on one objective, one success makes it so. Selection over that objective alone answers nothing, so a choice applied literally would almost never be served.

## Decision

`GET /api/courses/:courseId/activity?objective=<id>` decides among that objective alone. One outside the course, another organization's included, answers 404, as a missing course does. The answers keep their shapes: a task, a rest with `retryAfter`, the day's limit, no activity, or empty.

- **Due, acquiring, or new: ordinary practice.** Selection decides as it would were the objective the course's only one, with its intent (`introduce`, `reteach`, `review`).
- **Retained and not due: extra practice.** Its task is served with the intent `practise`, the learner's request, never the model's recommendation. `practise` is the application's (`apps/server/application/activity.ts`); `learning` keeps its three decisions and is unchanged. The learn app labels it Extra practice.
- **Rules as usual.** The task follows rotation and its rest ([ADR 0017](0017-task-rest.md)): with every task resting, the answer says when practice resumes. The day's limit ([ADR 0041](0041-daily-limit.md)) holds back the objective only if it is not started yet; a started one takes nothing from it. The answer is graded and recorded as any other: a success moves the next review, a miss returns the objective to `acquiring`.
- **One extra question per request.** An extra question is no part of a practice session: the app neither counts it nor shows a session's progress beside it, which would promise a run of ten. Once its feedback shows, it is finished: the app never asks another by itself. It offers Back to recommended, which after a miss continues acquisition through the model's own choice, and the learner may tap Practise again. Ordinary practice on a chosen objective continues in focus, on Continue, until it would turn into extra practice.
- **Focus lasts the page.** The chosen objective is the course page's search parameter, so a reload keeps it; Back to recommended or leaving the course page drops it. The server keeps nothing.

## Alternatives rejected

- **Say a chosen objective is not due** (204, as selection would): the choice would be refused almost everywhere it is offered, and every focused run would end at its first success.
- **Offer Practise only where something is due**: avoids a refusal, but takes away the choice exactly when the learner has nothing else to do.
- **Keep serving extra practice on Continue**: easy to repeat known material without a learning reason, which product.md rules out; one question per tap keeps every extra question the learner's own request.
- **Choose in the app** by reading the standings and answering any task: attempts are not bound to an activity served (ADR 0015), so it would work, but rests, the limit, and rotation would be the app's to restate.
- **`review` as the intent**: review means due (progress-5); an extra question would then misreport why it was asked.

## Consequences

- An early success postpones the scheduled review, though it is little evidence of lasting recall: the success restarts the due clock and barely grows stability, as today's evidence model does for any success not due. Accepted; extra practice stays a visible, deliberate act, never repeated by itself.
- A miss on extra practice discards the objective's stability, as any lapse does.
- A chosen objective's rest has nothing else to fill it: a one-task objective rests ten minutes, and the page says when it resumes.
- The decision a learner sees can be the learner's own, so a client switching on `intent` handles `practise` too.
