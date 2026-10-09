import type { Annotation, AnnotationKind, AnnotationOp, AnnotationPayload, LaserStyle, RoomState } from "@/lib/confa-types";
import { dropIdentity, dropOtherShares, EMPTY_DRAFT_VIEW, EMPTY_DRAFTS, parseDraftPacket, receiveDraft, selectDraftView, settleDrafts, sweepDrafts, type DraftFilter, type DraftKind, type DraftState, type DraftView } from "./annotation-drafts.ts";
import { accessRoomFromState, canAnnotate, canModerate } from "./annotation-permissions.ts";
import { isAnnotationKind, validateAnnotationPayload, type PayloadPatch } from "./annotation-validate.ts";

export const HISTORY_LIMIT = 50;
export const JOURNAL_LIMIT = 1000;
export const SEEN_LIMIT = 2000;

export type BoardRow = Annotation & { data: AnnotationPayload };
export type PendingRow = Omit<BoardRow, "seq"> & { seq: number | null };
export type Board = { shareId: string | null; rows: ReadonlyMap<string, BoardRow> };
export type BoardItem = { id: string; kind: AnnotationKind; authorId: string; authorName: string; data: AnnotationPayload; seq: number | null; createdAt: number; status: "saved" | "sending" | "moving" | "editing" };
export type BoardView = { shareId: string | null; items: readonly BoardItem[]; liveCount: number };
export type PendingOverlay = { data: AnnotationPayload; status: "moving" | "editing" };
export type Pending = { adds: ReadonlyMap<string, PendingRow>; overlays: ReadonlyMap<string, PendingOverlay>; erases: ReadonlySet<string>; clearUpTo: number | null };
export type SnapshotTicket = { id: number; journalIndex: number };
export type SnapshotResult = "applied" | "stale" | "reset";
export type SnapshotSink = {
  beginSnapshot(): SnapshotTicket;
  releaseSnapshot(ticket: SnapshotTicket): void;
  applySnapshot(ticket: SnapshotTicket, shareId: string | null, rows: Annotation[]): SnapshotResult;
};
// `tag` identifies an entry across re-keys and merges; the client assigns it.
export type HistoryEntry = { tag?: number } & (
  | { op: "add"; ids: string[] }
  | { op: "erase"; ids: string[]; rows: PendingRow[]; gesture?: string }
  | { op: "restore"; ids: string[] }
  | { op: "clear"; ids: string[]; rows: PendingRow[] }
  | { op: "move"; id: string; dx: number; dy: number }
  | { op: "edit"; id: string; before: PayloadPatch; after: PayloadPatch }
);
export type HistoryCommand =
  | { op: "erase"; ids: string[] }
  | { op: "restore"; ids: string[]; rows: PendingRow[] }
  | { op: "move"; id: string; dx: number; dy: number }
  | { op: "edit"; id: string; patch: PayloadPatch };
export type HistoryState = { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] };
export type HistoryFlags = { canUndo: boolean; canRedo: boolean };
export type SyncContext = DraftFilter & { selfId: string | null; nameOf(identity: string): string | undefined };
export type AnnotationActivity =
  | { type: "mark"; id: string; authorId: string; authorName: string; kind: AnnotationKind }
  | { type: "draft-start"; strokeId: string; authorId: string; authorName: string; kind: DraftKind; style?: LaserStyle };
export type ApplyResult = "ok" | "ignored" | "resync";
export type AnnotationStore = SnapshotSink & {
  now(): number;
  subscribeBoard(listener: () => void): () => void;
  getBoard(): BoardView;
  subscribeDrafts(listener: () => void): () => void;
  getDrafts(): DraftView;
  subscribeHistory(listener: () => void): () => void;
  getHistory(): HistoryFlags;
  subscribeActivity(listener: (activity: AnnotationActivity) => void): () => void;
  nameOf(identity: string): string | undefined;
  setContext(context: SyncContext): void;
  context(): SyncContext;
  // A local op (a response the server also broadcasts) skips the rows and ids whose server copy arrived after `since`
  // (a serverCursor() value taken before the request), so it never overwrites a newer server op.
  applyOp(op: AnnotationOp, origin: "server" | "local", since?: number): ApplyResult;
  serverCursor(): number;
  receiveDraft(identity: string, name: string | undefined, raw: unknown): void;
  dropDraftsOf(identity: string): void;
  sweep(): void;
  // Used by the client: raw state, mutations, and batching so one action produces one emit.
  board(): Board;
  pending(): Pending;
  history(): HistoryState;
  mutatePending(update: (pending: Pending) => Pending): void;
  mutateHistory(update: (history: HistoryState) => HistoryState): void;
  batch<T>(run: () => T): T;
};

