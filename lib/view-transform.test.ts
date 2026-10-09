import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Point } from "@/lib/confa-types";
import type { Size } from "./annotation-geometry.ts";
import {
  DEFAULT_MAX_ZOOM, DOUBLE_TAP, DOUBLE_TAP_ZOOM, IDENTITY_VIEW, MAX_ZOOM, MAX_ZOOM_FLOOR, TAP, clampTransform, ensureMinScale, fromOffset, fromTransform,
  isDoubleTap, isTap, isZoomed, maxScaleFor, panBy, pinch, routePointerDown, stripPlacement, toContent, toggleZoom, toOffset, toTransform, toViewport,
  wheelZoomFactor, zoomAt, zoomPercent, type Interaction, type PointerRoute, type RouteInput, type View, type XY,
} from "./view-transform.ts";

// Desktop: 1000×600 viewport showing a 16:9 frame (letterboxed top and bottom). Phone: 360×470 portrait.
const V: Size = { width: 1000, height: 600 };
const B: Size = { width: 1000, height: 562.5 };
const PV: Size = { width: 360, height: 470 };
const PB: Size = { width: 360, height: 202.5 };
const CENTER: XY = { x: 500, y: 300 };

const view = (scale: number, x = 0.5, y = 0.5): View => ({ scale, x, y });
const near = (actual: number, expected: number, eps = 1e-9, message?: string) => assert.ok(Math.abs(actual - expected) <= eps, message ?? `${actual} ≉ ${expected}`);
const nearView = (actual: View, expected: View, eps = 1e-9, message = "") => {
  near(actual.scale, expected.scale, eps, `${message} scale ${actual.scale} ≉ ${expected.scale}`);
  near(actual.x, expected.x, eps, `${message} x ${actual.x} ≉ ${expected.x}`);
  near(actual.y, expected.y, eps, `${message} y ${actual.y} ≉ ${expected.y}`);
};
const nearPoint = (actual: Point, expected: Point, eps = 1e-9) => { near(actual[0], expected[0], eps); near(actual[1], expected[1], eps); };
const nearXY = (actual: XY, expected: XY, eps = 1e-9) => { near(actual.x, expected.x, eps); near(actual.y, expected.y, eps); };

// The frame edges in viewport px for a view.
function edges(v: View, box = B, viewport = V, max = MAX_ZOOM) {
  const { scale, left, top } = toOffset(v, box, viewport, max);
  return { scale, left, top, right: left + scale * box.width, bottom: top + scale * box.height };
}

describe("constants", () => {
  it("identity is scale 1 centred and frozen; tap limits match the plan", () => {
    assert.deepEqual(IDENTITY_VIEW, { scale: 1, x: 0.5, y: 0.5 });
    assert.ok(Object.isFrozen(IDENTITY_VIEW));
    assert.deepEqual(DOUBLE_TAP, { ms: 300, px: 24 });
    assert.deepEqual(TAP, { ms: 250, px: 10 });
    assert.equal(DOUBLE_TAP_ZOOM, 2.5);
    assert.equal(MAX_ZOOM, 8);
    assert.equal(MAX_ZOOM_FLOOR, 3);
  });
});

describe("maxScaleFor", () => {
  it("is clamp(2·frameWidth/boxWidth, 3, 8)", () => {
    assert.equal(maxScaleFor({ width: 1920, height: 1080 }, PB), 8); // phone
    assert.equal(maxScaleFor({ width: 1920, height: 1080 }, { width: 1280, height: 720 }), 3); // desktop
    near(maxScaleFor({ width: 1920, height: 1080 }, { width: 800, height: 450 }), 4.8);
    near(maxScaleFor({ width: 3840, height: 2160 }, { width: 1000, height: 562.5 }), 7.68);
    assert.equal(maxScaleFor({ width: 640, height: 360 }, B), 3);
  });

  it("falls back to 4 when the frame or the box is unknown", () => {
    assert.equal(DEFAULT_MAX_ZOOM, 4);
    assert.equal(maxScaleFor(null, B), 4);
    assert.equal(maxScaleFor(undefined, B), 4);
    assert.equal(maxScaleFor({ width: 0, height: 0 }, B), 4);
    assert.equal(maxScaleFor({ width: 1920, height: 1080 }, { width: 0, height: 0 }), 4);
  });
});

