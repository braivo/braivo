# Learning model v1

Status: draft (2026-09-16)

How Braivo turns learner evidence into knowledge estimates, and estimates into the next learning intent. This is the specification for the `learning` module. Product intent is in `product.md`, terms in `glossary.md`, module boundaries in `architecture.md`.

The structure below is decided. The constants are not: they are placeholders to be validated by replaying recorded evidence, not tuned by intuition.

## Invariants

These hold regardless of what the model computes, and are the reason the model can be replaced cheaply later.

- **One model, versioned, replaced rather than selected.** A model version identifies the algorithm **and its parameter values** together, and there is one active set. A second model is adopted by replacing the first and recomputing estimates, not by running both; an estimate carrying any other version is stale input, which `learning` rejects. Why there is no registry, strategy interface, or per-organization choice, and how a replacement is evaluated: [ADR 0007](../adr/0007-one-learning-model.md).
- **Estimates are derived and disposable; evidence is the source of truth.** Every stored estimate must be reconstructible by replaying that learner's evidence in a defined order. Nothing may be knowable only from an estimate. Adding or removing a field on an estimate is therefore a recomputation, not a migration.
- **Model-derived state lives only in `learning`'s output and in stored estimates.** No interval, due date, stability, or other model artifact appears on content, task, or evidence schema. Violating this is what makes a future model change expensive, because the schema then encodes assumptions the next model may not share.
- **Subject-neutral.** `learning` consumes normalized evidence and never sees task shape, subject, or response content, and never names an activity. A conjugation, a derivative, and a balanced equation reach it in the same form and leave it in the same form.
- **Pure.** No I/O, network, database, clock, or implicit randomness. `now` and the model are arguments. This is what makes replay and recomputation possible at all.

## Unit of knowledge

An **objective**: a stable, assessable learning target. Learning content and tasks _reference_ objectives; they do not own them. Estimates are per `(learner, objective)`.

Reference rather than ownership, because the same knowledge recurs: two lessons and a second course may all teach the past tense. If an objective belonged to one content node, those become three unrelated objectives and Braivo forgets they are the same knowledge. This does not require a global concept graph — it only requires that ownership-by-content is not an invariant.

**An objective ID has stable learning semantics.** A material change to what is being learned creates a new objective rather than rewriting the meaning of an existing one. Without this rule, editing an objective silently rewrites the meaning of every past evidence record attributed to it, and replay produces nonsense. Rewording is not a material change; changing what a learner must be able to do is.

Objectives are the only vocabulary `learning` shares with the rest of the system.

## Evidence

Normalized at the task boundary by the grader, which is where subject-specific knowledge stops.

```ts
type Evidence = {
  id: string;
  objectiveId: string;
  outcome: "success" | "failure";
  at: Date;
};
```

The outcome is binary. A continuous score would have to mean the same thing across graders for the model to use it — a pronunciation grader's 0.8 is not an algebra grader's 0.8 — and nothing in v1 knows how to establish that. The grader owns the rubric, the raw score, and the threshold, and emits the outcome; richer grading detail is preserved on the attempt and assessment, outside `learning`. Expand this shape when recorded data shows what information the model is missing.

`failure` rather than `lapse`, because a grader does not know whether the learner was recalling or still acquiring, and only one of those is a lapse. Evidence reports what happened; interpreting it is the model's job, and a name that presumes the interpretation would be wrong on exactly the first attempt.

**One attempt may produce evidence for zero or more objectives**, each record attributed to a single objective. A math problem can exercise fraction addition, algebraic manipulation, and equation solving at once. Keeping `task → exactly one objective` out of the structure preserves the simple per-objective model without constraining task design.

**Ordering and idempotency.** The evidence ID does two jobs:

- It breaks timestamp ties, so evidence replays in a total `(at, id)` order that does not depend on arrival. IDs compare by UTF-16 code unit, never by locale, which would not be deterministic.
- It is the key a grading result is recorded under, unique per learner. A retry is always a retry for the same learner, and a global key would silently drop one learner's evidence whenever another learner's ID collided with it.

Recording enforces identity; replay does not deduplicate, so a duplicate that reached it would be folded twice rather than hidden. Under an ID already stored:

