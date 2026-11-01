// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Evidence } from "../learning/index.ts";
import {
  createCourse,
  createObjectives,
  ConflictingKey,
  type GroupChange,
  ConflictingGroupRole,
  type GroupDefinition,
  recordEvidence,
} from "../persistence/index.ts";
import type { AccessKind } from "./access.ts";
import { readCourseProgress } from "./course-progress.ts";
import { changeGroup, defineGroup, listGroups } from "./groups.ts";
import { readLearnerProgress } from "./learner-progress.ts";
import { InvalidDefinition } from "./objectives.ts";
import { NotPermitted } from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "groups-test-org";
const otherOrganizationId = "groups-test-other-org";
const admin = "groups-test-admin";
/** Teaches 7A, and nothing about 7B. */
const teacherA = "groups-test-teacher-a";
/** Teaches 7B. */
const teacherB = "groups-test-teacher-b";
const ana = "groups-test-ana";
const ben = "groups-test-ben";
/** A member in no group. */
const cleo = "groups-test-cleo";
/** A member of the other organization only. */
const stranger = "groups-test-stranger";
const installation = { hostname: "localhost", installation: true };
const now = new Date("2026-06-01T00:00:00.000Z");

let greetings!: string;
/** Taken by both groups. */
let shared!: string;
/** Taken by neither group. */
let untaught!: string;
let foreignCourse!: string;

const definition = (overrides: Partial<GroupDefinition> = {}): GroupDefinition => ({
  name: "7A",
  learnerIds: [ana],
  teacherIds: [teacherA],
  courseIds: [shared],
  ...overrides,
});

function overview(viewedBy: string, courseId = shared, accessKind: AccessKind = "browser") {
  return readCourseProgress({
    database,
    viewedBy,
    accessKind,
    courseId,
    host: installation,
    now,
  });
}