describe("clampTransform / toOffset", () => {
  it("scale 1 is always centred, whatever the stored point", () => {
    for (const [x, y] of [[0, 0], [1, 1], [-5, 7], [0.2, 0.9], [Number.NaN, Number.POSITIVE_INFINITY]]) {
      assert.deepEqual(clampTransform(view(1, x, y), B, V), IDENTITY_VIEW);
      assert.deepEqual(toOffset(view(1, x, y), B, V), { scale: 1, left: 0, top: 18.75 });
      assert.deepEqual(toOffset(view(1, x, y), PB, PV), { scale: 1, left: 0, top: 133.75 });
    }
  });

  it("clamps the scale to [1, max]", () => {
    assert.equal(clampTransform(view(0.4), B, V).scale, 1);
    assert.equal(clampTransform(view(Number.NaN), B, V).scale, 1);
    assert.equal(clampTransform(view(50), B, V).scale, MAX_ZOOM);
    assert.equal(clampTransform(view(50), B, V, 3).scale, 3);
    assert.equal(clampTransform(view(2), B, V, 0.5).scale, 1);
  });

  it("zoomed content never shows past an edge; an axis that fits is centred", () => {
    for (const scale of [1, 1.05, 1.2, 2, 3.5, 8]) for (const x of [-1, 0, 0.1, 0.5, 0.93, 1, 2]) for (const y of [-1, 0, 0.3, 0.5, 1, 2]) {
      for (const [box, viewport] of [[B, V], [PB, PV]] as [Size, Size][]) {
        const e = edges(view(scale, x, y), box, viewport);
        const label = `s=${scale} x=${x} y=${y} ${viewport.width}×${viewport.height}`;
        if (scale * box.width > viewport.width) assert.ok(e.left <= 1e-9 && e.right >= viewport.width - 1e-9, label);
        else near(e.left, (viewport.width - scale * box.width) / 2, 1e-9, label);
        if (scale * box.height > viewport.height) assert.ok(e.top <= 1e-9 && e.bottom >= viewport.height - 1e-9, label);
        else near(e.top, (viewport.height - scale * box.height) / 2, 1e-9, label);
      }
    }
  });

  it("phone at 2×: the height still fits (centred), the width is clamped at the left edge", () => {
    const v = clampTransform(view(2, 0, 0.1), PB, PV);
    nearView(v, view(2, 0.25, 0.5));
    const e = edges(v, PB, PV);
    near(e.left, 0);
    near(e.top, 32.5);
    near(e.right, 720);
  });

  it("is idempotent and returns the same object when nothing changes", () => {
    const canonical = view(2.5, 0.3, 0.6);
    assert.equal(clampTransform(canonical, B, V), canonical);
    assert.equal(clampTransform(IDENTITY_VIEW, B, V), IDENTITY_VIEW);
    const clamped = clampTransform(view(3, -2, 9), B, V);
    assert.notEqual(clamped, view(3, -2, 9));
    assert.equal(clampTransform(clamped, B, V), clamped);
  });

  it("keeps the content point at the viewport centre across a resize", () => {
    const v = view(3, 0.4, 0.45);
    const wide = clampTransform(v, B, V);
    const small: Size = { width: 700, height: 600 }, smallBox: Size = { width: 700, height: 393.75 };
    assert.equal(clampTransform(wide, smallBox, small), wide);
    nearPoint(toContent(wide, { x: 350, y: 300 }, smallBox, small), [0.4, 0.45]);
  });

  it("survives an unmeasured box", () => {
    assert.deepEqual(clampTransform(view(2, 0.1, 0.9), { width: 0, height: 0 }, { width: 0, height: 0 }), view(2));
    assert.deepEqual(toOffset(view(2, 0.1, 0.9), { width: 0, height: 0 }, V), { scale: 2, left: 500, top: 300 });
  });

  it("toOffset and fromOffset are inverse", () => {
    for (const v of [view(1), view(1.5, 0.4, 0.5), view(2, 0.3, 0.7), view(8, 0.9, 0.1), view(3.84, 0.0625, 0.9375)]) {
      const c = clampTransform(v, B, V);
      nearView(fromOffset(toOffset(c, B, V), B, V), c);
    }
  });
});

