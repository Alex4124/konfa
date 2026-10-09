"use client";

import type { CSSProperties } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import { ZoomFrame } from "@/components/zoom-frame";
import { CollapseButton, headerButton, PageNav, PaneShell, type Orientation, type PaneDrawing, type WorkspaceHostActions, type WorkspaceLayerProps, type WorkspacePart } from "@/components/workspace/pane-chrome";
import { BOARD_FRAME, MAX_BOARD_PAGES } from "@/lib/workspace";
import type { WorkspaceView } from "@/lib/confa-types";

// A dark «school board» (the palette's light colours read well on it) with a faint square grid that zooms with the marks.
const BOARD_GRID: CSSProperties = {
  backgroundImage: "linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)",
  backgroundSize: `2.5% ${2.5 * BOARD_FRAME.width / BOARD_FRAME.height}%`,
};

type Props = {
  view: WorkspaceView;
  layer: WorkspaceLayerProps;
  drawing: PaneDrawing;
  highlight: boolean;
  orientation: Orientation;
  host: WorkspaceHostActions | null;
  onActivate: (part: WorkspacePart) => void;
};

export function BoardPane({ view, layer, drawing, highlight, orientation, host, onActivate }: Props) {
  const surface = view.boardSurface;
  const controls = <>
    <PageNav label="Лист" page={view.boardPage} count={view.boardPages} onFlip={host ? (page) => host.flip("board", page) : undefined} />
    {host && <Button type="button" variant="ghost" size="icon-sm" title="Новый лист" aria-label="Новый лист" disabled={view.boardPages >= MAX_BOARD_PAGES} className={headerButton} onClick={host.addBoardPage}><Plus /></Button>}
    {host && <CollapseButton part="board" orientation={orientation} onClick={() => host.collapse("board", true)} />}
  </>;
  return <PaneShell part="board" title="Доска" controls={controls} highlight={highlight} onActivate={onActivate}>
    <ZoomFrame frame={BOARD_FRAME} frameless zoomable interaction={drawing.interaction} fingersDraw={drawing.fingersDraw} resetKey={surface} zoomLabel="Масштаб доски" frameClassName="bg-[#173a34]" media={<div aria-hidden className="absolute inset-0" style={BOARD_GRID} />}>
      <AnnotationLayer key={surface} {...layer} shareId={surface} toolKey={drawing.toolKey} toolbar={drawing.active ? drawing.toolbar : undefined} hotkeysEnabled={drawing.active} label="Пометки на доске" />
    </ZoomFrame>
  </PaneShell>;
}
