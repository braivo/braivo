# Generation

Status: planned. Specify after [sources](sources.md), whose identity and provenance rules constrain it.

What AI may produce from [sources](sources.md) — objectives, tasks, explanations — and how a content owner accepts it ([product.md](../product.md), core jobs 1 and 4; "Grounded AI"). Generated content must stay tied to the source it adapts and never replace it with unrelated material. Grading a learner's answer with AI, and the feedback on it, belong to the [learner loop](learner-loop.md) until they outgrow it.

## To decide

- What is generated first, and the structured output each kind must satisfy before it is stored.
- Proposal or content: whether generation writes reviewable proposals or ordinary objectives and tasks, and when generated content becomes ordinary authored content. Once accepted, the learner loop should not know or care that AI wrote it.
- Review: whether anything reaches learners without a content owner accepting it, and what accept, edit, reject, and regenerate do.
- Provenance: which source locations an item came from, and what belongs to the generation run instead (model, prompt version).
- Where the line sits between deterministic application code and model calls, so the rest stays testable without a model.
- Failure, retry, and idempotency of a generation request.