describe("toTransform / fromTransform", () => {
  it("writes translate + scale for transform-origin 0 0, whole px at scale 1", () => {
    assert.equal(toTransform(IDENTITY_VIEW, B, V), "translate(0px, 19px) scale(1)");
    assert.equal(toTransform(IDENTITY_VIEW, PB, PV), "translate(0px, 134px) scale(1)");
    assert.equal(toTransform(view(2), B, V), "translate(-500px, -262.5px) scale(2)");
    assert.equal(toTransform(view(2, 0, 0), B, V), "translate(0px, 0px) scale(2)");
    assert.equal(toTransform(view(1 / 3 + 1, 0.5, 0.5), B, V), "translate(-166.667px, -75px) scale(1.333333)");
  });

  it("round-trips through the CSS string", () => {
    const views = [IDENTITY_VIEW, view(1.5, 0.4, 0.5), view(2), view(2, 0.3, 0.7), view(8, 0.9, 0.1), view(3.84, 0, 1), view(1.01, 0.5, 0.5), view(4, -3, 5)];
    for (const [box, viewport] of [[B, V], [PB, PV]] as [Size, Size][]) for (const v of views) {
      const back = fromTransform(toTransform(v, box, viewport), box, viewport);
      assert.ok(back);
      nearView(back, clampTransform(v, box, viewport), 1e-5, `${JSON.stringify(v)}`);
    }
  });

  it("reads the computed matrix(...) form and 'none'", () => {
    const back = fromTransform("matrix(2, 0, 0, 2, -500, -262.5)", B, V);
    assert.ok(back);
    nearView(back, view(2));
    assert.deepEqual(fromTransform("none", B, V), IDENTITY_VIEW);
    assert.deepEqual(fromTransform("scale(1)", B, V), IDENTITY_VIEW);
    const translated = fromTransform("translate(-250px, -112.5px) scale(2)", B, V);
    assert.ok(translated);
    nearView(translated, view(2, 0.375, 0.3666666666666667));
  });

  it("returns null for anything else", () => {
    assert.equal(fromTransform("", B, V), null);
    assert.equal(fromTransform("rotate(10deg)", B, V), null);
    assert.equal(fromTransform("garbage", B, V), null);
  });
});

describe("toViewport / toContent", () => {
  it("maps normalised frame points to viewport px and back", () => {
    nearXY(toViewport(IDENTITY_VIEW, [0.5, 0.5], B, V), CENTER);
    nearXY(toViewport(IDENTITY_VIEW, [0, 0], B, V), { x: 0, y: 18.75 });
    const v = view(2, 0.3, 0.4);
    nearXY(toViewport(v, [0.3, 0.4], B, V), CENTER);
    for (const p of [[0, 0], [1, 1], [0.25, 0.75], [0.3, 0.4]] as Point[]) nearPoint(toContent(v, toViewport(v, p, B, V), B, V), p);
  });
});

