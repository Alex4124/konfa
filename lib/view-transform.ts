import type { Point } from "@/lib/confa-types";
import { fitBox, type Size } from "./annotation-geometry.ts";

// Per-viewer zoom of the shared-screen frame (video and marks together). A View is what SharedScreen keeps in state:
// the scale and the content point (x, y normalised 0..1 of the frame box) shown at the viewport centre, so a resize or
// a new frame aspect keeps what the viewer was looking at. Every XY here is viewport-relative CSS px
// (clientX - viewportRect.left, clientY - viewportRect.top). The frame element is positioned at the viewport's top-left
// and gets toTransform(...) with transform-origin 0 0.

export type XY = { x: number; y: number };
export type View = Readonly<{ scale: number; x: number; y: number }>;
// Where the scaled frame sits: screen = (left, top) + scale * frame px.
export type FrameOffset = Readonly<{ scale: number; left: number; top: number }>;
export type PinchStart = Readonly<{ view: View; p1: XY; p2: XY }>;
export type Tap = Readonly<{ t: number; x: number; y: number }>;
export type TapLimits = Readonly<{ ms: number; px: number }>;
export type Interaction = "draw" | "view";
export type PointerRoute = "gesture" | "pass" | "block";
export type RouteInput = Readonly<{
  pointerType: string;
  button: number;
  interaction: Interaction;
  penOnly: boolean;
  penDown: boolean; // a pen pointer is currently down on the viewport
  otherTouches: number; // touch pointers already down, not counting this one
  zoomed: boolean;
  primary?: boolean; // PointerEvent.isPrimary; false for a touch means another finger is down
}>;
// penOnly is the next value of the session flag (a pen contact in draw mode turns it on).
export type RouteDecision = Readonly<{ route: PointerRoute; penOnly: boolean }>;
export type StripSize = Readonly<{ top: number; left: number }>;
export type StripPlacement = "top" | "left";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const MAX_ZOOM_FLOOR = 3;
export const DEFAULT_MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
export const ZOOM_STEP = 1.5;
export const ZOOMED_EPSILON = 0.01;
export const DOUBLE_TAP: TapLimits = Object.freeze({ ms: 300, px: 24 });
export const TAP: TapLimits = Object.freeze({ ms: 250, px: 10 });
export const WHEEL_LINE_PX = 16;
export const WHEEL_PAGE_PX = 800;
export const WHEEL_MAX_PX = 25;
export const WHEEL_RATE = 0.01;
export const IDENTITY_VIEW: View = Object.freeze({ scale: 1, x: 0.5, y: 0.5 });

const SAME_EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function clampScale(scale: number, max: number): number {
  return clamp(finite(scale, MIN_ZOOM), MIN_ZOOM, Math.max(MIN_ZOOM, finite(max, MAX_ZOOM)));
}

// Content larger than the viewport may not leave a gap at either edge; smaller content is centred.
function clampAxis(offset: number, content: number, viewport: number): number {
  if (!(content > viewport)) return (viewport - content) / 2;
  return clamp(finite(offset, 0), viewport - content, 0);
}

function sameView(a: View, b: View): boolean {
  return Math.abs(a.scale - b.scale) < SAME_EPSILON && Math.abs(a.x - b.x) < SAME_EPSILON && Math.abs(a.y - b.y) < SAME_EPSILON;
}

function keep(previous: View, next: View): View {
  return sameView(previous, next) ? previous : next;
}

export function isZoomed(view: View): boolean {
  return view.scale > MIN_ZOOM + ZOOMED_EPSILON;
}

export function zoomPercent(view: View): number {
  return Math.round(view.scale * 100);
}

export function maxScaleFor(frame: Size | null | undefined, box: Size): number {
  if (!frame || !(frame.width > 0) || !(box.width > 0)) return DEFAULT_MAX_ZOOM;
  return clamp(2 * frame.width / box.width, MAX_ZOOM_FLOOR, MAX_ZOOM);
}

export function toOffset(view: View, box: Size, viewport: Size, max = MAX_ZOOM): FrameOffset {
  const scale = clampScale(view.scale, max);
  const width = scale * box.width, height = scale * box.height;
  return {
    scale,
    left: clampAxis(viewport.width / 2 - finite(view.x, 0.5) * width, width, viewport.width),
    top: clampAxis(viewport.height / 2 - finite(view.y, 0.5) * height, height, viewport.height),
  };
}

