import { useEffect } from "react";

// The room is h-dvh and never scrolls, yet iOS can leave the page scrolled after the keyboard closes
// (the "page stays zoomed and doesn't come back" look). Once the visual viewport is back to full height, scroll home.
export function useVisualViewportReset(win?: Window | null): void {
  useEffect(() => {
    const target = win ?? (typeof window === "undefined" ? null : window);
    const visual = target?.visualViewport;
    if (!target || !visual) return;
    const check = () => {
      if (visual.height >= 0.9 * target.innerHeight && (target.scrollY !== 0 || target.scrollX !== 0)) target.scrollTo(0, 0);
    };
    visual.addEventListener("resize", check);
    return () => visual.removeEventListener("resize", check);
  }, [win]);
}