describe("zoomAt", () => {
  it("keeps the focal content point under the cursor when nothing is clamped", () => {
    for (const [start, focus, factor] of [[view(2), { x: 300, y: 200 }, 1.5], [IDENTITY_VIEW, { x: 250, y: 150 }, 2], [view(3, 0.6, 0.4), { x: 700, y: 420 }, 1 / 1.5]] as [View, XY, number][]) {
      const before = toContent(start, focus, B, V);
      const next = zoomAt(start, factor, focus, B, V);
      near(next.scale, start.scale * factor);
      nearPoint(toContent(next, focus, B, V), before);
    }
  });

  it("zooming in and back out about the same point returns to the start", () => {
    const start = view(2, 0.45, 0.55), focus = { x: 420, y: 260 };
    nearView(zoomAt(zoomAt(start, 1.5, focus, B, V), 1 / 1.5, focus, B, V), start);
  });

  it("clamps: zooming at the frame's corner pins that corner to the viewport corner", () => {
    const next = zoomAt(IDENTITY_VIEW, 3, { x: 0, y: 0 }, B, V);
    assert.equal(next.scale, 3);
    nearXY(toViewport(next, [0, 0], B, V), { x: 0, y: 0 });
  });

  it("respects max and min", () => {
    assert.equal(zoomAt(IDENTITY_VIEW, 100, CENTER, B, V).scale, MAX_ZOOM);
    assert.equal(zoomAt(IDENTITY_VIEW, 100, CENTER, B, V, 3).scale, 3);
    assert.deepEqual(zoomAt(view(2, 0.1, 0.1), 0.1, CENTER, B, V), IDENTITY_VIEW);
  });

  it("ignores an invalid factor", () => {
    const v = view(2, 0.4, 0.4);
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(zoomAt(v, factor, CENTER, B, V), v);
  });

  it("returns the same object for factor 1", () => {
    const v = view(2, 0.4, 0.4);
    assert.equal(zoomAt(v, 1, { x: 123, y: 456 }, B, V), v);
  });
});

describe("panBy", () => {
  it("moves the zoomed frame by the delta", () => {
    const e = edges(panBy(view(2), 100, -50, B, V));
    near(e.left, -400);
    near(e.top, -312.5);
  });

  it("stops at the edges", () => {
    const tl = edges(panBy(view(2), 10_000, 10_000, B, V));
    near(tl.left, 0);
    near(tl.top, 0);
    const br = edges(panBy(view(2), -10_000, -10_000, B, V));
    near(br.right, V.width);
    near(br.bottom, V.height);
  });

  it("does nothing at scale 1 and keeps a fitting axis centred", () => {
    assert.equal(panBy(IDENTITY_VIEW, 80, 80, B, V), IDENTITY_VIEW);
    const phone = panBy(view(2), -50, 100, PB, PV);
    assert.equal(phone.y, 0.5);
    near(edges(phone, PB, PV).left, -230);
  });

  it("ignores non-finite deltas", () => {
    const v = view(2, 0.4, 0.4);
    assert.equal(panBy(v, Number.NaN, Number.POSITIVE_INFINITY, B, V), v);
  });
});

describe("pinch", () => {
  const p = (x: number, y: number): XY => ({ x, y });

  it("the finger distance ratio becomes the scale and the midpoint stays anchored", () => {
    const start = { view: IDENTITY_VIEW, p1: p(400, 300), p2: p(500, 300) };
    const next = pinch(start, p(350, 300), p(600, 300), B, V);
    near(next.scale, 2.5);
    nearPoint(toContent(next, p(475, 300), B, V), toContent(IDENTITY_VIEW, p(450, 300), B, V));
  });

  it("the ratio applies to the start scale", () => {
    const start = { view: view(2, 0.4, 0.5), p1: p(450, 300), p2: p(550, 300) };
    near(pinch(start, p(400, 300), p(600, 300), B, V).scale, 4);
    near(pinch(start, p(475, 300), p(525, 300), B, V).scale, 1);
  });

  it("moving both fingers together pans", () => {
    const start = { view: view(2), p1: p(400, 250), p2: p(600, 350) };
    const before = edges(view(2));
    const after = edges(pinch(start, p(440, 220), p(640, 320), B, V));
    near(after.scale, 2);
    near(after.left - before.left, 40);
    near(after.top - before.top, -30);
  });

  it("is clamped to the max scale and to the edges", () => {
    const max = maxScaleFor({ width: 1920, height: 1080 }, B);
    const start = { view: IDENTITY_VIEW, p1: p(495, 300), p2: p(505, 300) };
    const next = pinch(start, p(0, 300), p(1000, 300), B, V, max);
    near(next.scale, max);
    const e = edges(pinch({ view: view(2), p1: p(100, 100), p2: p(200, 100) }, p(900, 500), p(1000, 500), B, V));
    near(e.left, 0);
    near(e.top, 0);
  });

  it("fingers closing together return to the whole frame", () => {
    assert.deepEqual(pinch({ view: view(3, 0.2, 0.8), p1: p(300, 300), p2: p(700, 300) }, p(495, 300), p(505, 300), B, V), IDENTITY_VIEW);
  });

  it("survives coincident start fingers", () => {
    const next = pinch({ view: IDENTITY_VIEW, p1: p(500, 300), p2: p(500, 300) }, p(499, 300), p(501, 300), B, V);
    assert.ok(Number.isFinite(next.scale) && Number.isFinite(next.x) && Number.isFinite(next.y));
    near(next.scale, 2);
  });

  it("returns the start view when the fingers have not moved", () => {
    const v = view(2, 0.4, 0.6);
    assert.equal(pinch({ view: v, p1: p(300, 200), p2: p(600, 400) }, p(300, 200), p(600, 400), B, V), v);
  });
});

