# 0007: One learning model, replaced rather than selected

Status: accepted (2026-09-16)

## Context

The `learning` module takes the model as an argument:

```ts
selectNext({ now, candidates, estimates, model });
```

That signature reads like the first step toward a `LearningModelStrategy`, a registry of named models, and an organization-level setting to choose between them. It is not. The model is an argument for the same reason `now` is: the module is pure, and purity is what makes replay and recomputation possible at all. [The learning model spec](../specs/learning-model.md) describes the model; this records what was decided about having more than one.

Adaptive-learning systems attract model pluggability early — there is always another spaced-repetition algorithm worth trying, and a registry looks like the cheap way to keep the option open. The registry is not the cost. The cost is that stored estimates, evaluation, support, and the meaning of a learner's history all become conditional on which model produced them.

## Decision

Braivo has one active learning model. `learning` exports it as a constant. No registry, no strategy interface, no ensembles, and no per-organization, per-subject, or per-learner choice of model.

A model version identifies the algorithm **and its parameter values** together, so changing a parameter materially is a new version exactly as changing the algorithm is. A second model is adopted by replacing the first and recomputing estimates, not by running both. An estimate stamped with a version other than the active one is stale input: `learning` rejects it, and the remedy is to replay that learner's evidence.

This is affordable only because estimates are derived and disposable — every one reconstructible by replaying the learner's evidence. That invariant, held by the spec, is the thing actually worth protecting; single-model is what it buys.

## Consequences

- Replacing the model means recomputing estimates wherever they are stored. None are stored today — every decision replays the learner's evidence under the active model — so replacement currently costs nothing and the rejection of a foreign `modelVersion` cannot fire outside a direct call into `learning`. The first estimate cache is what buys that cost: from then on, selection for a learner whose estimates are stale fails loudly rather than mixing versions, and recomputation becomes a prerequisite of replacing the model rather than a background task that can trail it. That is the trade to weigh when adding the cache, and it is paid deliberately rather than avoided by keeping old models runnable.
- Replay was measured, not assumed. Against a warm local PostgreSQL, over a 200-objective course, one decision takes about 2ms for a learner with 1,000 recorded outcomes, 11ms at 10,000, and 29ms at 50,000, of which replay is about 8ms and fetching the evidence most of the rest. That was one learner at a time, so it shows how cost grows with a history's length, not how it behaves under concurrency or against a hosted database. It does show that history size alone does not call for the estimate cache above.
- A candidate **estimation model** is evaluated offline: replay recorded evidence through both models and compare predictive calibration against what each learner actually did next. This is sound, because the evidence being replayed does not depend on which model is being tested — and it needs preserved evidence and two pure functions, not a runtime registry.
- A candidate **selection policy** cannot be settled that way. A different policy would have chosen different objectives at different times and produced evidence that was never recorded, so replaying history against it answers a counterfactual the history does not contain. Offline simulation can bound the damage and catch regressions; the learning effect needs prospective evaluation. Running both models in production would not remove the counterfactual, so one model costs nothing here either.
- Model behavior stays uniform across installations and subjects, so a learner's history means one thing and a support question has one answer.
- `learning` stays a few pure functions and a few precise types, with contract violations expressed as plain assertions. A `Result` type, repository, replay service, or engine interface earns its place only when application code demonstrates the need.
- If concurrent models ever become a real requirement — a live experiment across cohorts, say — this ADR is superseded rather than worked around, and the disposable-estimate invariant is what makes that affordable.
