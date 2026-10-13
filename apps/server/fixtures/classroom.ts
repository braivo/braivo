// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createDatabase, type Database } from "@braivo/db";

import {
  addSource,
  chooseNextActivity,
  citeSources,
  defineCourse,
  defineGroup,
  defineObjectives,
  defineTasks,
  nameNewLearner,
  readAuthoredCourse,
  readCourseProgress,
  registerLearnDomain,
} from "../application/index.ts";
import { addMember, type Auth, createAuth, createOwnedOrganization } from "../auth/index.ts";

/**
 * A classroom to develop against: a small Fernwood school whose administrator,
 * teacher, and learner sign in as anyone does, by a code, to a course made
 * through the same use cases the console calls. The development demo serves it
 * (docs/guides/demo.md); a test may seed it too. Synthetic people on a reserved
 * domain; no history, so what a report shows is what was practised.
 */

/**
 * Bumped when an existing demo can no longer serve as this scenario's
 * baseline, never for a migration or a wording change: a demo seeded under
 * another version is refused, not patched.
 */
export const SCENARIO_VERSION = 1;

const ORGANIZATION = { name: "Fernwood School", slug: "fernwood" } as const;

/** Its learn app, served locally as any `<slug>.localhost` is (ADR 0004). */
export const LEARN_HOSTNAME = "fernwood.localhost";

/** Who to sign in as, and what each may do as seeded (ADR 0042 for the teacher). */
export const PERSONAS = {
  administrator: {
    email: "admin@fernwood.example",
    name: "Morgan Hale",
    scope: "owns Fernwood School: administers it, reads every member's progress",
  },
  teacher: {
    email: "teacher@fernwood.example",
    name: "Jordan Price",
    scope: "teaches Class A English: reads its learner's progress in Everyday English",
  },
  learner: {
    email: "learner@fernwood.example",
    name: "Sam Nowak",
    scope: "learns in Class A English: practises Everyday English on the learn app",
  },
} as const;

/** What the scenario made, by its own names for them; the IDs are generated. */
export type ClassroomHandles = {
  organization: string;
  administrator: string;
  teacherClassA: string;
  learner: string;
  courseEnglish: string;
  groupClassA: string;
};

const SOURCE = {
  title: "Fernwood reader: everyday English",
  text: `Saying hello

In the morning, people often say "Good morning" when they meet. Later in the day, "Good afternoon" is more usual, and "Good evening" is said after about six o'clock.

Asking politely

To ask for something politely, add "please": "Could I have a glass of water, please?" When someone helps you, say "Thank you".

Saying goodbye

When you leave, you can say "Goodbye" or, more casually, "See you later".
`,
};

const OBJECTIVES = [
  {
    key: "greetings",
    title: "Greet someone for the time of day",
    quote: `In the morning, people often say "Good morning" when they meet.`,
    tasks: [
      {
        prompt: "It is eight in the morning and you meet your teacher. What do you say?",
        options: ["Good morning", "Good evening", "Goodbye"],
        answer: 0,
        quote: `In the morning, people often say "Good morning"`,
      },
      {
        prompt: "It is seven in the evening. Which greeting fits?",
        options: ["Good afternoon", "Good evening"],
        answer: 1,
        quote: `"Good evening" is said after about six o'clock`,
      },
    ],
  },
  {
    key: "polite-requests",
    title: "Ask for something politely",
    quote: `To ask for something politely, add "please"`,
    tasks: [
      {
        prompt: "Which request is polite?",
        options: ["Give me water.", "Could I have a glass of water, please?"],
        answer: 1,
        quote: `"Could I have a glass of water, please?"`,
      },
      {
        prompt: "Someone helps you. What do you say?",
        options: ["Thank you", "Goodbye"],
        answer: 0,
        quote: `When someone helps you, say "Thank you".`,
      },
    ],
  },
  {
    key: "goodbyes",
    title: "Say goodbye",
    quote: `When you leave, you can say "Goodbye" or, more casually, "See you later".`,
    tasks: [
      {
        prompt: "You are leaving a friend's house. What can you say?",
        options: ["See you later", "Good morning"],
        answer: 0,
        quote: `more casually, "See you later"`,
      },
    ],
  },
] as const;

/**
 * Seeds the classroom into a migrated database with no organizations, at
 * `now`, through the use cases the apps call, the administrator acting.
 */
