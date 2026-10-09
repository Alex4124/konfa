import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, AnnotationOp, DraftPacketV2, RoomState } from "@/lib/confa-types";
import {
  applyOp, boardFromRows, buildView, contextFromState, createAnnotationStore, EMPTY_HISTORY, EMPTY_PENDING, inverseOf, JOURNAL_LIMIT, mapHistory, parseServerOp,
  pushHistory, pushStack, renameId, toBoardRow, withoutIds, type AnnotationActivity, type Board, type HistoryEntry, type Pending, type PendingRow, type SyncContext,
} from "./annotation-sync.ts";
import { fitAnnotationOp, MAX_OP_BYTES } from "./annotation-wire.ts";

const SHARE = "share-1";
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function row(n: number, over: Partial<Annotation> = {}): Annotation {
  return { id: ID(n), author_id: "ann", author_name: "Аня", kind: "pen", payload: JSON.stringify({ color: "#6de7d4", points: [[0.1, 0.1], [0.2, n / 1000]] }), created_at: 1000 + n, seq: n, ...over };
}

function op(body: Record<string, unknown>, shareId = SHARE, by = "ann"): AnnotationOp {
  return { type: "annotations", v: 1, shareId, by, ...body } as AnnotationOp;
}

const board = (rows: Annotation[], shareId: string | null = SHARE): Board => boardFromRows(shareId, rows);
const ids = (b: Board) => [...b.rows.keys()];

function pendingRow(n: number, seq: number | null = null): PendingRow {
  const base = row(n);
  return { ...base, seq, data: JSON.parse(base.payload) };
}

function withPending(over: Partial<Pending>): Pending {
  return { ...EMPTY_PENDING, ...over };
}

describe("parseServerOp", () => {
  it("accepts every op shape", () => {
    assert.deepEqual(parseServerOp(op({ op: "add", rows: [row(1)] })), op({ op: "add", rows: [row(1)] }));
    assert.deepEqual(parseServerOp(op({ op: "erase", ids: [ID(1)] })), op({ op: "erase", ids: [ID(1)] }));
    assert.deepEqual(parseServerOp(op({ op: "clear", upToSeq: 7 })), op({ op: "clear", upToSeq: 7 }));
    assert.deepEqual(parseServerOp(op({ op: "resync" })), op({ op: "resync" }));
    assert.equal(parseServerOp(op({ op: "move", rows: [{ ...row(2), author_name: undefined }] }))?.op, "move", "a missing author_name defaults to empty");
  });

  it("rejects wrong versions, missing rows, bad rows and non-string ids", () => {
    const bad: unknown[] = [
      null, "x", { type: "state-changed" }, { ...op({ op: "add", rows: [row(1)] }), v: 2 }, op({ op: "add" }), op({ op: "add", rows: [{ ...row(1), seq: "1" }] }),
      op({ op: "add", rows: [{ ...row(1), kind: "laser" }] }), op({ op: "edit", rows: [{ ...row(1), payload: {} }] }), op({ op: "erase", ids: [1] }), op({ op: "erase" }),
      op({ op: "clear" }), op({ op: "wipe" }), { ...op({ op: "resync" }), shareId: "" }, { ...op({ op: "resync" }), by: 5 },
    ];
    for (const raw of bad) assert.equal(parseServerOp(raw), null, JSON.stringify(raw));
  });

  it("turns ops over MAX_OP_BYTES into resync (server side), which the store reports", () => {
    const big = op({ op: "add", rows: Array.from({ length: 3 }, (_, i) => row(i + 1, { payload: JSON.stringify({ color: "#6de7d4", text: "Ж".repeat(2500), point: [0.1, 0.1] }), kind: "text" })) });
    const fitted = fitAnnotationOp(big);
    assert.ok(new TextEncoder().encode(JSON.stringify(big)).length > MAX_OP_BYTES);
    assert.equal(fitted.op, "resync");
    const parsed = parseServerOp(JSON.parse(JSON.stringify(fitted)));
    assert.ok(parsed);
    assert.equal(createAnnotationStore({ now: () => 0 }).applyOp(parsed, "server"), "resync");
  });
});

