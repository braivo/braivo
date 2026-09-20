// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { type Evidence, replay } from "./estimate.ts";
import { activeModel } from "./model.ts";
import { selectNext } from "./select.ts";

/**
 * Guards the shape of the cost, not the cost itself.
 *
 * A decision replays a learner's whole history, so what that costs is worth
 * guarding — but not as a number, since quoted numbers rot. What would actually
 * hurt is not a slower constant but a changed exponent: a fold or a sort turned
 * quadratic is invisible on the handful of records every other test uses, and
 * arrives as a timeout once one learner has a few years of history.
 *
 * Each bound below was placed between two measurements: what the operation costs
 * now, and what it costs once the regression this guards against is injected.
 * Both ends were measured, and each bound sits about an order of magnitude from
 * either — loose enough that a busy machine does not turn it red, tight enough
 * that the regression cannot slip under it on a faster one. A bound chosen by
 * feel tends to clear the first bar and fail the second silently, which is a
 * worse outcome than having no test, since the comment then claims cover that is
 * not there.
 *
 * Which is worth stating plainly about this file too: timing one fixed size
 * proves nothing about complexity. These catch the three substitutions that were
 * actually injected and measured — listed at each bound — and a quadratic path
 * that misses all three would pass. They are regression guards, not proofs.
 *
 * Fifty thousand records, rather than the largest number that would still prove
 * the point. A quadratic fold over this many finishes in seconds and fails the
 * bound; over ten times as many it does not finish at all, and a test whose
 * failure mode is a stalled run tells whoever broke it far less than one that
 * simply goes red.
 */
const model = activeModel;
const start = new Date("2020-01-01T00:00:00.000Z");
const now = new Date("2026-06-01T00:00:00.000Z");

function history(records: number, objectives: number): Evidence[] {
  return Array.from({ length: records }, (_unused, index) => ({
    id: `e${index}`,
    objectiveId: `o${index % objectives}`,
    outcome: index % 4 === 0 ? ("failure" as const) : ("success" as const),
    at: new Date(start.getTime() + index * 60_000),
  }));
}

/**
 * Deterministic shuffle. Replay sorts before it folds, and a fixture already in
 * order never asks the sort to do anything — an insertion sort would take its
 * best case and look linear.
 *
 * Lehmer's multiplier and modulus, whose product peaks at 2^46.6 and so stays
 * exactly representable: a generator that overflows 2^53 loses its low bits to
 * rounding silently, and a shuffle left quietly half-ordered would weaken this
 * guard without failing anything. The modulo bias in `state % (i + 1)` is real
 * and does not matter here — a fixture only has to be thoroughly out of order,
 * not uniformly sampled, and this one lands within 1% of the inversion count a
 * uniform shuffle would give.
 */
function shuffled(evidence: readonly Evidence[]): Evidence[] {
  const out = [...evidence];
  let state = 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 48_271) % 2_147_483_647;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Best of several runs: any single one can lose to whatever else the machine is doing. */
function fastest(run: () => void, attempts = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const began = Bun.nanoseconds();
    run();
    best = Math.min(best, (Bun.nanoseconds() - began) / 1e6);
  }
  return best;
}

/** As long a history as a learner plausibly accumulates. */
const LONG_HISTORY = 50_000;

/**
 * Healthy replay costs 5ms in order and 16ms out of it. Of the two regressions
 * this budget has to catch, the cheaper — an insertion sort — costs 2.0s, and an
 * unkeyed estimate lookup 3.3s. The budget sits an order of magnitude from
 * either side of that gap.
 */
const REPLAY_BUDGET_MS = 200;

/**
 * Enough distinct objectives that replay's own estimate lookup has to be keyed.
 * A scan over the estimates is O(records × objectives), which a small number of
 * objectives hides: over 200 of them it costs 78ms and passes the budget above,
 * over 10,000 it costs 3.3s and does not. Selection reuses the count for its
 * candidate list, where it does the same job for the same reason.
 */
const DISTINCT_OBJECTIVES = 10_000;

describe("the cost of a long history", () => {
  test("replay grows with the evidence, not with its square", () => {
    const ordered = history(LONG_HISTORY, DISTINCT_OBJECTIVES);

    replay(ordered, model); // Warm, so the first run does not pay for the last.

    // Catches a fold that scans the estimates instead of keying into them, which
    // is quadratic in objectives rather than in records and so needs the long
    // candidate set rather than the long history to show up.
    expect(fastest(() => void replay(ordered, model))).toBeLessThan(REPLAY_BUDGET_MS);

    // The same history out of order, because sorting is the other half of what
    // replay does and the fixture above never asks it to do any: an insertion
    // sort takes its linear best case on sorted input and would pass there while
    // costing about two seconds here. Replay accepts evidence in any order, so
    // this is the case that has to be timed.
    expect(fastest(() => void replay(shuffled(ordered), model))).toBeLessThan(REPLAY_BUDGET_MS);
  });

  test("selection stays cheap however long the candidate list", () => {
    // Selection reads one estimate per candidate and nothing per evidence
    // record, so the length of a history must not reach it at all. The candidate
    // list is long because the regression worth catching is looking an estimate
    // up by scanning rather than by key, and that only separates from a keyed
    // lookup in bulk: at a thousand candidates the scan still finishes in three
    // milliseconds and any bound loose enough to be stable would wave it
    // through. At ten thousand it costs 0.6ms keyed against roughly 165ms
    // scanning, measured across several runs.
    const estimates = replay(history(LONG_HISTORY, DISTINCT_OBJECTIVES), model);
    const candidates = Array.from({ length: DISTINCT_OBJECTIVES }, (_unused, index) => `o${index}`);

    const milliseconds = fastest(() => void selectNext({ now, candidates, estimates, model }));

    expect(milliseconds).toBeLessThan(15);
  });
});
