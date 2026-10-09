import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, AnnotationOp, AnnotationPayload, DraftPacketV2, Point, RoomState } from "@/lib/confa-types";
import {
  createAnnotationClient, createMutationQueue, createSingleFlight, createStateRefresher, errorCodeOf, ERASE_FLUSH_MS, NOTICE_TEXT, REQUEST_TIMEOUT_MS,
  type AnnotationClient, type SyncNotice, type TransportResponse,
} from "./annotation-client.ts";
import { decodeJson, type TimerHost } from "./annotation-drafts.ts";
import { translateAnnotation } from "./annotation-geometry.ts";
import { createAnnotationStore, type AnnotationStore, type SnapshotTicket, type SyncContext } from "./annotation-sync.ts";
import { validatePatch } from "./annotation-validate.ts";

const SHARE = "share-1";
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const PEN: AnnotationPayload = { color: "#6de7d4", strokeWidth: 4, points: [[0.1, 0.1], [0.2, 0.2]] };

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

const settle = () => new Promise<void>((done) => setImmediate(done));

// In-memory stand-in for POST /annotations with the Stage 1 response shapes.
function fakeServer() {
  const rows = new Map<string, { row: Annotation; deleted: boolean }>();
  let seq = 0;
  const live = () => [...rows.values()].filter((item) => !item.deleted);
  const seed = (row: Annotation) => { rows.set(row.id, { row, deleted: false }); seq = Math.max(seq, row.seq); };
  const handle = (body: Record<string, unknown>): TransportResponse => {
    const targets = Array.isArray(body.targetIds) ? body.targetIds as string[] : [];
    switch (body.action) {
      case "add": {
        const id = body.id as string;
        const existing = rows.get(id);
        if (existing) return existing.deleted ? { status: 410, body: { error: "Пометку уже удалили", code: "gone" } } : { status: 200, body: { row: existing.row } };
        const row: Annotation = { id, author_id: "me", author_name: "Я", kind: body.kind as Annotation["kind"], payload: JSON.stringify(body.payload), created_at: 0, seq: ++seq };
        rows.set(id, { row, deleted: false });
        return { status: 201, body: { row } };
      }
      case "erase": {
        const deletedIds = targets.filter((id) => rows.get(id) && !rows.get(id)?.deleted);
        const alreadyDeletedIds = targets.filter((id) => rows.get(id)?.deleted);
        for (const id of deletedIds) (rows.get(id) as { deleted: boolean }).deleted = true;
        return { status: 200, body: { deletedIds, alreadyDeletedIds } };
      }
      case "restore": {
        for (const id of targets) { const item = rows.get(id); if (item) item.deleted = false; }
        return { status: 200, body: { rows: targets.flatMap((id) => rows.get(id) && !rows.get(id)?.deleted ? [rows.get(id)?.row as Annotation] : []) } };
      }
      case "move":
      case "edit": {
        const item = rows.get(body.targetId as string);
        if (!item || item.deleted) return { status: 404, body: { error: "Пометка не найдена", code: "gone" } };
        const data = JSON.parse(item.row.payload) as AnnotationPayload;
        if (body.action === "edit") {
          const checked = validatePatch(item.row.kind, data, body.patch);
          if ("error" in checked) return { status: 400, body: { error: checked.error, code: "invalid" } };
          item.row = { ...item.row, payload: checked.encoded };
          return { status: 200, body: { row: item.row } };
        }
        const moved = translateAnnotation(data, body.dx as number, body.dy as number);
        item.row = { ...item.row, payload: JSON.stringify(moved.payload) };
        return { status: 200, body: { row: item.row, dx: moved.dx, dy: moved.dy } };
      }
      case "clear":
      case "clearAuthor": {
        const cleared = live().filter((item) => body.action === "clear" || item.row.author_id === body.targetId);
        for (const item of cleared) item.deleted = true;
        const ids = cleared.map((item) => item.row.id);
        return { status: 200, body: body.action === "clear" ? { cleared: true, clearedIds: ids, upToSeq: Math.max(0, ...cleared.map((item) => item.row.seq)) } : { deletedIds: ids } };
      }
    }
    return { status: 400, body: { error: "Неизвестное действие", code: "invalid" } };
  };
  return { rows, seed, handle };
}

type Held = { body: Record<string, unknown>; resolve(response: TransportResponse): void; reject(error: unknown): void };

