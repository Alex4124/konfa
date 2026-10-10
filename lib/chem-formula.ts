import type { Point } from "@/lib/confa-types";
import { fontPx as unitsToFontPx, round4, textUnits, type Size } from "./annotation-geometry.ts";
import { innerWidthEm, TEXT_ASCENT, TEXT_DESCENT, TEXT_LINE_HEIGHT, TEXT_PAD_X, TEXT_PAD_Y, type MeasureEm, type TextMetrics } from "./annotation-text.ts";

// A formula is a text mark with `chem: 1`. `text` and `lines` keep what was typed, so a client that does not know the flag
// shows the source, and every viewer lays the stored lines out itself. Like lib/annotation-text, everything is in em
// (font size = 1); y is relative to the baseline and grows downwards.
export const SCRIPT_SCALE = 0.68;
export const SUB_SHIFT = 0.2;
export const SUP_SHIFT = -0.38;
export const OVER_SCALE = 0.6;
export const OVER_SHIFT = -0.84; // an oxidation state sits above the capitals
export const OVER_EXTRA = 0.36; // what a line with oxidation states adds above its baseline
export const LABEL_SCALE = 0.6; // the condition above an arrow
export const FORMULA_STROKE = 0.085; // drawn arrows

export type ArrowDir = "right" | "both";
// start, end: the token's place in the source line. A "space" is where a line may break; an "atom" is an element symbol:
// digits after it are indices and an oxidation state sits above it.
export type FormulaToken = { start: number; end: number } & (
  | { type: "text" | "space" | "atom" | "sub" | "sup" | "over"; text: string }
  | { type: "arrow"; dir: ArrowDir; label: string }
  | { type: "mark"; dir: "up" | "down" } // gas, precipitate
);
export type FormulaRun = { text: string; x: number; dy: number; scale: number };
// strokes: polylines of the drawn arrows; atoms: where each element symbol stands on the baseline.
export type FormulaLayout = { runs: FormulaRun[]; strokes: Point[][]; width: number; over: boolean; atoms: Array<{ x: number; width: number }> };

// Arrows are drawn, not typed as glyphs: Arial has no ⇄ and a fallback font would change the line's width.
const ARROWS: ReadonlyArray<readonly [string, ArrowDir]> = [["<->", "both"], ["<=>", "both"], ["⇄", "both"], ["⇌", "both"], ["↔", "both"], ["-->", "right"], ["->", "right"], ["→", "right"], ["⟶", "right"]];
// Typed in the Russian layout, these look exactly like Latin element letters.
const CYRILLIC_UPPER = "АВЕКМНОРСТХ";
const CYRILLIC_LOWER = "аеорсух";
const SCRIPT = /^(?:[+\-−]\d+|\d+[+\-−]?|[+\-−])/; // ^2-, ^3+, ^+, ^-3, ^2
const OXIDATION = /^(?:[+\-−]\d|0)/; // ^^+6, ^^-2, ^^0
const DIGITS = /^\d+/;
const LETTER = /^\p{L}/u;
const WORD_END = /[\p{L})\]]$/u;
const ARROW_MIN = 1.5;
const ARROW_PAD = 0.3;
const AXIS = 0.34; // the arrow's height above the baseline, level with a plus sign
const PAIR_GAP = 0.18;
const HEAD_X = 0.2;
const HEAD_Y = 0.12;
const LABEL_GAP = 0.2;
const MARK_WIDTH = 0.4;
const MARK_GAP = 0.06;
const MARK_TOP = 0.72;
const OVER_GAP = 0.14;
const FIT_EPSILON = 1e-6;

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLatin = (c: string | undefined) => c !== undefined && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z"));
const isUpper = (c: string | undefined) => c !== undefined && ((c >= "A" && c <= "Z") || CYRILLIC_UPPER.includes(c));
const isLower = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || CYRILLIC_LOWER.includes(c));
// The end of a formula: the line's edge counts as a space, so a wrapped line reads the same as the unwrapped text.
const ends = (c: string | undefined) => c === undefined || c === " " || ",;.)".includes(c);
// Where a charge may end: also before the bracket of a concentration, [H+].
const closes = (c: string | undefined) => ends(c) || c === "]";
const isSign = (c: string | undefined) => c === "+" || c === "-" || c === "−";
const glued = (c: string | undefined) => c !== undefined && c !== " ";
const minus = (text: string) => text.replace(/-/g, "−");

