import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DraftPacketV2, Point } from "@/lib/confa-types";
import {
  createDraftSender, decodeJson, DRAFT_CATCHUP_POINTS, DRAFT_SEND_MS, DRAFT_TAIL_POINTS, DRAFT_TTL_MS, dropIdentity, EMPTY_DRAFTS, ENDED_MEMORY_MS, ENDED_TTL_MS,
  MAX_LIVE_DRAFTS_PER_IDENTITY, parseDraftPacket, randomId, receiveDraft, selectDraftView, settleDrafts, sweepDrafts,
  type DraftFilter, type DraftState, type TimerHost,
} from "./annotation-drafts.ts";
import { round4 } from "./annotation-geometry.ts";
import { INK_FADE_MS, INK_TTL_MS, LASER_FADE_MS, LASER_HOLD_MS, LASER_TRAIL_POINTS } from "./annotation-laser.ts";

const SHARE = "share-1";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const ROW = "44444444-4444-4444-8444-444444444444";
const ann = { identity: "ann", name: "Аня" };
const bob = { identity: "bob", name: "Боря" };

type Task = { at: number; run: () => void; every: number | null };

function fakeClock() {
  let time = 0, nextId = 1;
  const tasks = new Map<number, Task>();
  const add = (handler: TimerHandler, ms: number | undefined, every: boolean) => {
    const id = nextId++;
    tasks.set(id, { at: time + Math.max(0, ms ?? 0), run: () => { if (typeof handler === "function") handler(); }, every: every ? Math.max(1, ms ?? 0) : null });
    return id;
  };
  const host: TimerHost = {
    setTimeout: (handler: TimerHandler, ms?: number) => add(handler, ms, false),
    clearTimeout: (id?: number) => { if (id !== undefined) tasks.delete(id); },
    setInterval: (handler: TimerHandler, ms?: number) => add(handler, ms, true),
    clearInterval: (id?: number) => { if (id !== undefined) tasks.delete(id); },
  };
  return {
    host,
    now: () => time,
    timers: () => tasks.size,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        let due: [number, Task] | null = null;
        for (const entry of tasks) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, task] = due;
        time = Math.max(time, task.at);
        if (task.every) task.at += task.every;
        else tasks.delete(id);
        task.run();
      }
      time = end;
    },
  };
}

function packet(over: Partial<DraftPacketV2> = {}): DraftPacketV2 {
  return { v: 2, shareId: SHARE, strokeId: S1, seq: 1, phase: "live", kind: "pen", color: "#6de7d4", strokeWidth: 4, from: 0, points: [], ...over };
}

function pts(count: number, offset = 0): Point[] {
  return Array.from({ length: count }, (_, i): Point => [Math.round(((i + offset) % 1000) / 1000 * 1e4) / 1e4, 0.5]);
}

const allow: DraftFilter = { shareId: SHARE, canAnnotate: () => true, canModerate: () => false };
const none = { has: () => false };
const noAuthor = () => undefined;

function receive(state: DraftState, list: DraftPacketV2[], sender = ann, now = 0): DraftState {
  return list.reduce((s, p) => receiveDraft(s, p, sender, now), state);
}

function view(state: DraftState) {
  return selectDraftView(state, allow, none, noAuthor);
}

