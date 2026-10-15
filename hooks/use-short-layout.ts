import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { SHORT_QUERY, nextShort, type ShortState } from "@/lib/short-layout";

// The room's landscape-phone layout as html[data-short] (the `short:` variant in app/globals.css): kept while the on-screen
// keyboard has the height (lib/short-layout). On <html>, because the room's popovers render into <body>. One store per window:
// the room's and the presenter's PiP window, which copies the attribute once when it opens and then keeps its own.
const TYPING = "textarea, [contenteditable]:not([contenteditable=false]), input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=button],[type=submit],[type=reset])";
const KEYBOARD_MS = 600; // after a field lets go, the keyboard's closing resize is not the window's; then the height decides again

type Store = { state: ShortState; releasedAt: number; listeners: Set<() => void>; detach: (() => void) | null };
const stores = new WeakMap<Window, Store>();

const fresh = (win: Window): ShortState => ({ short: win.matchMedia(SHORT_QUERY).matches, width: win.innerWidth });
const mark = (win: Window, short: boolean) => { win.document.documentElement.toggleAttribute("data-short", short); };

function storeOf(win: Window): Store {
  let store = stores.get(win);
  if (!store) {
    store = { state: fresh(win), releasedAt: -Infinity, listeners: new Set(), detach: null };
    stores.set(win, store);
  }
  if (!store.detach) store.state = fresh(win); // nobody watched: whatever the window is now
  return store;
}

function decide(win: Window, store: Store) {
  const held = Boolean(win.document.activeElement?.matches(TYPING)) || win.performance.now() - store.releasedAt < KEYBOARD_MS;
  const next = nextShort(store.state, { matches: win.matchMedia(SHORT_QUERY).matches, width: win.innerWidth, held });
  if (next === store.state) return;
  const flipped = next.short !== store.state.short;
  store.state = next;
  if (!flipped) return;
  mark(win, next.short);
  for (const listener of store.listeners) listener();
}

function watch(win: Window, onChange: () => void): () => void {
  const store = storeOf(win);
  store.listeners.add(onChange);
  if (!store.detach) {
    const list = win.matchMedia(SHORT_QUERY);
    let timer = 0;
    const check = () => decide(win, store);
    const released = (event: FocusEvent) => {
      if (!(event.target as Element | null)?.matches?.(TYPING)) return;
      store.releasedAt = win.performance.now();
      win.clearTimeout(timer);
      timer = win.setTimeout(check, KEYBOARD_MS + 50);
    };
    list.addEventListener("change", check);
    win.addEventListener("resize", check);
    win.document.addEventListener("focusout", released, true);
    store.detach = () => {
      list.removeEventListener("change", check);
      win.removeEventListener("resize", check);
      win.document.removeEventListener("focusout", released, true);
      win.clearTimeout(timer);
    };
  }
  mark(win, store.state.short);
  return () => {
    store.listeners.delete(onChange);
    if (store.listeners.size) return;
    store.detach?.();
    store.detach = null;
    mark(win, false); // `short:` belongs to the room
  };
}

export function useShortLayout(win?: Window | null): boolean {
  const target = win ?? (typeof window === "undefined" ? null : window);
  const subscribe = useCallback((onChange: () => void) => target ? watch(target, onChange) : () => {}, [target]);
  const getSnapshot = useCallback(() => target ? storeOf(target).state.short : false, [target]);
  const short = useSyncExternalStore(subscribe, getSnapshot, () => false);
  // Before the first paint (the subscription comes after it): a room opened on a landscape phone starts as a rail.
  useLayoutEffect(() => { if (target) mark(target, short); }, [target, short]);
  return short;
}