function setup(options: { rows?: Annotation[]; canAnnotate?: boolean } = {}) {
  const clock = fakeClock();
  const server = fakeServer();
  const store: AnnotationStore = createAnnotationStore({ now: clock.now });
  const ctx: SyncContext = { shareId: SHARE, selfId: "me", canAnnotate: () => options.canAnnotate ?? true, canModerate: () => true, nameOf: () => undefined };
  store.setContext(ctx);
  for (const row of options.rows ?? []) server.seed(row);
  store.applySnapshot(store.beginSnapshot(), SHARE, options.rows ?? []);
  const posts: Array<Record<string, unknown>> = [];
  const held: Held[] = [];
  const failures: Array<TransportResponse | "network" | "hang"> = [];
  let hold = false;
  const notices: SyncNotice[] = [];
  const packets: Array<{ packet: DraftPacketV2; reliable: boolean }> = [];
  let refreshes = 0;
  const client: AnnotationClient = createAnnotationClient({
    store,
    transport: {
      post(body) {
        posts.push(body);
        const failure = failures.shift();
        if (failure === "network") return Promise.reject(new TypeError("Failed to fetch"));
        if (failure === "hang") return new Promise<TransportResponse>(() => {});
        if (failure) return Promise.resolve(failure);
        if (hold) return new Promise<TransportResponse>((resolve, reject) => held.push({ body, resolve, reject }));
        return Promise.resolve(server.handle(body));
      },
    },
    publish: (data, reliable) => { packets.push({ packet: decodeJson(data) as DraftPacketV2, reliable }); },
    self: { id: "me", name: "Я" },
    shareIdOf: () => SHARE,
    timers: clock.host,
    now: clock.now,
    onNotice: (notice) => notices.push(notice),
    requestRefresh: () => { refreshes++; },
  });
  client.start();
  let emits = 0;
  store.subscribeBoard(() => { emits++; });
  return {
    clock, server, store, client, posts, held, failures, notices, packets,
    emits: () => emits,
    refreshes: () => refreshes,
    hold(value: boolean) { hold = value; },
    async release() {
      while (held.length) {
        const next = held.shift() as Held;
        next.resolve(server.handle(next.body));
        await settle();
      }
    },
    items: () => store.getBoard().items.map((item) => [item.id, item.status] as const),
    ids: () => store.getBoard().items.map((item) => item.id),
  };
}

// The op the server broadcasts for a request it answered with `response`.
function echoOf(body: Record<string, unknown>, response: TransportResponse): AnnotationOp {
  const head = { type: "annotations" as const, v: 1 as const, shareId: SHARE, by: "me" };
  const result = response.body as Record<string, unknown>;
  if (body.action === "erase") return { ...head, op: "erase", ids: result.deletedIds as string[] };
  if (body.action === "restore") return { ...head, op: "restore", rows: result.rows as Annotation[] };
  return { ...head, op: body.action as "add" | "move" | "edit", rows: [result.row as Annotation] };
}

function savedRow(n: number, over: Partial<Annotation> = {}): Annotation {
  return { id: ID(n), author_id: "me", author_name: "Я", kind: "pen", payload: JSON.stringify(PEN), created_at: 0, seq: n, ...over };
}

describe("errorCodeOf", () => {
  it("prefers the server code, then maps the status", () => {
    assert.equal(errorCodeOf(409, { code: "cap" }), "cap");
    assert.equal(errorCodeOf(409, { code: "share-changed" }), "share-changed");
    assert.equal(errorCodeOf(503, { code: "retry" }), "network");
    assert.deepEqual([0, 500, 403, 401, 404, 410, 409, 429, 400, 422].map((status) => errorCodeOf(status, {})), ["network", "network", "forbidden", "forbidden", "gone", "gone", "conflict", "rate", "invalid", "invalid"]);
  });
});

