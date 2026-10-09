import type { AnnotationPayload, Point } from "@/lib/confa-types";
import { fontPx as unitsToFontPx, round4, TEXT_FONT, TEXT_SIZE_UNITS, textUnits, type Size } from "./annotation-geometry.ts";
import { MAX_LINES_CHARS, MAX_TEXT_CHARS, MAX_TEXT_LINES } from "./annotation-validate.ts";

// Everything here is in em (font size = 1), so wrapping does not depend on the viewer's frame size.
export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_PAD_X = 0.3;
export const TEXT_PAD_Y = 0.15;
export const TEXT_ASCENT = 0.905; // Arial / Liberation Sans
export const TEXT_DESCENT = 0.212;
export const TEXT_PLATE_RADIUS_EM = 0.2;
export const TEXT_WEIGHT = 700;
export const TEXT_MAX_CHARS = MAX_TEXT_CHARS;
export const TEXT_MAX_LINES = MAX_TEXT_LINES;
export const TEXT_TARGET_EMS = 20;
export const TEXT_MIN_WIDTH = 0.12;
export const TEXT_DEFAULT_MAX_WIDTH = 0.6;

// Width of `s` in em (measured at 100px / 100).
export type MeasureEm = (s: string) => number;
export type TextMetrics = { lines: string[]; w: number; h: number };
export type TextPlate = { fill: string; fillOpacity: number; stroke?: string };
export type TextSizeKey = keyof typeof TEXT_SIZE_UNITS;

const FIT_EPSILON = 1e-6;
const BREAK_SPACES = /([ \u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+)/;
const TRAILING_SPACES = /[ \u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+$/;
const HYPHENS = "-\u2010\u2013";
const LETTER = /\p{L}/u;
const GRAPHEME_FALLBACK = /\p{Regional_Indicator}{2}|[^\p{M}\u200d][\p{M}\p{Emoji_Modifier}\u{e0020}-\u{e007f}]*(?:\u200d[^\p{M}\u200d][\p{M}\p{Emoji_Modifier}\u{e0020}-\u{e007f}]*)*\u200d?|[\s\S]/gu;
const LIGHT_PLATE = "#ffffff";
const DARK_PLATE = "#0e192c";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const trimSpaces = (line: string) => line.replace(TRAILING_SPACES, "");

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };
let segmenter: GraphemeSegmenter | null | undefined;

function getSegmenter(): GraphemeSegmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

// Approximate extended grapheme clusters for engines without Intl.Segmenter (ZWJ emoji, skin tones, flags, combining marks).
export function graphemesFallback(text: string): string[] {
  return text.match(GRAPHEME_FALLBACK) ?? [];
}

export function graphemes(text: string): string[] {
  const seg = getSegmenter();
  return seg ? Array.from(seg.segment(text), (part) => part.segment) : graphemesFallback(text);
}

// CRLF/CR → LF, tabs → 2 spaces, control chars dropped, trailing spaces trimmed per line,
// at most 2 consecutive blank lines, no outer blank lines, ≤ TEXT_MAX_LINES lines and ≤ TEXT_MAX_CHARS UTF-16 units.
export function normalizeText(raw: string): string {
  const unified = (typeof raw === "string" ? raw : "").slice(0, TEXT_MAX_CHARS * 8).replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n").replace(/\t/g, "  ");
  let clean = "";
  for (const char of unified) {
    const code = char.charCodeAt(0);
    if (code === 10 || (code >= 32 && code !== 127 && !(code >= 0x80 && code < 0xa0) && !(char.length === 1 && code >= 0xd800 && code <= 0xdfff))) clean += char;
  }
  const lines: string[] = [];
  let blanks = 0;
  for (const source of clean.split("\n")) {
    const line = source.trimEnd();
    if (line) blanks = 0;
    else if (!lines.length || ++blanks > 2) continue;
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  let text = lines.slice(0, TEXT_MAX_LINES).join("\n");
  if (text.length > TEXT_MAX_CHARS) {
    let cut = "";
    for (const part of graphemes(text)) {
      if (cut.length + part.length > TEXT_MAX_CHARS) break;
      cut += part;
    }
    text = cut;
  }
  return text.trimEnd();
}

// Soft break opportunities inside a word: after a hyphen between two letters ("какой-то", "онлайн-встреча").
function wordPieces(word: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (let i = 1; i < word.length - 1; i++) {
    if (HYPHENS.includes(word[i]) && LETTER.test(word[i - 1]) && LETTER.test(word[i + 1])) {
      pieces.push(word.slice(start, i + 1));
      start = i + 1;
    }
  }
  pieces.push(word.slice(start));
  return pieces;
}

// Greedy split of a word that does not fit on its own line; at least one grapheme per line.
function splitWord(word: string, fits: (s: string) => boolean): string[] {
  const parts = graphemes(word);
  const chunks: string[] = [];
  let start = 0;
  while (start < parts.length) {
    const rest = parts.slice(start).join("");
    if (fits(rest)) {
      chunks.push(rest);
      break;
    }
    let lo = start + 1, hi = parts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(parts.slice(start, mid).join(""))) lo = mid;
      else hi = mid - 1;
    }
    chunks.push(parts.slice(start, lo).join(""));
    start = lo;
  }
  return chunks;
}

