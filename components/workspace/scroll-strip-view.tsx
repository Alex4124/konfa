"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { AnnotationLayer, type EdgeHandoff, type LayerHandle, type PointerRelay } from "@/components/annotations/annotation-layer";
import { FrameTile, ZoomFrame, type FrameController, type FrameInteraction, type FrameState } from "@/components/zoom-frame";
import { useSurface } from "@/hooks/use-surface-hub";
import type { PrefsPatch, TextSize } from "@/lib/annotation-tools";
import { followWidth, posAt, readingTile, stripWidth, tileAt, topAt, visibleTiles, type StripLayout } from "@/lib/scroll-strip";
import type { SurfaceHub } from "@/lib/surface-hub";
import { panBy, viewAtTop, viewTop, type Band } from "@/lib/view-transform";
import type { PartView } from "@/lib/view-sync";

// What a mounted tile's annotation layer gets from the strip: where to register its handle, and (board) the edge hand-off.
export type TileSlot = { handle: (handle: LayerHandle | null) => void; onEdge?: (handoff: EdgeHandoff) => PointerRelay | null };
export type StripApi = {
  commitText(): boolean;
  cancelStroke(): boolean;
  busy(): boolean;
  restyle(patch: PrefsPatch): void;
  layer(index: number): LayerHandle | undefined;
  position(): number; // tile index + fraction at the top row
  scrollTo(position: number, animate?: boolean): void;
  scrollBy(screens: number): void;
  reveal(index: number): void; // brings a tile into view if it is not (after an undo there)
  rewind(): void; // back to the top, forgetting how far down the view has been (the board was cleared)
};
type Props = {
  layout: StripLayout;
  pixelWidth: number; // the strip's native width (zoom limit)
  resetKey: string;
  fitAspect: number | null; // a landscape reference page fits whole; null: the strip fills the width
  host: boolean; // the teacher scrolls; everyone else is held in the teacher's window
  start: number; // where the teacher's view opens
  // A student: the teacher's place and window. The teacher: where another of the teacher's devices has moved the strip since.
  target: { pos: number; span: number | null } | null;
  extent?: (bottom: number) => number; // the board: how far down it reaches, given the lowest row shown (strip widths)
  seamless?: boolean; // the board: a stroke passes from tile to tile
  interaction: FrameInteraction;
  fingersDraw: boolean;
  penOnly: boolean;
  onPenOnlyChange: (value: boolean) => void;
  zoomLabel: string;
  api?: Ref<StripApi>;
  onIntent?: () => void; // the teacher moved or pressed the strip on purpose (not a resize): this device leads from now on
  onView?: (view: PartView, settled: boolean) => void;
  onTile?: (index: number) => void; // the tile the page indicator names (lib/scroll-strip readingTile)
  background?: (strip: { width: number; rows: number }) => ReactNode;
  tile: (index: number, slot: TileSlot) => ReactNode;
  placeholder?: (index: number) => ReactNode; // what an unmounted tile shows
  scrollLabel?: (position: number) => string;
};
type Size = { width: number; height: number };

const EMPTY: Size = { width: 0, height: 0 };
const OVERSCAN = 0.5; // of a viewport, above and below
const SETTLE_MS = 220;
const MIN_THUMB_PX = 28;
const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

// The mounted tiles' layer handles, and the slot each layer registers through (one object per tile, so its props stay stable).
function createTiles(seamless: boolean) {
  const handles = new Map<number, LayerHandle>();
  const slots = new Map<number, TileSlot>();
  const relays = new Map<number, number>(); // pointer id -> the tile that currently draws its stroke

  // A stroke left tile `from` through an edge: the tile beyond takes it over, and the layer that holds the pointer capture
  // relays the pointer's further events to whichever tile owns the stroke now.
  const edge = (from: number, handoff: EdgeHandoff): PointerRelay | null => {
    const owner = from + (handoff.edge === "bottom" ? 1 : -1);
    const next = handles.get(owner);
    if (!next || !next.pointer.adopt(handoff)) return null;
    const id = handoff.pointerId;
    relays.set(id, owner);
    next.pointer.move(handoff.next);
    const current = () => handles.get(relays.get(id) ?? -1);
    return {
      move: (input) => current()?.pointer.move(input),
      up(input) {
        const layer = current();
        relays.delete(id);
        layer?.pointer.up(input);
      },
      cancel() {
        const layer = current();
        relays.delete(id);
        layer?.pointer.cancel(id);
      },
    };
  };

  return {
    handles,
    // A tile with a stroke, a relayed pointer or an open text: it stays mounted wherever the view goes.
    held: (index: number) => Boolean(handles.get(index)?.busy()) || [...relays.values()].includes(index),
    slot(index: number): TileSlot {
      let made = slots.get(index);
      if (!made) slots.set(index, made = {
        handle(handle) {
          if (handle) handles.set(index, handle);
          else handles.delete(index);
        },
        ...(seamless ? { onEdge: (handoff: EdgeHandoff) => edge(index, handoff) } : {}),
      });
      return made;
    },
  };
}

