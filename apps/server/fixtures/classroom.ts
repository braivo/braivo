// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createDatabase, type Database } from "@braivo/db";
import { member, organization, user } from "@braivo/db/schema";
import { eq, inArray } from "drizzle-orm";

import {
  addSource,
  chooseNextActivity,
  citeSources,
  type CourseProgressOverview,
  defineCourse,
  defineGroup,
  defineObjectives,
  defineTasks,
  nameNewLearner,
  readAuthoredCourse,
  readCourseProgress,
  registerLearnDomain,
  submitAttempt,
} from "../application/index.ts";
import { addMember, type Auth, createAuth, createOwnedOrganization } from "../auth/index.ts";

/**
 * A classroom to develop against: a small Fernwood school whose administrator,
 * teacher, and two learners sign in as anyone does, by a code, to a course made
 * through the same use cases the console calls. The development demo serves it
 * (docs/guides/demo.md); a test may seed it too. Synthetic people on a reserved
 * domain. The learners practised before the anchor, through the learn app's use
 * cases, so the two take different paths from there: one answered every
 * objective right the first time, the other is offered again what they missed.
 */

/**
 * Bumped when an existing demo can no longer serve as this scenario's
 * baseline, never for a migration or a wording change: a demo seeded under
 * another version is refused, not patched.
 */
export const SCENARIO_VERSION = 2;

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
    scope: "teaches Class A English: reads its learners' progress in Everyday English",
  },
  sam: {
    email: "sam@fernwood.example",
    name: "Sam Nowak",
    scope: "learns in Class A English: missed a polite request, practises it again next",
  },
  zofia: {
    email: "zofia@fernwood.example",
    name: "Zofia Wójcik",
    scope: "learns in Class A English: answered all three right, reviews once due",
  },
} as const;

