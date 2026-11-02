# 0054: Review shows an objective's own passages, once the learner has answered on it

Status: accepted (2026-11-07). Amends [ADR 0021](0021-citations.md) for passages shown before an attempt, and [ADR 0039](0039-published-in-the-console.md) for citations carrying their publication.

## Context

A miss makes an objective `acquiring`, and the learner meets its tasks again after each one's rest ([ADR 0017](0017-task-rest.md)). The feedback after a miss shows that one task's answer, explanation, and passages ([ADR 0021](0021-citations.md)). Nothing shows the objective as a whole, so a learner who never understood the rule meets task after task with no way back to the lesson, though most objectives already cite the passages that teach them, with no extra work from the teacher.

Three rules bound what a review may be. ADR 0021 shows a learner a task's passages only after answering it, since a passage could give the answer away. The learning model counts no reading as evidence, and a task graded after one is ([learning model](../specs/learning-model.md), "What a grader admits"). Re-teaching is the application's to shape, since `learning` returns only the intent ([learning model](../specs/learning-model.md), Interaction contract).

## Decision

- **The learner opens it; nothing opens it for them.** **Review this topic** is offered in the feedback after a miss, Show answer included, and while the objective's tasks rest, for an objective with at least one citation a review would show. A threshold of misses, or a review shown automatically, would be a parameter with no evidence behind it and an interruption to a learner who understood.
- **It shows the objective's own cited passages, nothing else.** Each as a task's passages are shown (quote, source title and link, moment or page), in the same order, at most five: drafting cites at most five per objective; a tool may cite more, and the first five are shown. No authored note and no generated text: the material is the owner's own words, published by a person.
- **Only citations a person published.** A tool may cite an objective at any time, and [ADR 0039](0039-published-in-the-console.md) lets nothing a tool writes reach learners until someone publishes it, so a citation carries the state, as a task does: a browser's is published as written, accepting a reviewed draft; a tool's waits until Publish on a course's page, which shows each objective's citations and sends the keys of those pending it showed, alone or with whatever else it publishes; beside other work, the owner may hold them back. Citations stored before this rule wait too: nothing records that a person saw them.
- **Only once the learner has evidence on the objective** at its organization. This amends ADR 0021: an objective's passages are shown before an attempt on it, but never before the learner's first, so a review is never a preview of the answers. After a first answer, a passage may still give away a sibling task's answer; that is accepted below, as the cost of re-teaching from the material itself.
- **Opening it records nothing** on the server: no evidence, no attempt, no change to a rest, the shuffle, or selection. It never releases a resting task.
- **The next answer counts in full.** The passages are study before an attempt, closed while the learner answers, so the attempt is unaided as the learning model reads what a grader admits. Its success moves the objective as any success does; later reviews, spaced by the model, settle whether it is retained.
- **The attempt records `reviewedTeaching`**, exposure metadata: whether the learner's app showed them the objective's passages since their previous attempt on it. The app sets it, the server stores it with the attempt, and it is part of the attempt's identity, so a resend cannot change it. Grading, evidence, rests, and the model never read it; it is there to calibrate the model and to read what reviews do.

## Alternatives rejected

- **Review shown automatically, after a miss or after several:** interrupts every learner to help some, and its threshold is a guess.
- **Discounting a success after a review:** needs a weighted outcome the model does not have ([ADR 0017](0017-task-rest.md) rejects it for the same reason); `reviewedTeaching` lets calibration measure first whether it should.
- **Recording the review on the server** (an exposure event, or the read itself as a write): the model counts no reading as evidence, a read with a side effect is no read, and a client-side flag is enough to calibrate with.
- **An authored note per objective** (a teaching card, written by the teacher or the drafter): another thing to write and review per objective. It follows if the pilot shows passages alone teach poorly.
- **Every citation, whoever added it and when:** a tool's citation on a published course would reach learners unreviewed, against ADR 0039.
- **A citation dated, shown once a course with its objective was published at or after it** (replaced): nothing new to publish, but a citation a tool adds between a page's loading and its Publish was published unseen, and time is no record of what a person saw; one added after every such course was published waited for another course.
- **Citations stored before this rule counted as published:** a tool's added after its course was published would reach learners unseen.
- **The passages the objective's published tasks cite, instead of its own:** inside ADR 0039 with nothing new stored, but a one-task objective, the vocabulary case, would review only the passage its feedback already showed.
- **An explanation generated on demand:** reaches learners unreviewed, against "published by a person" ([product](../product.md)).
- **A `lesson` task kind:** reading is not evidence, so it would be a task graded by nothing.
- **Review before any answer on the objective:** gives answers away (ADR 0021).

## Consequences

- **Accepted inflation:** after a review, a sibling task may be offered at once, and one success moves `acquiring` to `retaining`. v1 reads that as uncertain retention, never as corrected: it may overestimate retention for a while, and the spaced reviews that follow test it. If the pilot shows successes after a review followed by failed reviews, the first change is a rest of the whole objective after a review, or keeping it out of the next activity; both need review state on the server.
- `reviewedTeaching` is the tab's: lost with the tab, blind to a review on another device, and it may last until the next day. Calibration reads it as a lower bound on exposure, never as proof that the learner read or understood anything.
- A wrong objective citation shows in the review as it already shapes drafting; citations cannot be removed ([ADR 0021](0021-citations.md)), which is authoring's gap.
- Source passages may explain poorly, as material that is only a vocabulary table or an exercise does. An authored note follows only if use shows that need.
- Existing citations need publishing: review work for owners, but nothing reaches learners that nobody demonstrably approved. A course already published reviews nothing until a person publishes its citations from its page, as for its pending tasks, the organization's page marking it Needs review meanwhile; one shared by courses reaches each course's reviews at once, which the confirmation names.
- A grade and a resting activity say whether the objective can be reviewed (`reviewable`), one existence check each, so the app offers no button that would open nothing.