export const EMPTY_BOARD: Board = { shareId: null, rows: new Map() };
export const EMPTY_PENDING: Pending = { adds: new Map(), overlays: new Map(), erases: new Set(), clearUpTo: null };
export const EMPTY_HISTORY: HistoryState = { undo: [], redo: [] };
export const EMPTY_CONTEXT: SyncContext = { shareId: null, selfId: null, canAnnotate: () => false, canModerate: () => false, nameOf: () => undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Parsing

export function parseRow(raw: unknown): Annotation | null {
  if (!isRecord(raw)) return null;
  const { id, author_id, author_name, kind, payload, created_at, seq } = raw;
  if (typeof id !== "string" || !id || typeof author_id !== "string" || typeof payload !== "string" || !isAnnotationKind(kind)) return null;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  return { id, author_id, author_name: typeof author_name === "string" ? author_name : "", kind, payload, created_at: typeof created_at === "number" && Number.isFinite(created_at) ? created_at : 0, seq };
}

export function parseServerOp(raw: unknown): AnnotationOp | null {
  if (!isRecord(raw) || raw.type !== "annotations" || raw.v !== 1) return null;
  const { shareId, by, op } = raw;
  if (typeof shareId !== "string" || !shareId || typeof by !== "string") return null;
  const head = { type: "annotations" as const, v: 1 as const, shareId, by };
  if (op === "add" || op === "move" || op === "edit" || op === "restore") {
    if (!Array.isArray(raw.rows)) return null;
    const rows = raw.rows.map(parseRow);
    return rows.every((row): row is Annotation => row !== null) ? { ...head, op, rows } : null;
  }
  if (op === "erase") {
    if (!Array.isArray(raw.ids) || !raw.ids.every((id) => typeof id === "string")) return null;
    return { ...head, op, ids: [...raw.ids] as string[] };
  }
  if (op === "clear") {
    const upToSeq = raw.upToSeq;
    return typeof upToSeq === "number" && Number.isFinite(upToSeq) ? { ...head, op, upToSeq } : null;
  }
  return op === "resync" ? { ...head, op } : null;
}

export function parsePayload(payload: string): AnnotationPayload | null {
  try {
    const data: unknown = JSON.parse(payload);
    return isRecord(data) && typeof data.color === "string" ? data as AnnotationPayload : null;
  } catch {
    return null;
  }
}

// Board

function sameRow(a: Annotation, b: Annotation): boolean {
  return a.payload === b.payload && a.seq === b.seq && a.author_name === b.author_name && a.author_id === b.author_id && a.kind === b.kind && a.created_at === b.created_at;
}

// Reuses `previous` when nothing changed so memoized items keep their identity; null when the payload is unreadable or invalid
// (the old server stored unchecked keys), so rendering and hit-testing only ever see validated data.
export function toBoardRow(row: Annotation, previous?: BoardRow): BoardRow | null {
  if (previous && sameRow(previous, row)) return previous;
  const parsed = parsePayload(row.payload);
  const checked = parsed ? validateAnnotationPayload(row.kind, parsed) : null;
  if (!checked || "error" in checked) return null;
  return { id: row.id, author_id: row.author_id, author_name: row.author_name, kind: row.kind, payload: row.payload, created_at: row.created_at, seq: row.seq, data: checked.payload };
}

// Idempotent; ops for another share leave the board untouched.
export function applyOp(board: Board, op: AnnotationOp): Board {
  if (op.shareId !== board.shareId) return board;
  let rows: Map<string, BoardRow> | null = null;
  const edit = () => (rows ??= new Map(board.rows));
  switch (op.op) {
    case "add":
    case "move":
    case "edit":
    case "restore":
      for (const row of op.rows) {
        const previous = (rows ?? board.rows).get(row.id);
        const next = toBoardRow(row, previous);
        if (next === previous) continue;
        if (next) edit().set(row.id, next);
        else if (previous) edit().delete(row.id);
      }
      break;
    case "erase":
      for (const id of op.ids) if ((rows ?? board.rows).has(id)) edit().delete(id);
      break;
    case "clear":
      for (const row of board.rows.values()) if (row.seq <= op.upToSeq) edit().delete(row.id);
      break;
  }
  return rows ? { shareId: board.shareId, rows } : board;
}

export function boardFromRows(shareId: string | null, rows: readonly Annotation[], previous?: Board): Board {
  const prior = previous && previous.shareId === shareId ? previous.rows : undefined;
  const map = new Map<string, BoardRow>();
  for (const row of rows) {
    const next = toBoardRow(row, prior?.get(row.id) ?? map.get(row.id));
    if (next) map.set(row.id, next);
    else map.delete(row.id);
  }
  if (previous && prior && prior.size === map.size && [...map].every(([id, row]) => prior.get(id) === row)) return previous;
  return { shareId, rows: map };
}

const rowItems = new WeakMap<object, BoardItem>();
const overlayItems = new WeakMap<PendingOverlay, { row: PendingRow; item: BoardItem }>();

function itemFor(row: PendingRow, status: BoardItem["status"], overlay?: PendingOverlay): BoardItem {
  if (overlay) {
    const cached = overlayItems.get(overlay);
    if (cached?.row === row) return cached.item;
  } else {
    const cached = rowItems.get(row);
    if (cached) return cached;
  }
  const item: BoardItem = { id: row.id, kind: row.kind, authorId: row.author_id, authorName: row.author_name, data: overlay?.data ?? row.data, seq: row.seq, createdAt: row.created_at, status: overlay?.status ?? status };
  if (overlay) overlayItems.set(overlay, { row, item });
  else rowItems.set(row, item);
  return item;
}

// Saved rows by seq, minus pending erases and the pending clear, with move/edit overlays; then unsaved adds (seq null) last.
export function buildView(board: Board, pending: Pending, previous?: BoardView): BoardView {
  const items: BoardItem[] = [];
  for (const row of board.rows.values()) {
    if (pending.erases.has(row.id) || (pending.clearUpTo !== null && row.seq <= pending.clearUpTo)) continue;
    items.push(itemFor(row, "saved", pending.overlays.get(row.id)));
  }
  for (const row of pending.adds.values()) {
    if (board.rows.has(row.id) || pending.erases.has(row.id)) continue;
    items.push(itemFor(row, "sending", pending.overlays.get(row.id)));
  }
  items.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  if (previous && previous.shareId === board.shareId && previous.items.length === items.length && previous.items.every((item, i) => item === items[i])) return previous;
  return { shareId: board.shareId, items, liveCount: items.length };
}

// History

function mergeUnique<T>(a: readonly T[], b: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((item) => !seen.has(key(item)) && seen.add(key(item)))];
}

