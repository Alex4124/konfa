import type { AnnotationKind, DraftPacketV2, LaserStyle, Point } from "@/lib/confa-types";
import { MAX_FREEHAND_POINTS, round4, roundPoint } from "./annotation-geometry.ts";
import { INK_FADE_MS, INK_TTL_MS, LASER_FADE_MS, LASER_HOLD_MS, LASER_TRAIL_POINTS } from "./annotation-laser.ts";
import { isAnnotationKind } from "./annotation-validate.ts";
import { parseUuid } from "./annotation-wire.ts";

export const DRAFT_TOPIC = "confa-annotation-draft";
export const DRAFT_SEND_MS = 40;
export const DRAFT_MOVE_SEND_MS = 50;
export const DRAFT_TAIL_POINTS = 12;
export const DRAFT_CATCHUP_POINTS = 48;
export const DRAFT_HEARTBEAT_TICK_MS = 500;
export const DRAFT_HEARTBEAT_MS = 1000; // idle time before a stroke or move preview re-sends its tail
export const LASER_HEARTBEAT_MS = 500;
export const DRAFT_TTL_MS = 3000;
export const ENDED_TTL_MS = 10_000;
export const ENDED_MEMORY_MS = 15_000;
export const MAX_LIVE_POINTS = 2000;
export const MAX_LIVE_DRAFTS_PER_IDENTITY = 4;
export const MAX_DRAFTS_PER_IDENTITY = 32; // ended strokes wait for their saved row, so fast writers keep several
export const MAX_DRAFTS = 240;

const MAX_FROM = 1_000_000;
const MAX_ENDED_KEYS = 4000;
const SENDER_MEMORY_MS = 60_000; // a failed add may cancel its draft after all retries (3 × 10 s timeout)
const HEARTBEAT_SLACK_MS = DRAFT_HEARTBEAT_TICK_MS / 2;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export type TimerHost = Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
export type DraftKind = AnnotationKind | "laser";
export type DraftItem = {
  key: string; identity: string; authorName: string; kind: DraftKind; style?: LaserStyle; color: string; strokeWidth?: number;
  points: readonly Point[]; pointTimes?: readonly number[]; phase: "live" | "ended"; lastSeen: number; endedAt?: number; moveOf?: string; dx?: number; dy?: number;
};
// hiddenIds: saved rows currently shown by someone's move preview instead.
export type DraftView = { items: readonly DraftItem[]; hiddenIds: ReadonlySet<string> };
export type DraftEntry = {
  key: string; identity: string; name: string; shareId: string; kind: DraftKind; style?: LaserStyle; color: string; strokeWidth?: number;
  points: ReadonlyArray<Point | undefined>; // strokes: sparse by sender index; laser: the newest LASER_TRAIL_POINTS, dense
  indices?: readonly number[]; times?: readonly number[]; // laser only, parallel to points
  seq: number; phase: "live" | "ended"; lastSeen: number; endedAt?: number; moveOf?: string; dx?: number; dy?: number;
};
export type DraftState = { entries: ReadonlyMap<string, DraftEntry>; ended: ReadonlyMap<string, number> };
export type DraftFilter = { shareId: string | null; canAnnotate(identity: string): boolean; canModerate(identity: string): boolean };
export type DraftSpec = { id: string; kind: DraftKind; style?: LaserStyle; color: string; strokeWidth?: number; moveOf?: string };
export type DraftChange = { points: readonly Point[] } | { dx: number; dy: number };
export type DraftFinal = { points?: readonly Point[]; dx?: number; dy?: number };
export type DraftSender = {
  begin(spec: DraftSpec, timers?: TimerHost): void;
  update(id: string, change: DraftChange): void;
  end(id: string, final?: DraftFinal): void;
  cancel(id: string): void;
  cancelAll(): void;
};
export type DraftSenderOptions = { publish(data: Uint8Array, reliable: boolean): Promise<void> | void; now(): number; shareId(): string | null; canSend(): boolean; timers: TimerHost };