describe("add", () => {
  it("shows the mark synchronously and swaps to the saved row in one emit", async () => {
    const t = setup();
    t.hold(true);
    const done = t.client.add("pen", PEN, ID(1).toUpperCase());
    assert.deepEqual(t.items(), [[ID(1), "sending"]]);
    assert.equal(t.emits(), 1);
    assert.equal(t.store.getHistory().canUndo, true);
    await settle();
    assert.equal(t.posts.length, 1);
    assert.deepEqual({ ...t.posts[0], payload: undefined }, { action: "add", id: ID(1), kind: "pen", payload: undefined, shareId: SHARE });
    await t.release();
    assert.deepEqual(await done, { ok: true });
    assert.deepEqual(t.items(), [[ID(1), "saved"]]);
    assert.equal(t.emits(), 2, "exactly one emit for the swap");
    assert.equal(t.store.pending().adds.size, 0);
  });

  it("rolls back on cap, cancels the draft for peers and shows the notice", async () => {
    const t = setup();
    t.client.draft.begin({ id: ID(1), kind: "pen", color: "#6de7d4" }, t.clock.host);
    t.client.draft.update(ID(1), { points: [[0.1, 0.1], [0.2, 0.2]] });
    t.client.draft.end(ID(1), { points: [[0.1, 0.1], [0.2, 0.2]] });
    t.failures.push({ status: 409, body: { error: "На экране уже 500 пометок — очистите доску", code: "cap" } });
    const result = await t.client.add("pen", PEN, ID(1));
    assert.deepEqual(result, { ok: false, code: "cap", message: NOTICE_TEXT.cap });
    assert.deepEqual(t.items(), []);
    assert.equal(t.store.getHistory().canUndo, false);
    assert.deepEqual(t.notices, [{ tone: "error", code: "cap", text: NOTICE_TEXT.cap }]);
    assert.deepEqual(t.packets.map((item) => [item.packet.phase, item.reliable]), [["live", false], ["end", true], ["cancel", true]]);
    assert.equal(t.posts.length, 1, "cap is not retried");
  });

  it("retries network errors and 5xx with the same id, then succeeds", async () => {
    const t = setup();
    t.failures.push("network", { status: 503, body: { error: "Не удалось", code: "retry" } });
    const done = t.client.add("pen", PEN, ID(1));
    await settle();
    assert.equal(t.posts.length, 1);
    t.clock.advance(399);
    await settle();
    assert.equal(t.posts.length, 1);
    t.clock.advance(1);
    await settle();
    assert.equal(t.posts.length, 2);
    t.clock.advance(1200);
    await settle();
    assert.deepEqual(await done, { ok: true });
    assert.deepEqual(t.posts.map((body) => body.id), [ID(1), ID(1), ID(1)]);
    assert.deepEqual(t.items(), [[ID(1), "saved"]]);
  });

  it("gives up after the retries with a network notice", async () => {
    const t = setup();
    t.failures.push("network", "network", "network");
    const done = t.client.add("pen", PEN, ID(1));
    await settle();
    t.clock.advance(400);
    await settle();
    t.clock.advance(1200);
    await settle();
    const result = await done;
    assert.equal(result.ok, false);
    assert.equal(t.posts.length, 3);
    assert.deepEqual(t.notices.map((notice) => notice.text), [NOTICE_TEXT.network]);
    assert.deepEqual(t.items(), []);
  });

  it("times out a hanging request after REQUEST_TIMEOUT_MS and retries", async () => {
    const t = setup();
    t.failures.push("hang");
    const done = t.client.add("pen", PEN, ID(1));
    await settle();
    t.clock.advance(REQUEST_TIMEOUT_MS);
    await settle();
    t.clock.advance(400);
    await settle();
    assert.deepEqual(await done, { ok: true });
    assert.equal(t.posts.length, 2);
  });

  it("re-keys the pending mark, its history and later actions when the server assigns another id", async () => {
    const t = setup();
    t.client.draft.begin({ id: ID(1), kind: "pen", color: "#6de7d4" }, t.clock.host);
    t.client.draft.update(ID(1), { points: [[0.1, 0.1]] });
    t.client.draft.end(ID(1), { points: [[0.1, 0.1], [0.2, 0.2]] });
    t.hold(true);
    const done = t.client.add("pen", PEN, ID(1));
    t.client.erase([ID(1)], "g");
    await settle();
    const held = t.held.shift() as Held;
    const row = savedRow(7, { id: ID(77) });
    t.server.seed(row);
    held.resolve({ status: 200, body: { row } });
    assert.deepEqual(await done, { ok: true });
    assert.equal(t.packets.at(-1)?.packet.phase, "cancel");
    assert.equal(t.packets.at(-1)?.packet.strokeId, ID(1));
    assert.deepEqual(t.ids(), [], "still hidden by the pending erase under its new id");
    assert.ok(t.store.pending().erases.has(ID(77)));
    t.clock.advance(ERASE_FLUSH_MS);
    await settle();
    await t.release();
    assert.deepEqual(t.posts.at(-1), { action: "erase", targetIds: [ID(77)], shareId: SHARE });
    assert.equal(t.server.rows.get(ID(77))?.deleted, true);
    t.hold(false);
    assert.deepEqual(await t.client.undo(), { ok: true });
    assert.deepEqual(t.posts.at(-1), { action: "restore", targetIds: [ID(77)], shareId: SHARE });
    assert.deepEqual(t.ids(), [ID(77)]);
  });

  it("does not revive its own mark that someone erased between the server op and the response", async () => {
    const t = setup();
    t.hold(true);
    const done = t.client.add("pen", PEN, ID(1));
    await settle();
    const held = t.held.shift() as Held;
    const response = t.server.handle(held.body);
    t.store.applyOp(echoOf(held.body, response), "server");
    assert.deepEqual(t.items(), [[ID(1), "saved"]]);
    assert.equal(t.store.pending().adds.size, 0, "the saved row replaces the pending copy");
    t.store.applyOp({ type: "annotations", v: 1, shareId: SHARE, by: "host", op: "erase", ids: [ID(1)] }, "server");
    assert.deepEqual(t.items(), [], "no pending copy comes back as sending");
    held.resolve(response);
    assert.deepEqual(await done, { ok: true });
    assert.deepEqual(t.items(), [], "the late response does not undo the newer erase");
  });

  it("validates locally and never posts an invalid payload", async () => {
    const t = setup();
    const result = await t.client.add("pen", { color: "red", points: [] }, ID(1));
    assert.equal(result.ok, false);
    assert.equal(t.posts.length, 0);
    assert.equal(t.notices[0].code, "invalid");
  });

  it("treats share-changed and forbidden as quiet and info notices", async () => {
    const t = setup();
    t.failures.push({ status: 409, body: { error: "Демонстрация сменилась", code: "share-changed" } }, { status: 403, body: { error: "Ведущий не разрешил вам делать пометки", code: "forbidden" } });
    assert.equal((await t.client.add("pen", PEN, ID(1))).ok, false);
    assert.equal((await t.client.add("pen", PEN, ID(2))).ok, false);
    assert.deepEqual(t.notices, [{ tone: "info", code: "forbidden", text: "Ведущий не разрешил вам делать пометки" }]);
  });
});

