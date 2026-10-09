import type { Annotation, AnnotationKind, AnnotationOp, AnnotationPayload, RoomState } from "@/lib/confa-types";
import { translateAnnotation } from "./annotation-geometry.ts";
import { createDraftSender, type DraftSender, type TimerHost } from "./annotation-drafts.ts";
import { inverseOf, mapHistory, parseRow, pushHistory, pushStack, renameId, withoutIds, type AnnotationStore, type HistoryCommand, type HistoryEntry, type Pending, type PendingOverlay, type PendingRow, type SnapshotSink } from "./annotation-sync.ts";
import { EDITABLE_KEYS, validateAnnotationPayload, validatePatch, type PayloadPatch } from "./annotation-validate.ts";
import { ANNOTATION_CAP } from "./annotation-wire.ts";

export const ERASE_FLUSH_MS = 250;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RETRY_DELAYS_MS: readonly number[] = [400, 1200];
export const REFRESH_MIN_INTERVAL_MS = 250;
export const RESYNC_MIN_INTERVAL_MS = 2000;

export type SyncErrorCode = "cap" | "rate" | "forbidden" | "share-changed" | "no-share" | "gone" | "conflict" | "network" | "invalid";
export type MutationResult = { ok: true } | { ok: false; code: SyncErrorCode; message: string };
export type SyncNotice = { tone: "error" | "info"; code: SyncErrorCode; text: string };
export type TransportResponse = { status: number; body: unknown };
// Resolves with any HTTP status; rejects only on a network error or abort.
export type AnnotationTransport = { post(body: Record<string, unknown>, signal?: AbortSignal): Promise<TransportResponse> };
export type AnnotationActions = {
  add(kind: AnnotationKind, payload: AnnotationPayload, id: string): Promise<MutationResult>;
  // draftId: the move preview's stroke id, cancelled for peers when the move fails.
  move(id: string, dx: number, dy: number, draftId?: string): Promise<MutationResult>;
  edit(id: string, patch: PayloadPatch): Promise<MutationResult>;
  erase(ids: readonly string[], gesture: string): void;
  flushErase(): Promise<MutationResult>;
  clear(): Promise<MutationResult>;
  clearAuthor(authorId: string): Promise<MutationResult>;
  undo(): Promise<MutationResult>;
  redo(): Promise<MutationResult>;
  draft: DraftSender;
};
export type AnnotationClient = AnnotationActions & { start(): void; stop(): void };
export type AnnotationClientOptions = {
  store: AnnotationStore;
  transport: AnnotationTransport;
  publish(data: Uint8Array, reliable: boolean): Promise<void> | void;
  self: { id: string; name: string };
  shareIdOf(): string | null;
  timers: TimerHost;
  now(): number;
  onNotice?(notice: SyncNotice): void;
  requestRefresh?(): void;
};

export const NOTICE_TEXT: Record<SyncErrorCode, string> = {
  cap: `На экране уже ${ANNOTATION_CAP} пометок — очистите доску, чтобы добавить новые`,
  rate: "Слишком много пометок подряд — подождите пару секунд",
  forbidden: "Ведущий не разрешил вам делать пометки",
  network: "Не удалось сохранить пометку — проверьте соединение",
  conflict: "Пометку только что изменили — попробуйте ещё раз",
  gone: "Эту пометку уже удалили",
  invalid: "Некорректная пометка",
  "share-changed": "Демонстрация сменилась",
  "no-share": "Сейчас никто не показывает экран",
};

const SILENT: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>(["share-changed", "no-share", "gone"]);
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(NOTICE_TEXT));
const RETRIABLE: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>(["network", "rate"]);
const OK: MutationResult = { ok: true };

type Failure = { ok: false; code: SyncErrorCode; message: string };
type Outcome = { ok: true; body: Record<string, unknown>; attempts: number } | Failure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function errorCodeOf(status: number, body: unknown): SyncErrorCode {
  const code = isRecord(body) ? body.code : undefined;
  if (typeof code === "string" && KNOWN_CODES.has(code)) return code as SyncErrorCode;
  if (!(status > 0) || status >= 500) return "network";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404 || status === 410) return "gone";
  if (status === 409) return "conflict";
  if (status === 429) return "rate";
  return "invalid";
}