export const EMPTY_DRAFTS: DraftState = { entries: new Map(), ended: new Map() };
export const EMPTY_DRAFT_VIEW: DraftView = { items: [], hiddenIds: new Set() };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
}

// Lowercase v4 UUID; falls back to getRandomValues outside secure contexts.
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Receiver

// v2 only. Rebuilds the packet from whitelisted keys; live tails carry ≤ DRAFT_CATCHUP_POINTS, end ≤ MAX_FREEHAND_POINTS.
export function parseDraftPacket(raw: unknown): DraftPacketV2 | null {
  if (!isRecord(raw) || raw.v !== 2) return null;
  const { shareId, phase, kind, seq } = raw;
  const strokeId = parseUuid(raw.strokeId);
  if (typeof shareId !== "string" || !shareId || shareId.length > 64 || !strokeId) return null;
  if (phase !== "live" && phase !== "end" && phase !== "cancel") return null;
  if (kind !== "laser" && !isAnnotationKind(kind)) return null;
  if (!intIn(seq, 1, Number.MAX_SAFE_INTEGER)) return null;
  const packet: DraftPacketV2 = { v: 2, shareId, strokeId, seq, phase, kind };
  if (phase === "cancel") return packet;
  if (kind === "laser") {
    if (raw.style !== undefined && raw.style !== "laser" && raw.style !== "ink") return null;
    packet.style = raw.style === "ink" ? "ink" : "laser";
  }
  if (raw.color !== undefined) {
    if (typeof raw.color !== "string" || !COLOR.test(raw.color)) return null;
    packet.color = raw.color;
  }
  if (raw.strokeWidth !== undefined) {
    if (!intIn(raw.strokeWidth, 1, 24)) return null;
    packet.strokeWidth = raw.strokeWidth;
  }
  if (raw.moveOf !== undefined) {
    const moveOf = parseUuid(raw.moveOf);
    if (!moveOf || kind === "laser") return null;
    packet.moveOf = moveOf;
    for (const key of ["dx", "dy"] as const) {
      const value = raw[key];
      if (value === undefined) continue;
      if (!finiteIn(value, -1, 1)) return null;
      packet[key] = value;
    }
    return packet;
  }
  if (!packet.color) return null;
  if (raw.from !== undefined) {
    if (!intIn(raw.from, 0, MAX_FROM)) return null;
    packet.from = raw.from;
  }
  if (raw.points !== undefined) {
    const limit = phase === "live" ? DRAFT_CATCHUP_POINTS : MAX_FREEHAND_POINTS;
    if (!Array.isArray(raw.points) || raw.points.length > limit || !raw.points.every(validPoint)) return null;
    if (phase === "live" && packet.from === undefined) return null;
    packet.points = raw.points.map(([x, y]): Point => [x, y]);
  }
  return packet;
}

function remember(ended: Map<string, number>, key: string, now: number): void {
  ended.delete(key);
  ended.set(key, now);
  while (ended.size > MAX_ENDED_KEYS) ended.delete(ended.keys().next().value as string);
}

// Points arrive by sender index, so reordered or repeated lossy packets merge into the same array.
function mergeStroke(previous: ReadonlyArray<Point | undefined>, from: number, points: readonly Point[]): Array<Point | undefined> {
  const merged = previous.slice();
  for (let i = 0; i < points.length && from + i < MAX_LIVE_POINTS; i++) merged[from + i] = points[i];
  return merged;
}