describe("erase", () => {
  it("hides at once and sends one POST with the union of a gesture's hits", async () => {
    const t = setup({ rows: [savedRow(1), savedRow(2), savedRow(3), savedRow(4)] });
    t.client.erase([ID(1)], "g");
    assert.deepEqual(t.ids(), [ID(2), ID(3), ID(4)]);
    t.clock.advance(100);
    t.client.erase([ID(2), ID(1)], "g");
    t.clock.advance(100);
    t.client.erase([ID(3)], "g");
    await settle();
    assert.equal(t.posts.length, 0);
    t.clock.advance(ERASE_FLUSH_MS - 200);
    await settle();
    assert.deepEqual(t.posts, [{ action: "erase", targetIds: [ID(1), ID(2), ID(3)], shareId: SHARE }]);
    assert.deepEqual(t.ids(), [ID(4)]);
    assert.equal(t.store.pending().erases.size, 0);
    assert.equal(t.store.history().undo.length, 1, "one undo step per gesture");
  });

  it("brings back ids the server did not delete and narrows the history entry", async () => {
    const t = setup({ rows: [savedRow(1), savedRow(2), savedRow(3)] });
    t.failures.push({ status: 200, body: { deletedIds: [ID(1)], alreadyDeletedIds: [ID(3)] } });
    t.client.erase([ID(1), ID(2), ID(3)], "g");
    assert.equal((await t.client.flushErase()).ok, true);
    assert.deepEqual(t.ids(), [ID(2)], "not deleted (someone else's) comes back; already deleted stays gone");
    const [entry] = t.store.history().undo;
    assert.ok(entry.op === "erase");
    assert.deepEqual(entry.ids, [ID(1)], "a first attempt does not claim ids someone else erased");
  });

  it("counts alreadyDeletedIds as erased on a retried request", async () => {
    const t = setup({ rows: [savedRow(1), savedRow(2)] });
    t.failures.push("network", { status: 200, body: { deletedIds: [ID(2)], alreadyDeletedIds: [ID(1)] } });
    t.client.erase([ID(1), ID(2)], "g");
    const done = t.client.flushErase();
    await settle();
    t.clock.advance(400);
    assert.deepEqual(await done, { ok: true });
    assert.equal(t.posts.length, 2);
    const [entry] = t.store.history().undo;
    assert.ok(entry.op === "erase");
    assert.deepEqual(entry.ids, [ID(1), ID(2)]);
    assert.deepEqual(t.ids(), []);
  });

  it("posts an erase of a pending mark only after its add resolves", async () => {
    const t = setup();
    t.hold(true);
    const added = t.client.add("pen", PEN, ID(1));
    t.client.erase([ID(1)], "g");
    const erased = t.client.flushErase();
    assert.deepEqual(t.ids(), []);
    await settle();
    assert.deepEqual(t.posts.map((body) => body.action), ["add"]);
    await t.release();
    await added;
    await settle();
    assert.deepEqual(t.posts.map((body) => body.action), ["add", "erase"]);
    await t.release();
    assert.deepEqual(await erased, { ok: true });
    assert.deepEqual(t.ids(), []);
    assert.equal(t.server.rows.get(ID(1))?.deleted, true);
  });

  it("restores the marks when the erase fails", async () => {
    const t = setup({ rows: [savedRow(1)] });
    t.failures.push({ status: 403, body: { error: "Ведущий не разрешил вам делать пометки", code: "forbidden" } });
    t.client.erase([ID(1)], "g");
    const result = await t.client.flushErase();
    assert.equal(result.ok, false);
    assert.deepEqual(t.ids(), [ID(1)]);
    assert.equal(t.store.getHistory().canUndo, false);
  });
});

