import type { Annotation } from "@/lib/confa-types";
import { createAnnotationClient, createSingleFlight, REFRESH_MIN_INTERVAL_MS, REQUEST_TIMEOUT_MS, RESYNC_MIN_INTERVAL_MS, type AnnotationActions, type AnnotationClient, type MutationResult, type SyncNotice, type TransportResponse } from "./annotation-client.ts";
import type { TimerHost } from "./annotation-drafts.ts";
import { createAnnotationStore, EMPTY_HISTORY, EMPTY_PENDING, parseServerOp, type AnnotationStore, type HistoryFlags, type SnapshotSink, type SyncContext } from "./annotation-sync.ts";

// The workspace's surfaces (board bands, material pages) come and go as the strips scroll, far more of them than the screen
// share's single one. The hub owns one annotation store and client per surface id, so that:
// - one room listener routes server ops and draft packets to the right store by share id;
// - a surface that scrolled out of view keeps its store for a while (and with it the undo history);
// - one request reads the rows of all surfaces on screen, and only of those whose revision moved;
// - undo and redo follow the order of the user's actions across surfaces (a shared tag counter orders history entries).
// The screen share keeps its own hook (hooks/use-annotation-sync.ts).

export const SURFACE_CACHE = 16;
export const SURFACE_BATCH_MS = 60;
export const SURFACES_PER_REQUEST = 12;

export type SurfaceSync = SnapshotSink & { store: AnnotationStore; actions: AnnotationActions | null };
export type SurfaceQuery = Readonly<{ id: string; rev: number }>;
// rows: present when the surface changed since the revision the client named.
export type SurfaceAnswer = { rev: number; rows?: Annotation[] };
export type HubStep = { result: MutationResult; id: string | null };
export type SurfaceHubOptions = {
  self: { id: string; name: string } | null; // null: read-only (the recording)
  now(): number;
  timers: TimerHost;
  publish(data: Uint8Array, reliable: boolean): Promise<void> | void;
  post(body: Record<string, unknown>, signal?: AbortSignal): Promise<TransportResponse>;
  fetchSurfaces(query: readonly SurfaceQuery[], signal?: AbortSignal): Promise<Record<string, SurfaceAnswer>>;
  contextOf(shareId: string): SyncContext;
  onNotice?(notice: SyncNotice): void;
  onError?(error: unknown): void;
  cacheSize?: number;
  batchMs?: number;
};
export type SurfaceHub = {
  surface(id: string): SurfaceSync; // the surface's store, created on first use
  acquire(id: string): () => void; // on screen: kept and read from the server until released
  receiveOp(raw: unknown): void; // a server op from the room's data channel
  receiveDraft(identity: string, name: string | undefined, raw: unknown): void;
  dropDraftsOf(identity: string): void;
  sweep(): void;
  refreshContexts(): void; // the room state changed: permissions and names
  refresh(): Promise<void>;
  reset(prefix: string): void; // the surfaces were cleared on the server: forget pending work and history, read again
  undo(prefix: string): Promise<HubStep>;
  redo(prefix: string): Promise<HubStep>;
  history(prefix: string): HistoryFlags;
  subscribeHistory(listener: () => void): () => void;
  stop(): void;
};

type Entry = { id: string; store: AnnotationStore; client: AnnotationClient | null; sync: SurfaceSync; refs: number; rev: number; used: number; unsubscribe(): void };

