# 0029: Braivo drafts a course from a source on request, checks it, and stores nothing

Status: accepted (2026-09-24)

## Context

A content owner with a desktop agent drafts a course through `braivo mcp` at their own AI's cost ([ADR 0023](0023-mcp-server.md)). One without — most teachers — has material in Braivo and no way to turn it into objectives and tasks but writing them by hand. "Upload your materials and get a tutor" needs Braivo to draft too, without giving up what makes drafts trustworthy: every quote located in the source, every task a valid one, a person reviewing before learners see it ([ADR 0021](0021-citations.md)).

## Decision

- **An `ai` module with one port.** `Model` answers one request — instructions, the material, and the JSON Schema of the answer — and nothing else. `anthropicModel` is the one provider, over `fetch` to Anthropic's Messages API, forcing the answer as a tool call whose input schema is the shape asked for. Another provider, or a self-hoster's own endpoint, is another small adapter.
- **On with a key.** `ANTHROPIC_API_KEY` turns drafting on; `BRAIVO_AI_MODEL` picks the model, `claude-sonnet-5` by default for its balance of quality and cost. Without a key the route answers 501 and says to draft with a desktop agent: the installation stays complete without paying for a model.
- **The operator says who spends.** The operator creates every organization ([ADR 0018](0018-sign-in-and-invitations.md)), so with a key every one may draw on it, within its monthly quota ([ADR 0031](0031-ai-limits.md)). `BRAIVO_AI_ORGANIZATIONS`, organization IDs, narrows that to those named — the organizations paying for it, say; any other's request answers 403, saying to ask the operator or draft with a desktop agent. Set but naming none, or `*`, it is refused at startup rather than read as everyone.
- **The model proposes; `content` decides.** `ai.draftCourse` asks for objectives in teaching order, each with quotes and two to five multiple-choice tasks, and keeps only what the authoring endpoints would accept: each quote located exactly once, each task parsed by `content`'s own rule. Braivo's own writing is held to more than a person's: a task with no located quote, and an objective left with no quote or no task, are dropped too, so everything drafted traces to the source; a hand-written task may cite nothing. What it drops is listed in `refused`, named by title, question, and quote — "Objective “Say hello”, task “Hola?”: the quote “Hola, amigo.” does not occur in the source." — so a reviewer knows what the model got wrong; not by position, since the review numbers only what was kept. The answer's shape is one zod schema, which is both the tool's input schema and its validation.
- **Returned, never stored.** `POST …/sources/:sourceId/draft`, for administrators, answers the draft synchronously in the shapes `define_objectives`, `cite_sources`, and `author_tasks` take. ADR 0021 kept proposals out of the server because review happens where a draft is made; here it is made for the console, which reviews it and authors what is accepted through the usual endpoints. No job, no queue, no draft table.
- **Keys for the draft.** Each objective's key is random, made with the draft, so accepting the same draft again — a retry after a failure halfway — returns the objectives it already made ([ADR 0024](0024-idempotent-authoring.md)), and another draft makes its own.
- **Bounded.** At most 200,000 characters of source, twelve objectives, and five tasks each; a longer source is refused, naming the fix: several sources, a chapter each. Only the first three quotes of a task and five of an objective are looked for, so accepting a whole draft stays within the 200 quotes one authoring request may ask Braivo to find. The audience — "grade 2, English speakers" — is the content owner's words, at most 200 characters.

## Alternatives rejected

- **Keys from the model's name for an objective**, so that a redraft would find it again. The same idea came back under another name, and a reworded title under the same name was refused.
- **Requiring `BRAIVO_AI_ORGANIZATIONS`**, needed only while anyone who signed up could create an organization.

## Consequences

- A draft takes as long as the model does, tens of seconds for a chapter. The route lifts Bun's ten-second idle timeout for its own request, the model's five-minute timeout bounding it instead; a proxy in front of Braivo must allow it too; if that proves too slow, drafting becomes a job, which this decision would then revisit.
- Drafting reads a source's text only; a PDF or photo is read into a source first ([ADR 0030](0030-server-extraction.md)).
- Each draft spends the installation's AI credits; each request is recorded, and an operator may set organizations a monthly quota ([ADR 0031](0031-ai-limits.md)).
- The console reviews a draft on the source's page: each objective and task kept or dropped, a task's words and correct option corrected (never its passages, which were located), what was refused listed, and what is kept authored as a course. A redraft's objectives are new ones; matching them to earlier ones waits for teachers who need it.
- Review before learners see a draft is the console's workflow, not a state the server enforces: the authoring API and `braivo mcp` create courses directly, as the person they act for. A publish step would be a state machine no customer has asked for.
- The route passes the request's abort signal to the model's, and the console aborts its request when the teacher leaves the page, so Braivo stops waiting and asks the provider to stop. That cannot promise the provider bills nothing, and the request still counts against the quota.