export function fromOffset(offset: FrameOffset, box: Size, viewport: Size, max = MAX_ZOOM): View {
  const scale = clampScale(offset.scale, max);
  const width = scale * box.width, height = scale * box.height;
  const left = clampAxis(offset.left, width, viewport.width), top = clampAxis(offset.top, height, viewport.height);
  return { scale, x: width > viewport.width ? (viewport.width / 2 - left) / width : 0.5, y: height > viewport.height ? (viewport.height / 2 - top) / height : 0.5 };
}

// Canonical form: scale in [1, max]; the frame never shows past its edges; an axis that fits is centred (0.5).
// Returns the same object when nothing changes, so it is safe inside a setState updater.
export function clampTransform(view: View, box: Size, viewport: Size, max = MAX_ZOOM): View {
  return keep(view, fromOffset(toOffset(view, box, viewport, max), box, viewport, max));
}

const cssNumber = (value: number, digits: number) => `${Number(value.toFixed(digits)) || 0}`;

// The frame's CSS transform (transform-origin 0 0). At scale 1 the offset is rounded to whole px to keep video and text sharp.
export function toTransform(view: View, box: Size, viewport: Size, max = MAX_ZOOM): string {
  const { scale, left, top } = toOffset(view, box, viewport, max);
  const whole = scale === MIN_ZOOM;
  return `translate(${whole ? Math.round(left) || 0 : cssNumber(left, 3)}px, ${whole ? Math.round(top) || 0 : cssNumber(top, 3)}px) scale(${cssNumber(scale, 6)})`;
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const TRANSLATE_RE = new RegExp(String.raw`translate\(\s*(${NUMBER})(?:px)?\s*(?:,\s*(${NUMBER})(?:px)?\s*)?\)`, "i");
const SCALE_RE = new RegExp(String.raw`scale\(\s*(${NUMBER})\s*(?:,\s*${NUMBER}\s*)?\)`, "i");
const MATRIX_RE = new RegExp(String.raw`^\s*matrix\(\s*(${NUMBER})\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\)\s*$`, "i");

// Inverse of toTransform; also reads the computed matrix(...) form. null when the string is not a translate/scale transform.
export function fromTransform(css: string, box: Size, viewport: Size, max = MAX_ZOOM): View | null {
  const text = css.trim();
  if (text === "none") return fromOffset({ scale: 1, left: 0, top: 0 }, box, viewport, max);
  const matrix = MATRIX_RE.exec(text);
  if (matrix) return fromOffset({ scale: Number(matrix[1]), left: Number(matrix[2]), top: Number(matrix[3]) }, box, viewport, max);
  const translate = TRANSLATE_RE.exec(text), scale = SCALE_RE.exec(text);
  if (!translate && !scale) return null;
  return fromOffset({ scale: scale ? Number(scale[1]) : 1, left: translate ? Number(translate[1]) : 0, top: translate?.[2] ? Number(translate[2]) : 0 }, box, viewport, max);
}

// Normalised frame point -> viewport px, and back (not clamped to the frame).
export function toViewport(view: View, point: Point, box: Size, viewport: Size, max = MAX_ZOOM): XY {
  const { scale, left, top } = toOffset(view, box, viewport, max);
  return { x: left + scale * point[0] * box.width, y: top + scale * point[1] * box.height };
}

export function toContent(view: View, at: XY, box: Size, viewport: Size, max = MAX_ZOOM): Point {
  const { scale, left, top } = toOffset(view, box, viewport, max);
  return [box.width > 0 ? (at.x - left) / (scale * box.width) : 0.5, box.height > 0 ? (at.y - top) / (scale * box.height) : 0.5];
}

// The content point under `focus` stays under it unless clamping has to move it.
export function zoomAt(view: View, factor: number, focus: XY, box: Size, viewport: Size, max = MAX_ZOOM): View {
  const from = toOffset(view, box, viewport, max);
  if (!(factor > 0) || !Number.isFinite(factor)) return clampTransform(view, box, viewport, max);
  const scale = clampScale(from.scale * factor, max), k = scale / from.scale;
  return keep(view, fromOffset({ scale, left: focus.x - (focus.x - from.left) * k, top: focus.y - (focus.y - from.top) * k }, box, viewport, max));
}

export function panBy(view: View, dx: number, dy: number, box: Size, viewport: Size, max = MAX_ZOOM): View {
  const from = toOffset(view, box, viewport, max);
  return keep(view, fromOffset({ scale: from.scale, left: from.left + finite(dx, 0), top: from.top + finite(dy, 0) }, box, viewport, max));
}

// Two fingers: the scale follows the finger distance ratio and the content under the start midpoint follows the
// current midpoint, so moving both fingers pans. Always computed from the gesture start, never incrementally.
export function pinch(start: PinchStart, p1: XY, p2: XY, box: Size, viewport: Size, max = MAX_ZOOM): View {
  const from = toOffset(start.view, box, viewport, max);
  const scale = clampScale(from.scale * distance(p1, p2) / Math.max(distance(start.p1, start.p2), 1), max);
  const m0 = midpoint(start.p1, start.p2), m1 = midpoint(p1, p2);
  const cx = (m0.x - from.left) / from.scale, cy = (m0.y - from.top) / from.scale;
  return keep(start.view, fromOffset({ scale, left: m1.x - scale * cx, top: m1.y - scale * cy }, box, viewport, max));
}

// Double-tap / double-click: zoomed -> back to the whole frame; otherwise zoom to `target` about the tap.
export function toggleZoom(view: View, focus: XY, box: Size, viewport: Size, max = MAX_ZOOM, target = DOUBLE_TAP_ZOOM): View {
  if (isZoomed(view)) return clampTransform(IDENTITY_VIEW, box, viewport, max);
  return zoomAt(view, target / clampScale(view.scale, max), focus, box, viewport, max);
}

// Text tool: zoom in about a normalised frame point until the scale is at least `min`.
export function ensureMinScale(view: View, min: number, focus: Point, box: Size, viewport: Size, max = MAX_ZOOM): View {
  const current = clampScale(view.scale, max);
  if (!(min > current)) return clampTransform(view, box, viewport, max);
  return zoomAt(view, min / current, toViewport(view, focus, box, viewport, max), box, viewport, max);
}

// Ctrl+wheel and trackpad pinch (Chrome/Edge/Firefox send ctrlKey). 1 means "not a zoom wheel".
// A mouse notch (100 px or 3 lines) gives about 1.28x; trackpad deltas are small, so the zoom is smooth.
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  if (!ctrlKey || !Number.isFinite(deltaY)) return 1;
  const px = deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * WHEEL_PAGE_PX : deltaY;
  return Math.exp(-clamp(px, -WHEEL_MAX_PX, WHEEL_MAX_PX) * WHEEL_RATE);
}

