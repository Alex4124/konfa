import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnnotationActivity } from "@/lib/annotation-sync";
import { ALERT_TITLE, alertTitle, isAlertActivity, marksCountLabel, marksLabel, pluralRu } from "./presenter-alerts.ts";

describe("pluralRu", () => {
  const forms = ["one", "few", "many"] as const;
  const cases: Array<[number, string]> = [[0, "many"], [1, "one"], [2, "few"], [4, "few"], [5, "many"], [11, "many"], [12, "many"], [14, "many"], [15, "many"], [20, "many"],
    [21, "one"], [22, "few"], [25, "many"], [101, "one"], [104, "few"], [111, "many"], [112, "many"], [121, "one"], [1001, "one"], [1011, "many"]];
  for (const [n, form] of cases) it(`${n} → ${form}`, () => assert.equal(pluralRu(n, forms), form));

  it("treats negative and fractional counts by their whole absolute value", () => {
    assert.equal(pluralRu(-1, forms), "one");
    assert.equal(pluralRu(2.7, forms), "few");
    assert.equal(pluralRu(Number.NaN, forms), "many");
  });
});

describe("marksLabel", () => {
  it("declines «новая пометка»", () => {
    assert.equal(marksLabel(1), "1 новая пометка");
    assert.equal(marksLabel(2), "2 новые пометки");
    assert.equal(marksLabel(3), "3 новые пометки");
    assert.equal(marksLabel(5), "5 новых пометок");
    assert.equal(marksLabel(11), "11 новых пометок");
    assert.equal(marksLabel(21), "21 новая пометка");
    assert.equal(marksLabel(22), "22 новые пометки");
    assert.equal(marksLabel(111), "111 новых пометок");
  });

  it("shows zero for empty, negative or broken counts", () => {
    assert.equal(marksLabel(0), "0 новых пометок");
    assert.equal(marksLabel(-3), "0 новых пометок");
    assert.equal(marksLabel(Number.NaN), "0 новых пометок");
    assert.equal(marksLabel(2.9), "2 новые пометки");
  });
});

describe("marksCountLabel", () => {
  it("declines «пометка» without «новая»", () => {
    assert.equal(marksCountLabel(1), "1 пометка");
    assert.equal(marksCountLabel(2), "2 пометки");
    assert.equal(marksCountLabel(5), "5 пометок");
    assert.equal(marksCountLabel(11), "11 пометок");
    assert.equal(marksCountLabel(21), "21 пометка");
    assert.equal(marksCountLabel(22), "22 пометки");
    assert.equal(marksCountLabel(111), "111 пометок");
    assert.equal(marksCountLabel(0), "0 пометок");
  });
});

describe("alertTitle", () => {
  const base = "Конфа — видеовстречи и вебинары";

  it("prefixes the count while there are new marks", () => {
    assert.equal(ALERT_TITLE, "Новые пометки — Конфа");
    assert.equal(alertTitle(1, base), "(1) Новые пометки — Конфа");
    assert.equal(alertTitle(3, base), "(3) Новые пометки — Конфа");
    assert.equal(alertTitle(99, base), "(99) Новые пометки — Конфа");
  });

  it("caps long counts", () => {
    assert.equal(alertTitle(100, base), "(99+) Новые пометки — Конфа");
  });

  it("returns the base title for nothing new", () => {
    assert.equal(alertTitle(0, base), base);
    assert.equal(alertTitle(-2, base), base);
    assert.equal(alertTitle(Number.NaN, base), base);
    assert.equal(alertTitle(0.5, base), base);
  });
});

describe("isAlertActivity", () => {
  const mark: AnnotationActivity = { type: "mark", id: "a1", authorId: "m2", authorName: "Оля", kind: "pen" };
  const draft = (kind: "laser" | "pen", style?: "laser" | "ink"): AnnotationActivity => ({ type: "draft-start", strokeId: "s1", authorId: "m2", authorName: "Оля", kind, ...(style ? { style } : {}) });

  it("counts saved marks and laser or fading-ink strokes of others", () => {
    assert.equal(isAlertActivity(mark, "m1"), true);
    assert.equal(isAlertActivity(draft("laser", "laser"), "m1"), true);
    assert.equal(isAlertActivity(draft("laser", "ink"), "m1"), true);
    assert.equal(isAlertActivity(draft("laser")), true);
  });

  it("skips ordinary drafts (counted when saved) and own activity", () => {
    assert.equal(isAlertActivity(draft("pen"), "m1"), false);
    assert.equal(isAlertActivity(mark, "m2"), false);
    assert.equal(isAlertActivity(draft("laser"), "m2"), false);
    assert.equal(isAlertActivity(mark, null), true);
  });
});