describe("applyOp", () => {
  it("upserts rows for add, move, edit and restore", () => {
    const start = board([row(1)]);
    const added = applyOp(start, op({ op: "add", rows: [row(2)] }));
    assert.deepEqual(ids(added), [ID(1), ID(2)]);
    const movedRow = row(1, { payload: JSON.stringify({ color: "#6de7d4", points: [[0.5, 0.5], [0.6, 0.6]] }) });
    for (const kind of ["move", "edit", "restore"]) {
      const next = applyOp(added, op({ op: kind, rows: [movedRow] }));
      assert.deepEqual(next.rows.get(ID(1))?.data.points, [[0.5, 0.5], [0.6, 0.6]]);
      assert.equal(next.rows.get(ID(2)), added.rows.get(ID(2)), "untouched rows keep identity");
    }
    assert.deepEqual(ids(applyOp(board([]), op({ op: "restore", rows: [row(3)] }))), [ID(3)]);
  });

  it("is idempotent and returns the same board when nothing changes", () => {
    const once = applyOp(board([row(1)]), op({ op: "add", rows: [row(2)] }));
    assert.equal(applyOp(once, op({ op: "add", rows: [row(2)] })), once);
    assert.equal(applyOp(once, op({ op: "erase", ids: [ID(9)] })), once);
    assert.equal(applyOp(once, op({ op: "resync" })), once);
  });

  it("erases ids and clears up to a seq", () => {
    const start = board([row(1), row(2), row(5)]);
    assert.deepEqual(ids(applyOp(start, op({ op: "erase", ids: [ID(2), ID(9)] }))), [ID(1), ID(5)]);
    assert.deepEqual(ids(applyOp(start, op({ op: "clear", upToSeq: 2 }))), [ID(5)]);
  });

  it("ignores ops for another share and drops unreadable payloads", () => {
    const start = board([row(1)]);
    assert.equal(applyOp(start, op({ op: "erase", ids: [ID(1)] }, "other")), start);
    assert.deepEqual(ids(applyOp(start, op({ op: "edit", rows: [row(1, { payload: "{oops" })] }))), []);
  });
});

describe("toBoardRow", () => {
  it("drops rows that fail validation and keeps only whitelisted keys", () => {
    const bad = row(2, { kind: "text", payload: JSON.stringify({ color: "#ffffff", point: [0.1, 0.1], text: "ab", lines: "ab" }) });
    const junk = row(3, { payload: JSON.stringify({ color: "#6de7d4", points: [[0.1, 0.1], [0.2, 0.2]], extra: { deep: 1 } }) });
    assert.equal(toBoardRow(bad), null, "a legacy row with unchecked keys never reaches rendering");
    const b = board([row(1), bad, junk]);
    assert.deepEqual(ids(b), [ID(1), ID(3)]);
    assert.deepEqual(b.rows.get(ID(3))?.data, { color: "#6de7d4", points: [[0.1, 0.1], [0.2, 0.2]] });
    assert.equal(b.rows.get(ID(3))?.payload, junk.payload, "the stored payload string is kept for change detection");
    assert.deepEqual(ids(applyOp(b, op({ op: "restore", rows: [bad] }))), [ID(1), ID(3)]);
  });
});

describe("boardFromRows", () => {
  it("reuses the previous board and rows when nothing changed", () => {
    const first = board([row(1), row(2)]);
    assert.equal(boardFromRows(SHARE, [row(1), row(2)], first), first);
    const changed = boardFromRows(SHARE, [row(1), row(2, { payload: JSON.stringify({ color: "#ffffff", points: [[0, 0], [1, 1]] }) })], first);
    assert.notEqual(changed, first);
    assert.equal(changed.rows.get(ID(1)), first.rows.get(ID(1)));
    assert.notEqual(boardFromRows("other", [row(1)], first).rows.get(ID(1)), first.rows.get(ID(1)), "another share starts fresh");
  });
});

