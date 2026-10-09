"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { TrackReference } from "@livekit/components-react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LayoutGrid, List, Maximize2, Minimize2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import { SharedScreen } from "@/components/shared-screen";
import { useAnnotationPrefs, useArmedTool } from "@/hooks/use-annotation-prefs";
import { useMediaQuery } from "@/hooks/use-media-query";
import { defaultToolFor, toolbarLayoutFor } from "@/lib/annotation-tools";
import { stripPlacement } from "@/lib/view-transform";
import type { RoomState, UiTool } from "@/lib/confa-types";

type Member = RoomState["members"][number];
// Horizontal room the toolbar container leaves: px-1 in a row, max-w-[calc(100%-272px)] as the expanded overlay
// (centred, it then clears the zoom controls in the frame's bottom-right corner, about 124 px with their inset).
const ROW_MARGIN = 8;
const OVERLAY_MARGIN = 272;
// Space the toolbar takes beside the frame (min-h-12 row with size-11 touch buttons, w-15 column), for the strip choice.
const TOOLBAR_ROW_PX = 52;
const TOOLBAR_COLUMN_PX = 60;
type Area = { width: number; height: number; vw: number; vh: number };
// The top-right cluster over the share (RoomView passes its own buttons in the same look).
export const clusterButton = "bg-[#0e192c]/85 text-white shadow-xl hover:bg-[#243c5a] max-md:size-9 short:size-9";
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export type PresentationLayerProps = Omit<ComponentProps<typeof AnnotationLayer>, "shareId" | "toolbar" | "portalContainer" | "onToolChange">;
type Props = {
  state: RoomState;
  activeScreen: TrackReference;
  members: Member[];
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  renderTile: (person: Member, layout: "top" | "left") => ReactNode;
  renderParticipantList: () => ReactNode;
  layerProps: PresentationLayerProps;
  toolbarVisible: boolean;
  placeholder?: ReactNode; // shown instead of the share (the whole-screen presenter's mirror guard): no video, no layer, no toolbar
  actions?: ReactNode; // extra buttons left of «Развернуть экран»
};