describe("undo and redo", () => {
  it("undo right after drawing posts the add, then the erase; redo restores the same id", async () => {
    const t = setup();
    t.hold(true);
    const added = t.client.add("pen", PEN, ID(1));
    const undone = t.client.undo();
    assert.deepEqual(t.ids(), [], "hidden at once");
    await settle();
    assert.deepEqual(t.posts.map((body) => body.action), ["add"]);
    await t.release();
    await added;
    await settle();
    await t.release();
    assert.deepEqual(await undone, { ok: true });
    assert.deepEqual(t.posts.map((body) => body.action), ["add", "erase"]);
    assert.deepEqual(t.store.getHistory(), { canUndo: false, canRedo: true });
    t.hold(false);
    assert.deepEqual(await t.client.redo(), { ok: true });
    assert.deepEqual(t.posts.at(-1), { action: "restore", targetIds: [ID(1)], shareId: SHARE });
    assert.deepEqual(t.items(), [[ID(1), "saved"]]);
    assert.deepEqual(t.store.getHistory(), { canUndo: true, canRedo: false });
  });

  it("returns gone when the undo changes nothing", async () => {
    const t = setup();
    await t.client.add("pen", PEN, ID(1));
    (t.server.rows.get(ID(1)) as { deleted: boolean }).deleted = true;
    const result = await t.client.undo();
    assert.deepEqual(result, { ok: false, code: "gone", message: NOTICE_TEXT.gone });
    assert.equal(t.notices.length, 0, "gone is left to the caller");
    assert.deepEqual(t.store.getHistory(), { canUndo: false, canRedo: false });
  });

  it("is a no-op on an empty stack and a new action clears redo", async () => {
    const t = setup();
    assert.deepEqual(await t.client.undo(), { ok: true });
    await t.client.add("pen", PEN, ID(1));
    await t.client.undo();
    assert.equal(t.store.getHistory().canRedo, true);
    await t.client.add("pen", PEN, ID(2));
    assert.equal(t.store.getHistory().canRedo, false);
  });

  it("undoes an erase from the stored rows optimistically", async () => {
    const t = setup({ rows: [savedRow(1)] });
    t.client.erase([ID(1)], "g");
    await t.client.flushErase();
    t.hold(true);
    const undone = t.client.undo();
    assert.deepEqual(t.items(), [[ID(1), "sending"]]);
    await settle();
    await t.release();
    assert.deepEqual(await undone, { ok: true });
    assert.deepEqual(t.items(), [[ID(1), "saved"]]);
  });

  it("waits for a buffered erase before undoing it, so marks someone else erased stay erased", async () => {
    const t = setup({ rows: [savedRow(1), savedRow(2)] });
    t.failures.push({ status: 200, body: { deletedIds: [ID(1)], alreadyDeletedIds: [ID(2)] } });
    t.client.erase([ID(1), ID(2)], "g");
    assert.deepEqual(await t.client.undo(), { ok: true });
    assert.deepEqual(t.posts.map((body) => body.action), ["erase", "restore"]);
    assert.deepEqual(t.posts[1].targetIds, [ID(1)]);
    assert.deepEqual(t.ids(), [ID(1)]);
  });

  it("applies its own response when the server op is late, after earlier rounds whose ops were on time", async () => {
    const t = setup({ rows: [savedRow(1)] });
    const answer = async (echo: boolean) => {
      await settle();
      const held = t.held.shift() as Held;
      const response = t.server.handle(held.body);
      if (echo) t.store.applyOp(echoOf(held.body, response), "server");
      held.resolve(response);
      await settle();
    };
    t.hold(true);
    t.client.erase([ID(1)], "g");
    const erased = t.client.flushErase();
    await answer(true);
    assert.deepEqual(await erased, { ok: true });
    const undone = t.client.undo();
    await answer(true);
    assert.deepEqual(await undone, { ok: true });
    assert.deepEqual(t.ids(), [ID(1)]);
    const redone = t.client.redo();
    await answer(false);
    assert.deepEqual(await redone, { ok: true });
    assert.deepEqual(t.ids(), [], "the erase applies although an erase of the same id was seen in the first round");
  });

  it("drops a failed undo or redo when a new action was recorded meanwhile", async () => {
    const t = setup();
    await t.client.add("pen", PEN, ID(1));
    await t.client.add("pen", PEN, ID(2));
    const rate = { status: 429, body: { error: "Слишком много пометок подряд", code: "rate" } };
    t.hold(true);
    const undone = t.client.undo();
    await settle();
    t.hold(false);
    await t.client.add("pen", PEN, ID(3));
    (t.held.shift() as Held).resolve(rate);
    assert.equal((await undone).ok, false);
    assert.deepEqual(t.store.history().undo.map((entry) => entry.op === "add" && entry.ids), [[ID(1)], [ID(3)]], "the newer action stays on top");
    await t.client.undo();
    assert.deepEqual(t.posts.at(-1), { action: "erase", targetIds: [ID(3)], shareId: SHARE });

    await t.client.undo();
    assert.equal(t.store.getHistory().canRedo, true);
    t.hold(true);
    const redone = t.client.redo();
    await settle();
    t.hold(false);
    await t.client.add("pen", PEN, ID(4));
    (t.held.shift() as Held).resolve(rate);
    assert.equal((await redone).ok, false);
    assert.equal(t.store.getHistory().canRedo, false, "redo stays cleared by the new action");
  });

  it("puts the entry back after a network failure", async () => {
    const t = setup();
    await t.client.add("pen", PEN, ID(1));
    t.failures.push("network", "network", "network");
    const undone = t.client.undo();
    await settle();
    t.clock.advance(400);
    await settle();
    t.clock.advance(1200);
    const result = await undone;
    assert.equal(result.ok, false);
    assert.equal(t.store.getHistory().canUndo, true);
    assert.deepEqual(t.ids(), [ID(1)]);
  });
});

