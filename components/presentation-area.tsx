"use client";

import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import type { TrackReference } from "@livekit/components-react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import { FloatingParticipantsPanel } from "@/components/floating-participants-panel";
import { CameraSizeControl, TileStrip, type RenderTile } from "@/components/participant-tiles";
import { SharedScreen } from "@/components/shared-screen";
import { useAnnotationPrefs, useArmedTool } from "@/hooks/use-annotation-prefs";
import { useCameraSize } from "@/hooks/use-camera-size";
import { useShortLayout } from "@/hooks/use-short-layout";
import { defaultToolFor, toolbarLayoutFor } from "@/lib/annotation-tools";
import { fitStrip } from "@/lib/tile-grid";
import { stripPlacement } from "@/lib/view-transform";
import type { RoomState, UiTool } from "@/lib/confa-types";

type Member = RoomState["members"][number];
// Room the toolbar container leaves: px-1 in a row (py-1 in a column); the expanded overlay starts at left-3 and stops short
// of the zoom controls in the frame's bottom-right corner (about 124 px with their inset) and a 12 px gap.
const ROW_MARGIN = 8;
const OVERLAY_MARGIN = 148;
// Space the toolbar takes beside the frame, for the strip choice: a row is its buttons with p-1.5, the border and py-1; a
// column is w-15, or w-28 with two (lib/annotation-tools toolbarLayoutFor).
const rowPx = (button: number) => button + 22;
const columnPx = (columns: 1 | 2) => columns === 2 ? 112 : 60;
type Area = { width: number; height: number; vw: number; vh: number };
// The top-right cluster over the share (RoomView passes its own buttons in the same look).
export const clusterButton = "bg-[#0e192c]/85 text-white shadow-xl hover:bg-[#243c5a] max-md:size-9 short:size-9";
export type PresentationLayerProps = Omit<ComponentProps<typeof AnnotationLayer>, "shareId" | "toolbar" | "portalContainer" | "onToolChange">;
type Props = {
  state: RoomState;
  activeScreen: TrackReference;
  members: Member[];
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  renderTile: RenderTile;
  renderParticipantList: () => ReactNode;
  layerProps: PresentationLayerProps;
  toolbarVisible: boolean;
  placeholder?: ReactNode; // shown instead of the share (the whole-screen presenter's mirror guard): no video, no layer, no toolbar
  actions?: ReactNode; // extra buttons left of «Развернуть экран»
};

