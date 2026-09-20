# Glossary

Canonical terms for Braivo's docs, code, API, and UI. Use each term as written here, in code and prose alike; where the code spells it differently, the code name follows in parentheses. A "Not" note names a synonym to avoid and why. User roles are defined in `product.md`; how they appear in code is below.

## Product and platform

- **Braivo:** the self-hostable product: run it yourself, or consume it as the managed Braivo Cloud service.
- **`braivo`:** this public repository, holding the self-hostable Braivo platform. Use this name in dependency and code-ownership rules.
- **Braivo Cloud:** the managed Braivo service — Braivo plus closed-source code of its own for tenancy, billing, provisioning, and custom-domain setup. An engineering term, not a separate customer-facing product.
- **Core:** the `content`, `learning`, and `ai` modules in `braivo`.
- **Public contract:** an explicitly documented endpoint, type, or entry point intended for external use. Undocumented internals are not supported integration points.
- **Tenant:** an isolation boundary within Braivo Cloud for a customer's data and operations. Tenant isolation is Braivo Cloud's responsibility. Not a synonym for organization: whether an organization is the tenancy boundary is undecided ([ADR 0006](adr/0006-better-auth.md)).
- **Learn app** (`apps/learn`): the learner-facing app. White-label: it runs for one organization under that organization's brand and domain — a vocabulary app at `springo.app`, say. `demo.braivo.app` is Braivo's own deployment of it, for prospects and integrators ([ADR 0004](adr/0004-one-application-origin.md)).
- **Console** (`apps/console`): the application content owners use to manage their organization. Under [ADR 0004](adr/0004-one-application-origin.md) (not yet implemented) it owns the root of its origin and addresses organizations by slug — `braivo.app/<organization>` on Braivo Cloud, and no slug at all where an organization's own domain identifies it. A self-hosted installation serves the same console on its own origin.
- **Braivo Design System:** the whole of Braivo's visual language — tokens, components, their stories, and the conventions for using them. `@braivo/ui` is its React implementation and `apps/storybook` its catalog ([ADR 0013](adr/0013-ui-package-and-storybook.md)).

## People and access