- The same result again is a retry, and is stored once.
- A different result — another outcome, date, or objective — is refused with its whole batch, and the first result stands. Estimates already derived from the first require keeping it, and refusing loudly exposes a grader that builds IDs from task and objective rather than from the attempt, which would otherwise lose every attempt after the first. The stored row is compared after the insert, in the same transaction, so two writers racing with different results cannot both succeed.

Late-arriving evidence is permitted: replaying ordered evidence absorbs it, a direct payoff of estimates being disposable. Evidence dated _ahead_ of its arrival is refused beyond a few minutes' allowance for clocks, because once stored it cannot be corrected: it stays out of every decision until its date comes, and a resend with the right date is a conflict. Mistakes that date a record in the past cannot be caught, since they look like an imported history. This is a rule of recording, not of `learning`, which has no clock and already reads only evidence dated at or before its own `now`.

## Estimate

```ts
type KnowledgeEstimate =
  | {
      objectiveId: string;
      phase: "acquiring";
      lastEvidenceAt: Date;
      modelVersion: string;
    }
  | {
      objectiveId: string;
      phase: "retaining";
      stability: number; // days until recall probability falls to 0.9
      lastEvidenceAt: Date;
      modelVersion: string;
    };
```

Three states, not two: **unseen** (no estimate at all), **acquiring**, and **retaining**. A learner who has failed an objective does not possess a memory of it that is decaying — they have not learned it yet. Collapsing that into a low stability value makes a failed first attempt indistinguishable from a weak memory, and the objective then falls out of selection entirely: its retrievability is 1 the instant the estimate is written, so it is not due, and having an estimate at all means it is no longer new. The phase distinction is what actually delivers the model's main job of separating "never learned" from "learned and fading".

`stability` exists only in `retaining`, because it is meaningless before anything is retained. Absence of an estimate is how `unseen` is represented; there is no third phase value and no nullable stability to guard.

**Naming convention.** Learner states are continuous participles — `acquiring`, `retaining` — and decisions are imperative verbs — `introduce`, `reteach`, `review`. A phase describes what is true of the learner; an intent describes what Braivo will do about it. Keeping the two vocabularies disjoint is deliberate, and the trap is an easy one: naming the phase `review` collides with the `review` intent, and such a collision hides behind sentences that read fluently while saying nothing — "a `review` objective that is not due gets no `review`".

**Retrievability** is derived, never stored:

```
elapsedDays = max(0, nowMs - lastEvidenceAtMs) / 86_400_000
r(now)      = 0.9 ** (elapsedDays / stability)
```

Stability is defined as **the elapsed time at which recall probability reaches 0.9**. Anchoring the curve at 0.9 rather than at `1/e` makes the stored number legible — `stability: 10` means ten days until review is due at the default target, not ten days until recall has decayed to 37%. It also matches the convention the spaced-repetition literature uses, so the term carries its usual meaning to anyone who has met it before. The anchor is part of the definition of stability and does not move when `targetRetention` is tuned.

## Update rule

On evidence for an objective, in `(at, id)` order:

| Current phase | Outcome   | Next phase                                  |
| ------------- | --------- | ------------------------------------------- |
| unseen        | `success` | `retaining`, `stability = initialStability` |
| unseen        | `failure` | `acquiring`                                 |
| `acquiring`   | `success` | `retaining`, `stability = initialStability` |
| `acquiring`   | `failure` | `acquiring`                                 |
| `retaining`   | `success` | `retaining`, stability grown (below)        |
| `retaining`   | `failure` | `acquiring`, stability discarded            |

`lastEvidenceAt` is set to the evidence's `at` in every case. A failure while `retaining` is the only one of these that is a **lapse** — a memory that existed and was not retrieved.

**Growth on a success while retaining.** Stability grows more when retrieval was harder, so a later, more effortful recall is worth more than an early one:

```
stability' = stability * min(1 + stabilityGain * (1 - r), maxStabilityGrowth)
```

The cap bounds the ratio `stability' / stability`, not stability itself, so a very overdue success cannot inflate stability without bound. Note that `r` is evaluated at the evidence's `at`, which makes the formula meaningful for evidence on an objective that was not due — a multi-objective task produces exactly that, and `1 - r ≈ 0` correctly grows such an objective barely at all.

