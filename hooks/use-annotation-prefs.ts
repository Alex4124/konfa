"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_PREFS, mergePrefs, parsePrefs, PREFS_KEY, samePrefs, serializePrefs, toolPrefsPatch, type AnnotationPrefs, type PrefsPatch } from "@/lib/annotation-tools";
import type { UiTool } from "@/lib/confa-types";

// One store per JS realm: the main layer and the PiP layer share prefs and the armed tool.
// Prefs persist in localStorage (in memory when storage is blocked); the armed tool is session state for one share.
const listeners = new Set<() => void>();
let prefs: AnnotationPrefs | null = null;
let armed: { shareId: string; tool: UiTool } | null = null;
let storageWindow: Window | null = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readPrefs(): AnnotationPrefs {
  if (prefs) return prefs;
  if (typeof window === "undefined") return DEFAULT_PREFS;
  let raw: string | null = null;
  try { raw = storage()?.getItem(PREFS_KEY) ?? null; } catch { /* Blocked storage: defaults */ }
  prefs = parsePrefs(raw);
  return prefs;
}

function emit() {
  for (const listener of [...listeners]) listener();
}

// Another tab changed the prefs.
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== PREFS_KEY) return;
  const next = parsePrefs(event.key === null ? null : event.newValue);
  if (prefs && samePrefs(prefs, next)) return;
  prefs = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageWindow && typeof window !== "undefined") {
    storageWindow = window;
    storageWindow.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size || !storageWindow) return;
    storageWindow.removeEventListener("storage", onStorage);
    storageWindow = null;
  };
}

// Writes without notifying; true when something changed.
function storePrefs(patch: PrefsPatch): boolean {
  const current = readPrefs();
  const next = mergePrefs(current, patch);
  if (samePrefs(current, next)) return false;
  prefs = next;
  try { storage()?.setItem(PREFS_KEY, serializePrefs(next)); } catch { /* Quota or blocked storage: keep in memory */ }
  return true;
}

export function updateAnnotationPrefs(patch: PrefsPatch): void {
  if (storePrefs(patch)) emit();
}

const serverPrefs = () => DEFAULT_PREFS;

export function useAnnotationPrefs(): [AnnotationPrefs, (patch: PrefsPatch) => void] {
  return [useSyncExternalStore(subscribe, readPrefs, serverPrefs), updateAnnotationPrefs];
}

// Selecting a tool also remembers it (lastDrawTool and the line/shape variant) for the "Рисовать" button and later shares.
export function setArmedTool(shareId: string, tool: UiTool): void {
  const changed = armed?.shareId !== shareId || armed.tool !== tool;
  if (changed) armed = { shareId, tool };
  if (storePrefs(toolPrefsPatch(tool)) || changed) emit();
}

// Forget the armed tool of this share, so it falls back to the default again (permission flipped). Safe to call from effects.
export function resetArmedTool(shareId: string): void {
  if (armed?.shareId !== shareId) return;
  armed = null;
  emit();
}

export function useArmedTool(shareId: string, fallback: UiTool): [UiTool, (tool: UiTool) => void] {
  const read = useCallback(() => armed && armed.shareId === shareId ? armed.tool : fallback, [shareId, fallback]);
  const tool = useSyncExternalStore(subscribe, read, () => fallback);
  const set = useCallback((next: UiTool) => setArmedTool(shareId, next), [shareId]);
  return [tool, set];
}
