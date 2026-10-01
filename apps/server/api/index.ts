// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// HTTP entry point to `application`. Only the endpoints and shapes documented
// here are public contracts; everything else is an internal detail.
// Why Hono, and what a route may do: docs/adr/0010-hono-http-layer.md.
//
// `/api/auth/*` — Better Auth's own surface, mounted per ADR 0006.
//
// `BRAIVO_URL`'s host is the console's and its tools'. On any other — an
// organization's learn domain — sign-up (until ADR 0018 replaces it), the
// device flow, and every `/api/organizations…` route answer 404, and any
// request carrying `Authorization` 401 (ADR 0004, ADR 0022).
//
// `GET /api/organization` — the organization the request's host serves, for the
// learn app on that domain to present itself as. No session needed. 200 answers
// `{ "name": "…" }`; 404 means the host serves no organization. The host is the
// request's `Host`, so a router in front forwards it unchanged (ADR 0004).
//
// Every `/api/courses/:courseId/…` route below answers 404, as for a course that
// does not exist, when the request's host may not reach the course: on an
// organization's domain, another organization's course; on a host that is
// neither that nor `BRAIVO_URL`'s, any course.
//
// A session is a cookie from a browser, or `Authorization: Bearer <token>` from
// a content owner's own tools, which get the token through the device flow
// under `/api/auth/device/*` as client `braivo-cli` (ADR 0022). Every route
// below treats the two alike: "no session" means neither was sent, or it has
// expired. A JSON write needs `application/json`, and an `Origin`, if sent,
// must be the host's own. Of `/api/auth/*`, a token reaches only `get-session`
// and `organization/list`, anything else answering 403, and its responses
// carry no `set-cookie` or `set-auth-token`.
//
// `GET /api/courses/:courseId/next` — what the signed-in learner should do next
// in a course. The learner is the session's user; the request never names one.
//
//   401  no session
//   404  the course does not exist, or belongs to an organization the learner
//        is not in. One status for both, deliberately: singling out the second
//        would enumerate other organizations' courses one guess at a time.
//   204  caught up — the course is theirs and nothing in it needs attention
//        now, a course with no objectives yet included. Only an entitled
//        learner reaches this, so telling it apart from 404 discloses nothing.
//   200  a learning decision. Always `objectiveId`, `modelVersion` and
//        `intent`, plus the values that intent was decided on:
//
//          { "objectiveId": "…", "modelVersion": "v1", "intent": "introduce" }
//          { …, "intent": "reteach", "lastEvidenceAt": "2026-06-01T00:00:00.000Z" }
//          { …, "intent": "review", "retrievability": 0.35, "stability": 1 }
//
//        Dates are ISO 8601 strings. The shape is the serialization of
//        `LearningDecision`, so a rename inside `learning` reshapes the
//        response; `app.test.ts` pins it so that cannot happen quietly.
//
// `GET /api/courses` — the courses the signed-in learner may study: every course
// of every organization they belong to, by title. On an organization's domain,
// only that organization's; on a host that is neither that nor `BRAIVO_URL`'s,
// none.
// 401 without a session; otherwise 200 with
// `{ "courses": [{ "id": "…", "title": "…" }] }`, possibly empty.
//
// `GET /api/courses/:courseId/activity` — the learner loop for learners Braivo
// serves: the next objective, with a task to practise it or, while its tasks
// rest, when to ask again. Statuses as for `next`,
// except that only objectives with a task are considered, so 204 also means the
// course has nothing to practise yet. When a task is available, 200 answers the
// decision, its objective, and the task, never the task's answer:
//
//   { "decision": { "objectiveId": "…", "modelVersion": "v1", "intent": "introduce" },
//     "objective": { "id": "…", "title": "Greetings" },
//     "task": { "id": "…", "kind": "choice", "prompt": "…",
//               "options": [{ "choice": 1, "text": "…" }, { "choice": 0, "text": "…" }] } }
//
// Options come shuffled unless the author kept their order, so a learner cannot
// rely on where the answer was last time. Show them as given and answer with
// the option's `choice`. A reload keeps the order; each accepted answer reseeds it.
//
// A task rests for ten minutes after Braivo accepts an answer to it, because
// the grade reveals the answer. When every task for the decision is resting,
// 200 answers the objective and in how many seconds to ask again: whole
// seconds, rounded up, and a duration rather than a date, so the client's clock
// does not matter. No decision: it may no longer hold when the rest ends.
//
//   { "objective": { "id": "…", "title": "Greetings" }, "retryAfter": 540 }
//
// `POST /api/courses/:courseId/attempts` — the signed-in learner answers a task,
// and Braivo grades it and records the evidence. Body
// `{ "id": "…", "taskId": "…", "response": { "choice": 1 } }`, where `choice` is
// the option's, as the activity gave it. `id` is the client's, unique per
// learner within the course's organization, at most 128 characters (a UUID
// will do). Mint it once per answer,
// and when delivery is uncertain (a network error, a 5xx) resend that same ID:
// the resend records nothing twice and answers the same grade, where a fresh ID
// would record it again. A 409 is not such a case.
//
//   401  no session
//   400  the body is not an attempt, `id` is empty or too long, or the response
//        cannot answer the task
//   403  the request could have been forged, as for evidence
//   404  the course does not exist, is not the learner's, or has no such task,
//        or the task was retired (a resend of an attempt recorded before that
//        still answers its grade)
//   409  `id` was already used at this organization for a different task or
//        response, or the
//        learner answered this task in another attempt less than ten minutes
//        ago. Either way, ask for the activity again rather than resending.
//   413  the body is larger than 1 MB
//   200  the grade: `{ "outcome": "failure", "correctChoice": 0, "explanation": "…" }`,
//        `correctChoice` the correct option's `choice`, `explanation` present
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
//        grading, since a passage could give the answer away.
//
// `GET /api/courses/:courseId/learners/:learnerId/progress` — where a learner
// stands on each objective in a course, for a content owner or the learner. The
// reader is the session's user and must be the learner, or hold `owner` or
// `admin` in the course's organization; the learner must belong to it.
//
//   401  no session
//   404  the course does not exist; the reader is neither the learner nor
//        administers its organization; or the learner is not in it, or does
//        not exist. One status for all of them, so it confirms neither a
//        course nor a person to someone with no business knowing.
//   200  a knowledge report, objectives in content order, each carrying the
//        values that describe its phase:
//
//          { "modelVersion": "v1", "objectives": [
//              { "objectiveId": "…", "title": "Greetings", "phase": "unseen" },
//              { "objectiveId": "…", "title": "…", "phase": "acquiring",
//                "lastEvidenceAt": "2026-06-01T00:00:00.000Z" },
//              { "objectiveId": "…", "title": "…", "phase": "retaining",
//                "lastEvidenceAt": "…", "stability": 3.2,
//                "retrievability": 0.94, "due": false }
//          ] }
//
//        `due` is the decision route's own rule — a retained objective it would
//        offer for review — so given the same evidence and time, the two agree.
//        The shape is `LearnerProgressReport` serialized, pinned like the
//        decision's.
//
// `POST /api/organizations/:organizationId/learners/:learnerId/evidence` —
// records what a learner did. The grader is the session's user and is never
// named in the request; they must hold `owner` or `admin` in the organization,
// because a learner is a `member` and would otherwise be able to grade
// themselves. Body, at most 1000 records:
//
//   { "evidence": [
//       { "id": "…", "objectiveId": "…", "outcome": "success", "at": "2026-06-01T00:00:00.000Z" }
//   ] }
//
// `at` is exactly what `Date#toISOString` produces — UTC, with milliseconds —
// and no more than five minutes ahead of the clock when the batch is validated.
// A wrong evidence time is permanent: it reorders replay and moves every review
// that follows, and one dated ahead cannot be corrected through this API, since
// it stays invisible until its date and resending it is a conflict.
//
//   401  no session
//   400  the body is not evidence, carries more than 1000 records, dates a
//        record more than five minutes ahead, or has an `id` longer than 256
//        characters or starting with `attempt:`, which is reserved for evidence
//        graded from attempts
//   403  the request could have been forged (it must be `application/json`, and
//        any `Origin` it sends must be this installation's), or the grader may
//        not grade here, or the learner or an objective is not this
//        organization's
//   413  the body is larger than 1 MB
//   409  a record's `id` already holds a different result for this learner in
//        this organization — another outcome, date, or objective. Nothing in
//        the batch is stored. IDs are the organization's own: another
//        organization's evidence under the same `id` is unrelated.
//        An evidence ID identifies one attempt's result for one objective;
//        built from the task and the objective alone it repeats on every
//        attempt, and each one after the first answers this.
//   204  recorded. Redelivering the same result is a no-op, so a retry answers
//        the same way and writes no second row. An empty `evidence` records
//        nothing and is checked no further than the session and origin, so its
//        204 says nothing about permission to grade.
//
// `GET /api/organizations` — the organizations the signed-in user manages
// (`owner` or `admin`, not `member`), by name:
// `{ "organizations": [{ "id": "…", "name": "…", "slug": "…" }] }`. 401 without
// a session.
//
// The organization routes below share their refusals: 401 without a session,
// and 403 unless the session holds `owner` or `admin` there — authoring is a
// content-owner act for the same reason grading is. Each write adds 403 for a
// request that could have been forged, 413 for a body over 1 MB (a source's
// 10 MB, a file's 50 MB), and 400 for an invalid one, answered before the role
// is checked since that reveals nothing about the organization. Below is what
// each answers beyond that.
//
// A source, task, citation, or key of the documented shape refused for what it
// says answers 400 with `{ "error": "…" }`: which item, what is wrong, and what
// would fix it — "Task 0 repeats option 0 as option 1; every option must differ."
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
// `error` saying which (ADR 0024). A malformed key answers 400 with an `error`.
//
// `GET /api/organizations/:organizationId/objectives` — answers
// `{ "objectives": [{ "id": "…", "title": "…" }] }`, by title. That is a listing
// order and not content order: the sequence a learner meets objectives in
// belongs to a course.
//
// `POST /api/organizations/:organizationId/tasks` — adds tasks to objectives
// that already exist, at most 1000, citing at most 200 quotes in all:
//
//   { "tasks": [{ "objectiveId": "…", "kind": "choice", "prompt": "…",
//                 "options": ["…", "…"], "answer": 0, "explanation": "…" }] }
//
// `choice` is the only kind: a prompt and 2 to 26 distinct options, `answer`
// the index of the correct one, `explanation` optional and shown after
// grading, each text 1 to 2000 characters, and `keepOrder: true` to present
// the options as written rather than shuffled — for a scale, or "all of the
// above". Any task may add `"citations": [{ "sourceId": "…", "quote": "…" }]`,
// at most 10: the passages it was written from, located as on the citations
// route and stored with the task. Tasks are immutable: to correct one, add
// another and retire the wrong one. A task the objective already has,
// unretired — the same body and passages — is not added again: its ID is
// answered, so a retry duplicates nothing (ADR 0024). Answers 201 with
// `{ "taskIds": [...] }`, positionally matching; 400 with an `error` when a
// task is not a valid one of its kind or cites a quote Braivo cannot find —
// "Task 1, citation 0: the quote does not occur in the source." — and 403 when
// an objective or a source is not this organization's. Either refusal stores
// nothing in the batch.
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
//
// `POST /api/organizations/:organizationId/courses` — creates a course over
// objectives that already exist. Body `{ "title": "…", "objectiveIds": [...] }`,
// the title non-blank and at most 500 characters, the objectives at most 1000
// and each appearing once; position in that list is content order, and that
// list is what selection chooses from. Answers 201 with
// `{ "courseId": "…" }`, or 403 when an objective is not this organization's —
// also the answer for one that does not exist, so neither confirms the other's.
// An optional `key` works as for objectives: the same course again — title and
// objectives in the same order — answers its ID, and another under the same
// key answers 409 with an `error`.
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
// Any source may also name its `original`, the file its text was extracted
// from, by the `fileId` uploading it answered (below); a source naming another
// is another source (ADR 0028). 400 explains an original that is not one of
// the organization's files.
//
// `POST /api/organizations/:organizationId/sources/:sourceId/draft` — a course
// drafted from the source by the installation's model, for review; nothing is
// stored (ADR 0029). Body `{ "audience": "grade 2, English speakers" }`, the
// audience optional and at most 200 characters. Slow: the model reads the
// whole source. Answers 200 with
//
//   { "objectives": [{ "key": "<random, for this draft>", "title": "Say hello",
//       "citations": [{ "sourceId": "…", "quote": "…" }],
//       "tasks": [{ "kind": "choice", "prompt": "…", "options": [...], "answer": 0,
//                   "citations": [...] }] }],
//     "refused": ["Objective 0, task 1, quote 0: the quote does not occur in the source."] }
//
// in the shapes the objective, citation, and task routes take, so accepting it
// is sending them. Every objective and task kept cites a passage found in the
// source; `refused` names what the model proposed that Braivo would not
// accept. Each refusal carries an `error`: 400 for a source over 200,000
// characters or a long audience; 403 when `BRAIVO_AI_ORGANIZATIONS` is set and
// does not list the organization; 429, with `Retry-After`, when it has made its
// month's requests under `BRAIVO_AI_MONTHLY_LIMIT` (ADR 0031), each valid
// request counting, answered or not; 501 when the installation has no model
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
// most 3.75 MB; anything else is a 400 saying so. Otherwise as drafting — 403,
// 429, 501, and 502 explained, counted against the same monthly limit — plus
// 501 when the installation keeps no files and 404 when the organization has
// no such file.
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
// 2000 characters. All or nothing, and a citation already stored is stored
// once. Answers 200 with where each quote was found, in code points:
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
// Every GET above answers `Cache-Control: private, no-store`, since each one
// answers differently per cookie or per host; so does a 500 raised after the
// route set it, because Hono's default error response keeps the headers already
// on the context. Braivo's writes set none: nothing caches a POST unasked.

export type { Api, ApiOptions } from "./app.ts";
export { createApi } from "./app.ts";