export function PresentationArea({ state, activeScreen, members, expanded, onExpand, onCollapse, renderTile, renderParticipantList, layerProps, toolbarVisible: canShowToolbar, placeholder, actions }: Props) {
  const [overlayView, setOverlayView] = useState<"tiles" | "list">("tiles");
  const [overlayCollapsed, setOverlayCollapsed] = useState(false);
  const [overlayNavigation, setOverlayNavigation] = useState({ overflow: false, canPrevious: false, canNext: false });
  const [area, setArea] = useState<Area>({ width: 0, height: 0, vw: 0, vh: 0 });
  const [frameAspect, setFrameAspect] = useState(16 / 9);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  const [wasExpanded, setWasExpanded] = useState(expanded);
  const presentationRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const overlayNavigationRef = useRef<HTMLDivElement>(null);
  const overlayTilesRef = useRef<HTMLDivElement>(null);
  const shareId = state.room.activeShareId;
  const toolbarVisible = canShowToolbar && !placeholder;
  const overlayMemberIds = members.map((person) => person.id).join("\u0000");
  const coarse = layerProps.coarse ?? false;
  const short = useMediaQuery("(max-height: 520px)");
  const [prefs] = useAnnotationPrefs();
  // Same store and fallback as the layer, so the frame's interaction always matches the armed tool.
  const [uiTool] = useArmedTool(shareId ?? "", defaultToolFor({ armedByDefault: layerProps.armedByDefault ?? false, coarse, lastDrawTool: prefs.lastDrawTool }));
  const interaction = layerProps.canDraw && uiTool !== "view" ? "draw" : "view";
  // The toolbar's own column (without the participants strip), so the full toolbar never scrolls sideways.
  const toolbarSpace = columnWidth > 0 ? Math.max(1, columnWidth - (expanded ? OVERLAY_MARGIN : ROW_MARGIN)) : 0;
  const toolbarLayout = toolbarLayoutFor({ expanded, coarse, short, areaWidth: toolbarSpace });
  const placement = toolbarLayout.placement;
  // The participants strip goes where it leaves the larger frame (sizes as in its clamp() classes); the expanded overlay keeps width ≥ height.
  const toolbarRow = toolbarVisible && placement === "row" ? TOOLBAR_ROW_PX : 0;
  const toolbarColumn = toolbarVisible && placement === "column" ? TOOLBAR_COLUMN_PX : 0;
  const strip = { top: clamp(.11 * area.vh, 64, 136), left: clamp(.15 * area.vw, 100, 176) };
  const participantsOnTop = area.width <= 0 ? true : expanded ? area.width >= area.height : stripPlacement({ width: area.width - toolbarColumn, height: area.height - toolbarRow }, frameAspect, strip) === "top";
  // While a stroke is in progress (data-annotating on the layer's svg) the overlays fade and let the pointer through.
  const fade = "transition-opacity group-has-data-[annotating=true]/presentation:pointer-events-none group-has-data-[annotating=true]/presentation:opacity-30";
  // The expanded participants panel starts right of the toolbar column (w-15 + 12 px), so it never covers the tools.
  const besideColumn = toolbarVisible && placement === "column";
  const overlayAt = besideColumn ? "left-18 top-3" : "left-3 top-3";

  if (wasExpanded !== expanded) {
    setWasExpanded(expanded);
    if (expanded) {
      setOverlayView("tiles");
      setOverlayCollapsed(coarse || short); // on phones the tiles would cover much of the frame: they start as the «N участников» chip
    }
  }

  useEffect(() => {
    const element = presentationRef.current, column = columnRef.current;
    if (!element || !column) return;
    const win = element.ownerDocument.defaultView;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== element) {
          setColumnWidth(Math.round(entry.contentRect.width));
          continue;
        }
        const next: Area = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height), vw: win?.innerWidth ?? 0, vh: win?.innerHeight ?? 0 };
        setArea((current) => current.width === next.width && current.height === next.height && current.vw === next.vw && current.vh === next.vh ? current : next);
      }
    });
    observer.observe(element);
    observer.observe(column);
    return () => observer.disconnect();
  }, [expanded]);

  const updateOverlayNavigation = useCallback(() => {
    const viewport = overlayTilesRef.current;
    if (!viewport) return;
    const position = participantsOnTop ? viewport.scrollLeft : viewport.scrollTop;
    const end = participantsOnTop ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const navigationHeight = participantsOnTop ? 0 : (overlayNavigationRef.current?.offsetHeight ?? 0);
    const overflow = end > navigationHeight + 1;
    const next = { overflow, canPrevious: overflow && position > 1, canNext: overflow && position < end - 1 };
    setOverlayNavigation((current) => current.overflow === next.overflow && current.canPrevious === next.canPrevious && current.canNext === next.canNext ? current : next);
  }, [participantsOnTop]);

  useEffect(() => {
    const viewport = overlayTilesRef.current;
    if (!expanded || overlayCollapsed || overlayView !== "tiles" || !viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateOverlayNavigation);
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(viewport);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [expanded, overlayCollapsed, overlayView, participantsOnTop, overlayMemberIds, updateOverlayNavigation]);

  function toolChanged(tool: UiTool) {
    if (expanded && tool !== "view") setOverlayCollapsed(true);
  }

  function pageOverlay(direction: -1 | 1) {
    const viewport = overlayTilesRef.current;
    if (!viewport) return;
    const tiles = Array.from(viewport.children) as HTMLElement[];
    if (tiles.length < 2) return;
    const horizontal = participantsOnTop;
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
    const pageStarts = Array.from({ length: Math.ceil(tiles.length / pageSize) }, (_, page) => Math.min(page * pageSize, lastStart))
      .filter((start, index, starts) => index === 0 || start !== starts[index - 1]);
    const maxScroll = horizontal ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const offset = (index: number) => Math.min(maxScroll, horizontal ? tiles[index].offsetLeft - first.offsetLeft : tiles[index].offsetTop - first.offsetTop);
    const position = horizontal ? viewport.scrollLeft : viewport.scrollTop;
    const currentPage = pageStarts.reduce((nearest, start, index) => Math.abs(offset(start) - position) < Math.abs(offset(pageStarts[nearest]) - position) ? index : nearest, 0);
    const targetPage = Math.max(0, Math.min(pageStarts.length - 1, currentPage + direction));
    const target = offset(pageStarts[targetPage]);
    viewport.scrollTo(horizontal ? { left: target, behavior: "auto" } : { top: target, behavior: "auto" });
    updateOverlayNavigation();
  }

  return <div ref={presentationRef} className={`group/presentation relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0e192c] ${participantsOnTop ? "flex-col" : "flex-row"}`}>
    {!expanded && <div aria-label="Видео участников" className={participantsOnTop
      ? "flex h-[clamp(64px,11vh,136px)] shrink-0 gap-2 overflow-x-auto px-2 py-1 short:hidden"
      : "flex w-[clamp(100px,15vw,176px)] shrink-0 flex-col gap-2 overflow-y-auto px-1 py-2 short:hidden"}>
      {members.map((person) => renderTile(person, participantsOnTop ? "top" : "left"))}
    </div>}

    <div ref={columnRef} className={`relative flex min-h-0 min-w-0 flex-1 ${placement === "column" ? "flex-row" : "flex-col"}`}>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
        {placeholder ?? <SharedScreen trackRef={activeScreen} frameless zoomable interaction={interaction} fingersDraw={prefs.fingersDraw} resetKey={shareId} onFrameChange={setFrameAspect}>
          {shareId && <AnnotationLayer key={shareId} {...layerProps} shareId={shareId} toolbar={{ container: toolbarContainer, layout: toolbarLayout }} onToolChange={toolChanged} />}
        </SharedScreen>}
        {!expanded && !placeholder && <span className="pointer-events-none absolute left-3 top-3 max-w-[50%] truncate rounded-lg bg-[#0e192c]/80 px-3 py-1.5 text-xs text-white short:hidden">{activeScreen.participant.name || "Демонстрация экрана"}</span>}
      </div>
      {toolbarVisible && <div ref={setToolbarContainer} className={placement === "overlay"
        ? `absolute bottom-3 left-1/2 z-40 flex max-w-[calc(100%-272px)] -translate-x-1/2 justify-center ${fade}`
        : placement === "column" ? "order-first flex w-15 shrink-0 flex-col items-center justify-center py-1" : "flex min-h-12 shrink-0 justify-center px-1 py-1"} />}
    </div>

    <div className={`absolute right-3 top-3 z-40 flex gap-2 ${fade}`}>
      {actions}
      <Button variant="secondary" size="icon-lg" title={expanded ? "Свернуть экран" : "Развернуть экран"} aria-label={expanded ? "Свернуть экран" : "Развернуть экран"} className={clusterButton} onClick={() => expanded ? onCollapse() : onExpand()}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
    </div>

    {expanded && <div className={`absolute z-30 flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/15 bg-[#14243a]/90 shadow-2xl backdrop-blur-md ${fade} ${participantsOnTop
      ? overlayCollapsed ? overlayAt : overlayView === "tiles" ? `${overlayAt} w-fit max-h-[min(50vh,440px)] ${besideColumn ? "max-w-[calc(100%-136px)]" : "max-w-[calc(100%-76px)]"}` : `${overlayAt} max-h-[min(50vh,440px)] ${besideColumn ? "w-[min(360px,calc(100%-136px))]" : "w-[min(360px,75vw)]"}`
      : overlayCollapsed ? overlayAt : overlayView === "tiles" ? `${overlayAt} h-fit max-h-[calc(100%-24px)] w-[clamp(110px,16vw,180px)]` : `${overlayAt} bottom-3 ${besideColumn ? "w-[min(340px,calc(100%-136px))]" : "w-[min(340px,75vw)]"}`}`}>
      <div className="flex shrink-0 items-center justify-between gap-1 p-1.5">
        {overlayCollapsed ? <Button variant="ghost" size="sm" aria-label="Развернуть панель участников" aria-expanded={false} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayCollapsed(false)}><Users size={16} />{members.length}{participantsOnTop ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</Button> : <>
          <span className="min-w-0 truncate px-1 text-xs text-slate-200">{members.length}</span>
          <div className="flex items-center gap-0.5">
            <Button variant={overlayView === "tiles" ? "secondary" : "ghost"} size="icon-xs" title="Видео участников" aria-label="Видео участников" aria-pressed={overlayView === "tiles"} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayView("tiles")}><LayoutGrid size={15} /></Button>
            <Button variant={overlayView === "list" ? "secondary" : "ghost"} size="icon-xs" title="Список участников" aria-label="Список участников" aria-pressed={overlayView === "list"} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayView("list")}><List size={15} /></Button>
            <Button variant="ghost" size="icon-xs" title="Свернуть панель участников" aria-label="Свернуть панель участников" aria-expanded={true} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayCollapsed(true)}>{participantsOnTop ? <ChevronUp size={15} /> : <ChevronLeft size={15} />}</Button>
          </div>
        </>}
      </div>
      {!overlayCollapsed && (overlayView === "tiles"
        ? <>
          {overlayNavigation.overflow && <div ref={overlayNavigationRef} className="flex shrink-0 items-center justify-center gap-1 px-1 pb-1">
            <Button variant="ghost" size="icon-xs" title="Предыдущие участники" aria-label="Предыдущие участники" disabled={!overlayNavigation.canPrevious} className="text-white hover:bg-white/10 hover:text-white" onClick={() => pageOverlay(-1)}>{participantsOnTop ? <ChevronLeft size={15} /> : <ChevronUp size={15} />}</Button>
            <Button variant="ghost" size="icon-xs" title="Следующие участники" aria-label="Следующие участники" disabled={!overlayNavigation.canNext} className="text-white hover:bg-white/10 hover:text-white" onClick={() => pageOverlay(1)}>{participantsOnTop ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</Button>
          </div>}
          <div ref={overlayTilesRef} aria-label="Видео участников" onScroll={updateOverlayNavigation} className={participantsOnTop
            ? "flex h-[clamp(84px,13vh,120px)] w-max max-w-full min-w-0 gap-2 overflow-x-auto p-2"
            : "flex min-h-0 flex-col gap-2 overflow-y-auto p-2"}>
            {members.map((person) => renderTile(person, participantsOnTop ? "top" : "left"))}
          </div>
        </>
        : <div aria-label="Список участников" className="min-h-0 flex-1 overflow-y-auto p-3">{renderParticipantList()}</div>)}
    </div>}
  </div>;
}
