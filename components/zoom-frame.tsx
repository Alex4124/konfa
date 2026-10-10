"use client";

import { createContext, useCallback, useContext, useImperativeHandle, useLayoutEffect, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fitBox, type Size } from "@/lib/annotation-geometry";
import { clampToBand, clampTransform, DEFAULT_MAX_ZOOM, ensureMinScale, IDENTITY_VIEW, isDoubleTap, isPannable, isTap, isZoomed, maxScaleFor, panBy, pinch, routePointerDown, toggleStripZoom, toggleZoom, TOP_VIEW, toTransform, wheelPan, wheelZoomFactor, ZOOM_STEP, zoomAt, zoomOutAt, zoomPercent, type Band, type PinchStart, type PointerRoute, type Tap, type View, type XY } from "@/lib/view-transform";
import type { Point } from "@/lib/confa-types";

export type FrameInteraction = "draw" | "view";
export type FrameInfo = {
  box: Size;
  aspect: number;
  ready: boolean;
  scale: number;
  zoomable: boolean;
  interaction: FrameInteraction;
  penOnly: boolean;
  setPenOnly(value: boolean): void;
  onGestureStart(listener: () => void): () => void;
  ensureScale(minScale: number, focus: Point): void;
  overlay: HTMLElement | null;
};
// What a strip's owner needs from outside the frame: where the view is (also mid-gesture) and a way to move it.
export type FrameState = { view: View; box: Size; viewport: Size; max: number };
export type FrameController = {
  get(): FrameState;
  apply(change: (view: View, state: FrameState) => View, animate?: boolean): void; // moves and commits
  preview(change: (view: View, state: FrameState) => View): void; // moves now, commits once the moves stop (following)
  subscribe(listener: () => void): () => void; // every shown view: gesture frames, commits, resizes
};
type Props = {
  frame: Size | null; // the content's pixel size (aspect, zoom limit); null until known
  // "width": a scrolling strip. The frame is `boxWidth` wide (default: the viewport's width) and as tall as its aspect makes
  // it, usually far taller than the viewport; the view starts at its top, a plain wheel and a drag in «Просмотр» scroll it.
  fit?: "contain" | "width";
  boxWidth?: number;
  band?: Band | null; // strip only, in strip widths: the rows the view may show (the board's used part, a follower's window)
  locked?: boolean; // strip only: no scrolling by wheel, drag or fling (a follower), zoom stays
  glide?: boolean; // a view change that comes from the props (the teacher scrolled) eases in instead of jumping
  controller?: Ref<FrameController>;
  penOnly?: boolean; // controlled: several frames behind one toolbar share the flag
  onPenOnlyChange?: (value: boolean) => void;
  controlsClassName?: string; // where the zoom buttons sit
  media?: ReactNode; // drawn in the frame under the children (the video, a page image, the board)
  children?: ReactNode;
  className?: string;
  frameClassName?: string; // the frame's background
  frameless?: boolean;
  zoomable?: boolean;
  interaction?: FrameInteraction;
  fingersDraw?: boolean; // «Пальцы тоже рисуют»: a pen contact does not switch fingers to pan and zoom
  resetKey?: string | null;
  zoomLabel?: string;
};
// What the gesture handlers read at event time (written after every render). band: in frame px at scale 1.
type Geometry = { view: View; box: Size; viewport: Size; max: number; interaction: FrameInteraction; penOnly: boolean; fingersDraw: boolean; strip: boolean; band: Band | null; locked: boolean };
type Zoomer = { current(): View; apply(change: (view: View, geometry: Geometry) => View, animate?: boolean): void; preview(change: (view: View, geometry: Geometry) => View): void };
type Tracked = { type: string; route: PointerRoute; at: XY; down: Tap };
type GestureStart = { kind: "pan"; id: number; view: View; from: XY } | { kind: "pinch"; ids: [number, number]; start: PinchStart };

const DEFAULT_ASPECT = 16 / 9;
const WHEEL_SETTLE_MS = 160; // Ctrl+wheel and trackpad pinch commit once the wheel goes quiet
const ANIMATE_MS = 160;
const TOUCH_DBLCLICK_MS = 800; // a dblclick this soon after a touch or pen tap was synthesized from it
const FLING_MIN_SPEED = 0.35; // px/ms at release for a strip to keep rolling
const FLING_STOP_SPEED = 0.02;
const FLING_DECAY_MS = 325;
const GLIDE_MS = 110; // a follower's step between two of the teacher's positions (sent every ~80 ms)
const EMPTY: Size = { width: 0, height: 0 };
const now = () => performance.now();

