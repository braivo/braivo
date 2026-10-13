// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import {
  changeOf,
  conflictingUserIds,
  definitionOf,
  edited,
  NO_EDITS,
  outstanding,
} from "./group-edits.ts";

const group = {
  name: "7A · English",
  teachers: [{ userId: "t1", name: "Tess" }],
  learners: [
    { userId: "l1", name: "Lee" },
    { userId: "l2", name: "Lou" },
  ],
  courses: [{ id: "c1", number: 1000, title: "Beginners", urlLabel: "beginners" }],
};

describe("a group form's change", () => {
  test("names nothing when nothing differs, including edits undone or repeating the group", () => {
    expect(changeOf(group, group.name, NO_EDITS)).toBeUndefined();
    expect(
      changeOf(group, group.name, {
        people: { t1: "teacher", l1: "learner", x: null },
        courses: { c1: true, c2: false },
      }),
    ).toBeUndefined();
  });

  test("names only what differs from the group as loaded", () => {
    expect(
      changeOf(group, "7A", {
        people: { l3: "learner", l2: null, t2: "teacher" },
        courses: { c2: true, c1: false },
      }),
    ).toEqual({
      name: "7A",
      add: { teacherIds: ["t2"], learnerIds: ["l3"], courseIds: ["c2"] },
      remove: { userIds: ["l2"], courseIds: ["c1"] },
    });
  });

  test("changes a role by removing and adding the person in one change", () => {
    expect(changeOf(group, group.name, { people: { l1: "teacher" }, courses: {} })).toEqual({
      add: { teacherIds: ["l1"] },
      remove: { userIds: ["l1"] },
    });
  });

  test("drops what the group, reloaded, already holds, keeping the rest", () => {
    const edits = { people: { l3: "learner", t2: "teacher" }, courses: {} } as const;
    const reloaded = { ...group, learners: [...group.learners, { userId: "l3", name: "Lia" }] };
    expect(changeOf(reloaded, group.name, edits)).toEqual({ add: { teacherIds: ["t2"] } });
  });
});

test("shows the group with the edits applied, and defines a new one from them alone", () => {
  const edits = {
    people: { l1: "teacher", l2: null, l3: "learner" },
    courses: { c2: true },
  } as const;
  expect(edited(group, edits)).toEqual({
    teacherIds: ["t1", "l1"],
    learnerIds: ["l3"],
    courseIds: ["c1", "c2"],
  });
  expect(definitionOf("7B", edits)).toEqual({
    name: "7B",
    teacherIds: ["l1"],
    learnerIds: ["l3"],
    courseIds: ["c2"],
  });
});

describe("edits carried onto a reloaded group", () => {
  test("drop what was undone, so it is never sent as a new change", () => {
    // Lee made a teacher, then a learner again; Lia added. Meanwhile someone
    // removed Lee and the course: the reloaded group must not get them back.
    const edits = outstanding(group, {
      people: { l1: "learner", l3: "learner" },
      courses: { c1: true },
    });
    expect(edits).toEqual({ people: { l3: "learner" }, courses: {} });
    const reloaded = { ...group, learners: [{ userId: "l2", name: "Lou" }], courses: [] };
    expect(changeOf(reloaded, group.name, outstanding(reloaded, edits))).toEqual({
      add: { learnerIds: ["l3"] },
    });
  });

  test("drop what someone else already did", () => {
    const reloaded = { ...group, learners: [...group.learners, { userId: "l3", name: "Lia" }] };
    expect(outstanding(reloaded, { people: { l3: "learner", l2: null }, courses: {} })).toEqual({
      people: { l2: null },
      courses: {},
    });
  });

  test("name whom someone else added in the other role meanwhile", () => {
    const reloaded = { ...group, learners: [...group.learners, { userId: "x", name: "Alex" }] };
    const edits = { people: { x: "teacher", t2: "teacher", l1: "teacher" }, courses: {} } as const;
    // Lee's change of role was made over the group holding him: no conflict.
    expect(conflictingUserIds(group, reloaded, edits)).toEqual(["x"]);
  });
});
