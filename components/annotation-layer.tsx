"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronDown, ChevronUp, Circle, Eraser, Hexagon, Highlighter, Minus, Pen, RectangleHorizontal, RotateCcw, Trash2, Triangle, Type, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { Annotation, AnnotationPayload, Point, Tool } from "@/lib/confa-types";

type Props = {
  annotations: Annotation[];
  canDraw?: boolean;
  onAdd?: (kind: Tool, payload: AnnotationPayload) => Promise<void>;
  onAction?: (action: "undo" | "clear" | "erase", targetId?: string) => Promise<void>;
  onDraft?: (kind: Tool, payload: AnnotationPayload | null) => void;
  canClear?: boolean;
  drafts?: Array<{ id: string; kind: Tool; payload: AnnotationPayload }>;
  toolbarContainer?: HTMLElement | null;
};

type Drawing = { kind: Tool; color: string; strokeWidth: number; points: Point[] };
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

function renderAnnotation(id: string, kind: Tool, data: AnnotationPayload, size: CanvasSize, onErase?: (id: string) => void) {
  const color = data.color || "#6de7d4";
  const strokeWidth = typeof data.strokeWidth === "number" && data.strokeWidth >= 1 && data.strokeWidth <= 24 ? data.strokeWidth : kind === "marker" ? 23 : 5;
  const points = (data.points || []).map(([x, y]): Point => [x * size.width, y * size.height]);
  const onClick = onErase ? () => onErase(id) : undefined;
  const style = { pointerEvents: onErase ? "stroke" as const : "none" as const, cursor: onErase ? "crosshair" : undefined };
  const strokeProps = { fill: "none", stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, onClick, style };

  if (kind === "text" && data.point) {
    return <text key={id} x={data.point[0] * size.height} y={data.point[1] * size.height} transform={`scale(${size.width / size.height} 1)`} fill={color} fontSize={36 * size.height / 1000} fontWeight="700" paintOrder="stroke" stroke="#0e192c" strokeWidth={4 * size.height / 1000} onClick={onClick} style={{ pointerEvents: onErase ? "auto" : "none", cursor: onErase ? "crosshair" : undefined }}>{data.text}</text>;
  }
  if (!points.length) return null;
  if (kind === "pen" || kind === "marker") {
    return <path key={id} d={smoothPath(points)} strokeOpacity={kind === "marker" ? .45 : 1} {...strokeProps} />;
  }
  if (points.length < 2) return null;

  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  if (kind === "line" || kind === "dashed") {
    return <line key={id} x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={kind === "dashed" ? `${strokeWidth * 3} ${strokeWidth * 2}` : undefined} {...strokeProps} />;
  }
  if (kind === "arrow") {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(12, strokeWidth * 4);
    const path = `M${x1} ${y1} L${x2} ${y2} M${x2} ${y2} L${x2 - head * Math.cos(angle - .6)} ${y2 - head * Math.sin(angle - .6)} M${x2} ${y2} L${x2 - head * Math.cos(angle + .6)} ${y2 - head * Math.sin(angle + .6)}`;
    return <path key={id} d={path} {...strokeProps} />;
  }

  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  if (kind === "rect") return <rect key={id} x={left} y={top} width={width} height={height} {...strokeProps} />;
  if (kind === "circle") {
    const diameter = Math.min(width, height);
    const circleLeft = x2 >= x1 ? x1 : x1 - diameter;
    const circleTop = y2 >= y1 ? y1 : y1 - diameter;
    return <circle key={id} cx={circleLeft + diameter / 2} cy={circleTop + diameter / 2} r={diameter / 2} {...strokeProps} />;
  }
  if (kind === "triangle") {
    return <polygon key={id} points={`${left + width / 2},${top} ${left + width},${top + height} ${left},${top + height}`} {...strokeProps} />;
  }
  if (kind === "hexagon") {
    return <polygon key={id} points={`${left + width * .25},${top} ${left + width * .75},${top} ${left + width},${top + height / 2} ${left + width * .75},${top + height} ${left + width * .25},${top + height} ${left},${top + height / 2}`} {...strokeProps} />;
  }
  return null;
}

