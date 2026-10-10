"use client";

import { memo, useCallback, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { AnnotationToolbar, type ToolbarPicker } from "@/components/annotations/annotation-toolbar";
import { AuthorChip, authorLabel } from "@/components/annotations/author-chip";
import { ClearAllDialog } from "@/components/annotations/clear-dialog";
import { LaserLayer } from "@/components/annotations/laser";
import { renderAnnotation, renderHighlight } from "@/components/annotations/render-annotation";
import { TextEditor, type TextEditorState } from "@/components/annotations/text-editor";
import { getMeasureEm } from "@/components/annotations/text-measure";
import { useFrame } from "@/components/shared-screen";
import { useAnnotationHotkeys } from "@/hooks/use-annotation-hotkeys";
import { useAnnotationPrefs, useArmedTool } from "@/hooks/use-annotation-prefs";
import { useAnnotationHistory, useBoard, useDrafts, useHiddenIds, type AnnotationSync } from "@/hooks/use-annotation-sync";
import { CLICK_PX, constrainEnd, eraseHits, finalizeFreehand, fontPx, hitRadiusFor, isDegenerate, isFreehand, normFromClient, pickForMove, pushFiltered, round4, roundPoint, TEXT_SIZE_UNITS, textUnits, translateAnnotation, type HitItem, type Rect, type Size } from "@/lib/annotation-geometry";
import { abortGesture, gestureInput, gestureStep, initialGesture, isTentativeResolved, PALM_GUARD_MS, pointerKind, startsTentative, TENTATIVE_MS, type GestureState, type PointerKind, type TentativeSample } from "@/lib/annotation-gesture";
import { DRAFT_SEND_MS, randomId, type DraftItem } from "@/lib/annotation-drafts";
import { laserLife, pushLaserPoints } from "@/lib/annotation-laser";
import { defaultMaxWidth, fitMaxWidth, nearestTextSize, normalizeText, placeTextAnchor, TEXT_LINE_HEIGHT, TEXT_PAD_Y, textFits, textLines, textMetrics } from "@/lib/annotation-text";
import { defaultToolFor, isCreatingTool, LASER_COLOR, markAnchor, resolveEscape, widthGroup, type HotkeyAction, type PrefsPatch, type TextSize, type ToolbarLayout } from "@/lib/annotation-tools";
import { edgeExit, type EdgeExit } from "@/lib/scroll-strip";
import type { AnnotationStore, BoardItem } from "@/lib/annotation-sync";
import type { AnnotationKind, AnnotationPayload, LaserStyle, Point, UiTool } from "@/lib/confa-types";

type Props = {
  shareId: string;
  sync: AnnotationSync;
  selfId?: string;
  canDraw?: boolean;
  canModerate?: boolean;
  armedByDefault?: boolean; // host or share owner: starts with the last drawing tool on a fine pointer
  coarse?: boolean;
  toolbar?: { container: HTMLElement | null; layout: ToolbarLayout };
  portalContainer?: HTMLElement | null; // popovers and the dialog (PiP body); undefined = document.body
  showSavedAuthors?: boolean; // overrides prefs.showAuthors
  toolKey?: string; // the armed tool's key (default: shareId); the workspace's two parts share one
  hotkeysEnabled?: boolean; // false for a workspace part that is not the active one
  label?: string; // the svg's accessible name
  onToolChange?: (tool: UiTool) => void;
  onNotice?: (text: string, id: string) => void; // the layer's own notices (PiP: sonner toasts would land in the hidden opener)
  // A tile of the workspace's strips: no toolbar, hotkeys or dialog of its own; the workspace drives it through `handle`.
  color?: string; // ink for new marks instead of prefs.color (white paper has its own)
  tone?: "dark" | "light"; // what the marks lie on: light paper gets a dark hover highlight
  handle?: Ref<LayerHandle>;
  onEditing?: (style: { color: string; size: TextSize } | null) => void; // the open text editor's look, for the toolbar
  // A pen, laser or eraser stroke left through the top or bottom edge. A neighbouring layer that takes it over returns the
  // relay this layer forwards the pointer's further events to (the pointer capture stays here).
  onEdge?: (handoff: EdgeHandoff) => PointerRelay | null;
};

// A pointer event reduced to what a stroke needs, so one layer can pass a pointer on to another.
export type PointerInput = { pointerId: number; pointerType: string; clientX: number; clientY: number; buttons: number; shiftKey: boolean; samples: ReadonlyArray<{ clientX: number; clientY: number }> };
type StrokeSpec = { type: "draw"; kind: AnnotationKind; color: string; strokeWidth: number } | { type: "laser"; style: LaserStyle; color: string; strokeWidth?: number } | { type: "erase"; radius: number };
// x, y: the point on the edge (client px); next: the input that crossed it, with the samples beyond the edge.
export type EdgeHandoff = { edge: EdgeExit["edge"]; x: number; y: number; pointerId: number; pointerType: string; tentative: boolean; start: TentativeSample; spec: StrokeSpec; next: PointerInput };
export type PointerRelay = { move(input: PointerInput): void; up(input: PointerInput): void; cancel(): void };
export type LayerHandle = {
  commitText(): boolean; // false: the open text stays open (too long for its place)
  cancelStroke(): boolean; // true: there was a gesture to cancel
  busy(): boolean; // a stroke, a relayed pointer or an open text: the tile must stay mounted
  restyle(patch: PrefsPatch): void; // the toolbar's colour and size, for the open text
  count(): number; // saved marks on this surface
  pointer: { adopt(handoff: EdgeHandoff): boolean; move(input: PointerInput): void; up(input: PointerInput): void; cancel(pointerId: number): void };
};

// One pointer gesture at a time, kept in a ref so handlers never see a stale closure.
// A finger stays tentative (not drawn, not sent) until it lasts TENTATIVE_MS or moves TENTATIVE_PX, so a pinch never flashes a mark.
// at: the pointer's last position (client px), to see where it leaves the layer.
type StrokeBase = { pointerId: number; pointer: PointerKind; start: TentativeSample; tentative: boolean; timer: number | null; at: { x: number; y: number } };
type StrokeEnd = { end: Point; rect: Rect; shiftKey: boolean; clientX: number; clientY: number; before?: Point[]; exact?: boolean };
type Stroke = StrokeBase & (
  | { type: "draw"; id: string; kind: AnnotationKind; color: string; strokeWidth: number; origin: Point; points: Point[]; sent: boolean; end: Point; aspect: number } // end, aspect: the last pointer sample, re-constrained when Shift changes
  | { type: "laser"; id: string; style: LaserStyle; color: string; strokeWidth?: number; points: Point[]; sent: boolean; trail: DraftItem | null }
  | { type: "drag"; id: string; draftId: string; kind: AnnotationKind; data: AnnotationPayload; origin: Point; moved: AnnotationPayload; dx: number; dy: number; sent: boolean }
  | { type: "erase"; gesture: string; last: Point; radius: number; queued: string[] }
);
type LivePatch = { mark?: HitItem | null; hideId?: string | null; hoverId?: string | null; lasers?: readonly DraftItem[] };
type LiveStore = {
  subscribe(listener: () => void): () => void;
  mark(): HitItem | null;
  hideId(): string | null;
  hoverId(): string | null;
  lasers(): readonly DraftItem[]; // this member's laser and ink trails, fading after release
  // With `win`, listeners hear about it on that window's next frame; without, at once (the pointerup handoff lands in one commit).
  set(patch: LivePatch, win?: Window | null): void;
};
type NameOf = (identity: string) => string | undefined;

const EMPTY_ITEMS: readonly BoardItem[] = [];
const NO_LASERS: readonly DraftItem[] = [];
const DOUBLE_TAP_MS = 400;
const READABLE_TEXT_PX = 14; // smaller text asks the frame to zoom in (Stage 5)
const LASER_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Ccircle cx='8' cy='8' r='5' fill='%23ff3b5c' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") 8 8, crosshair`;
const now = () => performance.now();

// The local stroke preview, the dragged id, the hover id and the own laser trails: they change every frame, so only the parts that draw them re-render.
function createLiveStore(): LiveStore {
  let mark: HitItem | null = null, hideId: string | null = null, hoverId: string | null = null, lasers = NO_LASERS;
  let frame = 0, frameWin: Window | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (frame && frameWin) frameWin.cancelAnimationFrame(frame);
    frame = 0;
    frameWin = null;
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    mark: () => mark,
    hideId: () => hideId,
    hoverId: () => hoverId,
    lasers: () => lasers,
    set(patch, win) {
      if (patch.mark !== undefined) mark = patch.mark;
      if (patch.hideId !== undefined) hideId = patch.hideId;
      if (patch.hoverId !== undefined) hoverId = patch.hoverId;
      if (patch.lasers !== undefined) lasers = patch.lasers;
      if (!win) emit();
      else if (!frame) {
        frameWin = win;
        frame = win.requestAnimationFrame(() => {
          frame = 0;
          frameWin = null;
          emit();
        });
      }
    },
  };
}