function report(
  viewedBy: string,
  learnerId: string,
  courseId = shared,
  accessKind: AccessKind = "browser",
) {
  return readLearnerProgress({
    database,
    viewedBy,
    accessKind,
    learnerId,
    courseId,
    host: installation,
    now,
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("groups", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [stranger],
      at: now,
    });
    const [theirs] = (await createObjectives(database, otherOrganizationId, ["Theirs"])) as [
      string,
    ];
    foreignCourse = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Theirs",
        objectiveIds: [theirs],
      })
    ).id;
  });

  beforeEach(async () => {
    // Fresh each test: removing a member, below, must not leak into the next.
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [teacherA, teacherB, ana, ben, cleo],
      adminIds: [admin],
      at: now,
    });
    [greetings] = (await createObjectives(database, organizationId, ["Greetings"])) as [string];
    shared = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Shared",
        objectiveIds: [greetings],
      })
    ).id;
    untaught = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Untaught",
        objectiveIds: [greetings],
      })
    ).id;
    await testing.clearLearnerHistory(database, [ana, ben, cleo]);
  });

  describe("defining", () => {
    test("creates a group an administrator lists, its people and courses by name", async () => {
      const groupId = await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: definition({ name: "  7A  ", learnerIds: [ben, ana] }),
      });

      expect(
        await listGroups({ database, organizationId, actingAs: admin, accessKind: "browser" }),
      ).toEqual([
        {
          id: groupId,
          organizationId,
          name: "7A",
          learners: [
            { userId: ana, name: ana },
            { userId: ben, name: ben },
          ],
          teachers: [{ userId: teacherA, name: teacherA }],
          courses: [
            { id: shared, number: expect.any(Number), title: "Shared", urlLabel: "shared" },
          ],
        },
      ]);
    });

    test("is an administrator's act alone", async () => {
      const groupId = await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: definition(),
      });
      for (const actingAs of [teacherA, ana, stranger]) {
        await expect(
          defineGroup({ database, organizationId, actingAs, definition: definition() }),
        ).rejects.toThrow(NotPermitted);
        await expect(
          changeGroup({
            database,
            organizationId,
            actingAs,
            accessKind: "browser",
            groupId,
            change: { name: "Mine" },
          }),
        ).rejects.toThrow(NotPermitted);
      }
    });

    // Thunks: the table is built before `beforeAll` makes the courses.
    test.each<[string, () => Partial<GroupDefinition>, RegExp]>([
      ["a blank name", () => ({ name: "  " }), /has a name that is blank/],
      ["an ID twice", () => ({ learnerIds: [ana, ana] }), /lists "groups-test-ana" twice/],
      [
        "one person in both roles",
        () => ({ learnerIds: [ana], teacherIds: [ana] }),
        /as a learner and a teacher/,
      ],
      ["someone not a member", () => ({ learnerIds: [stranger] }), /who is not a member/],
      [
        "another organization's course",
        () => ({ courseIds: [foreignCourse] }),
        /not one of the organization's/,
      ],
      [
        "a course that does not exist",
        () => ({ courseIds: ["no-such-course"] }),
        /not one of the organization's/,
      ],
    ])("refuses %s, saying so", async (_, overrides, message) => {
      const defining = defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: definition(overrides()),
      });
      await expect(defining).rejects.toThrow(InvalidDefinition);
      await expect(defining).rejects.toThrow(message);
    });

    test("returns the group created the same under its key, changed since or not, and refuses another", async () => {
      const define = (overrides: Partial<GroupDefinition> = {}) =>
        defineGroup({
          database,
          organizationId,
          actingAs: admin,
          key: "7a",
          definition: definition(overrides),
        });

      const groupId = await define({ learnerIds: [ana, ben] });
      // The same sets in another order are the same request.
      expect(await define({ learnerIds: [ben, ana] })).toBe(groupId);
      // A retry is compared with the creation, not with the group as it is now.
      await changeGroup({
        database,
        organizationId,
        actingAs: admin,
        accessKind: "browser",
        groupId,
        change: { remove: { userIds: [ben] } },
      });
      expect(await define({ learnerIds: [ana, ben] })).toBe(groupId);
      // Nor with the organization as it is now: someone in it may have left.
      await database
        .delete(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, ana)));
      expect(await define({ learnerIds: [ana, ben] })).toBe(groupId);
      await expect(define({ learnerIds: [ben] })).rejects.toThrow(ConflictingKey);
    });
  });

  describe("changing", () => {
    let groupId!: string;
    const change = (groupChange: GroupChange, id = groupId) =>
      changeGroup({
        database,
        organizationId,
        actingAs: admin,
        accessKind: "browser",
        groupId: id,
        change: groupChange,
      });
    const read = async () =>
      (await listGroups({ database, organizationId, actingAs: admin, accessKind: "browser" }))[0];

    beforeEach(async () => {
      groupId = await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: definition(),
      });
    });

    test("renames, adds, and removes what it names, leaving the rest, and answers the group", async () => {
      const changed = await change({
        name: "7A, spring",
        add: { learnerIds: [ben], courseIds: [untaught] },
        remove: { courseIds: [shared] },
      });

      expect(changed).toEqual(await read());
      expect(changed).toMatchObject({
        name: "7A, spring",
        learners: [
          { userId: ana, name: ana },
          { userId: ben, name: ben },
        ],
        teachers: [{ userId: teacherA, name: teacherA }],
        courses: [
          { id: untaught, number: expect.any(Number), title: "Untaught", urlLabel: "untaught" },
        ],
      });
    });

    test("changes nothing more sent again at once, and applies again after another change", async () => {
      const removeAna = { remove: { userIds: [ana] } };
      await change(removeAna);
      await change(removeAna);
      expect((await read())?.learners).toEqual([]);

      // A retry is not deduplicated: after someone adds Ana back, it removes
      // Ana again. The last change's word is final.
      await change({ add: { learnerIds: [ana] } });
      await change(removeAna);
      expect((await read())?.learners).toEqual([]);
    });

    test("changes a role only when the change removes and adds the person", async () => {
      // A learner listed among teachers by mistake would read their classmates' progress.
      const promoting = change({ add: { teacherIds: [ana] } });
      await expect(promoting).rejects.toThrow(ConflictingGroupRole);
      await expect(promoting).rejects.toThrow(/already a learner in the group/);
      expect((await read())?.learners).toEqual([{ userId: ana, name: ana }]);

      expect(
        await change({ remove: { userIds: [ana] }, add: { teacherIds: [ana] } }),
      ).toMatchObject({
        learners: [],
        teachers: [
          { userId: ana, name: ana },
          { userId: teacherA, name: teacherA },
        ],
      });
      // In the role they hold, adding them again changes nothing.
      expect((await change({ add: { teacherIds: [ana] } }))?.teachers).toHaveLength(2);
    });

    test.each<[string, () => GroupChange, RegExp]>([
      ["a blank name", () => ({ name: " " }), /has a name that is blank/],
      [
        "one person added in both roles",
        () => ({ add: { learnerIds: [ben], teacherIds: [ben] } }),
        /as a learner and a teacher/,
      ],
      ["a change naming nothing", () => ({ add: {}, remove: {} }), /names nothing to change/],
      ["an ID twice", () => ({ remove: { userIds: [ana, ana] } }), /twice in remove.userIds/],
      ["adding a non-member", () => ({ add: { learnerIds: [stranger] } }), /not a member/],
      [
        "adding another organization's course",
        () => ({ add: { courseIds: [foreignCourse] } }),
        /not one of the organization's/,
      ],
    ])("refuses %s, saying so", async (_, groupChange, message) => {
      const changing = change(groupChange());
      await expect(changing).rejects.toThrow(InvalidDefinition);
      await expect(changing).rejects.toThrow(message);
    });

    test("answers no group for one the organization does not have, and refuses a non-administrator first", async () => {
      expect(await change({ name: "Any" }, "no-such-group")).toBeUndefined();
      await expect(
        changeGroup({
          database,
          organizationId,
          actingAs: teacherA,
          accessKind: "browser",
          groupId: "no-such-group",
          change: { name: "Any" },
        }),
      ).rejects.toThrow(NotPermitted);
    });

    test("refuses a tool while the organization does not allow it, before reading its people or groups (access-45)", async () => {
      const asTool = (groupChange: GroupChange, id = groupId) =>
        changeGroup({
          database,
          organizationId,
          actingAs: admin,
          accessKind: "tool",
          groupId: id,
          change: groupChange,
        });
      await testing.setToolsReadLearnerData(database, organizationId, false);

      await expect(asTool({ name: "Renamed" })).rejects.toThrow(NotPermitted);
      // Not a 400 naming the non-member, nor a 404 for the missing group.
      await expect(asTool({ add: { learnerIds: [stranger] } })).rejects.toThrow(NotPermitted);
      await expect(asTool({ name: "Any" }, "no-such-group")).rejects.toThrow(NotPermitted);
      // What reads nothing still says what is wrong with the change.
      for (const invalid of [
        {},
        { name: "  " },
        { add: { learnerIds: [ana, ana] } },
        { add: { learnerIds: [ben], teacherIds: [ben] } },
      ]) {
        await expect(asTool(invalid)).rejects.toThrow(InvalidDefinition);
      }
      expect((await read())?.name).toBe("7A");

      await testing.setToolsReadLearnerData(database, organizationId, true);
      expect(await asTool({ name: "Renamed" })).toMatchObject({ name: "Renamed" });
      await expect(asTool({ add: { learnerIds: [stranger] } })).rejects.toThrow(InvalidDefinition);
      expect(await asTool({ name: "Any" }, "no-such-group")).toBeUndefined();
    });
  });

  describe("teaching", () => {
    beforeEach(async () => {
      await defineGroup({ database, organizationId, actingAs: admin, definition: definition() });
      await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: { name: "7B", learnerIds: [ben], teacherIds: [teacherB], courseIds: [shared] },
      });
      const success: Evidence = { id: "e1", objectiveId: greetings, outcome: "success", at: now };
      await recordEvidence(database, { learnerId: ana, organizationId }, [success]);
      await recordEvidence(database, { learnerId: ben, organizationId }, [success]);
    });

    test("lists a teacher the groups they teach, another member none, an administrator all", async () => {
      const names = async (actingAs: string) =>
        (await listGroups({ database, organizationId, actingAs, accessKind: "browser" })).map(
          ({ name }) => name,
        );

      expect(await names(teacherA)).toEqual(["7A"]);
      expect(await names(ana)).toEqual([]);
      expect(await names(admin)).toEqual(["7A", "7B"]);
      await expect(
        listGroups({ database, organizationId, actingAs: stranger, accessKind: "browser" }),
      ).rejects.toThrow(NotPermitted);
    });

    test("lists a tool groups only while the organization allows it, and no more than its person's (access-45)", async () => {
      const names = async (actingAs: string, accessKind: AccessKind) =>
        (await listGroups({ database, organizationId, actingAs, accessKind })).map(
          ({ name }) => name,
        );
      await testing.setToolsReadLearnerData(database, organizationId, false);
      for (const actingAs of [admin, teacherA]) {
        await expect(
          listGroups({ database, organizationId, actingAs, accessKind: "tool" }),
        ).rejects.toThrow(NotPermitted);
      }

      await testing.setToolsReadLearnerData(database, organizationId, true);
      expect(await names(admin, "tool")).toEqual(["7A", "7B"]);
      expect(await names(teacherA, "tool")).toEqual(["7A"]);
      await expect(
        listGroups({ database, organizationId, actingAs: stranger, accessKind: "tool" }),
      ).rejects.toThrow(NotPermitted);
    });

    test("shows a teacher the overview of their groups' learners alone, counted as their reports", async () => {
      const read = await overview(teacherA);

      if (read.kind !== "assessed") throw new Error("No overview");
      expect(read.overview.learners).toEqual([
        {
          userId: ana,
          name: ana,
          standings: { unseen: 0, acquiring: 0, retained: 1, due: 0 },
          repeatedMisses: 0,
          lastPractisedAt: null,
        },
      ]);
      // Counted over that learner alone, not the organization.
      expect(read.overview.objectives[0]?.standings).toEqual({
        unseen: 0,
        acquiring: 0,
        retained: 1,
        due: 0,
      });
      expect(await report(teacherA, ana)).toMatchObject({ kind: "assessed" });
    });

    test("names to a teacher the repeated misses of their groups' learners alone", async () => {
      const failures = (learnerId: string) =>
        recordEvidence(
          database,
          { learnerId, organizationId },
          [1, 2, 3].map((index) => ({
            id: `miss-${index}`,
            objectiveId: greetings,
            outcome: "failure" as const,
            // At the moment of the success each learner has here, "e1", and
            // after it in replay's order, which ties by ID.
            at: now,
          })),
        );
      await failures(ana);
      await failures(ben);

      for (const [teacher, learner] of [
        [teacherA, ana],
        [teacherB, ben],
      ] as const) {
        const read = await overview(teacher);
        if (read.kind !== "assessed") throw new Error("No overview");
        expect(read.overview.objectives[0]?.repeatedMisses.map(({ userId }) => userId)).toEqual([
          learner,
        ]);
        expect(
          read.overview.learners.map(({ userId, repeatedMisses }) => [userId, repeatedMisses]),
        ).toEqual([[learner, 1]]);
      }
      // Taught in a second group of the same teacher, still named once.
      await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: definition({ name: "Support", learnerIds: [ana] }),
      });
      const read = await overview(teacherA);
      expect(read.kind === "assessed" && read.overview.objectives[0]?.repeatedMisses).toMatchObject(
        [{ userId: ana, misses: { count: 3 } }],
      );
    });

    test("keeps another group's learners, other courses, and other members from a teacher", async () => {
      expect(await report(teacherA, ben)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, cleo)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, ana, untaught)).toEqual({ kind: "unavailable" });
      expect(await overview(teacherA, untaught)).toEqual({ kind: "unavailable" });
      // A learner is taught, never teaches.
      expect(await overview(ana)).toEqual({ kind: "unavailable" });
      expect(await report(ana, ben)).toEqual({ kind: "unavailable" });
    });

    test("shows a teacher's tool their groups' progress only while the organization allows it (access-45)", async () => {
      await testing.setToolsReadLearnerData(database, organizationId, false);
      expect(await overview(teacherA, shared, "tool")).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, ana, shared, "tool")).toEqual({ kind: "unavailable" });

      await testing.setToolsReadLearnerData(database, organizationId, true);
      expect(await overview(teacherA, shared, "tool")).toEqual(await overview(teacherA));
      expect(await report(teacherA, ana, shared, "tool")).toMatchObject({ kind: "assessed" });
      // The setting adds no reader: another group's learner stays out of reach.
      expect(await report(teacherA, ben, shared, "tool")).toEqual({ kind: "unavailable" });
    });

    test("shows a teacher of several groups taking a course their learners together, each once", async () => {
      await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: definition({ name: "Support", learnerIds: [ana, ben] }),
      });

      const read = await overview(teacherA);

      if (read.kind !== "assessed") throw new Error("No overview");
      expect(read.overview.learners.map(({ userId }) => userId)).toEqual([ana, ben]);
      expect(read.overview.objectives[0]?.standings).toMatchObject({ retained: 2 });
      expect(await report(teacherA, ben)).toMatchObject({ kind: "assessed" });
    });

    test("leaves an administrator's view the whole organization", async () => {
      const read = await overview(admin);

      if (read.kind !== "assessed") throw new Error("No overview");
      expect(read.overview.learners.map(({ userId }) => userId).sort()).toEqual(
        [admin, ana, ben, cleo, teacherA, teacherB].sort(),
      );
    });

    test("lists a member who leaves no longer, and again with their practice on rejoining", async () => {
      await recordEvidence(database, { learnerId: cleo, organizationId }, [
        { id: "attempt:1:greetings", objectiveId: greetings, outcome: "success", at: now },
      ]);
      const cleoPractised = async () => {
        const read = await overview(admin);
        if (read.kind !== "assessed") throw new Error("No overview");
        return read.overview.learners.find(({ userId }) => userId === cleo)?.lastPractisedAt;
      };
      expect(await cleoPractised()).toEqual(now);

      await database
        .delete(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, cleo)));
      expect(await cleoPractised()).toBeUndefined();

      // Rejoining brings their evidence back, never deleted with the membership.
      await database.insert(member).values({
        id: `${organizationId}:${cleo}`,
        organizationId,
        userId: cleo,
        role: "member",
        createdAt: now,
      });
      expect(await cleoPractised()).toEqual(now);
    });

    test("ends a teacher's access when the course leaves the group, and keeps the history", async () => {
      const [group] = await listGroups({
        database,
        organizationId,
        actingAs: teacherA,
        accessKind: "browser",
      });
      await changeGroup({
        database,
        organizationId,
        actingAs: admin,
        accessKind: "browser",
        groupId: group!.id,
        change: { remove: { courseIds: [shared] } },
      });

      expect(await overview(teacherA)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, ana)).toEqual({ kind: "unavailable" });
      expect(await report(ana, ana)).toMatchObject({ kind: "assessed" });
    });

    test("ends a teacher's access to a learner removed from the group, then the removed teacher's", async () => {
      const [group] = await listGroups({
        database,
        organizationId,
        actingAs: teacherA,
        accessKind: "browser",
      });
      const remove = (userIds: string[]) =>
        changeGroup({
          database,
          organizationId,
          actingAs: admin,
          accessKind: "browser",
          groupId: group!.id,
          change: { remove: { userIds } },
        });

      await remove([ana]);
      expect(await report(teacherA, ana)).toEqual({ kind: "unavailable" });
      expect(await overview(teacherA)).toMatchObject({ overview: { learners: [] } });

      await remove([teacherA]);
      expect(await overview(teacherA)).toEqual({ kind: "unavailable" });
    });

    test("ends a teacher's access when they leave the organization", async () => {
      await database
        .delete(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, teacherA)));

      await expect(
        listGroups({ database, organizationId, actingAs: teacherA, accessKind: "browser" }),
      ).rejects.toThrow(NotPermitted);
      expect(await overview(teacherA)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, ana)).toEqual({ kind: "unavailable" });
    });

    test("shows a teacher an empty overview of a group with no learners yet", async () => {
      await defineGroup({
        database,
        organizationId,
        actingAs: admin,
        definition: { name: "New", learnerIds: [], teacherIds: [cleo], courseIds: [untaught] },
      });

      const read = await overview(cleo, untaught);
      if (read.kind !== "assessed") throw new Error("No overview");
      expect(read.overview.learners).toEqual([]);
      expect(read.overview.objectives[0]?.standings).toEqual({
        unseen: 0,
        acquiring: 0,
        retained: 0,
        due: 0,
      });
    });
  });
});
