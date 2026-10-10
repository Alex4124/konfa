"use client";

import { useImperativeHandle, useMemo, useRef, type CSSProperties, type Ref } from "react";
import { ArrowUpToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollStripView, SurfaceLayer, type StripApi } from "@/components/workspace/scroll-strip-view";
import { CollapseButton, headerButton, PaneShell, type Orientation, type PaneApi, type PaneDrawing, type PaneEditing, type WorkspaceHostActions, type WorkspaceLayerProps, type WorkspacePart } from "@/components/workspace/pane-chrome";
import { useFollowTarget, type WorkspaceFollow } from "@/hooks/use-workspace-view";
import { boardExtent, uniformLayout } from "@/lib/scroll-strip";
import { BOARD_ASPECT, BOARD_GRID_COLUMNS, BOARD_PIXEL_WIDTH, boardSurface, MAX_BOARD_BANDS } from "@/lib/workspace";
import type { WorkspaceView } from "@/lib/confa-types";

// The whole board, wherever it is scrolled to: 200 bands of 16:9. Only the bands near the viewport are mounted.
const BOARD_LAYOUT = uniformLayout(MAX_BOARD_BANDS, BOARD_ASPECT);
const BAND_ROWS = 1 / BOARD_ASPECT;
const GRID = "rgba(15, 35, 60, .09)";

// White paper with a faint square grid, one element under all bands so the lines run unbroken across them.
function paper({ width, rows }: { width: number; rows: number }) {
  const cell = width / BOARD_GRID_COLUMNS;
  const style: CSSProperties = { width, height: rows * width, backgroundImage: `linear-gradient(${GRID} 1px, transparent 1px), linear-gradient(90deg, ${GRID} 1px, transparent 1px)`, backgroundSize: `${cell}px ${cell}px` };
  return <div aria-hidden className="absolute left-0 top-0 bg-white" style={style} />;
}

type Props = {
  view: WorkspaceView;
  layer: WorkspaceLayerProps;
  drawing: PaneDrawing;
  follow: WorkspaceFollow;
  highlight: boolean;
  orientation: Orientation;
  host: WorkspaceHostActions | null;
  api?: Ref<PaneApi>;
  onActivate: (part: WorkspacePart) => void;
  onEditing: PaneEditing;
};

// The teacher's endless white board: it scrolls down as far as anyone needs, there is always a clean band below the last marks.
export function BoardPane({ view, layer, drawing, follow, highlight, orientation, host, api, onActivate, onEditing }: Props) {
  const strip = useRef<StripApi>(null);
  const bands = view.boardPages;
  const docId = view.doc?.id ?? null;
  const key = useMemo(() => ({ ws: view.id, docId }), [view.id, docId]);
  const target = useFollowTarget(follow, "board", key, view.boardPos, Boolean(host));
  useImperativeHandle(api, () => ({ get strip() { return strip.current; } }), []);
  const controls = host && <>
    <Button type="button" variant="ghost" size="icon-sm" title="В начало доски" aria-label="В начало доски" className={headerButton} onClick={() => strip.current?.scrollTo(0, true)}><ArrowUpToLine /></Button>
    <CollapseButton part="board" orientation={orientation} onClick={() => host.collapse("board", true)} />
  </>;
  return <PaneShell part="board" title="Доска" controls={controls} highlight={highlight} onActivate={onActivate}>
    <ScrollStripView api={strip} layout={BOARD_LAYOUT} pixelWidth={BOARD_PIXEL_WIDTH} resetKey={view.id} fitAspect={null} host={Boolean(host)} start={view.boardPos} target={target} onIntent={() => follow.touch("board")} onView={(seen, settled) => follow.report("board", key, seen, settled)}
      extent={(bottom) => boardExtent({ bands, bottom, bandHeight: BAND_ROWS, max: MAX_BOARD_BANDS })} seamless
      interaction={drawing.interaction} fingersDraw={drawing.fingersDraw} penOnly={drawing.penOnly} onPenOnlyChange={drawing.onPenOnlyChange} zoomLabel="Масштаб доски" background={paper}
      tile={(index, slot) => <>
        {/* Lines, shapes, text and moved marks stay inside a band: the seam shows while such a tool is armed. */}
        {drawing.seams && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 border-b border-dashed border-slate-400/60" />}
        <SurfaceLayer hub={layer.hub} id={boardSurface(view.id, index)} slot={slot} selfId={layer.selfId} canDraw={layer.canDraw} canModerate={layer.canModerate} armedByDefault={layer.armedByDefault} coarse={layer.coarse} toolKey={drawing.toolKey} color={drawing.color} label="Пометки на доске" onEditing={(style) => onEditing("board", style)} />
      </>} />
  </PaneShell>;
}
