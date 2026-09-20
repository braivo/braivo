# 0008: Courses order objectives, and position stops at the module boundary

Status: accepted (2026-09-16)

## Context

`learning` selects from an ordered list of candidate objective IDs, and [the spec](../specs/learning-model.md) is explicit that position in that list _is_ content order: candidates carry no `order` field, so conflicting order values cannot be expressed. Eligibility is resolved before `learning` is called.

Nothing produced that list. `chooseNextObjective` took `candidates` from its caller, which meant the application layer would recommend whatever it was handed — including an objective ID that does not exist, silently, as `introduce`. Objectives gained a table in [ADR 0005](0005-postgresql-drizzle.md)'s wake, but a bag of objectives is not a sequence.

## Decision

A **course** is an ordered set of objectives owned by an organization, and it is what produces a candidate list. `chooseNextObjective` takes a `courseId` rather than a candidate list and resolves the objectives itself, after resolving the course's organization and checking that the learner belongs to it.

Ordering is stored as an integer `position` on the membership row, unique per course, and is **erased on the way out**: `readCourseObjectives` returns a plain ordered array of objective IDs. The column exists only at the storage boundary, because a database needs somewhere to put an order and a list already is one. That keeps the spec's property — that a candidate list cannot express a conflicting or duplicate order — true of the whole path rather than only of the in-memory type. Membership is keyed by `(course, objective)`, so an objective appears in a course at most once.

Courses order objectives; they do not own them. The same objective may appear in several courses, which is the point: the past tense taught in two courses is one piece of knowledge and one estimate.

Membership carries the organization and references `(organization, course)` and `(organization, objective)` together, so a course can only arrange objectives its own organization owns. Referencing each by ID alone would check only that both rows exist, and one organization's course could then sequence another's objectives — a cross-organization leak that authorizing the course would not catch, because the course itself is legitimately the learner's. [ADR 0006](0006-better-auth.md) makes that distinction; this makes it structural rather than a rule the one writer has to remember.

**Enrollment is not decided here.** Which learners may take which course is a separate question. A course the caller cannot name correctly yields no decision.

## Alternatives rejected

- **Ordering objectives directly within an organization.** No course table, just a position per objective. It produces an order, but one syllabus per organization is a placeholder that every real content owner immediately outgrows, and unpicking a global order later is worse than not having one.
- **A full content tree** — course, module, lesson, task, each with its own ordering. That is the shape Braivo probably grows into, but none of the intermediate levels have behavior that needs them yet, and [ADR 0005](0005-postgresql-drizzle.md) is explicit that tables follow implemented requirements.
- **Prerequisite graph instead of a sequence.** The spec leaves open whether prerequisites belong to content structure or to separate learning constraints. A sequence is the weaker claim and does not foreclose adding constraints later; a graph would have decided that question as a side effect of needing an order.

## Consequences

- `chooseNextObjective` can no longer be asked about an objective that does not exist, because it no longer accepts objective IDs from its caller.
- Four queries per decision: the course's organization and the learner's membership first, then the course's objectives and the learner's evidence concurrently.
- Reordering a course means rewriting positions. There is no gap-based scheme, because nothing yet reorders an existing course and a unique constraint per course is what makes conflicting orders unrepresentable.
- A course is per organization, so two organizations teaching the same subject have two courses and two sets of objectives. That follows from objectives being organization-owned, not from anything decided here.
- If sequencing later needs to be per learner — a generated path rather than an authored one — this ADR is superseded. The candidate list is already the seam that would change, and `learning` would not notice.
