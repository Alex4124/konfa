"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { decodeJson } from "@/lib/annotation-drafts";
import { createViewReceiver, createViewSender, nextStamp, parseViewPacket, VIEW_STALE_MS, VIEW_TOPIC, type PartView, type ViewPart, type ViewSender, type ViewSnapshot } from "@/lib/view-sync";
import { windowTimers } from "@/hooks/use-annotation-sync";
import type { Member } from "@/lib/confa-types";

type Options = {
  room: Room;
  members: readonly Member[];
  isHost: boolean;
  save(body: Record<string, unknown>): Promise<unknown>; // POST /workspace {action: "view"}: where the teacher is, for late joiners
};
type Publish = (data: Uint8Array, reliable: boolean) => Promise<void> | void;
// The workspace and the material a part belongs to: a view of another board or material is not followed.
export type FollowKey = Readonly<{ ws: string; docId: string | null }>;
// fresh: packets still arrive; once they stop (the teacher's connection dropped) the saved position takes over.
export type LedView = Readonly<{ pos: number; span: number; fresh: boolean }>;
export type WorkspaceFollow = {
  // A deliberate move of a part on this teacher's device (scrolled, jumped, pressed, opened): it leads the part from now on.
  touch(part: ViewPart): void;
  // The teacher's own view of a part: sent to everyone (lossy while it moves, reliably once settled) and saved.
  report(part: ViewPart, key: FollowKey, view: PartView, settled: boolean): void;
  subscribe(listener: () => void): () => void;
  // The part as the leading teacher's device shows it; null when nothing was received, or when this device leads it.
  led(part: ViewPart, key: FollowKey): LedView | null;
};

const SAVE_MS = 600;
const now = () => performance.now();
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

// Kept outside React state: view packets arrive a dozen times a second while the teacher scrolls, and only the two strips
// (useFollowTarget) need to re-render for them, not the room.
function createFollow() {
  const receiver = createViewReceiver();
  const listeners = new Set<() => void>();
  const stamps: Record<ViewPart, number> = { board: 0, doc: 0 };
  const shown = new Map<ViewPart, LedView>();
  const saved: Record<ViewPart, string | null> = { board: null, doc: null };
  const saveTimers: Record<ViewPart, number | null> = { board: null, doc: null };
  let config: Pick<Options, "members" | "save"> = { members: [], save: async () => undefined };
  let sender: ViewSender | null = null;
  let snapshot: ViewSnapshot | null = null;
  let staleTimer: number | null = null;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const api: WorkspaceFollow = {
    touch(part) {
      // Already newer than everything any device has sent: the stamp stays, so one device alone never changes it.
      if (!sender || stamps[part] > receiver.newest()) return;
      stamps[part] = nextStamp(Date.now(), Math.max(receiver.newest(), stamps.board, stamps.doc));
      emit();
    },
    report(part, key, view, settled) {
      if (!sender) return;
      const pos = round4(view.pos), sent = { pos, span: round4(view.span), at: stamps[part] };
      const base: ViewSnapshot = snapshot && snapshot.ws === key.ws ? snapshot : { ws: key.ws };
      const board = part === "board" ? sent : base.board;
      // A material that is no longer open leaves the snapshot.
      const doc = part === "doc" ? (key.docId ? { ...sent, id: key.docId } : undefined) : base.doc && base.doc.id === key.docId ? base.doc : undefined;
      snapshot = { ws: key.ws, ...(board ? { board } : {}), ...(doc ? { doc } : {}) };
      sender.update(snapshot, settled);
      if (!settled) return;
      // Another of the teacher's devices leads this part: that one saves where it is.
      const lead = receiver.lead(part, key.ws, key.docId);
      if (lead && lead.at > stamps[part]) return;
      const mark = `${part === "board" ? key.ws : key.docId}:${pos}`;
      if (saved[part] === mark) return;
      if (saveTimers[part] !== null) window.clearTimeout(saveTimers[part] as number);
      saveTimers[part] = window.setTimeout(() => {
        saveTimers[part] = null;
        saved[part] = mark;
        void config.save({ action: "view", part, pos }).catch(() => { saved[part] = null; }); // the next settled position is saved again
      }, SAVE_MS);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    led(part, key) {
      const lead = receiver.lead(part, key.ws, key.docId);
      if (!lead || (sender && lead.at <= stamps[part])) return null;
      const fresh = now() - lead.heard < VIEW_STALE_MS;
      const previous = shown.get(part);
      // The same object while nothing changed, for useSyncExternalStore.
      if (previous && previous.pos === lead.pos && previous.span === lead.span && previous.fresh === fresh) return previous;
      const next: LedView = { pos: lead.pos, span: lead.span, fresh };
      shown.set(part, next);
      return next;
    },
  };

  return {
    api,
    configure(next: Pick<Options, "members" | "save">) {
      config = next;
    },
    receive(identity: string, raw: unknown) {
      // Only the teacher moves everyone's view.
      if (config.members.find((member) => member.id === identity)?.role !== "host") return;
      const packet = parseViewPacket(raw);
      if (!packet || !receiver.accept(identity, packet, now())) return;
      // When packets stop, the listeners look again and fall back to the saved position.
      if (staleTimer !== null) window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => {
        staleTimer = null;
        emit();
      }, VIEW_STALE_MS + 50);
      emit();
    },
    forget(identity: string) {
      receiver.forget(identity);
      emit();
    },
    // The teacher's device starts sending; returns the cleanup.
    send(publish: Publish) {
      const created = createViewSender({ publish, now, timers: windowTimers, epoch: Date.now() });
      sender = created;
      snapshot = null;
      return () => {
        created.stop();
        if (sender === created) sender = null;
        for (const part of ["board", "doc"] as const) {
          if (saveTimers[part] !== null) window.clearTimeout(saveTimers[part] as number);
          saveTimers[part] = null;
        }
        emit();
      };
    },
    stop() {
      if (staleTimer !== null) window.clearTimeout(staleTimer);
      staleTimer = null;
    },
  };
}

// Students strictly follow the teacher's scroll of the board and the material (lib/view-sync). The returned object is stable.
export function useWorkspaceView({ room, members, isHost, save }: Options): WorkspaceFollow {
  const [follow] = useState(createFollow);
  useEffect(() => { follow.configure({ members, save }); });

  useEffect(() => {
    if (!isHost) return;
    return follow.send((data, reliable) => room.localParticipant.publishData(new Uint8Array(data), { reliable, topic: VIEW_TOPIC }));
  }, [follow, room, isHost]);

  // The teacher's devices listen too: each learns where the others are and who moved last.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic === VIEW_TOPIC && participant) follow.receive(participant.identity, decodeJson(payload));
    };
    const onLeft = (participant: RemoteParticipant) => follow.forget(participant.identity);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
      follow.stop();
    };
  }, [room, follow]);

  return follow.api;
}

// What a part shows besides the viewer's own scrolling. A student: the teacher's place and window — live, or the saved place
// until packets arrive and after they stop. A teacher's device: where another of the teacher's devices has moved the part
// since (null: this device leads).
export function useFollowTarget(follow: WorkspaceFollow, part: ViewPart, key: FollowKey, saved: number, host: boolean): { pos: number; span: number | null } | null {
  const led = useSyncExternalStore(follow.subscribe, () => follow.led(part, key), () => null);
  if (host) return led?.fresh ? { pos: led.pos, span: null } : null;
  if (!led) return { pos: saved, span: null };
  return led.fresh ? { pos: led.pos, span: led.span } : { pos: saved, span: led.span };
}