// Keeps only the newest LASER_TRAIL_POINTS indices; new points get local receive times spread over (lastSeen, now].
function mergeTrail(entry: DraftEntry | undefined, from: number, points: readonly Point[], now: number): Pick<DraftEntry, "points" | "indices" | "times"> {
  const slots: Array<{ index: number; point: Point; time: number }> = [];
  if (entry?.indices && entry.times) entry.indices.forEach((index, i) => slots.push({ index, point: entry.points[i] as Point, time: (entry.times as number[])[i] }));
  const fresh: Array<{ index: number; point: Point }> = [];
  points.forEach((point, i) => {
    const slot = slots.find((item) => item.index === from + i);
    if (slot) slot.point = point;
    else fresh.push({ index: from + i, point });
  });
  const start = entry ? Math.min(entry.lastSeen, now) : now - DRAFT_SEND_MS;
  fresh.forEach((item, i) => slots.push({ ...item, time: start + (now - start) * (i + 1) / fresh.length }));
  slots.sort((a, b) => a.index - b.index);
  for (let i = slots.length - 2; i >= 0; i--) slots[i].time = Math.min(slots[i].time, slots[i + 1].time);
  const kept = slots.slice(-LASER_TRAIL_POINTS);
  return { points: kept.map((slot) => slot.point), indices: kept.map((slot) => slot.index), times: kept.map((slot) => slot.time) };
}

function isTrail(entry: Pick<DraftEntry, "kind" | "style">): boolean {
  return entry.kind === "laser" && entry.style !== "ink";
}

// Makes room for one new entry of `identity`, dropping the least recently seen ones first.
function evict(entries: Map<string, DraftEntry>, ended: Map<string, number>, identity: string, live: boolean, now: number): void {
  const limit = (match: (entry: DraftEntry) => boolean, max: number) => {
    const matching = [...entries.values()].filter(match).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const entry of matching.slice(0, Math.max(0, matching.length - max + 1))) {
      entries.delete(entry.key);
      remember(ended, entry.key, now);
    }
  };
  if (live) limit((entry) => entry.identity === identity && entry.phase === "live", MAX_LIVE_DRAFTS_PER_IDENTITY);
  limit((entry) => entry.identity === identity, MAX_DRAFTS_PER_IDENTITY);
  limit(() => true, MAX_DRAFTS);
}

// Returns `s` unchanged when the packet is dropped: stale seq, ended key, foreign identity, or live after end.
export function receiveDraft(s: DraftState, p: DraftPacketV2, sender: { identity: string; name: string }, now: number): DraftState {
  const key = p.strokeId;
  const entry = s.entries.get(key);
  if (entry && (entry.identity !== sender.identity || p.seq <= entry.seq)) return s;
  if (p.phase === "cancel") {
    if (!entry && s.ended.has(key)) return s;
    const entries = new Map(s.entries);
    const ended = new Map(s.ended);
    entries.delete(key);
    remember(ended, key, now);
    return { entries, ended };
  }
  if (s.ended.has(key) || entry?.phase === "ended") return s;
  const base: DraftEntry = entry ?? { key, identity: sender.identity, name: sender.name, shareId: p.shareId, kind: p.kind, color: p.color ?? "#ffffff", points: [], seq: 0, phase: "live", lastSeen: now };
  const next: DraftEntry = { ...base, name: sender.name || base.name, kind: p.kind, seq: p.seq, lastSeen: now };
  if (p.style) next.style = p.style;
  if (p.color) next.color = p.color;
  if (p.strokeWidth !== undefined) next.strokeWidth = p.strokeWidth;
  if (p.moveOf) {
    next.moveOf = p.moveOf;
    next.dx = p.dx ?? base.dx ?? 0;
    next.dy = p.dy ?? base.dy ?? 0;
  } else if (p.phase === "live" && p.points?.length) {
    const from = p.from ?? 0;
    if (isTrail(next)) Object.assign(next, mergeTrail(entry, from, p.points, now));
    else next.points = mergeStroke(base.points, from, p.points);
  }
  if (p.phase === "end") {
    next.phase = "ended";
    next.endedAt = now;
    if (p.points && !isTrail(next) && !p.moveOf) next.points = p.points;
  }
  const entries = new Map(s.entries);
  if (entry) {
    entries.set(key, next);
    return { entries, ended: s.ended };
  }
  const ended = new Map(s.ended);
  evict(entries, ended, sender.identity, next.phase === "live", now);
  entries.set(key, next);
  return { entries, ended };
}

