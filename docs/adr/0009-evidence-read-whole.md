# 0009: An organization's evidence is read whole, never narrowed to the decision

Status: accepted (2026-09-16)

## Context

`chooseNextObjective` reads a learner's recorded evidence and replays it, then hands the result to `selectNext`, which consults the estimate for each of the course's candidates and nothing else. Estimates are derived rather than stored ([ADR 0007](0007-one-learning-model.md)), so this happens on every request, and progress reports read the same way. What a decision may read at all is [ADR 0032](0032-learner-history.md)'s: the evidence the course's organization recorded.

Within that, the read is plainly wider than the answer. `replay` folds each objective independently, and selection only ever looks up its own candidates, so a record about an objective the course does not teach cannot reach the decision. Narrowing the read to the candidate list is therefore not a cache and carries none of a cache's staleness; it is the same answer from fewer rows.

It does not bound the work, which is worth being clear about before reaching for it as though it did. A learner can accumulate any number of records about a single objective, so even a one-objective course replays a history that grows without limit. Narrowing changes the constant, not the shape.

That argument is correct and the optimization still does not work. This ADR records why, because the reasoning above is convincing enough that someone will have it again.

## Decision

`readLearnerEvidence` takes a learner, an organization, and an instant, and returns everything that organization recorded for the learner up to it, as one range of the index `(learner_id, organization_id, at, id)`. It is never narrowed by objective or course.

The organization is a key prefix, not a filter: one parameter, no array for a generic plan to expand, and an index scan that visits only the rows it returns. Measured against a local PostgreSQL with 50,000 records for one learner across five organizations, 10,000 at the one asked about, and 200,000 other learners' records, each query run 20 times on one connection:

| Read                                                      | 1st–5th | 6th onward | Rows   |
| --------------------------------------------------------- | ------- | ---------- | ------ |
| Whole history, index `(learner, at, id)`                  | 18–34ms | 19–48ms    | 50,000 |
| One organization, index `(learner, organization, at, id)` | 6–12ms  | 4–10ms     | 10,000 |

The index replaces the whole-history one, so writes maintain one index, not two.

## Why not by objective

- The measurement that settles it, on the same data, for a course teaching 40 of the organization's 200 objectives, each query run 20 times on one connection, twice:

  | Read                                         | 1st–5th | 6th onward | Rows   |
  | -------------------------------------------- | ------- | ---------- | ------ |
  | One organization                             | 3–9ms   | 3–11ms     | 10,000 |
  | One organization, `objective_id IN (40 ids)` | 2–3ms   | 11–24ms    | 2,000  |

  The narrowed read is faster until the sixth time it runs, and then several times slower than the read it would replace, for as long as that prepared statement lives on that connection.

- It was first measured on the learner's whole history, before reads were scoped to the organization, with 50,000 records over 1,000 objectives and a course teaching 200 of them; the regression was larger there, and the analysis below is of that run:

  | Read                                  | 1st–5th execution | 6th onward | Rows   |
  | ------------------------------------- | ----------------- | ---------- | ------ |
  | Whole history                         | 22–24ms           | 22–24ms    | 50,000 |
  | Narrowed, `objective_id IN (200 ids)` | 11–13ms           | 266–296ms  | 10,000 |

  There, twelve times slower from the sixth run.

- The cause is PostgreSQL's plan cache, and it is narrower than "the generic plan is worse". Under the default `plan_cache_mode = auto` a prepared statement is planned against its actual parameters for its first five executions; from the sixth, the planner compares the generic plan's estimated cost against the average of those custom plans and adopts the generic one when it does not look more expensive. It is a comparison, not an automatic switch, and the accounting belongs to one prepared statement in one session — pooled connections each keep their own, and new statistics or DDL can cause replanning. Here the comparison came out wrong, and `EXPLAIN (ANALYZE, BUFFERS)` says why:

  | Plan              | Access path                                 | Buffers | Execution |
  | ----------------- | ------------------------------------------- | ------- | --------- |
  | Unscoped          | Index Scan on `learner_evidence_replay_idx` | 1027    | 5.97ms    |
  | Narrowed, custom  | the same Index Scan, plus a filter          | 1027    | 6.87ms    |
  | Narrowed, generic | the same Index Scan, plus a filter          | 1027    | 257.48ms  |

  All three choose the same access path and touch exactly the same 1027 buffers. What differs is the filter expression. The custom plan folds the candidates into a single array constant, `objective_id = ANY ('{…}'::text[])`, which is evaluated once into a hashed lookup. The generic plan cannot fold parameters, so it emits an array constructor, `objective_id = ANY (ARRAY[$2, $3, … $201])`, and walks it per row — up to 200 comparisons each, since a match stops early and a miss does not, against every one of the 50,000 rows it scans. The regression is in expression evaluation, not in the choice of index.

- That the database does more work when asked for less is the part worth keeping. The narrowed read scans the identical index range — the objective is not in the index key and cannot restrict it — and then discards 40,000 of the rows it read. Even on the good plan it is slower inside PostgreSQL than the unscoped read, 6.87ms against 5.97ms. The saving measured at the client, 22–24ms down to 11–13ms, is therefore entirely the cost of carrying and decoding 40,000 rows that the server had already visited.

- So the failure is one tests are poorly placed to catch. A suite runs the query a handful of times per connection and sees the custom plan; a long-lived server can cross the threshold on a single connection under ordinary traffic. This is a caveat about where the risk sits, not a proof that every deployment would degrade — the switch is conditional and per session.

- What it buys is not large enough to fight for: a millisecond or two on the first five runs.

- Reopening this means starting from the filter, not the row count. An index on `(learner_id, organization_id, objective_id, at, id)` would let the objective restrict the scan instead of filtering after it, but it is a candidate to benchmark rather than a known remedy: it would not serve the `(at, id)` ordering across several objectives without a sort, and it adds a second index to the table that takes every write. A measured need would justify trying it. None exists, and ADR 0007 already records that no estimate cache is warranted by history size alone.

- The `inArray` on the write path, `findObjectivesOutsideOrganization`, crosses the same threshold, measured rather than assumed: the sixth execution costs 0.9ms for a batch of 10, 5.5ms for 100, and 25.8ms for 500, against 0.5–1.1ms before it. The shape is identical; only the scale differs, at the size `objective` had when measured. It is left alone until a real batch size makes it matter.

## Alternatives rejected

- **The course's candidate objectives:** slower once PostgreSQL switches to a generic plan (Why not by objective).