export const FrameContext = createContext<FrameInfo | null>(null);

export function useFrame(): FrameInfo {
  const info = useContext(FrameContext);
  if (!info) throw new Error("useFrame() must be used inside <ZoomFrame> or <SharedScreen>");
  return info;
}

const centreOf = (size: Size): XY => ({ x: size.width / 2, y: size.height / 2 });

// Fine pointers: −, {pct}%, + (shown on hover until zoomed). Coarse pointers: only a «{pct}% ✕» reset chip while zoomed.
// Out of the way while a text's buttons are shown: they sit inside the frame, below this row, and may reach its corner.
function ZoomControls({ label, percent, zoomed, canZoomIn, className, onZoom, onReset }: { label: string; percent: number; zoomed: boolean; canZoomIn: boolean; className: string; onZoom: (factor: number) => void; onReset: () => void }) {
  const round = "rounded-full text-white hover:bg-white/10 hover:text-white";
  return <div data-gesture-ignore className={`pointer-events-none absolute z-20 flex items-center transition-opacity group-has-data-[annotating=true]/screen:opacity-0 group-has-data-text-editor/screen:invisible ${className}`}>
    <div role="group" aria-label={label} className={`flex items-center gap-0.5 rounded-full border border-white/15 bg-[#12243a]/90 p-0.5 text-white shadow-xl transition-opacity pointer-coarse:hidden ${zoomed ? "pointer-events-auto" : "opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/screen:pointer-events-auto group-hover/screen:opacity-100"}`}>
      <Button variant="ghost" size="icon-sm" title="Отдалить" aria-label="Отдалить" disabled={!zoomed} className={round} onClick={() => onZoom(1 / ZOOM_STEP)}><ZoomOut /></Button>
      <Button variant="ghost" size="sm" title="Сбросить масштаб" aria-label={`Масштаб ${percent}%. Сбросить масштаб`} className={`h-8 min-w-12 px-2 text-xs tabular-nums ${round}`} onClick={onReset}>{percent}%</Button>
      <Button variant="ghost" size="icon-sm" title="Приблизить" aria-label="Приблизить" disabled={!canZoomIn} className={round} onClick={() => onZoom(ZOOM_STEP)}><ZoomIn /></Button>
    </div>
    {zoomed && <Button variant="secondary" size="sm" title="Сбросить масштаб" aria-label={`Масштаб ${percent}%. Сбросить масштаб`} className="pointer-events-auto hidden h-9 gap-1.5 rounded-full border border-white/15 bg-[#12243a]/90 px-3 text-sm tabular-nums text-white shadow-xl hover:bg-[#1c2c45] pointer-coarse:inline-flex" onClick={onReset}>{percent}%<X size={16} /></Button>}
  </div>;
}