async function seedClassroom(input: {
  database: Database;
  auth: Auth;
  /** `BRAIVO_URL`. */
  baseUrl: string;
  now: Date;
}): Promise<ClassroomHandles> {
  const { database, auth, baseUrl, now } = input;

  // As a learn domain's code makes an account, verified, then named (ADR 0018).
  const account = async ({ email, name }: { email: string; name: string }) => {
    const { user } = await auth.api.verifiedAccount({ body: { email } });
    await nameNewLearner({ database, userId: user.id, name, now });
    return user.id;
  };
  const administrator = await account(PERSONAS.administrator);
  const teacher = await account(PERSONAS.teacher);
  const learner = await account(PERSONAS.learner);

  const created = await createOwnedOrganization(auth, { ...ORGANIZATION, ownerId: administrator });
  if (typeof created === "string") throw new Error(`Fernwood was not created: ${created}.`);
  const organizationId = created.id;
  // A teacher is a member until a group says whom they teach (ADR 0042).
  for (const { email } of [PERSONAS.teacher, PERSONAS.learner]) {
    await addMember(auth, { slug: ORGANIZATION.slug, email, role: "member" });
  }
  await registerLearnDomain({
    database,
    baseUrl,
    organizationSlug: ORGANIZATION.slug,
    hostname: LEARN_HOSTNAME,
  });

  const authoring = { database, organizationId, actingAs: administrator };
  const sourceId = await addSource({ ...authoring, ...SOURCE, language: "en", now });
  const objectiveIds = await defineObjectives({
    ...authoring,
    objectives: OBJECTIVES.map(({ key, title }) => ({ key, title })),
  });
  const objectiveId = (index: number) => objectiveIds[index]!;
  await citeSources({
    ...authoring,
    citations: OBJECTIVES.map(({ quote }, index) => ({
      objectiveId: objectiveId(index),
      sourceId,
      quote,
    })),
  });
  await defineTasks({
    ...authoring,
    tasks: OBJECTIVES.flatMap(({ tasks }, index) =>
      tasks.map(({ quote, ...body }) => ({
        objectiveId: objectiveId(index),
        body: { kind: "choice", ...body },
        citations: [{ sourceId, quote }],
      })),
    ),
    now,
  });
  const courseEnglish = await defineCourse({
    ...authoring,
    key: "everyday-english",
    title: "Everyday English",
    objectiveIds,
  });
  const groupClassA = await defineGroup({
    ...authoring,
    key: "class-a-english",
    definition: {
      name: "Class A English",
      learnerIds: [learner],
      teacherIds: [teacher],
      courseIds: [courseEnglish],
    },
  });

  return {
    organization: organizationId,
    administrator,
    teacherClassA: teacher,
    learner,
    courseEnglish,
    groupClassA,
  };
}

/**
 * Seeds the classroom into the migrated, empty database at `databaseUrl`, and
 * checks it is the baseline, in a pool of its own: what a new demo runs.
 */
export async function prepareClassroom(input: {
  databaseUrl: string;
  authSecret: string;
  /** `BRAIVO_URL`. */
  baseUrl: string;
  now: Date;
}): Promise<ClassroomHandles> {
  const { databaseUrl, authSecret, baseUrl, now } = input;
  const database = createDatabase(databaseUrl);
  try {
    const auth = createAuth({
      database,
      secret: authSecret,
      baseURL: baseUrl,
      sendMail: () => Promise.reject(new Error("Seeding sends no email.")),
    });
    const handles = await seedClassroom({ database, auth, baseUrl, now });
    await checkClassroomBaseline({ database, handles, now });
    return handles;
  } finally {
    await database.$client.end();
  }
}

/**
 * Proves a freshly seeded classroom is the baseline it claims, through the use
 * cases the apps call: who reads whose progress, that every task cites its
 * source, and that the learner has a task to practise now. Throws what failed.
 */
async function checkClassroomBaseline(input: {
  database: Database;
  handles: ClassroomHandles;
  now: Date;
}): Promise<void> {
  const { database, handles, now } = input;
  const failures: string[] = [];
  const check = (holds: boolean, failure: string) => {
    if (!holds) failures.push(failure);
  };
  const installation = { hostname: "localhost", installation: true };
  const reportFor = async (viewedBy: string) => {
    const progress = await readCourseProgress({
      database,
      viewedBy,
      courseId: handles.courseEnglish,
      host: installation,
      now,
    });
    return progress.kind === "assessed"
      ? new Set(progress.overview.learners.map(({ userId }) => userId))
      : undefined;
  };
  const exactly = (found: Set<string> | undefined, expected: string[]) =>
    found?.size === expected.length && expected.every((id) => found.has(id));

  check(
    exactly(await reportFor(handles.administrator), [
      handles.administrator,
      handles.teacherClassA,
      handles.learner,
    ]),
    "the administrator does not read every member's progress",
  );
  check(
    exactly(await reportFor(handles.teacherClassA), [handles.learner]),
    "the teacher does not read exactly their group's learner",
  );
  check((await reportFor(handles.learner)) === undefined, "the learner reads the course's report");

  const course = await readAuthoredCourse({
    database,
    organizationId: handles.organization,
    actingAs: handles.administrator,
    courseId: handles.courseEnglish,
  });
  check(
    course?.objectives.length === OBJECTIVES.length &&
      course.objectives.every(
        ({ citations, tasks }, index) =>
          citations.length > 0 &&
          tasks.length === OBJECTIVES[index]!.tasks.length &&
          tasks.every((task) => task.citations.length > 0),
      ),
    "the course's objectives and tasks are not all there, each citing its source",
  );

  const next = await chooseNextActivity({
    database,
    learnerId: handles.learner,
    courseId: handles.courseEnglish,
    host: { hostname: LEARN_HOSTNAME, installation: false },
    now,
    timeZone: "UTC",
  });
  check(next.kind === "decided", `the learner has no task to practise at ${LEARN_HOSTNAME}`);

  if (failures.length > 0) {
    throw new Error(`The classroom is not its baseline: ${failures.join("; ")}.`);
  }
}