// Server wording only where it is more specific than ours (permission and validation texts).
export function failure(code: SyncErrorCode, serverMessage?: unknown): Failure {
  const specific = (code === "forbidden" || code === "invalid") && typeof serverMessage === "string" && serverMessage.trim();
  return { ok: false, code, message: specific ? serverMessage.trim() : NOTICE_TEXT[code] };
}

export function noticeFor(result: MutationResult): SyncNotice | null {
  if (result.ok || SILENT.has(result.code)) return null;
  return { tone: result.code === "forbidden" ? "info" : "error", code: result.code, text: result.message };
}

// Tasks on the same key run in order, different keys in parallel; "*" waits for everything queued before it and blocks what follows.
export function createMutationQueue(): { run<T>(keys: readonly string[] | "*", task: () => Promise<T>): Promise<T> } {
  const tails = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  let barrier: Promise<void> | null = null;
  const settle = () => undefined;
  return {
    run<T>(keys: readonly string[] | "*", task: () => Promise<T>): Promise<T> {
      const deps = keys === "*" ? [...inflight] : [barrier, ...keys.map((key) => tails.get(key))].filter((dep): dep is Promise<void> => Boolean(dep));
      const result = (deps.length ? Promise.all(deps).then(settle) : Promise.resolve()).then(task);
      const done = result.then(settle, settle);
      inflight.add(done);
      if (keys === "*") barrier = done;
      else for (const key of keys) tails.set(key, done);
      void done.then(() => {
        inflight.delete(done);
        if (barrier === done) barrier = null;
        if (keys !== "*") for (const key of keys) if (tails.get(key) === done) tails.delete(key);
      });
      return result;
    },
  };
}

// run() resolves once a task that started at or after the call has finished. One task at a time; calls during a run
// collapse into one trailing run, started no sooner than minIntervalMs after the previous start. Task errors never reject.
export function createSingleFlight(task: () => Promise<void>, o: { minIntervalMs: number; now(): number; timers: TimerHost }): { run(): Promise<void> } {
  let running = false;
  let waiting: { promise: Promise<void>; resolve: () => void } | null = null;
  let timer: number | null = null;
  let lastStart = -Infinity;

  const start = () => {
    timer = null;
    const batch = waiting;
    waiting = null;
    running = true;
    lastStart = o.now();
    let run: Promise<void>;
    try {
      run = Promise.resolve(task());
    } catch (error) {
      run = Promise.reject(error);
    }
    void run.catch(() => undefined).then(() => {
      running = false;
      batch?.resolve();
      if (waiting) schedule();
    });
  };
  const schedule = () => {
    if (running || timer !== null) return;
    const wait = lastStart + o.minIntervalMs - o.now();
    if (wait > 0) timer = o.timers.setTimeout(start, wait);
    else start();
  };
  return {
    run() {
      if (!waiting) {
        let resolve = () => {};
        const promise = new Promise<void>((done) => { resolve = done; });
        waiting = { promise, resolve };
      }
      const promise = waiting.promise;
      schedule();
      return promise;
    },
  };
}

const STATE_TIMEOUT_MESSAGE = "Не удалось обновить комнату";

// One annotation store fed by the polled state: which surface the state names for it, and that surface's rows.
export type StateSink = { sink: SnapshotSink; select(state: RoomState): { shareId: string | null; rows: Annotation[] } };

export function shareSnapshot(state: RoomState): { shareId: string | null; rows: Annotation[] } {
  return { shareId: state.room.activeShareId, rows: Array.isArray(state.annotations) ? state.annotations : [] };
}

