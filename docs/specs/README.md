# Specifications

One file per area of behavior: what people can rely on, and where the area ends, short enough to hold in mind while changing it.

| Question                       | Where it is answered                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| What must hold, and for whom?  | the area's spec, `docs/specs/<area>.md`                                                 |
| Why this way, not another?     | an ADR in `docs/adr/`, linked from the spec                                             |
| How is it implemented?         | the code, with a comment where the flow is not obvious; `api/index.ts` for the HTTP API |
| How do we know it holds?       | the tests each rule names                                                               |
| What are we changing, and how? | the area's plan, `local/plans/<area>.md`: gitignored and disposable                     |

## Writing a spec

A **living** spec describes behavior that exists, checked against the code on the date it gives:

- **Purpose:** who it serves and which [core job](../product.md#core-jobs), in a few sentences.
- **Rules:** one observable behavior each, true now, followed by the tests that pin it. A rule says what a user, caller, or other area can rely on, never which function does it. Each has an ID, `<area>-<n>` (`progress-3`), never renumbered or reused, so searching the repository for it finds every reference.
- **Boundaries:** what the area leaves to which other spec, and what it does not do yet.
- **Decisions:** the ADRs behind it, a line each.
- **Gaps:** limitations a customer or integrator would notice, and product promises not yet kept, as a table of gap, impact, and next step. Add one when found, delete it when fixed. What only an engineer would notice, such as a missing test, goes in the plan.
- **Entry points:** the few files to start reading from, not a full map.

A **planned** spec scopes an area before its code exists: purpose, boundaries, and the questions to decide first. It has no gaps, since the whole area is one; active work, when there is any, lives in its plan. Each answer becomes a rule or an ADR, and the spec turns living when its first behavior ships.

Each rule has one owner. Another spec may summarize it for context, naming its ID ("own only, progress-1"), but never defines it again: two definitions both look authoritative, and only one gets updated.

Update a spec in the same change as its behavior, rules, boundaries, or gaps; a refactor that keeps them leaves it alone. What Braivo Cloud adds to an area is specified in `braivo-cloud`, linking here.

## Plans

A plan is an area's working notes, kept out of Git so they can be rough: the goal and the rules it meets, design, steps, roadmap, questions for the maintainer, chores only an engineer would notice, and findings and rejected approaches that matter while the work lasts. Work too large for one reviewable commit is a list of ordered checkpoints, each naming one thing that becomes true, what it meets (spec rule IDs, a heading before the spec has IDs, or for tooling an ADR or repository rule), and the observation that proves it. `AGENTS.md` says how to work through them.

```md
- [ ] C1 A report lists objectives not yet started (progress-4). Proof: an unpractised objective is reported, not started.
- [ ] C2 A report counts only evidence up to its moment (progress-6). Proof: evidence dated after that moment leaves the report unchanged.
```

A plan may propose changing the spec but never overrides it: until code and spec change together, the spec holds. What ships leaves the plan, its rules into the spec and anything worth knowing later, a rejected approach included, into an ADR or a comment, so deleting a finished plan loses nothing. Every worktree shares `local/` ([ADR 0019](../adr/0019-shared-local-notes.md)), so one worktree works on an area at a time; `local/NEXT.md` orders the work across areas.

## Areas

Grouped by primary concern. Start with the group's specs, and follow their links where behavior crosses into another area.

### Learning

- [Learner loop](learner-loop.md): courses, activities, attempts, grading, and evidence from elsewhere.
- [Learning model v1](learning-model.md): how evidence becomes estimates and estimates the next objective.
- [Progress](progress.md): where a learner stands, for content owners and the learner.

### Content

- [Sources](sources.md): the material content owners bring, and how derived content links back to it.
- [Generation](generation.md): what AI may produce from sources, and how an owner accepts it.
- [Authoring](authoring.md): objectives, courses, and tasks, including their editing, retirement, and deletion.

### Platform

- [Access](access.md): sign-in, accounts, organizations, roles, and what each reaches, including enrollment.
- [White-label](white-label.md): organization domains, the host ceiling, branding, and console addressing.

Split an area out of its spec when it outgrows it, not before: grading from the learner loop once AI grades answers, enrollment from access once a course needs its own ([ADR 0018](../adr/0018-sign-in-and-invitations.md)), publishing from authoring once content has a draft state. Data export and retention, integrations, and notifications get a spec when their first feature does.

[Progress](progress.md), [sources](sources.md), [generation](generation.md), the [learner loop](learner-loop.md), and [white-label](white-label.md) follow this outline. The other living specs keep the one they were written with (how it works, invariants, code map, unnumbered rules): an incidental update stays in that format, and a spec is converted, rule IDs included, only when substantially reworked or on purpose, never all at once.