const OK: MutationResult = { ok: true };
const NO_HISTORY: HistoryFlags = Object.freeze({ canUndo: false, canRedo: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createSurfaceHub(o: SurfaceHubOptions): SurfaceHub {
  const { timers } = o;
  const cacheSize = o.cacheSize ?? SURFACE_CACHE;
  const entries = new Map<string, Entry>();
  const historyListeners = new Set<() => void>();
  const flags = new Map<string, HistoryFlags>();
  let tags = 0, uses = 0, recorded = 0;
  let batchTimer: number | null = null;
  let resyncTimer: number | null = null;
  let lastResync = -Infinity;
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const emitHistory = () => {
    for (const listener of [...historyListeners]) listener();
  };

  const evict = (entry: Entry) => {
    entries.delete(entry.id);
    entry.unsubscribe();
    entry.client?.stop();
  };

  // Surfaces off screen stay while the cache has room; the least recently used go first (never the one just asked for).
  const trim = (keep?: Entry) => {
    const idle = [...entries.values()].filter((entry) => entry.refs === 0 && entry !== keep).sort((a, b) => a.used - b.used);
    let dropped = false;
    while (idle.length > cacheSize) {
      evict(idle.shift() as Entry);
      dropped = true;
    }
    if (dropped) emitHistory();
  };

  const create = (id: string): Entry => {
    const store = createAnnotationStore({ now: o.now });
    store.setContext(o.contextOf(id));
    // An empty snapshot names the surface at once: the layer may draw, and the first rows from the server merge into what the
    // user has already drawn instead of resetting it.
    store.applySnapshot(store.beginSnapshot(), id, []);
    const client = o.self ? createAnnotationClient({
      store,
      self: o.self,
      timers,
      now: o.now,
      shareIdOf: () => id,
      publish: o.publish,
      transport: { post: o.post },
      onNotice: o.onNotice,
      requestRefresh: () => void flight.run(),
      nextTag: () => ++tags,
      actionsElsewhere: () => recorded,
      // A new action here: what was undone elsewhere can no longer be redone (nor what an undo on its way would leave).
      onRecord: () => {
        recorded++;
        for (const other of entries.values()) if (other.id !== id) other.store.mutateHistory((history) => history.redo.length ? { ...history, redo: [] } : history);
      },
    }) : null;
    client?.start();
    const sync: SurfaceSync = { store, actions: client, beginSnapshot: store.beginSnapshot, releaseSnapshot: store.releaseSnapshot, applySnapshot: store.applySnapshot };
    const entry: Entry = { id, store, client, sync, refs: 0, rev: -1, used: ++uses, unsubscribe: store.subscribeHistory(emitHistory) };
    entries.set(id, entry);
    return entry;
  };

  const entryOf = (id: string): Entry => {
    const existing = entries.get(id);
    if (existing) {
      existing.used = ++uses;
      return existing;
    }
    const entry = create(id);
    trim(entry);
    return entry;
  };

  const fetchWithin = (query: readonly SurfaceQuery[]) => new Promise<Record<string, SurfaceAnswer>>((resolve, reject) => {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = timers.setTimeout(() => {
      controller?.abort();
      reject(new Error("Не удалось обновить доску"));
    }, REQUEST_TIMEOUT_MS);
    let request: Promise<Record<string, SurfaceAnswer>>;
    try {
      request = Promise.resolve(o.fetchSurfaces(query, controller?.signal));
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then((answers) => { timers.clearTimeout(timer); resolve(answers); }, (error: unknown) => { timers.clearTimeout(timer); reject(error); });
  });

  // Rows of the surfaces on screen, through snapshot tickets taken before the request (ops that arrive meanwhile are replayed).
  const readSurfaces = async (live: readonly Entry[]): Promise<boolean> => {
    const tickets = live.map((entry) => entry.store.beginSnapshot());
    let answers: Record<string, SurfaceAnswer>;
    try {
      answers = await fetchWithin(live.map((entry) => ({ id: entry.id, rev: entry.rev })));
    } catch (error) {
      live.forEach((entry, index) => entry.store.releaseSnapshot(tickets[index]));
      o.onError?.(error);
      return false;
    }
    let stale = false;
    live.forEach((entry, index) => {
      const answer = isRecord(answers) ? answers[entry.id] : undefined;
      const rows = answer && Array.isArray(answer.rows) ? answer.rows : null;
      if (!rows || entries.get(entry.id) !== entry) {
        entry.store.releaseSnapshot(tickets[index]);
        return;
      }
      try {
        if (entry.store.applySnapshot(tickets[index], entry.id, rows) === "stale") stale = true;
        else if (typeof answer?.rev === "number") entry.rev = answer.rev;
      } catch (error) {
        entry.store.releaseSnapshot(tickets[index]);
        o.onError?.(error);
      }
    });
    return stale;
  };

  const flight = createSingleFlight(async () => {
    if (stopped) return;
    const live = [...entries.values()].filter((entry) => entry.refs > 0);
    let stale = false;
    for (let index = 0; index < live.length; index += SURFACES_PER_REQUEST) {
      if (await readSurfaces(live.slice(index, index + SURFACES_PER_REQUEST))) stale = true;
    }
    if (stale) void flight.run();
  }, { minIntervalMs: REFRESH_MIN_INTERVAL_MS, now: o.now, timers });

  // At most one resync refresh per RESYNC_MIN_INTERVAL_MS; a request inside the window runs once at its end.
  const resync = () => {
    if (resyncTimer !== null) return;
    const run = () => {
      resyncTimer = null;
      lastResync = o.now();
      void flight.run();
    };
    const wait = lastResync + RESYNC_MIN_INTERVAL_MS - o.now();
    if (wait <= 0) run();
    else resyncTimer = timers.setTimeout(run, wait);
  };

  const top = (entry: Entry, stack: "undo" | "redo") => {
    const list = entry.store.history()[stack];
    return list[list.length - 1];
  };

  // The store whose newest history entry is the newest of all: where the user's latest action (or latest undo) happened.
  const pick = (prefix: string, stack: "undo" | "redo"): Entry | null => {
    let best: Entry | null = null, bestTag = -Infinity;
    for (const entry of entries.values()) {
      if (!entry.client || !entry.id.startsWith(prefix)) continue;
      const newest = top(entry, stack);
      if (newest && (newest.tag ?? 0) > bestTag) {
        best = entry;
        bestTag = newest.tag ?? 0;
      }
    }
    return best;
  };

  // One step at a time: a second key press waits for the first, so two presses never hit the same entry.
  const step = (prefix: string, stack: "undo" | "redo"): Promise<HubStep> => {
    const run = chain.then(async (): Promise<HubStep> => {
      const target = pick(prefix, stack);
      if (!target?.client) return { result: OK, id: null };
      const result = stack === "undo" ? await target.client.undo() : await target.client.redo();
      return { result, id: target.id };
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    surface: (id) => entryOf(id).sync,

    acquire(id) {
      const entry = entryOf(id);
      entry.refs++;
      // Tiles that mount together are read in one request.
      if (batchTimer === null) batchTimer = timers.setTimeout(() => {
        batchTimer = null;
        void flight.run();
      }, o.batchMs ?? SURFACE_BATCH_MS);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.used = ++uses;
        trim();
      };
    },

    receiveOp(raw) {
      const op = parseServerOp(raw);
      const entry = op ? entries.get(op.shareId) : undefined;
      if (!op || !entry) return;
      if (entry.store.applyOp(op, "server") === "resync") {
        entry.rev = -1;
        resync();
        return;
      }
      // In step with the server: the next read can skip this surface. A gap leaves the revision behind, and the read catches up.
      const rev = isRecord(raw) && typeof raw.rev === "number" ? raw.rev : null;
      if (rev !== null && rev === entry.rev + 1) entry.rev = rev;
    },

    receiveDraft(identity, name, raw) {
      const shareId = isRecord(raw) ? raw.shareId : undefined;
      if (typeof shareId === "string") entries.get(shareId)?.store.receiveDraft(identity, name, raw);
    },

    dropDraftsOf(identity) {
      for (const entry of entries.values()) entry.store.dropDraftsOf(identity);
    },

    sweep() {
      for (const entry of entries.values()) entry.store.sweep();
    },

    refreshContexts() {
      for (const entry of entries.values()) entry.store.setContext(o.contextOf(entry.id));
    },

    refresh: () => flight.run(),

    reset(prefix) {
      for (const entry of entries.values()) {
        if (!entry.id.startsWith(prefix)) continue;
        entry.store.batch(() => {
          entry.store.mutatePending(() => EMPTY_PENDING);
          entry.store.mutateHistory(() => EMPTY_HISTORY);
        });
        // The marks go at once, also on surfaces that have scrolled away: they must not show again before the next read.
        entry.store.applySnapshot(entry.store.beginSnapshot(), entry.id, []);
        entry.rev = -1;
      }
      emitHistory();
      void flight.run();
    },

    undo: (prefix) => step(prefix, "undo"),
    redo: (prefix) => step(prefix, "redo"),

    // Stable while unchanged, for useSyncExternalStore.
    history(prefix) {
      let canUndo = false, canRedo = false;
      for (const entry of entries.values()) {
        if (!entry.client || !entry.id.startsWith(prefix)) continue;
        const history = entry.store.history();
        canUndo ||= history.undo.length > 0;
        canRedo ||= history.redo.length > 0;
      }
      const previous = flags.get(prefix) ?? NO_HISTORY;
      if (previous.canUndo === canUndo && previous.canRedo === canRedo) return previous;
      const next = { canUndo, canRedo };
      flags.set(prefix, next);
      return next;
    },

    subscribeHistory(listener) {
      historyListeners.add(listener);
      return () => { historyListeners.delete(listener); };
    },

    stop() {
      stopped = true;
      if (batchTimer !== null) timers.clearTimeout(batchTimer);
      if (resyncTimer !== null) timers.clearTimeout(resyncTimer);
      batchTimer = null;
      resyncTimer = null;
      for (const entry of [...entries.values()]) evict(entry);
    },
  };
}
