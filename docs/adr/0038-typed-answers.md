# 0038: Typed answers, graded by comparing, and Show answer

Status: accepted (2026-10-11)

## Context

The only task kind is `choice` ([ADR 0015](0015-tasks.md)). Picking the right option from four tests recognition; a vocabulary course has to test recall, the learner producing the word, or a success says less than it seems to. Grading recall by AI costs money and latency per answer and gives outcomes that are not reproducible, which a word, a date, or a name does not need: its answer is a short, closed text an author can list.

A learner who does not know the answer can today only guess, and a guess on a choice task can succeed; the record cannot tell it from knowing.

## Decision

- **A second kind, `typed`**, named for what the learner does, as `choice` is. Its body: `prompt`; `accepted`, every answer graded correct, 1 to 20, each 1 to 200 characters, none empty or equal to another once compared (below), the first the one a learner who missed is shown; an optional `explanation`; and an optional `answerLanguage`, the BCP 47 tag of the language the answers are in, stored canonical as a source's language is. A tag on the task, not the course: a task serves every course its objective is in, and a translation course alternates directions. Nothing reads it yet; it is there because a task is immutable, so a course drafted without it could gain it only by replacing every task.
- **Comparing, deliberately little.** Both sides are compared after NFC, trimming, each whitespace run made one space, `toLowerCase()` (locale-independent, so the same everywhere), and typographic apostrophes and quotes folded to ASCII. Nothing else: punctuation counts, accents count, and a variant the author accepts is one the author lists (`["żółć", "zolc"]`). Its own function, so changing it never changes how options are validated or how tasks are matched as twins ([ADR 0024](0024-idempotent-authoring.md)).
- **Grading.** Success when the text equals an accepted answer as compared; otherwise failure, the empty text included (which the learn app does not send: a stray Enter is no answer).
- **A response names exactly one of** `choice` (a choice task), `text` (a typed one, up to 500 characters, stored exactly as sent), or `reveal: true` (either kind). Naming none of them, or more than one, answers 400: a mixed response is never read as whichever field the parser looks at first. Other fields are ignored, as elsewhere in the API, and a resend is compared on the response as read.
- **Show answer is a response, `reveal`, on both kinds**, offered before answering. The server grades it a failure, so it is recorded as an attempt like any other (its evidence, its rest, its reseeding) and answered with the grade, which shows the answer. The stored response keeps `reveal`, so asking can later be told from missing without a migration. Not an empty answer: a guess and a request to be taught would then look alike.
- **The grade says its kind.** `choice` keeps its fields and gains `kind`; `typed` answers `{ kind, outcome, correctAnswer, explanation?, passages? }`, `correctAnswer` being the first accepted answer whichever matched. The learn app shows it only on a failure, so a learner who typed the second accepted spelling is not corrected.
- **A client meeting a kind it does not know** shows that the activity is not supported there, with a way back to its courses, and sends nothing. The server cannot know a client's kinds, so it keeps offering the task; Braivo's own apps ship with the server. Kinds a client renders are negotiated only once a second client renders some kinds and not others.

## Consequences

- Case never counts, so a typed task cannot assess capitalization (German `Sie` and `sie`), and Turkish casing is not modelled (`I` lowers to `i`, not `ı`): such answers stay choice tasks until a course needs a rule.
- A slip of one letter is a failure, as a wrong word is, until near misses arrive (planned as forgiving feedback that records nothing); a hint, likewise, is planned and not decided here. Each amends this ADR when it comes.
- Evidence stays binary and task-blind ([learning model spec](../specs/learning-model.md)): recognition and recall, a miss and a reveal, count alike. The attempt keeps the response and its task's kind, so a weighting decided later has what it needs.
- A task missed or revealed rests ten minutes before it can be asked again ([ADR 0017](0017-task-rest.md)), and when it is its objective's only one, so does practice on that word. Bringing a missed word back after a few others is relearning, a decision of its own, taken before a vocabulary course reaches learners.
- A word in a sentence's gap is the next step, added to this kind as an optional field rather than a placeholder in `prompt`.

## Alternatives rejected

- **A vocabulary kind, or experience modes.** A new interaction is a new kind with its own grader, sharing everything else; a medium (audio, an image) is a field of the kind it serves.
- **Implicit accent or punctuation folding.** It would grade two different words alike (Polish `kat`, an executioner, and `kąt`, an angle), and only the author knows which variants are acceptable.
- **AI grading for short answers.** Cost and latency per answer, and an outcome that would have to be stored with its provenance, for answers an author can list.
- **The empty text as Show answer.** It would make a guess and a request to be taught look alike in the record.