// ↑ and ↓ as typed, a lone ^ (gas), or a lone v right after a formula (precipitate): "v = k[A]" keeps its letter.
function markAt(line: string, index: number, before: string | undefined): "up" | "down" | null {
  const c = line[index], next = line[index + 1];
  if (c === "↑" || (c === "^" && next !== "^" && ends(next))) return "up";
  if (c === "↓") return "down";
  const formula = isLatin(before) || isDigit(before) || before === ")" || before === "]" || (before !== undefined && CYRILLIC_UPPER.includes(before));
  return c === "v" && ends(next) && formula ? "down" : null;
}

// One line of the source into tokens. Nothing here fails: what does not read as chemistry stays plain text.
export function parseFormula(line: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  const plain = (text: string, start: number, end: number) => {
    const last = tokens[tokens.length - 1];
    if (last?.type === "text" && last.end === start) {
      last.text += text;
      last.end = end;
    } else tokens.push({ type: "text", text, start, end });
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i], prev = line[i - 1], next = line[i + 1];
    const last = tokens[tokens.length - 1];

    if (c === " ") {
      let j = i;
      while (line[j] === " ") j++;
      // The space before ↑ or ↓ belongs to the sign, so the line never breaks there.
      const mark = markAt(line, j, prev);
      if (mark) {
        tokens.push({ type: "mark", dir: mark, start: i, end: j + 1 });
        i = j + 1;
      } else {
        tokens.push({ type: "space", text: line.slice(i, j), start: i, end: j });
        i = j;
      }
      continue;
    }

    const arrow = ARROWS.find(([sign]) => line.startsWith(sign, i));
    if (arrow) {
      let end = i + arrow[0].length, label = "";
      const close = line[end] === "[" ? line.indexOf("]", end) : -1;
      if (close > 0) {
        label = line.slice(end + 1, close);
        end = close + 1;
      }
      tokens.push({ type: "arrow", dir: arrow[1], label, start: i, end });
      i = end;
      continue;
    }

    const mark = markAt(line, i, undefined);
    if (mark) {
      tokens.push({ type: "mark", dir: mark, start: i, end: i + 1 });
      i++;
      continue;
    }

    if (c === "^" && next === "^") {
      const match = OXIDATION.exec(line.slice(i + 2));
      const anchored = last?.type === "atom" || (last?.type === "sub" && tokens[tokens.length - 2]?.type === "atom");
      if (match && anchored) {
        const end = i + 2 + match[0].length;
        tokens.push({ type: "over", text: minus(match[0]), start: i, end });
        i = end;
      } else {
        plain("^^", i, i + 2);
        i += 2;
      }
      continue;
    }

    if (c === "^" || c === "_") {
      const rest = line.slice(i + 1);
      const close = rest[0] === "{" ? rest.indexOf("}") : -1;
      const body = close > 1 ? rest.slice(1, close) : ((c === "^" ? SCRIPT : DIGITS).exec(rest) ?? LETTER.exec(rest))?.[0];
      if (body) {
        const end = i + 1 + (close > 1 ? close + 1 : body.length);
        tokens.push({ type: c === "^" ? "sup" : "sub", text: minus(body), start: i, end });
        i = end;
      } else {
        plain(c, i, i + 1);
        i++;
      }
      continue;
    }

    if (isUpper(c)) {
      let j = i + 1;
      while (isLower(line[j])) j++;
      tokens.push({ type: "atom", text: line.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (isDigit(line[j])) j++;
      // An index follows an element, its oxidation state, a bracket or a Latin letter; any other number is a coefficient.
      const index = last?.type === "atom" || last?.type === "over" || (last?.type === "text" && (isLatin(prev) || prev === ")" || prev === "]"));
      // Digits and a sign that end a formula hold its charge, typed without ^. Of several digits the last one is the
      // charge: SO42-, O22-. A single digit is the charge of a lone element or of a complex (Ba2+, [Cu(NH3)4]2+) and an
      // index anywhere else (NH4+, MnO4-). What this guesses wrong ("FeOH2+") is typed with ^.
      if (index && isSign(line[j]) && closes(line[j + 1]) && (last?.type === "atom" || prev === ")" || prev === "]")) {
        const before = tokens[tokens.length - 2];
        const lone = last?.type === "atom" && (!before || before.type === "space" || before.type === "arrow" || before.type === "mark" || (before.type === "text" && !WORD_END.test(before.text)));
        const cut = j - i > 1 ? j - 1 : lone || prev === "]" ? i : j;
        if (cut > i) tokens.push({ type: "sub", text: line.slice(i, cut), start: i, end: cut });
        tokens.push({ type: "sup", text: line.slice(cut, j) + (line[j] === "+" ? "+" : "−"), start: cut, end: j + 1 });
        i = j + 1;
        continue;
      }
      if (index) tokens.push({ type: "sub", text: line.slice(i, j), start: i, end: j });
      else plain(line.slice(i, j), i, j);
      i = j;
      continue;
    }

    // The electron: "2e-", "+ e-".
    if ((c === "e" || c === "е") && next === "-" && ends(line[i + 2]) && (prev === undefined || " +-−(0123456789".includes(prev))) {
      plain(c, i, i + 1);
      tokens.push({ type: "sup", text: "−", start: i + 1, end: i + 2 });
      i += 2;
      continue;
    }

    // A sign that ends a formula is its charge: OH-, Na+, NO3-.
    if (isSign(c) && closes(next) && (last?.type === "atom" || last?.type === "sub" || prev === ")" || prev === "]")) {
      tokens.push({ type: "sup", text: c === "+" ? "+" : "−", start: i, end: i + 1 });
      i++;
      continue;
    }

    if ((c === "*" || c === "#") && glued(prev) && glued(next)) {
      plain(c === "*" ? "·" : "≡", i, i + 1);
      i++;
      continue;
    }

    if (c === "-") {
      // A bond next to an atom group; a range between numbers; a minus before a number; otherwise the hyphen of a word ("бутен-1").
      const bond = (last?.type === "atom" || last?.type === "sub" || last?.type === "over" || prev === ")" || prev === "]" || isUpper(next)) && !isDigit(next);
      const open = prev === undefined || prev === " " || prev === "(";
      plain(bond || (isDigit(prev) && isDigit(next)) ? "–" : open && (isDigit(next) || !glued(next)) ? "−" : "-", i, i + 1);
      i++;
      continue;
    }

    plain(c, i, i + 1);
    i++;
  }
  return tokens;
}

function head(tip: number, y: number, dir: 1 | -1, sides: ReadonlyArray<1 | -1> = [-1, 1]): Point[][] {
  return sides.map((side): Point[] => [[tip - dir * HEAD_X, y + side * HEAD_Y], [tip, y]]);
}

// Positions of everything in one line. `nested` lays out the condition above an arrow: no conditions of its own.
export function layoutFormula(line: string, measure: MeasureEm, nested = false): FormulaLayout {
  const runs: FormulaRun[] = [], strokes: Point[][] = [], atoms: Array<{ x: number; width: number }> = [];
  let x = 0, base = "", baseX = 0, right = 0, over = false, overEnd = -Infinity;
  let script: { type: "sub" | "sup"; x: number } | null = null; // the index or charge the line ends with so far
  // Text on the baseline gathers into one run, so the browser spaces its letters as usual.
  const flush = () => {
    if (!base) return;
    runs.push({ text: base, x: baseX, dy: 0, scale: 1 });
    x = baseX + measure(base);
    base = "";
  };
  for (const token of parseFormula(line)) {
    if (token.type === "text" || token.type === "space" || token.type === "atom") {
      if (!base) baseX = x;
      script = null;
      const before = measure(base);
      base += token.text;
      if (token.type === "atom") atoms.push({ x: baseX + before, width: measure(base) - before });
    } else if (token.type === "over") {
      const atom = atoms[atoms.length - 1];
      if (!atom) continue;
      const width = measure(token.text) * OVER_SCALE;
      // Centred over its element; pushed right rather than onto the previous one.
      const left = Math.max(0, overEnd + OVER_GAP, atom.x + atom.width / 2 - width / 2);
      runs.push({ text: token.text, x: left, dy: OVER_SHIFT, scale: OVER_SCALE });
      overEnd = left + width;
      right = Math.max(right, overEnd);
      over = true;
    } else if (token.type === "sub" || token.type === "sup") {
      flush();
      // A charge right after an index stands above it, as in print: the 2− of SO₄²⁻ over its 4.
      const start: number = script && script.type !== token.type ? script.x : x;
      runs.push({ text: token.text, x: start, dy: token.type === "sub" ? SUB_SHIFT : SUP_SHIFT, scale: SCRIPT_SCALE });
      script = start === x ? { type: token.type, x } : null;
      x = Math.max(x, start + measure(token.text) * SCRIPT_SCALE);
    } else if (token.type === "arrow") {
      flush();
      script = null;
      const text = nested ? "" : token.label.trim();
      const label = text ? layoutFormula(text, measure, true) : null;
      const length = Math.max(ARROW_MIN, label ? label.width * LABEL_SCALE + 2 * ARROW_PAD : 0);
      const tip = x + length;
      let top = -AXIS;
      if (token.dir === "right") strokes.push([[x, top], [tip, top]], ...head(tip, top, 1));
      else {
        const bottom = -AXIS + PAIR_GAP / 2;
        top = -AXIS - PAIR_GAP / 2;
        strokes.push([[x, top], [tip, top]], ...head(tip, top, 1, [-1]), [[x, bottom], [tip, bottom]], ...head(x, bottom, -1, [1]));
      }
      if (label) {
        const start = x + (length - label.width * LABEL_SCALE) / 2, lift = top - LABEL_GAP;
        for (const run of label.runs) runs.push({ text: run.text, x: start + run.x * LABEL_SCALE, dy: lift + run.dy * LABEL_SCALE, scale: run.scale * LABEL_SCALE });
        for (const stroke of label.strokes) strokes.push(stroke.map(([sx, sy]): Point => [start + sx * LABEL_SCALE, lift + sy * LABEL_SCALE]));
      }
      x = tip;
    } else if (token.type === "mark") {
      flush();
      script = null;
      const cx = x + MARK_GAP + MARK_WIDTH / 2;
      const up = token.dir === "up";
      const tip = up ? -MARK_TOP : 0, barb = tip + (up ? HEAD_X : -HEAD_X);
      strokes.push([[cx, up ? 0 : -MARK_TOP], [cx, tip]], [[cx - HEAD_Y, barb], [cx, tip]], [[cx + HEAD_Y, barb], [cx, tip]]);
      x += MARK_GAP + MARK_WIDTH;
    }
  }
  flush();
  return { runs, strokes, width: Math.max(x, right), over, atoms };
}

export function formulaLineHeightEm(layout: Pick<FormulaLayout, "over">): number {
  return TEXT_LINE_HEIGHT + (layout.over ? OVER_EXTRA : 0);
}

// Baselines from the plate top, one per line (lib/annotation-text baselineOffsetsEm for lines of uneven height).
export function formulaBaselinesEm(layouts: ReadonlyArray<Pick<FormulaLayout, "over">>): number[] {
  const first = (TEXT_LINE_HEIGHT - TEXT_ASCENT - TEXT_DESCENT) / 2 + TEXT_ASCENT;
  let top = TEXT_PAD_Y;
  return layouts.map((layout) => {
    const baseline = round6(top + (layout.over ? OVER_EXTRA : 0) + first);
    top += formulaLineHeightEm(layout);
    return baseline;
  });
}

// Plate extent in em, padding included.
export function formulaExtentEm(layouts: ReadonlyArray<Pick<FormulaLayout, "over" | "width">>): { width: number; height: number } {
  let width = 0, height = 0;
  for (const layout of layouts) {
    width = Math.max(width, layout.width);
    height += formulaLineHeightEm(layout);
  }
  return { width: width + 2 * TEXT_PAD_X, height: Math.max(TEXT_LINE_HEIGHT, height) + 2 * TEXT_PAD_Y };
}

// Greedy wrap at spaces only: a formula is never split inside a word, and the condition of an arrow stays with its arrow.
// A word wider than the line keeps its own line. NaN or Infinity disables wrapping.
export function wrapFormula(text: string, maxInnerEm: number, measure: MeasureEm): string[] {
  const paragraphs = text.split("\n");
  if (Number.isNaN(maxInnerEm) || maxInnerEm === Infinity) return paragraphs;
  const max = Math.max(0, maxInnerEm) + FIT_EPSILON;
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const tokens = parseFormula(paragraph);
    let start = -1, end = 0; // the current line's place in the paragraph; its first line keeps the indent
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].type === "space") continue;
      const wordStart = tokens[index].start;
      while (index + 1 < tokens.length && tokens[index + 1].type !== "space") index++;
      const wordEnd = tokens[index].end;
      if (start < 0) start = 0;
      else if (layoutFormula(paragraph.slice(start, wordEnd), measure).width > max) {
        lines.push(paragraph.slice(start, end));
        start = wordStart;
      }
      end = wordEnd;
    }
    lines.push(start < 0 ? "" : paragraph.slice(start, end));
  }
  return lines;
}

// Author-side layout of a formula: lib/annotation-text textMetrics with the formula's own wrap and line heights.
export function formulaMetrics(input: { text: string; fontSize?: number; maxWidth?: number; box: Size; measure: MeasureEm }): TextMetrics {
  const { text, maxWidth, box, measure } = input;
  const px = unitsToFontPx(textUnits({ fontSize: input.fontSize }), box.height);
  if (!(px > 0) || !(box.width > 0)) return { lines: text.split("\n"), w: 0, h: 0 };
  const lines = maxWidth === undefined ? text.split("\n") : wrapFormula(text, innerWidthEm(maxWidth, box, px), measure);
  const extent = formulaExtentEm(lines.map((line) => layoutFormula(line, measure)));
  return { lines, w: round4(extent.width * px / box.width), h: round4(extent.height * px / box.height) };
}