describe("move and edit", () => {
  it("moves optimistically, then applies the server row and its clamped delta", async () => {
    const t = setup({ rows: [savedRow(1)] });
    t.hold(true);
    const moving = t.client.move(ID(1), 0.9, 0.05);
    const [item] = t.store.getBoard().items;
    assert.equal(item.status, "moving");
    assert.deepEqual(item.data.points, [[0.9, 0.15], [1, 0.25]]);
    await settle();
    assert.deepEqual(t.posts[0], { action: "move", targetId: ID(1), dx: 0.8, dy: 0.05, shareId: SHARE });
    await t.release();
    assert.deepEqual(await moving, { ok: true });
    assert.deepEqual(t.items(), [[ID(1), "saved"]]);
    assert.deepEqual(t.store.getBoard().items[0].data.points, [[0.9, 0.15], [1, 0.25]]);
    t.hold(false);
    await t.client.undo();
    assert.deepEqual(t.posts.at(-1), { action: "move", targetId: ID(1), dx: -0.8, dy: -0.05, shareId: SHARE });
    assert.deepEqual(t.store.getBoard().items[0].data.points, [[0.1, 0.1], [0.2, 0.2]]);
  });

  it("rolls back a conflicting move, cancels its preview and asks for a refresh", async () => {
    const t = setup({ rows: [savedRow(1)] });
    t.client.draft.begin({ id: ID(9), kind: "pen", color: "#6de7d4", moveOf: ID(1) }, t.clock.host);
    t.client.draft.update(ID(9), { dx: 0.1, dy: 0 });
    t.client.draft.end(ID(9), { dx: 0.1, dy: 0 });
    t.failures.push({ status: 409, body: { error: "Пометку только что изменили — попробуйте ещё раз", code: "conflict" } });
    const result = await t.client.move(ID(1), 0.1, 0, ID(9));
    assert.equal(result.ok, false);
    assert.deepEqual(t.store.getBoard().items[0].data.points, [[0.1, 0.1], [0.2, 0.2]]);
    assert.equal(t.store.getHistory().canUndo, false);
    assert.equal(t.packets.at(-1)?.packet.phase, "cancel");
    assert.equal(t.refreshes(), 1);
    assert.deepEqual(t.notices.map((notice) => notice.text), [NOTICE_TEXT.conflict]);
    assert.equal(t.posts.length, 1, "move is never retried");
  });

  it("edits optimistically and undo sends the previous values", async () => {
    const text = savedRow(1, { kind: "text", payload: JSON.stringify({ color: "#6de7d4", point: [0.1, 0.1], text: "Было", lines: ["Было"], fontSize: 26 }) });
    const t = setup({ rows: [text] });
    t.hold(true);
    const editing = t.client.edit(ID(1), { text: "Стало", lines: ["Стало"], point: [0.5, 0.5] as Point });
    const [item] = t.store.getBoard().items;
    assert.equal(item.status, "editing");
    assert.equal(item.data.text, "Стало");
    assert.deepEqual(item.data.point, [0.1, 0.1], "point is never patched");
    await settle();
    assert.deepEqual(t.posts[0], { action: "edit", targetId: ID(1), patch: { text: "Стало", lines: ["Стало"] }, shareId: SHARE });
    await t.release();
    assert.deepEqual(await editing, { ok: true });
    t.hold(false);
    await t.client.undo();
    assert.deepEqual(t.posts.at(-1), { action: "edit", targetId: ID(1), patch: { text: "Было", lines: ["Было"] }, shareId: SHARE });
    assert.equal(t.store.getBoard().items[0].data.text, "Было");
    await t.client.redo();
    assert.equal(t.store.getBoard().items[0].data.text, "Стало");
  });
});

describe("edit undo of added keys", () => {
  it("undo removes keys the edit added (sent as null) and redo puts them back", async () => {
    const legacy = { color: "#ffffff", point: [0.1, 0.1] as Point, text: "a" };
    const t = setup({ rows: [savedRow(1, { kind: "text", payload: JSON.stringify(legacy) })] });
    const grown = { text: "bb", lines: ["bb"], fontSize: 40, w: 0.2, h: 0.1 };
    assert.deepEqual(await t.client.edit(ID(1), grown), { ok: true });
    assert.deepEqual(await t.client.undo(), { ok: true });
    assert.deepEqual(t.posts.at(-1), { action: "edit", targetId: ID(1), patch: { text: "a", lines: null, fontSize: null, w: null, h: null }, shareId: SHARE });
    assert.deepEqual(t.store.getBoard().items[0].data, legacy);
    assert.deepEqual(JSON.parse(t.server.rows.get(ID(1))?.row.payload ?? "null"), legacy);
    assert.deepEqual(await t.client.redo(), { ok: true });
    assert.deepEqual(t.posts.at(-1)?.patch, grown);
    assert.deepEqual(t.store.getBoard().items[0].data, { ...legacy, ...grown });
  });

  it("undoes a width set on a row that had none", async () => {
    const legacy = { color: "#6de7d4", points: [[0.1, 0.1], [0.2, 0.2]] as Point[] };
    const t = setup({ rows: [savedRow(1, { payload: JSON.stringify(legacy) })] });
    assert.deepEqual(await t.client.edit(ID(1), { strokeWidth: 8 }), { ok: true });
    assert.deepEqual(await t.client.undo(), { ok: true });
    assert.deepEqual(t.store.getBoard().items[0].data, legacy);
    assert.deepEqual(t.store.getHistory(), { canUndo: false, canRedo: true });
    assert.equal(t.notices.length, 0);
  });
});

