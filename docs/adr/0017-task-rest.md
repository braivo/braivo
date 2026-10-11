# 0017: A task rests after it is answered, and practice moves on meanwhile

Status: accepted (2026-09-25)

## Context

Grading shows the learner the answer ([ADR 0015](0015-tasks.md)). An objective with one task that the learner fails is selected again at once to re-teach it, and the only task to offer is the one whose answer is still on screen. A success then cannot tell learning from recall of the feedback, yet it moves the objective to `retaining` — the model's strongest claim — on that alone. Spaced-repetition systems handle this with learning steps: a failed item comes back after an interval, not immediately.

The interval should be filled with other practice, not waiting. In a vocabulary course, one task per word, a missed word is `acquiring`, which outranks everything, so a rest that only waits stalls the learner after their first miss; the experience a learner expects (Lingvist's) is the missed word back after a few other cards. Counting the rest in minutes alone does not deliver it either: a learner who misses the first of twenty new words and answers five others in a minute should meet it again then, not ten minutes later.

## Decision

A task a learner answered rests before that learner is asked it again: for `TASK_REST_MS`, ten minutes, or until `TASK_REST_ATTEMPTS`, three, attempts by that learner at that organization on other objectives were recorded after it, whichever ends first. Both run from when Braivo accepted the attempt, which stands in for when the learner saw the grade: Braivo cannot know that. It is an application rule over stored attempts, outside `learning`, which stays unaware of tasks; nothing new is stored.

- **Other objectives, not other tasks.** A sibling task of the same objective is no spacing. Any outcome counts, Show answer included. A resend records nothing, and evidence posted from elsewhere is no attempt, so neither counts.
- **Rotation first.** Rotation prefers the least recently answered task, so an objective with several tasks offers another one at once. Its least recent task rests only if every one does: an older attempt has had at least as long and as many attempts on other objectives since.
- **Selecting again.** When every task of the decided objective rests, selection runs again without it, unseen objectives included, in course order. `acquiring` outranks the rest, so the missed objective comes back first once its rest ends. Only when every objective with a task that needs attention rests — ahead of one without a task, which would only say there is nothing to practise — does the activity route answer `retryAfter`, in seconds, naming the objective whose rest ends first, instead of a decision and a task — a duration rather than a date, so a client's clock need not agree with the server's. With nothing else answered meanwhile, that is ten minutes after its answer.
- **Refused, not deferred.** A new attempt on a resting task is refused by the same rule, checked against the task's latest earlier attempt, so a client cannot answer straight after seeing the answer. The refusal is a 409, like an attempt ID conflict: both tell the client to ask for the activity again. A 429 with `Retry-After` would invite resending the refused attempt once the rest is over, recording an answer chosen with the feedback on screen. A resend of an attempt already recorded is not a new answer and is accepted.

## Alternatives rejected

- **Waiting while the decided objective rests** (replaced): kept the course's sequencing in one selection rule, since filtering a resting objective out could introduce the next unseen one ahead of it; but it stalled a vocabulary course after its first miss, and a missed word's neighbours seldom depend on it.
- **Selecting again among started objectives only**: still stalls a learner whose only started objective is the one they missed, which is every learner's first miss.
- **A course flag keeping the old sequencing**: waits for a course whose order is a prerequisite chain and shows harm.
- **Discount the evidence.** Recording a quick success as weaker would need a graded outcome or a new evidence field, which the model deliberately does not have.

## Consequences

- New objectives may be introduced while a missed one rests, so material can arrive before an earlier objective is recovered. A learner with nothing else to practise — a one-objective course, or everything else resting or not yet due — still waits up to ten minutes, and the learn app says so and asks again by itself.
- A success three attempts after seeing the answer counts in full, as any success does: the model cannot tell short-term recall from learning.
- Ten minutes and three attempts are provisional. Since attempts within the rest are refused, recorded attempts alone cannot show whether a shorter rest would do; changing either needs an experiment.
- Deciding costs a count of the learner's recent attempts for each objective found resting, and selection runs once more for each; few objectives can rest at once, since each needs fewer than three attempts on other objectives since its own.
- A grade lost on the way back and fetched by a resend minutes later leaves less of the rest after the learner sees it. Tracking delivery would cost more than that edge is worth; revisit if experiments show it matters.
- Attempts recorded in the same millisecond do not count as after one another, so a tie keeps a rest rather than ending it.
- Two new attempts submitted at the same moment can both pass the check and both be recorded as evidence. The window is a race between one learner's own requests, and is accepted for now.