**A lapse returns the objective to `acquiring` and discards its stability.** This is deliberately severe, and it replaces the more common design of penalizing stability by a factor with a floor. That design has a hole: after a lapse the objective's retrievability resets to 1, so it is not due again for the whole reduced interval — days during which the learner has demonstrably just failed it. Returning to `acquiring` makes it immediately selectable, and re-teaching is the appropriate response to a failed recall anyway. The cost is that a single slip on a long-held objective forfeits its history; whether that is too harsh is a question for replay, and the alternative is a parameter, not a restructure.

It is also why the model needs no lapse-penalty factor, no stability floor, and no counter of consecutive failures: the phase transition carries what each of those would have encoded.

## Selection rule

Given `now`, candidate objectives in content order, and their estimates, selection is deterministic and ordered:

1. **Acquiring.** Any objective in `acquiring`, oldest `lastEvidenceAt` first. Intent `reteach`.
2. **Due.** `retaining` objectives with `r(now) < targetRetention`, lowest `r` first. Intent `review`.
3. **New.** Candidates with no estimate, in candidate order. Intent `introduce`.
4. **Nothing.** No candidate qualifies; selection returns `undefined` and the application decides what to do with a learner who has nothing due.

**Content order sequences new material within a candidate list.** Rule 1 returns any objective still being acquired, and rule 3 cannot reach an unseen candidate while rule 1 has one to offer. So while a course's first objective is unlearned, that course's later objectives are never _introduced_ — without `learning` knowing what a prerequisite is, and without anything in the rules saying so. Under ordered replay, only a success ends `acquiring`; elapsed time never does.

The guarantee is per call and per candidate list, which is narrower than it sounds. It says nothing about a second course whose candidates omit the unlearned objective: an objective held back behind it in one course is introduced as usual through a list that omits it, which follows from objectives being shared rather than owned ([ADR 0008](../adr/0008-courses-order-objectives.md)). Nor does it hold anything back retroactively — evidence arriving late cannot un-introduce what was already offered. The property is emergent rather than written, which is why `select.test.ts` pins it: nothing in the code states it, so nothing would notice it going.

**Candidates are an ordered list of objective IDs**, not records carrying an explicit `order` field. Position in the list _is_ content order, so duplicate or conflicting order values cannot be expressed, and the list's order is already total — so tie-breaking needs no final `objectiveId` comparison, because two candidates can never share a position.

**Tie-breaking** completes the total order, since determinism is otherwise only claimed and not delivered:

- Acquiring: oldest `lastEvidenceAt`, then candidate order.
- Due: lowest `r`, then candidate order.
- New: candidate order.

**Eligibility is resolved before `learning` is called.** Prerequisites, content-owner settings, and content availability determine the candidate list; `learning` receives it and never learns what a prerequisite is. This keeps learning constraints strictly prior to scoring rather than a tie-breaker, and removes a whole vocabulary from the module.

**`learning` returns an objective and an intent, never an activity.** Choosing between a grammar explanation, a cloze sentence, a pronunciation drill, and a worked example requires knowing what those are, which is precisely what the subject-neutral invariant denies `learning`. The application and content modules turn `review objective X` into a task. Returning an activity is the specific path by which a generic engine accumulates subject-specific logic.

**An objective above target is not selected solely for retention review.** It may still appear inside mixed practice, a transfer task, a multi-objective exercise, or a diagnostic. `r > targetRetention` says retention review is unnecessary, which is narrower than saying the objective must not be shown; `product.md` forbids repeating known material _without a learning reason_, and those are learning reasons.

## Decision

The decision carries the rule-specific values that explain it, rather than pairing a result with a separate trace object:

```ts
type LearningDecision = {
  objectiveId: string;
  modelVersion: string;
} & (
  | { intent: "introduce" }
  | { intent: "reteach"; lastEvidenceAt: Date }
  | { intent: "review"; retrievability: number; stability: number }
);
```

`product.md` requires that activity choices be explainable from recorded inputs. Making the explanation part of the decision's type, discriminated by the same `intent` the caller already switches on, means a `review` decision cannot exist without the retrievability that justified it — explainability is structural rather than a field someone remembers to populate. Narrowing on `decision.intent` gives the caller the values that explain that decision, without repeating the whole selection input — candidate order, `now`, and the model's parameters stay where they came from.

