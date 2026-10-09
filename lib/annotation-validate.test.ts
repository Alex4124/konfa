import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnnotationPayload, Point } from "@/lib/confa-types";
import { EDITABLE_KEYS, MAX_PAYLOAD_BYTES, isAnnotationKind, validateAnnotationPayload, validatePatch, type ValidationResult } from "./annotation-validate.ts";

function ok(result: ValidationResult): AnnotationPayload {
  if ("error" in result) assert.fail(`unexpected error: ${result.error}`);
  assert.deepEqual(JSON.parse(result.encoded), result.payload);
  return result.payload;
}

function error(result: ValidationResult): string {
  assert.ok("error" in result, "expected an error");
  return result.error;
}

const line = (count: number): Point[] => Array.from({ length: count }, (_, i): Point => [Math.round(i / Math.max(1, count - 1) * 1e4) / 1e4, 0.5]);
const pen = { color: "#6de7d4", strokeWidth: 4, points: line(10) };
const text = { color: "#ffcc75", point: [0.3, 0.5] as Point, text: "Строка 1\nСтрока 2", lines: ["Строка 1", "Строка 2"], fontSize: 26, maxWidth: 0.4, w: 0.2312, h: 0.0889, fa: 1.7778 };

describe("validateAnnotationPayload: kinds and shape", () => {
  it("accepts the 10 stored kinds only", () => {
    for (const kind of ["laser", "eraser", "move", "view", "", "PEN"]) assert.equal(error(validateAnnotationPayload(kind, pen)), "Некорректная пометка");
    assert.equal(isAnnotationKind("hexagon"), true);
    assert.equal(isAnnotationKind("laser"), false);
    assert.equal(isAnnotationKind(5), false);
  });

  it("rejects non-object payloads", () => {
    for (const payload of [null, undefined, "x", 5, [pen]]) assert.equal(error(validateAnnotationPayload("pen", payload)), "Некорректная пометка");
  });

  it("requires a #rrggbb colour", () => {
    for (const color of [undefined, "red", "#fff", "#12345g", 123]) assert.equal(error(validateAnnotationPayload("pen", { ...pen, color })), "Некорректный цвет");
    ok(validateAnnotationPayload("pen", { ...pen, color: "#ABCdef" }));
  });
});

