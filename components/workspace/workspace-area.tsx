"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minimize2, MonitorUp, Presentation, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AnnotationToolbar, type ToolbarPicker } from "@/components/annotations/annotation-toolbar";
import { ClearAllDialog } from "@/components/annotations/clear-dialog";
import { BoardPane } from "@/components/workspace/board-pane";
import { DocumentPane } from "@/components/workspace/document-pane";
import { CameraSizeControl, TileGrid, TileStrip, type RenderTile } from "@/components/participant-tiles";
import { PaneRail, type PaneApi, type PaneDrawing, type WorkspaceHostActions, type WorkspaceLayerProps, type WorkspacePart } from "@/components/workspace/pane-chrome";
import { useAnnotationHotkeys } from "@/hooks/use-annotation-hotkeys";
import { useAnnotationPrefs, useArmedTool } from "@/hooks/use-annotation-prefs";
import { useCameraSize } from "@/hooks/use-camera-size";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { MaterialUpload } from "@/hooks/use-material-upload";
import { useHubHistory } from "@/hooks/use-surface-hub";
import type { WorkspaceFollow } from "@/hooks/use-workspace-view";
import { defaultToolFor, resolveEscape, toolbarLayoutFor, type HotkeyAction, type PrefsPatch, type TextSize } from "@/lib/annotation-tools";
import { fitStrip } from "@/lib/tile-grid";
import { boardRange, docSurface, parseSurface, workspaceLayout } from "@/lib/workspace";
import type { Member, UiTool, WorkspaceView } from "@/lib/confa-types";

type Size = { width: number; height: number };
type Props = {
  view: WorkspaceView;
  roomId: string;
  isHost: boolean;
  canDraw: boolean;
  coarse: boolean;
  members: Member[];
  renderTile: RenderTile;
  layer: WorkspaceLayerProps;
  follow: WorkspaceFollow;
  host: WorkspaceHostActions | null;
  upload: MaterialUpload | null;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onShowShare?: () => void; // a screen share runs as well: switch the stage to it
  recording?: boolean; // the egress scene: only the two parts, no bar, no strip
};
type Clearing = { part: "board" } | { part: "doc"; docId: string; page: number; count: number };

const ROW_MARGIN = 8;
const EMPTY: Size = { width: 0, height: 0 };
const NO_STAGE = { width: 0, height: 0, vw: 0, vh: 0 }; // the whole workspace with its strip, and the window
const NO_PREFIX = "\u0000"; // matches no surface
// Tools whose marks stay inside one band of the board: its seams show while one of them is armed.
const BAND_TOOLS: ReadonlySet<UiTool> = new Set<UiTool>(["line", "arrow", "dashed", "rect", "circle", "triangle", "hexagon", "text", "move"]);
const SCROLL_KEYS: Readonly<Record<string, number>> = { PageDown: 0.9, PageUp: -0.9, ArrowDown: 0.12, ArrowUp: -0.12 }; // of a screen

// Keys typed into a control, a text or an open menu are not scroll keys.
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && typeof element.closest === "function" && (element.isContentEditable || element.closest("input, textarea, select, button, a, [role=slider], [role=dialog], [role=alertdialog], [role=menu], [data-slot=popover-content]")));
}