function inputOf(event: ReactPointerEvent<SVGSVGElement>): PointerInput {
  const native = event.nativeEvent;
  const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
  const samples = (coalesced.length ? coalesced : [native]).map((sample) => ({ clientX: sample.clientX, clientY: sample.clientY }));
  return { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, buttons: event.buttons, shiftKey: event.shiftKey, samples };
}

function pointsOf(samples: PointerInput["samples"], rect: Rect): Point[] {
  return samples.map((sample) => normFromClient(sample.clientX, sample.clientY, rect));
}

function shifted(item: HitItem, dx: number, dy: number): HitItem | null {
  try { return { id: item.id, kind: item.kind, data: translateAnnotation(item.data, dx, dy).payload }; }
  catch { return null; }
}

function capture(svg: SVGSVGElement, pointerId: number) {
  try { svg.setPointerCapture(pointerId); } catch { /* The pointer is already gone */ }
}

// click and dblclick are PointerEvents in current browsers; older ones report a mouse.
function pointerTypeOf(event: ReactMouseEvent): string {
  const native = event.nativeEvent as MouseEvent & { pointerType?: string };
  return native.pointerType || "mouse";
}

// The own trail list: replaces `item` and drops trails that have faded out.
function withTrail(list: readonly DraftItem[], item: DraftItem, t: number): DraftItem[] {
  return [...list.filter((other) => other.key !== item.key && laserLife(other, t) > 0), item];
}

// New samples arrived within the last send interval, even after the pointer was held still (their age drives the comet fade).
function extendTrail(item: DraftItem, added: readonly Point[], t: number): DraftItem {
  return pushLaserPoints(item.lastSeen < t - DRAFT_SEND_MS ? { ...item, lastSeen: t - DRAFT_SEND_MS } : item, added, t);
}

function px(point: Point, box: Size): [number, number] {
  return [point[0] * box.width, point[1] * box.height];
}

// Author label above a saved mark (hover, or "Показывать авторов"); counter-scaled so zoom does not grow it.
function MarkChip({ item, box, scale, nameOf }: { item: BoardItem; box: Size; scale: number; nameOf: NameOf }) {
  const anchor = markAnchor(item.kind, item.data);
  if (!anchor) return null;
  return <AuthorChip anchor={px(anchor, box)} name={authorLabel(item.authorName, item.authorId, nameOf)} color={item.data.color} box={box} scale={scale} prefer="above" />;
}

// Saved marks; re-renders on board changes and when the dragged or edited mark changes, never per live packet.
const CommittedLayer = memo(function CommittedLayer({ store, items, live, box, editingId }: { store: AnnotationStore; items: readonly BoardItem[]; live: LiveStore; box: Size; editingId: string | null }) {
  const hiddenIds = useHiddenIds(store);
  const dragged = useSyncExternalStore(live.subscribe, live.hideId, live.hideId);
  const marks = useMemo(() => items.map((item) => hiddenIds.has(item.id) || item.id === dragged || item.id === editingId ? null : renderAnnotation(item, box)), [items, hiddenIds, dragged, editingId, box]);
  return <g>{marks}</g>;
});

// Peers' live strokes and move previews with their authors' names; the only part that re-renders per draft packet (lasers are LaserLayer's).
const DraftLayer = memo(function DraftLayer({ store, byId, box, scale, selfId }: { store: AnnotationStore; byId: ReadonlyMap<string, BoardItem>; box: Size; scale: number; selfId?: string }) {
  const drafts = useDrafts(store);
  return <g>{drafts.items.map((item) => {
    if (item.kind === "laser") return null;
    const name = item.identity === selfId ? null : authorLabel(item.authorName, item.identity, store.nameOf);
    if (item.moveOf) {
      const row = byId.get(item.moveOf);
      const moved = row && shifted(row, item.dx ?? 0, item.dy ?? 0);
      if (!moved) return null;
      const anchor = markAnchor(moved.kind, moved.data);
      return <g key={item.key}>{renderAnnotation({ ...moved, id: item.key }, box)}{name !== null && anchor && <AuthorChip anchor={px(anchor, box)} name={name} color={moved.data.color} box={box} scale={scale} prefer="above" />}</g>;
    }
    const points = item.points as Point[];
    const last = points[points.length - 1];
    return <g key={item.key}>{renderAnnotation({ id: item.key, kind: item.kind, data: { color: item.color, strokeWidth: item.strokeWidth, points } }, box)}{name !== null && last && item.phase === "live" && <AuthorChip anchor={px(last, box)} name={name} color={item.color} box={box} scale={scale} />}</g>;
  })}</g>;
});