// A frame of known aspect with zoom and pan (Ctrl+wheel, pinch, buttons) and the gesture arbiter that decides per pointer
// whether it pans or reaches the annotation layer in `children`. Fitted whole into its box (the share), or a scrolling strip
// as wide as its box whose tiles are <FrameTile>s (the board, a material).
export function ZoomFrame({ frame, media, children, className = "", frameClassName = "bg-black", frameless = false, zoomable = false, interaction = "view", fingersDraw = false, resetKey = null, zoomLabel = "Масштаб демонстрации", fit = "contain", boxWidth, band = null, locked = false, glide = false, controller, penOnly: penOnlyProp, onPenOnlyChange, controlsClassName = "bottom-2 right-2" }: Props) {
  const strip = fit === "width";
  const home = strip ? TOP_VIEW : IDENTITY_VIEW;
  const [viewport, setViewport] = useState<Size>(EMPTY);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [ownPenOnly, setOwnPenOnly] = useState(false);
  const [storedView, setStoredView] = useState<View>(home);
  const [viewKey, setViewKey] = useState(resetKey);
  const [gestureListeners] = useState(() => new Set<() => void>());
  const [viewListeners] = useState(() => new Set<() => void>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const geometry = useRef<Geometry>({ view: home, box: EMPTY, viewport: EMPTY, max: DEFAULT_MAX_ZOOM, interaction, penOnly: false, fingersDraw, strip, band: null, locked });
  const zoomer = useRef<Zoomer | null>(null);
  const penOnly = penOnlyProp ?? ownPenOnly;
  const penOnlyChanged = useRef(onPenOnlyChange);
  const setPenOnly = useCallback((value: boolean) => {
    setOwnPenOnly(value);
    penOnlyChanged.current?.(value);
  }, []);

  if (viewKey !== resetKey) {
    setViewKey(resetKey);
    setStoredView(home);
  }

  const aspect = frame && frame.width > 0 && frame.height > 0 ? frame.width / frame.height : DEFAULT_ASPECT;
  const stripWidth = boxWidth && boxWidth > 0 ? Math.min(boxWidth, viewport.width) : viewport.width;
  const box = useMemo(() => strip ? { width: stripWidth, height: stripWidth / aspect } : fitBox(viewport, aspect), [strip, stripWidth, viewport, aspect]);
  const ready = Boolean(frame) && box.width > 0 && box.height > 0;
  const max = maxScaleFor(frame, box);
  const bandTop = band ? band.top * box.width : 0, bandBottom = band ? band.bottom * box.width : 0;
  const bandPx = useMemo<Band | null>(() => strip && band ? { top: bandTop, bottom: bandBottom } : null, [strip, band, bandTop, bandBottom]);
  // The stored view keeps the point the viewer looked at; a resize or a new frame size only re-clamps what is shown.
  const fitted = zoomable ? clampTransform(storedView, box, viewport, max) : home;
  const view = bandPx && zoomable ? clampToBand(fitted, bandPx, box, viewport, max) : fitted;
  const transform = toTransform(view, box, viewport, max);
  const scale = view.scale;
  const zoomed = isZoomed(view);
  const pannable = strip ? isPannable(view, box, viewport, max, bandPx) : zoomed;

  useLayoutEffect(() => {
    geometry.current = { view, box, viewport, max, interaction, penOnly, fingersDraw, strip, band: bandPx, locked };
    penOnlyChanged.current = onPenOnlyChange;
  });

  // The transform is never in the JSX: gestures write it straight to the element between commits.
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (element) {
      // Gestures switch the transition off again (stopAnimation) before they write.
      if (glide) element.style.transition = `transform ${GLIDE_MS}ms linear`;
      element.style.transform = transform;
    }
    for (const listener of [...viewListeners]) listener();
  }, [transform, box, viewport, viewListeners, glide]);

  useEffect(() => {
    const element = viewportRef.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (!element || !Observer) return;
    const observer = new Observer(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Zoom arbiter: capture-phase listeners on the viewport decide per pointer whether it pans/zooms the frame
  // or reaches the annotation layer (lib/view-transform routePointerDown). Re-bound per share, which drops a gesture in flight.
  useEffect(() => {
    const element = viewportRef.current, content = frameRef.current;
    const win = element?.ownerDocument.defaultView;
    if (!zoomable || !element || !content || !win) return;
    const pointers = new Map<number, Tracked>();
    let live: View | null = null; // shown but not yet committed to state
    let start: GestureStart | null = null;
    let multi = false; // the touch gesture had two pointers at some point: its pointerups are not taps
    let lastTap: Tap | null = null;
    let touchAt = -Infinity;
    let raf = 0, settle = 0, unanimate = 0, flingFrame = 0;
    let speed: { x: number; y: number; t: number } | null = null; // of a one-finger pan, px/ms (for the fling)

    const geo = () => geometry.current;
    const current = () => live ?? geo().view;
    const held = (next: View): View => {
      const g = geo();
      return g.band ? clampToBand(next, g.band, g.box, g.viewport, g.max) : next;
    };
    const tell = () => {
      for (const listener of [...viewListeners]) listener();
    };
    const local = (event: { clientX: number; clientY: number }): XY => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const write = (next: View) => {
      const g = geo();
      content.style.transform = toTransform(next, g.box, g.viewport, g.max);
    };
    // Snaps a zoom animation to its end. "none", not "": with the initial `all 0s` a running transition keeps running.
    const stopAnimation = () => {
      if (unanimate) win.clearTimeout(unanimate);
      unanimate = 0;
      if (content.style.transition) content.style.transition = "none";
    };
    const paint = () => {
      raf = 0;
      if (!live) return;
      write(live);
      tell();
    };
    const show = (next: View) => {
      live = held(next);
      stopAnimation();
      content.style.willChange = "transform";
      if (!raf) raf = win.requestAnimationFrame(paint);
    };
    const commit = (animate = false) => {
      if (raf) win.cancelAnimationFrame(raf);
      if (settle) win.clearTimeout(settle);
      raf = 0;
      settle = 0;
      const next = live ? held(live) : null;
      live = null;
      content.style.willChange = "";
      if (!next) return;
      stopAnimation(); // a leftover transition would animate this write, and its timer would cut a new one short
      if (animate && !win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        content.style.transition = `transform ${ANIMATE_MS}ms ease-out`;
        unanimate = win.setTimeout(stopAnimation, ANIMATE_MS + 60);
      }
      write(next);
      // Seen by the next event even before React re-renders.
      geometry.current = { ...geo(), view: next };
      setStoredView(next);
      tell();
    };
    const settleSoon = () => {
      if (settle) win.clearTimeout(settle);
      settle = win.setTimeout(() => {
        settle = 0;
        if (!start) commit();
      }, WHEEL_SETTLE_MS);
    };
    // A strip keeps rolling after a quick one-finger swipe, slowing down until it stops or something touches it.
    const stopFling = () => {
      if (!flingFrame) return;
      win.cancelAnimationFrame(flingFrame);
      flingFrame = 0;
      commit();
    };
    const fling = (vx: number, vy: number) => {
      let last = now();
      const roll = () => {
        const t = now(), dt = Math.min(64, t - last);
        last = t;
        const g = geo(), from = current();
        const next = held(panBy(from, vx * dt, vy * dt, g.box, g.viewport, g.max));
        const decay = Math.exp(-dt / FLING_DECAY_MS);
        vx *= decay;
        vy *= decay;
        if (next === from || Math.hypot(vx, vy) < FLING_STOP_SPEED) {
          flingFrame = 0;
          live = next;
          commit();
          return;
        }
        live = next;
        write(next);
        tell();
        flingFrame = win.requestAnimationFrame(roll);
      };
      content.style.willChange = "transform";
      flingFrame = win.requestAnimationFrame(roll);
    };
    const capture = (pointerId: number) => {
      try { element.setPointerCapture(pointerId); } catch { /* The pointer is already gone */ }
    };
    // Gestures restart from what is on screen whenever a pointer joins or leaves.
    const restart = () => {
      const active = [...pointers].filter(([, pointer]) => pointer.route === "gesture");
      const view = current();
      if (active.length >= 2) {
        const [[a, first], [b, second]] = active;
        multi = true;
        start = { kind: "pinch", ids: [a, b], start: { view, p1: first.at, p2: second.at } };
      } else if (active.length === 1) {
        const [[id, pointer]] = active;
        start = { kind: "pan", id, view, from: pointer.at };
      } else start = null;
    };
    const ignored = (event: Event) => {
      const target = event.target as Element | null;
      return typeof target?.closest === "function" && Boolean(target.closest("[data-gesture-ignore]"));
    };
    // The pen beats a finger that landed first (usually the palm): the layer drops that finger's stroke, a pan or pinch it drove
    // stops where it is, and the finger is ignored until it lifts.
    const blockPalms = () => {
      const palms = [...pointers].filter(([, pointer]) => pointer.type === "touch" && pointer.route !== "block");
      if (!palms.length) return;
      if (palms.some(([, pointer]) => pointer.route === "pass")) for (const listener of [...gestureListeners]) listener();
      const steering = palms.some(([, pointer]) => pointer.route === "gesture");
      for (const [id, pointer] of palms) {
        pointer.route = "block";
        capture(id);
      }
      if (!steering) return;
      if ([...pointers.values()].some((pointer) => pointer.route === "gesture")) {
        restart();
        return;
      }
      start = null;
      multi = false;
      commit();
    };

    const onDown = (event: PointerEvent) => {
      if (ignored(event)) return;
      stopFling();
      speed = null;
      stopAnimation(); // the layer measures the frame for this pointer: not mid-animation
      pointers.delete(event.pointerId); // its pointerup was lost
      const g = geo();
      const type = event.pointerType || "mouse";
      if (type !== "mouse") touchAt = now();
      let otherTouches = 0, penDown = false;
      for (const pointer of pointers.values()) {
        if (pointer.type === "touch") otherTouches++;
        else if (pointer.type === "pen") penDown = true;
      }
      // A strip scrolls at any zoom, so there a mouse drag in «Просмотр» pans whenever there is somewhere to go.
      const zoomed = g.strip ? isPannable(current(), g.box, g.viewport, g.max, g.band) : isZoomed(current());
      const decision = routePointerDown({ pointerType: type, button: event.button, interaction: g.interaction, penOnly: g.penOnly, penDown, otherTouches, zoomed, primary: event.isPrimary });
      if (decision.penOnly && !g.penOnly && !g.fingersDraw) {
        geometry.current = { ...g, penOnly: true };
        setPenOnly(true);
      }
      const at = local(event);
      const tracked: Tracked = { type, route: decision.route, at, down: { t: now(), x: at.x, y: at.y } };
      if (decision.route === "pass") {
        if (type === "pen") blockPalms();
        if (type !== "mouse") pointers.set(event.pointerId, tracked);
        return;
      }
      pointers.set(event.pointerId, tracked);
      // A blocked palm is swallowed and captured, so its moves and click never reach the layer.
      if (decision.route === "block") {
        event.preventDefault();
        event.stopPropagation();
        capture(event.pointerId);
        return;
      }
      // A gesture's pointerdown still reaches the document: open popovers close. preventDefault (no text selection or native drag)
      // also tells the layer to skip it; a touch in Просмотр, where the layer takes no pointer, keeps it so a tap still moves focus.
      if (type !== "touch" || g.interaction === "draw") event.preventDefault();
      // The layer drops its stroke before it loses the pointer capture (lostpointercapture without pointerup = cancel).
      for (const listener of [...gestureListeners]) listener();
      for (const [id, pointer] of pointers) {
        if (pointer.route !== "pass" || pointer.type !== "touch") continue;
        pointer.route = "gesture";
        capture(id);
      }
      capture(event.pointerId);
      if (type === "mouse") element.style.cursor = "grabbing";
      restart();
    };

    const onMove = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      if (pointer.route === "pass") {
        if (pointer.type === "touch") pointer.at = local(event); // a second finger turns it into a pinch from here
        return;
      }
      event.stopPropagation();
      if (pointer.route === "block") return;
      const before = pointer.at;
      pointer.at = local(event);
      const g = geo();
      if (start?.kind === "pinch") {
        speed = null;
        const a = pointers.get(start.ids[0]), b = pointers.get(start.ids[1]);
        if (a && b) show(pinch(start.start, a.at, b.at, g.box, g.viewport, g.max));
      } else if (start?.kind === "pan" && start.id === event.pointerId) {
        const t = now();
        if (speed && t > speed.t) {
          const dt = t - speed.t, mix = Math.min(1, dt / 50);
          speed = { x: speed.x + mix * ((pointer.at.x - before.x) / dt - speed.x), y: speed.y + mix * ((pointer.at.y - before.y) / dt - speed.y), t };
        } else speed ??= { x: 0, y: 0, t };
        show(panBy(start.view, pointer.at.x - start.from.x, pointer.at.y - start.from.y, g.box, g.viewport, g.max));
      }
    };

    const end = (event: PointerEvent, tapAllowed: boolean, ours = true) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      pointers.delete(event.pointerId);
      if (pointer.route === "pass") return;
      if (ours) event.stopPropagation();
      if (pointer.route === "block") return;
      if (pointer.type === "mouse") element.style.cursor = "";
      if ([...pointers.values()].some((other) => other.route === "gesture")) {
        restart();
        return;
      }
      start = null;
      const single = !multi;
      multi = false;
      if (tapAllowed && single && pointer.type !== "mouse") {
        const at = local(event);
        const tap: Tap = { t: now(), x: at.x, y: at.y };
        if (!isTap(pointer.down, tap)) lastTap = null;
        else if (isDoubleTap(lastTap, tap)) {
          lastTap = null;
          const g = geo();
          live = (g.strip ? toggleStripZoom : toggleZoom)(current(), tap, g.box, g.viewport, g.max);
          commit(true);
          return;
        } else lastTap = tap;
      }
      const released = speed;
      speed = null;
      const g = geo();
      if (g.strip && !g.locked && single && pointer.type === "touch" && released && now() - released.t < 80 && Math.hypot(released.x, released.y) >= FLING_MIN_SPEED) {
        fling(released.x, released.y);
        return;
      }
      commit();
    };
    const onUp = (event: PointerEvent) => end(event, true);
    const onCancel = (event: PointerEvent) => end(event, false);
    // Capture taken away without a pointerup (the element left the page): end the gesture where it is.
    const onLostCapture = (event: PointerEvent) => {
      if (event.target === element) end(event, false);
    };
    // A tracked pointer that ends elsewhere (its element left the page mid-stroke) must not count as a finger still down.
    const doc = element.ownerDocument;
    const onEndOutside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node | null)) end(event, false, false); // never stop an event meant for something else
    };

    // Mouse in Просмотр: double click zooms in about the cursor, or back out.
    const onDoubleClick = (event: MouseEvent) => {
      if (geo().interaction !== "view" || now() - touchAt < TOUCH_DBLCLICK_MS || ignored(event)) return;
      const g = geo();
      live = (g.strip ? toggleStripZoom : toggleZoom)(current(), local(event), g.box, g.viewport, g.max);
      commit(true);
    };

    // Ctrl+wheel and the trackpad pinch of Chrome, Edge and Firefox (they set ctrlKey); never the page zoom over the frame.
    // A plain wheel scrolls a strip (Shift: sideways).
    const onWheel = (event: WheelEvent) => {
      const g = geo();
      if (!event.ctrlKey) {
        if (!g.strip || ignored(event)) return;
        event.preventDefault();
        if (g.locked && !isZoomed(current())) return;
        stopFling();
        const by = wheelPan(event.deltaX, event.deltaY, event.deltaMode, event.shiftKey, g.viewport);
        show(panBy(current(), by.x, by.y, g.box, g.viewport, g.max));
        if (start) restart();
        else settleSoon();
        return;
      }
      event.preventDefault();
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, true);
      if (factor === 1) return;
      stopFling();
      show(zoomAt(current(), factor, local(event), g.box, g.viewport, g.max));
      if (start) {
        restart();
        return;
      }
      settleSoon();
    };
    // iOS: no page pinch over the frame (touch-action alone is not always honoured once two fingers are down).
    // A pan is consumed too, so a fast swipe leaves no browser fling behind that would swallow the next tap.
    const onTouchMove = (event: TouchEvent) => {
      if (event.cancelable && (event.touches.length > 1 || start)) event.preventDefault();
    };
    const onGesture = (event: Event) => event.preventDefault();
    // The viewport clips content larger than itself, and the browser may scroll it natively to reveal the caret of an open
    // text: the transform is the only scrolling there is, so that is undone at once.
    const onScroll = () => {
      if (element.scrollTop) element.scrollTop = 0;
      if (element.scrollLeft) element.scrollLeft = 0;
    };

    zoomer.current = {
      current,
      apply(change, animate = false) {
        stopFling();
        live = change(current(), geo());
        commit(animate);
        if (start) restart();
      },
      preview(change) {
        if (flingFrame) stopFling();
        show(change(current(), geo()));
        if (start) restart();
        else settleSoon();
      },
    };
    element.addEventListener("pointerdown", onDown, true);
    element.addEventListener("pointermove", onMove, true);
    element.addEventListener("pointerup", onUp, true);
    element.addEventListener("pointercancel", onCancel, true);
    element.addEventListener("lostpointercapture", onLostCapture, true);
    doc.addEventListener("pointerup", onEndOutside, true);
    doc.addEventListener("pointercancel", onEndOutside, true);
    element.addEventListener("dblclick", onDoubleClick);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("gesturestart", onGesture);
    element.addEventListener("scroll", onScroll);
    return () => {
      element.removeEventListener("pointerdown", onDown, true);
      element.removeEventListener("pointermove", onMove, true);
      element.removeEventListener("pointerup", onUp, true);
      element.removeEventListener("pointercancel", onCancel, true);
      element.removeEventListener("lostpointercapture", onLostCapture, true);
      doc.removeEventListener("pointerup", onEndOutside, true);
      doc.removeEventListener("pointercancel", onEndOutside, true);
      element.removeEventListener("dblclick", onDoubleClick);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("gesturestart", onGesture);
      element.removeEventListener("scroll", onScroll);
      if (raf) win.cancelAnimationFrame(raf);
      if (flingFrame) win.cancelAnimationFrame(flingFrame);
      if (settle) win.clearTimeout(settle);
      stopAnimation();
      // A dropped gesture leaves the committed view on screen (the share changed, or zoom was switched off).
      if (live) write(geo().view);
      content.style.willChange = "";
      element.style.cursor = "";
      zoomer.current = null;
    };
  }, [zoomable, resetKey, gestureListeners, viewListeners, setPenOnly]);

  const onGestureStart = useCallback((listener: () => void) => {
    gestureListeners.add(listener);
    return () => { gestureListeners.delete(listener); };
  }, [gestureListeners]);

  // Text tool: zoom in about the point until text of this size is readable (no-op without zoom).
  const ensureScale = useCallback((minScale: number, focus: Point) => {
    zoomer.current?.apply((current, g) => ensureMinScale(current, minScale, focus, g.box, g.viewport, g.max));
  }, []);

  const zoomBy = (factor: number) => zoomer.current?.apply((current, g) => zoomAt(current, factor, centreOf(g.viewport), g.box, g.viewport, g.max), true);
  const resetZoom = () => zoomer.current?.apply((current, g) => g.strip ? zoomOutAt(current, centreOf(g.viewport), g.box, g.viewport, g.max) : clampTransform(IDENTITY_VIEW, g.box, g.viewport, g.max), true);

  useImperativeHandle(controller, () => {
    const state = (): FrameState => {
      const g = geometry.current;
      return { view: zoomer.current?.current() ?? g.view, box: g.box, viewport: g.viewport, max: g.max };
    };
    return {
      get: state,
      apply: (change, animate) => zoomer.current?.apply((current) => change(current, state()), animate),
      preview: (change) => zoomer.current?.preview((current) => change(current, state())),
      subscribe(listener) {
        viewListeners.add(listener);
        return () => { viewListeners.delete(listener); };
      },
    };
  }, [viewListeners]);

  const info = useMemo<FrameInfo>(() => ({ box, aspect, ready, scale, zoomable, interaction, penOnly, setPenOnly, onGestureStart, ensureScale, overlay }), [box, aspect, ready, scale, zoomable, interaction, penOnly, setPenOnly, onGestureStart, ensureScale, overlay]);

  // A strip's frame element has no height of its own (its tiles are placed by `top` and overflow it), so the browser never
  // has to composite one layer hundreds of screens tall.
  return <div ref={viewportRef} className={`group/screen relative h-full w-full overflow-hidden ${zoomable ? `touch-none [-webkit-touch-callout:none] ${pannable && interaction === "view" ? "cursor-grab" : ""}` : ""} ${className}`}>
    <div ref={frameRef} className={strip ? "absolute left-0 top-0" : `absolute left-0 top-0 overflow-hidden ${frameClassName} ${frameless ? "" : "rounded-lg"}`} style={{ width: box.width, height: strip ? 0 : box.height, transformOrigin: "0 0" }}>
      {media}
      <FrameContext.Provider value={info}>{children}</FrameContext.Provider>
    </div>
    <div ref={setOverlay} className="pointer-events-none absolute inset-0 z-10" />
    {zoomable && ready && <ZoomControls label={zoomLabel} percent={zoomPercent(view)} zoomed={zoomed} canZoomIn={scale < max - 0.001} className={controlsClassName} onZoom={zoomBy} onReset={resetZoom} />}
  </div>;
}

// One tile of a strip (a board band, a material page): placed at `top` (strip widths), `aspect` wide to tall. The annotation
// layer inside sees it as its frame: its own box, the strip's zoom and gesture arbiter.
export function FrameTile({ top, aspect, className = "", children }: { top: number; aspect: number; className?: string; children?: ReactNode }) {
  const strip = useFrame();
  const width = strip.box.width, height = aspect > 0 ? width / aspect : width;
  const stripAspect = strip.aspect, ensure = strip.ensureScale;
  // The text tool names a point of the tile; the strip zooms about the same point of itself.
  const ensureScale = useCallback((minScale: number, focus: Point) => ensure(minScale, [focus[0], (top + focus[1] / aspect) * stripAspect]), [ensure, top, aspect, stripAspect]);
  const info = useMemo<FrameInfo>(() => ({ ...strip, box: { width, height }, aspect, ensureScale }), [strip, width, height, aspect, ensureScale]);
  return <div className={`absolute left-0 ${className}`} style={{ top: top * width, width, height }}>
    <FrameContext.Provider value={info}>{children}</FrameContext.Provider>
  </div>;
}
