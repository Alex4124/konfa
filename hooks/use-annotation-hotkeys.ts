"use client";

import { useEffect, useEffectEvent } from "react";
import { hotkeyFor, type HotkeyAction } from "@/lib/annotation-tools";

type Options = {
  win: Window | null; // the layer's window (main tab or PiP)
  enabled: boolean;
  onAction: (action: HotkeyAction, event: KeyboardEvent) => boolean; // true = handled, the key's default is prevented
};

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

// Duck-typed, so elements of another window (PiP) count too.
function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NON_TEXT_INPUTS.has(((element as HTMLInputElement).type || "text").toLowerCase());
}

// Keys inside a popover, menu or dialog belong to it (Radix closes it on Esc), not to the tools behind it.
function insideOverlay(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return Boolean(element && typeof element.closest === "function" && element.closest("[data-slot=popover-content],[role=dialog],[role=alertdialog],[role=menu],[role=listbox]"));
}

// Capture listener on the window, so it runs before RoomView's Esc handler and Radix's document listeners.
export function useAnnotationHotkeys({ win, enabled, onAction }: Options): void {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat || isEditable(event.target) || insideOverlay(event.target)) return;
    const action = hotkeyFor(event);
    if (action && onAction(action, event)) event.preventDefault();
  });

  useEffect(() => {
    if (!win || !enabled) return;
    const listener = (event: KeyboardEvent) => handle(event);
    win.addEventListener("keydown", listener, { capture: true });
    return () => win.removeEventListener("keydown", listener, { capture: true });
  }, [win, enabled]);
}