export function PresentationArea({ state, activeScreen, members, expanded, onExpand, onCollapse, renderTile, renderParticipantList, layerProps, toolbarVisible: canShowToolbar, placeholder, actions }: Props) {
  const coarse = layerProps.coarse ?? false;
  const short = useShortLayout();
  const [overlayCollapsed, setOverlayCollapsed] = useState(coarse || short);
  const [area, setArea] = useState<Area>({ width: 0, height: 0, vw: 0, vh: 0 });
  const [frameAspect, setFrameAspect] = useState(16 / 9);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const [columnSize, setColumnSize] = useState({ width: 0, height: 0 }); // the frame and the toolbar beside or under it
  const [clusterWidth, setClusterWidth] = useState(64); // the top-right buttons: the expanded participants panel stops short of them
  const [wasExpanded, setWasExpanded] = useState(expanded);
  const presentationRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const shareId = state.room.activeShareId;
  const toolbarVisible = canShowToolbar && !placeholder;
  const [prefs] = useAnnotationPrefs();
  const [cameraSize] = useCameraSize();
  // Same store and fallback as the layer, so the frame's interaction always matches the armed tool.
  const [uiTool] = useArmedTool(shareId ?? "", defaultToolFor({ armedByDefault: layerProps.armedByDefault ?? false, coarse, lastDrawTool: prefs.lastDrawTool }));
  const interaction = layerProps.canDraw && uiTool !== "view" ? "draw" : "view";
  // The toolbar's own column (without the participants strip), so the full toolbar never scrolls sideways.
  const toolbarSpace = columnSize.width > 0 ? Math.max(1, columnSize.width - (expanded ? OVERLAY_MARGIN : ROW_MARGIN)) : 0;
  const toolbarLayout = toolbarLayoutFor({ expanded, coarse, short, areaWidth: toolbarSpace, areaHeight: columnSize.height > 0 ? Math.max(1, columnSize.height - ROW_MARGIN) : 0 });
  const placement = toolbarLayout.placement;
  // The participants strip goes where it leaves the larger frame, at the size its tiles take there; the expanded overlay keeps width ≥ height.
  const toolbarRow = toolbarVisible && placement === "row" ? rowPx(toolbarLayout.button) : 0;
  const toolbarColumn = toolbarVisible && placement === "column" ? columnPx(toolbarLayout.columns) : 0;
  const viewport = { width: area.vw, height: area.vh };
  const strips = { top: fitStrip(members.length, "top", cameraSize, area, viewport), left: fitStrip(members.length, "left", cameraSize, area, viewport) };
  const participantsOnTop = area.width <= 0 ? true : expanded ? area.width >= area.height : stripPlacement({ width: area.width - toolbarColumn, height: area.height - toolbarRow }, frameAspect, { top: strips.top.extent, left: strips.left.extent }) === "top";
  const strip = participantsOnTop ? strips.top : strips.left;
  const stripShown = !expanded && strip.extent > 0;
  // The expanded panel starts beside a toolbar column and leaves room for the share controls at the top-right.
  const besideColumn = toolbarVisible && placement === "column";
  const underToolbar = toolbarVisible && placement === "overlay";

  if (wasExpanded !== expanded) {
    setWasExpanded(expanded);
    if (expanded) {
      setOverlayCollapsed(coarse || short); // on phones the tiles would cover much of the frame: they start as the «N участников» chip
    }
  }

  // Measured before the first paint too: an unmeasured frame showed the full toolbar and no camera strip for a moment.
  useLayoutEffect(() => {
    const element = presentationRef.current, column = columnRef.current, cluster = clusterRef.current;
    if (!element || !column || !cluster) return;
    const win = element.ownerDocument.defaultView;
    const sizeArea = (width: number, height: number) => {
      const next: Area = { width: Math.round(width), height: Math.round(height), vw: win?.innerWidth ?? 0, vh: win?.innerHeight ?? 0 };
      setArea((current) => current.width === next.width && current.height === next.height && current.vw === next.vw && current.vh === next.vh ? current : next);
    };
    const first = element.getBoundingClientRect();
    sizeArea(first.width, first.height);
    const sizeColumn = (width: number, height: number) => setColumnSize((current) => current.width === Math.round(width) && current.height === Math.round(height) ? current : { width: Math.round(width), height: Math.round(height) });
    const firstColumn = column.getBoundingClientRect();
    sizeColumn(firstColumn.width, firstColumn.height);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) sizeArea(entry.contentRect.width, entry.contentRect.height);
        else if (entry.target === column) sizeColumn(entry.contentRect.width, entry.contentRect.height);
        else setClusterWidth(Math.round(entry.contentRect.width));
      }
    });
    observer.observe(element);
    observer.observe(column);
    observer.observe(cluster);
    return () => observer.disconnect();
  }, [expanded]);

  function toolChanged(tool: UiTool) {
    if (expanded && tool !== "view") setOverlayCollapsed(true);
  }

  return <div ref={presentationRef} style={{ "--cluster": `${clusterWidth}px` } as CSSProperties} className={`group/presentation relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0e192c] ${participantsOnTop ? "flex-col" : "flex-row"}`}>
    {stripShown && <TileStrip members={members} renderTile={renderTile} placement={participantsOnTop ? "top" : "left"} strip={strip} />}

    <div ref={columnRef} className={`relative flex min-h-0 min-w-0 flex-1 ${placement === "column" ? "flex-row" : "flex-col"}`}>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
        {placeholder ?? <SharedScreen trackRef={activeScreen} frameless zoomable interaction={interaction} resetKey={shareId} onFrameChange={setFrameAspect}>
          {shareId && <AnnotationLayer key={shareId} {...layerProps} shareId={shareId} toolbar={{ container: toolbarContainer, layout: toolbarLayout }} onToolChange={toolChanged} />}
        </SharedScreen>}
        {!expanded && !placeholder && <span className="pointer-events-none absolute left-3 top-3 max-w-[min(50%,calc(100%-var(--cluster)-36px))] truncate rounded-lg bg-[#0e192c]/80 px-3 py-1.5 text-xs text-white short:hidden">{activeScreen.participant.name || "Демонстрация экрана"}</span>}
      </div>
      {toolbarVisible && <div ref={setToolbarContainer} className={placement === "overlay"
        ? "absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 z-40 flex max-w-[calc(100%-148px)]"
        : placement === "column" ? `order-first flex ${toolbarLayout.columns === 2 ? "w-28" : "w-15"} shrink-0 flex-col items-center py-1` : `flex min-h-12 shrink-0 px-1 ${expanded ? "pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]" : "py-1"}`} />}
    </div>

    <div ref={clusterRef} style={{ "--strip": `${stripShown && participantsOnTop ? strip.extent : 0}px` } as CSSProperties} className={`absolute right-3 z-40 flex items-center gap-2 ${expanded ? "top-[max(0.75rem,env(safe-area-inset-top))]" : "top-[calc(var(--strip)+12px)] short:top-3"}`}>
      {stripShown && <CameraSizeControl className="bg-[#0e192c]/85 shadow-xl" />}
      {actions}
      <Button variant="secondary" size="icon-lg" title={expanded ? "Свернуть экран" : "Развернуть экран"} aria-label={expanded ? "Свернуть экран" : "Развернуть экран"} className={clusterButton} onClick={() => expanded ? onCollapse() : onExpand()}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
    </div>

    {expanded && <FloatingParticipantsPanel boundaryRef={presentationRef} members={members} renderTile={renderTile} renderParticipantList={renderParticipantList}
      orientation={participantsOnTop ? "top" : "left"} collapsed={overlayCollapsed} onCollapsedChange={setOverlayCollapsed}
      initialLeft={besideColumn ? columnPx(toolbarLayout.columns) + 12 : 12} reservedRight={clusterWidth + 24} reservedBottom={underToolbar ? 88 : 12} />}
  </div>;
}