describe("buildView", () => {
  it("prefers the board row over a pending add with the same id", () => {
    const view = buildView(board([row(1)]), withPending({ adds: new Map([[ID(1), pendingRow(1)]]) }));
    assert.deepEqual(view.items.map((item) => [item.id, item.status, item.seq]), [[ID(1), "saved", 1]]);
  });

  it("hides pending erases, including pending adds", () => {
    const view = buildView(board([row(1), row(2)]), withPending({ adds: new Map([[ID(3), pendingRow(3)]]), erases: new Set([ID(1), ID(3)]) }));
    assert.deepEqual(view.items.map((item) => item.id), [ID(2)]);
    assert.equal(view.liveCount, 1);
  });

  it("applies move/edit overlays", () => {
    const overlay = { data: { color: "#ffffff", points: [[0.4, 0.4], [0.5, 0.5]] as [number, number][] }, status: "moving" as const };
    const view = buildView(board([row(1)]), withPending({ overlays: new Map([[ID(1), overlay]]) }));
    assert.equal(view.items[0].status, "moving");
    assert.equal(view.items[0].data, overlay.data);
  });

  it("hides only seq ≤ clearUpTo and keeps unsaved adds", () => {
    const view = buildView(board([row(1), row(2), row(3)]), withPending({ clearUpTo: 2, adds: new Map([[ID(9), pendingRow(9)]]) }));
    assert.deepEqual(view.items.map((item) => [item.id, item.status]), [[ID(3), "saved"], [ID(9), "sending"]]);
  });

  it("orders by seq with unsaved adds last and restored rows in place", () => {
    const pending = withPending({ adds: new Map([[ID(8), pendingRow(8)], [ID(2), pendingRow(2, 2)], [ID(7), pendingRow(7)]]) });
    const view = buildView(board([row(3), row(1)]), pending);
    assert.deepEqual(view.items.map((item) => item.id), [ID(1), ID(2), ID(3), ID(8), ID(7)]);
  });

  it("keeps item identity for unchanged rows and returns the previous view when equal", () => {
    const start = board([row(1), row(2)]);
    const first = buildView(start, EMPTY_PENDING);
    assert.equal(buildView(boardFromRows(SHARE, [row(1), row(2)], start), EMPTY_PENDING, first), first);
    const next = buildView(applyOp(start, op({ op: "add", rows: [row(3)] })), EMPTY_PENDING, first);
    assert.notEqual(next, first);
    assert.equal(next.items[0], first.items[0]);
    assert.equal(next.items[1], first.items[1]);
  });
});

describe("history", () => {
  const erase = (gesture: string, n: number): HistoryEntry => ({ op: "erase", ids: [ID(n)], rows: [pendingRow(n, n)], gesture });

  it("clears redo on a new entry and keeps at most 50", () => {
    let history = pushStack(EMPTY_HISTORY, "redo", { op: "add", ids: [ID(99)] });
    history = pushHistory(history, { op: "add", ids: [ID(1)] });
    assert.equal(history.redo.length, 0);
    for (let i = 2; i <= 60; i++) history = pushHistory(history, { op: "add", ids: [ID(i)] });
    assert.equal(history.undo.length, 50);
    assert.deepEqual(history.undo[0], { op: "add", ids: [ID(11)] });
  });

  it("merges erase entries of one gesture into one step", () => {
    let history = pushHistory(EMPTY_HISTORY, erase("g1", 1));
    history = pushHistory(history, erase("g1", 2));
    history = pushHistory(history, erase("g1", 2));
    history = pushHistory(history, erase("g2", 3));
    assert.equal(history.undo.length, 2);
    const [first] = history.undo;
    assert.ok(first.op === "erase");
    assert.deepEqual(first.ids, [ID(1), ID(2)]);
    assert.deepEqual(first.rows.map((item) => item.id), [ID(1), ID(2)]);
  });

  it("inverts every entry", () => {
    const rows = [pendingRow(1, 1)];
    assert.deepEqual(inverseOf({ op: "add", ids: [ID(1)] }), { op: "erase", ids: [ID(1)] });
    assert.deepEqual(inverseOf({ op: "restore", ids: [ID(1)] }), { op: "erase", ids: [ID(1)] });
    assert.deepEqual(inverseOf({ op: "erase", ids: [ID(1)], rows }), { op: "restore", ids: [ID(1)], rows });
    assert.deepEqual(inverseOf({ op: "clear", ids: [ID(1)], rows }), { op: "restore", ids: [ID(1)], rows });
    assert.deepEqual(inverseOf({ op: "move", id: ID(1), dx: 0.1, dy: -0.2 }), { op: "move", id: ID(1), dx: -0.1, dy: 0.2 });
    assert.deepEqual(inverseOf({ op: "edit", id: ID(1), before: { color: "#000000" }, after: { color: "#ffffff" } }), { op: "edit", id: ID(1), patch: { color: "#000000" } });
  });

  it("maps entries: drops ids, removes empty entries, renames re-keyed ids", () => {
    const history = { undo: [erase("g", 1), { op: "add", ids: [ID(1), ID(2)] }, { op: "move", id: ID(1), dx: 0.1, dy: 0 }] as HistoryEntry[], redo: [] };
    const dropped = mapHistory(history, (entry) => withoutIds(entry, new Set([ID(1)])));
    assert.deepEqual(dropped.undo, [{ op: "add", ids: [ID(2)] }]);
    assert.equal(mapHistory(history, (entry) => entry), history);
    const onlyAdds = mapHistory(history, (entry) => withoutIds(entry, new Set([ID(1)]), ["add"]));
    assert.equal(onlyAdds.undo.length, 3);
    const renamed = mapHistory(history, (entry) => renameId(entry, ID(1), ID(5)));
    assert.deepEqual(renamed.undo.map((entry) => entry.op === "move" || entry.op === "edit" ? entry.id : entry.ids), [[ID(5)], [ID(5), ID(2)], ID(5)]);
    const [first] = renamed.undo;
    assert.ok(first.op === "erase");
    assert.equal(first.rows[0].id, ID(5));
  });
});

