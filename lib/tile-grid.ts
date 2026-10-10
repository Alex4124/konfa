import type { Size } from "./annotation-geometry.ts";
import type { StripPlacement } from "./view-transform.ts";

// Camera tiles. Every tile is 16:9 and shows its camera whole; the layout picks the columns and rows that show everyone
// at once with the largest tiles. The grid fills its box. A strip beside the stage (the workspace or a screen share) may
// take up to a limit set by the viewer's camera size and is only as thick as its tiles need.

export type CameraSize = "s" | "m" | "l";
// How the tiles overflow when even the smallest ones do not fit: a strip on top scrolls sideways, the rest scroll down.
export type TileScroll = "x" | "y";
export type TileFit = Readonly<{ columns: number; rows: number; width: number; height: number; scroll: TileScroll | null }>;
// extent: the strip's height when on top and its width when on the left, padding included.
export type StripFit = Readonly<{ extent: number; fit: TileFit }>;

export const TILE_ASPECT = 16 / 9;
export const TILE_GAP = 8;
export const MIN_TILE_WIDTH = 80;
export const CAMERA_SIZES: readonly CameraSize[] = ["s", "m", "l"];
export const DEFAULT_CAMERA_SIZE: CameraSize = "m";
export const CAMERA_SIZE_KEY = "confa:camera-size:v1";
// Padding of a strip: across it (above and below a top strip) and along it.
export const STRIP_PAD = Object.freeze({ across: 4, along: 8 });

// [share of the window, min px, max px] of the window's height for a top strip and of its width for a left one.
type Limit = readonly [share: number, min: number, max: number];
const STRIP_LIMITS: Record<CameraSize, Record<StripPlacement, Limit>> = {
  s: { top: [0.11, 64, 136], left: [0.15, 100, 176] },
  m: { top: [0.22, 112, 272], left: [0.22, 150, 300] },
  l: { top: [0.3, 160, 380], left: [0.3, 200, 420] },
};
// Whatever the size, the cameras leave the stage at least this much of the area.
const STAGE_SHARE = 2 / 3;
const NO_FIT: TileFit = Object.freeze({ columns: 0, rows: 0, width: 0, height: 0, scroll: null });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function parseCameraSize(raw: unknown): CameraSize {
  return CAMERA_SIZES.includes(raw as CameraSize) ? raw as CameraSize : DEFAULT_CAMERA_SIZE;
}

// The largest tiles that show `count` people in the box without scrolling. Ties go to fewer rows; a row count gets the
// fewest columns that hold everyone, so the rows come out even (3 + 3, not 5 + 1).
export function fitTiles(count: number, box: Size, options: { gap?: number; aspect?: number; minWidth?: number; overflow?: TileScroll } = {}): TileFit {
  const { gap = TILE_GAP, aspect = TILE_ASPECT, overflow = "y" } = options;
  if (!(count >= 1) || !(box.width > 0) || !(box.height > 0)) return NO_FIT;
  const total = Math.floor(count);
  let best = { columns: 0, rows: 0, width: 0 };
  for (let rows = 1; rows <= total; rows += 1) {
    const columns = Math.ceil(total / rows);
    const width = Math.floor(Math.min((box.width - gap * (columns - 1)) / columns, aspect * (box.height - gap * (rows - 1)) / rows));
    if (width > best.width) best = { columns, rows, width };
  }
  const minWidth = Math.min(options.minWidth ?? MIN_TILE_WIDTH, Math.floor(box.width));
  if (best.width >= minWidth) return { ...best, height: best.width / aspect, scroll: null };
  if (overflow === "x") {
    // As many rows as the height holds, the columns run off to the right.
    const rows = Math.max(1, Math.floor((box.height + gap) / (minWidth / aspect + gap)));
    const width = Math.floor(aspect * (box.height - gap * (rows - 1)) / rows);
    return { columns: Math.ceil(total / rows), rows, width, height: width / aspect, scroll: "x" };
  }
  const columns = Math.max(1, Math.floor((box.width + gap) / (minWidth + gap)));
  const width = Math.floor((box.width - gap * (columns - 1)) / columns);
  return { columns, rows: Math.ceil(total / columns), width, height: width / aspect, scroll: "y" };
}

// How thick the strip may get: a share of the window by the camera size, never more than a third of the area.
export function stripLimit(size: CameraSize, placement: StripPlacement, area: Size, viewport: Size): number {
  const [share, min, max] = STRIP_LIMITS[size][placement];
  const top = placement === "top";
  return Math.max(0, Math.floor(Math.min(clamp(share * (top ? viewport.height : viewport.width), min, max), (top ? area.height : area.width) * (1 - STAGE_SHARE))));
}

// The strip of `count` tiles beside a stage that fills `area` together with it.
export function fitStrip(count: number, placement: StripPlacement, size: CameraSize, area: Size, viewport: Size, gap = TILE_GAP): StripFit {
  const top = placement === "top";
  const limit = stripLimit(size, placement, area, viewport);
  const along = (top ? area.width : area.height) - 2 * STRIP_PAD.along;
  const across = limit - 2 * STRIP_PAD.across;
  const fit = fitTiles(count, top ? { width: along, height: across } : { width: across, height: along }, { gap, overflow: top ? "x" : "y" });
  if (!fit.columns) return { extent: 0, fit };
  const lines = top ? fit.rows : fit.columns;
  const used = lines * (top ? fit.height : fit.width) + gap * (lines - 1);
  return { extent: Math.min(limit, Math.ceil(used) + 2 * STRIP_PAD.across), fit };
}

// Tiles: the teacher first, the viewer's own tile last, the others as they joined (the order given).
export function orderMembers<T extends { id: string; role: string }>(members: readonly T[], selfId: string): T[] {
  const rank = (person: T) => (person.role === "host" ? 0 : 2) + (person.id === selfId ? 1 : 0);
  return members.map((person, index) => ({ person, index })).sort((a, b) => rank(a.person) - rank(b.person) || a.index - b.index).map((item) => item.person);
}