function removeWhere(s: DraftState, now: number, match: (entry: DraftEntry) => boolean): DraftState {
  let entries: Map<string, DraftEntry> | null = null;
  let ended: Map<string, number> | null = null;
  for (const entry of s.entries.values()) {
    if (!match(entry)) continue;
    entries ??= new Map(s.entries);
    ended ??= new Map(s.ended);
    entries.delete(entry.key);
    remember(ended, entry.key, now);
  }
  return entries && ended ? { entries, ended } : s;
}

export function draftExpired(entry: Pick<DraftEntry, "kind" | "style" | "phase" | "lastSeen" | "endedAt">, now: number): boolean {
  if (entry.phase === "live") return now - entry.lastSeen > (entry.kind === "laser" ? LASER_HOLD_MS + LASER_FADE_MS : DRAFT_TTL_MS);
  const age = now - (entry.endedAt ?? entry.lastSeen);
  if (entry.kind !== "laser") return age > ENDED_TTL_MS;
  return age > (entry.style === "ink" ? INK_TTL_MS + INK_FADE_MS : LASER_FADE_MS);
}

export function sweepDrafts(s: DraftState, now: number): DraftState {
  const swept = removeWhere(s, now, (entry) => draftExpired(entry, now));
  let ended: Map<string, number> | null = null;
  for (const [key, at] of swept.ended) {
    if (now - at <= ENDED_MEMORY_MS) continue;
    ended ??= new Map(swept.ended);
    ended.delete(key);
  }
  return ended ? { entries: swept.entries, ended } : swept;
}

// Strokes whose id is on the board are done; move previews end when their author's move op for that row lands.
export function settleDrafts(s: DraftState, committed: { has(id: string): boolean }, moved: ReadonlyArray<{ id: string; by: string }>, now: number): DraftState {
  if (!s.entries.size) return s;
  return removeWhere(s, now, (entry) => entry.moveOf ? moved.some((item) => item.id === entry.moveOf && item.by === entry.identity) : entry.kind !== "laser" && committed.has(entry.key));
}

export function dropIdentity(s: DraftState, identity: string, now: number): DraftState {
  return removeWhere(s, now, (entry) => entry.identity === identity);
}

export function dropOtherShares(s: DraftState, shareId: string | null, now: number): DraftState {
  return removeWhere(s, now, (entry) => entry.shareId !== shareId);
}

const itemCache = new WeakMap<DraftEntry, DraftItem>();

function itemOf(entry: DraftEntry): DraftItem {
  const cached = itemCache.get(entry);
  if (cached) return cached;
  const item: DraftItem = { key: entry.key, identity: entry.identity, authorName: entry.name, kind: entry.kind, color: entry.color, points: entry.points.filter((point): point is Point => Boolean(point)), phase: entry.phase, lastSeen: entry.lastSeen };
  if (entry.style) item.style = entry.style;
  if (entry.strokeWidth !== undefined) item.strokeWidth = entry.strokeWidth;
  if (entry.times) item.pointTimes = entry.times;
  if (entry.endedAt !== undefined) item.endedAt = entry.endedAt;
  if (entry.moveOf) {
    item.moveOf = entry.moveOf;
    item.dx = entry.dx ?? 0;
    item.dy = entry.dy ?? 0;
  }
  itemCache.set(entry, item);
  return item;
}