// A column of tiles the teacher scrolls and students are held to (lib/scroll-strip): one ZoomFrame for all of them, only the
// tiles near the viewport mounted. It owns the tiles' layer handles, so the workspace can drive whichever are on screen.
export function ScrollStripView({ layout, pixelWidth, resetKey, fitAspect, host, start, target, extent, seamless = false, interaction, fingersDraw, penOnly, onPenOnlyChange, zoomLabel, api, onIntent, onView, onTile, background, tile, placeholder, scrollLabel }: Props) {
  const [size, setSize] = useState<Size>(EMPTY);
  const [mounted, setMounted] = useState<readonly number[]>([]);
  const [reach, setReach] = useState({ key: resetKey, tile: -1 }); // the lowest tile the teacher's view has shown: the board only grows while open
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const controller = useRef<FrameController>(null);
  const [tiles] = useState(() => createTiles(seamless));
  const started = useRef<string | null>(null);
  const anchor = useRef<{ key: string; shape: string; pos: number } | null>(null); // the teacher's top row at the current window size
  const settle = useRef<number | null>(null);
  const lastTile = useRef(-1);

  const natural = stripWidth(size, fitAspect ?? 1, fitAspect !== null);
  const boxWidth = !host && target?.span ? followWidth(size, target.span, natural) : natural;
  const screenRows = boxWidth > 0 ? size.height / boxWidth : 0;
  // A follower's window: the teacher's top row and one own viewport below it, kept inside the strip.
  const windowTop = !host && target ? Math.max(0, Math.min(topAt(layout, target.pos), layout.total - screenRows)) : 0;
  // The lowest row shown before the view reports itself: the teacher's saved place (or where another of the teacher's devices
  // is), or the follower's window.
  const lowest = (host ? Math.max(topAt(layout, start), target ? topAt(layout, target.pos) : 0) : windowTop) + screenRows;
  const reached = host && reach.key === resetKey && reach.tile >= 0 && reach.tile < layout.tops.length ? layout.tops[reach.tile] + layout.heights[reach.tile] : 0;
  const rows = extent ? extent(Math.max(lowest, reached)) : layout.total;
  const band: Band | null = !host && target ? { top: windowTop, bottom: windowTop + screenRows } : extent ? { top: 0, bottom: rows } : null;
  const live = useRef({ layout, rows, host, extent, onIntent, onView, onTile, resetKey });
  useEffect(() => { live.current = { layout, rows, host, extent, onIntent, onView, onTile, resetKey }; });

  useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Rows of the strip (strip widths) at the top and bottom of the viewport.
  const span = (state: FrameState) => {
    const top = viewTop(state.view, state.box, state.viewport, state.max) / state.box.width;
    return { top, bottom: top + state.viewport.height / (state.view.scale * state.box.width) };
  };

  // Runs for every shown view (gesture frames too): which tiles to mount, the scrollbar, the page indicator, the teacher's report.
  const sync = useCallback(() => {
    const state = controller.current?.get();
    const now = live.current;
    if (!state || !(state.box.width > 0) || !(state.viewport.height > 0)) return;
    const { top, bottom } = span(state);
    const screen = bottom - top;
    if (now.host && started.current === now.resetKey) {
      const shape = `${state.box.width}:${state.viewport.height}`, held = anchor.current;
      if (held && held.key === now.resetKey && held.shape !== shape) {
        // The window changed size: the view keeps its top row, not its middle, or the place everyone follows would drift.
        anchor.current = { ...held, shape };
        controller.current?.apply((view, frame) => viewAtTop(view, topAt(now.layout, held.pos) * frame.box.width, frame.box, frame.viewport, frame.max));
        return; // the apply above ran this again at the new size
      }
      anchor.current = { key: now.resetKey, shape, pos: posAt(now.layout, top) };
    }
    const range = visibleTiles(now.layout, top, bottom, OVERSCAN * screen);
    const next: number[] = [];
    for (let index = range.first; index <= range.last; index++) next.push(index);
    for (const index of tiles.handles.keys()) if (!next.includes(index) && tiles.held(index)) next.push(index);
    next.sort((a, b) => a - b);
    setMounted((current) => sameList(current, next) ? current : next);
    if (now.extent && now.host) {
      const lowestTile = tileAt(now.layout, bottom - 1e-9);
      setReach((current) => current.key === now.resetKey && current.tile >= lowestTile ? current : { key: now.resetKey, tile: lowestTile });
    }
    const thumb = thumbRef.current, track = trackRef.current;
    if (thumb && track) {
      const total = Math.max(now.rows, bottom), height = track.clientHeight;
      const size = Math.max(MIN_THUMB_PX, height * Math.min(1, screen / total));
      thumb.style.height = `${size}px`;
      thumb.style.transform = `translateY(${total > screen ? (height - size) * Math.min(1, top / (total - screen)) : 0}px)`;
      track.style.visibility = total > screen + 1e-6 ? "visible" : "hidden";
    }
    const reading = readingTile(now.layout, top, bottom);
    if (reading !== lastTile.current) {
      lastTile.current = reading;
      now.onTile?.(reading);
    }
    // Nothing is reported before the view has opened where it was left: everyone would follow it to the top and back.
    if (!now.host || !now.onView || started.current !== now.resetKey) return;
    const view: PartView = { pos: posAt(now.layout, top), span: state.viewport.height / state.box.width };
    now.onView(view, false);
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      settle.current = null;
      live.current.onView?.(view, true);
    }, SETTLE_MS);
  }, [tiles]);

  useEffect(() => {
    const unsubscribe = controller.current?.subscribe(sync);
    return () => {
      unsubscribe?.();
      if (settle.current !== null) window.clearTimeout(settle.current);
    };
  }, [sync]);

  // Layout inputs changed without the view moving (a material's pages, the follower's window): look again.
  useEffect(() => { sync(); }, [sync, layout, rows, boxWidth, size, windowTop]);

  const scrollTo = useCallback((position: number, animate = false) => {
    controller.current?.apply((view, state) => viewAtTop(view, topAt(live.current.layout, position) * state.box.width, state.box, state.viewport, state.max), animate);
  }, []);

  // A deliberate act of the teacher on this strip: this device leads from here on. `report`: also when nothing moves after it
  // (a press to draw), so everyone comes to where the teacher works.
  const intend = useCallback((report = false) => {
    if (!live.current.host) return;
    live.current.onIntent?.();
    if (report) sync();
  }, [sync]);

  // The teacher's view opens where it was left (once per board or material, as soon as the strip has a size).
  useEffect(() => {
    if (!host || !(boxWidth > 0) || started.current === resetKey) return;
    started.current = resetKey;
    live.current.onIntent?.();
    if (start > 0) scrollTo(start);
    else sync();
  }, [host, boxWidth, resetKey, start, scrollTo, sync]);

  // Another of the teacher's devices moved this part since: this one goes there too (and takes the lead back when touched).
  const leadPos = host && target ? target.pos : null;
  useEffect(() => {
    if (leadPos !== null && started.current === resetKey) scrollTo(leadPos, true);
  }, [leadPos, resetKey, scrollTo]);

  useImperativeHandle(api, () => ({
    commitText: () => [...tiles.handles.values()].map((handle) => handle.commitText()).every(Boolean),
    cancelStroke: () => [...tiles.handles.values()].map((handle) => handle.cancelStroke()).some(Boolean),
    busy: () => [...tiles.handles.values()].some((handle) => handle.busy()),
    restyle: (patch) => { for (const handle of tiles.handles.values()) handle.restyle(patch); },
    layer: (index) => tiles.handles.get(index),
    position() {
      const state = controller.current?.get();
      return state && state.box.width > 0 ? posAt(live.current.layout, span(state).top) : 0;
    },
    scrollTo(position, animate) {
      intend();
      scrollTo(position, animate);
    },
    scrollBy(screens) {
      intend();
      controller.current?.apply((view, state) => panBy(view, 0, -screens * state.viewport.height, state.box, state.viewport, state.max), true);
    },
    reveal(index) {
      const state = controller.current?.get();
      const top = live.current.layout.tops[index], height = live.current.layout.heights[index];
      if (!state || top === undefined || !(state.box.width > 0)) return;
      const shown = span(state);
      if (top + height > shown.top && top < shown.bottom) return;
      intend();
      scrollTo(index, true);
    },
    rewind() {
      intend();
      setReach({ key: live.current.resetKey, tile: -1 });
      scrollTo(0, true);
    },
  }), [scrollTo, intend, tiles]);

  // The teacher drags the scrollbar; for everyone else it only shows where they are.
  const dragTo = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current, thumb = thumbRef.current;
    if (!track || !thumb) return;
    const rect = track.getBoundingClientRect();
    const free = rect.height - thumb.offsetHeight;
    const share = free > 0 ? Math.min(1, Math.max(0, (event.clientY - rect.top - thumb.offsetHeight / 2) / free)) : 0;
    controller.current?.apply((view, state) => {
      const screen = state.viewport.height / (state.view.scale * state.box.width);
      return viewAtTop(view, share * Math.max(0, live.current.rows - screen) * state.box.width, state.box, state.viewport, state.max);
    });
    if (scrollLabel) setDragLabel(scrollLabel(posAt(layout, share * Math.max(0, rows - screenRows))));
  };

  return <div ref={areaRef} className="relative h-full w-full" onPointerDownCapture={host ? () => intend(true) : undefined} onWheelCapture={host ? () => intend() : undefined}>
    <ZoomFrame frame={{ width: pixelWidth, height: pixelWidth * Math.max(layout.total, 1e-6) }} fit="width" boxWidth={boxWidth} band={band} locked={!host} glide={!host} zoomable frameless interaction={interaction} fingersDraw={fingersDraw} penOnly={penOnly} onPenOnlyChange={onPenOnlyChange} resetKey={resetKey} zoomLabel={zoomLabel} controller={controller} controlsClassName="bottom-2 right-5" media={background?.({ width: boxWidth, rows })}>
      {placeholder && layout.tops.map((top, index) => mounted.includes(index) ? null : <FrameTile key={`blank-${index}`} top={top} aspect={1 / layout.heights[index]}>{placeholder(index)}</FrameTile>)}
      {mounted.map((index) => layout.tops[index] === undefined ? null : <FrameTile key={index} top={layout.tops[index]} aspect={1 / layout.heights[index]}>{tile(index, tiles.slot(index))}</FrameTile>)}
    </ZoomFrame>
    <div ref={trackRef} className={`absolute bottom-1.5 right-1 top-1.5 z-20 w-2.5 ${host ? "cursor-pointer touch-none" : "pointer-events-none"}`} style={{ visibility: "hidden" }}
      onPointerDown={host ? (event) => { event.currentTarget.setPointerCapture(event.pointerId); dragTo(event); } : undefined}
      onPointerMove={host ? (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) dragTo(event); } : undefined}
      onPointerUp={host ? () => setDragLabel(null) : undefined} onPointerCancel={host ? () => setDragLabel(null) : undefined}>
      <div ref={thumbRef} className={`absolute inset-x-0 top-0 rounded-full ${host ? "bg-slate-500/70 hover:bg-slate-400/80" : "bg-slate-500/45"}`}>
        {dragLabel && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-[#0e192c] px-2 py-1 text-xs text-white shadow-xl">{dragLabel}</span>}
      </div>
    </div>
  </div>;
}

type LayerProps = {
  hub: SurfaceHub;
  id: string;
  slot: TileSlot;
  selfId: string;
  canDraw: boolean;
  canModerate: boolean;
  armedByDefault: boolean;
  coarse: boolean;
  toolKey: string;
  color: string;
  label: string;
  onEditing?: (style: { color: string; size: TextSize } | null) => void;
};

// The annotation layer of one tile: its store comes from the hub and lives as long as the tile is mounted (and a while after).
export function SurfaceLayer({ hub, id, slot, selfId, canDraw, canModerate, armedByDefault, coarse, toolKey, color, label, onEditing }: LayerProps) {
  const sync = useSurface(hub, id);
  return <AnnotationLayer key={id} shareId={id} sync={sync} selfId={selfId} canDraw={canDraw} canModerate={canModerate} armedByDefault={armedByDefault} coarse={coarse} toolKey={toolKey} hotkeysEnabled={false} color={color} tone="light" label={label} handle={slot.handle} onEdge={slot.onEdge} onEditing={onEditing} />;
}
