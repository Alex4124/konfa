import type { AnnotationPayload, Point, Tool } from "@/lib/confa-types";

export const REF_HEIGHT = 720;
export const MAX_FREEHAND_POINTS = 400;
export const FREEHAND_CAP = 360;
export const MIN_STEP_SCREEN_PX = 1.5;
export const CLICK_PX = 6;
export const ARROW_MIN_PX = 10;
export const SHAPE_MIN_SIDE_PX = 4;
export const HIT_RADIUS_PX = { mouse: 8, pen: 8, touch: 16 } as const;
export const TEXT_SIZE_UNITS = { s: 18, m: 26, l: 40 } as const;
export const LEGACY_TEXT_UNITS = 26;
export const TEXT_FONT = "Arial, Helvetica, sans-serif";
export const ASPECT_TOLERANCE = 0.02;
export const DEFAULT_STROKE_UNITS = 5;
export const LEGACY_MARKER_UNITS = 23;
export const LEGACY_TEXT_EXTENT = 0.05;

const LEGACY_LINE_HEIGHT = 1.25;
const LEGACY_CHAR_EM = 0.6;
const ARROW_HEAD_ANGLE = 0.6;
const ELLIPSE_SEGMENTS = 64;

export type Size = { width: number; height: number };
export type Rect = Size & { left: number; top: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type TextBox = { x: number; y: number; w: number; h: number };
export type Primitive =
  | { type: "polyline"; points: Point[]; closed: boolean }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { type: "box"; x: number; y: number; w: number; h: number };
export type HitItem = { id: string; kind: Tool; data: AnnotationPayload };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const r2 = (value: number) => Math.round(value * 100) / 100;

export function isFreehand(kind: Tool): boolean {
  return kind === "pen" || kind === "marker";
}

export function isShape(kind: Tool): boolean {
  return kind === "rect" || kind === "circle" || kind === "triangle" || kind === "hexagon";
}

export function isLineLike(kind: Tool): boolean {
  return kind === "line" || kind === "arrow" || kind === "dashed";
}

export function hitRadiusFor(pointerType: string): number {
  return pointerType === "touch" ? HIT_RADIUS_PX.touch : pointerType === "pen" ? HIT_RADIUS_PX.pen : HIT_RADIUS_PX.mouse;
}

// Units: px = units * boxHeight / REF_HEIGHT

export function unitsToPx(units: number, boxHeight: number): number {
  return units * boxHeight / REF_HEIGHT;
}

export function strokeUnits(kind: Tool, data: Pick<AnnotationPayload, "strokeWidth">): number {
  const width = data.strokeWidth;
  if (typeof width === "number" && Number.isInteger(width) && width >= 1 && width <= 24) return width;
  return kind === "marker" ? LEGACY_MARKER_UNITS : DEFAULT_STROKE_UNITS;
}

export function strokePx(units: number, boxHeight: number): number {
  return Math.max(1, unitsToPx(units, boxHeight));
}

export function arrowHeadPx(units: number, boxHeight: number, lengthPx: number): number {
  return Math.min(unitsToPx(Math.max(12, 4 * units), boxHeight), Math.max(0.45 * lengthPx, 3 * strokePx(units, boxHeight)));
}

export function dashArray(px: number): string {
  return `${r2(3 * px)} ${r2(2 * px)}`;
}

export function textUnits(data: Pick<AnnotationPayload, "fontSize">): number {
  const size = data.fontSize;
  return typeof size === "number" && Number.isInteger(size) && size >= 10 && size <= 72 ? size : LEGACY_TEXT_UNITS;
}

export function fontPx(units: number, boxHeight: number): number {
  return unitsToPx(units, boxHeight);
}

// Coordinates and freehand

export function round4(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
}

export function roundPoint(point: Point): Point {
  return [round4(point[0]), round4(point[1])];
}

export function normFromClient(x: number, y: number, rect: Rect): Point {
  return [rect.width > 0 ? clamp01((x - rect.left) / rect.width) : 0, rect.height > 0 ? clamp01((y - rect.top) / rect.height) : 0];
}

export function screenDistance(a: Point, b: Point, screen: Size): number {
  return Math.hypot((a[0] - b[0]) * screen.width, (a[1] - b[1]) * screen.height);
}

// Mutates `points`; returns the number of samples appended.
export function pushFiltered(points: Point[], samples: readonly Point[], screen: Size, minStep = MIN_STEP_SCREEN_PX): number {
  let added = 0;
  for (const sample of samples) {
    const last = points[points.length - 1];
    if (last && screenDistance(last, sample, screen) < minStep) continue;
    points.push(sample);
    added++;
  }
  return added;
}

function scaledSegmentDistance(p: Point, a: Point, b: Point, sx: number, sy: number): number {
  const px = p[0] * sx, py = p[1] * sy, ax = a[0] * sx, ay = a[1] * sy, bx = b[0] * sx, by = b[1] * sy;
  const vx = bx - ax, vy = by - ay;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq > 0 ? clamp01(((px - ax) * vx + (py - ay) * vy) / lengthSq) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// Iterative Ramer–Douglas–Peucker in reference space (X = x*aspect*720, Y = y*720), distance to the segment.
export function simplifyRdp(points: readonly Point[], epsUnits: number, aspect: number): Point[] {
  const count = points.length;
  if (count <= 2) return points.slice();
  const sx = (aspect > 0 && Number.isFinite(aspect) ? aspect : 1) * REF_HEIGHT, sy = REF_HEIGHT;
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: number[] = [0, count - 1];
  while (stack.length) {
    const last = stack.pop() as number;
    const first = stack.pop() as number;
    let index = -1, max = epsUnits;
    for (let i = first + 1; i < last; i++) {
      const distance = scaledSegmentDistance(points[i], points[first], points[last], sx, sy);
      if (distance > max) { max = distance; index = i; }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function decimate(points: readonly Point[], cap: number): Point[] {
  const target = Math.max(2, Math.floor(cap));
  if (points.length <= target) return points.slice();
  const out: Point[] = [];
  for (let i = 0; i < target; i++) out.push(points[Math.round(i * (points.length - 1) / (target - 1))]);
  return out;
}

export function simplifyToCap(points: readonly Point[], cap: number, aspect: number, eps0 = 0.4): Point[] {
  let eps = eps0;
  let out = simplifyRdp(points, eps, aspect);
  while (out.length > cap && eps < 64) {
    eps *= 1.5;
    out = simplifyRdp(points, eps, aspect);
  }
  return out.length > cap ? decimate(out, cap) : out;
}

export function finalizeFreehand(points: readonly Point[], aspect: number, cap = FREEHAND_CAP): Point[] {
  if (!points.length) return [];
  const simplified = points.length === 1 ? [points[0]] : simplifyToCap(points, cap, aspect);
  const out: Point[] = [];
  for (const point of simplified) {
    const rounded = roundPoint(point);
    const last = out[out.length - 1];
    if (!last || last[0] !== rounded[0] || last[1] !== rounded[1]) out.push(rounded);
  }
  return out.length === 1 ? [out[0], [out[0][0], out[0][1]]] : out;
}

// Shapes

export function constrainEnd(kind: Tool, start: Point, end: Point, aspect: number, shift: boolean): Point {
  if (!shift || !(aspect > 0)) return end;
  const [sx, sy] = start;
  const dxp = (end[0] - sx) * aspect, dy = end[1] - sy;
  if (isLineLike(kind)) {
    const length = Math.hypot(dxp, dy);
    if (!length) return end;
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dxp) / step) * step;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let limit = length;
    if (ux > 1e-9) limit = Math.min(limit, (1 - sx) * aspect / ux);
    if (ux < -1e-9) limit = Math.min(limit, sx * aspect / -ux);
    if (uy > 1e-9) limit = Math.min(limit, (1 - sy) / uy);
    if (uy < -1e-9) limit = Math.min(limit, sy / -uy);
    return [clamp01(sx + limit * ux / aspect), clamp01(sy + limit * uy)];
  }
  if (isShape(kind)) {
    const signX = dxp < 0 ? -1 : 1, signY = dy < 0 ? -1 : 1;
    const side = Math.min(Math.max(Math.abs(dxp), Math.abs(dy)), signX > 0 ? (1 - sx) * aspect : sx * aspect, signY > 0 ? 1 - sy : sy);
    return [clamp01(sx + signX * side / aspect), clamp01(sy + signY * side)];
  }
  return end;
}

export function isDegenerate(kind: Tool, start: Point, end: Point, screen: Size): boolean {
  const dx = Math.abs(end[0] - start[0]) * screen.width, dy = Math.abs(end[1] - start[1]) * screen.height;
  const length = Math.hypot(dx, dy);
  if (kind === "line" || kind === "dashed") return length < CLICK_PX;
  if (kind === "arrow") return length < ARROW_MIN_PX;
  if (isShape(kind)) return length < CLICK_PX || Math.min(dx, dy) < SHAPE_MIN_SIDE_PX;
  return false;
}

function validExtent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Text plate box in normalized frame coordinates; legacy rows are estimated from the box when given.
export function textBoxNorm(data: AnnotationPayload, box?: Size): TextBox | null {
  if (!data.point) return null;
  const [x, y] = data.point;
  if (validExtent(data.w) && validExtent(data.h)) return { x, y, w: data.w, h: data.h };
  if (box && box.width > 0 && box.height > 0) {
    const size = fontPx(textUnits(data), box.height);
    const lines = data.lines?.length ? data.lines : (data.text ?? "").split("\n");
    const longest = lines.reduce((max, line) => Math.max(max, Array.from(line).length), 0);
    return { x, y, w: Math.max(0, Math.min(1 - x, LEGACY_CHAR_EM * size * longest / box.width)), h: lines.length * LEGACY_LINE_HEIGHT * size / box.height };
  }
  return { x, y, w: LEGACY_TEXT_EXTENT, h: LEGACY_TEXT_EXTENT };
}

function pointsBounds(points: readonly Point[] | undefined): Bounds | null {
  if (!points?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX + minY + maxX + maxY) ? { minX, minY, maxX, maxY } : null;
}

export function annotationBounds(kind: Tool, data: AnnotationPayload, box?: Size): Bounds | null {
  if (kind === "text" || (data.point && !data.points)) {
    const text = textBoxNorm(data, box);
    return text ? { minX: text.x, minY: text.y, maxX: text.x + text.w, maxY: text.y + text.h } : null;
  }
  return pointsBounds(data.points);
}

// Clamps the shift so the whole mark (text: point + [w, h]; legacy text: anchor ≤ 0.95) stays inside the frame.
export function translateAnnotation(data: AnnotationPayload, requestedX: number, requestedY: number): { payload: AnnotationPayload; dx: number; dy: number } {
  const bounds = annotationBounds(data.point ? "text" : "pen", data);
  if (!bounds) throw new Error("У пометки нет координат");
  const dx = round4(clamp(Number.isFinite(requestedX) ? requestedX : 0, -bounds.minX, 1 - bounds.maxX));
  const dy = round4(clamp(Number.isFinite(requestedY) ? requestedY : 0, -bounds.minY, 1 - bounds.maxY));
  const shift = ([x, y]: Point): Point => [round4(clamp01(x + dx)), round4(clamp01(y + dy))];
  return {
    payload: {
      ...data,
      ...(data.point ? { point: shift(data.point) } : {}),
      ...(data.points ? { points: data.points.map(shift) } : {}),
    },
    dx,
    dy,
  };
}

export function primitivesPx(kind: Tool, data: AnnotationPayload, size: Size): Primitive[] {
  const { width: W, height: H } = size;
  if (kind === "text") {
    const text = textBoxNorm(data, size);
    return text ? [{ type: "box", x: text.x * W, y: text.y * H, w: text.w * W, h: text.h * H }] : [];
  }
  if (kind === "eraser" || kind === "move" || !data.points?.length) return [];
  const points = data.points.map(([x, y]): Point => [x * W, y * H]);
  if (kind === "pen" || kind === "marker" || kind === "laser") return [{ type: "polyline", points, closed: false }];
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  if (kind === "line" || kind === "dashed") return [{ type: "polyline", points: [[x1, y1], [x2, y2]], closed: false }];
  if (kind === "arrow") {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = arrowHeadPx(strokeUnits(kind, data), H, Math.hypot(x2 - x1, y2 - y1));
    return [
      { type: "polyline", points: [[x1, y1], [x2, y2]], closed: false },
      { type: "polyline", points: [[x2, y2], [x2 - head * Math.cos(angle - ARROW_HEAD_ANGLE), y2 - head * Math.sin(angle - ARROW_HEAD_ANGLE)]], closed: false },
      { type: "polyline", points: [[x2, y2], [x2 - head * Math.cos(angle + ARROW_HEAD_ANGLE), y2 - head * Math.sin(angle + ARROW_HEAD_ANGLE)]], closed: false },
    ];
  }
  const left = Math.min(x1, x2), top = Math.min(y1, y2), width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  if (kind === "circle") return [{ type: "ellipse", cx: left + width / 2, cy: top + height / 2, rx: width / 2, ry: height / 2 }];
  if (kind === "rect") return [{ type: "polyline", points: [[left, top], [left + width, top], [left + width, top + height], [left, top + height]], closed: true }];
  if (kind === "triangle") return [{ type: "polyline", points: [[left + width / 2, top], [left + width, top + height], [left, top + height]], closed: true }];
  if (kind === "hexagon") {
    return [{ type: "polyline", points: [[left + width * .25, top], [left + width * .75, top], [left + width, top + height / 2], [left + width * .75, top + height], [left + width * .25, top + height], [left, top + height / 2]], closed: true }];
  }
  return [];
}

// Hit-testing in screen px

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  return scaledSegmentDistance(p, a, b, 1, 1);
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function polylineDistance(points: readonly Point[], closed: boolean, a: Point, b: Point): number {
  if (points.length === 1) return segmentDistance(a, b, points[0], points[0]);
  let min = Infinity;
  for (let i = 1; i < points.length && min > 0; i++) min = Math.min(min, segmentDistance(a, b, points[i - 1], points[i]));
  if (closed && points.length > 2 && min > 0) min = Math.min(min, segmentDistance(a, b, points[points.length - 1], points[0]));
  return min;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const angle = i * 2 * Math.PI / ELLIPSE_SEGMENTS;
    out.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return out;
}

function primitiveDistance(primitive: Primitive, a: Point, b: Point): number {
  if (primitive.type === "polyline") return polylineDistance(primitive.points, primitive.closed, a, b);
  if (primitive.type === "ellipse") return polylineDistance(ellipsePoints(primitive.cx, primitive.cy, primitive.rx, primitive.ry), true, a, b);
  const { x, y, w, h } = primitive;
  const inside = (p: Point) => p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
  if (inside(a) || inside(b)) return 0;
  return polylineDistance([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, a, b);
}

// Minimum distance (px) from the swept segment a→b (normalized) to the item's outline; text boxes count their interior.
export function distanceToItemPx(item: HitItem, a: Point, b: Point, screen: Size): number {
  const pa: Point = [a[0] * screen.width, a[1] * screen.height], pb: Point = [b[0] * screen.width, b[1] * screen.height];
  let min = Infinity;
  for (const primitive of primitivesPx(item.kind, item.data, screen)) {
    min = Math.min(min, primitiveDistance(primitive, pa, pb));
    if (min === 0) break;
  }
  return min;
}

function hitSlack(item: HitItem, screen: Size): { half: number; pad: number } {
  if (item.kind === "text") return { half: 0, pad: 0 };
  const units = strokeUnits(item.kind, item.data);
  const half = strokePx(units, screen.height) / 2;
  return { half, pad: half + (item.kind === "arrow" ? unitsToPx(Math.max(12, 4 * units), screen.height) : 0) };
}

function hits(item: HitItem, a: Point, b: Point, screen: Size, radiusPx: number): boolean {
  const bounds = annotationBounds(item.kind, item.data, screen);
  if (!bounds) return false;
  const { half, pad } = hitSlack(item, screen);
  const margin = radiusPx + pad;
  const W = screen.width, H = screen.height;
  if (Math.max(a[0], b[0]) * W < bounds.minX * W - margin || Math.min(a[0], b[0]) * W > bounds.maxX * W + margin) return false;
  if (Math.max(a[1], b[1]) * H < bounds.minY * H - margin || Math.min(a[1], b[1]) * H > bounds.maxY * H + margin) return false;
  return distanceToItemPx(item, a, b, screen) <= radiusPx + half;
}

export function eraseHits(items: readonly HitItem[], a: Point, b: Point, screen: Size, radiusPx: number): string[] {
  const ids: string[] = [];
  for (const item of items) if (hits(item, a, b, screen, radiusPx)) ids.push(item.id);
  return ids;
}

// Smallest bounding box wins; ties go to the newest (latest in `items`).
export function pickForMove(items: readonly HitItem[], p: Point, screen: Size, radiusPx: number): string | null {
  let best: string | null = null, bestArea = Infinity;
  for (const item of items) {
    if (!hits(item, p, p, screen, radiusPx)) continue;
    const bounds = annotationBounds(item.kind, item.data, screen);
    const area = bounds ? (bounds.maxX - bounds.minX) * screen.width * (bounds.maxY - bounds.minY) * screen.height : Infinity;
    if (area <= bestArea) { best = item.id; bestArea = area; }
  }
  return best;
}

// Frame helpers

export function fitBox(container: Size, aspect: number): Size {
  if (!(aspect > 0) || !Number.isFinite(aspect) || !(container.width > 0) || !(container.height > 0)) return { width: 0, height: 0 };
  const width = Math.min(container.width, container.height * aspect);
  return { width, height: width / aspect };
}

export function aspectMismatch(stored: number | undefined, current: number, tol = ASPECT_TOLERANCE): boolean {
  if (stored === undefined || !(stored > 0) || !(current > 0)) return false;
  return Math.abs(Math.log(stored / current)) > tol;
}