function sameItems(a: readonly DraftItem[], b: readonly DraftItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// Permission filtering happens here (not on receive) so a grant or revoke applies to drafts already in flight.
export function selectDraftView(s: DraftState, filter: DraftFilter, boardIds: { has(id: string): boolean }, authorOf: (id: string) => string | undefined, previous?: DraftView): DraftView {
  const items: DraftItem[] = [];
  const hiddenIds = new Set<string>();
  for (const entry of s.entries.values()) {
    if (entry.shareId !== filter.shareId || !filter.canAnnotate(entry.identity)) continue;
    if (entry.moveOf) {
      const author = authorOf(entry.moveOf);
      if (author === undefined || (author !== entry.identity && !filter.canModerate(entry.identity))) continue;
      hiddenIds.add(entry.moveOf);
    } else if (entry.kind !== "laser" && boardIds.has(entry.key)) continue;
    items.push(itemOf(entry));
  }
  const prior = previous ?? EMPTY_DRAFT_VIEW;
  const sameList = sameItems(items, prior.items), sameHidden = sameSet(hiddenIds, prior.hiddenIds);
  if (previous && sameList && sameHidden) return previous;
  return { items: sameList ? prior.items : items, hiddenIds: sameHidden ? prior.hiddenIds : hiddenIds };
}

// Sender

type Outgoing = {
  spec: DraftSpec; shareId: string | null; timers: TimerHost; seq: number; sent: boolean; dirty: boolean;
  points: readonly Point[] | null; lastSentLen: number; dx: number; dy: number; lastSentAt: number;
  trailing: number | null; heartbeat: number | null;
};
type Finished = { spec: DraftSpec; shareId: string | null; seq: number; sent: boolean; at: number };

function normalizeWidth(width: number | undefined): number | undefined {
  return typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.min(24, Math.round(width))) : undefined;
}