describe("parseDraftPacket", () => {
  it("accepts a valid live packet and rebuilds it from whitelisted keys", () => {
    const parsed = parseDraftPacket({ ...packet({ strokeId: S1.toUpperCase(), points: [[0.1, 0.2]] }), extra: "junk" });
    assert.deepEqual(parsed, packet({ points: [[0.1, 0.2]] }));
  });

  it("rejects v1, unknown kinds, bad colors, bad points and oversized tails", () => {
    const bad: unknown[] = [
      null, { ...packet(), v: 1 }, { kind: "pen", payload: { points: [] } }, packet({ kind: "eraser" as never }), packet({ color: "red" }), packet({ color: undefined }),
      packet({ points: [[1.2, 0]] }), packet({ points: [[Number.NaN, 0]] }), packet({ points: pts(DRAFT_CATCHUP_POINTS + 1) }), packet({ phase: "end", points: pts(401) }),
      packet({ seq: 0 }), packet({ seq: 1.5 }), packet({ strokeId: "nope" }), packet({ shareId: "" }), packet({ from: -1 }), packet({ from: undefined, points: [[0, 0]] }),
      packet({ strokeWidth: 30 }), packet({ phase: "drag" as never }), packet({ kind: "laser", style: "neon" as never }), packet({ moveOf: "x" }), packet({ moveOf: ROW, dx: 2 }),
    ];
    for (const raw of bad) assert.equal(parseDraftPacket(raw), null, JSON.stringify(raw));
  });

  it("accepts end with up to 400 points, laser with a default style, move previews and bare cancels", () => {
    assert.equal(parseDraftPacket(packet({ phase: "end", points: pts(400), from: undefined }))?.points?.length, 400);
    assert.equal(parseDraftPacket(packet({ kind: "laser", style: undefined }))?.style, "laser");
    assert.equal(parseDraftPacket(packet({ kind: "laser", style: "ink" }))?.style, "ink");
    assert.equal(parseDraftPacket(packet({ kind: "rect", style: "ink" }))?.style, undefined);
    assert.deepEqual(parseDraftPacket({ v: 2, shareId: SHARE, strokeId: S2, seq: 3, phase: "live", kind: "arrow", moveOf: ROW, dx: 0.1, dy: -0.2 }), { v: 2, shareId: SHARE, strokeId: S2, seq: 3, phase: "live", kind: "arrow", moveOf: ROW, dx: 0.1, dy: -0.2 });
    assert.deepEqual(parseDraftPacket({ v: 2, shareId: SHARE, strokeId: S1, seq: 9, phase: "cancel", kind: "pen" }), { v: 2, shareId: SHARE, strokeId: S1, seq: 9, phase: "cancel", kind: "pen" });
  });
});