describe("clear and clearAuthor", () => {
  it("waits for in-flight writes, hides optimistically and undoes through restore", async () => {
    const t = setup({ rows: [savedRow(1), savedRow(2)] });
    t.hold(true);
    const added = t.client.add("pen", PEN, ID(3));
    const cleared = t.client.clear();
    assert.deepEqual(t.items(), [[ID(3), "sending"]], "saved marks hidden at once");
    await settle();
    assert.deepEqual(t.posts.map((body) => body.action), ["add"], "clear waits for the add");
    await t.release();
    await added;
    await settle();
    await t.release();
    assert.deepEqual(await cleared, { ok: true });
    assert.deepEqual(t.posts.map((body) => body.action), ["add", "clear"]);
    assert.deepEqual(t.ids(), []);
    assert.equal(t.store.pending().clearUpTo, null);
    t.hold(false);
    assert.deepEqual(await t.client.undo(), { ok: true });
    assert.deepEqual(t.posts.at(-1), { action: "restore", targetIds: [ID(1), ID(2), ID(3)], shareId: SHARE });
    assert.deepEqual(t.ids(), [ID(1), ID(2), ID(3)]);
  });

  it("shows the marks again when clear fails", async () => {
    const t = setup({ rows: [savedRow(1)] });
    t.failures.push({ status: 403, body: { error: "Очистить пометки может ведущий или докладчик", code: "forbidden" } });
    const result = await t.client.clear();
    assert.deepEqual(result, { ok: false, code: "forbidden", message: "Очистить пометки может ведущий или докладчик" });
    assert.deepEqual(t.ids(), [ID(1)]);
    assert.equal(t.store.getHistory().canUndo, false);
  });

  it("erases one author's marks as an undoable erase", async () => {
    const t = setup({ rows: [savedRow(1, { author_id: "bob" }), savedRow(2), savedRow(3, { author_id: "bob" })] });
    const done = t.client.clearAuthor("bob");
    assert.deepEqual(t.ids(), [ID(2)]);
    assert.deepEqual(await done, { ok: true });
    assert.deepEqual(t.posts[0], { action: "clearAuthor", targetId: "bob", shareId: SHARE });
    const [entry] = t.store.history().undo;
    assert.ok(entry.op === "erase");
    assert.deepEqual(entry.ids, [ID(1), ID(3)]);
    await t.client.undo();
    assert.deepEqual(t.ids(), [ID(1), ID(2), ID(3)]);
  });
});

describe("lifecycle", () => {
  it("stop flushes buffered erases and cancels live drafts; start/stop are idempotent", async () => {
    const t = setup({ rows: [savedRow(1)] });
    t.client.draft.begin({ id: ID(5), kind: "pen", color: "#6de7d4" }, t.clock.host);
    t.client.draft.update(ID(5), { points: [[0.1, 0.1]] });
    t.client.erase([ID(1)], "g");
    t.client.stop();
    t.client.stop();
    await settle();
    assert.deepEqual(t.posts.map((body) => body.action), ["erase"]);
    assert.equal(t.packets.at(-1)?.packet.phase, "cancel");
    t.client.start();
    t.client.start();
  });

  it("does not send drafts without permission", () => {
    const t = setup({ canAnnotate: false });
    t.client.draft.begin({ id: ID(5), kind: "pen", color: "#6de7d4" }, t.clock.host);
    t.client.draft.update(ID(5), { points: [[0.1, 0.1]] });
    assert.equal(t.packets.length, 0);
  });
});

describe("createMutationQueue", () => {
  it("orders tasks per key, runs other keys in parallel and treats * as a barrier", async () => {
    const queue = createMutationQueue();
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const task = (name: string) => () => new Promise<string>((resolve) => {
      log.push(`start ${name}`);
      gates.set(name, () => { log.push(`end ${name}`); resolve(name); });
    });
    const a1 = queue.run(["a"], task("a1"));
    const a2 = queue.run(["a"], task("a2"));
    void queue.run(["b"], task("b1"));
    const all = queue.run("*", task("all"));
    const after = queue.run(["c"], task("c1"));
    await settle();
    assert.deepEqual(log, ["start a1", "start b1"]);
    gates.get("a1")?.();
    assert.equal(await a1, "a1");
    await settle();
    assert.deepEqual(log.slice(2), ["end a1", "start a2"]);
    gates.get("a2")?.();
    await a2;
    await settle();
    assert.ok(!log.includes("start all"), "the barrier waits for b1");
    gates.get("b1")?.();
    await settle();
    assert.equal(log.at(-1), "start all");
    gates.get("all")?.();
    await all;
    await settle();
    assert.equal(log.at(-1), "start c1");
    gates.get("c1")?.();
    assert.equal(await after, "c1");
  });

  it("keeps going after a failed task", async () => {
    const queue = createMutationQueue();
    const failed = queue.run(["a"], () => Promise.reject(new Error("boom")));
    await assert.rejects(failed);
    assert.equal(await queue.run(["a"], async () => 1), 1);
  });
});