describe("validateAnnotationPayload: strokes", () => {
  it("allows 2..400 points for pen and marker, exactly 2 otherwise", () => {
    ok(validateAnnotationPayload("pen", { ...pen, points: line(400) }));
    ok(validateAnnotationPayload("marker", { color: "#ffffff", points: line(2) }));
    assert.equal(error(validateAnnotationPayload("pen", { ...pen, points: line(401) })), "Некорректные координаты");
    assert.equal(error(validateAnnotationPayload("pen", { ...pen, points: line(1) })), "Некорректные координаты");
    ok(validateAnnotationPayload("arrow", { color: "#ffffff", points: line(2) }));
    assert.equal(error(validateAnnotationPayload("rect", { color: "#ffffff", points: line(3) })), "Некорректные координаты");
  });

  it("rejects points outside 0..1, non-finite or malformed", () => {
    for (const bad of [[1.1, 0.5], [-0.1, 0.5], [Number.NaN, 0.5], [Infinity, 0], ["0.5", 0.5], [0.5], [0.1, 0.2, 0.3]]) {
      assert.equal(error(validateAnnotationPayload("line", { color: "#ffffff", points: [[0, 0], bad] })), "Некорректные координаты");
    }
    assert.equal(error(validateAnnotationPayload("line", { color: "#ffffff" })), "Некорректные координаты");
  });

  it("strokeWidth is an optional integer 1..24", () => {
    for (const strokeWidth of [0, 25, 2.5, "4", null]) assert.equal(error(validateAnnotationPayload("pen", { ...pen, strokeWidth })), "Некорректная толщина");
    assert.equal(ok(validateAnnotationPayload("pen", { ...pen, strokeWidth: 24 })).strokeWidth, 24);
    assert.equal("strokeWidth" in ok(validateAnnotationPayload("pen", { color: "#ffffff", points: line(2) })), false);
  });

  it("fa is an optional finite 0.1..10", () => {
    assert.equal(ok(validateAnnotationPayload("pen", { ...pen, fa: 1.7778 })).fa, 1.7778);
    for (const fa of [0.05, 11, Number.NaN, "1.7"]) assert.equal(error(validateAnnotationPayload("pen", { ...pen, fa })), "Некорректная пометка");
  });

  it("rebuilds the object from whitelisted keys only", () => {
    const result = validateAnnotationPayload("pen", { ...pen, junk: "x".repeat(100), text: "hi", point: [0.1, 0.1], lines: ["a"], points: [[0, 0], [0.5, 0.5]] });
    assert.deepEqual(ok(result), { color: "#6de7d4", points: [[0, 0], [0.5, 0.5]], strokeWidth: 4 });
    if (!("error" in result)) assert.equal(result.encoded, '{"color":"#6de7d4","points":[[0,0],[0.5,0.5]],"strokeWidth":4}');
  });

  it("enforces the UTF-8 byte budget", () => {
    const long = Array.from({ length: 400 }, (_, i): Point => [0.123456789012345 + i / 1e6, 0.987654321098765]);
    assert.equal(error(validateAnnotationPayload("pen", { color: "#ffffff", points: long })), "Пометка слишком большая");
    const rounded = long.map(([x, y]): Point => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
    const result = validateAnnotationPayload("pen", { color: "#ffffff", strokeWidth: 24, fa: 1.7778, points: rounded });
    ok(result);
    if (!("error" in result)) assert.ok(new TextEncoder().encode(result.encoded).length <= MAX_PAYLOAD_BYTES);
  });
});

describe("validateAnnotationPayload: text", () => {
  it("accepts the full text payload and the legacy minimal one", () => {
    assert.deepEqual(ok(validateAnnotationPayload("text", text)), text);
    assert.deepEqual(ok(validateAnnotationPayload("text", { color: "#ffffff", point: [0.5, 0.5], text: "Привет" })), { color: "#ffffff", point: [0.5, 0.5], text: "Привет" });
  });

  it("fits 500 Cyrillic characters with their lines under 8000 bytes", () => {
    const raw = "Ж".repeat(500);
    const lines = Array.from({ length: 10 }, () => "Ж".repeat(50));
    const result = validateAnnotationPayload("text", { ...text, text: raw, lines });
    ok(result);
    if (!("error" in result)) assert.ok(new TextEncoder().encode(result.encoded).length < MAX_PAYLOAD_BYTES);
    assert.equal(error(validateAnnotationPayload("text", { ...text, text: "Ж".repeat(501) })), "Некорректный текст");
  });

  it("rejects empty, too long or too many lines of text", () => {
    for (const value of ["", "   \n  ", 5, undefined]) assert.equal(error(validateAnnotationPayload("text", { ...text, text: value })), "Некорректный текст");
    assert.equal(error(validateAnnotationPayload("text", { ...text, text: Array(41).fill("a").join("\n"), lines: undefined })), "Некорректный текст");
  });

  it("validates lines, fontSize and maxWidth", () => {
    for (const lines of [[], Array(41).fill("a"), ["a", 5], "a", ["x".repeat(601)]]) assert.equal(error(validateAnnotationPayload("text", { ...text, lines })), "Некорректный текст");
    for (const fontSize of [9, 73, 26.5, "26"]) assert.equal(error(validateAnnotationPayload("text", { ...text, fontSize })), "Некорректный текст");
    for (const maxWidth of [0.04, 1.01, Number.NaN]) assert.equal(error(validateAnnotationPayload("text", { ...text, maxWidth })), "Некорректный текст");
  });

  it("rejects strokeWidth and a bad anchor on text", () => {
    assert.equal(error(validateAnnotationPayload("text", { ...text, strokeWidth: 4 })), "Некорректная толщина");
    assert.equal(error(validateAnnotationPayload("text", { ...text, point: [1.2, 0.5] })), "Некорректные координаты");
    assert.equal(error(validateAnnotationPayload("text", { ...text, point: undefined })), "Некорректные координаты");
  });

  it("requires w and h together, in (0, 1], and inside the frame", () => {
    assert.equal(error(validateAnnotationPayload("text", { ...text, h: undefined })), "Некорректный текст");
    assert.equal(error(validateAnnotationPayload("text", { ...text, w: 0 })), "Некорректные координаты");
    assert.equal(error(validateAnnotationPayload("text", { ...text, h: 1.5 })), "Некорректные координаты");
    assert.equal(error(validateAnnotationPayload("text", { ...text, point: [0.9, 0.5], w: 0.2 })), "Некорректные координаты");
    assert.equal(error(validateAnnotationPayload("text", { ...text, point: [0.3, 0.95], h: 0.1 })), "Некорректные координаты");
    ok(validateAnnotationPayload("text", { ...text, point: [0.8, 0.5], w: 0.20005 }));
  });
});

describe("validatePatch", () => {
  it("EDITABLE_KEYS never include coordinates", () => {
    assert.deepEqual([...EDITABLE_KEYS], ["text", "lines", "color", "fontSize", "maxWidth", "w", "h", "strokeWidth"]);
  });

  it("applies whitelisted keys and ignores point/points/junk", () => {
    const result = validatePatch("pen", pen, { color: "#ffffff", strokeWidth: 8, points: [[0, 0], [1, 1]], point: [0, 0], junk: 1 });
    assert.deepEqual(ok(result), { ...pen, color: "#ffffff", strokeWidth: 8 });
    const moved = validatePatch("text", text, { color: "#ffffff", point: [0, 0] });
    assert.deepEqual(ok(moved).point, text.point);
  });

  it("rejects empty or non-object patches", () => {
    assert.equal(error(validatePatch("pen", pen, {})), "Некорректная пометка");
    assert.equal(error(validatePatch("pen", pen, { point: [0, 0] })), "Некорректная пометка");
    assert.equal(error(validatePatch("pen", pen, null)), "Некорректная пометка");
    assert.equal(error(validatePatch("pen", pen, [1])), "Некорректная пометка");
  });

  it("validates the merged payload", () => {
    assert.equal(error(validatePatch("pen", pen, { strokeWidth: 30 })), "Некорректная толщина");
    assert.equal(error(validatePatch("text", text, { strokeWidth: 4 })), "Некорректная толщина");
    assert.equal(error(validatePatch("text", text, { text: "  " })), "Некорректный текст");
    assert.equal(error(validatePatch("laser", pen, { color: "#ffffff" })), "Некорректная пометка");
  });

  it("re-clamps a text that grew past the frame edge", () => {
    const result = validatePatch("text", { ...text, point: [0.7, 0.5] }, { fontSize: 40, w: 0.45, h: 0.14, lines: ["Строка 1", "Строка 2"] });
    const payload = ok(result);
    assert.deepEqual(payload.point, [0.55, 0.5]);
    assert.equal(payload.fontSize, 40);
  });

  it("drops stale lines when the text changes without new lines", () => {
    const payload = ok(validatePatch("text", text, { text: "Новый текст" }));
    assert.equal(payload.text, "Новый текст");
    assert.equal("lines" in payload, false);
    const withLines = ok(validatePatch("text", text, { text: "Новый текст", lines: ["Новый", "текст"] }));
    assert.deepEqual(withLines.lines, ["Новый", "текст"]);
  });

  it("removes keys patched to null, the wire form of undoing an edit that added them", () => {
    const legacyPen = { color: "#6de7d4", points: line(3) };
    assert.deepEqual(ok(validatePatch("pen", { ...legacyPen, strokeWidth: 8 }, { strokeWidth: null })), legacyPen);
    const legacyText = { color: "#ffffff", point: [0.1, 0.1] as Point, text: "a" };
    const grown = ok(validatePatch("text", legacyText, { text: "bb", lines: ["bb"], fontSize: 40, w: 0.2, h: 0.1 }));
    assert.deepEqual(ok(validatePatch("text", grown, { text: "a", lines: null, fontSize: null, w: null, h: null })), legacyText);
    assert.equal(error(validatePatch("text", text, { w: null })), "Некорректный текст", "w and h go together");
    assert.equal(error(validatePatch("text", text, { text: null })), "Некорректный текст");
    assert.equal(error(validatePatch("pen", pen, { color: null })), "Некорректный цвет");
  });

  it("removes a key patched to undefined and keeps legacy rows editable", () => {
    const payload = ok(validatePatch("text", text, { maxWidth: undefined }));
    assert.equal("maxWidth" in payload, false);
    const legacy = ok(validatePatch("text", { color: "#ffffff", point: [0.98, 0.5], text: "old" }, { color: "#000000" }));
    assert.deepEqual(legacy, { color: "#000000", point: [0.95, 0.5], text: "old" });
  });
});