describe("toggleZoom (double tap)", () => {
  it("zooms to 2.5× about the tap", () => {
    const focus = { x: 420, y: 260 };
    const next = toggleZoom(IDENTITY_VIEW, focus, B, V);
    near(next.scale, 2.5);
    nearPoint(toContent(next, focus, B, V), toContent(IDENTITY_VIEW, focus, B, V));
  });

  it("goes back to the whole frame when zoomed", () => {
    assert.equal(toggleZoom(view(2.5, 0.2, 0.3), CENTER, B, V), IDENTITY_VIEW);
    assert.equal(toggleZoom(view(1.02), CENTER, B, V), IDENTITY_VIEW);
  });

  it("treats a hair above 1 as not zoomed", () => {
    near(toggleZoom(view(1.005), CENTER, B, V).scale, 2.5);
  });

  it("respects max and a custom target", () => {
    assert.equal(toggleZoom(IDENTITY_VIEW, CENTER, B, V, 2).scale, 2);
    assert.equal(toggleZoom(IDENTITY_VIEW, CENTER, B, V, 8, 4).scale, 4);
  });
});

describe("ensureMinScale (text tool)", () => {
  it("does nothing when the scale is already enough", () => {
    const v = view(2, 0.4, 0.4);
    assert.equal(ensureMinScale(v, 1.5, [0.4, 0.4], B, V), v);
    assert.equal(ensureMinScale(v, 2, [0.4, 0.4], B, V), v);
    assert.equal(ensureMinScale(IDENTITY_VIEW, 0.7, [0.1, 0.1], B, V), IDENTITY_VIEW);
  });

  it("zooms about the normalised point so it stays where it was", () => {
    const point: Point = [0.4, 0.45];
    const before = toViewport(IDENTITY_VIEW, point, B, V);
    const next = ensureMinScale(IDENTITY_VIEW, 2.2, point, B, V);
    near(next.scale, 2.2);
    nearXY(toViewport(next, point, B, V), before);
  });

  it("is capped at max", () => {
    assert.equal(ensureMinScale(IDENTITY_VIEW, 6, [0.5, 0.5], PB, PV, 3).scale, 3);
  });
});

describe("isZoomed / zoomPercent", () => {
  it("uses a small epsilon above 1", () => {
    assert.equal(isZoomed(IDENTITY_VIEW), false);
    assert.equal(isZoomed(view(1.005)), false);
    assert.equal(isZoomed(view(1.02)), true);
    assert.equal(zoomPercent(view(2.456)), 246);
    assert.equal(zoomPercent(IDENTITY_VIEW), 100);
  });
});

describe("wheelZoomFactor", () => {
  it("is 1 without Ctrl (a plain wheel scrolls the page)", () => {
    for (const delta of [-100, -3, 0, 3, 100]) assert.equal(wheelZoomFactor(delta, 0, false), 1);
  });

  it("a mouse notch zooms about 1.28× and in/out are symmetric", () => {
    near(wheelZoomFactor(-100, 0, true), Math.exp(0.25));
    near(wheelZoomFactor(-100, 0, true), 1.284, 1e-3);
    near(wheelZoomFactor(100, 0, true), Math.exp(-0.25));
    near(wheelZoomFactor(-100, 0, true) * wheelZoomFactor(100, 0, true), 1);
  });

  it("converts line and page modes", () => {
    near(wheelZoomFactor(-3, 1, true), wheelZoomFactor(-100, 0, true)); // Firefox notch: 3 lines
    near(wheelZoomFactor(1, 1, true), Math.exp(-0.16));
    near(wheelZoomFactor(-1, 2, true), Math.exp(0.25));
  });

  it("trackpad pinch deltas are small and smooth; pinching out zooms in", () => {
    const f = wheelZoomFactor(-2, 0, true);
    near(f, Math.exp(0.02));
    assert.ok(f > 1 && f < 1.03);
    assert.ok(wheelZoomFactor(1.5, 0, true) < 1);
  });

  it("ignores zero and non-finite deltas", () => {
    assert.equal(wheelZoomFactor(0, 0, true), 1);
    assert.equal(wheelZoomFactor(Number.NaN, 0, true), 1);
  });
});

