# 0052: A learner reports a problem with a task they answered, and the school's administrators resolve it in the console

Status: accepted (2026-11-02)

## Context

A task can be wrong: its answer key, two options that both fit, a right typed answer not accepted, unclear wording, a passage that does not support the answer. The learner is then graded wrong, the failure counts against their estimate ([learner loop](../specs/learner-loop.md), learner-loop-13), and the task returns to them and to every classmate. Nothing in the learn app lets them say so, and a task shows no ID they could quote to a teacher.

More and more tasks are drafted by AI, through Braivo's drafting or the owner's own assistant. A person publishes everything ([ADR 0039](0039-published-in-the-console.md)), but one reviewing a hundred objectives misses subtle defects: learners are the last reviewers, and what they notice is lost. A school must be able to tell which published tasks its learners dispute, and fix them without the operator.

What a learner answered and wrote is their data. An `author` reaches none of it ([ADR 0048](0048-author-role.md)), and whether tools may read learners' answers was decided apart: not yet, the console only, until the setting of [ADR 0050](0050-tools-read-learner-data.md) says in its confirmation that answers and notes reach AI providers.

## Decision

- **A report is about one recorded attempt.** A learner reports from a task's feedback, after answering, Show answer included; the attempt fixes the task version they saw and what they answered, so the report stores neither again and cannot name a task they never answered. It is keyed by the attempt (learner, organization, attempt ID), so sending it again is recognised as an attempt's resend is ([ADR 0015](0015-tasks.md)). It holds a reason, an optional note of at most 500 characters, and when it was sent.
- **Reasons, a fixed set:** `answer-correct` (my answer seems correct), `key-wrong` (the expected answer seems wrong), `confusing` (the question or explanation is confusing), `unsupported` (the lesson passage does not support this), and `other`, which needs a note. `answer-correct` is accepted only after a miss that was not Show answer, read from the attempt's recorded outcome, never regraded. The learn app offers `unsupported` only when the grade showed passages; the server does not check that, since nothing is lost by accepting it.
- **One undismissed report per learner and task, never changed.** A report is not edited. Sending the same one again answers what is stored; a different one for that attempt, or any report of a task the learner already has an undismissed report on, from any attempt, is refused, coded `ALREADY_REPORTED`. Once dismissed, the learner may report the task again. A unique index over undismissed reports holds this against racing requests, and bounds what a reviewer faces: a learner's open reports never outnumber the organization's live tasks. A report closed by the task's retirement still counts, since a retired task never returns.
- **Reporting changes nothing about learning.** It never touches the attempt, its evidence, the task's rest, the shuffle, or which tasks are offered: a learner never chooses an outcome (ADR 0015), and a reported task is not held back from them or anyone, since one class's reports could withdraw an objective's only task. It is accepted on a task retired since the feedback was shown, and while practice rests.
- **Its state is derived, never stored:** open while not dismissed and its task not retired; closed once the task is retired, by Retire or by a correction (the console's at once, a tool's when published); dismissed when an administrator dismissed it while the task was live. Retirement wins when both hold. An open report whose task a tool's correction waits to replace stays open, naming the correction.
- **The school's administrators read and resolve reports, in the browser alone.** An `owner` or `admin` sees, per reported task, how many learners reported it, and per report its reason, the answer recorded, the note, and the date, never the learner's name or ID. An `author` sees nothing of them, not even a count ([ADR 0048](0048-author-role.md)). A tool, a device-flow token or a connection, is refused reading and dismissing them whatever ADR 0050's setting says, and no MCP tool reads them; dismissing is a review decision, as retiring a published task is a browser's ([ADR 0039](0039-published-in-the-console.md)). The learner is told that their school will see the question, their answer, and their note, and never that the report is anonymous: in a small organization the answer and note can identify them.
- **Resolving is the task's existing actions, plus Dismiss.** Edit corrects the task and Retire retires it, which closes its reports; for a typed task reported `answer-correct`, Edit opens with that answer added to the accepted ones, saved only by Save. Dismiss closes exactly the reports the reviewer was shown, by ID, so one sent after the page was read stays open, and records who dismissed them and when.
- **Erased with the learner's account,** as the attempt it is about is.

## Alternatives rejected

- **A free-text feedback channel:** names no task and no answer, so a reviewer cannot act on it.
- **A report per task, without an attempt:** unbounded, editable, and able to name a task the learner never met.
- **A stored status:** races the task's retirement, which already says whether a report still needs a look.
- **Authors reading reports:** an answer and a note are learner data, which an `author` does not reach ([ADR 0048](0048-author-role.md)). A content-only view comes when a school asks.
- **Hiding a task automatically after some number of reports:** one class could withdraw an objective's practice from everyone; the reviewer decides.
- **Emailing the school:** another channel to configure, with nothing to resolve the report in.
- **Reporting before answering:** needs a report without an attempt, so the whole key; Show answer reaches feedback, at the cost of a recorded failure.
- **Holding a reported task back for its reporter:** changes selection ([ADR 0017](0017-task-rest.md)), and could remove an objective's only task.

## Consequences

- Reporting changes neither grading nor which task is offered: a learner who reported a wrong key may meet the task again after its rest, and may be graded wrong again, until a reviewer acts. A report open a week, or a recurrence that costs trust sooner, even within a session, brings forward holding a reported task back for its reporter while its objective has another published task.
- Show answer before reporting records a failure, even for a learner who knew the answer to a broken question; evidence graded by a task later retired as wrong still counts. Attempts stay as recorded; discounting or regrading is decided once confirmed defects change what learners practise or what a teacher concludes ([authoring](../specs/authoring.md), Gaps).
- A learner who first reported a task as confusing and then sees its key is wrong is told they already reported it. If that shows, a new report replaces their open one.
- Dismissed reports accumulate, each bound to a recorded attempt and a reviewer's dismissal.
- A correction or Retire closes every report on its task, whatever each said: closed means the version left practice, not that a complaint was upheld. The learner hears an outcome only once a correction keeps a link to what it replaced, then that the question changed, in the app, never for a dismissal or a task withdrawn without one, and never promising credit ([authoring](../specs/authoring.md), Gaps).
- Teachers of groups who do not administer read no reports until a contract for disclosing a learner's attempts to their teachers; an `author` may be handed a correction to make, written by the administrator, never a learner's answer or note.
- AI may check a candidate correction against its cited passages, content alone. Any future analysis of which recorded answers a proposed correction would grade differently is computed by Braivo, never a model, and shown only to an authorized reviewer in a browser. Answers and notes reach a provider, through `/mcp` or Braivo's own AI, only once ADR 0050's confirmation covers them.
- Reports are learner data: an export or erasure of a learner's data includes them.
