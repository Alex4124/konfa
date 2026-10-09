import { getMeasureEm } from "@/components/annotations/text-measure";
import { fontPx, TEXT_FONT, textUnits, type Size } from "@/lib/annotation-geometry";
import { baselineOffsetsEm, plateFor, TEXT_PAD_X, TEXT_PLATE_RADIUS_EM, TEXT_WEIGHT, textExtentEm, textLines } from "@/lib/annotation-text";
import type { AnnotationPayload } from "@/lib/confa-types";

const scaled = (extent: { width: number; height: number }, px: number) => ({ width: extent.width * px, height: extent.height * px });

// A text mark: contrast plate plus the author-wrapped lines, rendered verbatim so every viewer breaks lines the same way.
// The plate uses the stored extent (the same box hit-testing uses); legacy rows measure their hard-broken lines at 26 units.
export function TextMark({ data, box }: { data: AnnotationPayload; box: Size }) {
  if (!data.point || !(box.width > 0) || !(box.height > 0)) return null;
  const color = data.color || "#6de7d4";
  const px = fontPx(textUnits(data), box.height);
  const lines = textLines(data);
  const x = data.point[0] * box.width, y = data.point[1] * box.height;
  const extent = typeof data.w === "number" && data.w > 0 && typeof data.h === "number" && data.h > 0
    ? { width: data.w * box.width, height: data.h * box.height }
    : scaled(textExtentEm(lines, getMeasureEm()), px);
  const { width, height } = extent;
  const plate = plateFor(color);
  const offsets = baselineOffsetsEm(lines.length);
  const textX = x + TEXT_PAD_X * px;
  return <g pointerEvents="none">
    <rect x={x} y={y} width={width} height={height} rx={TEXT_PLATE_RADIUS_EM * px} fill={plate.fill} fillOpacity={plate.fillOpacity} stroke={plate.stroke} strokeWidth={plate.stroke ? 1 : undefined} />
    <text fill={color} fontFamily={TEXT_FONT} fontSize={px} fontWeight={TEXT_WEIGHT} textRendering="geometricPrecision" style={{ whiteSpace: "pre" }}>{lines.map((line, index) => <tspan key={index} x={textX} y={y + offsets[index] * px}>{line}</tspan>)}</text>
  </g>;
}