describe("receiveDraft", () => {
  it("merges live tails by index, so reordered packets give the same stroke", () => {
    const a = packet({ seq: 1, from: 0, points: [[0.1, 0.1], [0.2, 0.2]] });
    const b = packet({ seq: 2, from: 2, points: [[0.3, 0.3], [0.4, 0.4]] });
    const c = packet({ seq: 3, from: 1, points: [[0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.5, 0.5]] });
    const inOrder = view(receive(EMPTY_DRAFTS, [a, b, c])).items[0].points;
    assert.deepEqual(inOrder, [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.5, 0.5]]);
    const lostMiddle = view(receive(EMPTY_DRAFTS, [a, c])).items[0].points;
    assert.deepEqual(lostMiddle, inOrder);
  });

  it("drops packets with an older or equal seq", () => {
    const first = receive(EMPTY_DRAFTS, [packet({ seq: 5, from: 0, points: [[0.1, 0.1]] })]);
    assert.equal(receive(first, [packet({ seq: 4, from: 0, points: [[0.9, 0.9]] })]), first);
    assert.equal(receive(first, [packet({ seq: 5, from: 1, points: [[0.9, 0.9]] })]), first);
  });

  it("makes sparse arrays dense (a lost tail shows as a straight segment)", () => {
    const state = receive(EMPTY_DRAFTS, [packet({ seq: 1, from: 0, points: [[0.1, 0.1]] }), packet({ seq: 2, from: 5, points: [[0.6, 0.6]] })]);
    assert.deepEqual(view(state).items[0].points, [[0.1, 0.1], [0.6, 0.6]]);
  });

  it("ignores another identity reusing a stroke id", () => {
    const state = receive(EMPTY_DRAFTS, [packet({ points: [[0.1, 0.1]] })]);
    assert.equal(receiveDraft(state, packet({ seq: 9, from: 0, points: [[0.9, 0.9]] }), bob, 0), state);
    assert.equal(receiveDraft(state, packet({ seq: 9, phase: "cancel" }), bob, 0), state);
    assert.equal(view(state).items[0].identity, "ann");
  });

  it("replaces points on end and ignores later live packets, also after the key is settled", () => {
    let state = receive(EMPTY_DRAFTS, [packet({ seq: 1, points: pts(10) })]);
    state = receiveDraft(state, packet({ seq: 2, phase: "end", from: undefined, points: [[0.1, 0.1], [0.9, 0.9]] }), ann, 100);
    const ended = view(state).items[0];
    assert.equal(ended.phase, "ended");
    assert.equal(ended.endedAt, 100);
    assert.deepEqual(ended.points, [[0.1, 0.1], [0.9, 0.9]]);
    assert.equal(receive(state, [packet({ seq: 3, from: 10, points: [[0.5, 0.5]] })]), state);
    state = settleDrafts(state, new Set([S1]), [], 200);
    assert.equal(state.entries.size, 0);
    assert.equal(receive(state, [packet({ seq: 4, from: 0, points: [[0.5, 0.5]] })]), state);
  });

  it("creates an ended entry when only the end packet arrives", () => {
    const state = receiveDraft(EMPTY_DRAFTS, packet({ phase: "end", from: undefined, points: [[0.1, 0.1], [0.2, 0.2]] }), ann, 50);
    assert.equal(view(state).items[0].phase, "ended");
  });

  it("removes on cancel and remembers the key", () => {
    let state = receive(EMPTY_DRAFTS, [packet({ points: [[0.1, 0.1]] })]);
    state = receiveDraft(state, packet({ seq: 2, phase: "cancel" }), ann, 10);
    assert.equal(state.entries.size, 0);
    assert.equal(state.ended.get(S1), 10);
    assert.equal(receive(state, [packet({ seq: 3, points: [[0.2, 0.2]] })]), state);
    assert.equal(receiveDraft(state, packet({ seq: 4, phase: "cancel" }), ann, 20), state);
  });

  it("keeps only the newest LASER_TRAIL_POINTS for the laser, with receive times", () => {
    let state = EMPTY_DRAFTS;
    for (let seq = 1; seq <= 10; seq++) state = receiveDraft(state, packet({ kind: "laser", style: "laser", color: "#ff3b5c", seq, from: (seq - 1) * 5, points: pts(5, (seq - 1) * 5) }), ann, seq * 40);
    const laser = view(state).items[0];
    assert.equal(laser.points.length, LASER_TRAIL_POINTS);
    assert.equal(laser.pointTimes?.length, LASER_TRAIL_POINTS);
    assert.deepEqual(laser.points[LASER_TRAIL_POINTS - 1], pts(1, 49)[0]);
    assert.equal(laser.pointTimes?.[LASER_TRAIL_POINTS - 1], 400);
    const times = laser.pointTimes ?? [];
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
    const late = receiveDraft(state, packet({ kind: "laser", style: "laser", color: "#ff3b5c", seq: 11, from: 40, points: pts(3, 40) }), ann, 500);
    assert.deepEqual(view(late).items[0].pointTimes, times, "re-sent indices keep their times");
  });

  it("stores ink like a stroke and replaces it with the final points on end", () => {
    let state = receive(EMPTY_DRAFTS, [packet({ kind: "laser", style: "ink", seq: 1, points: pts(40) })]);
    assert.equal(view(state).items[0].points.length, 40);
    assert.equal(view(state).items[0].pointTimes, undefined);
    state = receiveDraft(state, packet({ kind: "laser", style: "ink", seq: 2, phase: "end", from: undefined, points: pts(3) }), ann, 0);
    assert.equal(view(state).items[0].points.length, 3);
  });

  it("limits live drafts per identity, dropping the least recently seen", () => {
    let state = EMPTY_DRAFTS;
    for (let i = 0; i <= MAX_LIVE_DRAFTS_PER_IDENTITY; i++) state = receiveDraft(state, packet({ strokeId: `0000000${i}-0000-4000-8000-000000000000`, points: [[0.1, 0.1]] }), ann, i);
    assert.equal(state.entries.size, MAX_LIVE_DRAFTS_PER_IDENTITY);
    assert.ok(!state.entries.has("00000000-0000-4000-8000-000000000000"));
    assert.ok(state.ended.has("00000000-0000-4000-8000-000000000000"));
  });
});

