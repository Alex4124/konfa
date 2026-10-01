"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronDown, ChevronUp, Circle, Eraser, Grab, Hexagon, Highlighter, Minus, Pen, RectangleHorizontal, RotateCcw, Trash2, Triangle, Type, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { translateAnnotation } from "@/lib/annotation-geometry";
import type { Annotation, AnnotationPayload, Point, Tool } from "@/lib/confa-types";

type Props = {
  annotations: Annotation[];
  canDraw?: boolean;
  onAdd?: (kind: Tool, payload: AnnotationPayload) => Promise<boolean>;
  onMove?: (id: string, dx: number, dy: number) => Promise<boolean>;
  onAction?: (action: "undo" | "clear" | "erase", targetId?: string) => Promise<boolean>;
  onDraft?: (kind: Tool, payload: AnnotationPayload | null) => void;
  canClear?: boolean;
  memberId?: string;
  drafts?: Array<{ id: string; kind: Tool; payload: AnnotationPayload }>;
  toolbarContainer?: HTMLElement | null;
};

type Drawing = { kind: Tool; color: string; strokeWidth: number; points: Point[] };
type TextEditor = { point: Point; color: string; text: string };
type Dragging = { id: string; data: AnnotationPayload; start: Point; delta: Point; pointerId: number; saving: boolean };
type ToolOption = { id: Tool; label: string; icon: LucideIcon; dashed?: boolean };
type CanvasSize = { width: number; height: number };

const pencilOptions: ToolOption[] = [
  { id: "pen", label: "Классический карандаш", icon: Pen },
  { id: "line", label: "Прямая линия", icon: Minus },
  { id: "arrow", label: "Стрелка", icon: ArrowUpRight },
  { id: "dashed", label: "Пунктирная линия", icon: Minus, dashed: true },
];
const shapeOptions: ToolOption[] = [
  { id: "rect", label: "Прямоугольник", icon: RectangleHorizontal },
  { id: "circle", label: "Окружность", icon: Circle },
  { id: "triangle", label: "Треугольник", icon: Triangle },
  { id: "hexagon", label: "Гексагон", icon: Hexagon },
];
const colors = [
  { value: "#6de7d4", label: "Мятный" },
  { value: "#ffcc75", label: "Жёлтый" },
  { value: "#ff7794", label: "Розовый" },
  { value: "#ffffff", label: "Белый" },
  { value: "#000000", label: "Чёрный" },
  { value: "#b9a7ff", label: "Лавандовый" },
];

function point(event: ReactPointerEvent<SVGSVGElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
  return [Number(x.toFixed(5)), Number(y.toFixed(5))];
}

function isFreehand(kind: Tool): boolean {
  return kind === "pen" || kind === "marker";
}

function isShape(kind: Tool): boolean {
  return kind === "rect" || kind === "circle" || kind === "triangle" || kind === "hexagon";
}

function appendPoint(points: Point[], nextPoint: Point): Point[] {
  const next = [...points, nextPoint];
  if (next.length <= 200) return next;
  return next.filter((_, index) => index === 0 || index === next.length - 1 || index % 2 === 0);
}

