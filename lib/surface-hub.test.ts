import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, AnnotationOp, DraftPacketV2 } from "@/lib/confa-types";
import type { TransportResponse } from "./annotation-client.ts";
import type { SyncContext } from "./annotation-sync.ts";
import { fakeClock } from "./fake-clock.ts";
import { createSurfaceHub, SURFACE_BATCH_MS, SURFACES_PER_REQUEST, type SurfaceAnswer, type SurfaceQuery } from "./surface-hub.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const band = (n: number) => `b:${WS}:${n}`;
const page = (n: number) => `d:22222222-2222-4222-8222-222222222222:${n}`;
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const settle = () => new Promise<void>((done) => setImmediate(done));
const pen = { color: "#000000", points: [[0.1, 0.1], [0.2, 0.3]] as [number, number][], strokeWidth: 4 };

function row(n: number, over: Partial<Annotation> = {}): Annotation {
  return { id: ID(n), author_id: "ann", author_name: "Аня", kind: "pen", payload: JSON.stringify({ color: "#000000", points: [[0.1, 0.1], [0.2, n / 1000]] }), created_at: n, seq: n, ...over };
}

function op(shareId: string, body: Record<string, unknown>, rev?: number): AnnotationOp {
  return { type: "annotations", v: 1, shareId, by: "ann", ...(rev === undefined ? {} : { rev }), ...body } as AnnotationOp;
}

// A server for both transports: rows and a revision per surface.
function fakeServer() {
  const surfaces = new Map<string, { rev: number; rows: Map<string, Annotation> }>();
  const queries: SurfaceQuery[][] = [];
  let seq = 100;
  const of = (id: string) => {
    let surface = surfaces.get(id);
    if (!surface) surfaces.set(id, surface = { rev: 0, rows: new Map() });
    return surface;
  };
  return {
    queries,
    of,
    seed(id: string, ...rows: Annotation[]) {
      const surface = of(id);
      for (const item of rows) surface.rows.set(item.id, item);
      surface.rev++;
    },
    async fetch(query: readonly SurfaceQuery[]): Promise<Record<string, SurfaceAnswer>> {
      queries.push([...query]);
      const answers: Record<string, SurfaceAnswer> = {};
      for (const { id, rev } of query) {
        const surface = of(id);
        answers[id] = rev === surface.rev ? { rev: surface.rev } : { rev: surface.rev, rows: [...surface.rows.values()].sort((a, b) => a.seq - b.seq) };
      }
      return answers;
    },
    async post(body: Record<string, unknown>): Promise<TransportResponse> {
      const surface = of(body.shareId as string);
      if (body.action === "add") {
        const added: Annotation = { id: body.id as string, author_id: "me", author_name: "Я", kind: "pen", payload: JSON.stringify(body.payload), created_at: 0, seq: ++seq };
        surface.rows.set(added.id, added);
        surface.rev++;
        return { status: 201, body: { row: added } };
      }
      if (body.action === "erase") {
        const ids = (body.targetIds as string[]).filter((id) => surface.rows.delete(id));
        surface.rev++;
        return { status: 200, body: { deletedIds: ids, alreadyDeletedIds: [] } };
      }
      if (body.action === "restore") return { status: 200, body: { rows: [] } };
      return { status: 400, body: { code: "invalid" } };
    },
  };
}

function setup(over: { self?: { id: string; name: string } | null; cacheSize?: number; canAnnotate?: boolean } = {}) {
  const clock = fakeClock();
  const server = fakeServer();
  const published: Array<{ packet: DraftPacketV2; reliable: boolean }> = [];
  const errors: unknown[] = [];
  let allowed = over.canAnnotate ?? true;
  const contextOf = (shareId: string): SyncContext => ({ shareId, selfId: "me", canAnnotate: () => allowed, canModerate: () => false, nameOf: () => undefined });
  const hub = createSurfaceHub({
    self: over.self === undefined ? { id: "me", name: "Я" } : over.self,
    now: clock.now, timers: clock.host,
    publish: (data, reliable) => { published.push({ packet: JSON.parse(new TextDecoder().decode(data)) as DraftPacketV2, reliable }); },
    post: (body) => server.post(body),
    fetchSurfaces: (query) => server.fetch(query),
    contextOf,
    onError: (error) => errors.push(error),
    cacheSize: over.cacheSize,
  });
  // Lets pending reads run: the batch an acquire schedules, and the single flight's minimum interval.
  const read = async () => {
    for (let round = 0; round < 3; round++) {
      clock.advance(Math.max(SURFACE_BATCH_MS, 2500));
      await settle();
      await settle();
    }
  };
  const refresh = async () => {
    const done = hub.refresh();
    await read();
    await done;
  };
  return { clock, server, hub, published, errors, read, refresh, allow: (value: boolean) => { allowed = value; } };
}