export function AnnotationLayer({ annotations, canDraw = false, onAdd, onAction, onDraft, canClear = false, drafts = [], toolbarContainer }: Props) {
  const [tool, setTool] = useState<Tool>("pen");
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [openPicker, setOpenPicker] = useState<"pencil" | "shape" | "color" | null>(null);
  const [color, setColor] = useState(colors[0].value);
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [current, setCurrent] = useState<Drawing | null>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const lastDraft = useRef(0);

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

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (!canDraw || tool === "eraser" || current) return;
    const start = point(event);
    if (tool === "text") {
      const text = window.prompt("Текст пометки (до 140 символов)")?.trim().slice(0, 140);
      if (text) void onAdd?.("text", { color, point: start, text });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setCurrent({ kind: tool, color, strokeWidth, points: [start] });
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
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
    if (!current) return;
    const end = point(event);
    const points = isFreehand(current.kind) ? appendPoint(current.points, end) : [current.points[0], end];
    setCurrent(null);
    onDraft?.(current.kind, null);
    if (isShape(current.kind) && (points[0][0] === end[0] || points[0][1] === end[1])) return;
    if (points.length >= 2) void onAdd?.(current.kind, { color: current.color, strokeWidth: current.strokeWidth, points });
  }

  const selectedPencil = pencilOptions.find((option) => option.id === tool) || pencilOptions[0];
  const selectedShape = shapeOptions.find((option) => option.id === tool) || shapeOptions[0];
  const PencilIcon = selectedPencil.icon;
  const ShapeIcon = selectedShape.icon;
  const activeColor = colors.find((choice) => choice.value === color)?.label || color;
  const activeClass = "bg-[#6de7d4] text-[#10243a]";
  const inactiveClass = "text-white hover:bg-white/10 hover:text-white";

  return <>
    <svg ref={svgRef} aria-label="Пометки поверх демонстрации" className="absolute inset-0 h-full w-full touch-none" viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`} preserveAspectRatio="none" style={{ pointerEvents: canDraw ? "auto" : "none", cursor: canDraw ? "crosshair" : "default" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { if (current) onDraft?.(current.kind, null); setCurrent(null); }}>
      {size.width > 0 && size.height > 0 && <>
        {annotations.map((item) => {
          try { return renderAnnotation(item.id, item.kind, JSON.parse(item.payload), size, canDraw && tool === "eraser" ? (id) => void onAction?.("erase", id) : undefined); }
          catch { return null; }
        })}
        {drafts.map((item) => renderAnnotation(item.id, item.kind, item.payload, size))}
        {current && renderAnnotation("current", current.kind, { color: current.color, strokeWidth: current.strokeWidth, points: current.points }, size)}
      </>}
    </svg>
    {canDraw && toolbarContainer && createPortal(<div className="annotation-toolbar flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-white/15 bg-[#12243a]/95 p-1.5 shadow-2xl" role="toolbar" aria-label="Инструменты пометок">
      <Button title={toolbarOpen ? "Свернуть инструменты" : "Развернуть инструменты"} aria-label={toolbarOpen ? "Свернуть инструменты" : "Развернуть инструменты"} aria-expanded={toolbarOpen} variant="ghost" size="icon" className={inactiveClass} onClick={() => { setToolbarOpen((open) => !open); setOpenPicker(null); }}>{toolbarOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</Button>
      {toolbarOpen && <>
        <Popover open={openPicker === "pencil"} onOpenChange={(open) => setOpenPicker(open ? "pencil" : null)}>
          <PopoverTrigger asChild><Button title={selectedPencil.label} aria-label={`Карандаш: ${selectedPencil.label}`} aria-expanded={openPicker === "pencil"} variant={pencilOptions.some((option) => option.id === tool) ? "default" : "ghost"} size="icon" className={pencilOptions.some((option) => option.id === tool) ? activeClass : inactiveClass}><PencilIcon size={18} strokeDasharray={selectedPencil.dashed ? "3 3" : undefined} /></Button></PopoverTrigger>
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