function context(over: Partial<SyncContext> = {}): SyncContext {
  return { shareId: SHARE, selfId: "me", canAnnotate: () => true, canModerate: () => false, nameOf: () => undefined, ...over };
}

function setup(rows: Annotation[] = [row(1)]) {
  let time = 0;
  const store = createAnnotationStore({ now: () => time });
  store.setContext(context());
  const ticket = store.beginSnapshot();
  assert.equal(store.applySnapshot(ticket, SHARE, rows), "reset");
  const calls = { board: 0, drafts: 0, history: 0 };
  store.subscribeBoard(() => { calls.board++; });
  store.subscribeDrafts(() => { calls.drafts++; });
  store.subscribeHistory(() => { calls.history++; });
  const activity: AnnotationActivity[] = [];
  store.subscribeActivity((event) => activity.push(event));
  return { store, calls, activity, tick: (ms: number) => { time += ms; } };
}

function draftPacket(strokeId: string, over: Partial<DraftPacketV2> = {}): DraftPacketV2 {
  return { v: 2, shareId: SHARE, strokeId, seq: 1, phase: "live", kind: "pen", color: "#6de7d4", from: 0, points: [[0.1, 0.1]], ...over };
}

describe("createAnnotationStore", () => {
  it("applies an op, settles the matching draft and notifies once, with both snapshots already updated", () => {
    const { store, calls } = setup();
    store.receiveDraft("ann", "Аня", draftPacket(ID(2)));
    assert.equal(store.getDrafts().items.length, 1);
    calls.drafts = 0;
    let seen: [number, number] | null = null;
    store.subscribeBoard(() => { seen = [store.getBoard().items.length, store.getDrafts().items.length]; });
    assert.equal(store.applyOp(op({ op: "add", rows: [row(2)] }), "server"), "ok");
    assert.deepEqual(seen, [2, 0], "the saved row and the vanished draft land in the same emit");
    assert.deepEqual(calls, { board: 1, drafts: 1, history: 0 });
    store.applyOp(op({ op: "add", rows: [row(2)] }), "server");
    assert.equal(calls.board, 1, "a duplicate op does not emit");
  });

  it("keeps snapshots referentially stable between emits", () => {
    const { store } = setup();
    const boardView = store.getBoard(), drafts = store.getDrafts(), history = store.getHistory();
    store.sweep();
    store.setContext(store.context());
    assert.equal(store.getBoard(), boardView);
    assert.equal(store.getDrafts(), drafts);
    assert.equal(store.getHistory(), history);
  });

  it("emits mark activity for foreign server adds only", () => {
    const { store, activity } = setup();
    store.applyOp(op({ op: "add", rows: [row(2, { author_id: "bob", author_name: "Боря", kind: "arrow" })] }), "server");
    store.applyOp(op({ op: "add", rows: [row(3, { author_id: "me" })] }), "server");
    store.applyOp(op({ op: "add", rows: [row(4, { author_id: "bob" })] }), "local");
    store.applyOp(op({ op: "add", rows: [row(2, { author_id: "bob", author_name: "Боря", kind: "arrow" })] }), "server");
    assert.deepEqual(activity, [{ type: "mark", id: ID(2), authorId: "bob", authorName: "Боря", kind: "arrow" }]);
  });

  it("emits draft-start on the first packet of a permitted foreign stroke", () => {
    const { store, activity } = setup();
    store.receiveDraft("bob", "Боря", draftPacket(ID(5), { kind: "laser", style: "laser", color: "#ff3b5c" }));
    store.receiveDraft("bob", "Боря", draftPacket(ID(5), { kind: "laser", style: "laser", color: "#ff3b5c", seq: 2 }));
    store.receiveDraft("me", "Я", draftPacket(ID(6)));
    store.receiveDraft("bob", "Боря", { v: 2, shareId: SHARE, strokeId: ID(7), seq: 1, phase: "live", kind: "pen", color: "#6de7d4", moveOf: ID(1), dx: 0.1, dy: 0 });
    store.receiveDraft("bob", "Боря", draftPacket(ID(8), { shareId: "other" }));
    store.receiveDraft("bob", "Боря", { junk: true });
    assert.deepEqual(activity, [{ type: "draft-start", strokeId: ID(5), authorId: "bob", authorName: "Боря", kind: "laser", style: "laser" }]);
    store.setContext(context({ canAnnotate: (id) => id !== "eve" }));
    store.receiveDraft("eve", "Ева", draftPacket(ID(9)));
    assert.equal(activity.length, 1);
    assert.equal(store.getDrafts().items.some((item) => item.identity === "eve"), false);
  });

  it("replays ops journaled after the ticket over an older snapshot", () => {
    const { store } = setup([row(1), row(2)]);
    const ticket = store.beginSnapshot();
    store.applyOp(op({ op: "erase", ids: [ID(2)] }), "server");
    store.applyOp(op({ op: "add", rows: [row(3)] }), "local");
    assert.equal(store.applySnapshot(ticket, SHARE, [row(1), row(2)]), "applied");
    assert.deepEqual(store.getBoard().items.map((item) => item.id), [ID(1), ID(3)]);
  });

  it("replays ops for a share that arrive before its first snapshot", () => {
    const { store, calls } = setup();
    const ticket = store.beginSnapshot();
    assert.equal(store.applyOp(op({ op: "add", rows: [row(7)] }, "share-2"), "server"), "ignored");
    calls.history = 0;
    assert.equal(store.applySnapshot(ticket, "share-2", [row(6)]), "reset");
    assert.deepEqual(store.getBoard().items.map((item) => item.id), [ID(6), ID(7)]);
    assert.equal(store.getBoard().shareId, "share-2");
  });

  it("returns stale for an older ticket and when the journal was pruned", () => {
    const { store } = setup();
    const older = store.beginSnapshot(), newer = store.beginSnapshot();
    assert.equal(store.applySnapshot(newer, SHARE, [row(1)]), "applied");
    assert.equal(store.applySnapshot(older, SHARE, []), "stale");
    assert.equal(store.getBoard().items.length, 1);
    const ticket = store.beginSnapshot();
    for (let i = 0; i <= JOURNAL_LIMIT; i++) store.applyOp(op({ op: "erase", ids: [ID(100 + i)] }), "server");
    assert.equal(store.applySnapshot(ticket, SHARE, []), "stale");
    assert.equal(store.getBoard().items.length, 1);
  });

  it("resets pending changes, history and other shares' drafts on a share change", () => {
    const { store } = setup();
    store.receiveDraft("bob", "Боря", draftPacket(ID(5)));
    store.batch(() => {
      store.mutatePending((p) => ({ ...p, adds: new Map([[ID(9), pendingRow(9)]]) }));
      store.mutateHistory((h) => pushHistory(h, { op: "add", ids: [ID(9)] }));
    });
    assert.equal(store.getHistory().canUndo, true);
    const ticket = store.beginSnapshot();
    assert.equal(store.applySnapshot(ticket, "share-2", []), "reset");
    assert.equal(store.pending(), EMPTY_PENDING);
    assert.equal(store.getHistory().canUndo, false);
    assert.equal(store.history(), EMPTY_HISTORY);
    store.setContext(context({ shareId: "share-2" }));
    assert.equal(store.getDrafts().items.length, 0);
  });

  it("keeps pending adds through a clear op and emits once per batch", () => {
    const { store, calls } = setup([row(1), row(2)]);
    store.batch(() => {
      store.mutatePending((p) => ({ ...p, adds: new Map([[ID(9), pendingRow(9)]]) }));
      store.mutateHistory((h) => pushHistory(h, { op: "add", ids: [ID(9)] }));
      store.applyOp(op({ op: "add", rows: [row(3)] }), "local");
    });
    assert.deepEqual(calls, { board: 1, drafts: 0, history: 1 });
    store.applyOp(op({ op: "clear", upToSeq: 2 }), "server");
    assert.deepEqual(store.getBoard().items.map((item) => [item.id, item.status]), [[ID(3), "saved"], [ID(9), "sending"]]);
  });

  it("hides drafts of a disconnected participant and sweeps expired drafts", () => {
    const { store, calls, tick } = setup();
    store.receiveDraft("bob", "Боря", draftPacket(ID(5)));
    store.receiveDraft("eve", "Ева", draftPacket(ID(6)));
    store.dropDraftsOf("bob");
    assert.deepEqual(store.getDrafts().items.map((item) => item.identity), ["eve"]);
    calls.drafts = 0;
    store.sweep();
    assert.equal(calls.drafts, 0);
    tick(4000);
    store.sweep();
    assert.equal(store.getDrafts().items.length, 0);
    assert.equal(calls.drafts, 1);
  });

  it("hides rows under a move preview and settles it when its author's move op lands", () => {
    const { store } = setup();
    store.receiveDraft("ann", "Аня", { v: 2, shareId: SHARE, strokeId: ID(7), seq: 1, phase: "end", kind: "pen", color: "#6de7d4", moveOf: ID(1), dx: 0.1, dy: 0 });
    assert.deepEqual([...store.getDrafts().hiddenIds], [ID(1)]);
    store.applyOp(op({ op: "move", rows: [row(1, { payload: JSON.stringify({ color: "#6de7d4", points: [[0.2, 0.1], [0.3, 0.1]] }) })] }, SHARE, "ann"), "server");
    assert.equal(store.getDrafts().items.length, 0);
    assert.equal(store.getDrafts().hiddenIds.size, 0);
  });

  it("resolves names from the context, then from rows and drafts", () => {
    const { store } = setup([row(1, { author_id: "zoe", author_name: "Зоя" })]);
    assert.equal(store.nameOf("zoe"), "Зоя");
    store.receiveDraft("bob", "Боря", draftPacket(ID(5)));
    assert.equal(store.nameOf("bob"), "Боря");
    store.setContext(context({ nameOf: (id) => id === "bob" ? "Борис" : undefined }));
    assert.equal(store.nameOf("bob"), "Борис");
    assert.equal(store.nameOf("nobody"), undefined);
  });
});