describe("createSingleFlight", () => {
  it("collapses concurrent calls: 5 calls → 2 runs, ≥ minInterval apart, each resolved by a later-started run", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const finishers: Array<() => void> = [];
    const flight = createSingleFlight(() => new Promise<void>((resolve) => { starts.push(clock.now()); finishers.push(resolve); }), { minIntervalMs: 250, now: clock.now, timers: clock.host });
    const resolved: number[] = [];
    const calls = [0, 1, 2, 3, 4].map((index) => flight.run().then(() => { resolved.push(index); }));
    assert.deepEqual(starts, [0]);
    clock.advance(100);
    finishers[0]();
    await settle();
    assert.deepEqual(resolved, [0], "only the first call is covered by the first run");
    assert.deepEqual(starts, [0], "the trailing run waits for the interval");
    clock.advance(150);
    await settle();
    assert.deepEqual(starts, [0, 250]);
    finishers[1]();
    await Promise.all(calls);
    assert.deepEqual(resolved, [0, 1, 2, 3, 4]);
    assert.equal(starts.length, 2);
  });

  it("swallows task errors", async () => {
    const clock = fakeClock();
    const flight = createSingleFlight(() => Promise.reject(new Error("offline")), { minIntervalMs: 0, now: clock.now, timers: clock.host });
    await flight.run();
  });
});

describe("createStateRefresher", () => {
  function state(annotations: Annotation[] = []): RoomState {
    return { room: { id: "r", kind: "meeting", status: "open", activeShareId: SHARE, activeShareOwner: "me", annotationsEnabled: true }, members: [], messages: [], shareRequests: [], annotations, recording: null };
  }

  it("applies each response through a snapshot ticket taken before the fetch", async () => {
    const clock = fakeClock();
    const store = createAnnotationStore({ now: clock.now });
    let respond: (value: RoomState) => void = () => {};
    const seen: RoomState[] = [];
    const refresher = createStateRefresher({ fetchState: () => new Promise((resolve) => { respond = resolve; }), sync: store, onState: (next) => seen.push(next), onError: () => {}, timers: clock.host, now: clock.now });
    const done = refresher.run();
    store.applyOp({ type: "annotations", v: 1, shareId: SHARE, by: "bob", op: "erase", ids: [ID(1)] }, "server");
    respond(state([savedRow(1), savedRow(2)]));
    await done;
    assert.deepEqual(store.getBoard().items.map((item) => item.id), [ID(2)], "the erase that raced the request is replayed");
    assert.equal(seen.length, 1);
  });

  it("aborts a stalled request after the timeout, so later runs fetch again and a late answer is ignored", async () => {
    const clock = fakeClock();
    const store = createAnnotationStore({ now: clock.now });
    const signals: Array<AbortSignal | undefined> = [];
    const errors: unknown[] = [];
    const seen: RoomState[] = [];
    let released = 0;
    let late: (value: RoomState) => void = () => {};
    const refresher = createStateRefresher({
      fetchState: (signal) => {
        signals.push(signal);
        return signals.length === 1 ? new Promise<RoomState>((resolve) => { late = resolve; }) : Promise.resolve(state([savedRow(2)]));
      },
      sync: { beginSnapshot: store.beginSnapshot, releaseSnapshot: (ticket) => { released++; store.releaseSnapshot(ticket); }, applySnapshot: store.applySnapshot },
      onState: (next) => seen.push(next), onError: (error) => errors.push(error), timers: clock.host, now: clock.now,
    });
    const first = refresher.run();
    const second = refresher.run();
    await settle();
    clock.advance(REQUEST_TIMEOUT_MS - 1);
    await settle();
    assert.equal(signals.length, 1, "later runs wait for the running one");
    clock.advance(1);
    await first;
    assert.equal(signals[0]?.aborted, true);
    assert.deepEqual(errors.map((error) => (error as Error).message), ["Не удалось обновить комнату"]);
    assert.equal(released, 1);
    await second;
    assert.equal(signals.length, 2);
    assert.deepEqual(store.getBoard().items.map((item) => item.id), [ID(2)]);
    late(state([savedRow(1)]));
    await settle();
    assert.equal(seen.length, 1);
    assert.deepEqual(store.getBoard().items.map((item) => item.id), [ID(2)]);
  });

  it("releases the ticket on errors and reruns after a stale snapshot", async () => {
    const clock = fakeClock();
    const tickets: SnapshotTicket[] = [];
    let released = 0, fetches = 0;
    const errors: unknown[] = [];
    let result: "applied" | "stale" | "reset" = "stale";
    const sync = {
      beginSnapshot: () => { const ticket = { id: tickets.length + 1, journalIndex: 0 }; tickets.push(ticket); return ticket; },
      releaseSnapshot: () => { released++; },
      applySnapshot: () => { const current = result; result = "applied"; return current; },
    };
    let fail = true;
    const refresher = createStateRefresher({
      fetchState: async () => { fetches++; if (fail) { fail = false; throw new Error("offline"); } return state(); },
      sync, onState: () => {}, onError: (error) => errors.push(error), timers: clock.host, now: clock.now,
    });
    await refresher.run();
    assert.equal(released, 1);
    assert.equal(errors.length, 1);
    clock.advance(250);
    await refresher.run();
    await settle();
    clock.advance(250);
    await settle();
    await settle();
    assert.equal(fetches, 3, "a stale snapshot triggers one more fetch");
    assert.equal(tickets.length, 3);
  });
});
