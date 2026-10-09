"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeWorkspace, type PendingWorkspace, type WorkspacePatch } from "@/lib/workspace";
import type { WorkspaceView } from "@/lib/confa-types";

type Options = {
  server: WorkspaceView | null | undefined; // the polled state
  post(body: Record<string, unknown>): Promise<Record<string, unknown>>; // POST /workspace, throws with the server's message
  refresh(): Promise<void>;
  onError(message: string): void;
};

export type WorkspaceControls = {
  view: WorkspaceView | null;
  // A teacher action: the patch shows at once and stays until the polled state reports the version the action produced.
  act(body: Record<string, unknown>, patch?: WorkspacePatch): Promise<boolean>;
  // Page turns: shown at once, sent once the clicks stop (FLIP_MS), one request per burst.
  flip(part: "board" | "doc", page: number): void;
};

const FLIP_MS = 150;

export function useWorkspace({ server, post, refresh, onError }: Options): WorkspaceControls {
  const [pending, setPending] = useState<PendingWorkspace | null>(null);
  const inflight = useRef(0);
  const newest = useRef(0);
  const timers = useRef(new Map<string, number>());
  const latest = useRef({ post, refresh, onError });
  useEffect(() => { latest.current = { post, refresh, onError }; });

  // The server caught up: drop the overlay.
  if (pending && pending.version !== null && server && server.version >= pending.version) setPending(null);

  const overlay = (patch: WorkspacePatch) => setPending((current) => ({ patch: { ...current?.patch, ...patch }, version: null }));

  const send = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    inflight.current++;
    let ok = false;
    try {
      const result = await latest.current.post(body);
      if (typeof result.version === "number") newest.current = Math.max(newest.current, result.version);
      ok = true;
    } catch (cause) {
      latest.current.onError(cause instanceof Error ? cause.message : "Не удалось изменить доску");
    } finally {
      inflight.current--;
      if (!ok) setPending(null);
      else if (inflight.current === 0 && timers.current.size === 0) setPending((current) => current && { ...current, version: newest.current });
      void latest.current.refresh();
    }
    return ok;
  }, []);

  const act = useCallback((body: Record<string, unknown>, patch?: WorkspacePatch) => {
    if (patch) overlay(patch);
    return send(body);
  }, [send]);

  const flip = useCallback((part: "board" | "doc", page: number) => {
    overlay(part === "board" ? { boardPage: page } : { docPage: page });
    const previous = timers.current.get(part);
    if (previous !== undefined) window.clearTimeout(previous);
    timers.current.set(part, window.setTimeout(() => {
      timers.current.delete(part);
      void send(part === "board" ? { action: "boardPage", page } : { action: "docPage", page });
    }, FLIP_MS));
  }, [send]);

  useEffect(() => {
    const scheduled = timers.current;
    return () => { for (const timer of scheduled.values()) window.clearTimeout(timer); };
  }, []);

  return { view: mergeWorkspace(server, pending), act, flip };
}