describe("createAnnotationStore: local ops after their server copy", () => {
  const moved = (n: number, x: number) => row(n, { payload: JSON.stringify({ color: "#6de7d4", points: [[x, x], [x / 2, x / 2]] }) });

  function storeWith(rows: Annotation[]) {
    const store = createAnnotationStore({ now: () => 0 });
    store.setContext({ shareId: SHARE, selfId: "ann", canAnnotate: () => true, canModerate: () => true, nameOf: () => undefined });
    store.applySnapshot(store.beginSnapshot(), SHARE, rows);
    return store;
  }

  it("skips what the server already delivered after `since`, so a response never undoes a newer op", () => {
    const store = storeWith([row(1)]);
    let since = store.serverCursor();
    store.applyOp(op({ op: "move", rows: [moved(1, 0.5)] }), "server");
    store.applyOp(op({ op: "move", rows: [moved(1, 0.7)] }, SHARE, "bob"), "server");
    assert.equal(store.applyOp(op({ op: "move", rows: [moved(1, 0.5)] }), "local", since), "ignored");
    assert.deepEqual(store.board().rows.get(ID(1))?.data.points, [[0.7, 0.7], [0.35, 0.35]]);

    since = store.serverCursor();
    store.applyOp(op({ op: "erase", ids: [ID(1)] }), "server");
    store.applyOp(op({ op: "restore", rows: [moved(1, 0.7)] }, SHARE, "bob"), "server");
    assert.equal(store.applyOp(op({ op: "erase", ids: [ID(1)] }), "local", since), "ignored");
    assert.deepEqual(ids(store.board()), [ID(1)]);

    since = store.serverCursor();
    store.applyOp(op({ op: "clear", upToSeq: 1 }), "server");
    store.applyOp(op({ op: "restore", rows: [moved(1, 0.7)] }, SHARE, "bob"), "server");
    assert.equal(store.applyOp(op({ op: "clear", upToSeq: 1 }), "local", since), "ignored");
    assert.deepEqual(ids(store.board()), [ID(1)]);
  });

  it("applies what has not arrived yet, even when an identical op arrived before `since`", () => {
    const store = storeWith([row(1), row(2), row(3)]);
    store.applyOp(op({ op: "erase", ids: [ID(1)] }), "server");
    store.applyOp(op({ op: "restore", rows: [row(1)] }), "server");
    const since = store.serverCursor();
    store.applyOp(op({ op: "erase", ids: [ID(3)] }), "server");
    assert.equal(store.applyOp(op({ op: "erase", ids: [ID(1), ID(2), ID(3)] }), "local", since), "ok");
    assert.deepEqual(ids(store.board()), []);
    assert.equal(store.applyOp(op({ op: "restore", rows: [row(2)] }), "local"), "ok", "without `since` a local op always applies");
    assert.deepEqual(ids(store.board()), [ID(2)]);
  });

  it("drops our pending copy once the server add lands, so a later erase cannot revive it", () => {
    const store = storeWith([]);
    store.mutatePending((p) => ({ ...p, adds: new Map([[ID(1), pendingRow(1)], [ID(2), pendingRow(2)]]) }));
    store.applyOp(op({ op: "add", rows: [row(1)] }), "server");
    store.applyOp(op({ op: "add", rows: [row(2, { author_id: "eve" })] }, SHARE, "eve"), "server");
    assert.deepEqual([...store.pending().adds.keys()], [ID(2)], "a row by someone else with our id leaves our copy alone");
    store.applyOp(op({ op: "erase", ids: [ID(1), ID(2)] }, SHARE, "host"), "server");
    assert.deepEqual(store.getBoard().items.map((item) => [item.id, item.status]), [[ID(2), "sending"]]);
  });
});