// Clears redo and keeps the newest HISTORY_LIMIT; erase entries of one eraser gesture merge into one undo step.
export function pushHistory(history: HistoryState, entry: HistoryEntry, limit = HISTORY_LIMIT): HistoryState {
  const top = history.undo[history.undo.length - 1];
  if (entry.op === "erase" && entry.gesture !== undefined && top?.op === "erase" && top.gesture === entry.gesture) {
    const merged: HistoryEntry = { ...top, ids: mergeUnique(top.ids, entry.ids, (id) => id), rows: mergeUnique(top.rows, entry.rows, (row) => row.id) };
    return { undo: [...history.undo.slice(0, -1), merged], redo: [] };
  }
  const undo = [...history.undo, entry];
  return { undo: undo.length > limit ? undo.slice(undo.length - limit) : undo, redo: [] };
}

// Appends to one stack without clearing the other (undo results go to redo and back).
export function pushStack(history: HistoryState, stack: "undo" | "redo", entry: HistoryEntry, limit = HISTORY_LIMIT): HistoryState {
  const next = [...history[stack], entry];
  return { ...history, [stack]: next.length > limit ? next.slice(next.length - limit) : next };
}

export function inverseOf(entry: HistoryEntry): HistoryCommand {
  switch (entry.op) {
    case "add":
    case "restore":
      return { op: "erase", ids: [...entry.ids] };
    case "erase":
    case "clear":
      return { op: "restore", ids: [...entry.ids], rows: [...entry.rows] };
    case "move":
      return { op: "move", id: entry.id, dx: -entry.dx, dy: -entry.dy };
    case "edit":
      return { op: "edit", id: entry.id, patch: { ...entry.before } };
  }
}