describe("sweepDrafts", () => {
  it("expires live strokes after DRAFT_TTL_MS without packets; heartbeats extend it", () => {
    let state = receive(EMPTY_DRAFTS, [packet({ points: [[0.1, 0.1]] })], ann, 0);
    assert.equal(sweepDrafts(state, DRAFT_TTL_MS), state);
    state = receiveDraft(state, packet({ seq: 2, from: 1, points: [] }), ann, 2500);
    assert.equal(sweepDrafts(state, DRAFT_TTL_MS + 100).entries.size, 1);
    const swept = sweepDrafts(state, 2500 + DRAFT_TTL_MS + 1);
    assert.equal(swept.entries.size, 0);
    assert.ok(swept.ended.has(S1));
  });

  it("keeps ended strokes and move previews for ENDED_TTL_MS", () => {
    const stroke = receiveDraft(EMPTY_DRAFTS, packet({ phase: "end", from: undefined, points: [[0.1, 0.1], [0.2, 0.2]] }), ann, 0);
    assert.equal(sweepDrafts(stroke, ENDED_TTL_MS).entries.size, 1);
    assert.equal(sweepDrafts(stroke, ENDED_TTL_MS + 1).entries.size, 0);
    const move = receiveDraft(EMPTY_DRAFTS, { v: 2, shareId: SHARE, strokeId: S2, seq: 1, phase: "end", kind: "rect", moveOf: ROW, dx: 0.1, dy: 0 }, ann, 0);
    assert.equal(sweepDrafts(move, ENDED_TTL_MS).entries.size, 1);
    assert.equal(sweepDrafts(move, ENDED_TTL_MS + 1).entries.size, 0);
  });

  it("applies the laser and ink lifetimes", () => {
    const laser = receive(EMPTY_DRAFTS, [packet({ kind: "laser", style: "laser", points: [[0.1, 0.1]] })], ann, 0);
    assert.equal(sweepDrafts(laser, LASER_HOLD_MS + LASER_FADE_MS).entries.size, 1);
    assert.equal(sweepDrafts(laser, LASER_HOLD_MS + LASER_FADE_MS + 1).entries.size, 0);
    const laserEnded = receiveDraft(laser, packet({ kind: "laser", style: "laser", seq: 2, phase: "end", from: undefined, points: undefined }), ann, 100);
    assert.equal(view(laserEnded).items[0].points.length, 1, "laser end keeps the trail");
    assert.equal(sweepDrafts(laserEnded, 100 + LASER_FADE_MS).entries.size, 1);
    assert.equal(sweepDrafts(laserEnded, 100 + LASER_FADE_MS + 1).entries.size, 0);
    const ink = receiveDraft(EMPTY_DRAFTS, packet({ kind: "laser", style: "ink", phase: "end", from: undefined, points: [[0.1, 0.1], [0.2, 0.2]] }), ann, 0);
    assert.equal(sweepDrafts(ink, INK_TTL_MS + INK_FADE_MS).entries.size, 1);
    assert.equal(sweepDrafts(ink, INK_TTL_MS + INK_FADE_MS + 1).entries.size, 0);
  });

  it("forgets ended keys after ENDED_MEMORY_MS and is a no-op when nothing expires", () => {
    const state = receiveDraft(EMPTY_DRAFTS, packet({ phase: "cancel" }), ann, 0);
    assert.equal(sweepDrafts(state, ENDED_MEMORY_MS), state);
    assert.equal(sweepDrafts(state, ENDED_MEMORY_MS + 1).ended.size, 0);
    assert.equal(sweepDrafts(EMPTY_DRAFTS, 5), EMPTY_DRAFTS);
  });
});