describe("contextFromState", () => {
  const state = {
    room: { id: "r", kind: "webinar", status: "open", activeShareId: SHARE, activeShareOwner: "owner", annotationsEnabled: true },
    members: [
      { id: "host", name: "Хост", role: "host", can_annotate: 0, raised_hand: 0, removed: 0 },
      { id: "owner", name: "Докладчик", role: "speaker", can_annotate: 0, raised_hand: 0, removed: 0 },
      { id: "viewer", name: "Зритель", role: "viewer", can_annotate: 0, raised_hand: 0, removed: 0 },
      { id: "allowed", name: "", role: "viewer", can_annotate: 1, raised_hand: 0, removed: 0 },
    ],
    messages: [], shareRequests: [], annotations: [], recording: null,
  } as RoomState;

  it("derives permissions and names from the room state", () => {
    const ctx = contextFromState(state, "viewer");
    assert.equal(ctx.shareId, SHARE);
    assert.equal(ctx.selfId, "viewer");
    assert.deepEqual(["host", "owner", "viewer", "allowed", "gone"].map((id) => ctx.canAnnotate(id)), [true, true, false, true, false]);
    assert.deepEqual(["host", "owner", "allowed"].map((id) => ctx.canModerate(id)), [true, true, false]);
    assert.equal(ctx.nameOf("owner"), "Докладчик");
    assert.equal(ctx.nameOf("allowed"), undefined);
    const none = contextFromState(null, "me");
    assert.deepEqual([none.shareId, none.selfId, none.canAnnotate("host")], [null, "me", false]);
  });
});
