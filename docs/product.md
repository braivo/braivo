# Product

Braivo turns existing educational content into adaptive, AI-assisted learning, so each learner spends time on what they need to learn or remember next instead of getting the same fixed sequence as everyone else.

Use this document to resolve product trade-offs. If a task conflicts with the principles or non-goals below, raise the conflict instead of working around it, and propose a compliant alternative when possible.

## Focus

Braivo's first focus is remembering: vocabulary, an exam's question bank, the facts a course rests on. A starting point, not a ceiling: planned learning experiences, such as theory when a question is too hard, or tutoring, will build on the same subject-neutral model rather than beside it. Four commitments guide the product; features strengthen them rather than dilute them:

- **The owner's material, under the owner's brand.** Content owners teach from material they already have, and learners practise in the owner's learn app, on the owner's address: a subdomain of the installation's, or a domain of the owner's own (core jobs 1 and 6).
- **AI-assisted authoring, published by a person.** Owners draft with the AI assistant they already use, or Braivo's own, and nothing a tool writes reaches learners until a person publishes it. Objectives and tasks may cite their source, and Braivo checks every quote is in it; a quote shows where content came from, not that it is correct.
- **Adaptation per objective.** Braivo estimates and schedules what a learner knows, not cards: an objective's tasks share one estimate, so practice varies while memory is tracked once, in every course of the organization using it.
- **Explainable decisions from evidence.** Estimates are derived from recorded learner evidence under a versioned model, and each decision carries the values that explain it.

The model is independent of the interface learning happens in: the learn app or another product embedding Braivo's API today, and an AI tutor built on the same model later.

## Users

- **Content owner:** an educator, school, training provider, or learning product that owns content and wants it to be adaptive, or a learner turning material of their own into practice for themselves.
- **Learner:** a person using a learning experience powered by Braivo.
- **Developer:** someone embedding Braivo into an app, LMS, or internal tool through its API.

## Core jobs

1. Turn existing materials into structured learning content. A content owner may draft it with the AI assistant they already use or with Braivo's own; either way, learners see it once the owner has reviewed and published it in Braivo.
2. Estimate what each learner knows, struggles with, and may be forgetting.
3. Choose the next learning or review activity from that estimate, within applicable learning constraints.
4. Generate practice and feedback grounded in the source content and the learner's work.
5. Show content owners learner progress and knowledge gaps.
6. Let others embed Braivo or run it under their own brand and domain, with no required Braivo branding.

## Principles

- **Content first.** Source content is authoritative for what is taught. AI may structure, enrich, and adapt it, but must not silently replace it with unrelated generated material.
- **Adaptive by default.** Learner state shapes what happens next, within applicable learning constraints. Fixed sequences may exist, but they are not the core model.
- **Learning over engagement.** Optimize for understanding, retention, and learner time. Do not add mechanics whose main purpose is engagement, or repeat known material without a learning reason.
- **Explainable decisions.** Mastery changes, scheduled reviews, and activity choices can be explained from recorded inputs and testable decision rules.
- **Grounded AI.** Generated content stays tied to the source material it adapts. Feedback is grounded in the source, the task, and the learner's response.
- **The AI people already use.** A content owner may author through their own AI assistant, acting as themselves and never with more authority. Braivo holds the content and learner evidence, enforces permissions, and is where the owner reviews and publishes; Braivo's own AI drafts for those without an assistant, and authoring never requires it.
- **Composable core.** Core learning capabilities do not depend on Braivo Cloud, a specific customer or brand, or a specific UI.
- **Simplest model that works.** Start with the simplest learning model that produces useful, testable behavior. Add sophistication only when evidence or a clear requirement justifies it.

## Non-goals

- A general-purpose chatbot or document Q&A tool.
- A course marketplace.
- A full LMS with broad enrollment, administration, and compliance workflows. Integrate with LMSs instead of reproducing them.
- Generating whole courses from nothing as the primary product.
- Engagement mechanics disconnected from learning outcomes.

Change non-goals only through an explicit product decision, never through incidental feature work.

## Repository boundary

This repository is the public Braivo platform: domain model, learning behavior, content processing, AI capabilities, extension points, and APIs. Braivo Cloud builds on it and owns managed-service concerns such as customer tenancy, billing, provisioning, automated custom-domain setup, and operations. Serving an organization under its own domain is the platform's job; obtaining certificates for that domain and onboarding it is the managed service's. `braivo` never depends on Braivo Cloud's code.

## Success

- Building a useful learning experience from existing content takes little effort.
- Learners with different knowledge get meaningfully different experiences.
- Weak and at-risk knowledge gets more attention than mastered material.
- Learning and retention are the primary outcomes; engagement is a supporting signal, not a goal.