// Applies `update` to every entry of both stacks; returning null drops the entry. Unchanged stacks keep their identity.
export function mapHistory(history: HistoryState, update: (entry: HistoryEntry) => HistoryEntry | null): HistoryState {
  const map = (stack: readonly HistoryEntry[]) => {
    let changed = false;
    const next: HistoryEntry[] = [];
    for (const entry of stack) {
      const mapped = update(entry);
      if (mapped !== entry) changed = true;
      if (mapped) next.push(mapped);
    }
    return changed ? next : stack;
  };
  const undo = map(history.undo), redo = map(history.redo);
  return undo === history.undo && redo === history.redo ? history : { undo, redo };
}

export function entryIds(entry: HistoryEntry): readonly string[] {
  return entry.op === "move" || entry.op === "edit" ? [entry.id] : entry.ids;
}

// Drops `ids` from add/erase/restore/clear entries (and move/edit entries of those ids); entries left empty are removed.
export function withoutIds(entry: HistoryEntry, ids: ReadonlySet<string>, ops?: ReadonlyArray<HistoryEntry["op"]>): HistoryEntry | null {
  if (ops && !ops.includes(entry.op)) return entry;
  if (entry.op === "move" || entry.op === "edit") return ids.has(entry.id) ? null : entry;
  if (!entry.ids.some((id) => ids.has(id))) return entry;
  const kept = entry.ids.filter((id) => !ids.has(id));
  if (!kept.length) return null;
  if (entry.op === "erase" || entry.op === "clear") return { ...entry, ids: kept, rows: entry.rows.filter((row) => !ids.has(row.id)) };
  return { ...entry, ids: kept };
}

export function renameId(entry: HistoryEntry, from: string, to: string): HistoryEntry {
  if (entry.op === "move" || entry.op === "edit") return entry.id === from ? { ...entry, id: to } : entry;
  if (!entry.ids.includes(from)) return entry;
  const ids = entry.ids.map((id) => id === from ? to : id);
  if (entry.op === "erase" || entry.op === "clear") return { ...entry, ids, rows: entry.rows.map((row) => row.id === from ? { ...row, id: to } : row) };
  return { ...entry, ids };
}

// Fingerprints of what an op changes, to recognise the server copy of a local op.

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

function rowKey(op: string, row: Annotation): string {
  return `${op}:${row.id}:${row.payload.length}:${hashText(row.payload)}`;
}

function opKeys(op: AnnotationOp): string[] {
  if (op.op === "add" || op.op === "move" || op.op === "edit" || op.op === "restore") return op.rows.map((row) => rowKey(op.op, row));
  if (op.op === "erase") return op.ids.map((id) => `erase:${id}`);
  return op.op === "clear" ? [`clear:${op.upToSeq}`] : [];
}

// The part of `op` whose keys pass `keep`; null when nothing is left.
function filterOp(op: AnnotationOp, keep: (key: string) => boolean): AnnotationOp | null {
  if (op.op === "add" || op.op === "move" || op.op === "edit" || op.op === "restore") {
    const rows = op.rows.filter((row) => keep(rowKey(op.op, row)));
    return rows.length === op.rows.length ? op : rows.length ? { ...op, rows } : null;
  }
  if (op.op === "erase") {
    const ids = op.ids.filter((id) => keep(`erase:${id}`));
    return ids.length === op.ids.length ? op : ids.length ? { ...op, ids } : null;
  }
  return op.op === "clear" && !keep(`clear:${op.upToSeq}`) ? null : op;
}

// Context

export function contextFromState(state: RoomState | null, selfId: string | null): SyncContext {
  if (!state) return { ...EMPTY_CONTEXT, selfId };
  const access = accessRoomFromState(state.room);
  const members = new Map(state.members.map((member) => [member.id, member]));
  return {
    shareId: state.room.activeShareId,
    selfId,
    canAnnotate: (identity) => canAnnotate(members.get(identity), access),
    canModerate: (identity) => canModerate(members.get(identity), access),
    nameOf: (identity) => members.get(identity)?.name || undefined,
  };
}

// Store

