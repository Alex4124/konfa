import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnnotationPayload, Point } from "@/lib/confa-types";
import {
  FREEHAND_CAP, LEGACY_TEXT_UNITS, MAX_FREEHAND_POINTS, annotationBounds, arrowHeadPx, aspectMismatch, constrainEnd, dashArray,
  distanceToItemPx, eraseHits, finalizeFreehand, fitBox, fontPx, hitRadiusFor, isDegenerate, normFromClient, pickForMove,
  primitivesPx, pushFiltered, round4, segmentDistance, simplifyRdp, simplifyToCap, strokePx, strokeUnits, textBoxNorm,
  textUnits, translateAnnotation, unitsToPx, type HitItem,
} from "./annotation-geometry.ts";

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
const decimals = (value: number) => (String(value).split(".")[1] ?? "").length;
const screen = { width: 1000, height: 1000 };

function lcg(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

describe("units", () => {
  it("strokePx scales with frame height and has a 1 px floor", () => {
    assert.equal(strokePx(5, 720), 5);
    assert.equal(strokePx(5, 1080), 7.5);
    near(strokePx(5, 219), 1.5208, 1e-3);
    assert.equal(strokePx(1, 100), 1);
    assert.equal(unitsToPx(24, 360), 12);
  });

  it("strokeUnits keeps valid integers and falls back to legacy defaults", () => {
    assert.equal(strokeUnits("marker", {}), 23);
    assert.equal(strokeUnits("pen", {}), 5);
    assert.equal(strokeUnits("rect", {}), 5);
    assert.equal(strokeUnits("pen", { strokeWidth: 2.5 }), 5);
    assert.equal(strokeUnits("pen", { strokeWidth: 0 }), 5);
    assert.equal(strokeUnits("marker", { strokeWidth: 25 }), 23);
    assert.equal(strokeUnits("pen", { strokeWidth: 4 }), 4);
    assert.equal(strokeUnits("marker", { strokeWidth: 16 }), 16);
  });

  it("fontPx has no floor; textUnits falls back to the legacy size", () => {
    near(fontPx(26, 219), 7.908, 1e-3);
    assert.equal(textUnits({}), LEGACY_TEXT_UNITS);
    assert.equal(textUnits({ fontSize: 40 }), 40);
    assert.equal(textUnits({ fontSize: 9 }), LEGACY_TEXT_UNITS);
    assert.equal(textUnits({ fontSize: 30.5 }), LEGACY_TEXT_UNITS);
  });

  it("arrowHeadPx never exceeds 0.45 × length for short arrows and caps long heads", () => {
    const short = arrowHeadPx(5, 720, 40);
    assert.ok(short <= 0.45 * 40 + 1e-9);
    assert.equal(arrowHeadPx(5, 720, 1000), unitsToPx(20, 720));
    assert.equal(arrowHeadPx(5, 720, 2), 3 * strokePx(5, 720));
    assert.equal(arrowHeadPx(1, 720, 1000), unitsToPx(12, 720));
  });

  it("dashArray is 3:2 of the stroke width", () => {
    assert.equal(dashArray(4), "12 8");
    assert.equal(dashArray(1.234), "3.7 2.47");
  });
});

describe("coordinates and freehand", () => {
  it("round4 rounds to 4 decimals and normalizes -0", () => {
    assert.equal(round4(0.123456), 0.1235);
    assert.ok(Object.is(round4(-0.00001), 0));
  });

  it("normFromClient maps through a zoomed rect and clamps", () => {
    const rect = { left: -300, top: -100, width: 1440, height: 810 };
    assert.deepEqual(normFromClient(420, 305, rect), [0.5, 0.5]);
    assert.deepEqual(normFromClient(-400, -500, rect), [0, 0]);
    assert.deepEqual(normFromClient(5000, 5000, rect), [1, 1]);
    const raw = normFromClient(1, 1, { left: 0, top: 0, width: 3, height: 7 });
    near(raw[0], 1 / 3, 1e-12);
    assert.ok(decimals(raw[0]) > 4);
    assert.deepEqual(normFromClient(10, 10, { left: 0, top: 0, width: 0, height: 0 }), [0, 0]);
  });

  it("pushFiltered drops sub-step samples in screen px", () => {
    const points: Point[] = [];
    assert.equal(pushFiltered(points, [[0, 0]], screen), 1);
    assert.equal(pushFiltered(points, [[0.001, 0]], screen), 0);
    assert.equal(pushFiltered(points, [[0.002, 0], [0.0025, 0], [0.004, 0]], screen), 2);
    assert.deepEqual(points, [[0, 0], [0.002, 0], [0.004, 0]]);
  });

  it("pushFiltered is anisotropic: the same normalized step differs on tall and wide screens", () => {
    const tall: Point[] = [[0, 0]], wide: Point[] = [[0, 0]];
    pushFiltered(tall, [[0.01, 0]], { width: 100, height: 1000 });
    pushFiltered(wide, [[0.01, 0]], { width: 1000, height: 100 });
    assert.equal(tall.length, 1);
    assert.equal(wide.length, 2);
  });

  it("simplifyRdp collapses collinear points to the endpoints", () => {
    const line = Array.from({ length: 1000 }, (_, i): Point => [i / 999, i / 1998]);
    assert.deepEqual(simplifyRdp(line, 0.4, 16 / 9), [line[0], line[999]]);
  });

  it("simplifyRdp keeps a zigzag above eps", () => {
    const zigzag = Array.from({ length: 20 }, (_, i): Point => [i / 20, i % 2 ? 0.05 : 0]);
    assert.equal(simplifyRdp(zigzag, 0.4, 1).length, 20);
  });

  it("simplifyRdp does not collapse a closed loop whose ends meet", () => {
    const loop = Array.from({ length: 101 }, (_, i): Point => [0.5 + 0.2 * Math.cos(i / 100 * 2 * Math.PI), 0.5 + 0.2 * Math.sin(i / 100 * 2 * Math.PI)]);
    loop[100] = loop[0];
    const out = simplifyRdp(loop, 0.4, 1);
    assert.ok(out.length > 10, `got ${out.length}`);
    assert.deepEqual(out[0], loop[0]);
    assert.deepEqual(out[out.length - 1], loop[100]);
  });

  it("simplifyToCap brings a 5000-point spiral under the cap and the payload budget", () => {
    const aspect = 16 / 9;
    const spiral = Array.from({ length: 5000 }, (_, i): Point => {
      const t = i / 4999, r = 0.02 + 0.43 * t, angle = t * 40 * Math.PI;
      return [0.5 + r * Math.cos(angle) / aspect, 0.5 + r * Math.sin(angle)];
    });
    const out = simplifyToCap(spiral, FREEHAND_CAP, aspect);
    assert.ok(out.length <= FREEHAND_CAP, `got ${out.length}`);
    assert.deepEqual(out[0], spiral[0]);
    assert.deepEqual(out[out.length - 1], spiral[4999]);
    const points = finalizeFreehand(spiral, aspect);
    assert.ok(points.length <= FREEHAND_CAP && points.length <= MAX_FREEHAND_POINTS);
    const encoded = JSON.stringify({ color: "#6de7d4", strokeWidth: 18, fa: 1.7778, points });
    assert.ok(new TextEncoder().encode(encoded).length < 8000, `${encoded.length} bytes`);
  });

  it("simplifyToCap decimates uniformly as a last resort and keeps endpoints", () => {
    const random = lcg(7);
    const noise = Array.from({ length: 3000 }, (): Point => [random(), random()]);
    const out = simplifyToCap(noise, 10, 1);
    assert.ok(out.length <= 10);
    assert.deepEqual(out[0], noise[0]);
    assert.deepEqual(out[out.length - 1], noise[2999]);
  });

  it("finalizeFreehand turns a tap into a dot, rounds and dedupes", () => {
    assert.deepEqual(finalizeFreehand([[0.123456, 0.654321]], 1), [[0.1235, 0.6543], [0.1235, 0.6543]]);
    assert.deepEqual(finalizeFreehand([[0.12341, 0.5], [0.12342, 0.5]], 1), [[0.1234, 0.5], [0.1234, 0.5]]);
    assert.deepEqual(finalizeFreehand([], 1), []);
    const out = finalizeFreehand([[0.111111, 0.2], [0.3, 0.912345], [0.7, 0.333333]], 1);
    assert.ok(out.length >= 2);
    for (const [x, y] of out) assert.ok(decimals(x) <= 4 && decimals(y) <= 4);
  });
});

describe("shapes", () => {
  const aspect = 16 / 9;
  const frame = { width: 1600, height: 900 };

  it("constrainEnd is the identity without Shift", () => {
    const end: Point = [0.7, 0.1];
    assert.equal(constrainEnd("rect", [0.2, 0.2], end, aspect, false), end);
  });

  it("Shift rectangle at 16:9 becomes a square in px", () => {
    const start: Point = [0.2, 0.2];
    const end = constrainEnd("rect", start, [0.5, 0.3], aspect, true);
    near((end[0] - start[0]) * frame.width, (end[1] - start[1]) * frame.height, 1e-6);
    near((end[0] - start[0]) * frame.width, 480, 1e-6);
  });

  it("Shift ellipse keeps the drag direction", () => {
    const start: Point = [0.6, 0.6];
    const end = constrainEnd("circle", start, [0.5, 0.58], aspect, true);
    assert.ok(end[0] < start[0] && end[1] < start[1]);
    near((start[0] - end[0]) * frame.width, (start[1] - end[1]) * frame.height, 1e-6);
  });

  it("Shift shape near an edge stays square and inside the frame", () => {
    const start: Point = [0.95, 0.9];
    const end = constrainEnd("hexagon", start, [0.99, 0.5], aspect, true);
    assert.ok(end[0] >= 0 && end[0] <= 1 && end[1] >= 0 && end[1] <= 1);
    near(Math.abs(end[0] - start[0]) * frame.width, Math.abs(end[1] - start[1]) * frame.height, 1e-6);
  });

  it("Shift line snaps 30° to 45° and 10° to 0°, keeping the length", () => {
    const start: Point = [0.5, 0.5];
    const at = (deg: number): Point => [0.5 + 0.2 * Math.cos(deg * Math.PI / 180) / aspect, 0.5 + 0.2 * Math.sin(deg * Math.PI / 180)];
    const diagonal = constrainEnd("line", start, at(30), aspect, true);
    near((diagonal[0] - 0.5) * frame.width, (diagonal[1] - 0.5) * frame.height, 1e-6);
    near(Math.hypot((diagonal[0] - 0.5) * aspect, diagonal[1] - 0.5), 0.2, 1e-9);
    const flat = constrainEnd("arrow", start, at(10), aspect, true);
    near(flat[1], 0.5, 1e-12);
    near((flat[0] - 0.5) * aspect, 0.2, 1e-9);
    const vertical = constrainEnd("dashed", start, at(-80), aspect, true);
    near(vertical[0], 0.5, 1e-9);
    assert.ok(vertical[1] < 0.5);
  });

  it("Shift line near an edge shrinks to stay inside the frame", () => {
    const end = constrainEnd("line", [0.9, 0.5], [1, 0.42], aspect, true);
    assert.ok(end[0] >= 0 && end[0] <= 1 && end[1] >= 0 && end[1] <= 1);
    near((end[0] - 0.9) * frame.width, (0.5 - end[1]) * frame.height, 1e-6);
  });

  it("isDegenerate rejects clicks and slivers, never freehand", () => {
    assert.equal(isDegenerate("line", [0.5, 0.5], [0.5, 0.5], screen), true);
    assert.equal(isDegenerate("dashed", [0.5, 0.5], [0.505, 0.5], screen), true);
    assert.equal(isDegenerate("line", [0.5, 0.5], [0.507, 0.5], screen), false);
    assert.equal(isDegenerate("arrow", [0.5, 0.5], [0.505, 0.5], screen), true);
    assert.equal(isDegenerate("arrow", [0.5, 0.5], [0.512, 0.5], screen), false);
    assert.equal(isDegenerate("rect", [0.1, 0.1], [0.2, 0.103], screen), true);
    assert.equal(isDegenerate("circle", [0.1, 0.1], [0.2, 0.15], screen), false);
    assert.equal(isDegenerate("pen", [0.1, 0.1], [0.101, 0.1], screen), false);
    assert.equal(isDegenerate("marker", [0.1, 0.1], [0.1, 0.1], screen), false);
  });

  it("primitivesPx: circle is an ellipse filling the drag rectangle", () => {
    const prims = primitivesPx("circle", { color: "#fff", points: [[0.5, 0.4], [0.1, 0.2]] }, { width: 1000, height: 500 });
    assert.deepEqual(prims, [{ type: "ellipse", cx: 300, cy: 150, rx: 200, ry: 50 }]);
  });

  it("primitivesPx: arrow is a shaft plus two head polylines", () => {
    const prims = primitivesPx("arrow", { color: "#fff", points: [[0.1, 0.5], [0.9, 0.5]] }, screen);
    assert.equal(prims.length, 3);
    assert.ok(prims.every((p) => p.type === "polyline"));
    const head = prims[1];
    assert.ok(head.type === "polyline" && head.points[1][0] < 900);
  });

  it("primitivesPx: closed shapes, freehand, text and non-drawing tools", () => {
    const rect = primitivesPx("rect", { color: "#fff", points: [[0.1, 0.1], [0.3, 0.2]] }, screen);
    assert.deepEqual(rect, [{ type: "polyline", points: [[100, 100], [300, 100], [300, 200], [100, 200]], closed: true }]);
    const pen = primitivesPx("pen", { color: "#fff", points: [[0, 0], [0.1, 0.1], [0.2, 0]] }, screen);
    assert.equal(pen.length, 1);
    assert.ok(pen[0].type === "polyline" && !pen[0].closed && pen[0].points.length === 3);
    const text = primitivesPx("text", { color: "#fff", point: [0.1, 0.2], text: "a", w: 0.3, h: 0.1 }, screen);
    assert.deepEqual(text, [{ type: "box", x: 100, y: 200, w: 300, h: 100 }]);
    assert.deepEqual(primitivesPx("eraser", { color: "#fff", points: [[0, 0], [1, 1]] }, screen), []);
    assert.equal(primitivesPx("hexagon", { color: "#fff", points: [[0, 0], [1, 1]] }, screen)[0].type, "polyline");
  });
});

describe("bounds and translate", () => {
  it("textBoxNorm uses stored extent, estimates legacy rows from the box, else 0.05", () => {
    assert.deepEqual(textBoxNorm({ color: "#fff", point: [0.1, 0.2], text: "x", w: 0.3, h: 0.1 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
    const legacy = textBoxNorm({ color: "#fff", point: [0.1, 0.2], text: "abcd\nab" }, { width: 1280, height: 720 });
    assert.ok(legacy);
    near(legacy.w, 0.6 * 26 * 4 / 1280, 1e-9);
    near(legacy.h, 2 * 1.25 * 26 / 720, 1e-9);
    assert.deepEqual(textBoxNorm({ color: "#fff", point: [0.1, 0.2], text: "abcd" }), { x: 0.1, y: 0.2, w: 0.05, h: 0.05 });
    assert.equal(textBoxNorm({ color: "#fff", points: [[0, 0], [1, 1]] }), null);
  });

  it("annotationBounds covers points or the text box", () => {
    assert.deepEqual(annotationBounds("pen", { color: "#fff", points: [[0.3, 0.1], [0.1, 0.4], [0.2, 0.2]] }), { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.4 });
    const text = annotationBounds("text", { color: "#fff", point: [0.2, 0.3], text: "x", w: 0.1, h: 0.2 });
    assert.ok(text);
    near(text.maxX, 0.3);
    near(text.maxY, 0.5);
    assert.equal(annotationBounds("pen", { color: "#fff" }), null);
  });

  it("translateAnnotation clamps text by point + [w, h]", () => {
    const moved = translateAnnotation({ color: "#fff", point: [0.6, 0.5], text: "x", w: 0.2, h: 0.1 }, 0.5, 0);
    assert.deepEqual(moved.payload.point, [0.8, 0.5]);
    assert.equal(moved.dx, 0.2);
    assert.equal(moved.dy, 0);
    assert.equal(moved.payload.w, 0.2);
  });

  it("translateAnnotation re-clamps an overflowing text with a zero shift", () => {
    const moved = translateAnnotation({ color: "#fff", point: [0.9, 0.95], text: "x", w: 0.2, h: 0.1 }, 0, 0);
    assert.deepEqual(moved.payload.point, [0.8, 0.9]);
    assert.ok(moved.payload.point && moved.payload.point[0] + 0.2 <= 1.0001);
  });

  it("translateAnnotation keeps legacy text anchors at or below 0.95", () => {
    const moved = translateAnnotation({ color: "#fff", point: [0.5, 0.5], text: "x" }, 0.9, -0.9);
    assert.deepEqual(moved.payload.point, [0.95, 0]);
  });

  it("translateAnnotation shifts strokes within the frame and rounds to 4 decimals", () => {
    const moved = translateAnnotation({ color: "#fff", strokeWidth: 4, points: [[0.12345, 0.1], [0.3, 0.2]] }, 0.2, -0.5);
    assert.equal(moved.dx, 0.2);
    assert.equal(moved.dy, -0.1);
    assert.deepEqual(moved.payload.points, [[0.3235, 0], [0.5, 0.1]]);
    assert.equal(moved.payload.strokeWidth, 4);
    const right = translateAnnotation({ color: "#fff", points: [[0.5, 0.5], [0.9, 0.6]] }, 1, 0);
    assert.equal(right.dx, 0.1);
    assert.deepEqual(right.payload.points, [[0.6, 0.5], [1, 0.6]]);
    assert.deepEqual(translateAnnotation({ color: "#fff", points: [[0.5, 0.5], [0.6, 0.6]] }, Number.NaN, 0).dx, 0);
  });

  it("translateAnnotation throws without coordinates", () => {
    assert.throws(() => translateAnnotation({ color: "#fff" }, 0, 0));
  });
});

describe("hit-testing", () => {
  const item = (id: string, kind: HitItem["kind"], data: Omit<AnnotationPayload, "color">): HitItem => ({ id, kind, data: { color: "#fff", ...data } });

  it("segmentDistance: crossing, parallel and degenerate segments", () => {
    assert.equal(segmentDistance([0, 0], [10, 10], [0, 10], [10, 0]), 0);
    assert.equal(segmentDistance([0, 0], [10, 0], [0, 5], [10, 5]), 5);
    assert.equal(segmentDistance([0, 0], [0, 0], [3, 4], [3, 4]), 5);
  });

  it("a fast swipe hits a thin line without samples in between", () => {
    const line = item("v", "pen", { strokeWidth: 1, points: [[0.5, 0.2], [0.5, 0.8]] });
    assert.deepEqual(eraseHits([line], [0, 0], [1, 1], screen, 8), ["v"]);
    assert.deepEqual(eraseHits([line], [0, 0], [0.4, 0.4], screen, 8), []);
  });

  it("rectangles and ellipses hit on the outline only; text hits inside", () => {
    const rect = item("r", "rect", { points: [[0.2, 0.2], [0.8, 0.8]] });
    const ellipse = item("e", "circle", { points: [[0.2, 0.2], [0.6, 0.4]] });
    const text = item("t", "text", { point: [0.1, 0.1], text: "x", w: 0.2, h: 0.1 });
    assert.deepEqual(eraseHits([rect], [0.5, 0.5], [0.5, 0.5], screen, 8), []);
    assert.deepEqual(eraseHits([rect], [0.5, 0.2], [0.5, 0.2], screen, 8), ["r"]);
    assert.deepEqual(eraseHits([ellipse], [0.4, 0.3], [0.4, 0.3], screen, 8), []);
    assert.deepEqual(eraseHits([ellipse], [0.4, 0.2], [0.4, 0.2], screen, 8), ["e"]);
    assert.deepEqual(eraseHits([text], [0.2, 0.15], [0.2, 0.15], screen, 8), ["t"]);
    assert.deepEqual(eraseHits([text], [0.5, 0.5], [0.5, 0.5], screen, 8), []);
  });

  it("the touch radius reaches further than the mouse radius", () => {
    const line = item("l", "line", { strokeWidth: 1, points: [[0.1, 0.5], [0.9, 0.5]] });
    const p: Point = [0.5, 0.512];
    assert.deepEqual(eraseHits([line], p, p, screen, hitRadiusFor("mouse")), []);
    assert.deepEqual(eraseHits([line], p, p, screen, hitRadiusFor("touch")), ["l"]);
    assert.equal(hitRadiusFor("pen"), 8);
  });

  it("wide marker strokes hit within half their width", () => {
    const marker = item("m", "marker", { points: [[0.1, 0.5], [0.9, 0.5]] });
    const p: Point = [0.5, 0.52];
    assert.ok(distanceToItemPx(marker, p, p, screen) > 8);
    assert.deepEqual(eraseHits([marker], p, p, screen, 8), ["m"]);
  });

  it("arrow heads are hittable outside the shaft's bounding box", () => {
    const arrow = item("a", "arrow", { strokeWidth: 4, points: [[0.1, 0.5], [0.5, 0.5]] });
    const [, wing] = primitivesPx("arrow", arrow.data, screen);
    assert.ok(wing.type === "polyline");
    const tip = wing.points[1];
    const p: Point = [tip[0] / 1000, tip[1] / 1000];
    assert.deepEqual(eraseHits([arrow], p, p, screen, 8), ["a"]);
  });

  it("pickForMove prefers the arrow inside a later, larger rectangle", () => {
    const arrow = item("arrow", "arrow", { points: [[0.25, 0.2], [0.5, 0.2]] });
    const rect = item("rect", "rect", { points: [[0.2, 0.2], [0.8, 0.8]] });
    assert.equal(pickForMove([arrow, rect], [0.3, 0.2], screen, 8), "arrow");
    assert.equal(pickForMove([arrow, rect], [0.8, 0.5], screen, 8), "rect");
    assert.equal(pickForMove([arrow, rect], [0.5, 0.5], screen, 8), null);
  });

  it("pickForMove breaks ties by the newest item and picks text by its interior", () => {
    const first = item("first", "line", { points: [[0.1, 0.1], [0.9, 0.1]] });
    const second = item("second", "line", { points: [[0.1, 0.1], [0.9, 0.1]] });
    assert.equal(pickForMove([first, second], [0.5, 0.1], screen, 8), "second");
    const text = item("text", "text", { point: [0.3, 0.3], text: "x", w: 0.2, h: 0.1 });
    const frame = item("frame", "rect", { points: [[0.1, 0.1], [0.9, 0.9]] });
    assert.equal(pickForMove([text, frame], [0.4, 0.35], screen, 8), "text");
  });
});

describe("frame helpers", () => {
  it("fitBox handles width- and height-limited containers", () => {
    assert.deepEqual(fitBox({ width: 1000, height: 1000 }, 16 / 9), { width: 1000, height: 562.5 });
    const tall = fitBox({ width: 1000, height: 400 }, 16 / 9);
    near(tall.width, 711.111, 1e-3);
    near(tall.height, 400, 1e-9);
    assert.deepEqual(fitBox({ width: 0, height: 400 }, 16 / 9), { width: 0, height: 0 });
    assert.deepEqual(fitBox({ width: 100, height: 400 }, 0), { width: 0, height: 0 });
  });

  it("aspectMismatch uses a 2% log tolerance", () => {
    assert.equal(aspectMismatch(1.7778, 1.6), true);
    assert.equal(aspectMismatch(1.7778, 1.77), false);
    assert.equal(aspectMismatch(undefined, 1.6), false);
    assert.equal(aspectMismatch(0, 1.6), false);
  });
});