describe("isTap / isDoubleTap", () => {
  const tap = (t: number, x = 100, y = 100) => ({ t, x, y });

  it("a tap is shorter than 250 ms and moves less than 10 px", () => {
    assert.equal(isTap(tap(0), tap(249, 109, 100)), true);
    assert.equal(isTap(tap(0), tap(250)), false);
    assert.equal(isTap(tap(0), tap(100, 110, 100)), false);
    assert.equal(isTap(tap(10), tap(5)), false);
  });

  it("two taps within 300 ms and 24 px", () => {
    assert.equal(isDoubleTap(tap(0), tap(299, 110, 110)), true);
    assert.equal(isDoubleTap(tap(0), tap(299, 123.9, 100)), true);
    assert.equal(isDoubleTap(tap(0), tap(300)), false);
    assert.equal(isDoubleTap(tap(0), tap(100, 124, 100)), false);
    assert.equal(isDoubleTap(null, tap(100)), false);
    assert.equal(isDoubleTap(undefined, tap(100)), false);
    assert.equal(isDoubleTap(tap(100), tap(50)), false);
  });

  it("accepts custom limits", () => {
    assert.equal(isDoubleTap(tap(0), tap(350, 128, 100), { ms: 400, px: 30 }), true);
    assert.equal(isDoubleTap(tap(0), tap(350, 128, 100)), false);
  });
});

