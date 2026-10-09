import type { AnnotationOp } from "@/lib/confa-types";

export const ANNOTATION_CAP = 500;
export const ANNOTATION_READ_LIMIT = 600;
export const ADD_RATE_MAX = 80;
export const ADD_RATE_WINDOW_MS = 10_000;
export const MAX_TARGET_IDS = 600;
export const SQL_IN_CHUNK = 90; // keeps every statement under D1's 100 bound parameters
export const MAX_OP_BYTES = 12_000; // LiveKit reliable packets are limited to 15 KiB

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export function parseUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return UUID.test(id) ? id : null;
}

// 1..max UUIDs, lowercased, de-duplicated in input order; null when the list or any id is malformed.
export function idList(value: unknown, max = MAX_TARGET_IDS): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > max) return null;
  const ids = new Set<string>();
  for (const item of value) {
    const id = parseUuid(item);
    if (!id) return null;
    ids.add(id);
  }
  return [...ids];
}

export function chunk<T>(items: readonly T[], size = SQL_IN_CHUNK): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < items.length; index += size) parts.push(items.slice(index, index + size));
  return parts;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

// An op that would not fit into one reliable packet becomes a resync request.
export function fitAnnotationOp(op: AnnotationOp, maxBytes = MAX_OP_BYTES): AnnotationOp {
  if (utf8Length(JSON.stringify(op)) <= maxBytes) return op;
  return { type: "annotations", v: 1, shareId: op.shareId, by: op.by, op: "resync" };
}
