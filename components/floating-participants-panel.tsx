"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Grip, LayoutGrid, List, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RenderTile } from "@/components/participant-tiles";
import type { Member } from "@/lib/confa-types";
import { clampFloatingPanel, type PanelPosition } from "@/lib/floating-panel";

type Props = {
  boundaryRef: RefObject<HTMLDivElement | null>;
  members: Member[];
  renderTile: RenderTile;
  renderParticipantList: () => ReactNode;
  orientation: "top" | "left";
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  initialLeft: number;
  initialTop?: string;
  reservedRight?: number;
  reservedBottom?: number;
};

type Drag = { pointerId: number; offsetX: number; offsetY: number };

// Used by both expanded stages. Only the grip moves the panel; its video, list and controls keep their normal gestures.
export function FloatingParticipantsPanel({ boundaryRef, members, renderTile, renderParticipantList, orientation, collapsed, onCollapsedChange, initialLeft, initialTop = "max(12px, env(safe-area-inset-top))", reservedRight = 12, reservedBottom = 12 }: Props) {
  const [view, setView] = useState<"tiles" | "list">("tiles");
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [navigation, setNavigation] = useState({ overflow: false, canPrevious: false, canNext: false });
  const panelRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const horizontal = orientation === "top";
  const memberIds = members.map((person) => person.id).join("\u0000");

  const bounds = () => {
    const boundary = boundaryRef.current, panel = panelRef.current;
    return boundary && panel ? { boundary: boundary.getBoundingClientRect(), panel: panel.getBoundingClientRect() } : null;
  };

  // A resized scene or an expanded list cannot leave a previously dragged panel offscreen.
  useLayoutEffect(() => {
    const boundary = boundaryRef.current, panel = panelRef.current;
    if (!boundary || !panel) return;
    const keepVisible = () => setPosition((current) => {
      if (!current) return current;
      const next = clampFloatingPanel(current,
        { width: boundary.clientWidth, height: boundary.clientHeight },
        { width: panel.offsetWidth, height: panel.offsetHeight });
      return next.x === current.x && next.y === current.y ? current : next;
    });
    const observer = new ResizeObserver(keepVisible);
    observer.observe(boundary);
    observer.observe(panel);
    keepVisible();
    return () => observer.disconnect();
  }, [boundaryRef]);

  const updateNavigation = useCallback(() => {
    const viewport = tilesRef.current;
    if (!viewport) return;
    const current = horizontal ? viewport.scrollLeft : viewport.scrollTop;
    const end = horizontal ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const navigationHeight = horizontal ? 0 : (navigationRef.current?.offsetHeight ?? 0);
    const overflow = end > navigationHeight + 1;
    const next = { overflow, canPrevious: overflow && current > 1, canNext: overflow && current < end - 1 };
    setNavigation((previous) => previous.overflow === next.overflow && previous.canPrevious === next.canPrevious && previous.canNext === next.canNext ? previous : next);
  }, [horizontal]);

  useEffect(() => {
    const viewport = tilesRef.current;
    if (collapsed || view !== "tiles" || !viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateNavigation);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    schedule();
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [collapsed, view, orientation, memberIds, updateNavigation]);

  function page(direction: -1 | 1) {
    const viewport = tilesRef.current;
    if (!viewport) return;
    const tiles = Array.from(viewport.children) as HTMLElement[];
    if (tiles.length < 2) return;
    const first = tiles[0];
    const step = horizontal ? tiles[1].offsetLeft - first.offsetLeft : tiles[1].offsetTop - first.offsetTop;
    if (step <= 0) return;
    const style = window.getComputedStyle(viewport);
    const padding = horizontal
      ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      : parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const tileSize = horizontal ? first.offsetWidth : first.offsetHeight;
    const viewportSize = (horizontal ? viewport.clientWidth : viewport.clientHeight) - padding;
    const pageSize = Math.max(1, Math.floor((viewportSize + step - tileSize + 0.5) / step));
    const lastStart = Math.max(0, tiles.length - pageSize);
    const starts = Array.from({ length: Math.ceil(tiles.length / pageSize) }, (_, index) => Math.min(index * pageSize, lastStart))
      .filter((start, index, values) => index === 0 || start !== values[index - 1]);
    const maxScroll = horizontal ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const offset = (index: number) => Math.min(maxScroll, horizontal ? tiles[index].offsetLeft - first.offsetLeft : tiles[index].offsetTop - first.offsetTop);
    const current = horizontal ? viewport.scrollLeft : viewport.scrollTop;
    const currentPage = starts.reduce((nearest, start, index) => Math.abs(offset(start) - current) < Math.abs(offset(starts[nearest]) - current) ? index : nearest, 0);
    const target = offset(starts[Math.max(0, Math.min(starts.length - 1, currentPage + direction))]);
    viewport.scrollTo(horizontal ? { left: target, behavior: "auto" } : { top: target, behavior: "auto" });
    updateNavigation();
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const box = bounds();
    if (!box) return;
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - box.panel.left, offsetY: event.clientY - box.panel.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPosition(clampFloatingPanel(
      { x: box.panel.left - box.boundary.left, y: box.panel.top - box.boundary.top },
      { width: box.boundary.width, height: box.boundary.height },
      { width: box.panel.width, height: box.panel.height }));
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const box = bounds();
    if (!box) return;
    event.preventDefault();
    event.stopPropagation();
    setPosition(clampFloatingPanel(
      { x: event.clientX - drag.offsetX - box.boundary.left, y: event.clientY - drag.offsetY - box.boundary.top },
      { width: box.boundary.width, height: box.boundary.height },
      { width: box.panel.width, height: box.panel.height }));
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function moveWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const delta = event.shiftKey ? 48 : 16;
    const movement: Record<string, PanelPosition> = {
      ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 },
      ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta },
    };
    const change = movement[event.key];
    if (!change) return;
    const box = bounds();
    if (!box) return;
    event.preventDefault();
    event.stopPropagation();
    setPosition((current) => clampFloatingPanel(
      { x: (current?.x ?? box.panel.left - box.boundary.left) + change.x, y: (current?.y ?? box.panel.top - box.boundary.top) + change.y },
      { width: box.boundary.width, height: box.boundary.height },
      { width: box.panel.width, height: box.panel.height }));
  }

  const availableWidth = `calc(100% - ${initialLeft + reservedRight}px)`;
  const style: CSSProperties = {
    left: position?.x ?? initialLeft,
    top: position?.y ?? initialTop,
    width: collapsed ? "fit-content" : view === "list" ? `min(${horizontal ? 360 : 340}px, ${availableWidth})` : horizontal ? "fit-content" : "clamp(110px, 16vw, 180px)",
    maxWidth: horizontal && !collapsed && view === "tiles" ? `min(420px, ${availableWidth})` : availableWidth,
    maxHeight: horizontal ? `min(50dvh, 440px, calc(100% - ${reservedBottom}px - ${initialTop}))` : `calc(100% - ${reservedBottom}px - ${initialTop})`,
  };

  return <div ref={panelRef} data-participant-overlay aria-label="Панель участников" style={style} className="absolute z-30 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur-md">
    <div className="flex shrink-0 items-center justify-between gap-1 p-1.5">
      <Button type="button" variant="ghost" size="icon-xs" title="Перетащить панель участников" aria-label="Перетащить панель участников. Стрелки перемещают её с клавиатуры" className="shrink-0 cursor-grab touch-none text-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={moveWithKeyboard}><Grip size={15} /></Button>
      {collapsed ? <Button type="button" variant="ghost" size="sm" aria-label="Развернуть панель участников" aria-expanded={false} className="text-foreground hover:bg-accent hover:text-foreground" onClick={() => onCollapsedChange(false)}><Users size={16} />{members.length}{horizontal ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</Button> : <>
        <span className="min-w-0 truncate px-1 text-xs text-[var(--text-subtle)]">{members.length}</span>
        <div className="flex items-center gap-0.5">
          <Button type="button" variant={view === "tiles" ? "secondary" : "ghost"} size="icon-xs" title="Видео участников" aria-label="Видео участников" aria-pressed={view === "tiles"} className="text-foreground hover:bg-accent hover:text-foreground" onClick={() => setView("tiles")}><LayoutGrid size={15} /></Button>
          <Button type="button" variant={view === "list" ? "secondary" : "ghost"} size="icon-xs" title="Список участников" aria-label="Список участников" aria-pressed={view === "list"} className="text-foreground hover:bg-accent hover:text-foreground" onClick={() => setView("list")}><List size={15} /></Button>
          <Button type="button" variant="ghost" size="icon-xs" title="Свернуть панель участников" aria-label="Свернуть панель участников" aria-expanded={true} className="text-foreground hover:bg-accent hover:text-foreground" onClick={() => onCollapsedChange(true)}>{horizontal ? <ChevronUp size={15} /> : <ChevronLeft size={15} />}</Button>
        </div>
      </>}
    </div>
    {!collapsed && (view === "tiles" ? <>
      {navigation.overflow && <div ref={navigationRef} className="flex shrink-0 items-center justify-center gap-1 px-1 pb-1">
        <Button type="button" variant="ghost" size="icon-xs" title="Предыдущие участники" aria-label="Предыдущие участники" disabled={!navigation.canPrevious} className="text-foreground hover:bg-accent hover:text-foreground" onClick={() => page(-1)}>{horizontal ? <ChevronLeft size={15} /> : <ChevronUp size={15} />}</Button>
        <Button type="button" variant="ghost" size="icon-xs" title="Следующие участники" aria-label="Следующие участники" disabled={!navigation.canNext} className="text-foreground hover:bg-accent hover:text-foreground" onClick={() => page(1)}>{horizontal ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</Button>
      </div>}
      <div ref={tilesRef} aria-label="Видео участников" onScroll={updateNavigation} className={horizontal
        ? "flex h-[clamp(84px,13dvh,120px)] w-max max-w-full min-w-0 gap-2 overflow-x-auto overscroll-contain p-2"
        : "flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2"}>
        {members.map((person) => renderTile(person, horizontal ? "top" : "left"))}
      </div>
    </> : <div aria-label="Список участников" className="min-h-0 flex-1 overflow-y-auto p-3">{renderParticipantList()}</div>)}
  </div>;
}
