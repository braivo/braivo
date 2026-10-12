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

function overview(viewedBy: string, courseId = shared) {
  return readCourseProgress({ database, viewedBy, courseId, host: installation, now });
}

function report(viewedBy: string, learnerId: string, courseId = shared) {
  return readLearnerProgress({ database, viewedBy, learnerId, courseId, host: installation, now });
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
    foreignCourse = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirs],
    });
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
    shared = await createCourse(database, {
      organizationId,
      title: "Shared",
      objectiveIds: [greetings],
    });
    untaught = await createCourse(database, {
      organizationId,
      title: "Untaught",
      objectiveIds: [greetings],
    });
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

      expect(await listGroups({ database, organizationId, actingAs: admin })).toEqual([
        {
          id: groupId,
          organizationId,
          name: "7A",
          learners: [
            { userId: ana, name: ana },
            { userId: ben, name: ben },
          ],
          teachers: [{ userId: teacherA, name: teacherA }],
          courses: [{ id: shared, title: "Shared" }],
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
          changeGroup({ database, organizationId, actingAs, groupId, change: { name: "Mine" } }),
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
      changeGroup({ database, organizationId, actingAs: admin, groupId: id, change: groupChange });
    const read = async () => (await listGroups({ database, organizationId, actingAs: admin }))[0];

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
        courses: [{ id: untaught, title: "Untaught" }],
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
          groupId: "no-such-group",
          change: { name: "Any" },
        }),
      ).rejects.toThrow(NotPermitted);
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
        (await listGroups({ database, organizationId, actingAs })).map(({ name }) => name);

      expect(await names(teacherA)).toEqual(["7A"]);
      expect(await names(ana)).toEqual([]);
      expect(await names(admin)).toEqual(["7A", "7B"]);
      await expect(listGroups({ database, organizationId, actingAs: stranger })).rejects.toThrow(
        NotPermitted,
      );
    });

    test("shows a teacher the overview of their groups' learners alone, counted as their reports", async () => {
      const read = await overview(teacherA);

      if (read.kind !== "assessed") throw new Error("No overview");
      expect(read.overview.learners).toEqual([
        {
          userId: ana,
          name: ana,
          standings: { unseen: 0, acquiring: 0, retained: 1, due: 0 },
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

    test("keeps another group's learners, other courses, and other members from a teacher", async () => {
      expect(await report(teacherA, ben)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, cleo)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, ana, untaught)).toEqual({ kind: "unavailable" });
      expect(await overview(teacherA, untaught)).toEqual({ kind: "unavailable" });
      // A learner is taught, never teaches.
      expect(await overview(ana)).toEqual({ kind: "unavailable" });
      expect(await report(ana, ben)).toEqual({ kind: "unavailable" });
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

    test("ends a teacher's access when the course leaves the group, and keeps the history", async () => {
      const [group] = await listGroups({ database, organizationId, actingAs: teacherA });
      await changeGroup({
        database,
        organizationId,
        actingAs: admin,
        groupId: group!.id,
        change: { remove: { courseIds: [shared] } },
      });

      expect(await overview(teacherA)).toEqual({ kind: "unavailable" });
      expect(await report(teacherA, ana)).toEqual({ kind: "unavailable" });
      expect(await report(ana, ana)).toMatchObject({ kind: "assessed" });
    });

    test("ends a teacher's access to a learner removed from the group, then the removed teacher's", async () => {
      const [group] = await listGroups({ database, organizationId, actingAs: teacherA });
      const remove = (userIds: string[]) =>
        changeGroup({
          database,
          organizationId,
          actingAs: admin,
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

      await expect(listGroups({ database, organizationId, actingAs: teacherA })).rejects.toThrow(
        NotPermitted,
      );
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
