// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// HTTP entry point to `application`. Only the endpoints and shapes documented
// here are public contracts; everything else is an internal detail.
// Why Hono, and what a route may do: docs/adr/0010-hono-http-layer.md.
//
// `/api/auth/*` — Better Auth's own surface, mounted per ADR 0006. An account
// is made or signed in to by an email code: `POST /api/auth/email-otp/send-verification-otp`
// `{ "email", "type": "sign-in" }` mails one (429 if one went to that address
// within the minute), and `POST /api/auth/sign-in/email-otp` `{ "email", "otp",
// "name"? }` redeems it, `name` naming a new account (ADR 0018). With Google's
// OAuth client configured, `POST /api/auth/sign-in/social` `{ "provider":
// "google", "callbackURL", "errorCallbackURL" }`, a JSON write, answers Google's
// address; Google returns to `/api/auth/callback/google`, which redirects to
// `callbackURL` signed in, or to `errorCallbackURL` with an `error` query
// parameter (to `/login` when it cannot tell where the sign-in began).
//
// `GET /api/sign-in-settings` — `{ "google": boolean, "legal": { "privacy",
// "terms" } | null }`: whether `/login` offers Google besides email codes, and
// the operator's pages that signing in agrees to. No session needed.
//
// `BRAIVO_URL`'s host is the console's and its tools'. On any other — an
// organization's learn domain — `/api/auth/*`, `/api/handoffs/*`,
// `/api/sign-in-settings`, `/api/memberships`, and every `/api/organizations…`
// route answer 404, and any request carrying `Authorization` 401 (ADR 0004,
// ADR 0022).
//
// What PostgreSQL cannot store as sent, a NUL or an unpaired surrogate, is
// refused after those host refusals and before any session is read: a path
// carrying `%00` answers 404, since no ID holds one; a query carrying it, 400;
// a body read as JSON, Better Auth's included, holding either in any key or
// string, 400 with `{ "error": "…" }` naming where (`tasks[0].prompt`).
// A body of Braivo's own routes that is not UTF-8 is not JSON (RFC 8259): a
// bare 400, when any malformed body is refused, rather than a lenient decode
// that could make two IDs one.
//
// A learn domain signs in by handoff from `BRAIVO_URL`'s origin (ADR 0018), and
// holds a learner session, Braivo's own, in its `__Host-braivo-learner`
// cookie: the session the learner routes below take there, and the only one.
//
// - `GET /api/session/sign-in?redirect=<path>` on a learn domain: sets the
//   `__Host-braivo-handoff` nonce cookie and redirects to
//   `BRAIVO_URL/login?handoff=<id>`; 404 on any other host.
// - `GET /api/handoffs/:id` on `BRAIVO_URL`'s host: what that sign-in is for,
//   `{ "organization": { "name": "…" }, "hostname": "…" }`; 404 once expired
//   (15 minutes after it began, or a minute after a code was issued), spent,
//   or its domain no longer the organization's.
// - `POST /api/handoffs/:id`, a JSON write, as the session's user: 200
//   `{ "url": "https://<hostname>/api/session/handoff?code=…" }` for a member of
//   the organization, to navigate to within a minute; 401 no session, 403 not a
//   member, possibly forged, or a bearer token, 404 as above.
// - `GET /api/session/handoff?code=` on the learn domain: with the nonce cookie,
//   sets the learner session (a week, renewed by use once a day old) and
//   redirects to the path sign-in began from; otherwise (a code spent, late,
//   or from another browser) spends nothing and redirects to `/login?failed=1`;
//   404 on `BRAIVO_URL`'s host.
// - `GET /api/session`: who is signed in on this host, `{ "user": { "id",
//   "name" } }`, from its learner session on a learn domain or the account's on
//   `BRAIVO_URL`'s; 401 when no one is.
// - `POST /api/session/sign-out`, a JSON write: ends this host's session, a
//   learn domain's learner session alone; 204, or 403 possibly forged or a
//   bearer token.
//
// `GET /api/connections` — the AI apps the signed-in person connected at
// `/mcp` (ADR 0045), oldest first: `{ "connections": [{ "id", "client": { "id",
// "name" | null }, "organization": { "id", "name" }, "connectedAt" }] }`.
// `POST /api/connections/:id/disconnect`, a JSON write, ends one: 204, or 404
// none of theirs by that ID. Both a browser's alone: 401 no session, 403 a
// bearer token or a connection, or a write possibly forged (access-42).
//
// `GET /api/host` — what the request's host serves, for the learn app there to
// present itself as: `{ "organization": { "name": "…" } | null, "installation":
// false | true }`, an organization's domain, or `BRAIVO_URL`'s, whose origin
// serves Braivo's own learn app (ADR 0059); both empty, neither. No session
// needed. The host is the request's `Host`, so a router in front forwards it
// unchanged (ADR 0004).
//
// `GET /api/organization` — `/api/host`'s organization alone, `{ "name": "…" }`,
// or 404, for learn apps built before `/api/host`; kept for one release, as the
// API and the learn app may deploy apart.
//
// On an organization's domain, the learner's `/api/courses/:courseId/…` routes
// below answer another organization's course 404, as one that does not exist.
// A host that is neither that nor `BRAIVO_URL`'s holds no session, so these
// routes answer there as without one (401); so does a course's overview
// anywhere but `BRAIVO_URL`'s.
//
// On `BRAIVO_URL`'s host, a session is the account's: a cookie from a browser,
// or `Authorization: Bearer <token>` from a content owner's own tools, which
// get the token through the device flow under `/api/auth/device/*` as client
// `braivo-cli` (ADR 0022); every route below treats the two alike. On a learn
// domain it is that domain's learner session alone. "No session" means none
// was sent, or it has expired. A JSON write needs `application/json`, and an
// `Origin`, if sent, must be the host's own. Of `/api/auth/*`, a token reaches
// only `get-session` and `sign-out`, which ends its own session; anything else
// answers 403, and its responses carry no `set-cookie` or `set-auth-token`.
//
// `GET /api/courses/:courseId/next` — what the signed-in learner should do next
// in a course. The learner is the session's user; the request never names one.
// `?timeZone=Europe/Warsaw`, an IANA name, is the learner's, for the day new
// objectives are counted in; UTC when it is left out. Once twenty were started
// today at the organization, objectives not started yet wait for tomorrow;
// started ones, acquiring or due, never do (ADR 0041).
//
//   401  no session
//   400  `timeZone` names no time zone
//   404  the course does not exist, or belongs to an organization the learner
//        is not in. One status for both, deliberately: singling out the second
//        would enumerate other organizations' courses one guess at a time.
//   204  caught up — the course is theirs and nothing in it needs attention
//        now. Only an entitled learner reaches this, so telling it apart from
//        404 discloses nothing.
//   200  `{ "empty": true }` — the course is theirs and has no objectives yet:
//        nothing to practise, and nothing finished. Not caught up: say so.
//   200  `{ "dailyLimit": 20 }` — nothing else needs attention, and objectives
//        not started yet wait for tomorrow. Not caught up: say so.
//   200  a learning decision. Always `objectiveId`, `modelVersion` and
//        `intent`, plus the values that intent was decided on:
//
//          { "objectiveId": "…", "modelVersion": "v1", "intent": "introduce" }
//          { …, "intent": "reteach", "lastEvidenceAt": "2026-06-01T00:00:00.000Z" }
//          { …, "intent": "review", "retrievability": 0.35, "stability": 1 }
//
//        Dates are ISO 8601 strings. The shape is the serialization of
//        `LearningDecision`, so a rename inside `learning` reshapes the
//        response; `learning.test.ts` pins it so that cannot happen quietly.
//
// `GET /api/courses` — the courses the signed-in learner may study: every course
// of every organization they belong to, by title. On an organization's domain,
// only that organization's.
// 401 without a session, as on any host but an organization's domain or
// `BRAIVO_URL`'s; otherwise 200 with
// `{ "courses": [{ "id": "…", "number": 4732, "title": "…", "urlLabel": "…" }] }`,
// possibly empty.
//   ?number=4732   only the course so numbered, on its organization's domain
//                  (none on `BRAIVO_URL`'s); 400 for a number not written as one.
//   ?standing=true each course also carries the signed-in learner's own
//                  standing in it at the moment of the request, counted as
//                  the learner's progress report counts it, and what practice
//                  would offer there now (learner-loop-27), with `timeZone` as
//                  for `next`:
//                    "standing": { "retained": 3, "dueForReview": 1,
//                                  "learning": 0, "notStarted": 2 },
//                    "waiting": { "learning": 0, "dueForReview": 1, "new": 2 }
//                  The learner's evidence is replayed once per organization.
//                  400 for any other value, beside `number`, or for an unknown
//                  `timeZone`.
//   ?personal=true only those of the learner's personal organization, the
//                  one their account owns, never one they are a member of
//                  (ADR 0060);
//                  400 for any other value, or beside `standing`.
//
// `GET /api/courses/:courseId/activity` — the learner loop for learners Braivo
// serves: the next objective, with a task to practise it or, while its tasks
// rest, when to ask again. Statuses, `timeZone`, and the daily limit as for
// `next`. The decision is made among objectives with a task first, and among
// those without only when none of those is selectable. When a task is
// available, 200 answers the decision, its objective, and the task, never the
// task's answer:
//
//   { "decision": { "objectiveId": "…", "modelVersion": "v1", "intent": "introduce" },
//     "objective": { "id": "…", "title": "Greetings" },
//     "historyEpoch": 0,
//     "task": { "id": "…", "kind": "choice", "prompt": "…",
//               "options": [{ "choice": 1, "text": "…" }, { "choice": 0, "text": "…" }] } }
//
// or, for a typed task, where the learner types the answer,
// `"task": { "id": "…", "kind": "typed", "prompt": "…" }`. A client meeting a
// kind it does not know says the task is not supported there and sends
// nothing (ADR 0038). `historyEpoch` comes only with a task: its answer sends it
// back (`POST …/attempts`).
//
// When the decided objective has no task, 200 answers the decision and its
// objective without one: the learner is not caught up, but has nothing to
// practise until a task is added or another objective comes due.
//
// `?objective=<id>`, the learner's choice, decides among that objective of the
// course alone, with the same answers except caught up: one needing no
// attention is served all the same, as extra practice, `"intent": "practise"`
// (the learner's request, never the model's, with no further values), with its
// task or, without one, as no activity. Its rest and the daily limit apply as
// ever, the limit only to one not started yet. One outside the course, or an
// empty one, is a 404, as a missing course is (ADR 0058).
//
// Options come shuffled unless the author kept their order, so a learner cannot
// rely on where the answer was last time. Show them as given and answer with
// the option's `choice`. A reload keeps the order; each accepted answer reseeds it.
//
// A task rests after Braivo accepts an answer to it, because the grade reveals
// the answer: for ten minutes, or until the learner makes three attempts on
// other objectives at the organization, Show answer included, whichever ends
// first. Meanwhile another objective is decided, a new one included. When every
// objective with a task that needs attention is resting, ahead of any without
// one, 200 answers the objective whose rest ends first and in how many seconds
// to ask again: whole seconds, rounded up, and a duration rather than a date,
// so the client's clock does not matter. No decision: it may no longer hold
// when the rest ends. `reviewable` says whether its review (below) would show
// a passage, for a client offering one meanwhile.
//
//   { "objective": { "id": "…", "title": "Greetings" }, "retryAfter": 540,
//     "reviewable": true }
//
// `POST /api/courses/:courseId/attempts` — the signed-in learner answers a task,
// and Braivo grades it and records the evidence. Body
// `{ "id": "…", "taskId": "…", "response": { "choice": 1 }, "historyEpoch": 0 }`,
// where `historyEpoch` is the activity's, and `choice` the option's, as the
// activity gave it; to a typed task the response is
// `{ "text": "…" }`, at most 500 characters, stored as sent; and to either
// kind, Show answer is `{ "reveal": true }`, graded a failure. A response names
// exactly one of `choice`, `text`, and `reveal`. `id` is the client's, unique per
// learner within the course's organization, at most 128 characters (a UUID
// will do). Mint it once per answer,
// and when delivery is uncertain (a network error, a 5xx) resend that same ID:
// the resend records nothing twice and answers the same grade, where a fresh ID
// would record it again. A 409 is not such a case. Resend `historyEpoch` as first
// sent: it says which of the learner's histories here the answer belongs to
// (learner-loop-25). `"reviewedTeaching": true` says the learner reviewed the
// objective (below) since their previous attempt on it: stored with the attempt,
// for calibration, changing neither grade nor evidence (ADR 0054); absent is
// `false`, and a resend must send the same.
//
//   401  no session
//   400  the body is not an attempt, `id` is empty or too long, `historyEpoch` is
//        missing or not a non-negative integer, the response cannot answer the
//        task or names more than one of `choice`, `text`, and `reveal`, or
//        `reviewedTeaching` is not a boolean
//   403  the request could have been forged, as for evidence
//   404  the course does not exist, is not the learner's, or has no such task,
//        or the task was retired (a resend of an attempt recorded before that
//        still answers its grade)
//   409  `id` was already used at this organization for a different task,
//        response, or `reviewedTeaching`, or the task is resting for this
//        learner since their latest answer to it. Either way, ask for the activity again rather than
//        resending. `{ "error": "…", "code": "HISTORY_ERASED" }`: a new `id`
//        under a `historyEpoch` other than the learner's current one here,
//        recording nothing; final, so forget the answer, and read the activity
//        for the epoch to go on under. An `id` already recorded answers its
//        grade, whatever `historyEpoch` it names.
//   413  the body is larger than 1 MB
//   200  the grade: `{ "kind": "choice", "outcome": "failure", "correctChoice": 0,
//        "explanation": "…" }`, `correctChoice` the correct option's `choice`;
//        or `{ "kind": "typed", "outcome": "failure", "correctAnswer": "bin" }`,
//        `correctAnswer` the first accepted one, whichever matched; `explanation` present
//        only when the task has one, and `passages` only when it cites any —
//        the words it was written from, by source:
//
//          "passages": [{ "quote": "Hablé con mi madre.", "at": 62.5,
//                         "source": { "title": "Unidad 4", "url": "https://…" } }]
//
//        `url` only when the source has one; `at` only when it is a timed
//        transcript — the second the words are said at, to open the video
//        there (ADR 0025); `page` only when it is a paged document — the
//        label of the page the words are on (ADR 0026). Given only after
//        grading, since a passage could give the answer away. Every grade
//        carries `"reviewable": true` or `false`: whether the review of the
//        task's objective (below) would show a passage.
//
// `GET /api/courses/:courseId/objectives/:objectiveId/review` — the passages
// the signed-in learner reviews an objective they answered on by (ADR 0054):
// those of its citations a person published, at most five, shaped and
// ordered as a grade's. Reading it records nothing.
//
//   401  no session
//   404  the course is not the learner's, as for the activity, or the
//        objective is not in it, or the learner has no evidence on it yet:
//        never a way to read passages before a first answer
//   204  nothing to show
//   200  `{ "title": "Greetings", "passages": [{ "quote": "…", "source": { "title": "…" } }] }`
//
// `POST /api/courses/:courseId/attempts/:attemptId/report` — the signed-in
// learner reports a problem with a task they answered, named by their attempt
// (ADR 0052), which fixes the task and the answer, so neither is sent. Body
// `{ "reason": "key-wrong", "note": "…" }`: `reason` one of `answer-correct`
// (only after a miss that was not Show answer), `key-wrong`, `confusing`,
// `unsupported`, and `other` (a note required); `note` optional, at most 500
// characters once trimmed, a blank one none. It changes nothing about the
// attempt, its evidence, or what is offered next; a task retired since is
// still reported. The learner's school reads it, without the learner's name.
//
//   401  no session
//   400  the body is not a report, or `answer-correct` names a success or
//        Show answer
//   403  the request could have been forged, as for an attempt
//   404  the course is not the learner's, as for an attempt, or the attempt
//        is not theirs there, or is of a task outside the course
//   409  `{ "error": "…", "code": "ALREADY_REPORTED" }`: the attempt's report
//        says otherwise, or the learner has an undismissed report of the task
//        from another attempt. A report is never changed.
//   413  the body is larger than 1 MB
//   201  stored: `{ "reason": "key-wrong", "note": "…", "at": "…" }`, `note`
//        only when there is one
//   200  the same report again: what is stored, dated when it first was
//
// `GET /api/courses/:courseId/learners/:learnerId/progress` — where a learner
// stands on each objective in a course, for a content owner, a teacher, or the
// learner. The reader is the session's user and must be the learner, hold
// `owner` or `admin` in the course's organization, or teach a group the learner
// learns in that takes the course (ADR 0042); the learner must belong to it. A
// learner session reads its own alone. `?includeHistory=false` leaves each
// objective's `evidence` out, for a reader showing standings only: it grows
// with every result. `historyEpoch` is the learner's history epoch here, which a
// sender of evidence names so a result it begins after this read is told from
// one begun before an erasure (learner-loop-25).
//
//   400  `includeHistory` given more than once, or as other than `true` or `false`
//   401  no session
//   404  the course does not exist; the reader is not the learner, does not
//        administer its organization, and does not teach them in it; or the
//        learner is not in it, or does not exist; or a tool reads another's
//        while the organization does not let tools read its learners' data
//        (ADR 0050). One status for all of them, so it confirms neither a
//        course nor a person to someone with no business knowing.
//   200  a knowledge report, objectives in content order, each carrying the
//        values that describe its phase:
//
//          { "modelVersion": "v1", "objectives": [
//              { "objectiveId": "…", "title": "Greetings", "phase": "unseen",
//                "evidence": [] },
//              { "objectiveId": "…", "title": "…", "phase": "acquiring",
//                "lastEvidenceAt": "2026-06-01T00:00:00.000Z",
//                "evidence": [{ "outcome": "failure", "at": "…" }] },
//              { "objectiveId": "…", "title": "…", "phase": "retaining",
//                "lastEvidenceAt": "…", "stability": 3.2,
//                "retrievability": 0.94, "due": false,
//                "dueAt": "2026-06-04T04:48:00.001Z",
//                "evidence": [{ "outcome": "success", "at": "…" }] }
//          ] }
//
//        `due` is the decision route's own rule — a retained objective it would
//        offer for review — so given the same evidence and time, the two agree.
//        `dueAt` is when that starts to hold, past or future. `evidence`, on every
//        objective unless left out, holds the outcome and time alone of each
//        result its standing was replayed from: oldest first, ties in replay's
//        order. `lastPractisedAt` is the latest attempt answered in Braivo on
//        the course's objectives, `null` if none, never a result recorded
//        elsewhere (progress-17).
//        The shape is `LearnerProgressReport` serialized, pinned like the
//        decision's.
//
// `GET /api/courses/:courseId/progress` — where each learner in a course
// stands, counted: by name, every member of its organization to a reader
// holding `owner` or `admin` there, or to a teacher of groups taking the
// course, those groups' learners, each once (ADR 0042); and each objective, in
// content order, with those learners counted. On `BRAIVO_URL`'s host alone:
// elsewhere, 401.
//
//   401  no session
//   404  the course does not exist, the reader neither administers its
//        organization nor teaches a group taking it, or a tool reads it while
//        the organization does not let tools read its learners' data (ADR
//        0050), alike
//   200  { "modelVersion": "v1", "learners": [
//          { "userId": "…", "name": "Ana", "roles": ["member"],
//            "standings": { "unseen": 1, "acquiring": 2, "retained": 0, "due": 1 } }
//        ], "objectives": [
//          { "objectiveId": "…", "title": "Greetings",
//            "standings": { "unseen": 3, "acquiring": 1, "retained": 2, "due": 0 } }
//        ] }
//
//        `roles` only to an `owner` or `admin`: a teacher's learners carry none
//        (access-26). `standings` count what each learner's report shows at
//        the same moment, per learner and per objective; `retained` is
//        retaining and not due. Each learner's `lastPractisedAt` is as in a
//        learner's report. `CourseProgressOverview` serialized.
//
// `POST /api/organizations/:organizationId/learners/:learnerId/evidence` —
// records what a learner did. The grader is the session's user and is never
// named in the request; they must hold `owner` or `admin` in the organization,
// because a learner is a `member` and would otherwise be able to grade
// themselves, and send it from a browser's session (ADR 0050). Body, at most
// 1000 records:
//
//   { "evidence": [
//       { "id": "…", "objectiveId": "…", "outcome": "success", "at": "2026-06-01T00:00:00.000Z" }
//   ], "historyEpoch": 0 }
//
// `historyEpoch`, optional, is the one the learner's report said (learner-loop-25).
// Send it: without one, a result dated within five minutes after an erasure is
// refused.
//
// `at` is exactly what `Date#toISOString` produces — UTC, with milliseconds —
// and no more than five minutes ahead of the clock when the batch is validated.
// A wrong evidence time is permanent: it reorders replay and moves every review
// that follows, and one dated ahead cannot be corrected through this API, since
// it stays invisible until its date and resending it is a conflict.
//
//   401  no session
//   400  the body is not evidence, carries more than 1000 records, names a
//        `historyEpoch` that is not a non-negative integer, dates a record more
//        than five minutes ahead, or has an `id` longer than 256
//        characters or starting with `attempt:`, which is reserved for evidence
//        graded from attempts
//   403  the request could have been forged (it must be `application/json`, and
//        any `Origin` it sends must be this installation's), a token sent
//        it (explained) or a connection did, or the grader may not grade
//        here, or the learner or an objective is not this organization's
//   413  the body is larger than 1 MB
//   409  a record's `id` already holds a different result for this learner in
//        this organization — another outcome, date, or objective. Nothing in
//        the batch is stored. IDs are the organization's own: another
//        organization's evidence under the same `id` is unrelated.
//        An evidence ID identifies one attempt's result for one objective;
//        built from the task and the objective alone it repeats on every
//        attempt, and each one after the first answers this.
//        `{ "error": "…", "code": "HISTORY_ERASED" }`: the batch's optional
//        `historyEpoch`, read from the learner's report, is not the current
//        one, or it names none and a record is dated at or before five minutes
//        past the learner's history here being erased. Nothing is stored; final.
//   204  recorded. Redelivering the same result is a no-op, so a retry answers
//        the same way and writes no second row. An empty `evidence` records
//        nothing and is checked no further than the session and origin, so its
//        204 says nothing about permission to grade.
//
// `GET /api/organizations/:organizationId/reports` — the organization's open
// reports of tasks (ADR 0052), for its `owner` or `admin` in a browser alone:
// reports neither dismissed nor of a retired task. Per task, the most recently
// reported first, at most 100 tasks, each with its 20 newest reports, newest
// first, counted and listed as of one moment; `?objectiveId=`, `?courseId=`,
// or `?taskId=`, at most one, scopes it, an objective's or a course's read
// answering every reported task, a task's its 1000 newest. No learner is named.
//
//   400  more than one scope, or an empty one
//   401  no session
//   403  not an `owner` or `admin` there, or a tool, whatever the organization
//        lets tools read (ADR 0050), explained
//   200  { "tasks": [{ "id": "…", "objectiveId": "…", "kind": "typed",
//          "prompt": "…", "accepted": ["went"], "pendingCorrectionId": "…",
//          "reportCount": 2, "reasonCount": 1, "reports": [{ "id": "…", "reason":
//          "answer-correct", "note": "…", "at": "…", "response": { "text":
//          "went." } }] }], "more": false }
//
//        Each task as authored (its body, as `…/objectives/:objectiveId/tasks`
//        reads it), `pendingCorrectionId` while a tool's correction of it
//        waits to be published, `reportCount` its open reports, one per
//        learner, `reasonCount` how many reasons they give, all of them,
//        though the reports listed are fewer; each report's `response` the attempt's, as sent, and
//        `note` only when there is one. `more` when tasks were left out.
//
// `POST /api/organizations/:organizationId/reports/dismiss`, a JSON write,
// `{ "reportIds": ["…"] }`, 1 to 1000: dismisses exactly those, so a report
// sent after the read stays open, recording who and when; one dismissed
// already keeps the first. Who as for reading them.
//
//   400  not 1 to 1000 IDs
//   401  no session
//   403  as for reading them, or the request could have been forged, or a
//        report not the organization's (nothing is dismissed then)
//   413  the body is larger than 1 MB
//   204  dismissed
//
// `GET /api/organizations/:organizationId/first-answers?courseId=…` (or
// `?objectiveId=…`, exactly one) — how learners first answered each published
// task of the course or objective (progress-18), for whoever reads reports:
// each current member's first attempt per task, at this organization through
// any course, classified by its recorded outcome, never regraded.
//
//   400  neither scope, both, or an empty one
//   401  no session
//   403  not an `owner` or `admin` there, or a tool, whatever the organization
//        lets tools read (ADR 0050), explained
//   404  the organization has no such course or objective
//   200  { "minLearners": 5, "tasks": [{ "id": "…", "objectiveId": "…",
//          "first": { "learners": 11, "correct": 2, "incorrect": 8,
//          "revealed": 1, "options": [2, 6, 2] }, "otherTasks": {
//          "responses": 13, "learners": 7, "correct": 9, "incorrect": 3,
//          "revealed": 1 } }],
//          "retired": [{ "id": "…", "objectiveId": "…", "kind": "choice", …,
//          "retiredAt": "…", "first": null }] }
//
//        `tasks`: each published, unretired task, oldest first; `first`
//        `null` under `minLearners` distinct learners, `options` a choice
//        task's first choices by authored index, reveals excluded; `otherTasks`
//        the objective's other such tasks pooled, a learner's first answer to
//        each, `null` with none or under `minLearners` learners across them.
//        `retired`, an objective's alone: its tasks retired after publishing,
//        as authored, newest retirement first, each keeping its own counts.
//        No learner is named, nor any typed answer.
//
// `GET /api/organizations` — the organizations the signed-in user
// administers (`owner` or `admin`), authors in (those or `author`, ADR 0048),
// or teaches a group in, by name: `{ "organizations": [{ "id": "…", "name":
// "…", "slug": "…", "learnDomain": "…" | null, "personal": false,
// "administers": true, "authors": true, "teaches": false, "aiEnabled": true }] }`,
// each flag on its own; `personal`, a personal organization rather than a
// school, as it was created (ADR 0060). `aiEnabled`, only where they author: whether they may have the
// installation's AI read a file's text and draft courses, there being a model
// that the organization may use (generation-9), whatever its month's
// requests. A member who does none of these is not listed. 401 without a
// session.
//
// `GET /api/memberships` — `{ "memberships": [{ "id", "name", "learnDomain" }] }`,
// every organization the signed-in user is a member of, in any role, by name,
// each with the learn domain it is named by, or `null` before one is
// registered (access-59). 401 without a session; 403 to a connection.
//
// `GET /api/organization-setup` — `{ "domain": "…" | null, "maySetUp": true
// | false, "dataRegion": "…" | null, "otherRegions": [{ "region": "…",
// "setupUrl": "…" | null }] }`: the domain an organization set up below is
// served under, `null` where only the operator creates them (ADR 0018);
// whether this account may set one up now, owning no school, as a personal
// organization counts for nothing here (ADR 0060) (`false` there); the
// region code (`EU`, `US`) where the installation stores data, `null` unsaid;
// and the regions whose own installations set up organizations, at
// `setupUrl`, `null` not yet open (ADR 0040). 401 without a session.
//
// `POST /api/organization-setup` `{ "name", "slug" }`, a JSON write — sets up
// a school the session's user owns, never a personal organization
// (`"personal": false`, ADR 0059), at `<slug>.<domain>`: 201
// `{ "organization" }` as listed above. 400 a malformed body, or `{ "error",
// "code" }` for a name or slug that cannot be one (`NAME_INVALID`,
// `ADDRESS_INVALID`, `ADDRESS_RESERVED`); 409 `{ "error", "code" }` for an
// address taken (`ADDRESS_TAKEN`) or a school the user already owns
// (`ALREADY_OWNER`); 404 where only the operator creates them; 401 without a
// session. `error` is English; a client words `code` in its own language.
// With `{ "personal": true }` alone, it sets up the session's account's
// personal organization instead (ADR 0060), a browser's session only (403 to a token or a
// connection, with an `error`): `{ "organization" }` as listed, `"personal":
// true`, `"learnDomain": null`, its slug `p-` and 16 random letters, named
// after the account; 201 made now, 200 the one it already has, so a retry
// answers the same. Owning a school neither stops it nor counts against it;
// visiting `/learn` never makes one.
//
// The organization routes below share their refusals: 401 without a session,
// and 403 unless the session holds the role there: `owner`, `admin`, or
// `author` for content, from objectives to courses (ADR 0048); `owner` or
// `admin` from renaming on, for people and settings. A plain `member` authors
// nothing, for the same reason it grades nothing. Each write adds 403 for a
// request that could have been forged, 413 for a body over 1 MB (a source's
// 10 MB, a file's 50 MB), and 400 for an invalid one, answered before the role
// is checked since that reveals nothing about the organization. Below is what
// each answers beyond that.
//
// A source, objective, course, task, or citation of the documented shape
// refused for what it says answers 400 with `{ "error": "…" }`: which item,
// what is wrong, and what would fix it — "Task 0 repeats option 0 as option 1;
// every option must differ."
// The caller is often a model drafting from a source, which can correct a
// mistake it is told about. Anything else malformed answers a bare 400.
//
// `POST /api/organizations/:organizationId/objectives` — registers learning
// targets, at most 1000:
//
//   { "objectives": [{ "title": "Greetings", "key": "es-greetings" }, { "title": "Numbers" }] }
//
// Titles are non-blank, at most 500 characters, and trimmed. Answers 201 with
// `{ "objectiveIds": [...] }`, positionally matching. IDs are opaque and
// generated, never a title. `key` is optional, the caller's own name for the
// objective, unique in the organization: 1 to 128 lowercase letters, digits,
// and `. _ / -`, starting with a letter or digit. An objective sent again
// under its key with the same title answers its ID, so a retry adds nothing;
// under a key already naming another title the batch answers 409 with an
// `error` saying which (ADR 0024). A refused title or key answers 400 with an
// `error` naming the objective.
//
// `GET /api/organizations/:organizationId/objectives` — answers
// `{ "objectives": [{ "id": "…", "title": "…", "courseIds": ["…"],
// "pendingTaskCount": 2, "pendingPassageCount": 1 }] }`, by title: the courses
// each is in, which its tasks serve, and how many of its tasks and citations
// wait for review (ADR 0039). That is
// a listing order and not content order: the sequence a learner meets
// objectives in belongs to a course.
//
// `POST /api/organizations/:organizationId/tasks` — adds tasks to objectives
// that already exist, at most 1000, citing at most 200 quotes in all:
//
//   { "tasks": [{ "objectiveId": "…", "kind": "choice", "prompt": "…",
//                 "options": ["…", "…"], "answer": 0, "explanation": "…" }] }
//
// Every task has a prompt and an optional `explanation`, shown after grading,
// each 1 to 2000 characters. A `choice` task: 2 to 26 distinct options of 1 to
// 2000 characters, `answer` the index of the correct one, and `keepOrder: true`
// to present them as written rather than shuffled — for a scale, or "all of
// the above". A `typed` task: 1 to 20 `accepted` answers of 1 to 200
// characters, distinct as compared (case, spacing, and curly or straight
// quotes aside), the first shown to a learner who missed, and an optional
// `answerLanguage`, a language tag such as "de" (ADR 0038). Any task may add
// `"citations": [{ "sourceId": "…", "quote": "…" }]`, at most 10: the passages
// it was written from, located as on the citations route and stored with the
// task. A task the objective already has, unretired — the same body and
// passages — is not added again: its ID is answered, so a retry duplicates
// nothing (ADR 0024). Answers 201 with `{ "tasks": [{ "id": "…", "added":
// true, "published": false }] }`, positionally matching: `added` false for a
// task already there, `published` whether it is published now or waits for
// Publish (ADR 0039), `replaces` for a pending correction of a
// published task, and `findings`, as a task read back carries them;
// 400 with an `error` when a task is not a valid one of
// its kind or cites a quote Braivo cannot find — "Task 1, citation 0: the
// quote does not occur in the source." — and 403 when an objective or a
// source is not this organization's. Any refusal stores nothing in the batch.
//
// Tasks are immutable. A task with `"replaces": "<taskId>"`, sent alone and for
// the replaced task's objective (else 400, explained), is that task's
// correction: stored, and the task retired, in one transaction; from a tool,
// a published task's correction instead waits beside it, answered with
// `replaces`, until Publish retires the task (ADR 0039). A correction
// equal to the task answers the task's ID, retiring nothing. Once the task is
// retired, a correction answers the task already offered that it asks for, as
// on a retry after a lost answer, and otherwise 409 with an `error`: it was
// written from a stale read. 403 when the replaced task is not this
// organization's.
//
// `POST /api/organizations/:organizationId/tasks/retire` — withdraws tasks from
// practice: `{ "taskIds": ["…"] }`, at most 1000. A retired task is never
// offered and accepts no new attempt; it is not deleted, and evidence already
// graded from it stands. Answers 204, also for a task already retired; 403 when
// any task is not this organization's or does not exist, retiring none.
//
// `GET /api/organizations/:organizationId/objectives/:objectiveId/tasks` — the
// objective's tasks still offered, oldest first, in the shape they are
// authored in, with their IDs and answers and the passages they cite:
// `{ "tasks": [{ "id": "…", "kind": "choice", "prompt": "…", "options": [...],
// "answer": 0, "citations": [{ "sourceId": "…", "start": 13, "end": 28,
// "quote": "…" }] }] }`. 404 when the organization has no such objective.
// A task with something a learner may run into as written carries
// `findings`, absent when none: advisory, computed on each read, never
// stored, each `{ "code": "typed-trailing-punctuation", "answer": "Hello.",
// "suggestion"?: "Hello" }`, `{ "code": "typed-literal-delimiters", "answer":
// "colour / color" }`, or `{ "code": "choice-correct-alike", "correct":
// "Paris", "other": "paris.", "differences": ["case", "punctuation"] }`
// (`content/findings.ts`).
//
// `GET /api/organizations/:organizationId/courses/:courseId/tasks` — the
// course's unretired tasks, all at once, in the order learners meet them:
// `{ "tasks": [...], "counts": { "published": { "total", "withoutExplanation",
// "withoutExplanationOrPassage" }, "pending": { "total", "withoutExplanation" }
// } }`, each task as an objective's listing answers it plus its `objectiveId`
// and, while published, `"pendingCorrection": { "id", "hasExplanation" }` when
// a correction waits. `?without=explanation` lists only those without one;
// `counts` cover the whole course either way. 400 for any other `without`; 404
// when the organization has no such course.
//
// `POST /api/organizations/:organizationId/courses` — creates a course over
// objectives that already exist. Body `{ "title": "…", "objectiveIds": [...] }`,
// the objectives at most 1000; position in that list is content order, and
// that list is what selection chooses from. A title refused as for objectives,
// or an objective listed twice, answers 400 with an `error`. Answers 201 with
// `{ "courseId": "…", "added": true, "published": false }`, or 403 when an
// objective is not this organization's — also the answer for one that does
// not exist, so neither confirms the other's.
// An optional `key` works as for objectives: the same course again — title and
// objectives in the same order — answers it, `added` false, published or not
// as it stands, and another under the same key answers 409 with an `error`,
// as does any under the key of a course since deleted.
//
// `GET /api/organizations/:organizationId/courses` — answers
// `{ "courses": [{ "id": "…", "title": "…" }] }`, by title.
//
// `GET /api/organizations/:organizationId/courses/:courseId` — one course as
// authored, for reviewing it whole: `{ "id", "title", "objectives": [{ "id",
// "title", "citations": [...], "tasks": [...] }], "sources": [...] }`, the
// objectives in the order learners meet them, each with its citations as
// `GET …/objectives/:objectiveId/citations` answers them and its tasks as
// `GET …/objectives/:objectiveId/tasks` does, answers included; `sources`
// lists each source those cite once, as the sources listing does. 404 when the
// organization has no such course.
//
// `POST /api/organizations/:organizationId/courses/:courseId/delete` — deletes
// an unpublished course (ADR 0039): its place in courses and groups goes, its
// objectives and tasks stay, and its key and number are never taken again.
// 204, also when deleted already; 409 with an `error` for a published course;
// 404 when the organization has no such course; 403 to a request carrying a
// token, explained.
//
// `POST /api/organizations/:organizationId/courses/:courseId/visibility`
// `{ "hidden": true }` — hides a published course from learners, or with
// `false` shows it again (ADR 0039): hidden, it reaches learners as an
// unpublished one does, not at all, while it stays published and their
// evidence stays. 204, also when it already was; 409 with an `error` for
// hiding an unpublished course; 404 when the organization has no such course;
// 403 to a request carrying a token, explained.
//
// `POST /api/organizations/:organizationId/rename` `{ "name" }` — renames the
// organization, its name trimmed: 200 `{ "name" }` as stored. 400 `{ "error",
// "code": "NAME_INVALID" }` for one blank, over 100 characters, or holding NUL.
//
// `GET /api/organizations/:organizationId/tools-read-learner-data` — whether
// tools read the organization's learners' data (ADR 0050): `{ "allowed":
// false, "changedBy": { "userId", "name" } | null, "changedAt": "…" | null
// }`, who last changed it, `null` before the first change or once their
// account is gone, and when, `null` until first changed. `POST` with `{
// "allowed": true }` sets it, answering the same; setting the value it has
// changes nothing, who and when included. Both to an `owner` or `admin`, 403
// to anyone else, and to a request carrying a token, explained: a tool cannot
// grant itself access, and the answer names a person.
//
// `GET /api/organizations/:organizationId/members` — answers
// `{ "members": [{ "userId": "…", "name": "…", "roles": ["member"] }] }`, by
// name, every role a member holds. No emails: the roster's clients need only
// names and roles. 403 to a tool, too, while the organization does not let
// tools read its learners' data (ADR 0050).
//
// `POST /api/organizations/:organizationId/members/:userId/remove` — removes
// a member: 204. They leave the organization's groups; their learning history
// stays. `POST …/members/:userId/role` `{ "role" }` — sets their roles to
// exactly `member` (a learner), `author`, or `admin`: 200 `{ "member": {
// "userId", "name", "roles" } }`, 400 `ROLE_NOT_ASSIGNABLE` for another role.
// Both: 404 `MEMBER_NOT_FOUND`; 409 `MEMBER_IS_OWNER`, whoever holds `owner`, or `OWN_MEMBERSHIP`,
// one's own membership; 403 to anyone but an `owner` or `admin`, and to a tool.
//
// `POST /api/organizations/:organizationId/invitations` `{ "emails": ["…"],
// "role" }` — invites up to 100 addresses, each trimmed and lowercased,
// repeats dropped, as `member` (a learner), `author`, or `admin`, for 7 days,
// mailing each the link `<origin>/invitations/<id>` in the language
// `Accept-Language` weighs highest (ADR 0018): 200 `{ "results": [...],
// "membersLeft" }`, a result per address in order: `{ "email", "outcome":
// "invited", "invitation": { "id", "email", "role", "expiresAt" }, "emailSent"
// }`, `emailSent` false when it was stored but its mail could not be sent in
// time; `"already a member"` with the member's `roles`; `"already invited"`
// with the pending invitation's `role`, which stays; `"refused"` with a
// `code`, `EMAIL_INVALID`, `PENDING_LIMIT` (past 1,000 waiting), or a mail
// bound (`RECIPIENT_DAILY_LIMIT`, `RECIPIENT_COOLDOWN`,
// `ORGANIZATION_HOURLY_LIMIT`); or `"failed"`, to try again. `membersLeft`:
// how many more members fit, invitations holding no places. Refused whole,
// inviting no one: 400 `{ "error", "code" }`, `EMAILS_INVALID`,
// `TOO_MANY_ADDRESSES`, or `ROLE_NOT_INVITABLE` (`owner` included); 409
// `NO_LEARN_DOMAIN`, learners while the organization has no learn domain, and
// `PERSONAL_ORGANIZATION`, anyone to a personal organization (access-60). 403
// to anyone but an `owner` or `admin`, and to a tool, also once the actor is
// no longer one partway through, no further address then tried (401 when
// the session ended partway); 429 past 60 requests a minute from one client.
//
// `POST /api/organizations/:organizationId/invitations/:invitationId/resend`
// — mails a pending invitation again, within the mail bounds: the same link
// and role, its expiry renewed, the resender named; one expired meanwhile is
// invited anew. 200 as one `"invited"` result above. 404
// `INVITATION_NOT_FOUND`; 409 `NOT_PENDING` (accepted or cancelled),
// `NO_LEARN_DOMAIN`, `PERSONAL_ORGANIZATION`, or, for one expired, `ALREADY_MEMBER` with `roles`,
// `ALREADY_INVITED` with `role`, or `PENDING_LIMIT`; 429 a mail bound, by its
// code, or the client limit; 403 as for inviting.
//
// `GET /api/organizations/:organizationId/invitations` — the invitations
// waiting to be accepted, newest first, and `membersLeft` as above: `{
// "invitations": [{ "id", "email", "role", "inviter": { "name" }, "expiresAt"
// }], "expired": […], "membersLeft" }`, `expired` in the same shape, each
// address's latest invitation when it expired unaccepted and the address is
// not a member, at most 100. 403 as for inviting.
//
// `POST …/invitations/:invitationId/cancel` — cancels a pending invitation,
// expired or not: 200 `{ "invitation": { "id", "status": "canceled" } }`. 404
// `INVITATION_NOT_FOUND`; 409 `INVITATION_ACCEPTED`, acceptance having come
// first and made the member, `INVITATION_ACCEPTING`, claimed by an acceptance
// with no member yet, or `INVITATION_CANCELED`. 403 as for inviting.
//
// `GET /api/invitations/:invitationId` — an invitation as its page shows it,
// with or without a session: `{ "organization": { "name" }, "status" }`,
// `status` `pending`, `expired`, `canceled`, or `accepted`; with a session,
// `recipient`, whether the account's email is the invitation's, and to the
// recipient alone the organization's `slug`, the `role`, and the `inviter`'s
// `{ "name" }`, `member`, whether they are one there, by this invitation or
// another way, and if so `continueTo`, where they go on as they are now, not
// as invited: `console` or `learn`; and `learnDomain`, the hostname to
// continue on, `null` while there is none, for a member who continues to
// `learn` or a non-member invited as a learner. Never the email. 404 for one that
// does not exist; 403 to a tool. Accepting is Better Auth's `POST
// /api/auth/organization/accept-invitation` `{ "invitationId" }`, for a
// verified account with the invited email alone, a learner's only while the
// organization has a learn domain (403 `NO_LEARN_DOMAIN`, still pending), none
// to a personal organization (403 `PERSONAL_ORGANIZATION`, still pending).
//
// `GET /api/organizations/:organizationId/groups` — the organization's groups,
// by name: `{ "groups": [{ "id", "organizationId", "name", "learners": [{
// "userId", "name" }], "teachers": [...], "courses": [{ "id", "title" }] }]
// }`, people by name and courses by title. Every group to an `owner` or
// `admin`; to any other member those they teach, none if they teach none:
// what a teacher may read through the progress routes above. 403 to anyone
// who is not a member, and to a tool as for members.
//
// `POST /api/organizations/:organizationId/groups` — creates a group: `{
// "name", "learnerIds": [...], "teacherIds": [...], "courseIds": [...] }`,
// each list at most 1000, with an optional `key` as for courses: the same
// creation again, its lists in any order, answers its ID even if the group
// changed since; another under the key 409 with an `error`. Answers 201 `{
// "groupId" }`. A name refused as a course's title is, an ID listed twice, one
// person in both roles, someone not a member, or a course not the
// organization's answers 400 with an `error`; a field it does not know, 400.
//
// `POST /api/organizations/:organizationId/groups/:groupId` — changes a group
// by what the body names, each part optional: `{ "name", "add": {
// "learnerIds", "teacherIds", "courseIds" }, "remove": { "userIds",
// "courseIds" } }`. Removals apply first, then additions: removing someone
// and adding them in one change sets their role, and adding someone already
// there in the other role is 409 with an `error`, never a silent promotion.
// Adding what is there or removing what is not does nothing. Concurrent
// changes apply in turn, the last one's word final. 200 `{ "group" }`, as
// listed, as it then stands; 404 when the organization has no such group.
// Refused as creating one is, and a change naming nothing is 400 with an
// `error`; a field it does not know, 400, as a misspelt one would otherwise
// change nothing. 403 to a tool as for members, before anything about the
// organization's people or groups is checked.
//
// `GET /api/organizations/:organizationId/domains` — answers `{ "domains":
// [{ "hostname", "removable" }], "claims": [{ "hostname", "status" }],
// "canAdd" }`: the hostnames serving its learn app, newest first, the first
// naming its learn domain, each `removable` as `…/remove` allows; those it
// claimed, each expiring seven days on unless activated, newest first, each
// `status` `{ "ready", "records": [{ "type", "name", "value" }] }` as the
// provisioner reads it now, or `null` when it cannot; and whether this
// installation has a provisioner (ADR 0038), never for a personal organization,
// which takes no learn domain (ADR 0059).
//
// `POST /api/organizations/:organizationId/domains` `{ "hostname" }` — claims
// a hostname, asking the provisioner to serve it once proven: 201 `{ "claim" }`
// as listed above, again for a hostname this organization claimed already.
// 400 `{ "error", "code" }` for one that cannot be a learn domain
// (`DOMAIN_INVALID`) or is the installation's (`DOMAIN_RESERVED`); 409 for one
// another organization holds (`DOMAIN_TAKEN`) or this one serves
// (`ALREADY_ADDED`), and for a personal organization (`PERSONAL_ORGANIZATION`, ADR
// 0059), storing no claim and asking no provisioner; 502
// `PROVISIONING_FAILED`, the claim kept, which
// claiming again retries; 501 where the installation has no provisioner.
//
// `POST /api/organizations/:organizationId/domains/:hostname/activate`, a JSON
// write — makes a claimed hostname serve the learn app, as the organization's
// primary domain, once the provisioner reports it ready: 204, also for one
// serving it already, left as it is. 409 `{ "error", "code": "NOT_VERIFIED",
// "status" }` while not ready, `status` as listed above; 409
// `PERSONAL_ORGANIZATION` for a personal organization, asking nothing; 404 for a
// hostname the organization has not claimed, or whose claim expired; 502
// `PROVISIONING_FAILED`; 501 where the installation has no provisioner.
//
// `POST /api/organizations/:organizationId/domains/:hostname/remove`, a JSON
// write — removes a domain serving the organization, or its claim to one: it
// stops serving at once, learner sessions there with it, then the provisioner
// is told to forget that claim alone (a domain the operator registered,
// nothing): 204, its failure logged, what it holds then its own to sweep. 409
// `{ "error", "code" }` for the installation's own (`DOMAIN_RESERVED`) or the
// only domain serving it (`LAST_DOMAIN`); 404 for a hostname the organization
// does not hold; 501 where the installation has no provisioner.
//
// `POST /api/organizations/:organizationId/sources` — adds material a content
// owner provides, as text:
//
//   { "title": "Unidad 1", "text": "# Saludos\n…",
//     "url": "https://www.youtube.com/watch?v=…", "language": "es" }
//
// Extracting the text — a PDF's, or a video's transcript — is the caller's job
// (ADR 0020), or `POST …/files/:fileId/text`'s. `url` is where the text came
// from when that is a link, kept instead of a copy; `language` is the text's
// main language as a BCP 47 tag. Both are optional, left out by being absent,
// and stored canonical: `es-mx` as `es-MX`. The title is trimmed; the text is
// stored in NFC with `\n` line endings and otherwise as sent, since citations
// address it by position. A source is immutable: a revision is another source,
// and adding one the organization already has — the same title, text, link,
// language, and original — returns that one, so a retry duplicates nothing
// (ADR 0024). Answers 201 with `{ "sourceId": "…" }` either way, or 400 with an
// `error` when the title is blank or over 500 characters, the text is blank or
// carries a NUL or an unpaired surrogate, `url` is not an `http` or `https` URL
// without credentials of at most 2048 characters, or `language` is not a
// language tag.
//
// A recording may be sent as its captions instead of `text` — never both:
//
//   { "title": "Los animales", "url": "https://www.youtube.com/watch?v=…",
//     "cues": [{ "at": 0, "text": "Hola, amigos." }, { "at": 62.5, "text": "El perro dice guau." }] }
//
// Braivo puts each cue's words on a line of its own as the source's text, and
// keeps the source's `timing`, where each line starts and when it is said, so a
// passage cited from it names its moment (ADR 0025). `at` is seconds from 0 to
// 86400, in order; at most 100,000 cues, each with words. A cue refused for
// what it says answers 400 with an `error` naming it.
//
// A document — a book, a worksheet — may be sent as its pages instead:
//
//   { "title": "Mi primer libro", "language": "es",
//     "pages": [{ "page": "11", "text": "Hola significa hello." }, { "page": "12", "text": "…" }] }
//
// Braivo joins the pages, a blank line apart, as the source's text, and keeps
// its `pagination`, where each page starts and its label, so a passage cited
// from it names its page (ADR 0026). `page` is the label as printed — `12`,
// `iv` — of at most 16 characters; pages stay in the order sent, at most
// 10,000, each with words. `text`, `cues`, and `pages`: exactly one.
//
// `GET /api/organizations/:organizationId/sources` — answers
// `{ "sources": [{ "id": "…", "title": "…", "url": "…", "language": "es",
// "original": "<sha256>", "createdAt": "…" }] }`, by title and without text.
// `url`, `language`, and `original` are present only when the source has them.
//
// `GET /api/organizations/:organizationId/sources/:sourceId` — the same shape
// with `text`, and for a transcript sent as cues its `timing`:
// `[{ "start": 0, "at": 0 }, { "start": 14, "at": 62.5 }]`, or for a document
// sent as pages its `pagination`: `[{ "start": 0, "page": "11" }, …]`,
// positions in code points, and `original` when it has one. 404 when the
// organization has no such source.
//
// `?pages=12-16`, `?seconds=60-300`, or `?characters=20000-40000` (one; `12-`
// reads on to the end) reads part of it instead, for an agent that cannot take
// a whole book in one answer: pages by position from 1, both ends included;
// seconds from the cue being said at the first; characters in code points.
// Answers the source as listed with at most 20,000 characters of its `text`,
// their `start` and `end`, the whole text's `length`, and the `timing` or
// `pagination` entries they overlap, all in the whole text's positions; when
// what was asked runs on, `next`, such as `{ "characters": "19742-48589" }`,
// to ask next. A range the source cannot answer — page 40 of 30, pages of a
// source without them — answers 400 with an `error` saying what it can.
//
// Any source may also name its `original`, the file its text was extracted
// from, by the `fileId` uploading it answered (below); a source naming another
// is another source (ADR 0028). 400 explains an original that is not one of
// the organization's files.
//
// `POST /api/organizations/:organizationId/sources/:sourceId/draft` — a course
// drafted from the source by the installation's model, for review; nothing is
// stored (ADR 0029). Body `{ "goal": "order food politely", "audience": "grade 2,
// English speakers", "instructionLanguage": "en" }`: the language of titles,
// prompts, and explanations a BCP 47 tag, required; the goal, 1 to 300
// characters, and the audience, at most 200, optional. They describe the
// purpose and the learners to the model, and tasks still come only from the
// source. Slow: the model reads the whole source. Answers 200 with
//
//   { "objectives": [{ "key": "<random, for this draft>", "title": "Say hello",
//       "citations": [{ "sourceId": "…", "quote": "…" }],
//       "tasks": [{ "kind": "choice", "prompt": "…", "options": [...], "answer": 0,
//                   "citations": [...] }] }],
//     "refused": [
//       "Objective “Say hello”, task “Hola?”: the quote “Hola, amigo.” does not occur in the source."
//     ] }
//
// in the shapes the objective, citation, and task routes take, so accepting it
// is sending them. Every objective and task kept cites a passage found in the
// source; `refused` names what the model proposed that Braivo would not
// accept. Both may be empty: the model proposed nothing. Each refusal carries
// an `error`: 400 for a source over 200,000 characters, an audience long or not
// text, a goal blank, long, or not text, or a language missing or not a tag;
// 403 `code` `AI_NOT_ENTITLED` when `BRAIVO_AI_ORGANIZATIONS` is set and does not list the organization; 429,
// with `Retry-After`, when it has made its month's requests under
// `BRAIVO_AI_MONTHLY_LIMIT` (ADR 0031), each valid request counting, answered
// or not; 501 `code` `AI_UNAVAILABLE` when the installation has no model
// (`ANTHROPIC_API_KEY` unset); 502 when the model failed. 404, bare, when the
// organization has no such source.
//
// `POST /api/organizations/:organizationId/files` — keeps a file, the request's
// body, as its `Content-Type`: `application/pdf`, `image/png`. At most 50 MB.
// Answers 201 with
// `{ "fileId": "<sha256>", "contentType": "application/pdf", "size": 48213 }`;
// the same bytes again answer the same, stored once. 400 explains an empty
// file or a `Content-Type` that is not a media type. No `Content-Type`, or a
// form's or `text/plain`, which another site's page could send, answers 403,
// as does an `Origin` other than the installation's. 501 with an `error` when
// the installation keeps no files (`BRAIVO_FILES` unset).
//
// `POST /api/organizations/:organizationId/files/:fileId/text` — the file's
// words, page by page, read by the installation's model (ADR 0030):
// `{ "pages": [{ "page": "12", "text": "…" }] }`, labelled as printed, for
// `POST …/sources` as `pages` with the file as `original`. Nothing is stored.
// Body `{}`. A PDF of at most 24 MB, or a PNG, JPEG, GIF, or WebP image of at
// most 7.5 MB; anything else is a 400 saying so. Otherwise as drafting — 403,
// 429, 501, and 502 explained, 403 and 501 coded, counted against the same
// monthly limit — plus 501, uncoded and answered first, when the installation
// keeps no files, and 404 when the organization has no such file.
//
// `GET /api/organizations/:organizationId/files/:fileId` — the file's bytes as
// its type, always as a download (`Content-Disposition: attachment`). 404 when
// the organization has no such file; 501 when the installation keeps no files.
//
// `POST /api/organizations/:organizationId/citations` — links objectives to the
// passages of sources that teach them. Body, at most 200:
//
//   { "citations": [{ "objectiveId": "…", "sourceId": "…", "quote": "uno, dos, tres." }] }
//
// Braivo locates each quote in its source: whitespace matches any whitespace,
// everything else exactly, and a quote must occur exactly once and be at most
// 2000 characters, not counting extra whitespace. All or nothing, and a
// citation already stored is stored once. Answers 200 with where each quote
// was found, in code points:
//
//   { "citations": [{ "objectiveId": "…", "sourceId": "…", "start": 13, "end": 28 }] }
//
// or 400 with `{ "error": "Citation 0: the quote does not occur in the source." }`
// naming the first citation it refused and why. 403 when an objective or a
// source is not this organization's.
//
// `GET /api/organizations/:organizationId/objectives/:objectiveId/citations` —
// answers `{ "citations": [{ "sourceId": "…", "start": 13, "end": 28,
// "quote": "…" }] }`, by source and position, or 404 when the organization has
// no such objective.
//
// Every answer under `/api`, a refusal, a 404, or a 500 included, carries
// `Cache-Control: private, no-store`: most answer differently per cookie or per
// host, and none is meant for a shared cache.

export type { Api } from "./app.ts";
export { createApi } from "./app.ts";
