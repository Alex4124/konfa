"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { decodeJson } from "@/lib/annotation-drafts";
import { createViewReceiver, createViewSender, parseViewPacket, VIEW_TOPIC, type PartView, type ViewPacket, type ViewSender, type ViewSnapshot } from "@/lib/view-sync";
import { windowTimers } from "@/hooks/use-annotation-sync";
import type { Member, WorkspaceView } from "@/lib/confa-types";

type Options = {
  room: Room;
  workspace: WorkspaceView | null;
  members: readonly Member[];
  isHost: boolean;
  save(body: Record<string, unknown>): Promise<unknown>; // POST /workspace {action: "view"}: where the teacher is, for late joiners
};
export type WorkspaceFollow = {
  // The teacher's own view of a part: sent to everyone (lossy while it moves, reliably once settled) and saved.
  report(part: "board" | "doc", view: PartView, settled: boolean): void;
  // What a student shows: the teacher's position and how many strip widths of rows the teacher sees (null: not known yet).
  target(part: "board" | "doc"): { pos: number; span: number | null };
};

const SAVE_MS = 600;
const now = () => performance.now();

// Students strictly follow the teacher's scroll of the board and the material (lib/view-sync).
export function useWorkspaceView({ room, workspace, members, isHost, save }: Options): WorkspaceFollow {
  const [packet, setPacket] = useState<ViewPacket | null>(null);
  const [receiver] = useState(createViewReceiver);
  const latest = useRef({ members, save, workspace });
  const snapshot = useRef<ViewSnapshot | null>(null);
  const saved = useRef<{ board: number | null; doc: string | null }>({ board: null, doc: null });
  const timers = useRef<{ board: number | null; doc: number | null }>({ board: null, doc: null });
  useEffect(() => { latest.current = { members, save, workspace }; });

  const sender = useRef<ViewSender | null>(null);
  useEffect(() => {
    if (!isHost) return;
    const created = createViewSender({
      publish: (data, reliable) => room.localParticipant.publishData(new Uint8Array(data), { reliable, topic: VIEW_TOPIC }),
      now, timers: windowTimers, epoch: Date.now(),
    });
    sender.current = created;
    const pending = timers.current;
    return () => {
      created.stop();
      sender.current = null;
      for (const part of ["board", "doc"] as const) if (pending[part] !== null) window.clearTimeout(pending[part] as number);
    };
  }, [room, isHost]);

  useEffect(() => {
    if (isHost) return;
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== VIEW_TOPIC || !participant) return;
      // Only the teacher moves everyone's view.
      if (latest.current.members.find((member) => member.id === participant.identity)?.role !== "host") return;
      const parsed = parseViewPacket(decodeJson(payload));
      if (parsed && receiver.accept(parsed, now())) setPacket(parsed);
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, receiver, isHost]);

  const report = useCallback((part: "board" | "doc", view: PartView, settled: boolean) => {
    const current = latest.current.workspace;
    if (!sender.current || !current) return;
    const pos = Math.round(view.pos * 1e4) / 1e4, span = Math.round(view.span * 1e4) / 1e4;
    const previous = snapshot.current?.ws === current.id ? snapshot.current : { ws: current.id };
    const docId = current.doc?.id;
    const next: ViewSnapshot = part === "board"
      ? { ...previous, board: { pos, span } }
      : docId ? { ...previous, doc: { id: docId, pos, span } } : previous;
    // A material that is no longer open leaves the snapshot.
    snapshot.current = next.doc && next.doc.id !== docId ? { ws: next.ws, ...(next.board ? { board: next.board } : {}) } : next;
    sender.current.update(snapshot.current, settled);
    if (!settled) return;
    const key = part === "board" ? "board" : `${docId}:${pos}`;
    if (part === "board" ? saved.current.board === pos : saved.current.doc === key) return;
    if (timers.current[part] !== null) window.clearTimeout(timers.current[part] as number);
    timers.current[part] = window.setTimeout(() => {
      timers.current[part] = null;
      if (part === "board") saved.current.board = pos;
      else saved.current.doc = key;
      void latest.current.save({ action: "view", part, pos }).catch(() => { /* The next settled position is saved again */ });
    }, SAVE_MS);
  }, []);

  const boardPos = workspace?.boardPos ?? 0, docPos = workspace?.doc?.pos ?? 0, docId = workspace?.doc?.id ?? null, workspaceId = workspace?.id ?? null;
  const target = useCallback((part: "board" | "doc") => {
    const live = packet && packet.ws === workspaceId ? (part === "board" ? packet.board : packet.doc && packet.doc.id === docId ? packet.doc : undefined) : undefined;
    const polled = part === "board" ? boardPos : docPos;
    if (!live) return { pos: polled, span: null };
    // Packets stopped (the teacher's connection dropped): the saved position takes over, the last known window size stays.
    return receiver.fresh(now()) ? { pos: live.pos, span: live.span } : { pos: polled, span: live.span };
  }, [packet, workspaceId, docId, boardPos, docPos, receiver]);

  return useMemo(() => ({ report, target }), [report, target]);
}
