"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { DEFAULT_ASPECT, normalizePipSize, parsePipSize, PIP_SIZE_KEY, pipFallbackSize, pipInitialSize, serializePipSize, type PipSize } from "@/lib/presenter-pip";

// Document Picture-in-Picture (Chrome/Edge 116+, Firefox 151+) is not in lib.dom yet.
// width and height go together (one alone throws a RangeError); requestWindow needs transient activation and closes an open PiP window.
export type DocumentPipOptions = { width: number; height: number; disallowReturnToOpener?: boolean; preferInitialWindowPlacement?: boolean };
export type DocumentPip = EventTarget & { readonly window: Window | null; requestWindow(options?: DocumentPipOptions): Promise<Window> };
export type DocumentPipControls = { pipWindow: Window | null; open(fallbackSize?: PipSize): void; close(): void };

const UNAVAILABLE = "Окно пометок недоступно";
const UNAVAILABLE_HINT = "Новые пометки будут видны в заголовке вкладки.";
const ROOT_ATTRIBUTES = new Set(["class", "lang", "dir"]);

export function documentPip(win?: Window | null): DocumentPip | null {
  const host = win ?? (typeof window === "undefined" ? null : window);
  if (!host) return null;
  try {
    if (host.top !== host) return null; // only a top-level window may open one
    const api = (host as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
    return api && typeof api.requestWindow === "function" ? api : null;
  } catch {
    return null;
  }
}

const subscribeNever = () => () => {};
const readSupported = () => documentPip() !== null;
const serverSupported = () => false;

export function useDocumentPipSupported(): boolean {
  return useSyncExternalStore(subscribeNever, readSupported, serverSupported);
}

// One-time copy: every readable sheet as <style> (so nothing loads asynchronously), cross-origin sheets as <link>.
export function copyDocumentStyles(source: Document, target: Document): void {
  const root = source.documentElement;
  for (const attribute of Array.from(root.attributes)) {
    if (ROOT_ATTRIBUTES.has(attribute.name) || attribute.name.startsWith("data-")) target.documentElement.setAttribute(attribute.name, attribute.value);
  }
  const scheme = source.defaultView?.getComputedStyle(root).colorScheme;
  if (scheme && scheme !== "normal") target.documentElement.style.colorScheme = scheme;
  // Root-relative url() in copied rules must resolve against the app, not about:blank.
  if (target.baseURI !== source.baseURI) {
    const base = target.createElement("base");
    base.href = source.baseURI;
    target.head.insertBefore(base, target.head.firstChild);
  }
  const fragment = target.createDocumentFragment();
  for (const sheet of [...Array.from(source.styleSheets), ...(source.adoptedStyleSheets ?? [])]) {
    if (sheet.disabled) continue;
    const media = sheet.media.mediaText;
    let css: string | null = null;
    try {
      css = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
    } catch { /* Cross-origin rules are unreadable: link the sheet instead */ }
    if (css !== null) {
      const style = target.createElement("style");
      if (media) style.media = media;
      style.textContent = css;
      fragment.appendChild(style);
    } else if (sheet.href) {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      if (media) link.media = media;
      fragment.appendChild(link);
    }
  }
  target.head.appendChild(fragment);
}

function readSavedSize(): PipSize | null {
  try {
    return parsePipSize(window.localStorage.getItem(PIP_SIZE_KEY));
  } catch {
    return null;
  }
}

function saveSize(size: PipSize | null): void {
  if (!size) return;
  try { window.localStorage.setItem(PIP_SIZE_KEY, serializePipSize(size)); } catch { /* Blocked storage: the next window uses the fallback */ }
}

function availableScreen(): PipSize | null {
  try {
    return { width: window.screen.availWidth, height: window.screen.availHeight };
  } catch {
    return null;
  }
}

function viewportOf(win: Window): PipSize | null {
  return normalizePipSize({ width: win.innerWidth, height: win.innerHeight });
}

function preparePipDocument(win: Window, title: string): void {
  const doc = win.document;
  copyDocumentStyles(window.document, doc);
  doc.title = title;
  doc.body.className = `${window.document.body.className} overflow-hidden`.trim();
}

function unavailable(): void {
  toast(UNAVAILABLE, { id: "presenter-pip", description: UNAVAILABLE_HINT });
}

export function useDocumentPip(title: string): DocumentPipControls {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const current = useRef<Window | null>(null);
  const opening = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Leaving the room (unmount) or replacing the window closes the old one; pagehide then clears the state.
  useEffect(() => {
    if (!pipWindow) return;
    return () => pipWindow.close();
  }, [pipWindow]);

  // A later title change reaches the open window (the ref is the same window as the state).
  useEffect(() => {
    const win = current.current;
    if (win && win === pipWindow) win.document.title = title;
  }, [pipWindow, title]);

  // Call straight from a click handler: requestWindow runs before any await, while the click's activation lasts.
  const open = useCallback((fallbackSize?: PipSize) => {
    if (opening.current) return;
    const ours = current.current;
    if (ours && !ours.closed) {
      try { ours.focus(); } catch { /* Focus is best effort */ }
      return;
    }
    const api = documentPip();
    if (!api) {
      unavailable();
      return;
    }
    const size = pipInitialSize(fallbackSize ?? pipFallbackSize(DEFAULT_ASPECT, false), readSavedSize(), availableScreen());
    let request: Promise<Window>;
    try {
      request = api.requestWindow({ width: size.width, height: size.height });
    } catch {
      unavailable();
      return;
    }
    opening.current = true;
    request.then((win) => {
      if (!mounted.current) {
        win.close();
        return;
      }
      try {
        preparePipDocument(win, title);
      } catch (error) {
        win.close();
        throw error;
      }
      let last = viewportOf(win) ?? size;
      const onResize = () => { last = viewportOf(win) ?? last; };
      win.addEventListener("resize", onResize);
      win.addEventListener("pagehide", () => {
        win.removeEventListener("resize", onResize);
        saveSize(viewportOf(win) ?? last);
        if (current.current === win) current.current = null;
        setPipWindow((c) => (c === win ? null : c));
      }, { once: true });
      current.current = win;
      setPipWindow(win);
    }).catch(unavailable).finally(() => { opening.current = false; });
  }, [title]);

  const close = useCallback(() => {
    current.current?.close();
  }, []);

  return { pipWindow, open, close };
}