The decision explains itself _at the moment it was made_. It does not by itself provide historical explainability: six months later the model version, parameters, candidate list, prerequisites, and content may all have changed, and the decision cannot be rebuilt from current state. `modelVersion` travels with the decision so that a persisted one stays interpretable, but whether to persist it is an application decision and this spec does not prescribe the storage. What matters here is not claiming an in-memory value already solves it.

## Module surface

Four functions, all pure. Three are the module's public surface; `updateEstimate` is the fold `replay` is built from, and stays inside the module:

```ts
function updateEstimate(
  estimate: KnowledgeEstimate | undefined,
  evidence: Evidence,
  model: LearningModel,
): KnowledgeEstimate;

function replay(
  evidence: readonly Evidence[],
  model: LearningModel,
): ReadonlyMap<string, KnowledgeEstimate>;

function selectNext(input: {
  now: Date;
  candidates: readonly string[];
  estimates: ReadonlyMap<string, KnowledgeEstimate>;
  model: LearningModel;
}): LearningDecision | undefined;

function assessKnowledge(input: {
  now: Date;
  objectiveIds: readonly string[];
  estimates: ReadonlyMap<string, KnowledgeEstimate>;
  model: LearningModel;
}): KnowledgeReport;

type KnowledgeReport = { modelVersion: string; objectives: ObjectiveStanding[] };

type ObjectiveStanding = { objectiveId: string } & (
  | { phase: "unseen" }
  | { phase: "acquiring"; lastEvidenceAt: Date }
  | {
      phase: "retaining";
      lastEvidenceAt: Date;
      stability: number;
      retrievability: number;
      due: boolean;
    }
);
```

`assessKnowledge` is the descriptive counterpart to `selectNext`: over the same inputs and held to the same checks, it reports where a learner stands on each objective instead of choosing one. `product.md` asks for both — choosing what comes next, and showing content owners learner progress and knowledge gaps — and retrievability, being derived from the model, may only come out of `learning`. It exists as a function rather than being assembled by its caller because that caller would otherwise need `retrievability` and the target it is compared against, which are the model's to own.

`due` is the selection rule's own predicate, shared rather than restated, so the two agree on what due means: a retained objective reported as due is one selection would review, were nothing more urgent. `assess.test.ts` checks that agreement across generated learners — whatever selection chooses appears in the report as the reason for choosing it — and asserts that each kind of decision was reached a meaningful number of times. That is a floor against a branch going untested, not a proof that every case is covered.

The report keeps the order it was given and decides nothing. `unseen` stands in for the estimate that does not exist, as it does everywhere else, so every standing carries exactly the values that describe it.

`undefined` is how absence is spelled throughout: an unseen objective has no estimate, and a selection with nothing to offer returns none. `updateEstimate` accepts `undefined` for the unseen case rather than making every caller branch before calling it, which is what keeps the three-state model from needing a fourth representation.

`replay` exists rather than leaving callers to fold `updateEstimate` themselves because it owns the `(at, id)` ordering. That ordering is what the disposable-estimate invariant rests on, so it belongs in one place instead of being re-derived at every call site — and it cannot be checked anywhere else: an estimate does not record which evidence it last absorbed, so a caller folding two records with the same timestamp could apply them in an order replay would not, and nothing would notice. That is why `updateEstimate` is not part of `learning`'s public surface. It accepts evidence spanning any number of objectives and returns one estimate per objective — the exact shape `selectNext` consumes, so recomputing a learner and choosing what they do next compose without glue. Returning a single estimate instead would have quietly obliged every caller to filter by objective first.

`estimates` is a `ReadonlyMap` keyed by objective ID, which makes two estimates for the same objective unrepresentable. `selectNext` takes a named object because four arguments are easy to transpose when read; `updateEstimate` stays positional because its three arguments are distinct types and read as a sentence.

## Model and parameters

Parameters are part of the model version, not a per-organization or per-subject setting. There is one active set. Changing a value materially is a new model version and a recomputation, exactly as changing the algorithm is.

