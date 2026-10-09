"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, MonitorUp, Presentation, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoardPane } from "@/components/workspace/board-pane";
import { DocumentPane } from "@/components/workspace/document-pane";
import { PaneRail, type PaneDrawing, type WorkspaceHostActions, type WorkspaceLayerProps, type WorkspacePart } from "@/components/workspace/pane-chrome";
import { useAnnotationPrefs, useArmedTool } from "@/hooks/use-annotation-prefs";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { MaterialUpload } from "@/hooks/use-material-upload";
import { defaultToolFor, toolbarLayoutFor } from "@/lib/annotation-tools";
import { workspaceLayout } from "@/lib/workspace";
import type { Member, WorkspaceView } from "@/lib/confa-types";

type Size = { width: number; height: number };
type Props = {
  view: WorkspaceView;
  roomId: string;
  isHost: boolean;
  canDraw: boolean;
  coarse: boolean;
  members: Member[];
  renderTile: (person: Member, layout: "grid" | "top") => ReactNode;
  board: WorkspaceLayerProps;
  doc: WorkspaceLayerProps;
  host: WorkspaceHostActions | null;
  upload: MaterialUpload | null;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onShowShare?: () => void; // a screen share runs as well: switch the stage to it
  recording?: boolean; // the egress scene: only the two parts, no bar, no strip
};

const ROW_MARGIN = 8;
const EMPTY: Size = { width: 0, height: 0 };