const ids = (hub: ReturnType<typeof setup>["hub"], id: string) => hub.surface(id).store.getBoard().items.map((item) => item.id);

describe("surface hub: stores and reads", () => {
  it("a new surface is named and drawable at once, and its rows arrive with the batched read", async () => {
    const { hub, server, read } = setup();
    server.seed(band(0), row(1), row(2));
    server.seed(band(1), row(3));
    const first = hub.surface(band(0));
    assert.equal(first.store.getBoard().shareId, band(0));
    assert.equal(first.store.getBoard().items.length, 0);
    assert.equal(hub.surface(band(0)), first, "one store per surface");
    hub.acquire(band(0));
    hub.acquire(band(1));
    assert.equal(server.queries.length, 0, "tiles that mount together are read together");
    await read();
    assert.equal(server.queries.length, 1);
    assert.deepEqual(server.queries[0], [{ id: band(0), rev: -1 }, { id: band(1), rev: -1 }]);
    assert.deepEqual(ids(hub, band(0)), [ID(1), ID(2)]);
    assert.deepEqual(ids(hub, band(1)), [ID(3)]);
  });

  it("a read skips surfaces whose revision did not move", async () => {
    const { hub, server, read, refresh } = setup();
    server.seed(band(0), row(1));
    hub.acquire(band(0));
    await read();
    await refresh();
    assert.deepEqual(server.queries[1], [{ id: band(0), rev: 1 }]);
    assert.deepEqual(ids(hub, band(0)), [ID(1)], "an answer without rows changes nothing");
    server.seed(band(0), row(2));
    await refresh();
    assert.deepEqual(ids(hub, band(0)), [ID(1), ID(2)]);
  });

  it("only surfaces on screen are read; a released one keeps its store and is read again when it returns", async () => {
    const { hub, server, read, refresh } = setup();
    server.seed(band(0), row(1));
    const release = hub.acquire(band(0));
    await read();
    release();
    release();
    server.seed(band(0), row(2));
    await refresh();
    assert.equal(server.queries.length, 1, "nothing on screen: no request");
    assert.deepEqual(ids(hub, band(0)), [ID(1)]);
    hub.acquire(band(0));
    await read();
    assert.deepEqual(ids(hub, band(0)), [ID(1), ID(2)]);
  });

  it("splits a large screenful into several requests", async () => {
    const { hub, server, read } = setup();
    for (let n = 0; n < SURFACES_PER_REQUEST + 3; n++) hub.acquire(band(n));
    await read();
    assert.deepEqual(server.queries.map((query) => query.length), [SURFACES_PER_REQUEST, 3]);
  });

  it("a failed read releases its tickets, reports the error and the next one works", async () => {
    const { hub, server, errors, read, refresh } = setup();
    server.seed(band(0), row(1));
    const original = server.fetch.bind(server);
    let fail = true;
    server.fetch = async (query) => {
      if (fail) { fail = false; throw new Error("offline"); }
      return original(query);
    };
    hub.acquire(band(0));
    await read();
    assert.equal(errors.length, 1);
    assert.deepEqual(ids(hub, band(0)), []);
    await refresh();
    assert.deepEqual(ids(hub, band(0)), [ID(1)]);
  });

  it("an op that raced the read is replayed over the rows", async () => {
    const { hub, server, clock } = setup();
    server.seed(band(0), row(1), row(2));
    let respond: (answers: Record<string, SurfaceAnswer>) => void = () => {};
    const original = server.fetch.bind(server);
    server.fetch = (query) => new Promise((resolve) => { respond = () => void original(query).then(resolve); });
    hub.acquire(band(0));
    clock.advance(SURFACE_BATCH_MS);
    await settle();
    hub.receiveOp(op(band(0), { op: "erase", ids: [ID(1)] }));
    respond({});
    await settle();
    await settle();
    await settle();
    assert.deepEqual(ids(hub, band(0)), [ID(2)]);
  });
});

