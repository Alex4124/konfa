import type { TimerHost } from "./annotation-drafts.ts";

// Students strictly follow the teacher's scroll. The teacher's client sends, per part of the workspace, the position at the
// top of its viewport (lib/scroll-strip: tile index + fraction) and how many strip widths of rows it shows (`span`), over the
// LiveKit data channel: lossy while scrolling, reliable once it settles, and a reliable heartbeat for late joiners.
// Receivers take packets only from a host and only in order (epoch = when that client started sending, seq within it).

export const VIEW_TOPIC = "confa-workspace-view";
export const VIEW_SEND_MS = 80;
export const VIEW_HEARTBEAT_MS = 2000;
export const VIEW_STALE_MS = 4000; // without packets for this long the polled state is the position
export const MAX_VIEW_POS = 1000;

export type PartView = Readonly<{ pos: number; span: number }>;
export type DocView = PartView & Readonly<{ id: string }>;
export type ViewSnapshot = Readonly<{ ws: string; board?: PartView; doc?: DocView }>;
export type ViewPacket = ViewSnapshot & Readonly<{ v: 1; epoch: number; seq: number }>;
export type ViewReceiver = { accept(packet: ViewPacket, now: number): boolean; latest(): ViewPacket | null; fresh(now: number): boolean };
export type ViewSender = { update(snapshot: ViewSnapshot, settled?: boolean): void; stop(): void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const finiteIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const idLike = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

function parsePart(raw: unknown): PartView | null {
  if (!isRecord(raw) || !finiteIn(raw.pos, 0, MAX_VIEW_POS) || !finiteIn(raw.span, 0.01, 100)) return null;
  return { pos: raw.pos, span: raw.span };
}

export function parseViewPacket(raw: unknown): ViewPacket | null {
  if (!isRecord(raw) || raw.v !== 1 || !idLike(raw.ws)) return null;
  if (!finiteIn(raw.epoch, 0, Number.MAX_SAFE_INTEGER) || !finiteIn(raw.seq, 0, Number.MAX_SAFE_INTEGER)) return null;
  const board = raw.board === undefined ? undefined : parsePart(raw.board);
  const docPart = raw.doc === undefined ? undefined : parsePart(raw.doc);
  if (board === null || docPart === null) return null;
  if (docPart && (!isRecord(raw.doc) || !idLike(raw.doc.id))) return null;
  const doc = docPart ? { ...docPart, id: (raw.doc as { id: string }).id } : undefined;
  return { v: 1, ws: raw.ws, epoch: raw.epoch, seq: raw.seq, ...(board ? { board } : {}), ...(doc ? { doc } : {}) };
}

export function sameSnapshot(a: ViewSnapshot | null, b: ViewSnapshot | null): boolean {
  if (!a || !b) return a === b;
  const part = (x?: PartView, y?: PartView) => (!x || !y ? x === y : x.pos === y.pos && x.span === y.span);
  return a.ws === b.ws && part(a.board, b.board) && part(a.doc, b.doc) && a.doc?.id === b.doc?.id;
}

// Newest packet wins: a later epoch (the teacher reloaded) or a later seq of the same one. Lossy and reliable packets may
// arrive out of order, so anything older is dropped.
export function createViewReceiver(): ViewReceiver {
  let current: ViewPacket | null = null;
  let at = -Infinity;
  return {
    accept(packet, now) {
      if (current && (packet.epoch < current.epoch || (packet.epoch === current.epoch && packet.seq <= current.seq))) return false;
      current = packet;
      at = now;
      return true;
    },
    latest: () => current,
    fresh: (now) => now - at < VIEW_STALE_MS,
  };
}

export function createViewSender(o: { publish(data: Uint8Array, reliable: boolean): Promise<void> | void; now(): number; timers: TimerHost; epoch: number; sendMs?: number; heartbeatMs?: number }): ViewSender {
  const sendMs = o.sendMs ?? VIEW_SEND_MS;
  const encoder = new TextEncoder();
  let latest: ViewSnapshot | null = null;
  let sent: ViewSnapshot | null = null; // the last snapshot that went out
  let delivered: ViewSnapshot | null = null; // the last one sent reliably
  let settledDue = false; // the latest snapshot still needs its reliable copy
  let seq = 0;
  let lastAt = -Infinity;
  let trailing: number | null = null;

  const send = (reliable: boolean) => {
    if (!latest) return;
    const packet: ViewPacket = { v: 1, epoch: o.epoch, seq: ++seq, ...latest };
    sent = latest;
    lastAt = o.now();
    if (reliable) {
      settledDue = false;
      delivered = latest;
    }
    try {
      const result = o.publish(encoder.encode(JSON.stringify(packet)), reliable);
      if (result && typeof result.then === "function") result.then(undefined, () => undefined);
    } catch { /* Not connected yet: the heartbeat sends it again */ }
  };
  const flush = () => {
    trailing = null;
    if (settledDue) send(true);
    else if (!sameSnapshot(latest, sent)) send(false);
  };
  const heartbeat = o.timers.setInterval(() => send(true), o.heartbeatMs ?? VIEW_HEARTBEAT_MS);

  return {
    update(snapshot, settled = false) {
      latest = snapshot;
      if (settled && !sameSnapshot(snapshot, delivered)) settledDue = true;
      if (!settledDue && sameSnapshot(latest, sent)) return;
      if (trailing !== null) return;
      const wait = lastAt + sendMs - o.now();
      if (wait <= 0) flush();
      else trailing = o.timers.setTimeout(flush, wait);
    },
    stop() {
      o.timers.clearInterval(heartbeat);
      if (trailing !== null) o.timers.clearTimeout(trailing);
      trailing = null;
    },
  };
}