// The teacher's workspace on the stage: the endless board and the material side by side (stacked on narrow screens), each a
// column the teacher scrolls and everyone follows. One toolbar for both: the tool and the ink are shared; undo, redo and
// «Очистить» act on the active part, the one last pressed. Collapsing a part (teacher only) leaves a rail.
export function WorkspaceArea({ view, roomId, isHost, canDraw, coarse, members, renderTile, layer, follow, host, upload, expanded, onExpand, onCollapse, onShowShare, recording = false }: Props) {
  const [focus, setFocus] = useState<WorkspacePart>("board");
  const [area, setArea] = useState<Size>(EMPTY);
  const [columnWidth, setColumnWidth] = useState(0);
  const [stage, setStage] = useState(NO_STAGE);
  const [penOnly, setPenOnly] = useState(false);
  const [openPicker, setOpenPicker] = useState<ToolbarPicker | null>(null);
  const [editing, setEditing] = useState<{ part: WorkspacePart; color: string; size: TextSize } | null>(null); // the open text editor, if any
  const [clearing, setClearing] = useState<Clearing | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const boardApi = useRef<PaneApi>(null);
  const docApi = useRef<PaneApi>(null);
  const short = useMediaQuery("(max-height: 520px)");
  const [cameraSize] = useCameraSize();
  const [prefs, updatePrefs] = useAnnotationPrefs();
  const toolKey = `ws:${view.id}`;
  // The tiles' layers read the same key with the same fallback, so they draw with what the toolbar shows.
  const [armed, setArmed] = useArmedTool(toolKey, defaultToolFor({ armedByDefault: layer.armedByDefault, coarse, lastDrawTool: prefs.lastDrawTool }));
  const tool: UiTool = canDraw ? armed : "view";
  const layout = workspaceLayout({ width: area.width, height: area.height, boardCollapsed: view.boardCollapsed, docCollapsed: view.docCollapsed, hasDoc: Boolean(view.doc), isHost });
  const docId = view.doc?.id ?? null;
  const boardShown = layout.board === "pane";
  const docShown = layout.doc === "pane" && docId !== null;
  const active: WorkspacePart | null = boardShown && (focus === "board" || !docShown) ? "board" : docShown ? "doc" : null;
  const toolbarVisible = canDraw && active !== null && !recording;
  const toolbarLayout = toolbarLayoutFor({ expanded: false, coarse, short, areaWidth: columnWidth > 0 ? Math.max(1, columnWidth - ROW_MARGIN) : 0 });
  const column = toolbarVisible && toolbarLayout.placement === "column";
  // The cameras above the parts: as tall as the viewer's camera size allows and their rows need.
  const strip = !expanded && !recording && !layout.grid ? fitStrip(members.length, "top", cameraSize, stage, { width: stage.vw, height: stage.vh }) : null;
  const stripShown = Boolean(strip && strip.extent > 0);
  // The surfaces undo and redo walk through: the active part's.
  const prefix = active === "board" ? boardRange(view.id).from : active === "doc" && docId ? `d:${docId}:` : NO_PREFIX;
  const history = useHubHistory(layer.hub, prefix);
  const strips = () => [boardApi.current?.strip, docApi.current?.strip];
  const drawing: PaneDrawing = {
    toolKey,
    color: prefs.paperColor,
    interaction: canDraw && tool !== "view" ? "draw" : "view",
    fingersDraw: prefs.fingersDraw,
    penOnly,
    onPenOnlyChange: setPenOnly,
    seams: canDraw && BAND_TOOLS.has(tool),
  };
  // The ring shows which part the toolbar acts on, when there are two to choose from.
  const highlight = (part: WorkspacePart) => toolbarVisible && boardShown && docShown && active === part;
  // The toolbar shows and changes the ink for white paper; the screen share keeps its own colour.
  const paperPrefs = useMemo(() => ({ ...prefs, color: prefs.paperColor }), [prefs]);
  const shownEditing = editing && (editing.part === "board" ? boardShown : docShown) ? editing : null;
  const paneWidth = layout.orientation === "row" && boardShown && layout.doc === "pane" ? area.width / 2 : area.width;
  if (openPicker && !toolbarVisible) setOpenPicker(null);
  if (clearing && (!toolbarVisible || (clearing.part === "doc" && clearing.docId !== docId))) setClearing(null);

  useEffect(() => {
    const element = areaRef.current, columnElement = columnRef.current, rootElement = rootRef.current;
    if (!element || !columnElement || !rootElement) return;
    const win = rootElement.ownerDocument.defaultView;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.round(entry.contentRect.width), height = Math.round(entry.contentRect.height);
        if (entry.target === columnElement) setColumnWidth(width);
        else if (entry.target === rootElement) {
          const vw = win?.innerWidth ?? 0, vh = win?.innerHeight ?? 0;
          setStage((current) => current.width === width && current.height === height && current.vw === vw && current.vh === vh ? current : { width, height, vw, vh });
        } else setArea((current) => current.width === width && current.height === height ? current : { width, height });
      }
    });
    observer.observe(element);
    observer.observe(columnElement);
    observer.observe(rootElement);
    return () => observer.disconnect();
  }, []);

  // A stroke is being drawn somewhere (an open text also keeps its layer busy, but it is not a gesture).
  const stroking = () => !editing && strips().some((strip) => strip?.busy());

  function changePrefs(patch: PrefsPatch) {
    const { color, ...rest } = patch;
    updatePrefs(color === undefined ? rest : { ...rest, paperColor: color });
    for (const strip of strips()) strip?.restyle(patch); // the open text takes the new colour or size
  }

  function selectTool(next: UiTool) {
    // An open text is saved first; it stays open (and the tool with it) when it does not fit yet.
    if (editing ? strips().some((strip) => strip && !strip.commitText()) : stroking()) return;
    setArmed(next);
    setOpenPicker(null);
  }

  async function step(direction: "undo" | "redo") {
    if (stroking()) return;
    const done = await (direction === "undo" ? layer.hub.undo(prefix) : layer.hub.redo(prefix));
    const surface = done.id ? parseSurface(done.id) : null;
    // The mark may be on a band or a page that has scrolled away: show where it happened.
    if (surface) (surface.kind === "board" ? boardApi : docApi).current?.strip?.reveal(surface.page);
    if (!done.result.ok && done.result.code === "gone") toast("Эту пометку уже удалили", { id: "annotation-gone" });
  }

  function requestClear() {
    if (active === "board") setClearing({ part: "board" });
    else if (active === "doc" && docId) {
      const page = docApi.current?.current?.() ?? 0;
      setClearing({ part: "doc", docId, page, count: docApi.current?.strip?.layer(page)?.count() ?? 0 });
    }
  }

  function onHotkey(action: HotkeyAction): boolean {
    if (action.type === "escape") {
      const next = resolveEscape({ overlayOpen: openPicker !== null || clearing !== null, gestureActive: stroking(), tool });
      if (next === "cancel-gesture") for (const strip of strips()) strip?.cancelStroke();
      else if (next === "view") selectTool("view");
      return next !== "pass";
    }
    if (action.type === "undo" || action.type === "redo") {
      void step(action.type);
      return true;
    }
    if (!prefs.hotkeys || stroking()) return false;
    selectTool(action.tool);
    return true;
  }

  useAnnotationHotkeys({ win: typeof window === "undefined" ? null : window, enabled: toolbarVisible, onAction: onHotkey });

  // The teacher scrolls the active part from the keyboard: PgUp/PgDn, Space, the arrows, Home/End.
  const onScrollKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    const strip = (active === "doc" ? docApi : boardApi).current?.strip;
    if (!strip || !active) return;
    const by = event.key === " " ? (event.shiftKey ? -0.9 : 0.9) : SCROLL_KEYS[event.key];
    if (by !== undefined) strip.scrollBy(by);
    else if (event.key === "Home") strip.scrollTo(0, true);
    else if (event.key === "End") strip.scrollTo(active === "doc" ? Math.max(0, (view.doc?.pageCount ?? 1) - 1) : Math.max(0, view.boardPages - 1), true);
    else return;
    event.preventDefault();
  });
  useEffect(() => {
    if (!isHost || recording) return;
    const listener = (event: KeyboardEvent) => onScrollKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [isHost, recording]);

  // A press anywhere else in the workspace saves the open text (the text itself, the toolbar and its menus do not).
  function commitTexts(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as Element | null;
    if (!editing || target?.closest?.("textarea, .annotation-toolbar, [data-slot=popover-content], [role=dialog], [role=alertdialog]")) return;
    for (const strip of strips()) strip?.commitText();
  }

  const onEditing = (part: WorkspacePart, style: { color: string; size: TextSize } | null) => setEditing(style ? { part, ...style } : null);
  const rail = (part: WorkspacePart) => <PaneRail key={`${part}-rail`} part={part} orientation={layout.orientation} busy={part === "doc" && Boolean(upload)} onExpand={host ? () => host.collapse(part, false) : undefined} />;

  return <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#0e192c]" onPointerDownCapture={commitTexts}>
    {strip && stripShown && <TileStrip members={members} renderTile={renderTile} placement="top" strip={strip} />}

    {!recording && <div className="flex min-h-11 shrink-0 items-center gap-2 px-3 pt-2">
      <Presentation size={18} className="shrink-0 text-[#9af4e7]" />
      <span className="truncate text-sm font-semibold max-sm:hidden">Доска и материалы</span>
      {host
        ? <Button type="button" variant="secondary" size="sm" aria-pressed={view.allDraw} title={view.allDraw ? "Сейчас рисуют все ученики. Выключить — останутся только вызванные к доске" : "Включить, чтобы рисовать могли все ученики. Вызвать одного — кнопка «К доске» в списке участников"} className={`text-white hover:bg-[#3e5673] ${view.allDraw ? "bg-[#317b75]" : "bg-[#2d415d]"}`} onClick={() => host.setAllDraw(!view.allDraw)}><Users />Все ученики рисуют: {view.allDraw ? "да" : "нет"}</Button>
        : canDraw && <span className="rounded-full bg-[#6de7d4]/15 px-2.5 py-1 text-xs font-medium text-[#9af4e7]">Вы у доски — можно рисовать</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {stripShown && <CameraSizeControl className="bg-[#2d415d]" />}
        {onShowShare && <Button type="button" variant="secondary" size="sm" title="Показать демонстрацию экрана" aria-label="Показать демонстрацию экрана" className="bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={onShowShare}><MonitorUp /><span className="max-sm:hidden">Демонстрация</span></Button>}
        <Button type="button" variant="secondary" size="icon-sm" title={expanded ? "Свернуть" : "Развернуть на весь экран"} aria-label={expanded ? "Свернуть" : "Развернуть на весь экран"} className="bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={expanded ? onCollapse : onExpand}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
      </div>
    </div>}

    <div ref={columnRef} className={`flex min-h-0 min-w-0 flex-1 ${column ? "flex-row" : "flex-col"}`}>
      <div ref={areaRef} className={`flex min-h-0 min-w-0 flex-1 gap-2 p-2 ${layout.orientation === "row" ? "flex-row" : "flex-col"}`}>
        {layout.board === "rail" && rail("board")}
        {layout.board === "pane" && <BoardPane api={boardApi} view={view} layer={layer} drawing={drawing} follow={follow} highlight={highlight("board")} orientation={layout.orientation} host={host} onActivate={setFocus} onEditing={onEditing} />}
        {layout.grid && <TileGrid members={members} renderTile={renderTile} />}
        {layout.doc === "pane" && <DocumentPane api={docApi} view={view} roomId={roomId} layer={layer} drawing={drawing} follow={follow} highlight={highlight("doc")} orientation={layout.orientation} host={host} upload={upload} onActivate={setFocus} onEditing={onEditing} />}
        {layout.doc === "rail" && rail("doc")}
      </div>
      {toolbarVisible && <div className={column ? "order-first flex w-15 shrink-0 flex-col items-center justify-center py-1" : "flex min-h-12 shrink-0 justify-center px-1 pb-1"}>
        <AnnotationToolbar tool={tool} prefs={paperPrefs} layout={toolbarLayout} coarse={coarse} canModerate={layer.canModerate} markCount={1} clearLabel={active === "board" ? "Очистить всю доску" : "Стереть пометки на странице"}
          canUndo={history.canUndo} canRedo={history.canRedo} penOnly={penOnly} boxHeight={Math.max(240, paneWidth * 9 / 16)} editingText={Boolean(shownEditing)} textStyle={shownEditing ? { color: shownEditing.color, size: shownEditing.size } : null}
          openPicker={openPicker} onOpenPicker={setOpenPicker} onTool={selectTool} onPrefs={changePrefs} onUndo={() => void step("undo")} onRedo={() => void step("redo")} onClearRequest={requestClear}
          onFingersDraw={(enabled) => {
            updatePrefs({ fingersDraw: enabled });
            if (enabled) setPenOnly(false);
          }} />
      </div>}
    </div>

    {host && <AlertDialog open={clearing?.part === "board"} onOpenChange={(open) => { if (!open) setClearing(null); }}>
      <AlertDialogContent size="sm" className="border-white/15 bg-[#1c2c45] text-white">
        <AlertDialogHeader>
          <AlertDialogTitle>Очистить всю доску?</AlertDialogTitle>
          <AlertDialogDescription>Все пометки на доске, сверху донизу, будут удалены у всех участников. Отменить это действие нельзя.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white">Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => {
            host.clearBoard();
            boardApi.current?.strip?.rewind(); // a clean board starts from its top, for everyone
          }}>Очистить доску</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
    {layer.canModerate && <ClearAllDialog open={clearing?.part === "doc"} count={clearing?.part === "doc" ? clearing.count : 0} onOpenChange={(open) => { if (!open) setClearing(null); }} onConfirm={() => {
      if (clearing?.part === "doc") void layer.hub.surface(docSurface(clearing.docId, clearing.page)).actions?.clear();
    }} />}
  </div>;
}