// Greedy wrap like CSS `white-space: pre-wrap; overflow-wrap: anywhere`. Hard breaks and empty lines are kept,
// trailing spaces are dropped, words longer than a line are split by grapheme. NaN or Infinity disables wrapping.
export function wrapText(text: string, maxInnerEm: number, measure: MeasureEm): string[] {
  const paragraphs = text.split("\n");
  if (Number.isNaN(maxInnerEm) || maxInnerEm === Infinity) return paragraphs;
  const max = Math.max(0, maxInnerEm) + FIT_EPSILON;
  const fits = (s: string) => measure(s) <= max;
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const first = lines.length;
    let line = "";
    for (const token of paragraph.split(BREAK_SPACES)) {
      if (!token) continue;
      const space = !trimSpaces(token);
      for (const piece of space ? [token] : wordPieces(token)) {
        if (fits(trimSpaces(line + piece))) {
          line += piece;
          continue;
        }
        if (space) {
          lines.push(trimSpaces(line));
          line = "";
          continue;
        }
        if (line.trim()) lines.push(trimSpaces(line));
        if (fits(piece)) {
          line = piece;
          continue;
        }
        const chunks = splitWord(piece, fits);
        lines.push(...chunks.slice(0, -1));
        line = chunks[chunks.length - 1] ?? "";
      }
    }
    const last = trimSpaces(line);
    if (last || lines.length === first) lines.push(last);
  }
  return lines;
}

// Inner (text) width in em of a plate whose outer width is `maxWidth` of the frame width.
export function innerWidthEm(maxWidth: number, box: Pick<Size, "width">, fontPx: number): number {
  if (!(fontPx > 0) || !(box.width > 0) || !Number.isFinite(maxWidth)) return NaN;
  return Math.max(0, round6(maxWidth * box.width / fontPx - 2 * TEXT_PAD_X));
}

// Plate extent in em, padding included.
export function textExtentEm(lines: readonly string[], measure: MeasureEm): { width: number; height: number } {
  let width = 0;
  for (const line of lines) width = Math.max(width, line ? measure(line) : 0);
  return { width: width + 2 * TEXT_PAD_X, height: Math.max(1, lines.length) * TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y };
}

// Default plate max width (fraction of frame width): about TEXT_TARGET_EMS em, within [TEXT_MIN_WIDTH, TEXT_DEFAULT_MAX_WIDTH].
export function defaultMaxWidth(box: Pick<Size, "width">, fontPx: number): number {
  if (!(box.width > 0) || !(fontPx > 0)) return TEXT_DEFAULT_MAX_WIDTH;
  return round4(clamp(TEXT_TARGET_EMS * fontPx / box.width, TEXT_MIN_WIDTH, TEXT_DEFAULT_MAX_WIDTH));
}

// Shrinks the max width so a plate anchored at `x` stays inside the frame, but not below TEXT_MIN_WIDTH
// (placeTextAnchor then shifts the anchor left).
export function fitMaxWidth(x: number, maxWidth: number): number {
  return round4(clamp(Math.min(maxWidth, 1 - x), TEXT_MIN_WIDTH, 1));
}

