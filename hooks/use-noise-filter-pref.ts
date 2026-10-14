"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_NOISE_FILTER, NOISE_FILTER_KEY, parseNoiseFilter, supportsNoiseFilter, type NoiseFilterChoice } from "@/lib/noise-filter";

// Whether this participant wants the microphone's noise suppression: their own choice, kept in localStorage (in memory
// when storage is blocked) and shared by the pre-join page and the room. Same scheme as hooks/use-camera-size.ts.
const listeners = new Set<() => void>();
let choice: NoiseFilterChoice | null = null;
let storageWindow: Window | null = null;

function read(): NoiseFilterChoice {
  if (choice) return choice;
  if (typeof window === "undefined") return DEFAULT_NOISE_FILTER;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(NOISE_FILTER_KEY); } catch { /* Blocked storage: the default */ }
  choice = parseNoiseFilter(raw);
  return choice;
}

function emit() {
  for (const listener of [...listeners]) listener();
}

// Another tab changed the choice.
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== NOISE_FILTER_KEY) return;
  const next = parseNoiseFilter(event.key === null ? null : event.newValue);
  if (choice === next) return;
  choice = next;
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

export function setNoiseFilter(next: NoiseFilterChoice): void {
  if (read() === next) return;
  choice = next;
  try { window.localStorage.setItem(NOISE_FILTER_KEY, next); } catch { /* Quota or blocked storage: keep in memory */ }
  emit();
}

const serverChoice = () => DEFAULT_NOISE_FILTER;

export function useNoiseFilterPref(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, serverChoice) === "on";
  return [on, (next) => setNoiseFilter(next ? "on" : "off")];
}

const never = () => () => {};
const assumeSupported = () => true;

// The server page assumes a browser that can run the filter; the client corrects it after hydration.
export function useNoiseFilterSupported(): boolean {
  return useSyncExternalStore(never, supportsNoiseFilter, assumeSupported);
}
