"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { UiTool } from "@/lib/confa-types";

// x, y: the hotspot within the image.
export type CursorImage = { src: string; x: number; y: number };
type ToolCursor = { css: string; image: CursorImage };

const imageCursor = (image: CursorImage): ToolCursor => ({ css: `url("${image.src}") ${image.x} ${image.y}, crosshair`, image });
const PEN = imageCursor({ src: "/cursors/pen.svg", x: 4, y: 28 });
const MARKER = imageCursor({ src: "/cursors/marker.svg", x: 4, y: 28 });
const ERASER = imageCursor({ src: "/cursors/eraser.svg", x: 7, y: 25 });
const LASER = imageCursor({ src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Ccircle cx='8' cy='8' r='5' fill='%23ff3b5c' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E", x: 8, y: 8 });
// The OS draws these three itself; the images stand in only for a page-drawn cursor.
const TEXT: ToolCursor = { css: "text", image: { src: "/cursors/text.svg", x: 16, y: 16 } };
const GRAB: ToolCursor = { css: "grab", image: { src: "/cursors/grab.svg", x: 16, y: 14 } };
const CROSSHAIR: ToolCursor = { css: "crosshair", image: { src: "/cursors/crosshair.svg", x: 16, y: 16 } };

export function toolCursor(tool: UiTool, textTool: boolean): ToolCursor {
  if (tool === "laser") return LASER;
  if (textTool) return TEXT;
  if (tool === "move") return GRAB;
  if (tool === "pen") return PEN;
  if (tool === "marker") return MARKER;
  if (tool === "eraser") return ERASER;
  return CROSSHAIR;
}

// The cursor drawn by the page over `target`, whose own cursor is hidden (`cursor: none`). Used while this member shares a screen:
// Chrome paints the OS cursor into a window share whenever it is over the shared window's area, even with Konfa's window on top,
// so the pen over Konfa showed up a second time inside the share. A hidden OS cursor is not painted, and the page is not captured.
export function PageCursor({ target, image }: { target: Element; image: CursorImage }) {
  const ref = useRef<HTMLImageElement>(null);
  const at = useRef<{ x: number; y: number } | null>(null); // the pointer's last position (client px) while over the target

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const point = at.current;
      element.style.visibility = point ? "visible" : "hidden";
      if (point) element.style.transform = `translate(${point.x - image.x}px, ${point.y - image.y}px)`;
    };
    // A finger has no cursor; a mouse or a hovering stylus has one.
    const move = (event: Event) => {
      const pointer = event as PointerEvent;
      at.current = pointer.pointerType === "touch" ? null : { x: pointer.clientX, y: pointer.clientY };
      place();
    };
    const leave = () => {
      at.current = null;
      place();
    };
    place();
    target.addEventListener("pointerover", move);
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerdown", move);
    target.addEventListener("pointerleave", leave);
    return () => {
      target.removeEventListener("pointerover", move);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerdown", move);
      target.removeEventListener("pointerleave", leave);
    };
  }, [target, image]);

  // eslint-disable-next-line @next/next/no-img-element -- a 32 px cursor icon
  return createPortal(<img ref={ref} src={image.src} alt="" aria-hidden draggable={false} className="pointer-events-none fixed left-0 top-0 z-[2147483647] max-w-none select-none" style={{ visibility: "hidden" }} />, target.ownerDocument.body);
}