// Anchor (top-left) moved so that point + extent stays inside 0..1; rounded to 4 decimals.
export function placeTextAnchor(point: Point, extent: { w: number; h: number }): Point {
  const w = clamp(Number.isFinite(extent.w) ? extent.w : 0, 0, 1), h = clamp(Number.isFinite(extent.h) ? extent.h : 0, 0, 1);
  const x = Number.isFinite(point[0]) ? point[0] : 0, y = Number.isFinite(point[1]) ? point[1] : 0;
  return [round4(clamp(x, 0, 1 - w)), round4(clamp(y, 0, 1 - h))];
}

// Author-side layout: wrapped lines plus the plate extent normalized to the frame (padding included, 4 decimals).
// Without maxWidth (legacy) only hard breaks apply. Lines are identical for any frame of the same aspect.
export function textMetrics(input: { text: string; fontSize?: number; maxWidth?: number; box: Size; measure: MeasureEm }): TextMetrics {
  const { text, maxWidth, box, measure } = input;
  const px = unitsToFontPx(textUnits({ fontSize: input.fontSize }), box.height);
  if (!(px > 0) || !(box.width > 0)) return { lines: text.split("\n"), w: 0, h: 0 };
  const lines = maxWidth === undefined ? text.split("\n") : wrapText(text, innerWidthEm(maxWidth, box, px), measure);
  const extent = textExtentEm(lines, measure);
  return { lines, w: round4(extent.width * px / box.width), h: round4(extent.height * px / box.height) };
}

// Whether the metrics can be stored: within the line limits and the frame.
export function textFits(metrics: TextMetrics): boolean {
  return metrics.lines.length <= TEXT_MAX_LINES && metrics.lines.join("\n").length <= MAX_LINES_CHARS && metrics.w <= 1 && metrics.h <= 1;
}

// Lines to render: author-wrapped `lines`, or hard breaks of `text` for legacy rows.
export function textLines(data: Pick<AnnotationPayload, "text" | "lines">): string[] {
  return data.lines?.length ? data.lines : (data.text ?? "").split(/\r?\n/);
}

// Baselines from the plate top, in em: padding + half-leading + ascent, one per line.
export function baselineOffsetsEm(lineCount: number): number[] {
  const first = TEXT_PAD_Y + (TEXT_LINE_HEIGHT - TEXT_ASCENT - TEXT_DESCENT) / 2 + TEXT_ASCENT;
  return Array.from({ length: Math.max(0, Math.floor(lineCount) || 0) }, (_, i) => round6(first + i * TEXT_LINE_HEIGHT));
}

export function textFontCss(px: number, weight = TEXT_WEIGHT): string {
  return `${weight} ${px}px ${TEXT_FONT}`;
}

export function nearestTextSize(units: number): TextSizeKey {
  let best: TextSizeKey = "m";
  for (const key of Object.keys(TEXT_SIZE_UNITS) as TextSizeKey[]) if (Math.abs(TEXT_SIZE_UNITS[key] - units) < Math.abs(TEXT_SIZE_UNITS[best] - units)) best = key;
  return best;
}

// Rough bold-Arial estimate for environments without canvas (server render, tests).
export const estimateMeasureEm: MeasureEm = (s) => {
  let width = 0;
  for (const part of graphemes(s)) {
    const code = part.codePointAt(0) ?? 0;
    width += part === " " ? 0.28 : code >= 0x2e80 ? 1 : 0.62;
  }
  return width;
};

// WCAG relative luminance of #rgb / #rrggbb; NaN for anything else.
export function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof hex === "string" ? hex.trim() : "");
  if (!match) return NaN;
  const digits = match[1].length === 3 ? match[1].replace(/./g, (d) => d + d) : match[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Plate behind the text: whichever of the light and dark plates contrasts more with the text colour.
export function plateFor(color: string): TextPlate {
  if (contrastRatio(color, LIGHT_PLATE) > contrastRatio(color, DARK_PLATE)) return { fill: LIGHT_PLATE, fillOpacity: 0.85, stroke: "rgba(14, 25, 44, 0.3)" };
  return { fill: DARK_PLATE, fillOpacity: 0.72 };
}
