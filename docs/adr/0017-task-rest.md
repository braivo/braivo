# 0017: A task rests after it is answered

Status: accepted (2026-09-25)

## Context

Grading shows the learner the answer ([ADR 0015](0015-tasks.md)). An objective with one task that the learner fails is selected again at once to re-teach it, and the only task to offer is the one whose answer is still on screen. A success then cannot tell learning from recall of the feedback, yet it moves the objective to `retaining` — the model's strongest claim — on that alone. Spaced-repetition systems handle this with learning steps: a failed item comes back after an interval, not immediately.

Two ways to avoid the immediate repeat were rejected:

- **Offer another objective meanwhile.** Filtering a resting objective out of the candidates would make selection introduce the next unseen one, so every failure would unlock new material and the course's sequencing ([spec](../specs/learning-model.md#selection-rule)) would stop holding.
- **Discount the evidence.** Recording a quick success as weaker would need a graded outcome or a new evidence field, which the model deliberately does not have.

## Decision

A task a learner answered rests for `TASK_REST_MS`, ten minutes, before that learner is asked it again. It is an application rule over attempts, outside `learning`, which stays unaware of tasks.

- Rotation prefers the least recently answered task, so an objective with several tasks offers another one at once. Only when every task of the decided objective is resting does the activity route answer `retryAfter`, in seconds, instead of the decision and a task — a duration rather than a date, so a client's clock need not agree with the server's.
- A new attempt on a resting task is refused, so a client cannot answer straight after seeing the answer. The refusal is a 409, like an attempt ID conflict: both tell the client to ask for the activity again. A 429 with `Retry-After` would invite resending the refused attempt once the rest is over, recording an answer chosen with the feedback on screen. A resend of an attempt already recorded is not a new answer and is accepted.

## Consequences

- A learner with one task on an objective they failed waits up to ten minutes, and the learn app says so and asks again by itself. Giving an objective several tasks makes the wait rarer.
- Ten minutes, like Anki's second learning step, is provisional, like the learning model's constants. Recorded attempts cannot tune it alone, since none come sooner: shortening it needs an experiment.
- Two new attempts submitted at the same moment can both pass the check and both be recorded as evidence. The window is a race between one learner's own requests, and is accepted for now.
