// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type Organization } from "@braivo/server/client";
import { vi } from "vite-plus/test";

// Data and Braivo's stubbed answers that several of the console's page tests
// share; what one file uses stays in that file.

export const members = [
  { userId: "u1", name: "Olive Owner", roles: ["owner"] },
  { userId: "u2", name: "Lee Learner", roles: ["member"] },
];

/** Braivo's overview of `course-1`: every member counted, by name, and every objective. */
export const courseProgress = async () => ({
  open: true,
  modelVersion: "v1",
  learners: [
    { ...members[1]!, standings: { unseen: 0, acquiring: 1, retained: 0, due: 1 } },
    { ...members[0]!, standings: { unseen: 2, acquiring: 0, retained: 0, due: 0 } },
  ],
  objectives: [
    {
      objectiveId: "greetings",
      title: "Greetings",
      standings: { unseen: 1, acquiring: 1, retained: 0, due: 0 },
    },
    {
      objectiveId: "numbers",
      title: "Numbers",
      standings: { unseen: 1, acquiring: 0, retained: 0, due: 1 },
    },
  ],
});

export const school: Organization = {
  id: "org-1",
  name: "Example School",
  slug: "example",
  learnDomain: "example.braivo.app",
  administers: true,
  authors: true,
  teaches: false,
};

export const annex: Organization = {
  id: "org-2",
  name: "Annex",
  slug: "annex",
  learnDomain: null,
  administers: true,
  authors: true,
  teaches: false,
};

/** A course as authored, one objective taught by a passage and practised by a task. */
export const beginners = {
  id: "course-1",
  number: 4732,
  title: "Beginners",
  urlLabel: "beginners",
  published: true,
  hidden: false,
  objectives: [
    {
      id: "greetings",
      title: "Greetings",
      citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
      tasks: [
        {
          id: "t1",
          kind: "choice" as const,
          prompt: "Hello, in Spanish?",
          options: ["Hola", "Adiós"],
          answer: 0,
          explanation: "Adiós is goodbye.",
          citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
          published: true,
        },
      ],
      otherPublishedCourses: [],
    },
    { id: "numbers", title: "Numbers", citations: [], tasks: [], otherPublishedCourses: [] },
  ],
  sources: [{ id: "s1", title: "Unidad 1", createdAt: "2026-06-01T00:00:00.000Z" }],
};

/** Braivo's `readCourse`, answering `course-1` and refusing any other as Braivo does. */
export async function readCourse({ courseId }: { courseId: string }) {
  if (courseId === beginners.id) return beginners;
  throw new BraivoError(404, "Braivo answered 404.");
}

export const saludos = {
  id: "s1",
  title: "Saludos",
  text: "Hola significa hello.",
  language: "es",
  createdAt: "2026-06-01T00:00:00.000Z",
};

export const hello = { sourceId: "s1", quote: "Hola significa hello." };

/** A draft of two objectives, the first with two tasks, and one thing left out. */
export const drafted = {
  objectives: [
    {
      key: "d1",
      title: "Say hello",
      citations: [hello],
      tasks: [
        {
          kind: "choice",
          prompt: "Hello?",
          options: ["Hola", "Adiós"],
          answer: 0,
          citations: [hello],
        },
        {
          kind: "choice",
          prompt: "Hi?",
          options: ["Hola", "Gracias"],
          answer: 0,
          citations: [hello],
        },
      ],
    },
    {
      key: "d2",
      title: "Say goodbye",
      citations: [hello],
      tasks: [
        {
          kind: "choice",
          prompt: "Bye?",
          options: ["Adiós", "Hola"],
          answer: 0,
          citations: [hello],
        },
      ],
    },
  ],
  refused: [
    "Objective “Greetings”, task “¿Adiós?”: the quote “Adiós.” does not occur in the source.",
  ],
};

export function authoring() {
  return {
    getSource: async () => saludos,
    draftCourse: vi.fn(async () => drafted),
    acceptDraft: vi.fn(async (): Promise<string> => "course-1"),
    readCourse,
  };
}
