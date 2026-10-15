# 0044: Learners' links name a course by a random number within its organization

Status: proposed (2026-10-13)

## Context

A teacher sends learners to a course by chat, by email, or aloud in class. The learn app named a course by its UUID, `/courses/c5d24a3f-93fc-40ff-acf2-02ac36de4b98`: impossible to dictate or type, and meaningless to read. The learn domain already names the organization ([ADR 0004](0004-one-application-origin.md)), so what the address must add is a course among that one organization's, which a handful of characters can do.

## Decision

Each course has a **number**, `course.number`, unique within its organization (`UNIQUE (organization_id, number)`), never changing. The UUID stays its identity everywhere else: keys, the API's course routes, evidence, a learner's unfinished answer.

- **Random, four digits, then five.** A new course draws a number its organization has not used, at random from 1000–9999 while any is free, then 10000–99999, then one past the largest. The draw is SQL inside the insert; a creator drawing the number another took meanwhile meets the unique index and starts over, three attempts in all. A keyed retry ([ADR 0024](0024-idempotent-authoring.md)) answers the existing course, which keeps its number.
- **The learn app's address is `/c/<ref>`.** `<ref>` is the number, `/c/4732`, short enough to dictate; or the number and a label, `/c/4732-everyday-english`, to read; or the UUID, which also works on the installation's host. Links Braivo writes on an organization's domain carry the label; a course with an empty one is the number alone.
- **The label is presentation, never identity.** Lowercase letters and digits of any script with their marks, at least one, hyphens between, at most 80 characters and 200 UTF-16 code units, as marks may stack without limit on one (`urlLabel`). It is the title's until the organization's `owner` or `admin` sets another, in the console or with `POST …/courses/:courseId/url-label`, saved only over the label they read, so a change made meanwhile is refused, not undone; repeating the same change succeeds. It is not unique: two courses may share one. Stored `null` until set, read as the title's, so that the migration need not repeat the title's Unicode transform in SQL; harmless while titles cannot change (see Consequences). Any label reaches the course: a stale one is replaced in the address by the current one, before the page asks anything else, so its learning work runs once; the page shows the title Braivo answers, never the label.
- **A number names a course on its organization's domain alone.** `GET /api/courses?number=4732` finds it among the session's learner's courses there, so a number is resolved, authorized, and scoped exactly as the list is (learner-loop-2). On the installation's host, which reaches every organization, a number names none, and the learn app links by UUID.
- **A number is not a secret.** Four digits are guessed in seconds; reaching a course still needs a session that may study it. A course not found and a course not theirs look alike.
- **Never reused.** No course is deleted today; deletion, when it comes, must keep the number from being drawn again (by keeping the row or recording the number), as a link sent earlier must not reach another course.

## Alternatives rejected

- **Sequential numbers from 1**, `/c/12`: shorter, but a mistyped digit lands on a neighbouring course, the numbers count an organization's courses to anyone, and allocating them serialises each organization's creations. Among a few hundred random numbers of 9000, a typo mostly lands on none.
- **Letters, a short Nano ID**, `/c/k7mq`: more per character, but letters are spelled differently across languages, confused (`l`/`1`, `O`/`0`), cased, and can spell words. Four digits hold 9000 courses an organization, and five 90,000 more.
- **A UUID or a long random ID**: unique across the installation without a domain, but no one dictates it, and the domain already narrows the search to one organization.
- **A label always the title's**: no column or editor, but a school could not shorten a long title's address, or keep one across a renamed course.
- **A label unique within the organization**, as a slug: an address without a number, but a rename then frees a label another course may take, so an old link reaches the wrong course; with the number naming the course, a label needs no uniqueness.
- **Keeping `/courses/<uuid>` beside `/c/`**: one route reads both forms, so a second would only preserve links nobody was given (Braivo is unreleased).

## Consequences

- An address keeps working while the course exists: the number never changes, and a label never selects.
- When titles become editable, a course whose label is still `null` must have its title's label written first, or renaming it would change its address.
- A learn domain's addresses mean nothing on another organization's: `/c/4732` there is that organization's course 4732, or none. Moving a course to another organization would need its own decision about the number and the links already sent.
