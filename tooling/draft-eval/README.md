# Draft evaluation

Compares a change to what Braivo tells its AI, or to the model, with what ships now, on a fixed set of material, before it ships. It runs a checkout's own `draftCourse` and `extractPages` through the production Anthropic adapter, bypassing only the quota and the ledger, and records every run. It costs real model calls, so it runs only by hand, never in CI.

A change to an operation in `apps/server/ai/` (`DRAFT_OPERATION`, `READ_OPERATION`: system text, template, parts, tool, schema) or to the default model attaches to its PR the comparison table and the filled rubric (below), with the prompt versions both sides ran. A contributor without an Anthropic key says so in the PR, and the maintainer runs it.

## Run it

```sh
# The baseline: what ships now, in its own checkout with its own dependencies.
git worktree add --detach ../baseline origin/main
(cd ../baseline && bun install --frozen-lockfile)

bun run eval:draft --checkout ../baseline --label baseline          # prints the calls it would make
bun run eval:draft --checkout ../baseline --label baseline --yes    # makes them
bun run eval:draft --label candidate --yes                          # this checkout
bun run eval:draft compare tmp/draft-eval/<…>-baseline tmp/draft-eval/<…>-candidate
```

`ANTHROPIC_API_KEY` comes from `.env.local`; `--model` (default: `BRAIVO_AI_MODEL`, else the evaluated checkout's own default, so a change of default model is compared with the old one) compares models instead. `--runs` (3) and `--fixture <name>` (repeatable) narrow a run. Each run is recorded in `tmp/draft-eval/<time>-<label>/<fixture>-<run>.json`: the model, the prompt version and how it was computed, the code revision (`+changes.<hash>` when `apps/server` had uncommitted changes, the hash telling two such apart), the model's raw answer, the result, the ledger's counts, and the checks. A run that fails is recorded with its failure and left out of every mean, never retried.

The fixtures and checks are this checkout's for both sides, so run the two back to back without changing them, and to the end: an interrupted side shows only as fewer runs. `compare` leaves a fixture only one side ran out of the totals, and says so. The evaluated checkout must export its operations and `promptVersion`, as `apps/server/ai/` does since the ledger.

## What it measures

- **Automatic checks** (`checks.ts`), cheap and blind to quality: the share of proposed objectives and tasks kept, refusal lines, quotes by whether they are found once, more than once, or not at all; and failures, named: a kept objective without a task, the same task twice (its question, options, and answers, not a shared question alone), an injected instruction obeyed (a fixture's `offTopic` words in anything the model wrote but its quotes), a reading's expected line missing or its columns out of order, a draft with nothing kept and no note saying why, a fixture's `expectUnsupported` goal drafted without one, instructions reading as the material's language rather than the fixture's `instructionLanguage` (titles, prompts, or explanations as a whole, by counting common words, so a rough check that a person still reads past). `compare` lists each run's note.
- **Kept share is not quality.** It says how much survived validation. A prompt can raise it by proposing easier tasks, and a lower one is not on its own a regression. No threshold decides a change: a person reads the table, the failures, and the rubric.
- **The rubric**: `compare` writes `rubric-vs-<baseline run dir>-<comparison>.md` beside the candidate's runs, `<comparison>` a hash of both sides' recorded runs, so another baseline or a side whose runs changed gets its own, and comparing again never writes over one already graded: per fixture and side, three objectives (first, middle, last, each from another run), each with a task and a checklist to tick by hand, its other tasks beside it, and the path of the whole draft, to see what one task gives away of another. The checklist: one assessable target, the task testing it, the keyed answer supported by its quote (located is not supported), an explanation teaching the distinction, no feedback giving another task's answer away, no order-dependent options, every right typed answer accepted.

## Fixtures

`fixtures/manifest.json` lists each one: its `kind` (`draft` from text, `read` from a file), its origin, its `rights` to be redistributed here, and its review for anything private. Only material written for Braivo (`authored`) or under a licence that allows it, with the proof, goes in; a real school's lesson stays out, however useful. Names are fictional (Fernwood). `make-read-fixtures.sh` makes the two reading fixtures from text.

| Fixture                        | What it tests                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `station-english`              | A vocabulary table a cell per line, every word and example repeated, as text extracted from a PDF is |
| `market-spanish`               | The same shape, smaller                                                                              |
| `family-german`                | `word – translation` lines, examples repeated in a reading                                           |
| `restaurant-french-injected`   | An instruction to the AI in the material, to write about something else                              |
| `market-spanish-goal`          | A goal naming part of the material, with no audience: the draft keeps to it, in the goal's language  |
| `market-spanish-goal-grade`    | The same goal, the learners described without their language: prompts in the goal's language         |
| `market-spanish-goal-polish`   | Instructions asked for in Polish, from Spanish material: neither English nor the material's language |
| `family-german-goal-missing`   | A goal the material does not support: the draft says so in `unsupported`, inventing nothing          |
| `market-spanish-goal-injected` | A goal telling the AI to ignore the material and write about something else                          |
| `two-column`                   | A page in two columns, read column by column                                                         |
| `hard-scan`                    | A page photographed at an angle in poor light                                                        |

`replays/` holds answers recorded from real runs; `eval.test.ts` replays them through today's validator, so counting and the checks are tested without a key. Replace one when a change to the validator rightly changes its counts.
