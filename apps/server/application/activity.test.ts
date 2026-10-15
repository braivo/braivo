// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { isDeepStrictEqual } from "node:util";

import { runMigrations } from "@braivo/db";
import { attempt, organizationDomain } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { type PresentedTask, presentTask, type TaskBody } from "../content/index.ts";
import { activeModel } from "../learning/index.ts";
import {
  createCourse,
  createObjectives,
  createSource,
  createTasks,
  readLearnerEvidence,
  recordAttempt,
  recordEvidence,
} from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import { NEW_OBJECTIVES_PER_DAY } from "./daily-limit.ts";
import type { RequestHost } from "./host.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "activity-test-org";
const otherOrganizationId = "activity-test-other-org";
const learner = "activity-test-learner";
/** Another member of the same organization. */
const classmate = "activity-test-classmate";
/** A member of another organization only. */
const outsider = "activity-test-outsider";
const installation: RequestHost = { hostname: "localhost", installation: true };
/** `otherOrganizationId`'s domain. */
const otherDomain: RequestHost = { hostname: "activity-test.example.com", installation: false };
const start = new Date("2026-06-01T00:00:00.000Z");
const later = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

/** Correct answer at index 0. */
const question = (prompt: string): TaskBody => ({
  kind: "choice",
  prompt,
  options: ["right", "wrong"],
  answer: 0,
});

let pastTense!: string;
/** In the course, but with no task: nothing to practise it with. */
let untaught!: string;
let fractions!: string;
let pastTenseTask!: string;
/** Fractions has two tasks, created in this order. */
let fractionsTasks!: [string, string];
/** Past tense, untaught, fractions, in that order. */
let courseId!: string;
let untaughtCourseId!: string;
let foreignTask!: string;
/** The other organization's course of `foreignTask`, where the learner also studies. */
let foreignCourseId!: string;
/** A course of one task with six options: enough that orders rarely coincide. */
let shuffleCourseId!: string;
let letters!: string;
let shuffleTask!: string;
/** A vocabulary course: five words, one task each, in this order. */
let wordsCourseId!: string;
let words!: string[];
let wordTasks!: string[];
/** A second task for the fifth word. */
let fifthWordSibling!: string;
/** The first two words alone. */
let twoWordsCourseId!: string;
/** As many objectives as a learner may start in a day, in no course. */
let elsewhere!: string[];
const sixOptions: TaskBody = {
  kind: "choice",
  prompt: "Which letter?",
  options: ["a", "b", "c", "d", "e", "f"],
  answer: 0,
};

function activity(now: Date, learnerId = learner, course = courseId, host = installation) {
  return chooseNextActivity({ database, learnerId, courseId: course, host, now, timeZone: "UTC" });
}

async function decided(now: Date) {
  const next = await activity(now);
  if (next.kind !== "decided") throw new Error(`Expected an activity, got "${next.kind}".`);
  return next;
}

function answer(
  attemptId: string,
  taskId: string,
  choice: unknown,
  now: Date,
  options: { learnerId?: string; course?: string; host?: RequestHost } = {},
) {
  return submitAttempt({
    database,
    learnerId: options.learnerId ?? learner,
    courseId: options.course ?? courseId,
    host: options.host ?? installation,
    attemptId,
    taskId,
    response: { choice },
    now,
  });
}

/** The response stored under an attempt ID, as the learner sent it. */
async function responseOf(attemptId: string) {
  const [row] = await database
    .select({ response: attempt.response })
    .from(attempt)
    .where(eq(attempt.id, attemptId));
  return row?.response;
}

/** A presented choice task's options; anything else fails the test. */
function optionsOf(task: PresentedTask) {
  if (task.kind !== "choice") throw new Error(`Expected a choice task, got "${task.kind}".`);
  return task.options;
}

