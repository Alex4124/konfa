import type { AnnotationKind, AnnotationPayload, Point } from "@/lib/confa-types";
import { MAX_FREEHAND_POINTS, translateAnnotation } from "./annotation-geometry.ts";

export const ANNOTATION_KINDS: readonly AnnotationKind[] = ["pen", "line", "arrow", "dashed", "marker", "rect", "circle", "triangle", "hexagon", "text"];
export const EDITABLE_KEYS = ["text", "lines", "color", "fontSize", "maxWidth", "w", "h", "strokeWidth"] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];
// A patch on the wire: null removes the key (JSON has no undefined), so undoing an edit can drop keys the edit added.
export type PayloadPatch = { [K in keyof AnnotationPayload]?: AnnotationPayload[K] | null };
export const MAX_PAYLOAD_BYTES = 8000;
export const MAX_TEXT_CHARS = 500;
export const MAX_TEXT_LINES = 40;
export const MAX_LINES_CHARS = 600;

export type ValidationResult = { encoded: string; payload: AnnotationPayload } | { error: string };

const INVALID = "Некорректная пометка";
const INVALID_COLOR = "Некорректный цвет";
const INVALID_TEXT = "Некорректный текст";
const INVALID_POINTS = "Некорректные координаты";
const INVALID_WIDTH = "Некорректная толщина";
const TOO_LARGE = "Пометка слишком большая";
const EXTENT_EPSILON = 1.0001;

const encoder = new TextEncoder();

export function isAnnotationKind(kind: unknown): kind is AnnotationKind {
  return typeof kind === "string" && (ANNOTATION_KINDS as readonly string[]).includes(kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function validPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 && finiteIn(value[0], 0, 1) && finiteIn(value[1], 0, 1);
}

function validExtent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function validLines(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_TEXT_LINES && value.every((line) => typeof line === "string") && value.join("\n").length <= MAX_LINES_CHARS;
}

function rebuild(kind: AnnotationKind, data: Record<string, unknown>): AnnotationPayload | string {
  const { color, fa, strokeWidth } = data;
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return INVALID_COLOR;
  if (fa !== undefined && !finiteIn(fa, 0.1, 10)) return INVALID;
  if (kind !== "text") {
    const maxPoints = kind === "pen" || kind === "marker" ? MAX_FREEHAND_POINTS : 2;
    const points = data.points;
    if (!Array.isArray(points) || points.length < 2 || points.length > maxPoints || !points.every(validPoint)) return INVALID_POINTS;
    if (strokeWidth !== undefined && !intIn(strokeWidth, 1, 24)) return INVALID_WIDTH;
    const payload: AnnotationPayload = { color, points: points.map(([x, y]): Point => [x, y]) };
    if (strokeWidth !== undefined) payload.strokeWidth = strokeWidth;
    if (fa !== undefined) payload.fa = fa;
    return payload;
  }
  const { point, text, lines, fontSize, maxWidth, w, h, chem } = data;
  if (!validPoint(point)) return INVALID_POINTS;
  if (chem !== undefined && chem !== 1) return INVALID_TEXT;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS || text.split("\n").length > MAX_TEXT_LINES) return INVALID_TEXT;
  if (strokeWidth !== undefined) return INVALID_WIDTH;
  if (lines !== undefined && !validLines(lines)) return INVALID_TEXT;
  if (fontSize !== undefined && !intIn(fontSize, 10, 72)) return INVALID_TEXT;
  if (maxWidth !== undefined && !finiteIn(maxWidth, 0.05, 1)) return INVALID_TEXT;
  if ((w === undefined) !== (h === undefined)) return INVALID_TEXT;
  const payload: AnnotationPayload = { color, point: [point[0], point[1]], text };
  if (lines !== undefined) payload.lines = [...lines];
  if (fontSize !== undefined) payload.fontSize = fontSize;
  if (maxWidth !== undefined) payload.maxWidth = maxWidth;
  if (w !== undefined || h !== undefined) {
    if (!validExtent(w) || !validExtent(h) || point[0] + w > EXTENT_EPSILON || point[1] + h > EXTENT_EPSILON) return INVALID_POINTS;
    payload.w = w;
    payload.h = h;
  }
  if (chem === 1) payload.chem = 1;
  if (fa !== undefined) payload.fa = fa;
  return payload;
}

// Pure; shared by the server route and the client. Rebuilds the payload from whitelisted keys only.
export function validateAnnotationPayload(kind: string, payload: unknown): ValidationResult {
  if (!isAnnotationKind(kind) || !isRecord(payload)) return { error: INVALID };
  const rebuilt = rebuild(kind, payload);
  if (typeof rebuilt === "string") return { error: rebuilt };
  const encoded = JSON.stringify(rebuilt);
  if (encoded.length > MAX_PAYLOAD_BYTES || encoder.encode(encoded).length > MAX_PAYLOAD_BYTES) return { error: TOO_LARGE };
  return { encoded, payload: rebuilt };
}

// Applies only EDITABLE_KEYS (never point/points; null removes a key), re-clamps the merged mark into the frame, then validates.
export function validatePatch(kind: string, current: AnnotationPayload, patch: unknown): ValidationResult {
  if (!isRecord(patch)) return { error: INVALID };
  const changes: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) if (Object.prototype.hasOwnProperty.call(patch, key)) changes[key] = patch[key] === null ? undefined : patch[key];
  if (!Object.keys(changes).length) return { error: INVALID };
  const merged: Record<string, unknown> = { ...current, ...changes };
  if ("text" in changes && !("lines" in changes)) delete merged.lines;
  let clamped: AnnotationPayload;
  try {
    clamped = translateAnnotation(merged as AnnotationPayload, 0, 0).payload;
  } catch {
    return { error: INVALID_POINTS };
  }
  return validateAnnotationPayload(kind, clamped);
}
