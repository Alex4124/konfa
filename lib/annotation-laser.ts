import type { Point } from "@/lib/confa-types";
import type { DraftItem } from "./annotation-drafts.ts";

export const LASER_TRAIL_MS = 700;
export const LASER_HOLD_MS = 1500;
export const LASER_FADE_MS = 500;
export const LASER_TRAIL_POINTS = 32;
export const INK_TTL_MS = 3000;
export const INK_FADE_MS = 600;

export type LaserItem = Pick<DraftItem, "kind" | "style" | "points" | "pointTimes" | "phase" | "lastSeen" | "endedAt">;
// Coordinates are normalized to the frame (0..1); `a` is the segment's age factor (1 = newest, ink is always 1).
export type LaserSegment = { x1: number; y1: number; x2: number; y2: number; a: number };
export type LaserFrame = { head: { x: number; y: number }; life: number; segments: LaserSegment[] };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// 0..1. A live trail holds while packets keep arriving, then fades; laser fades right after `end`, ink holds INK_TTL_MS first.
export function laserLife(item: Pick<LaserItem, "style" | "phase" | "lastSeen" | "endedAt">, now: number): number {
  if (item.phase === "ended" && item.endedAt !== undefined) {
    const age = now - item.endedAt;
    if (item.style === "ink") return age < INK_TTL_MS ? 1 : clamp01(1 - (age - INK_TTL_MS) / INK_FADE_MS);
    return clamp01(1 - age / LASER_FADE_MS);
  }
  const stale = now - item.lastSeen;
  return stale <= LASER_HOLD_MS ? 1 : clamp01(1 - (stale - LASER_HOLD_MS) / LASER_FADE_MS);
}

export function laserFrame(item: LaserItem, now: number): LaserFrame | null {
  const { points, pointTimes } = item;
  const life = laserLife(item, now);
  if (life <= 0 || !points.length) return null;
  const timed = item.style !== "ink" && pointTimes !== undefined && pointTimes.length === points.length;
  const segments: LaserSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    let a = 1;
    if (timed) {
      const age = Math.max(0, now - pointTimes[i]);
      if (age >= LASER_TRAIL_MS) continue;
      a = 1 - age / LASER_TRAIL_MS;
    }
    segments.push({ x1: points[i - 1][0], y1: points[i - 1][1], x2: points[i][0], y2: points[i][1], a });
  }
  const [x, y] = points[points.length - 1];
  return { head: { x, y }, life, segments };
}

export function hasLiveLasers(items: Iterable<LaserItem>, now: number): boolean {
  for (const item of items) if (item.kind === "laser" && laserLife(item, now) > 0) return true;
  return false;
}

// Local trail for the author's own laser/ink: times are spread over (lastSeen, now]; the laser keeps the newest LASER_TRAIL_POINTS.
export function pushLaserPoints<T extends LaserItem>(item: T, added: readonly Point[], now: number): T {
  if (!added.length) return item.lastSeen === now ? item : { ...item, lastSeen: now };
  const points = [...item.points, ...added.map((point): Point => [point[0], point[1]])];
  if (item.style === "ink") return { ...item, points, lastSeen: now };
  const start = Math.min(item.lastSeen, now);
  const times = [...(item.pointTimes?.length === item.points.length ? item.pointTimes : item.points.map(() => start))];
  added.forEach((_, index) => times.push(start + (now - start) * (index + 1) / added.length));
  const drop = Math.max(0, points.length - LASER_TRAIL_POINTS);
  return { ...item, points: points.slice(drop), pointTimes: times.slice(drop), lastSeen: now };
}