export function createAnnotationStore(options: { now(): number }): AnnotationStore {
  const now = () => options.now();
  let board = EMPTY_BOARD;
  let pending = EMPTY_PENDING;
  let history = EMPTY_HISTORY;
  let drafts: DraftState = EMPTY_DRAFTS;
  let context = EMPTY_CONTEXT;
  let boardView = buildView(board, pending);
  let draftView = EMPTY_DRAFT_VIEW;
  let flags: HistoryFlags = { canUndo: false, canRedo: false };
  const names = new Map<string, string>();
  const boardListeners = new Set<() => void>(), draftListeners = new Set<() => void>(), historyListeners = new Set<() => void>();
  const activityListeners = new Set<(activity: AnnotationActivity) => void>();
  let activities: AnnotationActivity[] = [];
  let depth = 0;
  let journal: AnnotationOp[] = [];
  let journalBase = 0, ticketSeq = 0, lastApplied = 0;
  const outstanding = new Map<number, number>();
  // Server ops applied to the current share: fingerprint -> arrival number, oldest first.
  let serverOps = 0;
  const seen = new Map<string, number>();

  const authorOf = (id: string) => board.rows.get(id)?.author_id ?? pending.adds.get(id)?.author_id;
  const subscribe = <T>(set: Set<T>, listener: T) => {
    set.add(listener);
    return () => { set.delete(listener); };
  };
  const notify = (listeners: Iterable<() => void>) => {
    for (const listener of [...listeners]) listener();
  };

  // Inputs the cached views were built from; a view is rebuilt only when one of its inputs changed.
  let viewInputs = [board, pending] as const;
  let draftInputs = [drafts, context, board, pending] as const;

  // One emit per outermost batch: views are rebuilt once and each channel is notified only if its snapshot changed.
  const emit = () => {
    const boardStale = viewInputs[0] !== board || viewInputs[1] !== pending;
    const draftsStale = draftInputs[0] !== drafts || draftInputs[1] !== context || draftInputs[2] !== board || draftInputs[3] !== pending;
    viewInputs = [board, pending];
    draftInputs = [drafts, context, board, pending];
    const nextBoard = boardStale ? buildView(board, pending, boardView) : boardView;
    const nextDrafts = draftsStale ? selectDraftView(drafts, context, board.rows, authorOf, draftView) : draftView;
    const canUndo = history.undo.length > 0, canRedo = history.redo.length > 0;
    const nextFlags = canUndo === flags.canUndo && canRedo === flags.canRedo ? flags : { canUndo, canRedo };
    const changed: Array<Set<() => void>> = [];
    if (nextBoard !== boardView) { boardView = nextBoard; changed.push(boardListeners); }
    if (nextDrafts !== draftView) { draftView = nextDrafts; changed.push(draftListeners); }
    if (nextFlags !== flags) { flags = nextFlags; changed.push(historyListeners); }
    const events = activities;
    activities = [];
    for (const listeners of changed) notify(listeners);
    for (const event of events) for (const listener of [...activityListeners]) listener(event);
  };

  const batch = <T>(run: () => T): T => {
    depth++;
    try {
      return run();
    } finally {
      depth--;
      if (depth === 0) emit();
    }
  };

  const learnNames = (rows: readonly Annotation[]) => {
    for (const row of rows) if (row.author_name) names.set(row.author_id, row.author_name);
  };

  const remember = (op: AnnotationOp) => {
    const arrival = ++serverOps;
    for (const key of opKeys(op)) {
      seen.delete(key);
      seen.set(key, arrival);
    }
    for (const key of seen.keys()) {
      if (seen.size <= SEEN_LIMIT) break;
      seen.delete(key);
    }
  };

  const pruneJournal = () => {
    let keepFrom = journalBase + journal.length;
    for (const index of outstanding.values()) keepFrom = Math.min(keepFrom, index);
    const drop = Math.max(keepFrom - journalBase, journal.length - JOURNAL_LIMIT);
    if (drop <= 0) return;
    journal = journal.slice(drop);
    journalBase += drop;
  };

  const store: AnnotationStore = {
    now,
    subscribeBoard: (listener) => subscribe(boardListeners, listener),
    getBoard: () => boardView,
    subscribeDrafts: (listener) => subscribe(draftListeners, listener),
    getDrafts: () => draftView,
    subscribeHistory: (listener) => subscribe(historyListeners, listener),
    getHistory: () => flags,
    subscribeActivity: (listener) => subscribe(activityListeners, listener),
    nameOf: (identity) => context.nameOf(identity) || names.get(identity) || undefined,
    setContext(next) {
      batch(() => { context = next; });
    },
    context: () => context,

    beginSnapshot() {
      const ticket = { id: ++ticketSeq, journalIndex: journalBase + journal.length };
      outstanding.set(ticket.id, ticket.journalIndex);
      return ticket;
    },
    releaseSnapshot(ticket) {
      outstanding.delete(ticket.id);
      pruneJournal();
    },
    // Snapshot + replay of every op received since the ticket was taken, so an older read never undoes a newer op.
    applySnapshot(ticket, shareId, rows) {
      outstanding.delete(ticket.id);
      if (ticket.id < lastApplied || ticket.journalIndex < journalBase) {
        pruneJournal();
        return "stale";
      }
      const replay = journal.slice(ticket.journalIndex - journalBase);
      lastApplied = ticket.id;
      const reset = shareId !== board.shareId;
      batch(() => {
        board = replay.reduce(applyOp, boardFromRows(shareId, rows, reset ? undefined : board));
        if (reset) {
          seen.clear();
          pending = EMPTY_PENDING;
          history = EMPTY_HISTORY;
          drafts = dropOtherShares(drafts, shareId, now());
        }
        drafts = settleDrafts(drafts, board.rows, [], now());
        learnNames(rows);
      });
      pruneJournal();
      return reset ? "reset" : "applied";
    },

    applyOp(raw, origin, since) {
      if (raw.op === "resync") return "resync";
      const op = origin === "local" && since !== undefined && raw.shareId === board.shareId ? filterOp(raw, (key) => !((seen.get(key) ?? 0) > since)) : raw;
      if (!op) return "ignored";
      journal.push(op);
      pruneJournal();
      if (op.shareId !== board.shareId) return "ignored";
      if (origin === "server") remember(op);
      batch(() => {
        const before = board;
        board = applyOp(board, op);
        if (op.op === "add" || op.op === "move" || op.op === "edit" || op.op === "restore") {
          learnNames(op.rows);
          // The saved row replaces our pending copy at once, so a later erase cannot bring the copy back as "sending".
          const saved = origin === "server" && op.op !== "move" && op.op !== "edit" ? op.rows.filter((row) => pending.adds.get(row.id)?.author_id === row.author_id && board.rows.has(row.id)) : [];
          if (saved.length) {
            const adds = new Map(pending.adds);
            for (const row of saved) adds.delete(row.id);
            pending = { ...pending, adds };
          }
          if (op.op === "add" && origin === "server") {
            for (const row of op.rows) {
              if (row.author_id === context.selfId || before.rows.has(row.id) || !board.rows.has(row.id)) continue;
              activities.push({ type: "mark", id: row.id, authorId: row.author_id, authorName: row.author_name, kind: row.kind });
            }
          }
        }
        drafts = settleDrafts(drafts, board.rows, op.op === "move" ? op.rows.map((row) => ({ id: row.id, by: op.by })) : [], now());
      });
      return "ok";
    },
    serverCursor: () => serverOps,

    receiveDraft(identity, name, raw) {
      const packet = parseDraftPacket(raw);
      if (!packet) return;
      if (name) names.set(identity, name);
      batch(() => {
        const existed = drafts.entries.has(packet.strokeId);
        drafts = receiveDraft(drafts, packet, { identity, name: name || store.nameOf(identity) || "" }, now());
        const entry = drafts.entries.get(packet.strokeId);
        if (existed || !entry || entry.moveOf || identity === context.selfId || entry.shareId !== context.shareId || !context.canAnnotate(identity)) return;
        activities.push({ type: "draft-start", strokeId: entry.key, authorId: identity, authorName: entry.name, kind: entry.kind, ...(entry.style ? { style: entry.style } : {}) });
      });
    },
    dropDraftsOf(identity) {
      batch(() => { drafts = dropIdentity(drafts, identity, now()); });
    },
    sweep() {
      batch(() => { drafts = sweepDrafts(drafts, now()); });
    },

    board: () => board,
    pending: () => pending,
    history: () => history,
    mutatePending(update) {
      batch(() => { pending = update(pending); });
    },
    mutateHistory(update) {
      batch(() => { history = update(history); });
    },
    batch,
  };
  return store;
}