// Single-flight GET /state applied through snapshot tickets (one per sink, all taken before the fetch); a "stale" snapshot
// asks for one more run. A request that outlives timeoutMs is aborted and reported, so one stalled fetch never blocks later refreshes.
// `sync` is the screen share's store alone (sinks: [{ sink: sync, select: shareSnapshot }]).
export function createStateRefresher(o: { fetchState(signal?: AbortSignal): Promise<RoomState>; sync?: SnapshotSink; sinks?: readonly StateSink[]; onState(state: RoomState): void; onError(error: unknown): void; timers: TimerHost; now(): number; minIntervalMs?: number; timeoutMs?: number }): { run(): Promise<void> } {
  const sinks: readonly StateSink[] = o.sinks ?? (o.sync ? [{ sink: o.sync, select: shareSnapshot }] : []);
  const fetchWithin = () => new Promise<RoomState>((resolve, reject) => {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = o.timers.setTimeout(() => {
      controller?.abort();
      reject(new Error(STATE_TIMEOUT_MESSAGE));
    }, o.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const done = () => o.timers.clearTimeout(timer);
    let request: Promise<RoomState>;
    try {
      request = Promise.resolve(o.fetchState(controller?.signal));
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then((state) => { done(); resolve(state); }, (error: unknown) => { done(); reject(error); });
  });
  const flight = createSingleFlight(async () => {
    const tickets = sinks.map(({ sink }) => sink.beginSnapshot());
    let state: RoomState;
    try {
      state = await fetchWithin();
    } catch (error) {
      sinks.forEach(({ sink }, index) => sink.releaseSnapshot(tickets[index]));
      o.onError(error);
      return;
    }
    // A sink that throws does not keep the others (or the rest of the state) from applying.
    let stale = false, failed = false, cause: unknown = null;
    sinks.forEach(({ sink, select }, index) => {
      try {
        const { shareId, rows } = select(state);
        if (sink.applySnapshot(tickets[index], shareId, rows) === "stale") stale = true;
      } catch (error) {
        sink.releaseSnapshot(tickets[index]);
        if (!failed) { failed = true; cause = error; }
      }
    });
    try {
      o.onState(state);
    } catch (error) {
      if (!failed) { failed = true; cause = error; }
    }
    if (failed) o.onError(cause);
    if (stale) void flight.run();
  }, { minIntervalMs: o.minIntervalMs ?? REFRESH_MIN_INTERVAL_MS, now: o.now, timers: o.timers });
  return { run: () => flight.run() };
}

function withoutKeys<V>(map: ReadonlyMap<string, V>, keys: Iterable<string>): ReadonlyMap<string, V> {
  let next: Map<string, V> | null = null;
  for (const key of keys) {
    if (!(next ?? map).has(key)) continue;
    next ??= new Map(map);
    next.delete(key);
  }
  return next ?? map;
}

function pickEditable(patch: PayloadPatch): PayloadPatch {
  const clean: Record<string, unknown> = {};
  const source = patch as Record<string, unknown>;
  for (const key of EDITABLE_KEYS) if (source[key] !== undefined) clean[key] = source[key];
  return clean as PayloadPatch;
}

// Previous values of the patched keys, null for keys the patch adds (undo removes them); a text change without `lines`
// also restores the old lines on undo.
function valuesBefore(data: AnnotationPayload, patch: PayloadPatch): PayloadPatch {
  const before: Record<string, unknown> = {};
  const source = data as Record<string, unknown>;
  for (const key of Object.keys(patch)) before[key] = source[key] !== undefined ? source[key] : null;
  if ("text" in patch && !("lines" in patch) && data.lines !== undefined) before.lines = data.lines;
  return before as PayloadPatch;
}

export function createAnnotationClient(o: AnnotationClientOptions): AnnotationClient {
  const { store, timers } = o;
  const queue = createMutationQueue();
  const rekeyed = new Map<string, string>();
  const resolve = (id: string) => rekeyed.get(id) ?? id;
  let tags = 0, generation = 0;
  let eraseBuffer: string[] = [];
  let eraseShare: string | null = null;
  let flushTimer: number | null = null;
  let started = false;
  const flushing = new Set<Promise<unknown>>();

  const draft = createDraftSender({ publish: (data, reliable) => o.publish(data, reliable), now: o.now, shareId: o.shareIdOf, canSend: () => store.context().canAnnotate(o.self.id), timers });

  const report = (result: Failure): Failure => {
    const notice = noticeFor(result);
    if (notice) o.onNotice?.(notice);
    return result;
  };

  const rowsOp = (shareId: string, op: "add" | "move" | "edit" | "restore", rows: Annotation[]): AnnotationOp => ({ type: "annotations", v: 1, shareId, by: o.self.id, op, rows });
  const eraseOp = (shareId: string, ids: string[]): AnnotationOp => ({ type: "annotations", v: 1, shareId, by: o.self.id, op: "erase", ids });
  const clearOp = (shareId: string, upToSeq: number): AnnotationOp => ({ type: "annotations", v: 1, shareId, by: o.self.id, op: "clear", upToSeq });

  const rowOf = (id: string): PendingRow | undefined => store.board().rows.get(id) ?? store.pending().adds.get(id);
  const dataOf = (id: string) => store.pending().overlays.get(id)?.data ?? rowOf(id)?.data;
  const sameShare = (shareId: string) => store.board().shareId === shareId;

  const changePending = (update: (pending: Pending) => Pending) => store.mutatePending(update);
  const addRows = (rows: readonly PendingRow[]) => changePending((p) => {
    const adds = new Map(p.adds);
    for (const row of rows) adds.set(row.id, row);
    return { ...p, adds };
  });
  const dropAdds = (ids: readonly string[]) => changePending((p) => {
    const adds = withoutKeys(p.adds, ids);
    return adds === p.adds ? p : { ...p, adds };
  });
  const hide = (ids: readonly string[]) => changePending((p) => ids.every((id) => p.erases.has(id)) ? p : { ...p, erases: new Set([...p.erases, ...ids]) });
  const unhide = (ids: Iterable<string>) => changePending((p) => {
    const drop = new Set(ids);
    if (![...drop].some((id) => p.erases.has(id))) return p;
    return { ...p, erases: new Set([...p.erases].filter((id) => !drop.has(id))) };
  });
  const setOverlay = (id: string, overlay: PendingOverlay) => changePending((p) => ({ ...p, overlays: new Map(p.overlays).set(id, overlay) }));
  const clearOverlay = (id: string, overlay: PendingOverlay) => changePending((p) => p.overlays.get(id) === overlay ? { ...p, overlays: withoutKeys(p.overlays, [id]) } : p);
  const rekeyPending = (from: string, to: string) => changePending((p) => {
    const overlay = p.overlays.get(from);
    const overlays = overlay ? new Map(withoutKeys(p.overlays, [from])).set(to, overlay) : p.overlays;
    const erases = p.erases.has(from) ? new Set([...p.erases].map((id) => id === from ? to : id)) : p.erases;
    return overlays === p.overlays && erases === p.erases ? p : { ...p, overlays, erases };
  });

  const record = (entry: HistoryEntry) => {
    generation++;
    store.mutateHistory((h) => pushHistory(h, entry));
  };
  const forget = (tag: number) => store.mutateHistory((h) => mapHistory(h, (entry) => entry.tag === tag ? null : entry));
  const replaceEntry = (tag: number, update: (entry: HistoryEntry) => HistoryEntry) => store.mutateHistory((h) => mapHistory(h, (entry) => entry.tag === tag ? update(entry) : entry));

  const attempt = (body: Record<string, unknown>) => new Promise<TransportResponse | null>((done) => {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let settled = false;
    const finish = (response: TransportResponse | null) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      done(response);
    };
    const timer = timers.setTimeout(() => {
      controller?.abort();
      finish(null);
    }, REQUEST_TIMEOUT_MS);
    try {
      o.transport.post(body, controller?.signal).then((response) => finish({ status: typeof response?.status === "number" ? response.status : 0, body: response?.body }), () => finish(null));
    } catch {
      finish(null);
    }
  });
  const delay = (ms: number) => new Promise<void>((done) => { timers.setTimeout(() => done(), ms); });

  // Idempotent actions retry on network errors and 5xx with the same body (and so the same ids).
  const send = async (body: () => Record<string, unknown>, retry: boolean): Promise<Outcome> => {
    const tries = retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let last: Failure = failure("network");
    for (let index = 0; index < tries; index++) {
      if (index > 0) await delay(RETRY_DELAYS_MS[index - 1]);
      const response = await attempt(body());
      if (response && response.status >= 200 && response.status < 300) return { ok: true, body: isRecord(response.body) ? response.body : {}, attempts: index + 1 };
      const code = response ? errorCodeOf(response.status, response.body) : "network";
      last = failure(code, isRecord(response?.body) ? response.body.error : undefined);
      if (code !== "network") return last;
    }
    return last;
  };

  // Erases `ids` on the server; un-hides every requested id and applies what was deleted in one emit.
  // `effective` is what this request deleted; on a retry, ids already gone count too (the first attempt may have committed).
  const runErase = async (shareId: string, ids: readonly string[], settle: (requested: ReadonlySet<string>, effective: ReadonlySet<string> | null) => void): Promise<{ result: MutationResult; effective: ReadonlySet<string> | null }> => {
    const since = store.serverCursor();
    const outcome = await queue.run(ids, () => send(() => ({ action: "erase", targetIds: [...new Set(ids.map(resolve))], shareId }), true));
    const requested = new Set(ids.flatMap((id) => [id, resolve(id)]));
    if (!outcome.ok) {
      store.batch(() => {
        unhide(requested);
        settle(requested, null);
      });
      return { result: report(outcome), effective: null };
    }
    const deleted = strings(outcome.body.deletedIds), already = strings(outcome.body.alreadyDeletedIds);
    const effective = new Set(outcome.attempts > 1 ? [...deleted, ...already] : deleted);
    store.batch(() => {
      const gone = [...deleted, ...already];
      if (gone.length) store.applyOp(eraseOp(shareId, gone), "local", since);
      unhide(requested);
      settle(requested, effective);
    });
    return { result: OK, effective };
  };

  const flushErase = async (): Promise<MutationResult> => {
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    flushTimer = null;
    const ids = eraseBuffer, shareId = eraseShare;
    eraseBuffer = [];
    eraseShare = null;
    if (!ids.length || !shareId) return OK;
    const run = runErase(shareId, ids, (requested, effective) => store.mutateHistory((h) => mapHistory(h, (entry) => {
      if (entry.op !== "erase") return entry;
      const lost = new Set(entry.ids.filter((id) => requested.has(id) && !effective?.has(id)));
      return lost.size ? withoutIds(entry, lost) : entry;
    })));
    flushing.add(run);
    try {
      return (await run).result;
    } finally {
      flushing.delete(run);
    }
  };

  const runMove = async (shareId: string, id: string, dx: number, dy: number, track: boolean): Promise<{ result: MutationResult; moved?: { dx: number; dy: number } }> => {
    const data = dataOf(id);
    if (!data) return { result: failure("gone") };
    let moved: ReturnType<typeof translateAnnotation>;
    try {
      moved = translateAnnotation(data, dx, dy);
    } catch {
      return { result: failure("invalid") };
    }
    if (!moved.dx && !moved.dy) return { result: OK, moved: { dx: 0, dy: 0 } };
    const overlay: PendingOverlay = { data: moved.payload, status: "moving" };
    const tag = ++tags, since = store.serverCursor();
    store.batch(() => {
      setOverlay(id, overlay);
      if (track) record({ op: "move", id, dx: moved.dx, dy: moved.dy, tag });
    });
    const outcome = await queue.run([id], () => send(() => ({ action: "move", targetId: resolve(id), dx: moved.dx, dy: moved.dy, shareId }), false));
    const target = resolve(id);
    if (outcome.ok) {
      const row = parseRow(outcome.body.row);
      const applied = { dx: numberOr(outcome.body.dx, moved.dx), dy: numberOr(outcome.body.dy, moved.dy) };
      store.batch(() => {
        if (row) store.applyOp(rowsOp(shareId, "move", [row]), "local", since);
        clearOverlay(target, overlay);
        if (track && (applied.dx !== moved.dx || applied.dy !== moved.dy)) replaceEntry(tag, (entry) => entry.op === "move" ? { ...entry, ...applied } : entry);
      });
      if (!row) o.requestRefresh?.();
      return { result: OK, moved: applied };
    }
    store.batch(() => {
      clearOverlay(target, overlay);
      if (track) forget(tag);
    });
    if (outcome.code === "conflict") o.requestRefresh?.();
    return { result: report(outcome) };
  };

  const runEdit = async (shareId: string, id: string, patch: PayloadPatch, track: boolean): Promise<{ result: MutationResult; before?: PayloadPatch; after?: PayloadPatch }> => {
    const row = rowOf(id), data = dataOf(id);
    if (!row || !data) return { result: failure("gone") };
    const after = pickEditable(patch);
    if (!Object.keys(after).length) return { result: OK };
    const checked = validatePatch(row.kind, data, after);
    if ("error" in checked) return { result: report(failure("invalid", checked.error)) };
    const before = valuesBefore(data, after);
    const overlay: PendingOverlay = { data: checked.payload, status: "editing" };
    const tag = ++tags, since = store.serverCursor();
    store.batch(() => {
      setOverlay(id, overlay);
      if (track) record({ op: "edit", id, before, after, tag });
    });
    const outcome = await queue.run([id], () => send(() => ({ action: "edit", targetId: resolve(id), patch: after, shareId }), true));
    const target = resolve(id);
    if (outcome.ok) {
      const saved = parseRow(outcome.body.row);
      store.batch(() => {
        if (saved) store.applyOp(rowsOp(shareId, "edit", [saved]), "local", since);
        clearOverlay(target, overlay);
      });
      if (!saved) o.requestRefresh?.();
      return { result: OK, before, after };
    }
    store.batch(() => {
      clearOverlay(target, overlay);
      if (track) forget(tag);
    });
    if (outcome.code === "conflict") o.requestRefresh?.();
    return { result: report(outcome) };
  };

  // Executes an undo/redo command; `next` is the entry for the opposite stack (absent when nothing changed).
  const perform = async (shareId: string, command: HistoryCommand): Promise<{ result: MutationResult; next?: HistoryEntry }> => {
    if (command.op === "erase") {
      const ids = command.ids.map(resolve);
      const rows = ids.flatMap((id) => rowOf(id) ?? []);
      hide(ids);
      const { result, effective } = await runErase(shareId, ids, () => {});
      if (!result.ok || !effective) return { result };
      const done = ids.map(resolve).filter((id) => effective.has(id));
      if (!done.length) return { result: failure("gone") };
      return { result, next: { op: "erase", ids: done, rows: rows.map((row) => ({ ...row, id: resolve(row.id) })).filter((row) => effective.has(row.id)) } };
    }
    if (command.op === "restore") {
      const ids = command.ids.map(resolve);
      const optimistic = command.rows.map((row) => ({ ...row, id: resolve(row.id) })).filter((row) => !store.board().rows.has(row.id));
      const since = store.serverCursor();
      if (optimistic.length) addRows(optimistic);
      const outcome = await queue.run(ids, () => send(() => ({ action: "restore", targetIds: [...new Set(ids.map(resolve))], shareId }), true));
      if (!outcome.ok) {
        dropAdds(optimistic.map((row) => row.id));
        return { result: report(outcome) };
      }
      const rows = (Array.isArray(outcome.body.rows) ? outcome.body.rows : []).map(parseRow).filter((row): row is Annotation => row !== null);
      store.batch(() => {
        if (rows.length) store.applyOp(rowsOp(shareId, "restore", rows), "local", since);
        dropAdds(optimistic.map((row) => row.id));
      });
      if (!rows.length) return { result: failure("gone") };
      return { result: OK, next: { op: "restore", ids: rows.map((row) => row.id) } };
    }
    if (command.op === "move") {
      const id = resolve(command.id);
      const { result, moved } = await runMove(shareId, id, command.dx, command.dy, false);
      if (!result.ok || !moved || (!moved.dx && !moved.dy)) return { result };
      return { result, next: { op: "move", id: resolve(id), dx: moved.dx, dy: moved.dy } };
    }
    const id = resolve(command.id);
    const { result, before, after } = await runEdit(shareId, id, command.patch, false);
    if (!result.ok || !before || !after) return { result };
    return { result, next: { op: "edit", id: resolve(id), before, after } };
  };

  // Waits for erase flushes first: their result narrows the erase entry (ids someone else had erased are never restored).
  const step = async (from: "undo" | "redo"): Promise<MutationResult> => {
    while (eraseBuffer.length || flushing.size) {
      if (eraseBuffer.length) void flushErase();
      await Promise.all(flushing);
    }
    const stack = store.history()[from];
    const entry = stack[stack.length - 1];
    if (!entry) return OK;
    const shareId = o.shareIdOf();
    if (!shareId || !sameShare(shareId)) return failure("share-changed");
    const to = from === "undo" ? "redo" : "undo";
    const startGeneration = generation;
    store.mutateHistory((h) => h[from][h[from].length - 1] === entry ? { ...h, [from]: h[from].slice(0, -1) } : h);
    const { result, next } = await perform(shareId, inverseOf(entry));
    if (!sameShare(shareId)) return result;
    if (next && (to === "undo" || generation === startGeneration)) store.mutateHistory((h) => pushStack(h, to, { ...next, tag: ++tags }));
    else if (!result.ok && RETRIABLE.has(result.code) && generation === startGeneration) store.mutateHistory((h) => pushStack(h, from, entry));
    return result;
  };

  return {
    draft,
    start() {
      started = true;
    },
    stop() {
      if (!started) return;
      started = false;
      if (eraseBuffer.length) void flushErase();
      draft.cancelAll();
    },

    // Shows a pending mark at once; the saved row replaces it in one emit (the server may re-key a claimed id).
    async add(kind, payload, rawId) {
      const id = rawId.toLowerCase();
      const shareId = o.shareIdOf();
      if (!shareId) {
        draft.cancel(id);
        return failure("no-share");
      }
      const checked = validateAnnotationPayload(kind, payload);
      if ("error" in checked) {
        draft.cancel(id);
        return report(failure("invalid", checked.error));
      }
      const row: PendingRow = { id, author_id: o.self.id, author_name: o.self.name, kind, payload: checked.encoded, created_at: 0, seq: null, data: checked.payload };
      const since = store.serverCursor();
      store.batch(() => {
        addRows([row]);
        record({ op: "add", ids: [id], tag: ++tags });
      });
      const outcome = await queue.run([id], () => send(() => ({ action: "add", id, kind, payload: checked.payload, shareId }), true));
      if (outcome.ok) {
        const saved = parseRow(outcome.body.row);
        const finalId = saved?.id ?? id;
        if (finalId !== id) rekeyed.set(id, finalId);
        store.batch(() => {
          if (saved) store.applyOp(rowsOp(shareId, "add", [saved]), "local", since);
          if (finalId !== id) {
            rekeyPending(id, finalId);
            store.mutateHistory((h) => mapHistory(h, (entry) => renameId(entry, id, finalId)));
          }
          dropAdds([id]);
        });
        if (finalId !== id) draft.cancel(id);
        if (!saved) o.requestRefresh?.();
        return OK;
      }
      store.batch(() => {
        dropAdds([id]);
        store.mutateHistory((h) => mapHistory(h, (entry) => withoutIds(entry, new Set([id]), ["add"])));
      });
      draft.cancel(id);
      return report(outcome);
    },

    async move(rawId, dx, dy, draftId) {
      const shareId = o.shareIdOf();
      const id = resolve(rawId.toLowerCase());
      const { result, moved } = shareId ? await runMove(shareId, id, dx, dy, true) : { result: failure("no-share"), moved: undefined };
      if (draftId && (!result.ok || (!moved?.dx && !moved?.dy))) draft.cancel(draftId);
      return result;
    },

    async edit(rawId, patch) {
      const shareId = o.shareIdOf();
      if (!shareId) return failure("no-share");
      return (await runEdit(shareId, resolve(rawId.toLowerCase()), patch, true)).result;
    },

    // Hides at once; ids are posted in one batch ERASE_FLUSH_MS later (or on flushErase), one undo step per gesture.
    erase(ids, gesture) {
      const shareId = o.shareIdOf();
      if (!shareId) return;
      if (eraseShare && eraseShare !== shareId) void flushErase();
      const hidden = store.pending().erases;
      const fresh: string[] = [];
      const rows: PendingRow[] = [];
      for (const raw of ids) {
        const id = resolve(raw.toLowerCase());
        const row = rowOf(id);
        if (!row || hidden.has(id) || fresh.includes(id)) continue;
        fresh.push(id);
        rows.push(row);
      }
      if (!fresh.length) return;
      store.batch(() => {
        hide(fresh);
        record({ op: "erase", ids: fresh, rows, gesture, tag: ++tags });
      });
      eraseShare = shareId;
      eraseBuffer.push(...fresh);
      if (flushTimer === null) flushTimer = timers.setTimeout(() => {
        flushTimer = null;
        void flushErase();
      }, ERASE_FLUSH_MS);
    },
    flushErase,

    // Optimistically hides everything up to the newest saved seq; the request waits for all in-flight writes.
    async clear() {
      const shareId = o.shareIdOf();
      if (!shareId) return failure("no-share");
      if (eraseBuffer.length) void flushErase();
      generation++;
      const captured = new Map<string, PendingRow>();
      let newest = -Infinity;
      for (const row of store.board().rows.values()) {
        captured.set(row.id, row);
        newest = Math.max(newest, row.seq);
      }
      const upTo = Number.isFinite(newest) ? newest : null;
      const since = store.serverCursor();
      if (upTo !== null) changePending((p) => ({ ...p, clearUpTo: Math.max(p.clearUpTo ?? upTo, upTo) }));
      const outcome = await queue.run("*", () => send(() => ({ action: "clear", shareId }), false));
      const reveal = () => changePending((p) => p.clearUpTo === null ? p : { ...p, clearUpTo: null });
      if (!outcome.ok) {
        reveal();
        return report(outcome);
      }
      const ids = strings(outcome.body.clearedIds);
      store.batch(() => {
        if (ids.length) store.applyOp(clearOp(shareId, numberOr(outcome.body.upToSeq, upTo ?? 0)), "local", since);
        reveal();
        if (ids.length && sameShare(shareId)) record({ op: "clear", ids, rows: ids.flatMap((id) => captured.get(id) ?? []), tag: ++tags });
      });
      return OK;
    },

    // Moderator action: erases every mark of one author; undoable like an erase.
    async clearAuthor(authorId) {
      const shareId = o.shareIdOf();
      if (!shareId) return failure("no-share");
      if (eraseBuffer.length) void flushErase();
      generation++;
      const hidden = store.pending().erases;
      const rows = [...store.board().rows.values()].filter((row) => row.author_id === authorId && !hidden.has(row.id));
      const ids = rows.map((row) => row.id);
      const since = store.serverCursor();
      if (ids.length) hide(ids);
      const outcome = await queue.run("*", () => send(() => ({ action: "clearAuthor", targetId: authorId, shareId }), false));
      if (!outcome.ok) {
        unhide(ids);
        return report(outcome);
      }
      const deleted = strings(outcome.body.deletedIds);
      store.batch(() => {
        if (deleted.length) store.applyOp(eraseOp(shareId, deleted), "local", since);
        unhide(ids);
        if (deleted.length && sameShare(shareId)) record({ op: "erase", ids: deleted, rows: rows.filter((row) => deleted.includes(row.id)), tag: ++tags });
      });
      return OK;
    },

    undo: () => step("undo"),
    redo: () => step("redo"),
  };
}