export function isTap(down: Tap, up: Tap, limits: TapLimits = TAP): boolean {
  const dt = up.t - down.t;
  return dt >= 0 && dt < limits.ms && distance(down, up) < limits.px;
}

export function isDoubleTap(prev: Tap | null | undefined, next: Tap, limits: TapLimits = DOUBLE_TAP): boolean {
  if (!prev) return false;
  const dt = next.t - prev.t;
  return dt >= 0 && dt < limits.ms && distance(prev, next) < limits.px;
}

// Capture-phase pointerdown arbiter on a zoomable viewport. gesture: SharedScreen pans/zooms (onGestureStart listeners,
// then setPointerCapture; the pointerdown still bubbles, its later events are stopped; a touch gesture also takes over a
// touch stroke in progress); pass: the annotation layer gets the event; block: swallowed (a palm while the pen is down).
export function routePointerDown(input: RouteInput): RouteDecision {
  const draw = input.interaction === "draw";
  const decide = (route: PointerRoute, penOnly = input.penOnly): RouteDecision => ({ route, penOnly });
  if (input.pointerType === "touch") {
    if (input.penDown) return decide("block");
    if (input.otherTouches > 0 || input.primary === false) return decide("gesture");
    return decide(draw && !input.penOnly ? "pass" : "gesture");
  }
  if (input.pointerType === "pen") return draw ? decide("pass", true) : decide("gesture");
  return decide(input.button === 0 && !draw && input.zoomed ? "gesture" : "pass");
}

// Participants strip beside the presentation: pick the side that leaves the larger frame (ties go to the top).
// `strip` is the strip's height when on top and its width when on the left.
export function stripPlacement(area: Size, aspect: number, strip: StripSize): StripPlacement {
  const top = fitBox({ width: area.width, height: area.height - strip.top }, aspect);
  const left = fitBox({ width: area.width - strip.left, height: area.height }, aspect);
  return top.width * top.height >= left.width * left.height ? "top" : "left";
}