function smoothPath(points: Point[]): string {
  if (!points.length) return "";
  let path = `M${points[0][0]} ${points[0][1]}`;
  if (points.length === 1) return `${path} L${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length - 1; index++) {
    const [x, y] = points[index];
    const [nextX, nextY] = points[index + 1];
    path += ` Q${x} ${y} ${(x + nextX) / 2} ${(y + nextY) / 2}`;
  }
  const [lastX, lastY] = points[points.length - 1];
  return `${path} L${lastX} ${lastY}`;
}

function renderAnnotation(id: string, kind: Tool, data: AnnotationPayload, size: CanvasSize, erasable = false, onMoveStart?: (id: string, event: ReactPointerEvent<SVGElement>) => void) {
  const color = data.color || "#6de7d4";
  const strokeWidth = typeof data.strokeWidth === "number" && data.strokeWidth >= 1 && data.strokeWidth <= 24 ? data.strokeWidth : kind === "marker" ? 23 : 5;
  const points = (data.points || []).map(([x, y]): Point => [x * size.width, y * size.height]);
  const onPointerDown = onMoveStart ? (event: ReactPointerEvent<SVGElement>) => onMoveStart(id, event) : undefined;
  const style = { pointerEvents: onMoveStart ? "all" as const : "none" as const, cursor: onMoveStart ? "grab" : undefined };
  const strokeProps = { fill: onMoveStart ? "transparent" : "none", stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, onPointerDown, style };
  const hitProps = { fill: "none", stroke: "transparent", strokeWidth: Math.max(24, strokeWidth + 16), strokeLinecap: "round" as const, strokeLinejoin: "round" as const, pointerEvents: "stroke" as const };
  const renderPath = (d: string, opacity = 1) => <g key={id}>
    <path d={d} strokeOpacity={opacity} {...strokeProps} style={{ pointerEvents: onMoveStart ? "none" : style.pointerEvents, cursor: style.cursor }} />
    {onMoveStart && <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(18, strokeWidth + 12)} strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" onPointerDown={onPointerDown} style={{ cursor: "grab" }} />}
    {erasable && <path d={d} {...hitProps} data-annotation-id={id} />}
  </g>;

  if (kind === "text" && data.point) {
    return <text key={id} x={data.point[0] * size.width} y={data.point[1] * size.height} dominantBaseline="hanging" fill={color} fontSize={Math.max(16, 36 * size.height / 1000)} fontWeight="700" paintOrder="stroke" stroke="#0e192c" strokeWidth={Math.max(2, 4 * size.height / 1000)} pointerEvents={onMoveStart || erasable ? "bounding-box" : "none"} data-annotation-id={erasable ? id : undefined} onPointerDown={onPointerDown} style={{ cursor: onMoveStart ? "grab" : undefined }}>{data.text}</text>;
  }
  if (!points.length) return null;
  if (kind === "pen" || kind === "marker") {
    return renderPath(smoothPath(points), kind === "marker" ? .45 : 1);
  }
  if (points.length < 2) return null;

  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  if (kind === "line" || kind === "dashed") {
    return <g key={id}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={kind === "dashed" ? `${strokeWidth * 3} ${strokeWidth * 2}` : undefined} {...strokeProps} style={{ pointerEvents: onMoveStart ? "none" : style.pointerEvents, cursor: style.cursor }} />
      {onMoveStart && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(18, strokeWidth + 12)} strokeLinecap="round" pointerEvents="stroke" onPointerDown={onPointerDown} style={{ cursor: "grab" }} />}
      {erasable && <line x1={x1} y1={y1} x2={x2} y2={y2} {...hitProps} data-annotation-id={id} />}
    </g>;
  }
  if (kind === "arrow") {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(12, strokeWidth * 4);
    const path = `M${x1} ${y1} L${x2} ${y2} M${x2} ${y2} L${x2 - head * Math.cos(angle - .6)} ${y2 - head * Math.sin(angle - .6)} M${x2} ${y2} L${x2 - head * Math.cos(angle + .6)} ${y2 - head * Math.sin(angle + .6)}`;
    return renderPath(path);
  }

  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  if (kind === "rect") return <g key={id}><rect x={left} y={top} width={width} height={height} {...strokeProps} />{erasable && <rect x={left} y={top} width={width} height={height} {...hitProps} data-annotation-id={id} />}</g>;
  if (kind === "circle") {
    const diameter = Math.min(width, height);
    const circleLeft = x2 >= x1 ? x1 : x1 - diameter;
    const circleTop = y2 >= y1 ? y1 : y1 - diameter;
    return <g key={id}><circle cx={circleLeft + diameter / 2} cy={circleTop + diameter / 2} r={diameter / 2} {...strokeProps} />{erasable && <circle cx={circleLeft + diameter / 2} cy={circleTop + diameter / 2} r={diameter / 2} {...hitProps} data-annotation-id={id} />}</g>;
  }
  if (kind === "triangle") {
    const vertices = `${left + width / 2},${top} ${left + width},${top + height} ${left},${top + height}`;
    return <g key={id}><polygon points={vertices} {...strokeProps} />{erasable && <polygon points={vertices} {...hitProps} data-annotation-id={id} />}</g>;
  }
  if (kind === "hexagon") {
    const vertices = `${left + width * .25},${top} ${left + width * .75},${top} ${left + width},${top + height / 2} ${left + width * .75},${top + height} ${left + width * .25},${top + height} ${left},${top + height / 2}`;
    return <g key={id}><polygon points={vertices} {...strokeProps} />{erasable && <polygon points={vertices} {...hitProps} data-annotation-id={id} />}</g>;
  }
  return null;
}

export function AnnotationLayer({ annotations, canDraw = false, onAdd, onMove, onAction, onDraft, canClear = false, memberId, drafts = [], toolbarContainer }: Props) {
  const [tool, setTool] = useState<Tool>("pen");
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [openPicker, setOpenPicker] = useState<"pencil" | "shape" | "color" | null>(null);
  const [color, setColor] = useState(colors[0].value);
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [current, setCurrent] = useState<Drawing | null>(null);
  const [editing, setEditing] = useState<TextEditor | null>(null);
  const [savingText, setSavingText] = useState(false);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [pendingErases, setPendingErases] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const savingTextRef = useRef(false);
  const lastDraft = useRef(0);
  const erasingPointer = useRef<number | null>(null);
  const erasingIds = useRef(new Set<string>());
  const editorPoint = editing?.point;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      setSize((previous) => previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editorPoint) return;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editorPoint]);

  async function commitText() {
    if (!editing || savingTextRef.current) return;
    const text = editing.text.trim();
    if (!text) { setEditing(null); return; }
    savingTextRef.current = true;
    setSavingText(true);
    try {
      const saved = await onAdd?.("text", { color: editing.color, point: editing.point, text });
      if (saved) setEditing(null);
      else requestAnimationFrame(() => editorRef.current?.focus());
    } catch {
      requestAnimationFrame(() => editorRef.current?.focus());
    } finally {
      savingTextRef.current = false;
      setSavingText(false);
    }
  }

  function startMove(id: string, event: ReactPointerEvent<SVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (dragging || editing || !canDraw) return;
    const item = annotations.find((entry) => entry.id === id);
    const svg = event.currentTarget.ownerSVGElement;
    if (!item || !svg || (item.author_id !== memberId && !canClear)) return;
    try {
      const data = JSON.parse(item.payload) as AnnotationPayload;
      const rect = svg.getBoundingClientRect();
      const start: Point = [
        Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
        Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
      ];
      svg.setPointerCapture(event.pointerId);
      setDragging({ id, data, start, delta: [0, 0], pointerId: event.pointerId, saving: false });
    } catch { /* Ignore malformed annotations. */ }
  }

  function eraseAt(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg || !canDraw || tool !== "eraser") return;
    const elements = document.elementsFromPoint(clientX, clientY);
    if (!elements[0] || !svg.contains(elements[0])) return;
    const hit = elements.find((element) => svg.contains(element) && element instanceof SVGElement && element.dataset.annotationId);
    const id = hit instanceof SVGElement ? hit.dataset.annotationId : undefined;
    if (!id || erasingIds.current.has(id)) return;
    erasingIds.current.add(id);
    setPendingErases((previous) => new Set(previous).add(id));
    const request = onAction?.("erase", id);
    if (!request) {
      erasingIds.current.delete(id);
      setPendingErases((previous) => { const next = new Set(previous); next.delete(id); return next; });
      return;
    }
    void request.then((success) => {
      if (success) return;
      erasingIds.current.delete(id);
      setPendingErases((previous) => { const next = new Set(previous); next.delete(id); return next; });
    }).catch(() => {
      erasingIds.current.delete(id);
      setPendingErases((previous) => { const next = new Set(previous); next.delete(id); return next; });
    });
  }

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (editing) { void commitText(); return; }
    if (!canDraw || tool === "move" || current || dragging || event.button !== 0) return;
    if (tool === "eraser") {
      erasingPointer.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      eraseAt(event.clientX, event.clientY);
      return;
    }
    const start = point(event);
    if (tool === "text") {
      event.preventDefault();
      const textHeight = Math.max(16, 36 * size.height / 1000);
      const editorWidth = Math.min(280, size.width);
      const editorHeight = Math.max(28, textHeight + 10);
      setEditing({ color, point: [
        Math.min(start[0], Math.max(0, 1 - editorWidth / Math.max(1, size.width))),
        Math.min(start[1], Math.max(0, 1 - editorHeight / Math.max(1, size.height))),
      ], text: "" });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setCurrent({ kind: tool, color, strokeWidth, points: [start] });
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    if (tool === "eraser") {
      if (erasingPointer.current === event.pointerId) eraseAt(event.clientX, event.clientY);
      return;
    }
    if (dragging && dragging.pointerId === event.pointerId && !dragging.saving) {
      const position = point(event);
      const translated = translateAnnotation(dragging.data, position[0] - dragging.start[0], position[1] - dragging.start[1]);
      setDragging({ ...dragging, delta: [translated.dx, translated.dy] });
      return;
    }
    if (!current) return;
    const nextPoint = point(event);
    const points = isFreehand(current.kind) ? appendPoint(current.points, nextPoint) : [current.points[0], nextPoint];
    setCurrent({ ...current, points });
    if (Date.now() - lastDraft.current > 75) {
      onDraft?.(current.kind, { color: current.color, strokeWidth: current.strokeWidth, points });
      lastDraft.current = Date.now();
    }
  }

  function up(event: ReactPointerEvent<SVGSVGElement>) {
    if (erasingPointer.current === event.pointerId) { erasingPointer.current = null; return; }
    if (dragging && dragging.pointerId === event.pointerId && !dragging.saving) {
      const position = point(event);
      const translated = translateAnnotation(dragging.data, position[0] - dragging.start[0], position[1] - dragging.start[1]);
      if (translated.dx === 0 && translated.dy === 0) { setDragging(null); return; }
      setDragging({ ...dragging, delta: [translated.dx, translated.dy], saving: true });
      void Promise.resolve(onMove?.(dragging.id, translated.dx, translated.dy)).catch(() => {}).finally(() => setDragging(null));
      return;
    }
    if (!current) return;
    const end = point(event);
    const points = isFreehand(current.kind) ? appendPoint(current.points, end) : [current.points[0], end];
    setCurrent(null);
    onDraft?.(current.kind, null);
    if (isShape(current.kind) && (points[0][0] === end[0] || points[0][1] === end[1])) return;
    if (points.length >= 2) void onAdd?.(current.kind, { color: current.color, strokeWidth: current.strokeWidth, points });
  }

  const selectedShape = shapeOptions.find((option) => option.id === tool) || shapeOptions[0];
  const ShapeIcon = selectedShape.icon;
  const activeColor = colors.find((choice) => choice.value === color)?.label || color;
  const activeClass = "bg-[#6de7d4] text-[#10243a]";
  const inactiveClass = "text-white hover:bg-white/10 hover:text-white";
  const pencilActive = pencilOptions.some((option) => option.id === tool);
  const canvasCursor = !canDraw || tool === "move" ? "default" : tool === "pen" ? "url('/cursors/pen.svg') 4 28, crosshair" : tool === "marker" ? "url('/cursors/marker.svg') 4 28, crosshair" : tool === "eraser" ? "url('/cursors/eraser.svg') 7 25, crosshair" : "crosshair";

  return <>
    <svg ref={svgRef} aria-label="Пометки поверх демонстрации" className="absolute inset-0 h-full w-full touch-none" viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`} preserveAspectRatio="none" style={{ pointerEvents: canDraw ? "auto" : "none", cursor: canvasCursor }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { if (current) onDraft?.(current.kind, null); erasingPointer.current = null; setCurrent(null); setDragging(null); }}>
      {size.width > 0 && size.height > 0 && <>
        {annotations.map((item) => {
          if (pendingErases.has(item.id)) return null;
          try {
            const data = dragging?.id === item.id ? translateAnnotation(dragging.data, dragging.delta[0], dragging.delta[1]).payload : JSON.parse(item.payload) as AnnotationPayload;
            const movable = canDraw && tool === "move" && (canClear || item.author_id === memberId);
            const erasable = canDraw && tool === "eraser" && (canClear || item.author_id === memberId);
            return renderAnnotation(item.id, item.kind, data, size, erasable, movable ? startMove : undefined);
          }
          catch { return null; }
        })}
        {drafts.map((item) => renderAnnotation(item.id, item.kind, item.payload, size))}
        {current && renderAnnotation("current", current.kind, { color: current.color, strokeWidth: current.strokeWidth, points: current.points }, size)}
      </>}
    </svg>
    {canDraw && editing && <input ref={editorRef} aria-label="Текст пометки" maxLength={140} value={editing.text} disabled={savingText} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onBlur={() => void commitText()} onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); void commitText(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
    }} className="absolute z-10 rounded border border-[#6de7d4] bg-[#0e192c]/90 px-1 font-bold shadow-lg outline-none focus:ring-2 focus:ring-[#6de7d4]" style={{ left: editing.point[0] * size.width, top: editing.point[1] * size.height, width: Math.min(280, size.width), height: Math.max(28, 36 * size.height / 1000 + 10), fontSize: Math.max(16, 36 * size.height / 1000), color: editing.color }} />}
    {canDraw && toolbarContainer && createPortal(<div className="annotation-toolbar flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-white/15 bg-[#12243a]/95 p-1.5 shadow-2xl" role="toolbar" aria-label="Инструменты пометок">
      <Button title={toolbarOpen ? "Свернуть инструменты" : "Развернуть инструменты"} aria-label={toolbarOpen ? "Свернуть инструменты" : "Развернуть инструменты"} aria-expanded={toolbarOpen} variant="ghost" size="icon" className={inactiveClass} onClick={() => { setToolbarOpen((open) => !open); setOpenPicker(null); }}>{toolbarOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</Button>
      {toolbarOpen && <>
        <Popover open={openPicker === "pencil"} onOpenChange={(open) => setOpenPicker(open ? "pencil" : null)}>
          <div className="flex items-center">
            <Button title="Карандаш" aria-label="Карандаш" aria-pressed={tool === "pen"} variant={tool === "pen" ? "default" : "ghost"} size="icon" className={tool === "pen" ? activeClass : inactiveClass} onClick={() => { setTool("pen"); setOpenPicker(null); }}><Pen size={18} /></Button>
            <PopoverTrigger asChild><Button title="Варианты карандаша" aria-label="Варианты карандаша" aria-expanded={openPicker === "pencil"} variant={pencilActive && tool !== "pen" ? "default" : "ghost"} size="icon-xs" className={pencilActive && tool !== "pen" ? activeClass : inactiveClass}><ChevronDown size={14} /></Button></PopoverTrigger>
          </div>
          <PopoverContent side="top" align="start" className="w-56 border-white/15 bg-[#1c2c45] p-1.5 text-white" aria-label="Вид карандаша">
            {pencilOptions.map(({ id, label, icon: Icon, dashed }) => <button key={id} type="button" aria-pressed={tool === id} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10 ${tool === id ? "bg-white/10" : ""}`} onClick={() => { setTool(id); setOpenPicker(null); }}><Icon size={18} strokeDasharray={dashed ? "3 3" : undefined} />{label}</button>)}
          </PopoverContent>
        </Popover>
        <Button title="Маркер" aria-label="Маркер" variant={tool === "marker" ? "default" : "ghost"} size="icon" className={tool === "marker" ? activeClass : inactiveClass} onClick={() => { setTool("marker"); setOpenPicker(null); }}><Highlighter size={18} /></Button>
        <Popover open={openPicker === "shape"} onOpenChange={(open) => setOpenPicker(open ? "shape" : null)}>
          <PopoverTrigger asChild><Button title={selectedShape.label} aria-label={`Фигура: ${selectedShape.label}`} aria-expanded={openPicker === "shape"} variant={shapeOptions.some((option) => option.id === tool) ? "default" : "ghost"} size="icon" className={shapeOptions.some((option) => option.id === tool) ? activeClass : inactiveClass}><ShapeIcon size={18} /></Button></PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-52 border-white/15 bg-[#1c2c45] p-1.5 text-white" aria-label="Фигура">
            {shapeOptions.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={tool === id} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10 ${tool === id ? "bg-white/10" : ""}`} onClick={() => { setTool(id); setOpenPicker(null); }}><Icon size={18} />{label}</button>)}
          </PopoverContent>
        </Popover>
        <Button title="Текст" aria-label="Текст" variant={tool === "text" ? "default" : "ghost"} size="icon" className={tool === "text" ? activeClass : inactiveClass} onClick={() => { setTool("text"); setOpenPicker(null); }}><Type size={18} /></Button>
        <Button title="Перемещение" aria-label="Перемещение" aria-pressed={tool === "move"} variant={tool === "move" ? "default" : "ghost"} size="icon" className={tool === "move" ? activeClass : inactiveClass} onClick={() => { setTool("move"); setOpenPicker(null); }}><Grab size={18} /></Button>
        <Button title="Ластик" aria-label="Ластик" variant={tool === "eraser" ? "default" : "ghost"} size="icon" className={tool === "eraser" ? activeClass : inactiveClass} onClick={() => { setTool("eraser"); setOpenPicker(null); }}><Eraser size={18} /></Button>
        <span className="mx-1 h-6 w-px shrink-0 bg-white/20" />
        <Popover open={openPicker === "color"} onOpenChange={(open) => setOpenPicker(open ? "color" : null)}>
          <PopoverTrigger asChild><button type="button" title={`Цвет пометок: ${activeColor}`} aria-label={`Цвет пометок: ${activeColor}`} aria-expanded={openPicker === "color"} className="mx-1 h-7 w-7 shrink-0 rounded-full border-2 border-white/80 outline-none focus-visible:ring-2 focus-visible:ring-[#6de7d4] focus-visible:ring-offset-2 focus-visible:ring-offset-[#12243a]" style={{ backgroundColor: color }} /></PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-44 border-white/15 bg-[#1c2c45] p-3 text-white" aria-label="Цвет пометок">
            <div className="grid grid-cols-3 gap-3">{colors.map((choice) => <button key={choice.value} type="button" title={choice.label} aria-label={choice.label} aria-pressed={color === choice.value} className={`h-9 w-9 rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-[#6de7d4] ${color === choice.value ? "border-white" : "border-white/30"}`} style={{ backgroundColor: choice.value }} onClick={() => { setColor(choice.value); setOpenPicker(null); }} />)}</div>
          </PopoverContent>
        </Popover>
        <div className="flex shrink-0 items-center gap-2 px-1 text-xs text-white"><span>Толщина</span><Slider aria-label="Толщина линии" className="w-24" min={1} max={24} step={1} value={[strokeWidth]} onValueChange={(value) => setStrokeWidth(value[0] ?? 5)} /><span className="w-7 text-right tabular-nums">{strokeWidth}</span></div>
        <span className="mx-1 h-6 w-px shrink-0 bg-white/20" />
        <Button title="Отменить свою пометку" aria-label="Отменить свою пометку" variant="ghost" size="icon" className={inactiveClass} onClick={() => void onAction?.("undo")}><RotateCcw size={18} /></Button>
        {canClear && <Button title="Очистить все пометки" aria-label="Очистить все пометки" variant="ghost" size="icon" className={inactiveClass} onClick={() => void onAction?.("clear")}><Trash2 size={18} /></Button>}
      </>}
    </div>, toolbarContainer)}
  </>;
}