const stored = () =>
  readLearnerEvidence(database, { learnerId: learner, organizationId }, later(10_000));

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the learner loop", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner, classmate],
      at: start,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [outsider, learner],
      at: start,
    });
    await database
      .insert(organizationDomain)
      .values({ hostname: otherDomain.hostname, organizationId: otherOrganizationId })
      .onConflictDoNothing();

    [pastTense, untaught, fractions] = (await createObjectives(database, organizationId, [
      "Past tense",
      "Untaught",
      "Fractions",
    ])) as [string, string, string];
    courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Loop",
      objectiveIds: [pastTense, untaught, fractions],
    });
    untaughtCourseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Nothing to practise",
      objectiveIds: [untaught],
    });

    const task = (objectiveId: string, prompt: string, createdAt: Date) =>
      testing.createTask(database, {
        organizationId,
        objectiveId,
        body: question(prompt),
        createdAt,
      });
    pastTenseTask = await task(pastTense, "Past tense?", start);
    fractionsTasks = [
      await task(fractions, "First fraction?", start),
      await task(fractions, "Second fraction?", later(1)),
    ];

    [letters] = (await createObjectives(database, organizationId, ["Letters"])) as [string];
    shuffleCourseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Shuffle",
      objectiveIds: [letters],
    });
    shuffleTask = await testing.createTask(database, {
      organizationId,
      objectiveId: letters,
      body: sixOptions,
      createdAt: start,
    });

    words = await createObjectives(database, organizationId, [
      "eins",
      "zwei",
      "drei",
      "vier",
      "fünf",
    ]);
    wordsCourseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Words",
      objectiveIds: words,
    });
    twoWordsCourseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Two words",
      objectiveIds: words.slice(0, 2),
    });
    wordTasks = [];
    for (const word of words) wordTasks.push(await task(word, `${word}?`, start));
    fifthWordSibling = await task(words[4]!, "fünf, again?", later(1));
    elsewhere = await createObjectives(
      database,
      organizationId,
      Array.from({ length: NEW_OBJECTIVES_PER_DAY }, (_, i) => `Elsewhere ${i}`),
    );

    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignTask = await testing.createTask(database, {
      organizationId: otherOrganizationId,
      objectiveId: theirs!,
      body: question("Theirs?"),
      createdAt: start,
    });
    foreignCourseId = await createCourse(database, {
      published: true,
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirs!],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner, classmate, outsider]);
  });

  test("objective, task, answer, grade, evidence, next objective", async () => {
    const first = await decided(start);
    expect(first.decision).toMatchObject({ objectiveId: pastTense, intent: "introduce" });
    // The learner is shown the question, never the answer.
    expect(first.task).toEqual({
      id: pastTenseTask,
      kind: "choice",
      prompt: "Past tense?",
      // In whichever order they were shuffled into, each with its own choice.
      options: expect.arrayContaining([
        { choice: 0, text: "right" },
        { choice: 1, text: "wrong" },
      ]),
    });

    expect(await answer("a1", pastTenseTask, 1, later(1))).toEqual({
      kind: "graded",
      grade: { kind: "choice", outcome: "failure", correctChoice: 0 },
      // Written by hand, from no source.
      passages: [],
    });
    // Its one task rests, since the learner has just been shown the answer, so
    // the next objective is introduced meanwhile, skipping the one without a task.
    expect((await decided(later(2))).decision).toMatchObject({
      objectiveId: fractions,
      intent: "introduce",
    });
    expect((await decided(later(11))).decision).toMatchObject({
      objectiveId: pastTense,
      intent: "reteach",
    });

    await answer("a2", pastTenseTask, 0, later(12));
    // Untaught has no task, so selection moves past it rather than stopping.
    expect((await decided(later(13))).decision).toMatchObject({
      objectiveId: fractions,
      intent: "introduce",
    });

    expect(await stored()).toEqual([
      {
        id: `attempt:a1:${pastTense}`,
        objectiveId: pastTense,
        outcome: "failure",
        at: later(1),
      },
      {
        id: `attempt:a2:${pastTense}`,
        objectiveId: pastTense,
        outcome: "success",
        at: later(12),
      },
    ]);
  });

  test("keeps a task's option order across reloads, and reseeds it once answered", async () => {
    const shown = async (now: Date, learnerId = learner) => {
      const next = await activity(now, learnerId, shuffleCourseId);
      if (next.kind !== "decided" || next.task.kind !== "choice") {
        throw new Error(`Expected a choice task, got "${next.kind}".`);
      }
      return next.task.options;
    };
    // The documented seed: who, which task, and when they last answered it.
    const order = (lastAttemptAt: Date | null, learnerId = learner) =>
      optionsOf(
        presentTask(
          sixOptions,
          JSON.stringify([learnerId, shuffleTask, lastAttemptAt?.getTime() ?? null]),
        ),
      );

    expect(await shown(start)).toEqual(order(null));
    expect(await shown(later(5))).toEqual(order(null));
    expect(await shown(start, classmate)).toEqual(order(null, classmate));

    // Wrongly, so the task is asked again.
    await answer("s1", shuffleTask, 1, later(5), { course: shuffleCourseId });
    expect(await shown(later(15))).toEqual(order(later(5)));
    // A resend records nothing, so it is not a new asking either.
    await answer("s1", shuffleTask, 1, later(16), { course: shuffleCourseId });
    expect(await shown(later(17))).toEqual(order(later(5)));
  });

  test("neither rests a task nor reseeds its order for evidence graded elsewhere", async () => {
    const seededBy = (lastAttemptAt: Date) =>
      optionsOf(
        presentTask(sixOptions, JSON.stringify([learner, shuffleTask, lastAttemptAt.getTime()])),
      );
    await answer("s1", shuffleTask, 1, later(5), { course: shuffleCourseId });
    // Were the evidence an attempt at any of these minutes, the ten-minute rest
    // would hold the task at minute 21, and reseed its order. The task ID is
    // random, so take a minute whose order differs, or a reseed could go unseen.
    const at = [12, 13, 14, 15, 16, 17, 18, 19, 20]
      .map(later)
      .find((minute) => !isDeepStrictEqual(seededBy(minute), seededBy(later(5))));
    if (at === undefined) throw new Error("No minute reorders the options.");
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      { id: "elsewhere", objectiveId: letters, outcome: "failure", at },
    ]);
    expect(await stored()).toContainEqual({
      id: "elsewhere",
      objectiveId: letters,
      outcome: "failure",
      at,
    });

    expect(await activity(later(21), learner, shuffleCourseId)).toMatchObject({
      kind: "decided",
      task: { id: shuffleTask, options: seededBy(later(5)) },
    });
  });

  test("shows the passages a grounded task was written from, once it is graded", async () => {
    const [greetings] = await createObjectives(database, organizationId, ["Greetings"]);
    const greetingsCourse = await createCourse(database, {
      published: true,
      organizationId,
      title: "Greetings",
      objectiveIds: [greetings!],
    });
    const video = await createSource(database, {
      organizationId,
      title: "Los saludos",
      text: "Hola significa hello. Adiós significa goodbye.",
      url: "https://www.youtube.com/watch?v=abc123",
      createdAt: start,
    });
    const workbook = await createSource(database, {
      organizationId,
      title: "Cuaderno",
      text: "Di hola a tu compañero.",
      createdAt: start,
    });
    const [taskId] = await createTasks(
      database,
      organizationId,
      [
        {
          objectiveId: greetings!,
          body: question("Hola?"),
          citations: [
            { sourceId: video, start: 0, end: 21 },
            { sourceId: workbook, start: 0, end: 7 },
          ],
        },
      ],
      start,
    );

    // Before answering, the task alone: a passage could give the answer away.
    expect((await activity(start, learner, greetingsCourse)) as object).not.toHaveProperty(
      "passages",
    );
    expect(await answer("g1", taskId!, 1, later(1), { course: greetingsCourse })).toEqual({
      kind: "graded",
      grade: { kind: "choice", outcome: "failure", correctChoice: 0 },
      // By source title, each with where a learner can find it.
      passages: [
        { quote: "Di hola", source: { title: "Cuaderno" } },
        {
          quote: "Hola significa hello.",
          source: { title: "Los saludos", url: "https://www.youtube.com/watch?v=abc123" },
        },
      ],
    });
  });

  test("has no activity when the decision falls on an objective without a task, naming it", async () => {
    expect(await activity(start, learner, untaughtCourseId)).toEqual({
      kind: "no-activity",
      decision: { objectiveId: untaught, modelVersion: activeModel.version, intent: "introduce" },
      objective: { id: untaught, title: "Untaught" },
    });
  });

  test("has no activity, not caught up, once only an objective without a task is left", async () => {
    for (const [attemptId, taskId] of [
      ["p", pastTenseTask],
      ["f", fractionsTasks[0]],
    ] as const) {
      expect(await answer(attemptId, taskId, 0, start)).toMatchObject({
        grade: { outcome: "success" },
      });
    }

    // Past tense and fractions retained, and not due for days: untaught is next.
    expect(await activity(later(15))).toMatchObject({
      kind: "no-activity",
      objective: { id: untaught },
    });
  });

  test("is caught up when an objective with a task needs no attention", async () => {
    expect(await answer("s", shuffleTask, 0, start, { course: shuffleCourseId })).toMatchObject({
      grade: { outcome: "success" },
    });

    expect(await activity(later(15), learner, shuffleCourseId)).toEqual({ kind: "caught-up" });
  });

  test("is caught up when an objective without a task needs no attention", async () => {
    // Graded elsewhere: untaught has no task to answer here.
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      { id: "elsewhere", objectiveId: untaught, outcome: "success", at: start },
    ]);

    expect(await activity(later(15), learner, untaughtCourseId)).toEqual({ kind: "caught-up" });
  });

  test("rotates through an objective's tasks, least recently attempted first", async () => {
    await answer("p", pastTenseTask, 0, start);

    const [first, second] = fractionsTasks;
    expect((await decided(later(1))).task.id).toBe(first);

    await answer("f1", first, 1, later(2));
    expect((await decided(later(3))).task.id).toBe(second);

    await answer("f2", second, 1, later(4));
    // Both answered within the rest, so neither is asked until the first has rested.
    expect(await activity(later(5))).toMatchObject({ kind: "resting", retryAt: later(12) });
    expect((await decided(later(12))).task.id).toBe(first);
  });

  test("refuses a new answer to a task still resting, but not a resend of the same one", async () => {
    await answer("first", pastTenseTask, 1, start);

    // Straight after seeing the answer: refused, recording nothing.
    expect(await answer("too-early", pastTenseTask, 0, later(1))).toEqual({ kind: "resting" });
    // The first attempt, resent, is the same answer rather than another one.
    expect(await answer("first", pastTenseTask, 1, later(1))).toMatchObject({ kind: "graded" });
    expect(await stored()).toMatchObject([{ id: `attempt:first:${pastTense}` }]);

    // A fresh answer once the rest is over. Were the refused attempt's row left
    // behind, this would be refused too, for coming within ten minutes of it.
    expect(await answer("after-rest", pastTenseTask, 0, later(10))).toMatchObject({
      kind: "graded",
      grade: { outcome: "success" },
    });
    expect(await stored()).toMatchObject([
      { id: `attempt:first:${pastTense}` },
      { id: `attempt:after-rest:${pastTense}` },
    ]);

    // A resend of the first, after the second: still a resend, not another
    // answer. A reuse of its ID for a different answer is still a conflict.
    expect(await answer("first", pastTenseTask, 1, later(11))).toMatchObject({ kind: "graded" });
    expect(await answer("first", pastTenseTask, 0, later(11))).toEqual({ kind: "conflict" });
  });

  test("rests a task for the learner who answered it, and nobody else", async () => {
    await answer("mine", pastTenseTask, 1, start);

    expect(await activity(later(1), classmate)).toMatchObject({
      kind: "decided",
      task: { id: pastTenseTask },
    });
    expect(
      await answer("theirs", pastTenseTask, 0, later(1), { learnerId: classmate }),
    ).toMatchObject({ kind: "graded" });
  });

  describe("while a missed word rests", () => {
    const word = (attemptId: string, index: number, choice: number, now: Date) =>
      answer(attemptId, wordTasks[index]!, choice, now, { course: wordsCourseId });
    /** The word offered next, by index, or why there is none. */
    const offered = async (now: Date) => {
      const next = await activity(now, learner, wordsCourseId);
      return next.kind === "decided" ? words.indexOf(next.decision.objectiveId) : next.kind;
    };

    test("introduces the next words, and brings it back after three of them", async () => {
      expect(await word("missed", 0, 1, start)).toMatchObject({ grade: { outcome: "failure" } });
      expect(await offered(start)).toBe(1);

      await word("second", 1, 0, later(1));
      await word("third", 2, 0, later(2));
      // Two answers since: still resting, and an answer to it is refused.
      expect(await offered(later(2))).toBe(3);
      expect(await word("too-early", 0, 0, later(2))).toEqual({ kind: "resting" });

      await word("fourth", 3, 0, later(3));
      // Three: back before the fifth word, well within ten minutes.
      expect(await activity(later(3), learner, wordsCourseId)).toMatchObject({
        kind: "decided",
        decision: { objectiveId: words[0], intent: "reteach" },
      });
      expect(await word("recalled", 0, 0, later(3))).toMatchObject({
        grade: { outcome: "success" },
      });
      // A rest runs from the latest answer, not the first one already spaced out.
      expect(await word("again", 0, 0, later(4))).toEqual({ kind: "resting" });
    });

    test("waits for the rest that ends first once every word rests", async () => {
      const inTwoWords = { course: twoWordsCourseId };
      await answer("first", wordTasks[0]!, 1, start, inTwoWords);
      await answer("second", wordTasks[1]!, 1, later(1), inTwoWords);

      expect(await activity(later(2), learner, twoWordsCourseId)).toEqual({
        kind: "resting",
        objective: { id: words[0], title: "eins" },
        retryAt: later(10),
      });
      expect(await activity(later(10), learner, twoWordsCourseId)).toMatchObject({
        kind: "decided",
        decision: { objectiveId: words[0], intent: "reteach" },
      });
    });

    test("counts only new attempts here: no resend, outside evidence, or other organization", async () => {
      await word("missed", 0, 1, start);
      await word("second", 1, 0, later(1));
      await word("fourth", 3, 0, later(1));
      // Each of these, were it counted, would be the third answer.
      await word("fourth", 3, 0, later(2));
      await recordEvidence(database, { learnerId: learner, organizationId }, [
        { id: "elsewhere", objectiveId: words[2]!, outcome: "success", at: later(2) },
      ]);
      expect(
        await answer("theirs", foreignTask, 0, later(2), { course: foreignCourseId }),
      ).toMatchObject({ kind: "graded" });

      expect(await offered(later(3))).toBe(4);
      expect(await word("too-early", 0, 0, later(3))).toEqual({ kind: "resting" });
    });

    test("never counts another task of the same word", async () => {
      await word("missed", 4, 1, start);
      await word("first", 0, 0, later(1));
      await word("second", 1, 0, later(2));
      // Were the same word spacing, this would be the third.
      expect(
        await answer("sibling", fifthWordSibling, 0, later(3), { course: wordsCourseId }),
      ).toMatchObject({ kind: "graded" });

      expect(await word("too-early", 4, 0, later(4))).toEqual({ kind: "resting" });
    });
  });

  test("holds new words back once a day's worth were started at the organization, never a review", async () => {
    const inWords = (now: Date, timeZone = "UTC") =>
      chooseNextActivity({
        database,
        learnerId: learner,
        courseId: wordsCourseId,
        host: installation,
        now,
        timeZone,
      });
    // Missed at midnight on June 1, UTC, then twenty more started elsewhere.
    await answer("missed", wordTasks[0]!, 1, start, { course: wordsCourseId });
    await recordEvidence(
      database,
      { learnerId: learner, organizationId },
      elsewhere.map((objectiveId) => ({
        id: objectiveId,
        objectiveId,
        outcome: "success" as const,
        at: later(1),
      })),
    );

    // The missed word is reviewed past the limit...
    expect(await inWords(later(20))).toMatchObject({
      kind: "decided",
      decision: { objectiveId: words[0], intent: "reteach" },
    });
    await answer("recalled", wordTasks[0]!, 0, later(20), { course: wordsCourseId });
    // ...but the next word waits for tomorrow, rather than reading as caught up.
    expect(await inWords(later(21))).toEqual({
      kind: "daily-limit",
      limit: NEW_OBJECTIVES_PER_DAY,
    });
    // 03:30 on June 1 in UTC, still the night of May 31 there, is 05:30 in
    // Warsaw, past four: a new day.
    const beforeFourInUtc = new Date("2026-06-01T03:30:00Z");
    expect(await inWords(beforeFourInUtc)).toEqual({
      kind: "daily-limit",
      limit: NEW_OBJECTIVES_PER_DAY,
    });
    expect(await inWords(beforeFourInUtc, "Europe/Warsaw")).toMatchObject({
      kind: "decided",
      decision: { objectiveId: words[1], intent: "introduce" },
    });
  });

  test("lets a rest, then an objective without a task, show through the daily limit", async () => {
    await recordEvidence(
      database,
      { learnerId: learner, organizationId },
      elsewhere.map((objectiveId) => ({
        id: objectiveId,
        objectiveId,
        outcome: "success" as const,
        at: start,
      })),
    );
    await answer("missed", pastTenseTask, 1, later(1));
    // Graded elsewhere: started, and with no task to practise it.
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      { id: "untaught", objectiveId: untaught, outcome: "failure", at: later(1) },
    ]);

    // Fractions, not started, is held back; the past tense rests.
    expect(await activity(later(2))).toEqual({
      kind: "resting",
      objective: { id: pastTense, title: "Past tense" },
      retryAt: later(11),
    });

    await answer("recalled", pastTenseTask, 0, later(11));
    expect(await activity(later(12))).toMatchObject({
      kind: "no-activity",
      objective: { id: untaught },
    });
  });

  test("records a resubmitted attempt once, and answers it the same", async () => {
    const first = await answer("retry", pastTenseTask, 0, later(1));
    const again = await answer("retry", pastTenseTask, 0, later(2));

    expect(again).toEqual(first);
    // Dated by the first submission, not the retry.
    expect(await stored()).toMatchObject([{ id: `attempt:retry:${pastTense}`, at: later(1) }]);
  });

  test("grades a typed answer, records the text as sent, and matches a resend on it", async () => {
    const [word] = (await createObjectives(database, organizationId, ["To be"])) as [string];
    const wordCourse = await createCourse(database, {
      published: true,
      organizationId,
      title: "Typed",
      objectiveIds: [word],
    });
    const typedTask = await testing.createTask(database, {
      organizationId,
      objectiveId: word,
      body: { kind: "typed", prompt: "I am tired: Ich ___ müde.", accepted: ["bin"] },
      createdAt: start,
    });

    expect(await activity(start, learner, wordCourse)).toMatchObject({
      kind: "decided",
      task: { id: typedTask, kind: "typed", prompt: "I am tired: Ich ___ müde." },
    });
    const send = (text: string) =>
      submitAttempt({
        database,
        learnerId: learner,
        courseId: wordCourse,
        host: installation,
        attemptId: "typed",
        taskId: typedTask,
        response: { text },
        now: later(1),
      });
    const graded = {
      kind: "graded",
      grade: { kind: "typed", outcome: "success", correctAnswer: "bin" },
      passages: [],
    };
    expect(await send(" Bin ")).toEqual(graded);
    expect(await responseOf("typed")).toEqual({ text: " Bin " });

    // The same text again is the same attempt; another, though graded alike, is not.
    expect(await send(" Bin ")).toEqual(graded);
    expect(await send("bin")).toEqual({ kind: "conflict" });
  });

  test("records Show answer as a failure, and that it was asked", async () => {
    expect(
      await submitAttempt({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        attemptId: "shown",
        taskId: pastTenseTask,
        response: { reveal: true },
        now: later(1),
      }),
    ).toMatchObject({
      kind: "graded",
      grade: { kind: "choice", outcome: "failure", correctChoice: 0 },
    });
    expect(await stored()).toMatchObject([
      { id: `attempt:shown:${pastTense}`, outcome: "failure" },
    ]);
    expect(await responseOf("shown")).toEqual({ reveal: true });
  });

  test("answers a resend with the outcome recorded, not today's grade", async () => {
    // Recorded as a grader that has since changed would have: the right
    // option, graded a failure.
    await recordAttempt(database, {
      learnerId: learner,
      organizationId,
      attemptId: "regraded",
      taskId: pastTenseTask,
      response: { choice: 0 },
      at: later(1),
      restWindowStart: start,
      restAttempts: 3,
      evidence: { id: `attempt:regraded:${pastTense}`, objectiveId: pastTense, outcome: "failure" },
    });

    expect(await answer("regraded", pastTenseTask, 0, later(2))).toMatchObject({
      kind: "graded",
      grade: { kind: "choice", outcome: "failure", correctChoice: 0 },
    });
    expect(await stored()).toMatchObject([{ outcome: "failure", at: later(1) }]);
  });

  test("refuses an attempt ID reused for a different response", async () => {
    await answer("reused", pastTenseTask, 0, later(1));

    expect(await answer("reused", pastTenseTask, 1, later(2))).toEqual({ kind: "conflict" });
    expect(await stored()).toMatchObject([{ outcome: "success" }]);
  });

  test("refuses an attempt ID reused for a different task", async () => {
    const [first, second] = fractionsTasks;
    await answer("reused", first, 0, later(1));

    expect(await answer("reused", second, 0, later(2))).toEqual({ kind: "conflict" });
    expect(await stored()).toMatchObject([{ id: `attempt:reused:${fractions}`, at: later(1) }]);
  });

  test("keeps a learner's attempt IDs at two organizations apart", async () => {
    // Each organization's app names attempts on its own, so the same ID at both
    // is two attempts; and a retry here stays a retry while the other holds a
    // different answer under that ID.
    const theirs = await answer("shared", foreignTask, 1, later(1), { course: foreignCourseId });
    const mine = await answer("shared", pastTenseTask, 0, later(2));

    expect(theirs).toMatchObject({ kind: "graded", grade: { outcome: "failure" } });
    expect(mine).toMatchObject({ kind: "graded", grade: { outcome: "success" } });
    expect(await answer("shared", pastTenseTask, 0, later(3))).toEqual(mine);
    expect(await stored()).toMatchObject([{ id: `attempt:shared:${pastTense}`, at: later(2) }]);
  });

  test("records one of two disagreeing submissions that arrive at once", async () => {
    // The comparison must read what is stored after inserting, as for evidence
    // (persistence/evidence.test.ts): checked first, both would pass.
    for (let race = 0; race < 10; race++) {
      await testing.clearLearnerHistory(database, [learner]);
      const submitted = await Promise.all([
        answer("raced", pastTenseTask, 0, later(1)),
        answer("raced", pastTenseTask, 1, later(1)),
      ]);

      const kinds = submitted.map((result) => result.kind);
      expect(kinds.toSorted()).toEqual(["conflict", "graded"]);
      const winner = submitted.find((result) => result.kind === "graded");
      expect((await stored()).map((record) => record.outcome)).toEqual([
        winner?.kind === "graded" && winner.grade.outcome,
      ]);
    }
  });

  test("records a submission that races its own retry once", async () => {
    for (let race = 0; race < 10; race++) {
      await testing.clearLearnerHistory(database, [learner]);
      const submitted = await Promise.all([
        answer("retried", pastTenseTask, 0, later(1)),
        answer("retried", pastTenseTask, 0, later(1)),
      ]);

      expect(submitted.map((result) => result.kind)).toEqual(["graded", "graded"]);
      expect(await stored()).toHaveLength(1);
    }
  });

  test("bounds attempt IDs to 1–128 characters", async () => {
    expect(await answer("", pastTenseTask, 0, start)).toEqual({ kind: "invalid" });
    expect(await answer("x".repeat(129), pastTenseTask, 0, start)).toEqual({ kind: "invalid" });
    expect((await answer("x".repeat(128), pastTenseTask, 0, start)).kind).toBe("graded");
  });

  test("refuses a response that cannot answer the task, recording nothing", async () => {
    expect(await answer("bad", pastTenseTask, 7, start)).toEqual({ kind: "invalid" });
    expect(await stored()).toEqual([]);
  });

  test("refuses a task outside the course, and a learner outside its organization", async () => {
    expect(await answer("x1", foreignTask, 0, start)).toEqual({ kind: "unavailable" });
    // The learner's organization, but a course without the task's objective.
    expect(await answer("x4", pastTenseTask, 0, start, { course: untaughtCourseId })).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x2", pastTenseTask, 0, start, { learnerId: outsider })).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x3", pastTenseTask, 0, start, { course: "missing" })).toEqual({
      kind: "unavailable",
    });
    expect(await activity(start, outsider)).toEqual({ kind: "unavailable" });
    expect(await stored()).toEqual([]);
  });

  test("serves and grades nothing on another organization's domain", async () => {
    expect(await activity(start, learner, courseId, otherDomain)).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x5", pastTenseTask, 0, start, { host: otherDomain })).toEqual({
      kind: "unavailable",
    });
    expect(await stored()).toEqual([]);
  });
});