// This member's stroke or move preview in progress.
const LiveStroke = memo(function LiveStroke({ live, box }: { live: LiveStore; box: Size }) {
  const mark = useSyncExternalStore(live.subscribe, live.mark, live.mark);
  return mark ? renderAnnotation(mark, box) : null;
});

// Snapshot of the peers' laser drafts that keeps its reference while they are unchanged (draft items are cached per entry),
// so pen and move packets do not re-render the laser layer or restart its frame loop.
function laserDraftsOf(store: AnnotationStore): () => readonly DraftItem[] {
  let seen: readonly DraftItem[] | null = null, lasers = NO_LASERS;
  return () => {
    const items = store.getDrafts().items;
    if (items === seen) return lasers;
    seen = items;
    const next = items.filter((item) => item.kind === "laser");
    if (next.length !== lasers.length || next.some((item, i) => item !== lasers[i])) lasers = next.length ? next : NO_LASERS;
    return lasers;
  };
}

// Peers' lasers from the draft store plus this member's own trails; faded own trails are dropped once the layer goes idle.
const Lasers = memo(function Lasers({ store, live, box, win, selfId, scale }: { store: AnnotationStore; live: LiveStore; box: Size; win: Window | null; selfId?: string; scale: number }) {
  const read = useMemo(() => laserDraftsOf(store), [store]);
  const remote = useSyncExternalStore(store.subscribeDrafts, read, read);
  const local = useSyncExternalStore(live.subscribe, live.lasers, live.lasers);
  const onIdle = useCallback(() => {
    const t = now(), list = live.lasers();
    const kept = list.filter((item) => item.phase === "live" || laserLife(item, t) > 0);
    if (kept.length !== list.length) live.set({ lasers: kept.length ? kept : NO_LASERS });
  }, [live]);
  return <LaserLayer items={remote} local={local} box={box} win={win} selfId={selfId} scale={scale} nameOf={store.nameOf} onIdle={onIdle} />;
});

const HoverHighlight = memo(function HoverHighlight({ live, byId, box, scale, tone }: { live: LiveStore; byId: ReadonlyMap<string, BoardItem>; box: Size; scale: number; tone: "dark" | "light" }) {
  const hoverId = useSyncExternalStore(live.subscribe, live.hoverId, live.hoverId);
  const item = hoverId ? byId.get(hoverId) : undefined;
  return item ? renderHighlight(item, box, scale, tone) : null;
});

const HoverChip = memo(function HoverChip({ live, byId, box, scale, nameOf }: { live: LiveStore; byId: ReadonlyMap<string, BoardItem>; box: Size; scale: number; nameOf: NameOf }) {
  const hoverId = useSyncExternalStore(live.subscribe, live.hoverId, live.hoverId);
  const item = hoverId ? byId.get(hoverId) : undefined;
  return item ? <MarkChip item={item} box={box} scale={scale} nameOf={nameOf} /> : null;
});

const AuthorChips = memo(function AuthorChips({ store, items, live, box, scale, editingId }: { store: AnnotationStore; items: readonly BoardItem[]; live: LiveStore; box: Size; scale: number; editingId: string | null }) {
  const hiddenIds = useHiddenIds(store);
  const dragged = useSyncExternalStore(live.subscribe, live.hideId, live.hideId);
  return <g>{items.map((item) => hiddenIds.has(item.id) || item.id === dragged || item.id === editingId ? null : <MarkChip key={item.id} item={item} box={box} scale={scale} nameOf={store.nameOf} />)}</g>;
});