- **Organization** (`organization`, `organizationId`): the group that owns the learning content and organizes the people using it. The API addresses one by its ID; the console will address one by its slug, as `/<organization>/…` ([ADR 0004](adr/0004-one-application-origin.md), not yet implemented). Not "workspace", which means the Vite+ workspace here.
- **Member** (`member`): a person's membership in an organization, managed by Better Auth ([ADR 0006](adr/0006-better-auth.md)). A member record carries one or more **organization roles** — `owner`, `admin`, or `member` — in its `role` field, comma-separated; `readOrganizationRoles` splits them, so nothing compares the whole string. Currently, membership is what authorizes access to an organization's courses, and course-specific enrollment is not yet defined; a request naming an organization authorizes nothing.
- **Content owner:** the person or organization that owns and manages the learning content — an educator, school, training provider, or learning product ([product.md](product.md)). Currently the organization roles `owner` and `admin` may take content-owner actions: authoring content, grading, and reading learners' progress. Not "teacher", since content owners include schools and products, and not "admin", which names one of those roles rather than both.
- **Learner** (a Better Auth `user`; `learnerId` is that user's ID): a person whose learning state Braivo tracks and for whom it selects what to learn next. Learners currently reach an organization's courses through membership in it; course-specific enrollment is not yet defined. Not "student", and not "user" in domain code: `user` is the account every learner has.

## Learning

- **Source content:** material a content owner provides. Authoritative for what is taught.
- **Learning content:** structured content derived from source content and linked to it.
- **Course** (`course`, `courseId`): an ordered set of objectives a content owner arranges, and what produces the candidate list `learning` selects from. A course orders objectives rather than owning them, so one objective may appear in several courses ([ADR 0008](adr/0008-courses-order-objectives.md)). Which learners take which course is not decided yet.
- **Objective** (`objective`, `objectiveId`): a stable, assessable learning target, and the unit knowledge estimates are kept for. Learning content and tasks reference objectives rather than owning them; a material change to what is being learned creates a new objective ([spec](specs/learning-model.md)). Not "skill", "concept", or "knowledge component", which name knowledge in general rather than one assessable target.
- **Activity:** what Braivo presents to a learner to learn or practice an objective, such as an explanation, a question, an exercise, or a review interaction. The intent says why an objective comes next; the activity is what the learner does.
- **Task:** a single learner interaction within an activity, such as answering a question.
- **Attempt:** a learner's interaction with a task, stored with enough task context to interpret it after content changes.
- **Learner evidence** (`Evidence`): observations used to update a learner's knowledge estimate. Attempts and assessments are the recorded detail; what reaches `learning` is a normalized outcome per objective, graded at the task boundary: an evidence ID, an objective, an outcome of `success` or `failure`, and when it happened (`at`). Not "grade" or "score": the outcome is binary.
- **Evidence ID** (`Evidence.id`): identifies one graded result — one attempt's outcome for one objective — and is unique per learner. Build it from the attempt, never from the task alone, and give each objective an attempt covers its own. The same result sent again is recorded once; a different result under an ID the learner already has is refused.
- **Knowledge estimate** (`KnowledgeEstimate`): what Braivo currently believes a learner knows, struggles with, or may be forgetting. Derived from learner evidence and recomputable from it. Not "mastery" or "score".
- **Learner progress** (`LearnerProgress`; the `…/progress` endpoint, which answers a `KnowledgeReport`): where one learner stands in one course, for the content owners of its organization.
- **Caught up** (`{ kind: "caught-up" }`; HTTP 204 from the next-objective endpoint): a learner with nothing to do in a course right now — no objective to introduce, re-teach, or review. A statement about this moment, not about mastery: objectives come due again as recall decays, and a course that teaches nothing yet leaves its learners caught up too.
- **Mastery:** an estimate of how well a learner has learned particular material. Its representation and computation are not yet decided. Not a synonym for knowledge estimate or caught up.
- **Learning constraints:** rules limiting which activities can come next, such as prerequisites or content-owner settings.

## Learning model

These are defined in the [spec](specs/learning-model.md); they are listed here so that code, API, and UI use them the same way.

- **Learning model** (`LearningModel`; the one in use is `activeModel`): the algorithm and its parameter values together, replaced rather than selected ([ADR 0007](adr/0007-one-learning-model.md)).
- **Model version** (`modelVersion`): what identifies a learning model, stamped on every estimate, decision, and report. A parameter change is a new version.
- **Phase** (`phase`: `unseen`, `acquiring`, or `retaining`): where a learner is with one objective. `unseen` is the absence of an estimate; a failure always returns an objective to `acquiring`.
- **Stability** (`stability`, in days): the retention timescale of a retained objective — the elapsed time at which recall probability reaches 0.9, which is the review interval at the default target retention.
- **Retrievability** (`retrievability`, from 0 to 1): the estimated probability of recalling a retained objective right now.
- **Due** (`due`, `isDue`): a retained objective whose retrievability is below the model's `targetRetention`. Selection and reports share this one rule.
- **Replay** (`replay`): rebuilding a learner's estimates from their evidence in `(at, id)` order; the only way from evidence to estimates.
- **Candidates** (`candidates`): the ordered objective IDs selection chooses from; position in the list is content order.
- **Learning decision** (`LearningDecision`): the next objective and an intent, with the values that explain it. Never an activity.
- **Intent** (`intent`: `introduce`, `reteach`, or `review`): why an objective comes next — new to the learner, still being acquired, or due.
- **Knowledge report** (`KnowledgeReport`, one `ObjectiveStanding` per objective): each objective's phase and values, in the order given, and whether it is due.
