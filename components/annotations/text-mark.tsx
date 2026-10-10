import { getMeasureEm } from "@/components/annotations/text-measure";
import { fontPx, TEXT_FONT, textUnits, type Size } from "@/lib/annotation-geometry";
import { baselineOffsetsEm, plateFor, TEXT_PAD_X, TEXT_PLATE_RADIUS_EM, TEXT_WEIGHT, textExtentEm, textLines } from "@/lib/annotation-text";
import { FORMULA_STROKE, formulaBaselinesEm, formulaExtentEm, layoutFormula, type FormulaLayout } from "@/lib/chem-formula";
import type { AnnotationPayload } from "@/lib/confa-types";

const scaled = (extent: { width: number; height: number }, px: number) => ({ width: extent.width * px, height: extent.height * px });
const round2 = (value: number) => Math.round(value * 100) / 100;

// The layer redraws every mark when its size changes; a formula's layout depends only on its payload.
const layouts = new WeakMap<AnnotationPayload, FormulaLayout[]>();

function formulaLayouts(data: AnnotationPayload, lines: readonly string[]): FormulaLayout[] {
  let cached = layouts.get(data);
  if (!cached) {
    const measure = getMeasureEm();
    cached = lines.map((line) => layoutFormula(line, measure));
    layouts.set(data, cached);
  }
  return cached;
}

// A text mark: contrast plate plus the author-wrapped lines, rendered verbatim so every viewer breaks lines the same way.
// The plate uses the stored extent (the same box hit-testing uses); legacy rows measure their hard-broken lines at 26 units.
// A formula (chem) lays each stored line out with lib/chem-formula; its plate has no border, so an equation does not sit in a box.
export function TextMark({ data, box }: { data: AnnotationPayload; box: Size }) {
  if (!data.point || !(box.width > 0) || !(box.height > 0)) return null;
  const color = data.color || "#6de7d4";
  const px = fontPx(textUnits(data), box.height);
  const lines = textLines(data);
  const formula = data.chem === 1 ? formulaLayouts(data, lines) : null;
  const x = data.point[0] * box.width, y = data.point[1] * box.height;
  const extent = typeof data.w === "number" && data.w > 0 && typeof data.h === "number" && data.h > 0
    ? { width: data.w * box.width, height: data.h * box.height }
    : scaled(formula ? formulaExtentEm(formula) : textExtentEm(lines, getMeasureEm()), px);
  const { width, height } = extent;
  const plate = plateFor(color);
  const offsets = formula ? formulaBaselinesEm(formula) : baselineOffsetsEm(lines.length);
  const textX = x + TEXT_PAD_X * px;
  if (!formula) return <g pointerEvents="none">
    <rect x={x} y={y} width={width} height={height} rx={TEXT_PLATE_RADIUS_EM * px} fill={plate.fill} fillOpacity={plate.fillOpacity} stroke={plate.stroke} strokeWidth={plate.stroke ? 1 : undefined} />
    <text fill={color} fontFamily={TEXT_FONT} fontSize={px} fontWeight={TEXT_WEIGHT} textRendering="geometricPrecision" style={{ whiteSpace: "pre" }}>{lines.map((line, index) => <tspan key={index} x={textX} y={y + offsets[index] * px}>{line}</tspan>)}</text>
  </g>;
  // Arrows and the gas and precipitate signs are drawn: Arial has no ⇄, and a drawn arrow is as wide as the layout says.
  const strokes = formula.flatMap((layout, index) => layout.strokes.map((stroke) => stroke.map(([sx, sy], at) => `${at ? "L" : "M"}${round2(textX + sx * px)} ${round2(y + (offsets[index] + sy) * px)}`).join(""))).join("");
  return <g pointerEvents="none">
    <rect x={x} y={y} width={width} height={height} rx={TEXT_PLATE_RADIUS_EM * px} fill={plate.fill} fillOpacity={plate.fillOpacity} />
    <text fill={color} fontFamily={TEXT_FONT} fontSize={px} fontWeight={TEXT_WEIGHT} textRendering="geometricPrecision" style={{ whiteSpace: "pre" }}>{formula.map((layout, index) => layout.runs.map((run, at) => <tspan key={`${index}-${at}`} x={textX + run.x * px} y={y + (offsets[index] + run.dy) * px} fontSize={run.scale === 1 ? undefined : px * run.scale}>{run.text}</tspan>))}</text>
    {strokes && <path d={strokes} fill="none" stroke={color} strokeWidth={FORMULA_STROKE * px} strokeLinecap="round" strokeLinejoin="round" />}
  </g>;
}
