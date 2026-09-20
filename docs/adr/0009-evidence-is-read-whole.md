# 0009: Evidence is read whole, not narrowed to the decision

Status: accepted (2026-09-16)

## Context

`chooseNextObjective` reads a learner's entire recorded history and replays it, then hands the result to `selectNext`, which consults the estimate for each of the course's candidates and nothing else. Estimates are derived rather than stored ([ADR 0007](0007-one-learning-model.md)), so this happens on every request.

The read is plainly wider than the answer. `replay` folds each objective independently, and selection only ever looks up its own candidates, so a record about an objective the course does not teach cannot reach the decision. Narrowing the read to the candidate list is therefore not a cache and carries none of a cache's staleness — it is the same answer computed from fewer rows, and it drops a learner's other courses and, for someone in more than one organization, everything the asking organization has no business replaying.

It does not bound the work, which is worth being clear about before reaching for it as though it did. A learner can accumulate any number of records about a single objective, so even a one-objective course replays a history that grows without limit. Narrowing changes the constant, not the shape.

That argument is correct and the optimization still does not work. This ADR records why, because the reasoning above is convincing enough that someone will have it again.

## Decision

`readLearnerEvidence` takes a learner and an instant, and returns everything recorded for that learner up to it. It is not narrowed by objective, by course, or by organization.

## Consequences

- The measurement that settles it, against a local PostgreSQL with 50,000 records over 1,000 objectives, on a course teaching 200 of them:

  | Read                                  | 1st–5th execution | 6th onward | Rows   |
  | ------------------------------------- | ----------------- | ---------- | ------ |
  | Whole history (this decision)         | 22–24ms           | 22–24ms    | 50,000 |
  | Narrowed, `objective_id IN (200 ids)` | 11–13ms           | 266–296ms  | 10,000 |

  The narrowed read is faster until the sixth time it runs, and then twelve times slower than the read it replaced, for as long as that prepared statement lives on that connection.

- The cause is PostgreSQL's plan cache, and it is narrower than "the generic plan is worse". Under the default `plan_cache_mode = auto` a prepared statement is planned against its actual parameters for its first five executions; from the sixth, the planner compares the generic plan's estimated cost against the average of those custom plans and adopts the generic one when it does not look more expensive. It is a comparison, not an automatic switch, and the accounting belongs to one prepared statement in one session — pooled connections each keep their own, and new statistics or DDL can cause replanning. Here the comparison came out wrong, and `EXPLAIN (ANALYZE, BUFFERS)` says why:

  | Plan              | Access path                                 | Buffers | Execution |
  | ----------------- | ------------------------------------------- | ------- | --------- |
  | Unscoped          | Index Scan on `learner_evidence_replay_idx` | 1027    | 5.97ms    |
  | Narrowed, custom  | the same Index Scan, plus a filter          | 1027    | 6.87ms    |
  | Narrowed, generic | the same Index Scan, plus a filter          | 1027    | 257.48ms  |

  All three choose the same access path and touch exactly the same 1027 buffers. What differs is the filter expression. The custom plan folds the candidates into a single array constant, `objective_id = ANY ('{…}'::text[])`, which is evaluated once into a hashed lookup. The generic plan cannot fold parameters, so it emits an array constructor, `objective_id = ANY (ARRAY[$2, $3, … $201])`, and walks it per row — up to 200 comparisons each, since a match stops early and a miss does not, against every one of the 50,000 rows it scans. The regression is in expression evaluation, not in the choice of index.

- That the database does more work when asked for less is the part worth keeping. The narrowed read scans the identical index range — the index is `(learner_id, at, id)`, so the objective is not a key and cannot restrict it — and then discards 40,000 of the rows it read. Even on the good plan it is slower inside PostgreSQL than the unscoped read, 6.87ms against 5.97ms. The saving measured at the client, 22–24ms down to 11–13ms, is therefore entirely the cost of carrying and decoding 40,000 rows that the server had already visited.

- So the failure is one tests are poorly placed to catch. A suite runs the query a handful of times per connection and sees the custom plan; a long-lived server can cross the threshold on a single connection under ordinary traffic. This is a caveat about where the risk sits, not a proof that every deployment would degrade — the switch is conditional and per session.

- What it buys is not large enough to fight for: about 12ms off a decision measured end to end at about 29ms for a learner with 50,000 records.

- Reopening this means starting from the filter, not the row count. An index on `(learner_id, objective_id, at, id)` would let the objective restrict the scan instead of filtering after it, but it is a candidate to benchmark rather than a known remedy: it would not serve the `(at, id)` ordering across several objectives without a sort, and it adds a second index to the table that takes every write. A measured need would justify trying it. None exists, and ADR 0007 already records that no estimate cache is warranted by history size alone.

- The `inArray` on the write path, `findObjectivesOutsideOrganization`, crosses the same threshold, measured rather than assumed: the sixth execution costs 0.9ms for a batch of 10, 5.5ms for 100, and 25.8ms for 500, against 0.5–1.1ms before it. The shape is identical; only the scale differs, at the size `objective` had when measured. It is left alone until a real batch size makes it matter.
