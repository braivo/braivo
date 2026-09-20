# Product

Braivo turns existing educational content into adaptive, AI-assisted learning, so each learner spends time on what they need to learn or remember next instead of getting the same fixed sequence as everyone else.

Use this document to resolve product trade-offs. If a task conflicts with the principles or non-goals below, raise the conflict instead of working around it, and propose a compliant alternative when possible.

## Users

- **Content owner:** an educator, school, training provider, or learning product that owns content and wants it to be adaptive.
- **Learner:** a person using a learning experience powered by Braivo.
- **Developer:** someone embedding Braivo into an app, LMS, or internal tool through its API.

## Core jobs

1. Turn existing materials into structured learning content.
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
