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
};

export function useWorkspace({ server, post, refresh, onError }: Options): WorkspaceControls {
  const [pending, setPending] = useState<PendingWorkspace | null>(null);
  const inflight = useRef(0);
  const newest = useRef(0);
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
      else if (inflight.current === 0) setPending((current) => current && { ...current, version: newest.current });
      void latest.current.refresh();
    }
    return ok;
  }, []);

  const act = useCallback((body: Record<string, unknown>, patch?: WorkspacePatch) => {
    if (patch) overlay(patch);
    return send(body);
  }, [send]);

  return { view: mergeWorkspace(server, pending), act };
}
