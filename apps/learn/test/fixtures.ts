// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Activity, LearnerProgressSummary } from "@braivo/server/client";

// Data that several of the learn app's page tests share; what one file uses stays in that file.

/**
 * Spanish by its ID, as the installation's host links it; tests on its
 * organization's domain visit it as `/c/4732`.
 */
export const SPANISH_ID = "5a7e0000-0000-4000-8000-000000004732";

/** A typed task: the learner types the word. */
export const typedActivity: Activity = {
  decision: { objectiveId: "o2", modelVersion: "v1", intent: "introduce" },
  objective: { id: "o2", title: "Sein" },
  task: { id: "t2", kind: "typed", prompt: "I am tired: Ich ___ müde." },
};

export const activity = {
  decision: { objectiveId: "o1", modelVersion: "v1", intent: "introduce" },
  objective: { id: "o1", title: "Past tense" },
  task: {
    id: "t1",
    kind: "choice",
    prompt: "Past tense of 'hablar'?",
    // Shown in another order than the author's, where "hablé" is choice 0: what
    // the learn app sends and marks must be the choice, never the position.
    options: [
      { choice: 1, text: "hablo" },
      { choice: 0, text: "hablé" },
    ],
  },
} satisfies Activity;

export const anotherActivity: Activity = {
  decision: {
    objectiveId: "o1",
    modelVersion: "v1",
    intent: "reteach",
    lastEvidenceAt: "2026-06-01T00:00:00.000Z",
  },
  objective: { id: "o1", title: "Past tense" },
  task: {
    id: "t2",
    kind: "choice",
    prompt: "Past tense of 'comer'?",
    options: [
      { choice: 0, text: "comí" },
      { choice: 1, text: "como" },
    ],
  },
};

export const noProgress: LearnerProgressSummary = {
  modelVersion: "v1",
  asOf: "2026-06-01T00:00:00.000Z",
  repeatedMissesThreshold: 3,
  objectives: [],
};