// Live tails are lossy and never simplified; end and cancel are reliable. Cancel is sent even after permission is lost.
export function createDraftSender(o: DraftSenderOptions): DraftSender {
  const active = new Map<string, Outgoing>();
  const finished = new Map<string, Finished>();

  const publish = (packet: DraftPacketV2, reliable: boolean) => {
    try {
      const result = o.publish(encodeJson(packet), reliable);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch { /* Peers converge through TTLs and the saved row. */ }
  };

  const header = (spec: DraftSpec, shareId: string, seq: number, phase: DraftPacketV2["phase"]): DraftPacketV2 => {
    const packet: DraftPacketV2 = { v: 2, shareId, strokeId: spec.id, seq, phase, kind: spec.kind };
    if (phase === "cancel") return packet;
    if (spec.kind === "laser") packet.style = spec.style ?? "laser";
    packet.color = spec.color;
    if (spec.strokeWidth !== undefined) packet.strokeWidth = spec.strokeWidth;
    if (spec.moveOf) packet.moveOf = spec.moveOf;
    return packet;
  };

  const stopTimers = (stroke: Outgoing) => {
    if (stroke.trailing !== null) stroke.timers.clearTimeout(stroke.trailing);
    if (stroke.heartbeat !== null) stroke.timers.clearInterval(stroke.heartbeat);
    stroke.trailing = null;
    stroke.heartbeat = null;
  };

  const prune = (now: number) => {
    for (const [id, item] of finished) if (now - item.at > SENDER_MEMORY_MS) finished.delete(id);
  };

  const sendLive = (stroke: Outgoing) => {
    stroke.dirty = false;
    if (!stroke.shareId || !o.canSend()) return;
    const packet = header(stroke.spec, stroke.shareId, ++stroke.seq, "live");
    if (stroke.spec.moveOf) {
      packet.dx = round4(stroke.dx);
      packet.dy = round4(stroke.dy);
    } else {
      const points = stroke.points ?? [];
      const length = points.length;
      let from = Math.max(0, Math.min(stroke.lastSentLen - 2, length - DRAFT_TAIL_POINTS));
      if (length - from > DRAFT_CATCHUP_POINTS) from = length - DRAFT_CATCHUP_POINTS;
      packet.from = from;
      packet.points = points.slice(from).map(roundPoint);
      stroke.lastSentLen = length;
    }
    stroke.sent = true;
    stroke.lastSentAt = o.now();
    publish(packet, false);
  };

  const interval = (spec: DraftSpec) => spec.moveOf ? DRAFT_MOVE_SEND_MS : DRAFT_SEND_MS;
  const idle = (spec: DraftSpec) => spec.kind === "laser" ? LASER_HEARTBEAT_MS : DRAFT_HEARTBEAT_MS;

  const sendCancel = (spec: DraftSpec, shareId: string | null, seq: number) => {
    if (shareId) publish(header(spec, shareId, seq, "cancel"), true);
  };

  const sender: DraftSender = {
    begin(spec, timers = o.timers) {
      const id = spec.id.toLowerCase();
      const previous = active.get(id) ?? finished.get(id);
      if (active.has(id)) stopTimers(active.get(id) as Outgoing);
      finished.delete(id);
      prune(o.now());
      const clean: DraftSpec = { ...spec, id, strokeWidth: normalizeWidth(spec.strokeWidth) };
      if (clean.strokeWidth === undefined) delete clean.strokeWidth;
      if (spec.kind !== "laser") delete clean.style;
      const stroke: Outgoing = { spec: clean, shareId: o.shareId(), timers, seq: previous?.seq ?? 0, sent: previous?.sent ?? false, dirty: false, points: null, lastSentLen: 0, dx: 0, dy: 0, lastSentAt: -Infinity, trailing: null, heartbeat: null };
      stroke.heartbeat = timers.setInterval(() => {
        if (active.get(id) !== stroke || (!stroke.sent && !stroke.dirty)) return;
        if (o.now() - stroke.lastSentAt >= idle(stroke.spec) - HEARTBEAT_SLACK_MS) sendLive(stroke);
      }, DRAFT_HEARTBEAT_TICK_MS);
      active.set(id, stroke);
    },
    update(rawId, change) {
      const id = rawId.toLowerCase();
      const stroke = active.get(id);
      if (!stroke) return;
      if ("points" in change) stroke.points = change.points;
      else {
        stroke.dx = change.dx;
        stroke.dy = change.dy;
      }
      stroke.dirty = true;
      const wait = stroke.lastSentAt + interval(stroke.spec) - o.now();
      if (wait <= 0) {
        if (stroke.trailing !== null) stroke.timers.clearTimeout(stroke.trailing);
        stroke.trailing = null;
        sendLive(stroke);
      } else if (stroke.trailing === null) {
        stroke.trailing = stroke.timers.setTimeout(() => {
          stroke.trailing = null;
          if (active.get(id) === stroke && stroke.dirty) sendLive(stroke);
        }, wait);
      }
    },
    end(rawId, final) {
      const id = rawId.toLowerCase();
      const stroke = active.get(id);
      if (!stroke) return;
      stopTimers(stroke);
      active.delete(id);
      if (stroke.shareId && o.canSend()) {
        const packet = header(stroke.spec, stroke.shareId, ++stroke.seq, "end");
        if (stroke.spec.moveOf) {
          packet.dx = round4(final?.dx ?? stroke.dx);
          packet.dy = round4(final?.dy ?? stroke.dy);
        } else if (final?.points && final.points.length <= MAX_FREEHAND_POINTS) packet.points = final.points.map(roundPoint);
        stroke.sent = true;
        publish(packet, true);
      } else if (stroke.sent) sendCancel(stroke.spec, stroke.shareId, ++stroke.seq);
      finished.set(id, { spec: stroke.spec, shareId: stroke.shareId, seq: stroke.seq, sent: stroke.sent, at: o.now() });
    },
    cancel(rawId) {
      const id = rawId.toLowerCase();
      const stroke = active.get(id);
      if (stroke) {
        stopTimers(stroke);
        active.delete(id);
        if (stroke.sent) sendCancel(stroke.spec, stroke.shareId, ++stroke.seq);
        return;
      }
      const done = finished.get(id);
      if (!done) return;
      finished.delete(id);
      if (done.sent) sendCancel(done.spec, done.shareId, ++done.seq);
    },
    cancelAll() {
      for (const id of [...active.keys()]) sender.cancel(id);
    },
  };
  return sender;
}