export function AnnotationLayer({ shareId, sync, selfId, canDraw = false, canModerate = false, armedByDefault = false, coarse = false, toolbar, portalContainer, showSavedAuthors, toolKey, hotkeysEnabled = true, label = "Пометки поверх демонстрации", onToolChange, onNotice, color, tone = "dark", handle, onEditing, onEdge }: Props) {
  const [prefs, updatePrefs] = useAnnotationPrefs();
  const [armed, setArmed] = useArmedTool(toolKey ?? shareId, defaultToolFor({ armedByDefault, coarse, lastDrawTool: prefs.lastDrawTool }));
  const [openPicker, setOpenPicker] = useState<ToolbarPicker | null>(null);
  const [editing, setEditing] = useState<TextEditorState | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const [live] = useState(createLiveStore);
  const frame = useFrame();
  const { box: size, aspect, ready, scale, onGestureStart } = frame;
  const board = useBoard(sync.store);
  const history = useAnnotationHistory(sync.store);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const gestureRef = useRef<GestureState>(initialGesture);
  const closedEditor = useRef<string | null>(null); // key of the editor already saved or cancelled (blur can follow Enter)
  const suppressClick = useRef(false); // the pointerdown that saved the open text must not open a new one
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  const relayRef = useRef<{ pointerId: number; sink: PointerRelay } | null>(null); // a stroke another layer took over at an edge
  const ink = color ?? prefs.color;
  const actions = sync.actions;
  const permitted = canDraw && Boolean(actions);
  // The store still holds the previous page (its snapshot is on the way): writes would go there, so nothing draws yet.
  const synced = board.shareId === shareId;
  const active = permitted && synced;
  const tool: UiTool = permitted ? armed : "view";
  const drawing = ready && active && tool !== "view" && frame.interaction === "draw";
  const win = svgEl?.ownerDocument.defaultView ?? null;
  const items = board.shareId === shareId ? board.items : EMPTY_ITEMS;
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const clearAllowed = active && canModerate;
  const showAuthors = showSavedAuthors ?? prefs.showAuthors;
  const fa = aspect >= .1 && aspect <= 10 ? round4(aspect) : undefined;
  const editingId = editing?.targetId ?? null;
  const [prevActive, setPrevActive] = useState(active);
  const notify = (text: string, id: string) => onNotice ? onNotice(text, id) : toast(text, { id });

  // Permission changed (E4): drop only local transient UI; the stroke and drafts are cancelled in the effect below.
  if (prevActive !== active) {
    setPrevActive(active);
    setOpenPicker(null);
    setClearOpen(false);
    setEditing(null);
  }
  if (clearOpen && !clearAllowed) setClearOpen(false);
  if (openPicker && !toolbar?.container) setOpenPicker(null); // the toolbar moved to the other part of the workspace
  // The text being edited was erased by someone else: keep the typing, it becomes a new mark.
  if (editing?.targetId && board.shareId === shareId && !byId.has(editing.targetId)) setEditing({ ...editing, targetId: undefined, original: undefined });

  // Marks this member may move, erase or edit (own, or any as moderator), read at event time so handlers see the newest board.
  function changeableItems(): readonly BoardItem[] {
    const view = sync.store.getBoard();
    if (view.shareId !== shareId) return EMPTY_ITEMS;
    return canModerate ? view.items : view.items.filter((item) => item.authorId === selfId);
  }

  function pickText(point: Point, rect: Rect, pointerType: string): BoardItem | null {
    const texts = changeableItems().filter((item) => item.kind === "text");
    const id = pickForMove(texts, point, rect, hitRadiusFor(pointerType));
    return texts.find((item) => item.id === id) ?? null;
  }

  function liveMarkOf(stroke: Stroke): HitItem | null {
    if (stroke.type === "erase" || stroke.type === "laser") return null;
    if (stroke.type === "drag") return { id: stroke.draftId, kind: stroke.kind, data: stroke.moved };
    return { id: stroke.id, kind: stroke.kind, data: { color: stroke.color, strokeWidth: stroke.strokeWidth, points: stroke.points.slice() } };
  }

  function stopTimer(stroke: Stroke) {
    if (stroke.timer !== null) win?.clearTimeout(stroke.timer);
    stroke.timer = null;
  }

  // The stroke becomes real: drawn, sent to peers, and the overlays around the frame fade (data-annotating).
  function reveal(stroke: Stroke) {
    stroke.tentative = false;
    stopTimer(stroke);
    svgEl?.setAttribute("data-annotating", "true");
    if (!actions) return;
    const timers = win ?? undefined;
    if (stroke.type === "erase") {
      if (stroke.queued.length) actions.erase(stroke.queued.splice(0), stroke.gesture);
      return;
    }
    if (stroke.type === "drag") {
      actions.draft.begin({ id: stroke.draftId, kind: stroke.kind, color: stroke.data.color, moveOf: stroke.id }, timers);
      if (stroke.dx || stroke.dy) actions.draft.update(stroke.draftId, { dx: stroke.dx, dy: stroke.dy });
      stroke.sent = true;
      live.set({ mark: liveMarkOf(stroke), hideId: stroke.id });
      return;
    }
    if (stroke.type === "laser") {
      actions.draft.begin({ id: stroke.id, kind: "laser", style: stroke.style, color: stroke.color, strokeWidth: stroke.strokeWidth }, timers);
      stroke.sent = true;
      actions.draft.update(stroke.id, { points: stroke.points });
      const t = now();
      stroke.trail = extendTrail({ key: stroke.id, identity: selfId ?? "", authorName: "", kind: "laser", style: stroke.style, color: stroke.color, strokeWidth: stroke.strokeWidth, points: [], pointTimes: [], phase: "live", lastSeen: t }, stroke.points, t);
      live.set({ lasers: withTrail(live.lasers(), stroke.trail, t) });
      return;
    }
    actions.draft.begin({ id: stroke.id, kind: stroke.kind, color: stroke.color, strokeWidth: stroke.strokeWidth }, timers);
    stroke.sent = true;
    actions.draft.update(stroke.id, { points: stroke.points });
    live.set({ mark: liveMarkOf(stroke) });
  }

  // Ends the stroke without saving: peers drop the draft; marks already erased stay erased (one undo step).
  function dropStroke() {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    if (!stroke) return;
    stopTimer(stroke);
    svgEl?.removeAttribute("data-annotating");
    live.set({ mark: null, hideId: null, ...(stroke.type === "laser" ? { lasers: live.lasers().filter((item) => item.key !== stroke.id) } : {}) });
    if (stroke.type === "erase") void actions?.flushErase();
    else if (stroke.sent) actions?.draft.cancel(stroke.type === "drag" ? stroke.draftId : stroke.id);
  }

  // The single cancel path: arbiter gesture, pointercancel, lost capture without pointerup, hidden page, unmount, revoke, Esc.
  function cancelStroke() {
    const relay = relayRef.current;
    relayRef.current = null;
    relay?.sink.cancel();
    gestureRef.current = abortGesture(gestureRef.current);
    dropStroke();
  }

  function eraseAlong(stroke: Extract<Stroke, { type: "erase" }>, points: readonly Point[], rect: Rect) {
    const targets = changeableItems();
    const ids = new Set<string>();
    for (const point of points) {
      for (const id of eraseHits(targets, stroke.last, point, rect, stroke.radius)) ids.add(id);
      stroke.last = point;
    }
    if (!ids.size) return;
    if (stroke.tentative) stroke.queued.push(...[...ids].filter((id) => !stroke.queued.includes(id)));
    else actions?.erase([...ids], stroke.gesture);
  }

  // Text editing

  // Opens the editor and focuses it inside the user's gesture: iOS shows the keyboard only for a focus() made there.
  function showEditor(next: TextEditorState) {
    live.set({ hoverId: null });
    setOpenPicker(null);
    setEditing(next);
    editorRef.current?.focus({ preventScroll: true });
  }

  function openText(point: Point) {
    const units = TEXT_SIZE_UNITS[prefs.textSize];
    const textPx = fontPx(units, size.height);
    if (textPx * scale < READABLE_TEXT_PX && textPx > 0) frame.ensureScale(READABLE_TEXT_PX / textPx, point);
    const maxWidth = fitMaxWidth(point[0], defaultMaxWidth(size, textPx));
    const anchor = placeTextAnchor(point, { w: maxWidth, h: (TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y) * textPx / Math.max(1, size.height) });
    showEditor({ key: randomId(), point: anchor, color: ink, fontSize: units, maxWidth, text: "" });
  }

  function openEdit(item: BoardItem) {
    const { data } = item;
    if (item.kind !== "text" || !data.point) return;
    const fontSize = textUnits(data);
    const text = data.text ?? textLines(data).join("\n");
    const maxWidth = data.maxWidth ?? fitMaxWidth(data.point[0], defaultMaxWidth(size, fontPx(fontSize, size.height)));
    showEditor({ key: randomId(), targetId: item.id, point: data.point, color: data.color, fontSize, maxWidth, text, original: { text, color: data.color, fontSize } });
  }

  function closeEditor(state: TextEditorState) {
    closedEditor.current = state.key;
    setEditing(null);
  }

  // Saves the open text; false when it stays open (too long for the frame). Empty text erases an edited mark (undoable).
  function commitText(state: TextEditorState | null = editing): boolean {
    if (!state || closedEditor.current === state.key) return true;
    const text = normalizeText(state.text);
    const target = state.targetId ? byId.get(state.targetId) : undefined;
    if (!text) {
      closeEditor(state);
      if (target && actions) {
        actions.erase([target.id], randomId());
        void actions.flushErase();
      }
      return true;
    }
    const metrics = textMetrics({ text, fontSize: state.fontSize, maxWidth: state.maxWidth, box: size, measure: getMeasureEm() });
    if (!textFits(metrics)) {
      notify("Слишком длинный текст для этого места", "annotation-text-long");
      return false;
    }
    closeEditor(state);
    if (!actions) return true;
    const style = { text, lines: metrics.lines, color: state.color, fontSize: state.fontSize, maxWidth: state.maxWidth, w: metrics.w, h: metrics.h };
    if (target) {
      const { original } = state;
      // The point stays: the server re-clamps the mark into the frame.
      if (!original || original.text !== text || original.color !== state.color || original.fontSize !== state.fontSize) void actions.edit(target.id, style);
      return true;
    }
    const point = translateAnnotation({ color: state.color, point: state.point, w: metrics.w, h: metrics.h }, 0, 0).payload.point ?? state.point;
    void actions.add("text", { ...style, point, fa }, randomId()).then((result) => {
      // Not saved after the retries: give the text back unless another editor is open.
      if (!result.ok && (result.code === "network" || result.code === "rate")) setEditing((current) => current ?? { ...state, key: randomId() });
    });
    return true;
  }

  function cancelText() {
    if (editing) closeEditor(editing);
  }

  // Toolbar colour and size also restyle the open editor; a new text re-fits its width to the size.
  function changePrefs(patch: PrefsPatch) {
    updatePrefs(patch);
    restyle(patch);
  }

  function restyle(patch: PrefsPatch) {
    if (!editing || (patch.color === undefined && patch.textSize === undefined)) return;
    const next = { ...editing };
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.textSize !== undefined) {
      next.fontSize = TEXT_SIZE_UNITS[patch.textSize];
      if (!next.targetId) next.maxWidth = fitMaxWidth(next.point[0], defaultMaxWidth(size, fontPx(next.fontSize, size.height)));
    }
    setEditing(next);
  }

  // Pointer pipeline

  // Starts a stroke for the tool; false when nothing started (the gesture guard then forgets the pointer).
  function startStroke(event: ReactPointerEvent<SVGSVGElement>): boolean {
    if (!drawing || !actions) return false;
    const svg = event.currentTarget;
    const kind = pointerKind(event.pointerType);
    if (!frame.zoomable) {
      // Without the zoom arbiter the layer rejects the palm itself: after a pen touch, fingers stop drawing.
      if (kind === "touch" && frame.penOnly) return false;
      if (kind === "pen" && !frame.penOnly && !prefs.fingersDraw) frame.setPenOnly(true);
    }
    if (editing) {
      // A press outside the editor saves it (and keeps focus in it, should it stay open); its click opens nothing.
      event.preventDefault();
      suppressClick.current = true;
      commitText();
      return false;
    }
    if (tool === "text") {
      // The editor opens on click, the event iOS allows to raise the keyboard.
      if (kind === "mouse") event.preventDefault();
      return false;
    }
    const rect = svg.getBoundingClientRect();
    const point = normFromClient(event.clientX, event.clientY, rect);
    const base: StrokeBase = { pointerId: event.pointerId, pointer: kind, start: { t: now(), x: event.clientX, y: event.clientY }, tentative: startsTentative(kind), timer: null, at: { x: event.clientX, y: event.clientY } };
    let stroke: Stroke;
    if (tool === "eraser") stroke = { ...base, type: "erase", gesture: randomId(), last: point, radius: hitRadiusFor(event.pointerType), queued: [] };
    else if (tool === "move") {
      const targets = changeableItems();
      const id = pickForMove(targets, point, rect, hitRadiusFor(event.pointerType));
      const item = id ? targets.find((entry) => entry.id === id) : undefined;
      if (!item) return false;
      stroke = { ...base, type: "drag", id: item.id, draftId: randomId(), kind: item.kind, data: item.data, origin: point, moved: item.data, dx: 0, dy: 0, sent: false };
    } else if (tool === "laser") {
      const vanishing = prefs.laserStyle === "ink";
      stroke = { ...base, type: "laser", id: randomId(), style: prefs.laserStyle, color: vanishing ? ink : LASER_COLOR, strokeWidth: vanishing ? prefs.widths.pen : undefined, points: [point], sent: false, trail: null };
    } else if (isCreatingTool(tool)) stroke = { ...base, type: "draw", id: randomId(), kind: tool, color: ink, strokeWidth: prefs.widths[widthGroup(tool) ?? "pen"], origin: point, points: [point], sent: false, end: point, aspect: rect.width / rect.height };
    else return false;
    capture(svg, event.pointerId);
    begin(stroke, point, rect);
    return true;
  }

  // The stroke is now the layer's gesture: shown at once, or once a finger has proved it is not the start of a pinch.
  function begin(stroke: Stroke, point: Point, rect: Rect) {
    strokeRef.current = stroke;
    live.set({ hoverId: null });
    if (stroke.type === "erase") eraseAlong(stroke, [point], rect);
    if (!stroke.tentative) reveal(stroke);
    else if (win) {
      stroke.timer = win.setTimeout(() => {
        stroke.timer = null;
        if (strokeRef.current === stroke && stroke.tentative) reveal(stroke);
      }, TENTATIVE_MS);
    }
  }

  // Takes over a stroke that left the neighbouring band through the shared edge: it goes on here from the edge point as a new
  // mark. The pointer stays captured by the layer it started on, which relays its events (pointer.move / up / cancel).
  function adopt(handoff: EdgeHandoff): boolean {
    if (!drawing || !actions || !svgEl || strokeRef.current || editing) return false;
    const rect = svgEl.getBoundingClientRect();
    const point = normFromClient(handoff.x, handoff.y, rect);
    const base: StrokeBase = { pointerId: handoff.pointerId, pointer: pointerKind(handoff.pointerType), start: handoff.start, tentative: handoff.tentative, timer: null, at: { x: handoff.x, y: handoff.y } };
    const { spec } = handoff;
    const stroke: Stroke = spec.type === "erase" ? { ...base, type: "erase", gesture: randomId(), last: point, radius: spec.radius, queued: [] }
      : spec.type === "laser" ? { ...base, type: "laser", id: randomId(), style: spec.style, color: spec.color, strokeWidth: spec.strokeWidth, points: [point], sent: false, trail: null }
        : { ...base, type: "draw", id: randomId(), kind: spec.kind, color: spec.color, strokeWidth: spec.strokeWidth, origin: point, points: [point], sent: false, end: point, aspect: rect.width / rect.height };
    begin(stroke, point, rect);
    return true;
  }

  // A pen, laser or eraser stroke crossed the top or bottom edge: if the layer beyond takes it over, this one ends its part
  // exactly on the edge (a still tentative finger just lets go, nothing was shown) and relays the pointer from now on.
  function handOff(stroke: Stroke, exit: EdgeExit, input: PointerInput, rect: DOMRect, dom: boolean): boolean {
    if (!onEdge || stroke.type === "drag" || (stroke.type === "draw" && !isFreehand(stroke.kind))) return false;
    const beyond = (y: number) => exit.edge === "bottom" ? y > rect.bottom : y < rect.top;
    const cut = input.samples.findIndex((sample) => beyond(sample.clientY));
    const rest = cut < 0 ? [] : input.samples.slice(cut);
    const spec: StrokeSpec = stroke.type === "draw" ? { type: "draw", kind: stroke.kind, color: stroke.color, strokeWidth: stroke.strokeWidth }
      : stroke.type === "laser" ? { type: "laser", style: stroke.style, color: stroke.color, strokeWidth: stroke.strokeWidth } : { type: "erase", radius: stroke.radius };
    const next: PointerInput = { ...input, samples: rest.length ? rest : [{ clientX: input.clientX, clientY: input.clientY }] };
    const sink = onEdge({ edge: exit.edge, x: exit.x, y: exit.y, pointerId: stroke.pointerId, pointerType: input.pointerType, tentative: stroke.tentative, start: stroke.start, spec, next });
    if (!sink) return false;
    if (stroke.tentative) {
      strokeRef.current = null;
      stopTimer(stroke);
    } else endStroke(stroke, { end: normFromClient(exit.x, exit.y, rect), rect, shiftKey: input.shiftKey, clientX: exit.x, clientY: exit.y, before: pointsOf(cut < 0 ? input.samples : input.samples.slice(0, cut), rect), exact: true });
    if (dom) relayRef.current = { pointerId: stroke.pointerId, sink };
    return true;
  }

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    // The zoom arbiter took this pointer for a pan or pinch (it prevents the default of every pointerdown it takes in draw mode).
    if (frame.zoomable && event.nativeEvent.defaultPrevented) return;
    suppressClick.current = false;
    relayRef.current = null; // a relay whose pointerup was lost
    if (!frame.zoomable) {
      // Two fingers never draw; a pen beats the palm (lib/annotation-gesture).
      const { state, effect } = gestureStep(gestureRef.current, gestureInput("down", event, now()));
      if (effect === "cancel" || effect === "cancel-start") dropStroke();
      gestureRef.current = state;
      if (event.pointerType === "touch" && state.blocked.includes(event.pointerId)) capture(event.currentTarget, event.pointerId);
      if (effect !== "start" && effect !== "cancel-start") return;
    } else {
      if (event.button !== 0) return;
      const current = strokeRef.current;
      if (current && current.pointerId !== event.pointerId) return;
      if (current) dropStroke(); // its pointerup was lost
    }
    if (!startStroke(event)) gestureRef.current = abortGesture(gestureRef.current);
  }

  function hover(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType === "touch" || event.buttons !== 0 || strokeRef.current) return;
    let id: string | null = null;
    if (!editing && (tool === "move" || tool === "eraser" || tool === "text")) {
      const rect = event.currentTarget.getBoundingClientRect();
      const point = normFromClient(event.clientX, event.clientY, rect);
      id = tool === "text" ? pickText(point, rect, event.pointerType)?.id ?? null : pickForMove(changeableItems(), point, rect, hitRadiusFor(event.pointerType));
    }
    if (id !== live.hoverId()) live.set({ hoverId: id }, win);
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    const relay = relayRef.current;
    if (relay && relay.pointerId === event.pointerId) {
      relay.sink.move(inputOf(event));
      return;
    }
    const stroke = strokeRef.current;
    let extend = Boolean(stroke && stroke.pointerId === event.pointerId);
    if (!frame.zoomable) {
      const { state, effect } = gestureStep(gestureRef.current, gestureInput("move", event, now()));
      gestureRef.current = state;
      extend = extend && effect === "extend";
    }
    // A mouse or pen moving with no button held lost its pointerup (e.g. alt-tab): drop the stroke instead of drawing on hover.
    if (stroke && extend && stroke.pointer !== "touch" && event.buttons === 0) {
      cancelStroke();
      extend = false;
    }
    if (!stroke || !extend) {
      hover(event);
      return;
    }
    moveStroke(inputOf(event), true);
  }

  // Extends the layer's stroke with a pointer move: its own event (dom), or one relayed from the layer that holds the capture.
  function moveStroke(input: PointerInput, dom: boolean) {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== input.pointerId || !svgEl) return;
    if (!dom && stroke.pointer !== "touch" && input.buttons === 0) {
      dropStroke();
      return;
    }
    const rect = svgEl.getBoundingClientRect();
    const exit = onEdge ? edgeExit(stroke.at, { x: input.clientX, y: input.clientY }, { top: rect.top, bottom: rect.bottom }) : null;
    stroke.at = { x: input.clientX, y: input.clientY };
    if (exit && handOff(stroke, exit, input, rect, dom)) return;
    const samples = pointsOf(input.samples, rect);
    const last = samples[samples.length - 1];
    let added = 0;
    let changed = true;
    if (stroke.type === "erase") {
      eraseAlong(stroke, samples, rect);
      changed = false;
    } else if (stroke.type === "drag") {
      const moved = translateAnnotation(stroke.data, last[0] - stroke.origin[0], last[1] - stroke.origin[1]);
      changed = moved.dx !== stroke.dx || moved.dy !== stroke.dy;
      if (changed) {
        stroke.dx = moved.dx;
        stroke.dy = moved.dy;
        stroke.moved = moved.payload;
      }
    } else if (stroke.type === "laser" || isFreehand(stroke.kind)) {
      added = pushFiltered(stroke.points, samples, rect);
      changed = added > 0;
    } else {
      stroke.end = last;
      stroke.aspect = rect.width / rect.height;
      stroke.points = [stroke.origin, constrainEnd(stroke.kind, stroke.origin, last, stroke.aspect, input.shiftKey)];
    }
    if (stroke.tentative) {
      if (isTentativeResolved(stroke.start, { t: now(), x: input.clientX, y: input.clientY })) reveal(stroke);
      return;
    }
    if (!changed || stroke.type === "erase") return;
    if (stroke.type === "drag") actions?.draft.update(stroke.draftId, { dx: stroke.dx, dy: stroke.dy });
    else actions?.draft.update(stroke.id, { points: stroke.points });
    if (stroke.type === "laser") {
      if (!stroke.trail) return;
      const t = now();
      stroke.trail = extendTrail(stroke.trail, stroke.points.slice(-added), t);
      live.set({ lasers: withTrail(live.lasers(), stroke.trail, t) }, win);
      return;
    }
    live.set({ mark: liveMarkOf(stroke) }, win);
  }

  // A tap on a text mark with the move tool; the second within DOUBLE_TAP_MS opens it for editing.
  function tapText(id: string) {
    const t = now(), previous = lastTap.current;
    if (previous && previous.id === id && t - previous.t <= DOUBLE_TAP_MS) {
      lastTap.current = null;
      const item = byId.get(id);
      if (item) openEdit(item);
    } else lastTap.current = { id, t };
  }

  // Draft end, the pending add/move and clearing the preview happen in this one handler, so they land in one commit.
  // `before` and `exact`: a stroke handed over at an edge ends with these samples and then exactly on the edge point.
  function endStroke(stroke: Stroke, { end, rect, shiftKey, clientX, clientY, before, exact }: StrokeEnd) {
    strokeRef.current = null;
    stopTimer(stroke);
    svgEl?.removeAttribute("data-annotating");
    if (stroke.type === "erase") {
      if (exact) eraseAlong(stroke, [...(before ?? []), end], rect);
      if (stroke.queued.length) actions?.erase(stroke.queued, stroke.gesture);
      void actions?.flushErase();
      return;
    }
    if (stroke.type === "drag") {
      // A finger or stylus that barely moved tapped: no move, and two taps on a text open it.
      const tap = stroke.pointer !== "mouse" && Math.hypot(clientX - stroke.start.x, clientY - stroke.start.y) < CLICK_PX;
      const moved = tap ? null : translateAnnotation(stroke.data, end[0] - stroke.origin[0], end[1] - stroke.origin[1]);
      if (moved && (moved.dx || moved.dy)) {
        if (stroke.sent) actions?.draft.end(stroke.draftId, { dx: moved.dx, dy: moved.dy });
        void actions?.move(stroke.id, moved.dx, moved.dy, stroke.sent ? stroke.draftId : undefined);
      } else if (stroke.sent) actions?.draft.cancel(stroke.draftId);
      live.set({ mark: null, hideId: null });
      if (tap && stroke.kind === "text") tapText(stroke.id);
      return;
    }
    if (exact) {
      // The part before the edge, then the edge point itself, whatever the distance filter would say.
      if (before?.length) pushFiltered(stroke.points, before, rect);
      const tail = stroke.points[stroke.points.length - 1];
      if (!tail || tail[0] !== end[0] || tail[1] !== end[1]) stroke.points.push(end);
    }
    if (stroke.type === "laser") {
      if (stroke.sent) actions?.draft.end(stroke.id, stroke.style === "ink" ? { points: finalizeFreehand(stroke.points, aspect) } : exact ? { points: stroke.points } : undefined);
      if (stroke.trail) {
        const t = now();
        live.set({ lasers: withTrail(live.lasers(), { ...stroke.trail, phase: "ended", endedAt: t }, t) });
      }
      return;
    }
    let points: Point[] | null = null;
    if (isFreehand(stroke.kind)) {
      if (!exact) pushFiltered(stroke.points, [end], rect);
      points = finalizeFreehand(stroke.points, aspect);
    } else {
      const target = constrainEnd(stroke.kind, stroke.origin, end, rect.width / rect.height, shiftKey);
      if (!isDegenerate(stroke.kind, stroke.origin, target, rect)) points = [roundPoint(stroke.origin), roundPoint(target)];
    }
    if (points && points.length >= 2 && actions) {
      if (stroke.sent) actions.draft.end(stroke.id, { points });
      void actions.add(stroke.kind, { color: stroke.color, strokeWidth: stroke.strokeWidth, points, fa }, stroke.id);
    } else if (stroke.sent) actions?.draft.cancel(stroke.id);
    live.set({ mark: null });
  }

  // The pointer lifted: the layer's own pointerup, or one relayed to the layer that took the stroke over.
  function upStroke(input: PointerInput) {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== input.pointerId || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    endStroke(stroke, { end: normFromClient(input.clientX, input.clientY, rect), rect, shiftKey: input.shiftKey, clientX: input.clientX, clientY: input.clientY });
  }

  function up(event: ReactPointerEvent<SVGSVGElement>) {
    const relay = relayRef.current;
    if (relay && relay.pointerId === event.pointerId) {
      relayRef.current = null;
      relay.sink.up(inputOf(event));
      return;
    }
    if (!frame.zoomable) {
      const { state, effect } = gestureStep(gestureRef.current, gestureInput("up", event, now()));
      gestureRef.current = state;
      if (effect !== "finish") return;
    }
    upStroke(inputOf(event));
  }

  // pointercancel, or capture lost without a pointerup (another gesture took over, the element went away): never commit.
  function abandon(event: ReactPointerEvent<SVGSVGElement>) {
    const relay = relayRef.current;
    if (relay && relay.pointerId === event.pointerId) {
      relayRef.current = null;
      relay.sink.cancel();
      return;
    }
    if (!frame.zoomable) {
      const { state, effect } = gestureStep(gestureRef.current, gestureInput("cancel", event, now()));
      gestureRef.current = state;
      if (effect === "cancel") dropStroke();
      return;
    }
    if (strokeRef.current?.pointerId === event.pointerId) dropStroke();
  }

  // Text tool: a click on own (or, for moderators, any) text edits it, elsewhere starts a new one.
  function click(event: ReactMouseEvent<SVGSVGElement>) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const pointerType = pointerTypeOf(event);
    if (!drawing || tool !== "text" || editing || !actions) return;
    // A palm next to the stylus never opens an editor.
    if (pointerType === "touch" && (frame.penOnly || now() - gestureRef.current.lastPenAt < PALM_GUARD_MS)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = normFromClient(event.clientX, event.clientY, rect);
    const target = pickText(point, rect, pointerType);
    if (target) openEdit(target);
    else openText(point);
  }

  // Move tool: a double click on a text edits it (touch uses the double tap in finishStroke).
  function doubleClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (!drawing || tool !== "move" || editing || !actions) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const target = pickText(normFromClient(event.clientX, event.clientY, rect), rect, pointerTypeOf(event));
    if (target) openEdit(target);
  }

  function selectTool(next: UiTool) {
    if (strokeRef.current) return;
    if (editing && !commitText()) return;
    setArmed(next);
    setOpenPicker(null);
    live.set({ hoverId: null });
    onToolChange?.(next);
  }

  async function step(direction: "undo" | "redo") {
    if (!actions || !synced || strokeRef.current) return;
    const result = await (direction === "undo" ? actions.undo() : actions.redo());
    if (!result.ok && result.code === "gone") notify("Эту пометку уже удалили", "annotation-gone");
  }

  function onHotkey(action: HotkeyAction): boolean {
    if (action.type === "escape") {
      const next = resolveEscape({ overlayOpen: openPicker !== null || clearOpen, gestureActive: Boolean(strokeRef.current), tool });
      if (next === "cancel-gesture") cancelStroke();
      else if (next === "view") selectTool("view");
      return next !== "pass";
    }
    if (action.type === "undo" || action.type === "redo") {
      void step(action.type);
      return true;
    }
    if (!prefs.hotkeys || strokeRef.current) return false;
    selectTool(action.tool);
    return true;
  }

  useAnnotationHotkeys({ win, enabled: active && ready && hotkeysEnabled, onAction: onHotkey });

  // Rebuilt on every render, so the workspace always drives the current state.
  useImperativeHandle(handle, () => ({
    commitText: () => commitText(),
    cancelStroke() {
      const had = Boolean(strokeRef.current || relayRef.current);
      cancelStroke();
      return had;
    },
    busy: () => Boolean(strokeRef.current || relayRef.current || editing),
    restyle,
    count: () => sync.store.getBoard().items.length,
    pointer: {
      adopt,
      move: (input) => moveStroke(input, false),
      up: upStroke,
      cancel(pointerId) {
        if (strokeRef.current?.pointerId === pointerId) dropStroke();
      },
    },
  }));

  const editingColor = editing?.color ?? null, editingSize = editing ? nearestTextSize(editing.fontSize) : null;
  const reportEditing = useEffectEvent((style: { color: string; size: TextSize } | null) => onEditing?.(style));
  useEffect(() => {
    if (editingColor === null || editingSize === null) return;
    reportEditing({ color: editingColor, size: editingSize });
    return () => reportEditing(null);
  }, [editingColor, editingSize]);

  const onHidden = useEffectEvent(cancelStroke);
  const onArbiterGesture = useEffectEvent(cancelStroke);
  // A second finger outside the svg (letterbox, toolbar, participants strip) is still a pinch: drop the finger's stroke.
  // The zoom arbiter only sees its own viewport, so this guard stays on with zoom as well.
  const onOtherTouch = useEffectEvent((event: PointerEvent) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointer !== "touch" || event.pointerType !== "touch" || event.pointerId === stroke.pointerId) return;
    if (svgEl?.contains(event.target as Node | null)) return; // down() sees touches on the svg itself
    cancelStroke();
  });
  const onRevoked = useEffectEvent(() => {
    cancelStroke();
    actions?.draft.cancelAll();
    live.set({ hoverId: null, lasers: NO_LASERS });
  });
  // Shift pressed or released mid-drag re-constrains the line or shape at once, matching what pointerup will save.
  const onShiftKey = useEffectEvent((event: KeyboardEvent) => {
    const stroke = strokeRef.current;
    if (event.key !== "Shift" || event.repeat || stroke?.type !== "draw" || isFreehand(stroke.kind) || stroke.points.length < 2) return;
    stroke.points = [stroke.origin, constrainEnd(stroke.kind, stroke.origin, stroke.end, stroke.aspect, event.shiftKey)];
    if (stroke.tentative) return;
    actions?.draft.update(stroke.id, { points: stroke.points });
    live.set({ mark: liveMarkOf(stroke) }, win);
  });

  // The layer's own document: a PiP stroke survives the opener tab being hidden.
  useEffect(() => {
    const doc = svgEl?.ownerDocument;
    if (!doc) return;
    const onVisibility = () => { if (doc.visibilityState === "hidden") onHidden(); };
    const onPointerDown = (event: PointerEvent) => onOtherTouch(event);
    const onKey = (event: KeyboardEvent) => onShiftKey(event);
    doc.addEventListener("visibilitychange", onVisibility);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("keyup", onKey, true);
    return () => {
      doc.removeEventListener("visibilitychange", onVisibility);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("keyup", onKey, true);
    };
  }, [svgEl]);

  useEffect(() => () => onHidden(), []);

  // The zoom arbiter took the pointer for a pinch or pan.
  useEffect(() => onGestureStart(() => onArbiterGesture()), [onGestureStart]);

  useEffect(() => { if (!permitted) onRevoked(); }, [permitted]);

  const cursor = !drawing ? "default" : tool === "laser" ? LASER_CURSOR : tool === "text" ? "text" : tool === "move" ? "grab" : tool === "pen" ? "url('/cursors/pen.svg') 4 28, crosshair" : tool === "marker" ? "url('/cursors/marker.svg') 4 28, crosshair" : tool === "eraser" ? "url('/cursors/eraser.svg') 7 25, crosshair" : "crosshair";
  const editorMounted = active && ready && (editing !== null || tool === "text" || tool === "move");
  // The svg is select-none: a mouse stroke across text marks would select them, and a press on a selection starts a native drag (pointercancel).

  return <>
    <svg ref={setSvgEl} aria-label={label} className={`absolute inset-0 h-full w-full select-none ${drawing ? "touch-none" : ""}`} viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`} preserveAspectRatio="none" style={{ pointerEvents: drawing ? "auto" : "none", cursor }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={abandon} onLostPointerCapture={abandon} onPointerLeave={() => { if (live.hoverId()) live.set({ hoverId: null }, win); }} onMouseDown={(event) => { if (editing) event.preventDefault(); }} onClick={click} onDoubleClick={doubleClick}>
      {ready && <>
        <HoverHighlight live={live} byId={byId} box={size} scale={scale} tone={tone} />
        <CommittedLayer store={sync.store} items={items} live={live} box={size} editingId={editingId} />
        {showAuthors && <AuthorChips store={sync.store} items={items} live={live} box={size} scale={scale} editingId={editingId} />}
        {!showAuthors && <HoverChip live={live} byId={byId} box={size} scale={scale} nameOf={sync.store.nameOf} />}
        <DraftLayer store={sync.store} byId={byId} box={size} scale={scale} selfId={selfId} />
        <LiveStroke live={live} box={size} />
        <Lasers store={sync.store} live={live} box={size} win={win} selfId={selfId} scale={scale} />
      </>}
    </svg>
    {editorMounted && <TextEditor editorRef={editorRef} state={editing} box={size} coarse={coarse} scale={scale} onChange={(text) => { if (editing) setEditing({ ...editing, text }); }} onCommit={() => { commitText(); }} onCancel={cancelText} />}
    {permitted && toolbar?.container && createPortal(<AnnotationToolbar tool={tool} prefs={prefs} layout={toolbar.layout} coarse={coarse} canModerate={canModerate} markCount={items.length} canUndo={history.canUndo && synced} canRedo={history.canRedo && synced} penOnly={frame.penOnly} boxHeight={size.height} editingText={Boolean(editing)} textStyle={editing ? { color: editing.color, size: nearestTextSize(editing.fontSize) } : null} openPicker={openPicker} portalContainer={portalContainer} onOpenPicker={setOpenPicker} onTool={selectTool} onPrefs={changePrefs} onUndo={() => void step("undo")} onRedo={() => void step("redo")} onClearRequest={() => setClearOpen(true)} onFingersDraw={(enabled) => {
      updatePrefs({ fingersDraw: enabled });
      if (enabled) frame.setPenOnly(false);
    }} />, toolbar.container)}
    {clearAllowed && <ClearAllDialog open={clearOpen} count={items.length} container={portalContainer} onOpenChange={setClearOpen} onConfirm={() => void actions?.clear()} />}
  </>;
}
