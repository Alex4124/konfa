"use client";

import { useSyncExternalStore } from "react";
import { CAMERA_SIZE_KEY, DEFAULT_CAMERA_SIZE, parseCameraSize, type CameraSize } from "@/lib/tile-grid";

// How much room the cameras beside the board or a screen share may take: the viewer's own choice, kept in localStorage
// (in memory when storage is blocked) and shared by every strip on the page.
const listeners = new Set<() => void>();
let size: CameraSize | null = null;
let storageWindow: Window | null = null;

function read(): CameraSize {
  if (size) return size;
  if (typeof window === "undefined") return DEFAULT_CAMERA_SIZE;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(CAMERA_SIZE_KEY); } catch { /* Blocked storage: the default */ }
  size = parseCameraSize(raw);
  return size;
}

function emit() {
  for (const listener of [...listeners]) listener();
}

// Another tab changed the size.
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== CAMERA_SIZE_KEY) return;
  const next = parseCameraSize(event.key === null ? null : event.newValue);
  if (size === next) return;
  size = next;
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

export function setCameraSize(next: CameraSize): void {
  if (read() === next) return;
  size = next;
  try { window.localStorage.setItem(CAMERA_SIZE_KEY, next); } catch { /* Quota or blocked storage: keep in memory */ }
  emit();
}

const serverSize = () => DEFAULT_CAMERA_SIZE;

export function useCameraSize(): [CameraSize, (next: CameraSize) => void] {
  return [useSyncExternalStore(subscribe, read, serverSize), setCameraSize];
}
