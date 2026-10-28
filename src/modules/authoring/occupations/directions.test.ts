import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDirectionCode, planOccupationDirections, toOccupationDirection, type StoredOccupationDirection } from "./directions";
import { occupationInputSchema } from "./input";

const existing: StoredOccupationDirection[] = [
  { id: "01", name: "车削加工", ordinal: 1, status: "active" },
  { id: "02", name: "铣削加工", ordinal: 2, status: "active" },
  { id: "03", name: "已移除方向", ordinal: 3, status: "archived" },
];

test("new directions are trimmed and numbered from 01 in input order", () => {
  const plan = planOccupationDirections([{ name: " 车削加工 " }, { name: "铣削加工" }], []);
  assert.deepEqual(plan.added, [{ name: "车削加工", ordinal: 1 }, { name: "铣削加工", ordinal: 2 }]);
  assert.equal(formatDirectionCode(1), "01");
  assert.equal(formatDirectionCode(2), "02");
  assert.equal(formatDirectionCode(100), "100");
});

test("full code follows occupation code and direction code", () => {
  assert.deepEqual(toOccupationDirection(existing[0], "6-18-01-01"), {
    id: "01", name: "车削加工", directionCode: "01", code: "6-18-01-01-01",
  });
  assert.equal(toOccupationDirection(existing[0], "new-code").code, "new-code-01");
});

test("editing and reordering retains direction identities and codes", () => {
  const plan = planOccupationDirections([{ id: "02", name: "数控铣削" }, { id: "01", name: "车削加工" }], existing);
  assert.deepEqual(plan.retained.map((direction) => [direction.id, direction.ordinal, direction.name]),
    [["02", 2, "数控铣削"], ["01", 1, "车削加工"]]);
  assert.deepEqual(plan.archivedIds, []);
});

test("removed directions are archived and their numbers are not reused", () => {
  const plan = planOccupationDirections([{ id: "02", name: "铣削加工" }, { name: "磨削加工" }], existing);
  assert.deepEqual(plan.archivedIds, ["01"]);
  assert.deepEqual(plan.added, [{ name: "磨削加工", ordinal: 4 }]);
});

test("empty direction list is supported and archives active directions", () => {
  assert.deepEqual(planOccupationDirections([], []).added, []);
  assert.deepEqual(planOccupationDirections([], existing).archivedIds, ["01", "02"]);
});

test("reject blank, overlong and duplicate direction names", () => {
  assert.throws(() => planOccupationDirections([{ name: " " }], []), /1 至 200/);
  assert.throws(() => planOccupationDirections([{ name: "a".repeat(201) }], []), /1 至 200/);
  assert.throws(() => planOccupationDirections([{ name: "车削加工" }, { name: " 车削加工 " }], []), /重复/);
  assert.throws(() => planOccupationDirections([{ name: "CNC" }, { name: "cnc" }], []), /重复/);
});

test("reject foreign, archived or duplicated direction identities", () => {
  assert.throws(() => planOccupationDirections([{ id: "other", name: "其他方向" }], existing), /不存在/);
  assert.throws(() => planOccupationDirections([{ id: "03", name: "已移除方向" }], existing), /已移除/);
  assert.throws(() => planOccupationDirections([{ id: "01", name: "名称甲" }, { id: "01", name: "名称乙" }], existing), /重复提交/);
});

test("API accepts legacy input and validates directions without trusting client codes", () => {
  assert.equal(occupationInputSchema.safeParse({ name: "车工", code: "6-18-01-01" }).success, true);
  const parsed = occupationInputSchema.parse({
    name: "车工", code: "6-18-01-01", directions: [{ name: "数控车削", directionCode: "99", code: "fake" }],
  });
  assert.deepEqual(parsed.directions, [{ name: "数控车削" }]);
  assert.equal(occupationInputSchema.safeParse({ name: "车工", code: "6-18-01-01", directions: [{ name: "" }] }).success, false);
  assert.equal(occupationInputSchema.safeParse({ name: "车工", code: "6-18-01-01", directions: "数控车削" }).success, false);
});
