// A scrolling strip: tiles (board bands, material pages) stacked in one column that the teacher scrolls and students follow.
// Everything here is in strip units: the strip's width is 1, so a tile of aspect a is 1/a tall. A position is a tile index plus
// the fraction of that tile above the viewport's top edge (2.25 = a quarter into the third tile); it does not depend on anyone's
// window size, which is why it is what the teacher sends.

export type StripLayout = Readonly<{ tops: readonly number[]; heights: readonly number[]; total: number }>;
export type StripWindow = Readonly<{ first: number; last: number }>;
export type EdgeExit = Readonly<{ edge: "top" | "bottom"; x: number; y: number }>;
type XY = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ width: number; height: number }>;

export const EMPTY_LAYOUT: StripLayout = Object.freeze({ tops: [], heights: [], total: 0 });
export const NO_TILES: StripWindow = Object.freeze({ first: 0, last: -1 });
export const READING_LINE = 0.35; // of the viewport, from its top: the page there is "the current page"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 1e4) / 1e4;

export function stripLayout(aspects: readonly number[], gap = 0): StripLayout {
  const tops: number[] = [], heights: number[] = [];
  let top = 0;
  for (const aspect of aspects) {
    const height = aspect > 0 && Number.isFinite(aspect) ? 1 / aspect : 1;
    tops.push(top);
    heights.push(height);
    top += height + gap;
  }
  return { tops, heights, total: aspects.length ? top - gap : 0 };
}

// `count` equal tiles without gaps (the board's bands).
export function uniformLayout(count: number, aspect: number): StripLayout {
  return stripLayout(Array.from({ length: Math.max(0, Math.floor(count)) }, () => aspect));
}

// The tile whose rows contain `y` (a gap belongs to the tile above it); -1 for an empty strip.
export function tileAt(layout: StripLayout, y: number): number {
  const count = layout.tops.length;
  if (!count) return -1;
  let low = 0, high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (layout.tops[middle] <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function topAt(layout: StripLayout, position: number): number {
  const count = layout.tops.length;
  if (!count) return 0;
  const safe = Number.isFinite(position) ? clamp(position, 0, count) : 0;
  const index = Math.min(count - 1, Math.floor(safe));
  return layout.tops[index] + clamp(safe - index, 0, 1) * layout.heights[index];
}

// Inverse of topAt; a row inside a gap is the top of the next tile.
export function posAt(layout: StripLayout, y: number): number {
  const index = tileAt(layout, y);
  if (index < 0) return 0;
  const fraction = (y - layout.tops[index]) / layout.heights[index];
  if (fraction >= 1) return index < layout.tops.length - 1 ? index + 1 : round(index + 1);
  return round(index + clamp(fraction, 0, 1));
}

// Tiles that touch rows [top - overscan, bottom + overscan].
export function visibleTiles(layout: StripLayout, top: number, bottom: number, overscan = 0): StripWindow {
  const count = layout.tops.length;
  if (!count || !(bottom >= top)) return NO_TILES;
  const from = top - overscan, to = bottom + overscan;
  if (to < 0 || from > layout.total) return NO_TILES;
  let first = Math.max(0, tileAt(layout, from));
  // `from` may fall in the gap under tile `first`.
  if (layout.tops[first] + layout.heights[first] < from && first < count - 1) first++;
  return { first, last: Math.max(first, tileAt(layout, to)) };
}

// The page a «3 / 12» indicator names for rows [top, bottom]: the one at the reading line. A page at the top row keeps the name
// while half of it still shows (pages much shorter than the viewport), so a jump to a page always names that page; scrolled to
// the very end, it is the last page.
export function readingTile(layout: StripLayout, top: number, bottom: number): number {
  const count = layout.tops.length;
  if (!count) return -1;
  if (top > 1e-6 && bottom >= layout.total - 1e-6) return count - 1;
  const first = clamp(Math.floor(posAt(layout, top)), 0, count - 1);
  const line = top + Math.min(READING_LINE * Math.max(0, bottom - top), 0.5 * layout.heights[first]);
  return Math.max(first, tileAt(layout, line));
}

// Where «‹» and «›» go from position `at` (the top row) while the indicator names `reading`: always a page top above or
// below the top row, and never the page the indicator already names.
export function stepTile(at: number, reading: number, by: -1 | 1, count: number): number {
  const target = by > 0 ? Math.max(Math.floor(at + 1e-3) + 1, reading + 1) : Math.min(Math.ceil(at - 1e-3) - 1, reading - 1);
  return clamp(target, 0, Math.max(0, count - 1));
}

// How far down the board may be scrolled: one blank band below the lowest band with marks and below what is on screen,
// so there is always clean space to scroll into, up to `max` bands.
export function boardExtent(input: { bands: number; bottom: number; bandHeight: number; max: number }): number {
  const used = clamp(Math.floor(input.bands) || 1, 1, input.max);
  const shown = input.bandHeight > 0 ? Math.ceil(Math.max(0, input.bottom) / input.bandHeight - 1e-9) : 1;
  return Math.min(input.max, Math.max(used, shown) + 1) * input.bandHeight;
}

// The strip's width in a viewport (px): landscape reference pages (slides) fit whole, portrait pages and the board fill the width.
export function stripWidth(viewport: Size, referenceAspect: number, fitPage: boolean): number {
  if (!(viewport.width > 0)) return 0;
  if (!fitPage || !(referenceAspect >= 1) || !(viewport.height > 0)) return viewport.width;
  return Math.min(viewport.width, viewport.height * referenceAspect);
}

// A follower's strip is narrowed until the teacher's rows (`span` strip units tall) fit its viewport.
export function followWidth(viewport: Size, span: number, own: number): number {
  if (!(span > 0) || !(viewport.height > 0)) return own;
  return Math.max(1, Math.min(own, viewport.height / span));
}

// Where a stroke left its band: the point on the top or bottom edge between the last sample inside and the first outside
// (client px). null while the pointer is still inside, or was already outside.
export function edgeExit(last: XY, current: XY, rect: { top: number; bottom: number }): EdgeExit | null {
  const bottom = current.y > rect.bottom && last.y <= rect.bottom;
  const top = current.y < rect.top && last.y >= rect.top;
  if (!bottom && !top) return null;
  const y = bottom ? rect.bottom : rect.top;
  const run = current.y - last.y;
  const t = run !== 0 ? clamp((y - last.y) / run, 0, 1) : 0;
  return { edge: bottom ? "bottom" : "top", x: last.x + t * (current.x - last.x), y };
}