/** What the scenario made, by its own names for them; the IDs are generated. */
export type ClassroomHandles = {
  organization: string;
  administrator: string;
  teacherClassA: string;
  sam: string;
  zofia: string;
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

// Each objective's typed task comes second, so a learner who misses the first
// is asked next to recall, not recognize.
const OBJECTIVES = [
  {
    key: "greetings",
    title: "Greet someone for the time of day",
    quote: `In the morning, people often say "Good morning" when they meet.`,
    tasks: [
      {
        kind: "choice",
        prompt: "It is eight in the morning and you meet your teacher. What do you say?",
        options: ["Good morning", "Good evening", "Goodbye"],
        answer: 0,
        quote: `In the morning, people often say "Good morning"`,
      },
      {
        kind: "typed",
        prompt: `It is seven in the evening. Complete the greeting: "Good ___"`,
        accepted: ["evening"],
        answerLanguage: "en",
        quote: `"Good evening" is said after about six o'clock`,
      },
      {
        kind: "choice",
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
        kind: "choice",
        prompt: "Which request is polite?",
        options: ["Give me water.", "Could I have a glass of water, please?"],
        answer: 1,
        quote: `"Could I have a glass of water, please?"`,
      },
      {
        kind: "typed",
        prompt: `Complete the polite request: "Could I have a glass of water, ___?"`,
        accepted: ["please"],
        answerLanguage: "en",
        quote: `To ask for something politely, add "please"`,
      },
      {
        kind: "choice",
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
        kind: "choice",
        prompt: "You are leaving a friend's house. What can you say?",
        options: ["See you later", "Good morning"],
        answer: 0,
        quote: `more casually, "See you later"`,
      },
      {
        kind: "typed",
        prompt: `Complete the casual goodbye: "See you ___"`,
        accepted: ["later"],
        answerLanguage: "en",
        quote: `more casually, "See you later"`,
      },
    ],
  },
] as const;

type ObjectiveKey = (typeof OBJECTIVES)[number]["key"];
type FixtureTask = (typeof OBJECTIVES)[number]["tasks"][number];

/**
 * What each learner practised, in order: the objective the learn app decided
 * on, how they answered the task it offered, and, where the scenario promises
 * one, the task's kind. Sam misses a greeting, types one right when asked
 * again, then misses a polite request, so the learn app asks for that again
 * next; Zofia gets each right the first time.
 */
const PRACTICE = {
  sam: [
    { objective: "greetings", answer: "wrong" },
    { objective: "greetings", answer: "right", kind: "typed" },
    { objective: "polite-requests", answer: "wrong" },
  ],
  zofia: [
    { objective: "greetings", answer: "right" },
    { objective: "polite-requests", answer: "right" },
    { objective: "goodbyes", answer: "right" },
  ],
} as const satisfies Record<string, readonly PracticeStep[]>;

type PracticeStep = {
  objective: ObjectiveKey;
  answer: "right" | "wrong";
  kind?: "choice" | "typed";
};

// Before the anchor: the people and content were created, then Sam and later
// Zofia practised, a minute an answer.
const CREATED_BEFORE_MS = 2 * 60 * 60_000;
const PRACTISED_BEFORE_MS = { sam: 60 * 60_000, zofia: 30 * 60_000 };
const PRACTICE_STEP_MS = 60_000;

/** The host the learners practise on. */
const LEARN_HOST = { hostname: LEARN_HOSTNAME, installation: false };

/**
 * Seeds the classroom into a migrated database with no organizations, at
 * `now`, through the use cases the apps call, the administrator acting. What
 * the practice depends on is dated before it: the source and tasks by their
 * use cases; the people, organization, and memberships by the fixture.
 */
async function seedClassroom(input: {
  database: Database;
  auth: Auth;
  /** `BRAIVO_URL`. */
  baseUrl: string;
  now: Date;
}): Promise<ClassroomHandles> {
  const { database, auth, baseUrl, now } = input;
  const before = (ms: number) => new Date(now.getTime() - ms);

  // As a learn domain's code makes an account, verified, then named (ADR 0018).
  const account = async ({ email, name }: { email: string; name: string }) => {
    const { user } = await auth.api.verifiedAccount({ body: { email } });
    await nameNewLearner({ database, userId: user.id, name, now });
    return user.id;
  };
  const administrator = await account(PERSONAS.administrator);
  const teacher = await account(PERSONAS.teacher);
  const sam = await account(PERSONAS.sam);
  const zofia = await account(PERSONAS.zofia);

  const created = await createOwnedOrganization(auth, { ...ORGANIZATION, ownerId: administrator });
  if (typeof created === "string") throw new Error(`Fernwood was not created: ${created}.`);
  const organizationId = created.id;
  // A teacher is a member until a group says whom they teach (ADR 0042).
  for (const { email } of [PERSONAS.teacher, PERSONAS.sam, PERSONAS.zofia]) {
    await addMember(auth, { slug: ORGANIZATION.slug, email, role: "member" });
  }
  // Better Auth dates these when made and takes no time, so the fixture dates
  // them back itself; signing in by code makes no `account` row to date.
  const people = [administrator, teacher, sam, zofia];
  const createdAt = before(CREATED_BEFORE_MS);
  await database.update(user).set({ createdAt }).where(inArray(user.id, people));
  await database.update(organization).set({ createdAt }).where(eq(organization.id, organizationId));
  await database.update(member).set({ createdAt }).where(eq(member.organizationId, organizationId));
  await registerLearnDomain({
    database,
    baseUrl,
    organizationSlug: ORGANIZATION.slug,
    hostname: LEARN_HOSTNAME,
  });

  const authoring = { database, organizationId, actingAs: administrator };
  const sourceId = await addSource({ ...authoring, ...SOURCE, language: "en", now: createdAt });
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
  const fixtureTasks = OBJECTIVES.flatMap(({ tasks }): readonly FixtureTask[] => tasks);
  // Stored in this order, which is the order each objective offers them in (learner-loop-6).
  const taskIds = await defineTasks({
    ...authoring,
    tasks: OBJECTIVES.flatMap(({ tasks }, index) =>
      tasks.map(({ quote, ...body }) => ({
        objectiveId: objectiveId(index),
        body,
        citations: [{ sourceId, quote }],
      })),
    ),
    now: createdAt,
    // As the console writes them: the demo's learners practise them.
    byTool: false,
  });
  const courseEnglish = await defineCourse({
    ...authoring,
    key: "everyday-english",
    title: "Everyday English",
    objectiveIds,
    // As the console's review publishes it: the demo's learners practise it.
    published: true,
  });
  const groupClassA = await defineGroup({
    ...authoring,
    key: "class-a-english",
    definition: {
      name: "Class A English",
      learnerIds: [sam, zofia],
      teacherIds: [teacher],
      courseIds: [courseEnglish],
    },
  });

  const practice = {
    database,
    courseId: courseEnglish,
    objectiveKeys: new Map(OBJECTIVES.map(({ key }, index) => [objectiveId(index), key])),
    tasks: new Map(taskIds.map((id, index) => [id, fixtureTasks[index]!] as const)),
  };
  await practise({
    ...practice,
    learnerId: sam,
    steps: PRACTICE.sam,
    from: before(PRACTISED_BEFORE_MS.sam),
  });
  await practise({
    ...practice,
    learnerId: zofia,
    steps: PRACTICE.zofia,
    from: before(PRACTISED_BEFORE_MS.zofia),
  });

  return {
    organization: organizationId,
    administrator,
    teacherClassA: teacher,
    sam,
    zofia,
    courseEnglish,
    groupClassA,
  };
}

/**
 * Practises as the learn app does, a step a minute from `from`: asks for the
 * next activity, then answers its task. Throws when the app offers other than
 * the step names, or grades the answer otherwise.
 */
async function practise(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  objectiveKeys: ReadonlyMap<string, ObjectiveKey>;
  tasks: ReadonlyMap<string, FixtureTask>;
  steps: readonly PracticeStep[];
  from: Date;
}): Promise<void> {
  const { database, learnerId, courseId, objectiveKeys, tasks, steps, from } = input;
  for (const [index, step] of steps.entries()) {
    const now = new Date(from.getTime() + index * PRACTICE_STEP_MS);
    const next = await chooseNextActivity({
      database,
      learnerId,
      courseId,
      host: LEARN_HOST,
      now,
      timeZone: "UTC",
    });
    const offered =
      next.kind === "decided"
        ? `${objectiveKeys.get(next.objective.id)} (${next.task.kind})`
        : next.kind;
    if (
      next.kind !== "decided" ||
      objectiveKeys.get(next.objective.id) !== step.objective ||
      (step.kind !== undefined && next.task.kind !== step.kind)
    ) {
      const wanted = step.kind === undefined ? step.objective : `${step.objective} (${step.kind})`;
      throw new Error(`Practice step ${index} was offered ${offered}, not ${wanted}.`);
    }
    const task = tasks.get(next.task.id)!;
    let response;
    if (step.answer === "right") {
      response = task.kind === "choice" ? { choice: task.answer } : { text: task.accepted[0] };
    } else if (task.kind === "choice") {
      response = { choice: task.answer === 0 ? 1 : 0 };
    } else {
      throw new Error(`Practice step ${index} has no wrong answer written for a typed task.`);
    }
    const submitted = await submitAttempt({
      database,
      learnerId,
      courseId,
      host: LEARN_HOST,
      attemptId: crypto.randomUUID(),
      taskId: next.task.id,
      response,
      now,
    });
    const expected = step.answer === "right" ? "success" : "failure";
    if (submitted.kind !== "graded" || submitted.grade.outcome !== expected) {
      throw new Error(`Practice step ${index} was not graded a ${expected}.`);
    }
  }
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

/** Where the report counts a learner's objectives: not started, learning, retained, due. */
type StandingCounts = CourseProgressOverview["learners"][number]["standings"];

/**
 * Proves a freshly seeded classroom is the baseline it claims, through the use
 * cases the apps call: who reads whose progress, that every task cites its
 * source, where each learner stands, and what each practises next. Throws
 * what failed.
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
      ? new Map(progress.overview.learners.map(({ userId, standings }) => [userId, standings]))
      : undefined;
  };
  const exactly = (found: Map<string, unknown> | undefined, expected: string[]) =>
    found?.size === expected.length && expected.every((id) => found.has(id));

  check(
    exactly(await reportFor(handles.administrator), [
      handles.administrator,
      handles.teacherClassA,
      handles.sam,
      handles.zofia,
    ]),
    "the administrator does not read every member's progress",
  );
  const teacherReport = await reportFor(handles.teacherClassA);
  check(
    exactly(teacherReport, [handles.sam, handles.zofia]),
    "the teacher does not read exactly their group's learners",
  );
  check((await reportFor(handles.sam)) === undefined, "a learner reads the course's report");
  const hasStandings = (learnerId: string, expected: StandingCounts) => {
    const found = teacherReport?.get(learnerId);
    return (
      found !== undefined &&
      found.unseen === expected.unseen &&
      found.acquiring === expected.acquiring &&
      found.retained === expected.retained &&
      found.due === expected.due
    );
  };
  check(
    hasStandings(handles.sam, { unseen: 1, acquiring: 1, retained: 1, due: 0 }),
    "Sam does not stand at one objective retained, one learning, one not started",
  );
  check(
    hasStandings(handles.zofia, { unseen: 0, acquiring: 0, retained: 3, due: 0 }),
    "Zofia does not stand at three objectives retained",
  );

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

  const nextFor = (learnerId: string) =>
    chooseNextActivity({
      database,
      learnerId,
      courseId: handles.courseEnglish,
      host: LEARN_HOST,
      now,
      timeZone: "UTC",
    });
  const samNext = await nextFor(handles.sam);
  check(
    samNext.kind === "decided" &&
      samNext.decision.intent === "reteach" &&
      samNext.objective.id === course?.objectives[1]?.id &&
      samNext.task.kind === "typed",
    `Sam is not asked again, by typing it, how to ask politely at ${LEARN_HOSTNAME}`,
  );
  check((await nextFor(handles.zofia)).kind === "caught-up", "Zofia is not caught up");

  if (failures.length > 0) {
    throw new Error(`The classroom is not its baseline: ${failures.join("; ")}.`);
  }
}