```ts
type LearningModel = {
  readonly version: string;
  readonly targetRetention: number;
  readonly initialStability: number; // days
  readonly stabilityGain: number;
  readonly maxStabilityGrowth: number;
};
```

Version and parameters are one flat object rather than a version alongside a nested parameter bag, so that a version cannot be passed apart from the values it names. That is as far as the shape goes: keeping the two in step — a new version whenever a parameter changes — remains a rule of the module, since nothing can tell a parameter set from its version, and the exported constant is frozen so the active one cannot drift at runtime. Passing the model as an argument is what purity and testability require, which is not the same as making it configurable: the module exports the one active set as a constant, so a caller supplies the active model rather than inventing parameter values.

| Parameter            | Placeholder | Meaning                                            |
| -------------------- | ----------- | -------------------------------------------------- |
| `targetRetention`    | 0.9         | Recall probability below which review is due       |
| `initialStability`   | 1 day       | Stability on entering `retaining`                  |
| `stabilityGain`      | 8           | Growth per success, scaled by retrieval difficulty |
| `maxStabilityGrowth` | 5×          | Cap on the single-update growth ratio              |

Four parameters, and the small count is a constraint rather than a coincidence. Most of what a spaced-repetition model would otherwise parameterize — lapse penalties, floors, struggle thresholds, session ratios — is settled here by the phase transitions instead. Add a parameter only when the structure genuinely cannot express the behavior, because a parameter that merely tunes what structure already decides is a value nobody can ever justify choosing.

Because stability is anchored at 0.9, the review interval at the default `targetRetention` is simply `stability`. In general `interval = stability * ln(targetRetention) / ln(0.9)`. An on-time success has `r = 0.9`, giving a growth factor of `1 + 8 * 0.1 = 1.8`, so an objective reviewed on schedule progresses roughly 1 → 1.8 → 3.2 → 5.8 → 10.5 days.

**Validation.** The module is pure, so failing fast is cheap: `0 < targetRetention < 1`, `initialStability > 0`, `stabilityGain >= 0`, `maxStabilityGrowth >= 1` — each a finite number, since `Infinity` survives the arithmetic these feed and lands in a stability — and when updating, `evidence.at >= lastEvidenceAt` and `evidence.objectiveId === estimate.objectiveId` — an estimate cannot absorb evidence older than what is already folded into it, nor evidence about something else. `replay` guarantees both by construction, through its ordering and its keying; `updateEstimate` checks both too, but cannot check the tie-break by ID when timestamps are equal, since an estimate does not record which evidence it last absorbed. `selectNext` and `assessKnowledge` separately require every estimate they read to be the one for the ID it was looked up under, and to carry a `lastEvidenceAt` at or before `now`. The first is needed because a map is keyed separately from the estimates it holds: a hand-built one could file one objective's estimate under another's ID, and selection then returned an objective that was never a candidate. `replay` never builds such a map. An estimate handed to any entry point is untrusted input, so each also requires a `retaining` estimate to carry a finite positive `stability`, and every timestamp to be a valid `Date`. Both checks exist because the bad values fail quietly rather than loudly: `Invalid Date` compares false against everything, a stability of 0 gives `r = NaN`, a negative gives `r > 1`, and `Infinity` gives `r = 1` — each reads as "not due", so an unchecked one removes the objective from selection permanently instead of raising anything. Elapsed time is a duration clamped at zero, never a calendar-day subtraction, so that time zones and DST cannot leak into a model that claims determinism.

**A stale model version is an error, not a fallback.** `selectNext`, `assessKnowledge`, and the `updateEstimate` fold beneath `replay` reject an estimate whose `modelVersion` is not that of the model they are given — in the application, the active one. Folding new evidence into a stability an older model produced, or selecting on one, creates state that replaying the learner's evidence cannot reproduce — the invariant the rest of this design rests on. `replay` is the remedy and cannot hit the error itself, since it derives every estimate from the model it was given. No estimate is persisted yet, so nothing can present a stale version through an application path: the check currently guards this module's own contract, and becomes load bearing the moment estimates are cached. From then on, recomputation is a prerequisite of replacing the model rather than a background task that can trail it.

## Interaction contract

**Selection runs after an evidence-producing interaction. Introduction and re-teaching flows culminate in an assessment before selection is consulted again.**

