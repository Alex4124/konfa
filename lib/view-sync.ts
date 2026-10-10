import type { TimerHost } from "./annotation-drafts.ts";

// Students strictly follow the teacher's scroll. The teacher's client sends, per part of the workspace, the position at the
// top of its viewport (lib/scroll-strip: tile index + fraction) and how many strip widths of rows it shows (`span`), over the
// LiveKit data channel: lossy while scrolling, reliable once it settles, and a reliable heartbeat for late joiners.
// The teacher may be signed in on several devices (a laptop and a tablet to write on). Every part carries a stamp of its
// sender's last deliberate move of it (scrolling, jumping to a page, pressing on it); the device with the newest stamp leads
// that part: students and the teacher's other devices go where it is. A resize or a heartbeat never takes the lead.

export const VIEW_TOPIC = "confa-workspace-view";
export const VIEW_SEND_MS = 80;
export const VIEW_HEARTBEAT_MS = 2000;
export const VIEW_STALE_MS = 4000; // without packets for this long the polled state is the position
export const MAX_VIEW_POS = 1000;

export type ViewPart = "board" | "doc";
export type PartView = Readonly<{ pos: number; span: number }>;
export type SentPart = PartView & Readonly<{ at: number }>; // at: the stamp of the sender's last deliberate move of this part
export type SentDoc = SentPart & Readonly<{ id: string }>;
export type ViewSnapshot = Readonly<{ ws: string; board?: SentPart; doc?: SentDoc }>;
export type ViewPacket = ViewSnapshot & Readonly<{ v: 1; epoch: number; seq: number }>;
// heard: when the sender's newest packet arrived (the receiver's clock): the lead is stale once that is VIEW_STALE_MS ago.
export type LedPart = SentPart & Readonly<{ sender: string; heard: number }>;
export type ViewReceiver = {
  accept(sender: string, packet: ViewPacket, now: number): boolean; // false: older than what this sender has already sent
  lead(part: ViewPart, ws: string, docId?: string | null): LedPart | null; // the part from the device that moved it last
  newest(): number; // the highest stamp seen from anyone
  forget(sender: string): void;
};
export type ViewSender = { update(snapshot: ViewSnapshot, settled?: boolean): void; stop(): void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const finiteIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const idLike = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

function parsePart(raw: unknown): SentPart | null {
  if (!isRecord(raw) || !finiteIn(raw.pos, 0, MAX_VIEW_POS) || !finiteIn(raw.span, 0.01, 100) || !finiteIn(raw.at, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { pos: raw.pos, span: raw.span, at: raw.at };
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
  const part = (x?: SentPart, y?: SentPart) => (!x || !y ? x === y : x.pos === y.pos && x.span === y.span && x.at === y.at);
  return a.ws === b.ws && part(a.board, b.board) && part(a.doc, b.doc) && a.doc?.id === b.doc?.id;
}

// The stamp of a deliberate move made now: later than every stamp seen so far, whatever the other devices' clocks say.
export function nextStamp(clock: number, newest: number): number {
  return Math.max(Math.floor(clock), newest + 1);
}

// Packets of one sender are taken in order: a later epoch (that device reloaded) or a later seq of the same one; lossy and
// reliable packets may arrive out of order, so anything older is dropped. Across senders the newest stamp of a part leads.
export function createViewReceiver(): ViewReceiver {
  const senders = new Map<string, { packet: ViewPacket; heard: number }>();
  let newest = 0;
  return {
    accept(sender, packet, now) {
      const known = senders.get(sender)?.packet;
      if (known && (packet.epoch < known.epoch || (packet.epoch === known.epoch && packet.seq <= known.seq))) return false;
      senders.set(sender, { packet, heard: now });
      newest = Math.max(newest, packet.board?.at ?? 0, packet.doc?.at ?? 0);
      return true;
    },
    lead(part, ws, docId = null) {
      let best: LedPart | null = null;
      for (const [sender, { packet, heard }] of senders) {
        if (packet.ws !== ws) continue;
        const sent = part === "board" ? packet.board : packet.doc && packet.doc.id === docId ? packet.doc : undefined;
        if (!sent) continue;
        // Equal stamps (two devices nobody has touched yet): a fixed order, so the lead does not flip with every heartbeat.
        if (!best || sent.at > best.at || (sent.at === best.at && sender < best.sender)) best = { pos: sent.pos, span: sent.span, at: sent.at, sender, heard };
      }
      return best;
    },
    newest: () => newest,
    forget(sender) {
      senders.delete(sender);
    },
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
