// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { course, courseObjective, objective, organization, task } from "@braivo/db/schema";
import {
  sharedDatabase,
  clearLearningData,
  seedOrganization,
  violatedConstraint,
} from "@braivo/db/testing";
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  createCourse,
  readCourseObjectives,
  readCourseOrganization,
  readCourses,
  updateCourseUrlLabel,
} from "./course.ts";
import { createObjectives } from "./objective.ts";
import { markPublished } from "./publication.ts";
import { createTasks, markTasksRetired } from "./task.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "course-test-org";
const otherOrganizationId = "course-test-other-org";
const organizationIds = [organizationId, otherOrganizationId];
const createdAt = new Date("2026-01-01T00:00:00.000Z");

/** Until some statement like `pattern` (SQL `like`) waits for another transaction's lock. */
async function waitForLock(pattern: string): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    const waiting = await database.execute(sql`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like ${pattern}`);
    if (waiting.rows.length > 0) return;
    await Bun.sleep(20);
  }
  throw new Error(`No statement like ${pattern} waited for a lock.`);
}

/** Requires TEST_DATABASE_URL, since the point is that the schema really applies. */
describe.skipIf(!connectionString)("courses", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    for (const id of organizationIds) {
      await seedOrganization(database, { organizationId: id, learnerIds: [], at: createdAt });
    }
  });

  beforeEach(async () => {
    for (const id of organizationIds) {
      await clearLearningData(database, id);
    }
  });

  test("lists an organization's own courses by title", async () => {
    const [objectiveId] = await createObjectives(database, organizationId, ["Past tense"]);
    const [theirObjective] = await createObjectives(database, otherOrganizationId, ["Past tense"]);
    const addCourse = (owner: string, title: string, objectiveId: string) =>
      createCourse(database, {
        published: true,
        organizationId: owner,
        title,
        objectiveIds: [objectiveId],
      });
    const zulu = await addCourse(organizationId, "Zulu", objectiveId!);
    const alpha = await addCourse(organizationId, "Alpha", objectiveId!);
    await addCourse(otherOrganizationId, "Mike", theirObjective!);

    expect(await readCourses(database, organizationId)).toEqual([
      { id: alpha, number: expect.any(Number), title: "Alpha", urlLabel: "alpha", published: true },
      { id: zulu, number: expect.any(Number), title: "Zulu", urlLabel: "zulu", published: true },
    ]);
  });

  describe("numbers", () => {
    /** Fills `from` to `to` with courses of the organization, as many years of them would. */
    const occupy = (from: number, to: number) =>
      database.execute(sql`
        insert into ${course} (id, organization_id, title, number)
        select gen_random_uuid()::text, ${organizationId}, 'Earlier', n
        from generate_series(${from}::integer, ${to}::integer) n`);
    const numberOf = async (courseId: string) =>
      (await readCourses(database, organizationId)).find(({ id }) => id === courseId)?.number;

    test("are four digits, each course's its own within the organization", async () => {
      const created = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          createCourse(database, {
            published: true,
            organizationId,
            title: `Course ${index}`,
            objectiveIds: [],
          }),
        ),
      );
      const numbers = (await readCourses(database, organizationId)).map(({ number }) => number);

      expect(numbers).toHaveLength(created.length);
      expect(new Set(numbers).size).toBe(created.length);
      for (const number of numbers) expect(number).toSatisfy((n) => n >= 1000 && n <= 9999);
    });

    test("go to five digits once four are taken", async () => {
      await occupy(1000, 9998);

      const last = await createCourse(database, {
        published: true,
        organizationId,
        title: "Last",
        objectiveIds: [],
      });
      const next = await createCourse(database, {
        published: true,
        organizationId,
        title: "Next",
        objectiveIds: [],
      });

      expect(await numberOf(last)).toBe(9999);
      expect(await numberOf(next)).toSatisfy((n) => n !== undefined && n >= 10000 && n <= 99999);
    });

    test("are drawn again when another creator took the same one meanwhile", async () => {
      await occupy(1000, 9998);
      let created: Promise<string> | undefined;

      await database.transaction(async (other) => {
        await other.execute(sql`
          insert into ${course} (id, organization_id, title, number)
          values (gen_random_uuid()::text, ${organizationId}, 'Other', 9999)`);
        // Draws 9999 too, unseen until this commits, then waits on the index.
        created = createCourse(database, {
          published: true,
          organizationId,
          title: "Mine",
          objectiveIds: [],
        });
        await waitForLock('insert into "course"%');
      });

      expect(await numberOf(await created!)).toBeGreaterThanOrEqual(10000);
    });

    test("go past the largest once five digits are taken too", async () => {
      await occupy(1000, 99999);

      const courseId = await createCourse(database, {
        published: true,
        organizationId,
        title: "Late",
        objectiveIds: [],
      });

      expect(await numberOf(courseId)).toBe(100000);
    });

    test("stay as they were when a course is added again under its key", async () => {
      const add = () =>
        createCourse(database, {
          published: true,
          organizationId,
          title: "Keyed",
          objectiveIds: [],
          key: "keyed",
        });
      const courseId = await add();
      const number = await numberOf(courseId);

      expect(await add()).toBe(courseId);
      expect(await numberOf(courseId)).toBe(number);
    });
  });

  test("adds a course once under a key, however many add it at once", async () => {
    const add = () =>
      createCourse(database, {
        published: true,
        organizationId,
        title: "Keyed",
        objectiveIds: [],
        key: "at-once",
      });

    const ids = await Promise.all([add(), add(), add()]);

    expect(new Set(ids).size).toBe(1);
    expect(await readCourses(database, organizationId)).toEqual([
      {
        id: ids[0],
        number: expect.any(Number),
        title: "Keyed",
        urlLabel: "keyed",
        published: true,
      },
    ]);
  });

  describe("url labels", () => {
    const create = () =>
      createCourse(database, {
        published: true,
        organizationId,
        title: "Everyday English",
        objectiveIds: [],
      });
    const labelOf = async (courseId: string) =>
      (await readCourses(database, organizationId)).find(({ id }) => id === courseId)?.urlLabel;
    const update = (courseId: string, urlLabel: string, previous: string) =>
      updateCourseUrlLabel(database, { organizationId, courseId, urlLabel, previous });

    test("are the title's until set, over the label read, a retry saved too", async () => {
      const courseId = await create();
      expect(await labelOf(courseId)).toBe("everyday-english");

      expect(await update(courseId, "english-a1", "everyday-english")).toEqual({ saved: true });
      expect(await update(courseId, "english-a1", "everyday-english")).toEqual({ saved: true });
      expect(await labelOf(courseId)).toBe("english-a1");
    });

    test("are kept when changed since the label read, saying what they are now", async () => {
      const courseId = await create();
      await update(courseId, "english-a1", "everyday-english");

      expect(await update(courseId, "english-b1", "everyday-english")).toEqual({
        saved: false,
        urlLabel: "english-a1",
      });
      expect(await labelOf(courseId)).toBe("english-a1");
    });

    test("let one of two edits over the same label win, the other told of it", async () => {
      const courseId = await create();
      let mine: ReturnType<typeof update> | undefined;

      await database.transaction(async (other) => {
        await other.update(course).set({ urlLabel: "english-a1" }).where(eq(course.id, courseId));
        // Reads the label only once theirs commits, not the one before it.
        mine = update(courseId, "english-b1", "everyday-english");
        await waitForLock(`select %from "course"%for update`);
      });

      expect(await mine).toEqual({ saved: false, urlLabel: "english-a1" });
      expect(await labelOf(courseId)).toBe("english-a1");
    });

    test("may repeat across courses, and reach no other organization's course", async () => {
      const [first, second] = [await create(), await create()];
      expect([await labelOf(first), await labelOf(second)]).toEqual([
        "everyday-english",
        "everyday-english",
      ]);

      expect(
        await updateCourseUrlLabel(database, {
          organizationId: otherOrganizationId,
          courseId: first,
          urlLabel: "theirs",
          previous: "everyday-english",
        }),
      ).toBeUndefined();
      expect(await labelOf(first)).toBe("everyday-english");
    });
  });

  test("returns its objectives in the order given, not by title or ID", async () => {
    // Titles chosen so that alphabetical order is not the order asked for: if
    // position were being ignored, this would come back sorted.
    const [zulu, alpha, mike] = await createObjectives(database, organizationId, [
      "Zulu",
      "Alpha",
      "Mike",
    ]);
    const courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Ordered",
      objectiveIds: [mike!, zulu!, alpha!],
    });

    expect(await readCourseObjectives(database, courseId)).toEqual([mike!, zulu!, alpha!]);
  });

  test("lets one objective sit at a different position in each course", async () => {
    // A course orders objectives, it does not own them — the same knowledge
    // taught in two courses is still one objective and one estimate.
    const [alpha, bravo] = await createObjectives(database, organizationId, ["Alpha", "Bravo"]);
    const first = await createCourse(database, {
      published: true,
      organizationId,
      title: "First",
      objectiveIds: [alpha!, bravo!],
    });
    const second = await createCourse(database, {
      published: true,
      organizationId,
      title: "Second",
      objectiveIds: [bravo!, alpha!],
    });

    expect(await readCourseObjectives(database, first)).toEqual([alpha!, bravo!]);
    expect(await readCourseObjectives(database, second)).toEqual([bravo!, alpha!]);
  });

  test("refuses the same objective twice in one course", async () => {
    const [alpha] = await createObjectives(database, organizationId, ["Alpha"]);

    const error = await createCourse(database, {
      published: true,
      organizationId,
      title: "Duplicated",
      objectiveIds: [alpha!, alpha!],
    }).catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_pkey");
  });

  test("refuses to arrange another organization's objective", async () => {
    // Plain foreign keys would accept this, since both rows exist. Matching the
    // organization on both references is what refuses it — otherwise selection
    // could hand a learner an objective from an organization they have nothing
    // to do with, and authorizing the course alone would not have caught it.
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);

    const error = await createCourse(database, {
      published: true,
      organizationId,
      title: "Borrowed",
      objectiveIds: [theirs!],
    }).catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_objective_fk");
  });

  test("refuses two objectives at the same position in one course", async () => {
    // `createCourse` never writes this, so only a direct insert can show the
    // database refusing it.
    const [alpha, bravo] = await createObjectives(database, organizationId, ["Alpha", "Bravo"]);
    const courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Clash",
      objectiveIds: [alpha!],
    });

    const error = await database
      .insert(courseObjective)
      .values({ organizationId, courseId, objectiveId: bravo!, position: 0 })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_position_uidx");
  });

  test("refuses to attach an objective to another organization's course", async () => {
    // The other half of matching organizations: the objective is this
    // organization's, and the course is not.
    const [mine] = await createObjectives(database, organizationId, ["Mine"]);
    const theirs = await createCourse(database, {
      published: true,
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [],
    });

    const error = await database
      .insert(courseObjective)
      .values({ organizationId, courseId: theirs, objectiveId: mine!, position: 0 })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_course_fk");
  });

  test("refuses to delete an objective a course uses, but not the course", async () => {
    const [objectiveId] = await createObjectives(database, organizationId, ["Past tense"]);
    const courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Grammar",
      objectiveIds: [objectiveId!],
    });
    const deleteObjective = () => database.delete(objective).where(eq(objective.id, objectiveId!));

    const error = await deleteObjective().catch((thrown: unknown) => thrown);
    expect(violatedConstraint(error)).toBe("course_objective_objective_fk");

    await database.delete(course).where(eq(course.id, courseId));
    expect(
      await database.select().from(courseObjective).where(eq(courseObjective.courseId, courseId)),
    ).toEqual([]);
    await deleteObjective();
  });

  test("refuses to delete an organization that still owns a course", async () => {
    await createCourse(database, {
      published: true,
      organizationId,
      title: "Empty",
      objectiveIds: [],
    });

    const error = await database
      .delete(organization)
      .where(eq(organization.id, organizationId))
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_organization_id_organization_id_fkey");
  });

  test("rolls the course back when its objectives cannot be attached", async () => {
    // A course that lost its membership is not a shorter course; selection would
    // read it as a course with nothing left to teach.
    const error = await createCourse(database, {
      published: true,
      organizationId,
      title: "Doomed",
      objectiveIds: ["no-such-objective"],
    }).catch((thrown: unknown) => thrown);

    // Assert which insert failed: without this the table would also be empty if
    // creation had failed before the course row was ever written.
    expect(violatedConstraint(error)).toBe("course_objective_objective_fk");
    expect(
      await database.select().from(course).where(eq(course.organizationId, organizationId)),
    ).toEqual([]);
  });

  test("allows a course with no objectives yet", async () => {
    const courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Empty",
      objectiveIds: [],
    });

    expect(await readCourseObjectives(database, courseId)).toEqual([]);
  });

  test("returns nothing for a course that does not exist", async () => {
    expect(await readCourseObjectives(database, "no-such-course")).toEqual([]);
  });

  test("reports which organization owns a course", async () => {
    const courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Owned",
      objectiveIds: [],
    });

    expect(await readCourseOrganization(database, courseId)).toEqual({
      organizationId,
      published: true,
    });
  });

  test("publishes an organization's courses all or none, keeping when each first was", async () => {
    const add = (title: string, published = false) =>
      createCourse(database, { published, organizationId, title, objectiveIds: [] });
    const waiting = await add("Waiting");
    const also = await add("Also waiting");
    const theirs = await createCourse(database, {
      published: false,
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [],
    });
    const publishedAt = async (courseId: string) =>
      (
        await database
          .select({ at: course.publishedAt })
          .from(course)
          .where(eq(course.id, courseId))
      )[0]!.at;
    expect(await readCourseOrganization(database, waiting)).toEqual({
      organizationId,
      published: false,
    });

    const now = new Date("2026-02-01T00:00:00.000Z");
    // Another organization's course among them: nothing is published.
    expect(
      await markPublished(database, {
        organizationId,
        courseIds: [waiting, theirs],
        taskIds: [],
        now,
      }),
    ).toBe(false);
    expect(await publishedAt(waiting)).toBeNull();

    expect(
      await markPublished(database, {
        organizationId,
        courseIds: [waiting, also, waiting],
        taskIds: [],
        now,
      }),
    ).toBe(true);
    expect(await publishedAt(waiting)).toEqual(now);
    expect(await publishedAt(also)).toEqual(now);
    // Again later: when it first was stays.
    const later = new Date("2026-03-01T00:00:00.000Z");
    expect(
      await markPublished(database, {
        organizationId,
        courseIds: [waiting],
        taskIds: [],
        now: later,
      }),
    ).toBe(true);
    expect(await publishedAt(waiting)).toEqual(now);
  });

  test("publishes a course with its tasks, or neither when a task was retired since", async () => {
    const [objectiveId] = (await createObjectives(database, organizationId, ["Reviewed"])) as [
      string,
    ];
    const proposed = await createCourse(database, {
      published: false,
      organizationId,
      title: "Proposed",
      objectiveIds: [objectiveId],
    });
    const now = new Date("2026-02-01T00:00:00.000Z");
    const [kept, withdrawn] = (await createTasks(
      database,
      organizationId,
      ["Kept", "Withdrawn"].map((prompt) => ({
        objectiveId,
        body: { kind: "choice", prompt, options: ["a", "b"], answer: 0 },
      })),
      now,
      { published: false },
    )) as [string, string];
    await markTasksRetired(database, [withdrawn], now, { byTool: true });
    const states = async () => [
      (await readCourseOrganization(database, proposed))?.published,
      ...(await database.select({ at: task.publishedAt }).from(task).where(eq(task.id, kept))).map(
        ({ at }) => at !== null,
      ),
    ];

    const publish = (taskIds: string[]) =>
      markPublished(database, { organizationId, courseIds: [proposed], taskIds, now });
    expect(await publish([kept, withdrawn])).toBe(false);
    expect(await states()).toEqual([false, false]);
    expect(await publish([kept])).toBe(true);
    expect(await states()).toEqual([true, true]);
  });

  test("reports no owner for a course that does not exist", async () => {
    expect(await readCourseOrganization(database, "no-such-course")).toBeUndefined();
  });
});
