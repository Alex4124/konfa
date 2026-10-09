import { useCallback, useSyncExternalStore } from "react";

function targetWindow(win?: Window | null): Window | null {
  return win ?? (typeof window === "undefined" ? null : window);
}

export function useMediaQuery(query: string, win?: Window | null): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = targetWindow(win)?.matchMedia(query);
    if (!list) return () => {};
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query, win]);
  const getSnapshot = useCallback(() => targetWindow(win)?.matchMedia(query).matches ?? false, [query, win]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
