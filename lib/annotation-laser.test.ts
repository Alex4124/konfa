import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Point } from "@/lib/confa-types";
import type { DraftItem } from "./annotation-drafts.ts";
import { hasLiveLasers, INK_FADE_MS, INK_TTL_MS, LASER_FADE_MS, LASER_HOLD_MS, LASER_TRAIL_MS, LASER_TRAIL_POINTS, laserFrame, laserLife, pushLaserPoints } from "./annotation-laser.ts";

function item(over: Partial<DraftItem> = {}): DraftItem {
  return { key: "k", identity: "a", authorName: "Аня", kind: "laser", style: "laser", color: "#ff3b5c", points: [], phase: "live", lastSeen: 0, ...over };
}

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

describe("laserLife", () => {
  it("holds a live laser for LASER_HOLD_MS without packets, then fades over LASER_FADE_MS", () => {
    const live = item({ lastSeen: 1000 });
    assert.equal(laserLife(live, 1000), 1);
    assert.equal(laserLife(live, 1000 + LASER_HOLD_MS), 1);
    close(laserLife(live, 1000 + LASER_HOLD_MS + LASER_FADE_MS / 2), 0.5);
    assert.equal(laserLife(live, 1000 + LASER_HOLD_MS + LASER_FADE_MS), 0);
    assert.equal(laserLife(live, 99_999), 0);
  });

  it("fades an ended laser right after release", () => {
    const ended = item({ phase: "ended", lastSeen: 5000, endedAt: 5000 });
    assert.equal(laserLife(ended, 5000), 1);
    close(laserLife(ended, 5000 + LASER_FADE_MS / 2), 0.5);
    assert.equal(laserLife(ended, 5000 + LASER_FADE_MS), 0);
    assert.equal(laserLife(ended, 4000), 1, "clock skew never exceeds 1");
  });

  it("keeps ended ink for INK_TTL_MS, then fades over INK_FADE_MS", () => {
    const ink = item({ style: "ink", phase: "ended", lastSeen: 0, endedAt: 0 });
    assert.equal(laserLife(ink, 0), 1);
    assert.equal(laserLife(ink, INK_TTL_MS - 1), 1);
    close(laserLife(ink, INK_TTL_MS + INK_FADE_MS / 2), 0.5);
    assert.equal(laserLife(ink, INK_TTL_MS + INK_FADE_MS), 0);
  });

  it("applies the hold rule to live ink too", () => {
    const ink = item({ style: "ink", lastSeen: 0 });
    assert.equal(laserLife(ink, LASER_HOLD_MS), 1);
    assert.ok(laserLife(ink, LASER_HOLD_MS + 100) < 1);
  });
});

describe("laserFrame", () => {
  const points: Point[] = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.5, 0.5]];

  it("returns the head and segments whose age factor grows towards the head", () => {
    const frame = laserFrame(item({ points, pointTimes: [0, 100, 200, 300, 400], lastSeen: 400 }), 450);
    assert.ok(frame);
    assert.deepEqual(frame.head, { x: 0.5, y: 0.5 });
    assert.equal(frame.life, 1);
    assert.equal(frame.segments.length, 4);
    for (let i = 1; i < frame.segments.length; i++) assert.ok(frame.segments[i].a > frame.segments[i - 1].a);
    close(frame.segments[3].a, 1 - 50 / LASER_TRAIL_MS);
    assert.deepEqual([frame.segments[0].x1, frame.segments[0].y2], [0.1, 0.2]);
  });

  it("drops segments older than LASER_TRAIL_MS but keeps the head", () => {
    const frame = laserFrame(item({ points, pointTimes: [0, 100, 200, 300, 400], lastSeen: 400 }), 400 + LASER_TRAIL_MS - 50);
    assert.ok(frame);
    assert.equal(frame.segments.length, 1, "only the newest segment is younger than the trail");
    const still = laserFrame(item({ points, pointTimes: [0, 100, 200, 300, 400], lastSeen: 1000 }), 1400);
    assert.ok(still);
    assert.equal(still.segments.length, 0);
    assert.deepEqual(still.head, { x: 0.5, y: 0.5 });
  });

  it("draws ink at full strength regardless of point age", () => {
    const frame = laserFrame(item({ style: "ink", points, pointTimes: [0, 0, 0, 0, 0], lastSeen: 0, phase: "ended", endedAt: 0 }), 2000);
    assert.ok(frame);
    assert.equal(frame.segments.length, 4);
    assert.ok(frame.segments.every((segment) => segment.a === 1));
  });

  it("returns null when faded out or empty", () => {
    assert.equal(laserFrame(item({ points, phase: "ended", endedAt: 0 }), LASER_FADE_MS), null);
    assert.equal(laserFrame(item({ points: [] }), 0), null);
  });

  it("treats missing times as fresh", () => {
    const frame = laserFrame(item({ points, lastSeen: 0 }), LASER_HOLD_MS);
    assert.ok(frame);
    assert.equal(frame.segments.length, 4);
  });
});

describe("hasLiveLasers and pushLaserPoints", () => {
  it("reports whether any laser is still visible", () => {
    assert.equal(hasLiveLasers([item({ lastSeen: 0 })], 100), true);
    assert.equal(hasLiveLasers([item({ phase: "ended", endedAt: 0 })], LASER_FADE_MS + 1), false);
    assert.equal(hasLiveLasers([item({ kind: "pen", lastSeen: 0 })], 0), false);
    assert.equal(hasLiveLasers([], 0), false);
  });

  it("keeps the newest LASER_TRAIL_POINTS with times spread over (lastSeen, now]", () => {
    let trail = item({ lastSeen: 0, pointTimes: [] });
    trail = pushLaserPoints(trail, [[0.1, 0.1], [0.2, 0.2]], 40);
    assert.deepEqual(trail.pointTimes, [20, 40]);
    assert.equal(trail.lastSeen, 40);
    for (let i = 0; i < 40; i++) trail = pushLaserPoints(trail, [[i / 100, 0.5]], 40 + (i + 1) * 16);
    assert.equal(trail.points.length, LASER_TRAIL_POINTS);
    assert.equal(trail.pointTimes?.length, LASER_TRAIL_POINTS);
    assert.deepEqual(trail.points[LASER_TRAIL_POINTS - 1], [0.39, 0.5]);
    const times = trail.pointTimes ?? [];
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
  });

  it("keeps every ink point and refreshes lastSeen on empty input", () => {
    let ink = item({ style: "ink", lastSeen: 0 });
    for (let i = 0; i < 50; i++) ink = pushLaserPoints(ink, [[i / 100, 0.2]], i);
    assert.equal(ink.points.length, 50);
    assert.equal(ink.pointTimes, undefined);
    assert.equal(pushLaserPoints(ink, [], 500).lastSeen, 500);
  });
});