// The teacher's workspace on the stage: the board and the material side by side (stacked on narrow screens), one toolbar for both.
// The toolbar, Ctrl+Z and «Очистить» act on the active part, the one last pressed; collapsing a part (teacher only) leaves a rail.
export function WorkspaceArea({ view, roomId, isHost, canDraw, coarse, members, renderTile, board, doc, host, upload, expanded, onExpand, onCollapse, onShowShare, recording = false }: Props) {
  const [focus, setFocus] = useState<WorkspacePart>("board");
  const [area, setArea] = useState<Size>(EMPTY);
  const [columnWidth, setColumnWidth] = useState(0);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const short = useMediaQuery("(max-height: 520px)");
  const [prefs] = useAnnotationPrefs();
  const toolKey = `ws:${view.id}`;
  // The layers' own fallback (same inputs), so the frames take the pointer exactly while a tool draws.
  const [uiTool] = useArmedTool(toolKey, defaultToolFor({ armedByDefault: board.armedByDefault, coarse, lastDrawTool: prefs.lastDrawTool }));
  const layout = workspaceLayout({ width: area.width, height: area.height, boardCollapsed: view.boardCollapsed, docCollapsed: view.docCollapsed, hasDoc: Boolean(view.doc), isHost });
  const boardDrawable = layout.board === "pane";
  const docDrawable = layout.doc === "pane" && Boolean(view.doc);
  const active: WorkspacePart | null = boardDrawable && (focus === "board" || !docDrawable) ? "board" : docDrawable ? "doc" : null;
  const toolbarVisible = canDraw && active !== null;
  const toolbarLayout = toolbarLayoutFor({ expanded: false, coarse, short, areaWidth: columnWidth > 0 ? Math.max(1, columnWidth - ROW_MARGIN) : 0 });
  const column = toolbarVisible && toolbarLayout.placement === "column";
  const drawing = (part: WorkspacePart): PaneDrawing => ({
    toolKey,
    interaction: canDraw && uiTool !== "view" ? "draw" : "view",
    fingersDraw: prefs.fingersDraw,
    toolbar: { container: toolbarContainer, layout: toolbarLayout },
    active: active === part,
  });
  // The ring shows which part the toolbar acts on, when there are two to choose from.
  const highlight = (part: WorkspacePart) => canDraw && boardDrawable && docDrawable && active === part;

  useEffect(() => {
    const element = areaRef.current, columnElement = columnRef.current;
    if (!element || !columnElement) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.round(entry.contentRect.width), height = Math.round(entry.contentRect.height);
        if (entry.target === columnElement) setColumnWidth(width);
        else setArea((current) => current.width === width && current.height === height ? current : { width, height });
      }
    });
    observer.observe(element);
    observer.observe(columnElement);
    return () => observer.disconnect();
  }, []);

  const rail = (part: WorkspacePart) => <PaneRail key={`${part}-rail`} part={part} orientation={layout.orientation} busy={part === "doc" && Boolean(upload)} onExpand={host ? () => host.collapse(part, false) : undefined} />;

  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#0e192c]">
    {!expanded && !recording && !layout.grid && members.length > 0 && <div aria-label="Видео участников" className="flex h-[clamp(64px,11vh,136px)] shrink-0 gap-2 overflow-x-auto px-2 pt-2 short:hidden">
      {members.map((person) => renderTile(person, "top"))}
    </div>}

    {!recording && <div className="flex min-h-11 shrink-0 items-center gap-2 px-3 pt-2">
      <Presentation size={18} className="shrink-0 text-[#9af4e7]" />
      <span className="truncate text-sm font-semibold max-sm:hidden">Доска и материалы</span>
      {host
        ? <Button type="button" variant="secondary" size="sm" aria-pressed={view.allDraw} title={view.allDraw ? "Сейчас рисуют все ученики. Выключить — останутся только вызванные к доске" : "Включить, чтобы рисовать могли все ученики. Вызвать одного — кнопка «К доске» в списке участников"} className={`text-white hover:bg-[#3e5673] ${view.allDraw ? "bg-[#317b75]" : "bg-[#2d415d]"}`} onClick={() => host.setAllDraw(!view.allDraw)}><Users />Все ученики рисуют: {view.allDraw ? "да" : "нет"}</Button>
        : canDraw && <span className="rounded-full bg-[#6de7d4]/15 px-2.5 py-1 text-xs font-medium text-[#9af4e7]">Вы у доски — можно рисовать</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {onShowShare && <Button type="button" variant="secondary" size="sm" title="Показать демонстрацию экрана" aria-label="Показать демонстрацию экрана" className="bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={onShowShare}><MonitorUp /><span className="max-sm:hidden">Демонстрация</span></Button>}
        <Button type="button" variant="secondary" size="icon-sm" title={expanded ? "Свернуть" : "Развернуть на весь экран"} aria-label={expanded ? "Свернуть" : "Развернуть на весь экран"} className="bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={expanded ? onCollapse : onExpand}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
      </div>
    </div>}

    <div ref={columnRef} className={`flex min-h-0 min-w-0 flex-1 ${column ? "flex-row" : "flex-col"}`}>
      <div ref={areaRef} className={`flex min-h-0 min-w-0 flex-1 gap-2 p-2 ${layout.orientation === "row" ? "flex-row" : "flex-col"}`}>
        {layout.board === "rail" && rail("board")}
        {layout.board === "pane" && <BoardPane view={view} layer={board} drawing={drawing("board")} highlight={highlight("board")} orientation={layout.orientation} host={host} onActivate={setFocus} />}
        {layout.grid && <div aria-label="Видео участников" className="grid min-h-0 min-w-0 flex-1 auto-rows-[minmax(120px,1fr)] grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2 overflow-y-auto">
          {members.map((person) => renderTile(person, "grid"))}
        </div>}
        {layout.doc === "pane" && <DocumentPane view={view} roomId={roomId} layer={doc} drawing={drawing("doc")} highlight={highlight("doc")} orientation={layout.orientation} host={host} upload={upload} onActivate={setFocus} />}
        {layout.doc === "rail" && rail("doc")}
      </div>
      {toolbarVisible && <div ref={setToolbarContainer} className={column ? "order-first flex w-15 shrink-0 flex-col items-center justify-center py-1" : "flex min-h-12 shrink-0 justify-center px-1 pb-1"} />}
    </div>
  </div>;
}