describe("routePointerDown", () => {
  const base: RouteInput = { pointerType: "mouse", button: 0, interaction: "draw", penOnly: false, penDown: false, otherTouches: 0, zoomed: false };
  const route = (over: Partial<RouteInput>) => routePointerDown({ ...base, ...over });

  it("follows the plan table row by row", () => {
    const rows: [string, Partial<RouteInput>, PointerRoute, boolean][] = [
      ["touch while the pen is down (palm)", { pointerType: "touch", penDown: true }, "block", false],
      ["second finger in draw mode", { pointerType: "touch", otherTouches: 1 }, "gesture", false],
      ["second finger reported by isPrimary", { pointerType: "touch", primary: false }, "gesture", false],
      ["finger in draw mode after a pen was used", { pointerType: "touch", penOnly: true }, "gesture", true],
      ["finger in draw mode", { pointerType: "touch" }, "pass", false],
      ["finger in view mode", { pointerType: "touch", interaction: "view" }, "gesture", false],
      ["pen in draw mode switches the session to pen-only", { pointerType: "pen" }, "pass", true],
      ["pen in view mode pans and zooms", { pointerType: "pen", interaction: "view" }, "gesture", false],
      ["mouse drag-pan in view mode when zoomed", { interaction: "view", zoomed: true }, "gesture", false],
      ["mouse in view mode, not zoomed", { interaction: "view" }, "pass", false],
      ["mouse in draw mode, zoomed", { zoomed: true }, "pass", false],
      ["right button in view mode, zoomed", { interaction: "view", zoomed: true, button: 2 }, "pass", false],
      ["middle button (deferred to stage 7)", { interaction: "view", zoomed: true, button: 1 }, "pass", false],
    ];
    for (const [label, over, expected, penOnly] of rows) assert.deepEqual(route(over), { route: expected, penOnly }, label);
  });

  it("matches the table for every combination", () => {
    const expected = (i: RouteInput): { route: PointerRoute; penOnly: boolean } => {
      const draw = i.interaction === "draw";
      if (i.pointerType === "touch") {
        if (i.penDown) return { route: "block", penOnly: i.penOnly };
        if (i.otherTouches >= 1 || i.primary === false) return { route: "gesture", penOnly: i.penOnly };
        if (draw && i.penOnly) return { route: "gesture", penOnly: true };
        return { route: draw ? "pass" : "gesture", penOnly: i.penOnly };
      }
      if (i.pointerType === "pen") return draw ? { route: "pass", penOnly: true } : { route: "gesture", penOnly: i.penOnly };
      return { route: i.button === 0 && !draw && i.zoomed ? "gesture" : "pass", penOnly: i.penOnly };
    };
    let count = 0;
    for (const pointerType of ["touch", "pen", "mouse", "", "unknown"]) for (const button of [0, 1, 2, 5]) for (const interaction of ["draw", "view"] as Interaction[])
      for (const penOnly of [false, true]) for (const penDown of [false, true]) for (const otherTouches of [0, 1, 2]) for (const zoomed of [false, true])
        for (const primary of [undefined, true, false]) {
          const input: RouteInput = { pointerType, button, interaction, penOnly, penDown, otherTouches, zoomed, primary };
          assert.deepEqual(routePointerDown(input), expected(input), JSON.stringify(input));
          count++;
        }
    assert.equal(count, 5 * 4 * 2 * 2 * 2 * 3 * 2 * 3);
  });

  it("two fingers never draw and a palm is never routed to the layer", () => {
    for (const interaction of ["draw", "view"] as Interaction[]) for (const penOnly of [false, true]) for (const zoomed of [false, true]) {
      assert.notEqual(route({ pointerType: "touch", otherTouches: 1, interaction, penOnly, zoomed }).route, "pass");
      assert.equal(route({ pointerType: "touch", penDown: true, otherTouches: 1, interaction, penOnly, zoomed }).route, "block");
    }
  });

  it("only a pen in draw mode turns pen-only on; nothing turns it off", () => {
    for (const pointerType of ["touch", "pen", "mouse"]) for (const interaction of ["draw", "view"] as Interaction[]) {
      assert.equal(route({ pointerType, interaction, penOnly: true }).penOnly, true);
      assert.equal(route({ pointerType, interaction }).penOnly, pointerType === "pen" && interaction === "draw");
    }
  });
});

describe("stripPlacement", () => {
  it("portrait phone 360×470 with a 16:9 frame puts the strip on top", () => {
    assert.equal(stripPlacement(PV, 16 / 9, { top: 96, left: 100 }), "top"); // 360×202.5 vs 260×146.25
  });

  it("a wide area with a portrait frame puts the strip on the left", () => {
    assert.equal(stripPlacement({ width: 1200, height: 700 }, 9 / 16, { top: 136, left: 176 }), "left");
  });

  it("picks the side that is not the limiting dimension", () => {
    // 16:9 frame in a 16:9 area: the height limits the frame, so the strip goes beside it, not on top (unlike width ≥ height).
    assert.equal(stripPlacement({ width: 1280, height: 720 }, 16 / 9, { top: 136, left: 176 }), "left");
    // Wider than tall but width-limited: the strip goes on top.
    assert.equal(stripPlacement({ width: 1000, height: 900 }, 16 / 9, { top: 136, left: 176 }), "top");
    assert.equal(stripPlacement({ width: 640, height: 360 }, 16 / 9, { top: 96, left: 100 }), "left");
  });

  it("ties and degenerate input go to the top", () => {
    assert.equal(stripPlacement({ width: 500, height: 500 }, 1, { top: 100, left: 100 }), "top");
    assert.equal(stripPlacement({ width: 0, height: 0 }, 16 / 9, { top: 96, left: 100 }), "top");
    assert.equal(stripPlacement({ width: 800, height: 600 }, Number.NaN, { top: 96, left: 100 }), "top");
  });

  it("a strip taller than the area goes to the left", () => {
    assert.equal(stripPlacement({ width: 100, height: 50 }, 16 / 9, { top: 60, left: 20 }), "left");
  });
});
