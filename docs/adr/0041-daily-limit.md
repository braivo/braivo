# 0041: A learner starts at most twenty new objectives a day

Status: accepted (2026-10-11)

## Context

Selection introduces new material whenever nothing is acquiring or due ([learning model](../specs/learning-model.md#selection-rule)), with no limit. A learner who works through eighty new words in one sitting is caught up that evening and faces eighty reviews over the next days, most of them failed; the pile, not the material, ends the course for them. Spaced-repetition apps limit new items per day for this reason, and Lingvist-style vocabulary practice, Braivo's first pilot, expects it. Reviews are the opposite case: limiting them only lets recall decay further.

## Decision

`NEW_OBJECTIVES_PER_DAY`, twenty, objectives a learner may start in a day at an organization. Once reached, objectives not yet started are left out of the candidates `selectNext` sees, for both the next-objective and the activity routes, so acquiring and due ones are still decided as before. It is eligibility in the application, beside the course's candidate list; `learning` is unchanged.

- **Counted from evidence.** An objective is started on the day of its first evidence at the organization: answering it again counts nothing, an objective two courses share counts once, every course at the organization draws on one limit, and nothing is stored. Evidence from elsewhere counts too, since it brings the same reviews.
- **The learner's day.** A day begins at four in the morning in the time zone the request names, `?timeZone=` with an IANA name, UTC when it names none; an unknown name answers 400. Until four it is still the day before, so a session past midnight is the evening's. `learnerDayIn` steps back a calendar date, not hours, so a night whose clocks change begins the day at four too. The browser client sends its runtime's zone, which is its user's, and the learn app counts "Practised today" in the same days. A learner who names another zone gains only material their own pacing held back.
- **Said, not hidden.** When nothing else needs attention and objectives were held back, the answer is the limit, `{ "dailyLimit": 20 }` with 200, rather than 204: the learner is not caught up, and the learn app says new material can be started again tomorrow, with when the next review falls due. Tomorrow is the learner's: at one in the morning, after they sleep.
- **A constant.** Twenty, provisional, with no per-course or per-learner setting until a pilot shows the need.

## Alternatives rejected

- **Midnight** (replaced): twenty words at 23:50 and twenty more at 00:05 made forty before one night's sleep, and "Practised today" lost the evening's work at midnight. Four is Anki's default for the same reason.
- **A rolling 24 hours**: needs no time zone, but a learner who starts twenty words at 8 p.m. gets none the next morning; learners think in days.
- **The organization's or a stored learner time zone**: neither exists, and the device's zone is the learner's wherever they are. Better Auth keeps none; a stored one would go stale when the learner travels.
- **Counting attempts only, not outside evidence**: an import of earlier results would then add reviews the limit does not see. An import dated today does fill today's limit, which is the cost.
- **A share of each session for new material**: needs session state selection does not have ([learning model](../specs/learning-model.md#not-in-scope)).
- **Limiting the activity route alone**: the next-objective route would then introduce what the activity holds back, so the two decisions would disagree.

## Consequences

- A tab left open past four shows the limit until it reloads.
- Attempts are not bound to an activity served ([ADR 0015](0015-tasks.md)), so a client answering tasks it was not offered, or two tabs open at once, can start more than twenty. The limit paces selection; it does not police answers.
- Twenty is a guess for vocabulary. A course of larger objectives may want fewer; a setting waits for the course that needs one.
