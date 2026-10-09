"use client";

import { memo, useEffect, useEffectEvent, useMemo, useState, type ReactNode } from "react";
import { AuthorChip, authorLabel } from "@/components/annotations/author-chip";
import { smoothPath } from "@/components/annotations/render-annotation";
import { strokePx, unitsToPx, type Size } from "@/lib/annotation-geometry";
import { hasLiveLasers, laserFrame, laserLife } from "@/lib/annotation-laser";
import type { DraftItem } from "@/lib/annotation-drafts";
import type { Point } from "@/lib/confa-types";

type Props = {
  items: readonly DraftItem[]; // peers' drafts; only kind "laser" is drawn here
  local?: readonly DraftItem[]; // this member's own trails (the newest may still be held)
  box: Size;
  win: Window | null; // the layer's window: in Document PiP the opener's frames may not run
  selfId?: string;
  scale?: number;
  nameOf?: (identity: string) => string | undefined;
  onIdle?: () => void; // every trail has faded and the frame loop stopped: the owner may drop its faded `local` trails
};

const INK_WIDTH_UNITS = 4;
const NO_ITEMS: readonly DraftItem[] = [];
// The opener's clock, same as the draft store (a PiP window has another time origin).
const clock = () => performance.now();

// The author's held trail stays alive without packets; time only fades its old segments.
function held(item: DraftItem, now: number): DraftItem {
  return item.phase === "live" && item.lastSeen < now ? { ...item, lastSeen: now } : item;
}

function renderTrail(item: DraftItem, now: number, box: Size, scale: number, chip: ReactNode): ReactNode {
  const { width: W, height: H } = box;
  const k = 1 / (scale > 0 ? scale : 1);
  if (item.style === "ink") {
    const life = laserLife(item, now);
    if (life <= 0 || !item.points.length) return null;
    const px = item.points.map(([x, y]): Point => [x * W, y * H]);
    return <g key={item.key} opacity={life}>
      <path d={smoothPath(px)} fill="none" stroke={item.color} strokeWidth={strokePx(item.strokeWidth ?? INK_WIDTH_UNITS, H)} strokeLinecap="round" strokeLinejoin="round" />
      {chip}
    </g>;
  }
  const frame = laserFrame(item, now);
  if (!frame) return null;
  const { head, life, segments } = frame;
  const hx = head.x * W, hy = head.y * H;
  const trail = Math.max(1.5 * k, unitsToPx(5, H));
  return <g key={item.key}>
    {segments.map((segment, index) => <line key={index} x1={segment.x1 * W} y1={segment.y1 * H} x2={segment.x2 * W} y2={segment.y2 * H} stroke={item.color} strokeWidth={trail * (.3 + .7 * segment.a)} strokeOpacity={.8 * segment.a * life} strokeLinecap="round" />)}
    <circle cx={hx} cy={hy} r={Math.max(7 * k, unitsToPx(14, H))} fill={item.color} fillOpacity={.25 * life} />
    <circle cx={hx} cy={hy} r={Math.max(4 * k, unitsToPx(7, H))} fill={item.color} fillOpacity={.9 * life} />
    <circle cx={hx} cy={hy} r={Math.max(1.5 * k, unitsToPx(2.5, H))} fill="#ffffff" fillOpacity={life} />
    {chip && <g opacity={life}>{chip}</g>}
  </g>;
}

// Laser pointer and vanishing ink: never stored, animated only while some trail is alive.
// `now` changes only inside the window's requestAnimationFrame callback, and the loop stops once every trail has faded.
export const LaserLayer = memo(function LaserLayer({ items, local = NO_ITEMS, box, win, selfId, scale = 1, nameOf, onIdle }: Props) {
  const [now, setNow] = useState(0);
  const remote = useMemo(() => items.filter((item) => item.kind === "laser"), [items]);
  const idle = useEffectEvent(() => onIdle?.());

  useEffect(() => {
    if (!win || (!remote.length && !local.length)) return;
    let frame = 0;
    const tick = () => {
      const t = clock();
      setNow(t);
      frame = hasLiveLasers(remote, t) || hasLiveLasers(local.map((item) => held(item, t)), t) ? win.requestAnimationFrame(tick) : 0;
      if (!frame && local.length) idle();
    };
    frame = win.requestAnimationFrame(tick);
    return () => { if (frame) win.cancelAnimationFrame(frame); };
  }, [win, remote, local]);

  if (!now || !(box.width > 0) || !(box.height > 0)) return null;
  const chipFor = (item: DraftItem) => {
    if (item.identity === selfId || !item.points.length) return null;
    const [x, y] = item.points[item.points.length - 1];
    return <AuthorChip anchor={[x * box.width, y * box.height]} name={authorLabel(item.authorName, item.identity, nameOf)} color={item.color} box={box} scale={scale} />;
  };
  return <g pointerEvents="none">
    {remote.map((item) => renderTrail(item, now, box, scale, chipFor(item)))}
    {local.map((item) => renderTrail(held(item, now), now, box, scale, null))}
  </g>;
});
