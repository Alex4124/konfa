import { memo } from "react";
import { getMeasureEm } from "@/components/annotations/text-measure";
import { TEXT_FONT, type Size } from "@/lib/annotation-geometry";
import { CHIP_GAP, chipFontPx, chipName, placeChip } from "@/lib/annotation-tools";

type Props = {
  anchor: readonly [number, number]; // px inside the frame
  name: string;
  color: string;
  box: Size;
  scale?: number; // frame zoom: the chip is counter-scaled so it keeps its screen size
  prefer?: "below" | "above"; // below: cursor label (drafts, laser); above: saved marks
  opacity?: number;
};

// Name label with the author's colour dot; never takes the pointer.
export const AuthorChip = memo(function AuthorChip({ anchor, name, color, box, scale = 1, prefer = "below", opacity }: Props) {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const k = 1 / (scale > 0 ? scale : 1);
  const font = chipFontPx(box.height);
  const label = chipName(name);
  const pad = font * .6, dot = font * .5;
  const width = pad * 2 + dot + pad * .7 + getMeasureEm(600)(label) * font, height = font * 1.75;
  const [x, y] = placeChip(anchor, box, { width: width * k, height: height * k }, { prefer, gap: CHIP_GAP * k });
  return <g transform={`translate(${x} ${y}) scale(${k})`} opacity={opacity} pointerEvents="none" aria-hidden>
    <rect width={width} height={height} rx={6} fill="#0e192c" fillOpacity={.85} />
    <circle cx={pad + dot / 2} cy={height / 2} r={dot / 2} fill={color} stroke="#ffffff" strokeOpacity={.5} strokeWidth={1} />
    <text x={pad + dot + pad * .7} y={height / 2} dominantBaseline="central" fill="#ffffff" fontFamily={TEXT_FONT} fontSize={font} fontWeight={600} style={{ whiteSpace: "pre" }}>{label}</text>
  </g>;
});

// Shown name: the row's or packet's name, then the room's member list, then «Участник» (chipName).
export function authorLabel(name: string | null | undefined, identity: string, nameOf?: (identity: string) => string | undefined): string {
  return name?.trim() || nameOf?.(identity) || "";
}
