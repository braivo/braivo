// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// HTTP entry point to `application`. Only the endpoints and shapes documented
// here are public contracts; everything else is an internal detail.
// Why Hono, and what a route may do: docs/adr/0010-hono-http-layer.md.
//
// `/api/auth/*` — Better Auth's own surface, mounted per ADR 0006.
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
// of every organization they belong to, by title.
// 401 without a session; otherwise 200 with
// `{ "courses": [{ "id": "…", "title": "…" }] }`, possibly empty.
//
// `GET /api/courses/:courseId/activity` — the learner loop for learners Braivo
// serves: the next objective and a task to practise it. Statuses as for `next`,
// except that only objectives with a task are considered, so 204 also means the
// course has nothing to practise yet. 200 answers the decision with a task,
// never its answer:
//
//   { "decision": { "objectiveId": "…", "modelVersion": "v1", "intent": "introduce" },
//     "task": { "id": "…", "kind": "choice", "prompt": "…", "options": ["…", "…"] } }
//
// A task rests for ten minutes after the learner answers it, since grading
// showed them the answer. When every task for the decision is resting, 200
// answers the decision with in how many seconds to ask again, instead of a
// task — a duration, like `Retry-After`, so the client's clock does not matter:
//
//   { "decision": { … }, "retryAfter": 540 }
//
// `POST /api/courses/:courseId/attempts` — the signed-in learner answers a task,
// and Braivo grades it and records the evidence. Body
// `{ "id": "…", "taskId": "…", "response": { "choice": 1 } }`. `id` is the
// client's, unique per learner, at most 128 characters (a UUID will do). Mint it
// once per answer and reuse it on every retry: a retry then records nothing
// twice and answers the same grade, where a fresh ID would record it again.
//
//   401  no session
//   400  the body is not an attempt, `id` is empty or too long, or the response
//        cannot answer the task
//   403  the request could have been forged, as for evidence
//   404  the course does not exist, is not the learner's, or has no such task
//   409  `id` was already used for a different task or response
//   413  the body is larger than 1 MB
//   429  the learner answered this task in another attempt less than ten
//        minutes ago; `Retry-After` says in how many seconds it may be answered
//   200  the grade: `{ "outcome": "failure", "answer": 0, "explanation": "…" }`,
//        `explanation` present only when the task has one.
//
// `GET /api/courses/:courseId/learners/:learnerId/progress` — where a learner
// stands on each objective in a course, for a content owner. The reader is the
// session's user and must hold `owner` or `admin` in the course's organization;
// the learner must belong to it. A learner reading their own progress is not
// covered, since a `member` does not administer.
//
//   401  no session
//   404  the course does not exist; the reader does not administer its
//        organization; or the learner is not in it, or does not exist. One
//        status for all of them, so it confirms neither a course nor a person
//        to someone with no business knowing.
//   200  a knowledge report, objectives in content order, each carrying the
//        values that describe its phase:
//
//          { "modelVersion": "v1", "objectives": [
//              { "objectiveId": "…", "phase": "unseen" },
//              { "objectiveId": "…", "phase": "acquiring",
//                "lastEvidenceAt": "2026-06-01T00:00:00.000Z" },
//              { "objectiveId": "…", "phase": "retaining",
//                "lastEvidenceAt": "…", "stability": 3.2,
//                "retrievability": 0.87, "due": false }
//          ] }
//
//        `due` is the decision route's own rule — a retained objective it would
//        offer for review — so the two answers cannot disagree about a learner.
//        The shape is `KnowledgeReport` serialized, pinned like the decision's.
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
//        record more than five minutes ahead, or uses an `id` starting with
//        `attempt:`, which is reserved for evidence graded from attempts
//   403  the request could have been forged (it must be `application/json`, and
//        any `Origin` it sends must be this installation's), or the grader may
//        not grade here, or the learner or an objective is not this
//        organization's
//   413  the body is larger than 1 MB
//   409  a record's `id` already holds a different result for this learner —
//        another outcome, date, or objective. Nothing in the batch is stored.
//        An evidence ID identifies one attempt's result for one objective;
//        built from the task and the objective alone it repeats on every
//        attempt, and each one after the first answers this.
//   204  recorded. Redelivering the same result is a no-op, so a retry answers
//        the same way and writes no second row.
//
// The organization routes below share their refusals: 401 without a session,
// and 403 unless the session holds `owner` or `admin` there — authoring is a
// content-owner act for the same reason grading is. Each write adds 403 for a
// request that could have been forged, 413 for a body over 1 MB, and 400 for
// an invalid one, which it answers before checking the role since that reveals
// nothing about the organization. Below is what each answers beyond
// that.
//
// `POST /api/organizations/:organizationId/objectives` — registers learning
// targets. Body `{ "titles": ["Past tense", …] }`, at most 1000, each non-blank
// and trimmed. Answers 201 with `{ "objectiveIds": [...] }`, positionally
// matching the titles. IDs are opaque and generated, never a title.
//
// `GET /api/organizations/:organizationId/objectives` — answers
// `{ "objectives": [{ "id": "…", "title": "…" }] }`, by title. That is a listing
// order and not content order: the sequence a learner meets objectives in
// belongs to a course.
//
// `POST /api/organizations/:organizationId/tasks` — adds tasks to objectives
// that already exist, at most 1000:
//
//   { "tasks": [{ "objectiveId": "…", "kind": "choice", "prompt": "…",
//                 "options": ["…", "…"], "answer": 0, "explanation": "…" }] }
//
// `choice` is the only kind: 2 to 26 distinct non-blank options, `answer` the
// index of the correct one, `explanation` optional and shown after grading.
// Tasks are immutable, and nothing retires one yet. Answers 201 with
// `{ "taskIds": [...] }`, positionally matching; 400 when any task is not a
// valid one of its kind, and 403 when an objective is not this organization's.
// Either refusal stores nothing in the batch.
//
// `POST /api/organizations/:organizationId/courses` — creates a course over
// objectives that already exist. Body `{ "title": "…", "objectiveIds": [...] }`,
// at most 1000 and each appearing once; position in that list is content order,
// and that list is what selection chooses from. Answers 201 with
// `{ "courseId": "…" }`, or 403 when an objective is not this organization's —
// also the answer for one that does not exist, so neither confirms the other's.
//
// `GET /api/organizations/:organizationId/courses` — answers
// `{ "courses": [{ "id": "…", "title": "…" }] }`, by title.
//
// Every GET above answers `Cache-Control: private, no-store`, since each one
// answers differently per cookie; so does a 500 raised after the route set it,
// because Hono's default error response keeps the headers already on the
// context. Braivo's writes set none: nothing caches a POST unasked.

export type { Api, ApiOptions } from "./app.ts";
export { createApi } from "./app.ts";