describe("settle, drop and select", () => {
  const move = (identity = ann, phase: "live" | "end" = "live") => (state: DraftState) => receiveDraft(state, { v: 2, shareId: SHARE, strokeId: S2, seq: phase === "end" ? 2 : 1, phase, kind: "rect", moveOf: ROW, dx: 0.1, dy: 0.2 }, identity, 0);

  it("settles move previews only for their own author's move op", () => {
    const state = move()(EMPTY_DRAFTS);
    assert.equal(settleDrafts(state, none, [{ id: ROW, by: "bob" }], 0), state, "a foreign move does not cut a live preview");
    assert.equal(settleDrafts(state, none, [{ id: ROW, by: "ann" }], 0).entries.size, 0);
  });

  it("drops all drafts of a disconnected identity", () => {
    const state = receive(receive(EMPTY_DRAFTS, [packet({ points: [[0.1, 0.1]] })]), [packet({ strokeId: S3, points: [[0.1, 0.1]] })], bob);
    const dropped = dropIdentity(state, "ann", 5);
    assert.deepEqual([...dropped.entries.keys()], [S3]);
    assert.equal(dropped.ended.get(S1), 5);
  });

  it("filters by share and permission at selection time", () => {
    const state = receive(receive(EMPTY_DRAFTS, [packet({ points: [[0.1, 0.1]] })]), [packet({ strokeId: S3, shareId: "other", points: [[0.1, 0.1]] })], bob);
    assert.deepEqual(view(state).items.map((item) => item.key), [S1]);
    assert.equal(selectDraftView(state, { ...allow, canAnnotate: (id) => id !== "ann" }, none, noAuthor).items.length, 0);
  });

  it("shows move previews only for the row's author or a moderator, and hides that row", () => {
    const own = move()(EMPTY_DRAFTS);
    const authorAnn = (id: string) => id === ROW ? "ann" : undefined;
    const visible = selectDraftView(own, allow, none, authorAnn);
    assert.equal(visible.items.length, 1);
    assert.deepEqual([...visible.hiddenIds], [ROW]);
    assert.equal(selectDraftView(own, allow, none, noAuthor).items.length, 0, "unknown row");
    const foreign = move(bob)(EMPTY_DRAFTS);
    assert.equal(selectDraftView(foreign, allow, none, authorAnn).items.length, 0);
    assert.equal(selectDraftView(foreign, { ...allow, canModerate: (id) => id === "bob" }, none, authorAnn).items.length, 1);
  });

  it("hides strokes already on the board and keeps identities stable between calls", () => {
    const state = receive(EMPTY_DRAFTS, [packet({ points: [[0.1, 0.1]] })]);
    assert.equal(selectDraftView(state, allow, new Set([S1]), noAuthor).items.length, 0);
    const first = view(state);
    assert.equal(selectDraftView(state, allow, none, noAuthor, first), first);
    const later = receive(state, [packet({ strokeId: S3, points: [[0.2, 0.2]] })], bob);
    const second = selectDraftView(later, allow, none, noAuthor, first);
    assert.notEqual(second, first);
    assert.equal(second.items[0], first.items[0], "unchanged entries keep their item object");
    assert.equal(second.hiddenIds, first.hiddenIds, "an equal hidden set keeps its identity");
  });
});

function harness(options: { canSend?: () => boolean; shareId?: string | null } = {}) {
  const clock = fakeClock();
  const sent: Array<{ packet: DraftPacketV2; reliable: boolean; bytes: number }> = [];
  const sender = createDraftSender({
    publish: (data, reliable) => { sent.push({ packet: decodeJson(data) as DraftPacketV2, reliable, bytes: data.length }); },
    now: clock.now, shareId: () => options.shareId === undefined ? SHARE : options.shareId, canSend: options.canSend ?? (() => true), timers: clock.host,
  });
  return { clock, sent, sender };
}