describe("surface hub: routing", () => {
  it("routes server ops by share id and ignores surfaces it does not hold", async () => {
    const { hub, read } = setup();
    hub.acquire(band(0));
    hub.acquire(page(4));
    await read();
    hub.receiveOp(op(band(0), { op: "add", rows: [row(1)] }));
    hub.receiveOp(op(page(4), { op: "add", rows: [row(2)] }));
    hub.receiveOp(op(band(9), { op: "add", rows: [row(3)] }));
    hub.receiveOp({ type: "state-changed" });
    hub.receiveOp(null);
    assert.deepEqual(ids(hub, band(0)), [ID(1)]);
    assert.deepEqual(ids(hub, page(4)), [ID(2)]);
  });

  it("an op in step with the revision saves the next read; a gap makes it read again", async () => {
    const { hub, server, read, refresh } = setup();
    server.seed(band(0), row(1));
    hub.acquire(band(0));
    await read();
    server.of(band(0)).rows.set(ID(2), row(2));
    server.of(band(0)).rev = 2;
    hub.receiveOp(op(band(0), { op: "add", rows: [row(2)] }, 2));
    await refresh();
    assert.deepEqual(server.queries[1], [{ id: band(0), rev: 2 }], "the hub knows revision 2 from the op");
    server.of(band(0)).rows.set(ID(4), row(4));
    server.of(band(0)).rev = 4;
    hub.receiveOp(op(band(0), { op: "add", rows: [row(4)] }, 4));
    await refresh();
    assert.deepEqual(server.queries[2], [{ id: band(0), rev: 2 }], "revision 3 was missed");
    assert.deepEqual(ids(hub, band(0)), [ID(1), ID(2), ID(4)]);
  });

  it("a resync op reads the surface again", async () => {
    const { hub, server, read } = setup();
    hub.acquire(band(0));
    await read();
    server.seed(band(0), row(5));
    hub.receiveOp(op(band(0), { op: "resync" }));
    await read();
    assert.deepEqual(ids(hub, band(0)), [ID(5)]);
  });

  it("routes peers' drafts to their surface, drops them when the peer leaves, and sweeps", async () => {
    const { hub, read } = setup();
    hub.acquire(band(0));
    hub.acquire(band(1));
    await read();
    const packet: DraftPacketV2 = { v: 2, shareId: band(1), strokeId: ID(50), seq: 1, phase: "live", kind: "pen", color: "#000000", strokeWidth: 4, from: 0, points: [[0.1, 0.1], [0.2, 0.2]] };
    hub.receiveDraft("ann", "Аня", packet);
    hub.receiveDraft("ann", "Аня", { ...packet, shareId: band(7) });
    hub.receiveDraft("ann", "Аня", "junk");
    assert.equal(hub.surface(band(1)).store.getDrafts().items.length, 1);
    assert.equal(hub.surface(band(0)).store.getDrafts().items.length, 0);
    hub.sweep();
    hub.dropDraftsOf("ann");
    assert.equal(hub.surface(band(1)).store.getDrafts().items.filter((item) => item.phase === "live").length, 0);
  });

  it("contexts follow the room state", () => {
    const { hub, allow } = setup({ canAnnotate: false });
    const surface = hub.surface(band(0));
    assert.equal(surface.store.context().canAnnotate("me"), false);
    assert.equal(surface.store.context().shareId, band(0));
    allow(true);
    hub.refreshContexts();
    assert.equal(surface.store.context().canAnnotate("me"), true);
  });

  it("the recording gets read-only surfaces", async () => {
    const { hub, server, read } = setup({ self: null });
    server.seed(band(0), row(1));
    hub.acquire(band(0));
    await read();
    assert.equal(hub.surface(band(0)).actions, null);
    assert.deepEqual(ids(hub, band(0)), [ID(1)]);
    assert.deepEqual(hub.history("b:"), { canUndo: false, canRedo: false });
    assert.deepEqual(await hub.undo("b:"), { result: { ok: true }, id: null });
  });
});

