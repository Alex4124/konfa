"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { contextFromState, createAnnotationStore, parseServerOp, type AnnotationStore, type BoardView, type HistoryFlags, type SnapshotSink } from "@/lib/annotation-sync";
import { createAnnotationClient, RESYNC_MIN_INTERVAL_MS, type AnnotationActions, type AnnotationClient, type SyncNotice } from "@/lib/annotation-client";
import { decodeJson, DRAFT_TOPIC, type DraftView, type TimerHost } from "@/lib/annotation-drafts";
import type { RoomState } from "@/lib/confa-types";

export { createStateRefresher } from "@/lib/annotation-client";

export type AnnotationSyncConfig = {
  room: Room;
  roomId: string;
  token: string; // session token, or the egress `access` token
  self: { id: string; name: string } | null; // null: read-only observer (egress); must not change while mounted
  state: RoomState | null;
  requestRefresh(): void;
  onNotice?(notice: SyncNotice): void;
};
export type AnnotationSync = SnapshotSink & { store: AnnotationStore; actions: AnnotationActions | null };

const now = () => performance.now();

// The newest config for callbacks that outlive a render; written only from an effect.
function createLatest<T>(initial: T): { get(): T; set(value: T): void } {
  let current = initial;
  return { get: () => current, set: (value) => { current = value; } };
}

// Resolves `window` on every call, so creating the client during a server render is harmless.
export const windowTimers: TimerHost = {
  setTimeout: (handler: TimerHandler, timeout?: number, ...rest: unknown[]) => window.setTimeout(handler, timeout, ...rest),
  clearTimeout: (id?: number) => window.clearTimeout(id),
  setInterval: (handler: TimerHandler, timeout?: number, ...rest: unknown[]) => window.setInterval(handler, timeout, ...rest),
  clearInterval: (id?: number) => window.clearInterval(id),
};

export function useAnnotationSync(config: AnnotationSyncConfig): AnnotationSync {
  const { room, state, self } = config;
  const selfId = self?.id ?? null;
  const [latest] = useState(() => createLatest(config));
  const [store] = useState(() => createAnnotationStore({ now }));
  const [client] = useState<AnnotationClient | null>(() => self ? createAnnotationClient({
    store,
    self: { id: self.id, name: self.name },
    timers: windowTimers,
    now,
    shareIdOf: () => store.board().shareId,
    publish: (data, reliable) => latest.get().room.localParticipant.publishData(new Uint8Array(data), { reliable, topic: DRAFT_TOPIC }),
    onNotice: (notice) => latest.get().onNotice?.(notice),
    requestRefresh: () => latest.get().requestRefresh(),
    transport: {
      async post(body, signal) {
        const { roomId, token } = latest.get();
        const response = await fetch(`/api/rooms/${roomId}/annotations`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
        let parsed: unknown = null;
        try { parsed = await response.json(); } catch { /* Non-JSON error page */ }
        return { status: response.status, body: parsed };
      },
    },
  }) : null);

  useEffect(() => { latest.set(config); });

  useEffect(() => {
    if (!client) return;
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => { store.setContext(contextFromState(state, selfId)); }, [store, state, selfId]);

  useEffect(() => {
    let lastResync = -Infinity;
    let resyncTimer: number | null = null;
    // At most one resync refresh per RESYNC_MIN_INTERVAL_MS; a request inside the window runs once at its end.
    const resync = () => {
      if (resyncTimer !== null) return;
      const wait = lastResync + RESYNC_MIN_INTERVAL_MS - now();
      const run = () => {
        resyncTimer = null;
        lastResync = now();
        latest.get().requestRefresh();
      };
      if (wait <= 0) run();
      else resyncTimer = window.setTimeout(run, wait);
    };
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic === DRAFT_TOPIC) {
        if (participant) store.receiveDraft(participant.identity, participant.name, decodeJson(payload));
        return;
      }
      // Server ops arrive without a participant; a peer cannot forge them once it is known to this client.
      if (topic !== "confa" || participant) return;
      const op = parseServerOp(decodeJson(payload));
      if (op && store.applyOp(op, "server") === "resync") resync();
    };
    const onDisconnected = (participant: RemoteParticipant) => store.dropDraftsOf(participant.identity);
    const onReconnected = () => latest.get().requestRefresh();
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
      room.off(RoomEvent.Reconnected, onReconnected);
      if (resyncTimer !== null) window.clearTimeout(resyncTimer);
    };
  }, [room, store, latest]);

  useEffect(() => {
    const timer = window.setInterval(() => store.sweep(), 500);
    return () => window.clearInterval(timer);
  }, [store]);

  return useMemo(() => ({ store, actions: client, beginSnapshot: store.beginSnapshot, releaseSnapshot: store.releaseSnapshot, applySnapshot: store.applySnapshot }), [store, client]);
}

export function useBoard(store: AnnotationStore): BoardView {
  return useSyncExternalStore(store.subscribeBoard, store.getBoard, store.getBoard);
}

export function useDrafts(store: AnnotationStore): DraftView {
  return useSyncExternalStore(store.subscribeDrafts, store.getDrafts, store.getDrafts);
}

// Only the move-preview ids, so a live draft packet does not re-render whoever needs just these.
export function useHiddenIds(store: AnnotationStore): ReadonlySet<string> {
  const read = () => store.getDrafts().hiddenIds;
  return useSyncExternalStore(store.subscribeDrafts, read, read);
}

export function useAnnotationHistory(store: AnnotationStore): HistoryFlags {
  return useSyncExternalStore(store.subscribeHistory, store.getHistory, store.getHistory);
}