describe("createDraftSender", () => {
  it("sends the first update at once, then throttles to DRAFT_SEND_MS with a trailing send", () => {
    const { clock, sent, sender } = harness();
    const points: Point[] = [];
    sender.begin({ id: S1, kind: "pen", color: "#6de7d4", strokeWidth: 4 }, clock.host);
    points.push([0.1, 0.1]);
    sender.update(S1, { points });
    assert.equal(sent.length, 1);
    for (let i = 0; i < 5; i++) {
      clock.advance(5);
      points.push([0.1 + i / 100, 0.2]);
      sender.update(S1, { points });
    }
    assert.equal(sent.length, 1, "throttled");
    clock.advance(DRAFT_SEND_MS);
    assert.equal(sent.length, 2, "trailing send");
    assert.deepEqual(sent[1].packet.points?.at(-1), points.at(-1));
    assert.equal(sent[1].reliable, false);
    assert.deepEqual(sent.map((item) => item.packet.seq), [1, 2]);
  });

  it("sends tails of at most DRAFT_TAIL_POINTS with overlap, catches up with ≤48 points, all within 1100 bytes", () => {
    const { clock, sent, sender } = harness();
    const points: Point[] = [];
    sender.begin({ id: S1, kind: "marker", color: "#6de7d4", strokeWidth: 16 }, clock.host);
    for (let i = 0; i < 100; i++) {
      points.push([0.123456789 + i / 1000, 0.987654321 - i / 1000]);
      sender.update(S1, { points });
      clock.advance(i % 10 === 9 ? 200 : 4);
    }
    const lives = sent.filter((item) => item.packet.phase === "live");
    assert.ok(lives.length > 3);
    for (const { packet: live, bytes } of lives) {
      assert.ok((live.points?.length ?? 0) <= DRAFT_CATCHUP_POINTS);
      assert.ok(bytes <= 1100, `${bytes} B`);
      for (const [x, y] of live.points ?? []) assert.deepEqual([round4(x), round4(y)], [x, y], "4 decimals");
    }
    assert.ok(lives.some((item) => item.packet.points?.length === DRAFT_TAIL_POINTS), "steady tails have DRAFT_TAIL_POINTS");
    let state = EMPTY_DRAFTS;
    for (const { packet: live } of lives) state = receiveDraft(state, live, ann, 0);
    assert.deepEqual(view(state).items[0].points, points.map(([x, y]): Point => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]), "never simplified: every point arrives");
  });

  it("jumps ahead with a catch-up window when far behind", () => {
    const { clock, sent, sender } = harness();
    sender.begin({ id: S1, kind: "pen", color: "#6de7d4" }, clock.host);
    sender.update(S1, { points: pts(2) });
    clock.advance(DRAFT_SEND_MS);
    sender.update(S1, { points: pts(200) });
    const last = sent.at(-1)?.packet;
    assert.equal(last?.from, 200 - DRAFT_CATCHUP_POINTS);
    assert.equal(last?.points?.length, DRAFT_CATCHUP_POINTS);
  });

  it("keeps two-point shapes at from 0", () => {
    const { clock, sent, sender } = harness();
    sender.begin({ id: S1, kind: "rect", color: "#6de7d4" }, clock.host);
    sender.update(S1, { points: [[0.1, 0.1], [0.2, 0.2]] });
    clock.advance(DRAFT_SEND_MS);
    sender.update(S1, { points: [[0.1, 0.1], [0.3, 0.3]] });
    assert.deepEqual(sent.map((item) => [item.packet.from, item.packet.points?.length]), [[0, 2], [0, 2]]);
  });

  it("re-sends the tail as a heartbeat: every ~1000 ms for strokes, every 500 ms for the laser", () => {
    const stroke = harness();
    stroke.sender.begin({ id: S1, kind: "pen", color: "#6de7d4" }, stroke.clock.host);
    stroke.sender.update(S1, { points: pts(3) });
    stroke.clock.advance(3000);
    assert.equal(stroke.sent.length, 4, "1 update + heartbeats at 1000, 2000, 3000");
    assert.deepEqual(stroke.sent[1].packet.points, pts(3));
    const laser = harness();
    laser.sender.begin({ id: S2, kind: "laser", style: "laser", color: "#ff3b5c" }, laser.clock.host);
    laser.sender.update(S2, { points: pts(1) });
    laser.clock.advance(2000);
    assert.equal(laser.sent.length, 5, "1 update + heartbeats every 500 ms");
    assert.ok(laser.sent.every((item) => item.packet.style === "laser" && item.packet.kind === "laser"));
  });

  it("sends nothing before the first update and stops all timers on end", () => {
    const { clock, sent, sender } = harness();
    sender.begin({ id: S1, kind: "pen", color: "#6de7d4" }, clock.host);
    clock.advance(5000);
    assert.equal(sent.length, 0);
    sender.update(S1, { points: pts(2) });
    sender.end(S1, { points: pts(2) });
    assert.equal(clock.timers(), 0);
    const end = sent.at(-1);
    assert.equal(end?.packet.phase, "end");
    assert.equal(end?.reliable, true);
    assert.deepEqual(end?.packet.points, pts(2));
    clock.advance(5000);
    assert.equal(sent.length, 2);
  });

  it("sends a reliable cancel even without permission, and after end with a higher seq", () => {
    let allowed = true;
    const { clock, sent, sender } = harness({ canSend: () => allowed });
    sender.begin({ id: S1, kind: "pen", color: "#6de7d4" }, clock.host);
    sender.update(S1, { points: pts(2) });
    allowed = false;
    sender.cancel(S1);
    assert.deepEqual(sent.map((item) => [item.packet.phase, item.reliable, item.packet.seq]), [["live", false, 1], ["cancel", true, 2]]);
    allowed = true;
    sender.begin({ id: S2, kind: "pen", color: "#6de7d4" }, clock.host);
    sender.update(S2, { points: pts(2) });
    sender.end(S2, { points: pts(2) });
    sender.cancel(S2);
    sender.cancel(S2);
    assert.deepEqual(sent.slice(2).map((item) => [item.packet.phase, item.packet.seq]), [["live", 1], ["end", 2], ["cancel", 3]]);
  });

  it("turns end into cancel when permission was lost mid-stroke, and stays silent for unknown ids", () => {
    let allowed = true;
    const { clock, sent, sender } = harness({ canSend: () => allowed });
    sender.begin({ id: S1, kind: "pen", color: "#6de7d4" }, clock.host);
    sender.update(S1, { points: pts(2) });
    allowed = false;
    clock.advance(DRAFT_SEND_MS);
    sender.update(S1, { points: pts(3) });
    sender.end(S1, { points: pts(3) });
    assert.deepEqual(sent.map((item) => item.packet.phase), ["live", "cancel"]);
    sender.cancel(S3);
    assert.equal(sent.length, 2);
  });

  it("cancelAll cancels every active stroke", () => {
    const { clock, sent, sender } = harness();
    for (const id of [S1, S2]) {
      sender.begin({ id, kind: "pen", color: "#6de7d4" }, clock.host);
      sender.update(id, { points: pts(2) });
    }
    sender.cancelAll();
    assert.deepEqual(sent.filter((item) => item.packet.phase === "cancel").map((item) => item.packet.strokeId), [S1, S2]);
    assert.equal(clock.timers(), 0);
  });

  it("throttles move previews to 50 ms and sends the final delta on end", () => {
    const { clock, sent, sender } = harness();
    sender.begin({ id: S2, kind: "rect", color: "#6de7d4", moveOf: ROW }, clock.host);
    sender.update(S2, { dx: 0.01, dy: 0 });
    clock.advance(DRAFT_SEND_MS);
    sender.update(S2, { dx: 0.02, dy: 0 });
    assert.equal(sent.length, 1);
    clock.advance(10);
    assert.equal(sent.length, 2);
    sender.end(S2, { dx: 0.123456789, dy: -0.05 });
    const end = sent.at(-1)?.packet;
    assert.deepEqual([end?.phase, end?.moveOf, end?.dx, end?.dy], ["end", ROW, 0.1235, -0.05]);
  });

  it("does not send without a share and lowercases ids", () => {
    const quiet = harness({ shareId: null });
    quiet.sender.begin({ id: S1, kind: "pen", color: "#6de7d4" }, quiet.clock.host);
    quiet.sender.update(S1, { points: pts(2) });
    quiet.sender.end(S1, { points: pts(2) });
    assert.equal(quiet.sent.length, 0);
    const loud = harness();
    loud.sender.begin({ id: S1.toUpperCase(), kind: "pen", color: "#6de7d4" }, loud.clock.host);
    loud.sender.update(S1, { points: pts(2) });
    assert.equal(loud.sent[0].packet.strokeId, S1);
  });

  it("round-trips through parse and receive, ending with the final points", () => {
    const { clock, sent, sender } = harness();
    const points: Point[] = [];
    sender.begin({ id: S1, kind: "pen", color: "#6de7d4", strokeWidth: 4.4 }, clock.host);
    for (let i = 0; i < 30; i++) {
      points.push([i / 30, 0.5]);
      sender.update(S1, { points });
      clock.advance(16);
    }
    sender.end(S1, { points: [points[0], points[29]] });
    let state = EMPTY_DRAFTS;
    for (const item of sent) {
      const parsed = parseDraftPacket(item.packet);
      assert.ok(parsed);
      state = receiveDraft(state, parsed, ann, clock.now());
    }
    const [draft] = view(state).items;
    assert.deepEqual([draft.phase, draft.strokeWidth, draft.points.length], ["ended", 4, 2]);
  });

  it("generates lowercase v4 ids", () => {
    const id = randomId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(randomId(), id);
  });
});
