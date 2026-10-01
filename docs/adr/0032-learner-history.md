# 0032: One history per learner, recorded and read per organization

Status: accepted (2026-10-01)

## Context

A person may learn at several organizations, one after another or at the same time: a language school and a private tutor, or a school and a self-study product. What Braivo records about them could belong to each organization, restarting at each one, or to the learner, accumulating across them, which is where portable knowledge would later come from.

The schema leaned to the second without a decision saying so. A learner is a Better Auth account, not a row an organization owns; evidence is keyed by learner, erased with the account, and outlives membership; an organization that still owns the content it refers to cannot be deleted ([ADR 0006](0006-better-auth.md)). Three things contradicted it:

- Evidence and attempt IDs were unique per learner across every organization. One organization's grader or app could refuse another's write, and the 409 told it the learner had a record under that ID elsewhere.
- Every decision read the learner's whole history, every organization's ([ADR 0009](0009-evidence-read-whole.md), as first decided). Only the current model's habit of folding objectives independently kept another organization's evidence out of the answer, and its volume still showed in the decision's latency.
- Nothing said which organization a record came from except its objective.

## Decision

**A learner has one history, in which each organization records evidence about its own objectives and reads only its own.**

- **Identity.** Today a learner is a Better Auth account (`learnerId` is `user.id`), and one account may belong to several organizations. That is the current mapping, not the definition of a learner: an account is not provably one person, and a learner who exists before having an account would need an identity of its own (see Consequences).
- **Provenance.** Evidence and attempts name the organization they were made at, always the owner of their objective or task; the database refuses any other. Their IDs are unique per learner within that organization, so a retry is always a retry at the same organization, and two organizations' IDs never collide.
- **Reads.** An organization's decisions and reports read only the evidence it recorded, so no other organization's evidence can reach them, whatever a future model does across objectives. How that read is shaped, and why it goes no narrower: [ADR 0009](0009-evidence-read-whole.md).
- **Ownership.** Organizations own their content and issue evidence about it; the history is kept per learner, outlives membership, and is erased with the account. Who may retain or export what, beyond that, is not decided here.

## Alternatives rejected

- **A learner per organization**, a row the organization owns: the history restarts at every organization, and erasing a person means finding them in each.
- **Reading the learner's whole history**, every organization's (replaced): separation rested on how the model folds evidence rather than on what it is given, and each decision's work grew with the learner's history at other organizations.
- **A shared objective taxonomy, or cross-organization equivalence, now:** an open-ended ontology project with no customer asking for it. Equivalence, when needed, maps organization-owned objectives rather than replacing them.
- **One mutable estimate that organizations write to:** each write would overwrite what another organization's evidence showed.
- **IDs unique across organizations** (replaced): independent clients collide, and each collision leaks a record.
- **Signed or cryptographic learning records:** a signature proves who issued a claim, not that it is true. Provenance and export come first.

## Consequences

- One account learns at several organizations of one installation at once, with no synchronization; no other organization's evidence reaches a decision or report through this read. Organizations still share the installation's database and processes, so this is not isolation of their performance.
- Combining a learner's history across organizations becomes a deliberate act: a read that names several organizations, which nothing does today. IDs are organization-local, so any such combination must keep the organization in each record's identity and in the order it replays by. Personalizing one organization's course from another's evidence needs objective matching, the learner's consent, and a rule for trusting another organization's grading; each waits for a customer.
- Identity, deferred:
  - **Learners before accounts** (a school importing a class without email addresses): would need a learner identity that an account later claims, with its own roster, claiming, merging, and deletion rules. Settle it when rosters or imports are next, not before.
  - **Two accounts for one person** (invited by different emails): linking or merging them within an installation.
  - **Identity across installations.**
- Also deferred: course enrollment, while membership stands in for it ([ADR 0018](0018-sign-in-and-invitations.md)); exporting or importing a learner's history; how long an organization may keep its records.
- Any deployment that partitions data by organization must still keep a learner's history erasable as one.
