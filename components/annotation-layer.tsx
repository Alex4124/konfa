"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronDown, ChevronUp, Eraser, Highlighter, Pen, RectangleHorizontal, RotateCcw, Trash2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
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

const tools: Array<{ id: Tool; label: string; icon: typeof Pen }> = [
  { id: "pen", label: "Перо", icon: Pen },
  { id: "marker", label: "Маркер", icon: Highlighter },
  { id: "arrow", label: "Стрелка", icon: ArrowUpRight },
  { id: "rect", label: "Прямоугольник", icon: RectangleHorizontal },
  { id: "text", label: "Текст", icon: Type },
  { id: "eraser", label: "Ластик", icon: Eraser },
];
const colors = ["#6de7d4", "#ffcc75", "#ff7794", "#ffffff"];

function point(event: ReactPointerEvent<SVGSVGElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))];
}

function renderAnnotation(id: string, kind: Tool, data: AnnotationPayload, onErase?: (id: string) => void) {
  const pts = data.points || [];
  const color = data.color || "#6de7d4";
  const handler = onErase ? () => onErase(id) : undefined;
  const shared = { onClick: handler, style: { pointerEvents: onErase ? "stroke" as const : "none" as const, cursor: onErase ? "crosshair" : undefined } };
  if (kind === "pen" || kind === "marker") {
    return <polyline key={id} points={pts.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")} fill="none" stroke={color} strokeOpacity={kind === "marker" ? .45 : 1} strokeWidth={kind === "marker" ? 23 : 5} strokeLinecap="round" strokeLinejoin="round" {...shared} />;
  }
  if (kind === "arrow" && pts.length >= 2) {
    const [start, end] = [pts[0], pts[pts.length - 1]];
    const x1 = start[0] * 1000, y1 = start[1] * 1000, x2 = end[0] * 1000, y2 = end[1] * 1000;
    const angle = Math.atan2(y2 - y1, x2 - x1), head = 21;
    return <g key={id} {...shared} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"><path d={`M${x1} ${y1} L${x2} ${y2} M${x2} ${y2} L${x2 - head * Math.cos(angle - .6)} ${y2 - head * Math.sin(angle - .6)} M${x2} ${y2} L${x2 - head * Math.cos(angle + .6)} ${y2 - head * Math.sin(angle + .6)}`} /></g>;
  }
  if (kind === "rect" && pts.length >= 2) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    return <rect key={id} x={Math.min(a[0], b[0]) * 1000} y={Math.min(a[1], b[1]) * 1000} width={Math.abs(a[0] - b[0]) * 1000} height={Math.abs(a[1] - b[1]) * 1000} fill="none" stroke={color} strokeWidth="5" {...shared} />;
  }
  if (kind === "text" && data.point) return <text key={id} x={data.point[0] * 1000} y={data.point[1] * 1000} fill={color} fontSize="36" fontWeight="700" paintOrder="stroke" stroke="#0e192c" strokeWidth="4" onClick={handler} style={{ pointerEvents: onErase ? "auto" : "none", cursor: onErase ? "crosshair" : undefined }}>{data.text}</text>;
  return null;
}

export function AnnotationLayer({ annotations, canDraw = false, onAdd, onAction, onDraft, canClear = false, drafts = [], toolbarContainer }: Props) {
  const [tool, setTool] = useState<Tool>("pen");
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [color, setColor] = useState(colors[0]);
  const [current, setCurrent] = useState<Point[] | null>(null);
  const lastDraft = useRef(0);

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (!canDraw || tool === "eraser") return;
    const p = point(event);
    if (tool === "text") {
      const text = window.prompt("Текст пометки (до 140 символов)")?.trim().slice(0, 140);
      if (text) void onAdd?.("text", { color, point: p, text });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setCurrent([p]);
  }
  function move(event: ReactPointerEvent<SVGSVGElement>) {
    if (!current) return;
    const p = point(event);
    const next = tool === "pen" || tool === "marker" ? [...current, p].slice(0, 200) : [current[0], p];
    setCurrent(next);
    if (Date.now() - lastDraft.current > 75) {
      onDraft?.(tool, { color, points: next });
      lastDraft.current = Date.now();
    }
  }
  function up(event: ReactPointerEvent<SVGSVGElement>) {
    if (!current) return;
    const p = point(event);
    const pts = tool === "pen" || tool === "marker" ? [...current, p].slice(0, 200) : [current[0], p];
    setCurrent(null);
    onDraft?.(tool, null);
    if (pts.length >= 2) void onAdd?.(tool, { color, points: pts });
  }

  return <>
    <svg aria-label="Пометки поверх демонстрации" className="absolute inset-0 h-full w-full touch-none" viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ pointerEvents: canDraw ? "auto" : "none", cursor: tool === "eraser" ? "crosshair" : canDraw ? "crosshair" : "default" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setCurrent(null); onDraft?.(tool, null); }}>
      {annotations.map((item) => {
        try { return renderAnnotation(item.id, item.kind, JSON.parse(item.payload), canDraw && tool === "eraser" ? (id) => void onAction?.("erase", id) : undefined); }
        catch { return null; }
      })}
      {drafts.map((item) => renderAnnotation(item.id, item.kind, item.payload))}
      {current && renderAnnotation("current", tool, { color, points: current })}
    </svg>
    {canDraw && toolbarContainer && createPortal(<div className="annotation-toolbar flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-white/15 bg-[#12243a]/95 p-1.5 shadow-2xl" role="toolbar" aria-label="Инструменты пометок">
      <Button title={toolbarOpen ? "Свернуть инструменты" : "Развернуть инструменты"} aria-label={toolbarOpen ? "Свернуть инструменты" : "Развернуть инструменты"} aria-expanded={toolbarOpen} variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setToolbarOpen((open) => !open)}>{toolbarOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</Button>
      {toolbarOpen && <>
      {tools.map(({ id, label, icon: Icon }) => <Button key={id} title={label} aria-label={label} variant={tool === id ? "default" : "ghost"} size="icon" className={tool === id ? "bg-[#6de7d4] text-[#10243a]" : "text-white hover:bg-white/10 hover:text-white"} onClick={() => setTool(id)}><Icon size={18} /></Button>)}
      <span className="mx-1 h-6 w-px bg-white/20" />
      {colors.map((choice) => <button key={choice} aria-label={`Цвет ${choice}`} className={`h-6 w-6 shrink-0 rounded-full border-2 ${color === choice ? "border-white" : "border-transparent"}`} style={{ background: choice }} onClick={() => setColor(choice)} />)}
      <span className="mx-1 h-6 w-px bg-white/20" />
      <Button title="Отменить свою пометку" aria-label="Отменить свою пометку" variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white" onClick={() => void onAction?.("undo")}><RotateCcw size={18} /></Button>
      {canClear && <Button title="Очистить все пометки" aria-label="Очистить все пометки" variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white" onClick={() => void onAction?.("clear")}><Trash2 size={18} /></Button>}
      </>}
    </div>, toolbarContainer)}
  </>;
}
