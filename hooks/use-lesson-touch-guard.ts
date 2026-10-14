import { useEffect } from "react";

// A lesson on a touch screen: the palm resting next to the stylus (on the board, the chat, a camera tile) must not select text
// and raise «Скопировать | Найти», lift an image or a link to drag it, open a long-press menu (Android) or set off the iPadOS
// three-finger copy, paste and undo. app/globals.css turns selection and the callout off under html[data-lesson-room]; these
// listeners stop the rest. Fields keep everything: typing, Paste and the three-finger undo in the chat and the text editor.
const FIELDS = "input, textarea, [contenteditable]";
const BLOCKING = { capture: true, passive: false } as const;

const inField = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.(FIELDS));

export function useLessonTouchGuard(coarse: boolean): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const doc = document, root = doc.documentElement;
    root.dataset.lessonRoom = "";
    if (!coarse) return () => { delete root.dataset.lessonRoom; };
    // The three-finger gestures start on the third touch and may go on moving; touchmove is only blocking while three are down,
    // so scrolling the chat never waits for the main thread.
    let watching = false;
    const onMove = (event: TouchEvent) => {
      if (event.cancelable && event.touches.length >= 3) event.preventDefault();
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length < 3 || inField(event.target)) return;
      if (event.cancelable) event.preventDefault();
      if (watching) return;
      watching = true;
      doc.addEventListener("touchmove", onMove, BLOCKING);
    };
    const onEnd = (event: TouchEvent) => {
      if (!watching || event.touches.length >= 3) return;
      watching = false;
      doc.removeEventListener("touchmove", onMove, BLOCKING);
    };
    const onMenuOrDrag = (event: Event) => {
      if (!inField(event.target)) event.preventDefault();
    };
    doc.addEventListener("touchstart", onStart, BLOCKING);
    doc.addEventListener("touchend", onEnd, true);
    doc.addEventListener("touchcancel", onEnd, true);
    doc.addEventListener("dragstart", onMenuOrDrag, true);
    doc.addEventListener("contextmenu", onMenuOrDrag, true);
    return () => {
      delete root.dataset.lessonRoom;
      doc.removeEventListener("touchstart", onStart, BLOCKING);
      doc.removeEventListener("touchmove", onMove, BLOCKING);
      doc.removeEventListener("touchend", onEnd, true);
      doc.removeEventListener("touchcancel", onEnd, true);
      doc.removeEventListener("dragstart", onMenuOrDrag, true);
      doc.removeEventListener("contextmenu", onMenuOrDrag, true);
    };
  }, [coarse]);
}
