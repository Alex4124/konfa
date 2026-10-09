"use client";

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { VideoTrack } from "@livekit/components-react";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fitBox, type Size } from "@/lib/annotation-geometry";
import { clampTransform, DEFAULT_MAX_ZOOM, ensureMinScale, IDENTITY_VIEW, isDoubleTap, isTap, isZoomed, maxScaleFor, panBy, pinch, routePointerDown, toggleZoom, toTransform, wheelZoomFactor, ZOOM_STEP, zoomAt, zoomPercent, type PinchStart, type PointerRoute, type Tap, type View, type XY } from "@/lib/view-transform";
import type { Point } from "@/lib/confa-types";

type TrackRef = NonNullable<ComponentProps<typeof VideoTrack>["trackRef"]>;
type Frame = Size & { source: "video" | "provisional" };
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
type Props = {
  trackRef: TrackRef;
  children?: ReactNode;
  className?: string;
  frameless?: boolean;
  zoomable?: boolean;
  interaction?: FrameInteraction;
  fingersDraw?: boolean; // «Пальцы тоже рисуют»: a pen contact does not switch fingers to pan and zoom
  resetKey?: string | null;
  onFrameChange?: (aspect: number) => void;
  hideVideo?: boolean;
};
// What the gesture handlers read at event time (written after every render).
type Geometry = { view: View; box: Size; viewport: Size; max: number; interaction: FrameInteraction; penOnly: boolean; fingersDraw: boolean };
type Zoomer = { apply(change: (view: View, geometry: Geometry) => View, animate?: boolean): void };
type Tracked = { type: string; route: PointerRoute; at: XY; down: Tap };
type GestureStart = { kind: "pan"; id: number; view: View; from: XY } | { kind: "pinch"; ids: [number, number]; start: PinchStart };

const DEFAULT_ASPECT = 16 / 9;
const PROVISIONAL_MS = 1200;
const WHEEL_SETTLE_MS = 160; // Ctrl+wheel and trackpad pinch commit once the wheel goes quiet
const ANIMATE_MS = 160;
const TOUCH_DBLCLICK_MS = 800; // a dblclick this soon after a touch or pen tap was synthesized from it
const EMPTY: Size = { width: 0, height: 0 };
const now = () => performance.now();

export const FrameContext = createContext<FrameInfo | null>(null);

export function useFrame(): FrameInfo {
  const info = useContext(FrameContext);
  if (!info) throw new Error("useFrame() must be used inside <SharedScreen>");
  return info;
}

function provisionalFrame(publication: TrackRef["publication"]): Frame | null {
  const settings = publication.track?.mediaStreamTrack?.getSettings();
  if (settings?.width && settings.height) return { width: settings.width, height: settings.height, source: "provisional" };
  const dimensions = publication.dimensions;
  if (dimensions?.width && dimensions.height) return { width: dimensions.width, height: dimensions.height, source: "provisional" };
  return null;
}

const centreOf = (size: Size): XY => ({ x: size.width / 2, y: size.height / 2 });

// Fine pointers: −, {pct}%, + (shown on hover until zoomed). Coarse pointers: only a «{pct}% ✕» reset chip while zoomed.
function ZoomControls({ percent, zoomed, canZoomIn, onZoom, onReset }: { percent: number; zoomed: boolean; canZoomIn: boolean; onZoom: (factor: number) => void; onReset: () => void }) {
  const round = "rounded-full text-white hover:bg-white/10 hover:text-white";
  return <div data-gesture-ignore className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-center transition-opacity group-has-data-[annotating=true]/screen:opacity-0">
    <div role="group" aria-label="Масштаб демонстрации" className={`flex items-center gap-0.5 rounded-full border border-white/15 bg-[#12243a]/90 p-0.5 text-white shadow-xl transition-opacity pointer-coarse:hidden ${zoomed ? "pointer-events-auto" : "opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/screen:pointer-events-auto group-hover/screen:opacity-100"}`}>
      <Button variant="ghost" size="icon-sm" title="Отдалить" aria-label="Отдалить" disabled={!zoomed} className={round} onClick={() => onZoom(1 / ZOOM_STEP)}><ZoomOut /></Button>
      <Button variant="ghost" size="sm" title="Сбросить масштаб" aria-label={`Масштаб ${percent}%. Сбросить масштаб`} className={`h-8 min-w-12 px-2 text-xs tabular-nums ${round}`} onClick={onReset}>{percent}%</Button>
      <Button variant="ghost" size="icon-sm" title="Приблизить" aria-label="Приблизить" disabled={!canZoomIn} className={round} onClick={() => onZoom(ZOOM_STEP)}><ZoomIn /></Button>
    </div>
    {zoomed && <Button variant="secondary" size="sm" title="Сбросить масштаб" aria-label={`Масштаб ${percent}%. Сбросить масштаб`} className="pointer-events-auto hidden h-9 gap-1.5 rounded-full border border-white/15 bg-[#12243a]/90 px-3 text-sm tabular-nums text-white shadow-xl hover:bg-[#1c2c45] pointer-coarse:inline-flex" onClick={onReset}>{percent}%<X size={16} /></Button>}
  </div>;
}

