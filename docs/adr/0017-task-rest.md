# 0017: A task rests after it is answered

Status: accepted (2026-09-25)

## Context

Grading shows the learner the answer ([ADR 0015](0015-tasks.md)). An objective with one task that the learner fails is selected again at once to re-teach it, and the only task to offer is the one whose answer is still on screen. A success then measures short-term memory of the feedback, not learning, and it moves the objective to `retaining` — the model's strongest claim — on that alone. Spaced-repetition systems handle this with learning steps: a failed item comes back after an interval, not immediately.

Two ways to avoid the immediate repeat were rejected:

- **Offer another objective meanwhile.** Filtering a resting objective out of the candidates would make selection introduce the next unseen one, so every failure would unlock new material and the course's sequencing ([spec](../specs/learning-model.md#selection-rule)) would stop holding.
- **Discount the evidence.** Recording a quick success as weaker would need a graded outcome or a new evidence field, which the model deliberately does not have.

## Decision

A task a learner answered rests for `TASK_REST_MS`, ten minutes, before that learner is asked it again. It is an application rule over attempts, outside `learning`, which stays unaware of tasks.

- Rotation prefers the least recently answered task, so an objective with several tasks offers another one at once. Only when every task of the decided objective is resting does the activity route answer the decision with `retryAfter`, in seconds, instead of a task — a duration rather than a date, so a client's clock need not agree with the server's.
- A new attempt on a resting task is refused (429 with `Retry-After`), so a client cannot answer straight after seeing the answer. A resend of the same attempt is not a new answer and is accepted.

## Consequences

- A learner with one task on an objective they failed waits up to ten minutes, and the learn app says so and asks again by itself. Authors avoid the wait by giving an objective several tasks.
- Ten minutes is provisional, like the learning model's constants: recorded attempts should show what interval separates recall from echo.
- Two new attempts submitted at the same moment can both pass the check. The window is a race between one learner's own requests, and it does not corrupt evidence.