describe("surface hub: writes and history", () => {
  it("a client writes to its own surface", async () => {
    const { hub, server } = setup();
    const result = await hub.surface(band(3)).actions?.add("pen", pen, ID(1));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual([...server.of(band(3)).rows.keys()], [ID(1)]);
    assert.deepEqual([...server.of(band(0)).rows.keys()], []);
  });

  it("undo follows the order of the user's actions across surfaces", async () => {
    const { hub, server } = setup();
    await hub.surface(band(0)).actions?.add("pen", pen, ID(1));
    await hub.surface(band(1)).actions?.add("pen", pen, ID(2));
    await hub.surface(band(0)).actions?.add("pen", pen, ID(3));
    assert.deepEqual(hub.history("b:"), { canUndo: true, canRedo: false });
    assert.equal((await hub.undo("b:")).id, band(0));
    assert.deepEqual([...server.of(band(0)).rows.keys()], [ID(1)]);
    assert.equal((await hub.undo("b:")).id, band(1));
    assert.equal((await hub.undo("b:")).id, band(0));
    assert.equal((await hub.undo("b:")).id, null);
    assert.deepEqual(hub.history("b:"), { canUndo: false, canRedo: true });
  });

  it("redo goes back in reverse, and two quick presses take two different steps", async () => {
    const { hub } = setup();
    await hub.surface(band(0)).actions?.add("pen", pen, ID(1));
    await hub.surface(band(1)).actions?.add("pen", pen, ID(2));
    const [first, second] = await Promise.all([hub.undo("b:"), hub.undo("b:")]);
    assert.deepEqual([first.id, second.id], [band(1), band(0)]);
    assert.equal((await hub.redo("b:")).id, band(0));
    assert.equal((await hub.redo("b:")).id, band(1));
    assert.equal((await hub.redo("b:")).id, null);
  });

  it("a new action clears what could be redone on every surface", async () => {
    const { hub } = setup();
    await hub.surface(band(0)).actions?.add("pen", pen, ID(1));
    await hub.undo("b:");
    assert.equal(hub.history("b:").canRedo, true);
    await hub.surface(band(1)).actions?.add("pen", pen, ID(2));
    assert.equal(hub.history("b:").canRedo, false);
    assert.equal((await hub.redo("b:")).id, null);
  });

  it("history is per part: the board's undo leaves the material alone", async () => {
    const { hub } = setup();
    await hub.surface(page(0)).actions?.add("pen", pen, ID(1));
    await hub.surface(band(0)).actions?.add("pen", pen, ID(2));
    assert.equal((await hub.undo("d:")).id, page(0));
    assert.deepEqual(hub.history("b:"), { canUndo: true, canRedo: false });
    assert.deepEqual(hub.history("d:"), { canUndo: false, canRedo: true });
    assert.equal(hub.history("d:"), hub.history("d:"), "a stable snapshot while nothing changes");
  });

  it("notifies history listeners when undo becomes possible", async () => {
    const { hub } = setup();
    let calls = 0;
    const off = hub.subscribeHistory(() => { calls++; });
    await hub.surface(band(0)).actions?.add("pen", pen, ID(1));
    assert.ok(calls > 0);
    off();
    const before = calls;
    await hub.undo("b:");
    assert.equal(calls, before);
  });

  it("a surface that scrolled away keeps its history while the cache has room, the oldest goes first", async () => {
    const { hub } = setup({ cacheSize: 2 });
    for (const n of [0, 1, 2]) {
      const release = hub.acquire(band(n));
      await hub.surface(band(n)).actions?.add("pen", pen, ID(n + 1));
      release();
    }
    assert.equal((await hub.undo("b:")).id, band(2));
    assert.equal((await hub.undo("b:")).id, band(1));
    assert.equal((await hub.undo("b:")).id, null, "band 0 left the cache with its history");
    assert.deepEqual(ids(hub, band(0)), [], "and comes back as a fresh store");
  });

  it("surfaces on screen are never evicted", async () => {
    const { hub } = setup({ cacheSize: 0 });
    hub.acquire(band(0));
    await hub.surface(band(0)).actions?.add("pen", pen, ID(1));
    hub.surface(band(1));
    hub.surface(band(2));
    assert.deepEqual(ids(hub, band(0)), [ID(1)]);
    assert.equal(hub.history("b:").canUndo, true);
  });

  it("an action on another surface while an undo is on its way leaves nothing to redo", async () => {
    const { hub, server } = setup();
    await hub.surface(band(2)).actions?.add("pen", pen, ID(1));
    // The undo's request stays open until released.
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    const post = server.post;
    server.post = async (body) => {
      if (body.action === "erase") await held;
      return post(body);
    };
    const undo = hub.undo("b:");
    await settle();
    await hub.surface(band(3)).actions?.add("pen", pen, ID(2));
    release();
    await undo;
    assert.deepEqual(hub.history("b:"), { canUndo: true, canRedo: false });
    assert.equal((await hub.redo("b:")).id, null);
  });

  it("reset empties the cleared surfaces at once, also the ones that scrolled away", async () => {
    const { hub, server, read } = setup();
    server.seed(band(0), row(1));
    server.seed(page(0), row(2));
    const release = hub.acquire(band(0));
    hub.acquire(page(0));
    await read();
    release(); // band 0 scrolled out of view: its store stays in the cache
    assert.deepEqual(ids(hub, band(0)), [ID(1)]);
    hub.reset("b:");
    assert.deepEqual(ids(hub, band(0)), [], "before any read");
    assert.deepEqual(ids(hub, page(0)), [ID(2)]);
  });

  it("reset forgets history and pending work of the cleared surfaces and reads them again", async () => {
    const { hub, server, read } = setup();
    hub.acquire(band(0));
    hub.acquire(page(0));
    await read();
    await hub.surface(band(0)).actions?.add("pen", pen, ID(1));
    await hub.surface(page(0)).actions?.add("pen", pen, ID(2));
    server.of(band(0)).rows.clear();
    server.of(band(0)).rev++;
    hub.reset("b:");
    await read();
    assert.deepEqual(ids(hub, band(0)), []);
    assert.equal(hub.history("b:").canUndo, false);
    assert.equal(hub.history("d:").canUndo, true);
  });

  it("stop ends every client and timer", async () => {
    const { hub, server, clock } = setup();
    hub.acquire(band(0));
    hub.stop();
    clock.advance(10_000);
    await settle();
    assert.equal(server.queries.length, 0);
  });
});