export function SharedScreen({ trackRef, children, className = "", frameless = false, zoomable = false, interaction = "view", fingersDraw = false, resetKey = null, onFrameChange, hideVideo = false }: Props) {
  const publication = trackRef.publication;
  const sid = publication.trackSid;
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameSid, setFrameSid] = useState(sid);
  const [viewport, setViewport] = useState<Size>(EMPTY);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [penOnly, setPenOnly] = useState(false);
  const [storedView, setStoredView] = useState<View>(IDENTITY_VIEW);
  const [viewKey, setViewKey] = useState(resetKey);
  const [gestureListeners] = useState(() => new Set<() => void>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reportedAspect = useRef<number | null>(null);
  const geometry = useRef<Geometry>({ view: IDENTITY_VIEW, box: EMPTY, viewport: EMPTY, max: DEFAULT_MAX_ZOOM, interaction, penOnly: false, fingersDraw });
  const zoomer = useRef<Zoomer | null>(null);

  if (frameSid !== sid) {
    setFrameSid(sid);
    setFrame(null);
  }
  if (viewKey !== resetKey) {
    setViewKey(resetKey);
    setStoredView(IDENTITY_VIEW);
  }

  const aspect = frame ? frame.width / frame.height : DEFAULT_ASPECT;
  const box = useMemo(() => fitBox(viewport, aspect), [viewport, aspect]);
  const ready = Boolean(frame) && box.width > 0 && box.height > 0;
  const max = maxScaleFor(frame, box);
  // The stored view keeps the point the viewer looked at; a resize or a new frame size only re-clamps what is shown.
  const view = zoomable ? clampTransform(storedView, box, viewport, max) : IDENTITY_VIEW;
  const transform = toTransform(view, box, viewport, max);
  const scale = view.scale;
  const zoomed = isZoomed(view);

  const frameChanged = useEffectEvent((next: number) => onFrameChange?.(next));

  useLayoutEffect(() => {
    geometry.current = { view, box, viewport, max, interaction, penOnly, fingersDraw };
  });

  // The transform is never in the JSX: gestures write it straight to the element between commits.
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (element) element.style.transform = transform;
  }, [transform]);

  useEffect(() => {
    const video = videoRef.current;
    const win = video?.ownerDocument.defaultView;
    if (!video || !win) return;
    let exact = false;
    const commit = (next: Frame) => {
      setFrame((previous) => previous && previous.width === next.width && previous.height === next.height && previous.source === next.source ? previous : next);
      const nextAspect = next.width / next.height;
      if (reportedAspect.current === nextAspect) return;
      reportedAspect.current = nextAspect;
      frameChanged(nextAspect);
    };
    const read = () => {
      const width = video.videoWidth, height = video.videoHeight;
      const expected = publication.track?.mediaStreamTrack;
      const stream = video.srcObject;
      const attached = stream && "getVideoTracks" in stream ? stream.getVideoTracks()[0] : undefined;
      if (!width || !height || !expected || attached?.id !== expected.id) return;
      exact = true;
      commit({ width, height, source: "video" });
    };
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    const raf = win.requestAnimationFrame(read);
    const timer = win.setTimeout(() => {
      if (exact) return;
      const next = provisionalFrame(publication);
      if (next) commit(next);
    }, PROVISIONAL_MS);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
      win.cancelAnimationFrame(raf);
      win.clearTimeout(timer);
    };
  }, [publication]);

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
    let raf = 0, settle = 0, unanimate = 0;

    const geo = () => geometry.current;
    const current = () => live ?? geo().view;
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
      if (live) write(live);
    };
    const show = (next: View) => {
      live = next;
      stopAnimation();
      content.style.willChange = "transform";
      if (!raf) raf = win.requestAnimationFrame(paint);
    };
    const commit = (animate = false) => {
      if (raf) win.cancelAnimationFrame(raf);
      if (settle) win.clearTimeout(settle);
      raf = 0;
      settle = 0;
      const next = live;
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
      const decision = routePointerDown({ pointerType: type, button: event.button, interaction: g.interaction, penOnly: g.penOnly, penDown, otherTouches, zoomed: isZoomed(current()), primary: event.isPrimary });
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
      pointer.at = local(event);
      const g = geo();
      if (start?.kind === "pinch") {
        const a = pointers.get(start.ids[0]), b = pointers.get(start.ids[1]);
        if (a && b) show(pinch(start.start, a.at, b.at, g.box, g.viewport, g.max));
      } else if (start?.kind === "pan" && start.id === event.pointerId) {
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
          live = toggleZoom(current(), tap, g.box, g.viewport, g.max);
          commit(true);
          return;
        } else lastTap = tap;
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
      live = toggleZoom(current(), local(event), g.box, g.viewport, g.max);
      commit(true);
    };

    // Ctrl+wheel and the trackpad pinch of Chrome, Edge and Firefox (they set ctrlKey); never the page zoom over the frame.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, true);
      if (factor === 1) return;
      const g = geo();
      show(zoomAt(current(), factor, local(event), g.box, g.viewport, g.max));
      if (start) {
        restart();
        return;
      }
      if (settle) win.clearTimeout(settle);
      settle = win.setTimeout(() => {
        settle = 0;
        if (!start) commit();
      }, WHEEL_SETTLE_MS);
    };
    // iOS: no page pinch over the frame (touch-action alone is not always honoured once two fingers are down).
    // A pan is consumed too, so a fast swipe leaves no browser fling behind that would swallow the next tap.
    const onTouchMove = (event: TouchEvent) => {
      if (event.cancelable && (event.touches.length > 1 || start)) event.preventDefault();
    };
    const onGesture = (event: Event) => event.preventDefault();

    zoomer.current = {
      apply(change, animate = false) {
        live = change(current(), geo());
        commit(animate);
        if (start) restart();
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
      if (raf) win.cancelAnimationFrame(raf);
      if (settle) win.clearTimeout(settle);
      stopAnimation();
      // A dropped gesture leaves the committed view on screen (the share changed, or zoom was switched off).
      if (live) write(geo().view);
      content.style.willChange = "";
      element.style.cursor = "";
      zoomer.current = null;
    };
  }, [zoomable, resetKey, gestureListeners]);

  const onGestureStart = useCallback((listener: () => void) => {
    gestureListeners.add(listener);
    return () => { gestureListeners.delete(listener); };
  }, [gestureListeners]);

  // Text tool: zoom in about the point until text of this size is readable (no-op without zoom).
  const ensureScale = useCallback((minScale: number, focus: Point) => {
    zoomer.current?.apply((current, g) => ensureMinScale(current, minScale, focus, g.box, g.viewport, g.max));
  }, []);

  const zoomBy = (factor: number) => zoomer.current?.apply((current, g) => zoomAt(current, factor, centreOf(g.viewport), g.box, g.viewport, g.max), true);
  const resetZoom = () => zoomer.current?.apply((_, g) => clampTransform(IDENTITY_VIEW, g.box, g.viewport, g.max), true);

  const info = useMemo<FrameInfo>(() => ({ box, aspect, ready, scale, zoomable, interaction, penOnly, setPenOnly, onGestureStart, ensureScale, overlay }), [box, aspect, ready, scale, zoomable, interaction, penOnly, onGestureStart, ensureScale, overlay]);

  return <div ref={viewportRef} className={`group/screen relative h-full w-full overflow-hidden ${zoomable ? `touch-none [-webkit-touch-callout:none] ${zoomed && interaction === "view" ? "cursor-grab" : ""}` : ""} ${className}`}>
    <div ref={frameRef} className={`absolute left-0 top-0 overflow-hidden bg-black ${frameless ? "" : "rounded-lg"}`} style={{ width: box.width, height: box.height, transformOrigin: "0 0" }}>
      <VideoTrack ref={videoRef} trackRef={trackRef} className={`absolute inset-0 h-full w-full ${frame?.source === "video" ? "object-fill" : "object-contain"} ${hideVideo ? "opacity-0" : ""}`} />
      <FrameContext.Provider value={info}>{children}</FrameContext.Provider>
    </div>
    <div ref={setOverlay} className="pointer-events-none absolute inset-0 z-10" />
    {zoomable && ready && <ZoomControls percent={zoomPercent(view)} zoomed={zoomed} canZoomIn={scale < max - 0.001} onZoom={zoomBy} onReset={resetZoom} />}
  </div>;
}
