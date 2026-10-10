"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { TileLayout } from "@/components/participant-tile";
import { useCameraSize } from "@/hooks/use-camera-size";
import { CAMERA_SIZES, TILE_GAP, fitTiles, type CameraSize, type StripFit, type TileFit } from "@/lib/tile-grid";
import type { StripPlacement } from "@/lib/view-transform";
import type { Member } from "@/lib/confa-types";

type Size = { width: number; height: number };
// Whoever gets a tile: a member of the room, or a camera of the recording scene.
type Tiled = { id: string };
export type RenderTile<T extends Tiled = Member> = (person: T, layout: TileLayout) => ReactNode;
type TilesProps<T extends Tiled> = { members: T[]; renderTile: RenderTile<T>; fit: TileFit; gap: number };

const SIZE_LABEL: Record<CameraSize, string> = { s: "Мелкие камеры", m: "Средние камеры", l: "Крупные камеры" };
const SIZE_GLYPH: Record<CameraSize, string> = { s: "h-1.5 w-2.5", m: "h-2 w-3.5", l: "h-2.5 w-[18px]" };

// The tiles of one fit. Everyone fits: slots of the fitted size, the last row centred. Otherwise the tiles size themselves
// from the scroller, so its scrollbar takes its room from them.
function Tiles<T extends Tiled>({ members, renderTile, fit, gap }: TilesProps<T>) {
  if (fit.scroll === "x") return <div className="flex h-full w-max flex-col" style={{ gap }}>
    {Array.from({ length: fit.rows }, (_, row) => <div key={row} className="flex min-h-0 flex-1" style={{ gap }}>
      {members.slice(row * fit.columns, (row + 1) * fit.columns).map((person) => renderTile(person, "top"))}
    </div>)}
  </div>;
  if (fit.scroll === "y") return <div className="grid w-full" style={{ gridTemplateColumns: `repeat(${fit.columns}, minmax(0, 1fr))`, gap }}>
    {members.map((person) => renderTile(person, "left"))}
  </div>;
  return <div className="flex shrink-0 flex-wrap justify-center" style={{ width: fit.columns * fit.width + gap * (fit.columns - 1), gap }}>
    {members.map((person) => <div key={person.id} className="aspect-video" style={{ width: fit.width }}>{renderTile(person, "fit")}</div>)}
  </div>;
}

// The camera grid: fills the room it is given. It measures a box that its tiles cannot stretch and lays them out at
// render, so someone joining needs no resize; nothing is drawn before the first measurement (a 0×0 video would ask the
// server for no picture at all).
export function TileGrid<T extends Tiled = Member>({ members, renderTile, gap = TILE_GAP, className = "" }: { members: T[]; renderTile: RenderTile<T>; gap?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width), height = Math.floor(entry.contentRect.height);
      setBox((current) => current && current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = box ? fitTiles(members.length, box, { gap }) : null;
  return <div ref={ref} aria-label="Видео участников" className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${className}`}>
    {fit && fit.columns > 0 && <div className={`absolute inset-0 flex justify-center ${fit.scroll ? "items-start overflow-y-auto" : "items-center"}`}>
      <Tiles members={members} renderTile={renderTile} fit={fit} gap={gap} />
    </div>}
  </div>;
}

// The cameras beside the stage, laid out by the area that holds both (lib/tile-grid fitStrip): on top a band as tall as
// its rows, on the left a column as wide as its tiles. Hidden on short screens, where the stage needs every pixel.
export function TileStrip({ members, renderTile, placement, strip }: { members: Member[]; renderTile: RenderTile; placement: StripPlacement; strip: StripFit }) {
  if (!strip.fit.columns || strip.extent <= 0) return null;
  const top = placement === "top";
  const flow = strip.fit.scroll ? (top ? "overflow-x-auto" : "items-start overflow-y-auto") : `justify-center overflow-hidden ${top ? "items-center" : "items-start"}`;
  return <div aria-label="Видео участников" style={top ? { height: strip.extent } : { width: strip.extent }} className={`flex shrink-0 short:hidden ${top ? "px-2 py-1" : "px-1 py-2"} ${flow}`}>
    <Tiles members={members} renderTile={renderTile} fit={strip.fit} gap={TILE_GAP} />
  </div>;
}

// «Мелкие — средние — крупные камеры»: how much room the strip may take, remembered on this device.
export function CameraSizeControl({ className = "" }: { className?: string }) {
  const [size, setSize] = useCameraSize();
  return <div role="group" aria-label="Размер камер" className={`flex shrink-0 items-center gap-0.5 rounded-lg p-1 short:hidden ${className}`}>
    {CAMERA_SIZES.map((item) => <Button key={item} type="button" variant="ghost" size="icon-xs" title={SIZE_LABEL[item]} aria-label={SIZE_LABEL[item]} aria-pressed={size === item} className={`text-white hover:bg-white/15 hover:text-white ${size === item ? "bg-white/20" : "text-white/70"}`} onClick={() => setSize(item)}>
      <span aria-hidden className={`rounded-[2px] border-[1.5px] border-current ${SIZE_GLYPH[item]}`} />
    </Button>)}
  </div>;
}