Without this rule the model has two dead ends. An introduced objective that is never assessed produces no evidence, so it still looks unseen and is introduced again. An objective in `acquiring` is selected for re-teaching, and re-teaching produces no evidence, so it is selected again, indefinitely.

Stating a contract is the v1 fix, in preference to modeling ungraded exposure as a second event type. If product requirements later call for genuinely unassessed activities, that is when to add the event type and the state it implies.

## Worked examples

These are the first test fixtures. Each states inputs and the expected decision.

**New learner, nothing known.** No estimates exist, so rules 1 and 2 produce nothing and selection falls to new material in candidate order. Decision: `introduce`.

**Failed first attempt.** The learner is introduced to an objective and fails the assessment. The estimate becomes `acquiring`; it is not a memory with low stability. On the next selection rule 1 fires immediately. Decision: `reteach`. This is the case a single-scalar model silently loses: giving a failed first attempt some low stability makes `r = 1` at that moment, so the objective is neither due nor new, and it drops out of selection entirely. Keep this fixture — it is the regression test for the distinction the phases exist to draw.

**Overdue but previously strong.** `stability = 40`, last evidence 120 days ago: `r = 0.9 ** 3 = 0.729`, below `targetRetention`, so rule 2 fires and beats available new material. Decision: `review`, `retrievability = 0.729`. A success here grows stability by `1 + 8 * 0.271 = 3.17` to about 127 days — the spacing effect the update rule is shaped around.

**Lapse.** A `retaining` objective with `stability = 40` receives a `failure`. It returns to `acquiring` and its stability is discarded, so it is selectable on the next call rather than after a reduced interval. Decision: `reteach`.

## Open questions

Deliberately unresolved; each needs evidence or a requirement, not a guess.

- Parameter values. The table is a starting point; validate by replaying real evidence before treating any number as settled.
- Whether discarding stability on a lapse is too severe, and whether re-acquisition should restore some fraction of the prior stability instead of `initialStability`.
- What happens to a learner who cannot acquire an objective. Selection will keep returning it, and v1 has no escape hatch — and because content order sequences new material, the course also stops advancing: no unseen candidate in it is introduced while anything in it is still being acquired. Not that everything later is unreachable, though. Objectives already started remain selectable, since rule 1 picks the oldest `acquiring` rather than the first in content order. That raises the stakes on answering, but the answer — skipping it, alerting the content owner, offering different material — is a product question, not a model one.
- Whether evidence needs a grader confidence alongside the outcome, so an uncertain AI judgment moves an estimate less than a deterministic one.
- Whether prerequisites belong to content structure or to separate learning constraints. `learning` receives an eligible candidate list either way, so this can be decided without touching this spec. What a prerequisite would add is narrower in one direction and not in another. Sequencing unseen material within a course is already covered by order, so that is not it. Readiness is: one success on `a` lifts the block on introducing `b`, while recall of `a` is still at its highest, and a rule demanding more than one success is exactly what a prerequisite would express. A dependency _between_ courses is the other thing order cannot reach, since each course's candidate list stands alone.
- How objectives are derived from source content, and how the stable-semantics rule is enforced when AI proposes edits to them. That belongs to `content` and `ai`.
- Whether re-teaching is a distinct activity type or the same task type with different framing. This is an application question now that `learning` returns an intent.

## Not in scope

- **Mastery as a binary label.** `glossary.md` leaves it undecided, and it stays that way. The model already exposes phase, stability, and retrievability; inventing a threshold so the glossary has an entry would add a parameter serving documentation rather than behavior. Define it when a concrete rule needs it — prerequisite readiness is the likely first caller — and define it as that rule.
- **Session composition.** No cap on the share of a session spent reviewing. Such a cap needs session state that selection does not have and v1 does not define, and it is not clear the problem exists. If review backlogs prove to hurt, the fix is an explicit session policy in the application, not a half-specified ratio here.
- Per-subject models, parameter profiles, or estimates. Subject-specific behavior belongs to task types and graders.
- Difficulty or ability estimation across learners, as in IRT. Adopt only if replay shows the per-learner model is insufficient.
- Engagement mechanics: streaks, points, or any scheduling pressure whose purpose is return frequency rather than retention.
