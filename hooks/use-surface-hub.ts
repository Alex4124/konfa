"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import type { SyncNotice } from "@/lib/annotation-client";
import { decodeJson, DRAFT_TOPIC } from "@/lib/annotation-drafts";
import type { HistoryFlags } from "@/lib/annotation-sync";
import { createSurfaceHub, type SurfaceAnswer, type SurfaceHub, type SurfaceSync } from "@/lib/surface-hub";
import { workspaceContext } from "@/lib/workspace";
import { windowTimers } from "@/hooks/use-annotation-sync";
import type { RoomState } from "@/lib/confa-types";

export type SurfaceHubConfig = {
  room: Room;
  roomId: string;
  token: string; // session token, or the egress `access` token
  self: { id: string; name: string } | null; // null: read-only observer (egress); must not change while mounted
  state: RoomState | null;
  onNotice?(notice: SyncNotice): void;
};

const POLL_MS = 3000;
const SWEEP_MS = 500;
const now = () => performance.now();

// The newest config for callbacks that outlive a render; written only from an effect.
function createLatest<T>(initial: T): { get(): T; set(value: T): void } {
  let current = initial;
  return { get: () => current, set: (value) => { current = value; } };
}

// The workspace's annotation stores (lib/surface-hub) wired to the room: its data channel, the polled state (permissions and
// names) and the /surfaces endpoint. One per room view; the screen share keeps useAnnotationSync.
export function useSurfaceHub(config: SurfaceHubConfig): SurfaceHub {
  const { room, state } = config;
  const selfId = config.self?.id ?? null;
  const [latest] = useState(() => createLatest(config));
  const [hub] = useState(() => createSurfaceHub({
    self: config.self,
    now,
    timers: windowTimers,
    publish: (data, reliable) => latest.get().room.localParticipant.publishData(new Uint8Array(data), { reliable, topic: DRAFT_TOPIC }),
    async post(body, signal) {
      const { roomId, token } = latest.get();
      const response = await fetch(`/api/rooms/${roomId}/annotations`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      let parsed: unknown = null;
      try { parsed = await response.json(); } catch { /* Non-JSON error page */ }
      return { status: response.status, body: parsed };
    },
    async fetchSurfaces(query, signal) {
      const { roomId, token } = latest.get();
      const ids = query.map((item) => encodeURIComponent(item.id)).join(","), revs = query.map((item) => item.rev).join(",");
      const response = await fetch(`/api/rooms/${roomId}/surfaces?ids=${ids}&revs=${revs}`, { headers: { Authorization: `Bearer ${token}` }, signal });
      if (!response.ok) throw new Error(`surfaces ${response.status}`);
      const body = await response.json() as { surfaces?: Record<string, SurfaceAnswer> };
      return body.surfaces ?? {};
    },
    contextOf: (shareId) => workspaceContext(latest.get().state, latest.get().self?.id ?? null, shareId),
    onNotice: (notice) => latest.get().onNotice?.(notice),
  }));

  // Before the contexts are refreshed below: they read the newest state.
  useEffect(() => { latest.set(config); });

  useEffect(() => { hub.refreshContexts(); }, [hub, state, selfId]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic === DRAFT_TOPIC) {
        if (participant) hub.receiveDraft(participant.identity, participant.name, decodeJson(payload));
        return;
      }
      // Server events arrive without a participant; a peer cannot forge them.
      if (topic !== "confa" || participant) return;
      const event = decodeJson(payload) as { type?: unknown; reset?: unknown } | null;
      if (event?.type === "annotations") hub.receiveOp(event);
      else if (event?.type === "surfaces-changed") {
        if (typeof event.reset === "string" && event.reset) hub.reset(event.reset);
        else void hub.refresh();
      }
    };
    const onDisconnected = (participant: RemoteParticipant) => hub.dropDraftsOf(participant.identity);
    const onReconnected = () => void hub.refresh();
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [room, hub]);

  useEffect(() => {
    const sweep = window.setInterval(() => hub.sweep(), SWEEP_MS);
    const poll = window.setInterval(() => void hub.refresh(), POLL_MS);
    return () => {
      window.clearInterval(sweep);
      window.clearInterval(poll);
    };
  }, [hub]);

  return hub;
}

// A tile's store: created on first use, kept live (read from the server) while the tile is mounted.
export function useSurface(hub: SurfaceHub, id: string): SurfaceSync {
  useEffect(() => hub.acquire(id), [hub, id]);
  return hub.surface(id);
}

export function useHubHistory(hub: SurfaceHub, prefix: string): HistoryFlags {
  const read = () => hub.history(prefix);
  return useSyncExternalStore(hub.subscribeHistory, read, read);
}
