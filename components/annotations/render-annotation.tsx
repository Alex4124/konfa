import type { ReactNode } from "react";
import { TextMark } from "@/components/annotations/text-mark";
import { dashArray, isFreehand, primitivesPx, strokePx, strokeUnits, textBoxNorm, type HitItem, type Primitive, type Size } from "@/lib/annotation-geometry";
import { MARKER_OPACITY } from "@/lib/annotation-tools";
import type { Point } from "@/lib/confa-types";

const HIGHLIGHT_PX = 6; // extra screen px around a hovered mark

export type RenderOptions = { highlighted?: boolean; dimmed?: boolean; scale?: number };

export function smoothPath(points: readonly Point[]): string {
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

function primitivePath(primitive: Primitive): string {
  if (primitive.type === "polyline") return primitive.points.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join(" ") + (primitive.closed ? " Z" : "");
  if (primitive.type === "ellipse") {
    const { cx, cy, rx, ry } = primitive;
    return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  }
  const { x, y, w, h } = primitive;
  return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
}

function isDot(points: readonly Point[]): boolean {
  return points.every(([x, y]) => x === points[0][0] && y === points[0][1]);
}

// Path and width (px) of a stroke-like mark; null for text and empty marks.
function strokeGeometry({ kind, data }: HitItem, box: Size): { d: string; width: number } | null {
  if (kind === "text") return null;
  const points = data.points || [];
  if (!points.length || (!isFreehand(kind) && points.length < 2)) return null;
  const primitives = primitivesPx(kind, data, box);
  if (!primitives.length) return null;
  const first = primitives[0];
  const d = isFreehand(kind) && first.type === "polyline" ? smoothPath(first.points) : primitives.map(primitivePath).join(" ");
  return { d, width: strokePx(strokeUnits(kind, data), box.height) };
}

function renderMark(item: HitItem, box: Size, key?: string): ReactNode {
  const { kind, data } = item;
  const color = data.color || "#6de7d4";

  if (kind === "text") return <TextMark key={key} data={data} box={box} />;

  const geometry = strokeGeometry(item, box);
  if (!geometry) return null;
  const marker = kind === "marker";
  const cap = kind === "dashed" ? "butt" : marker ? (isDot(data.points || []) ? "square" : "butt") : "round";
  return <path key={key} d={geometry.d} fill="none" stroke={color} strokeWidth={geometry.width} strokeOpacity={marker ? MARKER_OPACITY : undefined} strokeLinecap={cap} strokeLinejoin="round" strokeDasharray={kind === "dashed" ? dashArray(geometry.width) : undefined} pointerEvents="none" />;
}

// Hover underlay, drawn beneath the marks: a translucent halo of the same outline (text: its box); dark on light paper.
export function renderHighlight(item: HitItem, box: Size, scale = 1, tone: "dark" | "light" = "dark"): ReactNode {
  const halo = HIGHLIGHT_PX / (scale > 0 ? scale : 1);
  const ink = tone === "light" ? "#0e192c" : "#ffffff";
  if (item.kind === "text") {
    const text = textBoxNorm(item.data, box);
    if (!text) return null;
    return <rect key={`${item.id}:hl`} x={text.x * box.width - halo / 2} y={text.y * box.height - halo / 2} width={text.w * box.width + halo} height={text.h * box.height + halo} rx={halo} fill={ink} fillOpacity={.14} stroke={ink} strokeOpacity={.4} strokeWidth={halo / 3} pointerEvents="none" />;
  }
  const geometry = strokeGeometry(item, box);
  if (!geometry) return null;
  return <path key={`${item.id}:hl`} d={geometry.d} fill="none" stroke={ink} strokeOpacity={tone === "light" ? .22 : .35} strokeWidth={geometry.width + halo} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />;
}

// Sizes are in reference units scaled to the box height. Purely visual: hit-testing is geometric (lib/annotation-geometry).
export function renderAnnotation(item: HitItem, box: Size, options?: RenderOptions): ReactNode {
  if (!options?.highlighted && !options?.dimmed) return renderMark(item, box, item.id);
  return <g key={item.id} opacity={options.dimmed ? .35 : undefined}>{options.highlighted && renderHighlight(item, box, options.scale)}{renderMark(item, box)}</g>;
}
