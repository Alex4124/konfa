"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Check, X } from "lucide-react";
import { TextMark } from "@/components/annotations/text-mark";
import { getMeasureEm } from "@/components/annotations/text-measure";
import { fontPx as unitsToFontPx, TEXT_FONT, type Size } from "@/lib/annotation-geometry";
import { plateFor, TEXT_LINE_HEIGHT, TEXT_MAX_CHARS, TEXT_PAD_X, TEXT_PAD_Y, TEXT_PLATE_RADIUS_EM, TEXT_WEIGHT, textMetrics } from "@/lib/annotation-text";
import { formulaMetrics } from "@/lib/chem-formula";
import type { AnnotationPayload, Point } from "@/lib/confa-types";

// targetId: the saved text being edited (absent for a new mark); original: what it was, to skip unchanged saves.
// chem: a formula — the text is its source, laid out by lib/chem-formula.
export type TextEditorState = { key: string; targetId?: string; point: Point; color: string; fontSize: number; maxWidth: number; text: string; chem?: boolean; original?: { text: string; color: string; fontSize: number } };
type Props = {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  state: TextEditorState | null;
  box: Size;
  coarse: boolean;
  scale?: number;
  onChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
};
// insert: what the button types; caret: where the caret lands inside it (default: after it);
// spaced: a sign that stands between spaces, they are not doubled next to a space already there.
type FormulaSign = { label: ReactNode; title: string; insert: string; caret?: number; spaced?: boolean };

const MIN_FONT_PX = 16; // iOS zooms the page into inputs with a smaller computed font
const COUNTER_FROM = 400;
const ACTIONS_GAP = 6;
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();
const small = (text: string) => <span className="text-[0.7em] leading-none">{text}</span>;
// The Russian layout has no ^, _ or #: every sign of the formula syntax is also a button.
const FORMULA_SIGNS: readonly FormulaSign[] = [
  { label: "→", title: "Стрелка реакции: ->", insert: " → ", spaced: true },
  { label: "⇄", title: "Обратимая реакция: <->", insert: " ⇄ ", spaced: true },
  { label: <span className="flex flex-col items-center leading-[0.7]">{small("t")}<span>→</span></span>, title: "Условие над стрелкой: ->[t, кат]", insert: " →[] ", caret: 3, spaced: true },
  { label: "↑", title: "Газ: пробел и ^", insert: "↑" },
  { label: "↓", title: "Осадок: пробел и v", insert: "↓" },
  { label: <span>X<sup>{small("2+")}</sup></span>, title: "Заряд иона: Fe^3+, SO4^2- (в конце формулы можно без ^: OH-, Ba2+)", insert: "^" },
  { label: <span className="flex flex-col items-center leading-[0.8]">{small("+6")}<span>X</span></span>, title: "Степень окисления над элементом: S^^+6", insert: "^^" },
  { label: <span>X<sub>{small("n")}</sub></span>, title: "Буквенный индекс: C_nH_{2n+2}", insert: "_" },
  { label: "·", title: "Кристаллогидрат: CuSO4*5H2O", insert: "·" },
  { label: "≡", title: "Тройная связь: CH#CH", insert: "≡" },
  { label: "°", title: "Градус", insert: "°" },
];

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return Number.isFinite(value) ? `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})` : hex;
}

// Mounted while text can be opened, so focus() runs inside the user's click (iOS shows the keyboard only then).
// The textarea has a computed font of at least 16 px and is scaled down to the mark's size, so lines wrap where the saved mark will.
// A formula is typed as its source; the row below shows the mark it becomes and the signs the keyboard lacks.
export function TextEditor({ editorRef, state, box, coarse, scale = 1, onChange, onCommit, onCancel }: Props) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<number | null>(null); // where a sign button left the caret, applied once the text has changed
  const chem = Boolean(state?.chem);
  const px = state ? unitsToFontPx(state.fontSize, box.height) : MIN_FONT_PX;
  const editorFont = Math.max(MIN_FONT_PX, px);
  const k = px > 0 ? px / editorFont : 1;
  const metrics = useMemo(() => state ? (state.chem ? formulaMetrics : textMetrics)({ text: state.text, fontSize: state.fontSize, maxWidth: state.maxWidth, box, measure: getMeasureEm() }) : null, [state, box]);
  const left = state ? state.point[0] * box.width : 0;
  const top = state && metrics ? Math.max(0, Math.min(state.point[1] * box.height, box.height - metrics.h * box.height)) : 0;
  const cssWidth = state ? state.maxWidth * box.width / k : 1;
  const open = state !== null;
  const text = state?.text ?? "";
  const counter = text.length > COUNTER_FROM;
  const showActions = open && (coarse || counter || chem);
  const plate = plateFor(state?.color ?? "#ffffff");
  const zoom = scale > 0 ? scale : 1;
  const unscale = 1 / zoom;
  // The formula as it will be saved, at the size it has on the screen (the row it sits in is not zoomed with the frame).
  const preview = useMemo(() => {
    if (!state?.chem || !metrics || !state.text.trim()) return null;
    const view = { width: box.width * zoom, height: box.height * zoom };
    const data: AnnotationPayload = { color: state.color, point: [0, 0], fontSize: state.fontSize, lines: metrics.lines, w: metrics.w, h: metrics.h, chem: 1 };
    return { data, view, width: Math.ceil(metrics.w * view.width), height: Math.ceil(metrics.h * view.height) };
  }, [state, metrics, box, zoom]);

  // Auto-grow and the actions row below the plate (above it near the bottom edge of the frame, or of the part of a
  // scrolling board that is on screen): DOM writes only.
  useLayoutEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    if (!open) {
      if (element.ownerDocument.activeElement === element) element.blur();
      return;
    }
    element.style.height = "0px";
    const height = element.scrollHeight;
    element.style.height = `${height}px`;
    const caret = caretRef.current;
    if (caret !== null) {
      caretRef.current = null;
      element.setSelectionRange(caret, caret);
    }
    const actions = actionsRef.current;
    if (!actions) return;
    const below = top + height * k + ACTIONS_GAP;
    const own = actions.offsetHeight * unscale;
    const view = actions.closest(".group\\/screen")?.getBoundingClientRect(); // the zoom frame's window
    const edge = element.getBoundingClientRect(), reach = actions.offsetHeight + ACTIONS_GAP;
    const cut = view !== undefined && edge.bottom + reach > view.bottom && edge.top - reach >= view.top;
    actions.style.top = `${below + own <= box.height && !cut ? below : Math.max(0, top - own - ACTIONS_GAP)}px`;
    actions.style.left = `${Math.max(0, Math.min(left, box.width - actions.offsetWidth * unscale))}px`;
  }, [editorRef, open, text, editorFont, cssWidth, k, top, left, box, unscale, showActions, preview]);

  // Fallback for openings outside a click (the click handler focuses synchronously).
  const key = state?.key;
  useEffect(() => {
    const element = editorRef.current;
    if (key && element && element.ownerDocument.activeElement !== element) element.focus({ preventScroll: true });
  }, [editorRef, key]);

  // Types a sign at the caret, over the selection. maxLength does not limit a value set from code.
  function typeSign(sign: FormulaSign) {
    const element = editorRef.current;
    if (!element || !open) return;
    const start = Math.min(element.selectionStart ?? text.length, text.length), end = Math.max(start, Math.min(element.selectionEnd ?? start, text.length));
    let insert = sign.insert, caret = sign.caret ?? insert.length;
    if (sign.spaced) {
      const before = text[start - 1], after = text[end];
      if (before === undefined || before === " " || before === "\n") {
        insert = insert.slice(1);
        caret--;
      }
      if (after === " ") {
        insert = insert.slice(0, -1);
        if (caret > insert.length) caret = insert.length + 1; // past the space already there
      }
    }
    element.focus({ preventScroll: true });
    if (text.length - (end - start) + insert.length > TEXT_MAX_CHARS) return;
    caretRef.current = start + caret;
    onChange(text.slice(0, start) + insert + text.slice(end));
  }

  return <>
    <textarea
      ref={editorRef}
      aria-label={chem ? "Формула" : "Текст пометки"}
      tabIndex={open ? 0 : -1}
      aria-hidden={open ? undefined : true}
      rows={1}
      maxLength={TEXT_MAX_CHARS}
      enterKeyHint={coarse ? "enter" : "done"}
      placeholder={chem ? (coarse ? "2H2 + O2 -> 2H2O" : "2H2 + O2 -> 2H2O  Enter — сохранить") : coarse ? "Текст…" : "Текст… Enter — сохранить"}
      spellCheck={!chem}
      autoCorrect={chem ? "off" : undefined}
      autoCapitalize={chem ? "off" : undefined}
      value={text}
      data-gesture-ignore
      className={`absolute z-20 m-0 block resize-none overflow-hidden border-0 outline-none placeholder:text-slate-400 ${open ? "" : "pointer-events-none opacity-0"}`}
      style={state ? {
        left, top, width: cssWidth, transform: k === 1 ? undefined : `scale(${k})`, transformOrigin: "0 0",
        fontFamily: TEXT_FONT, fontSize: editorFont, fontWeight: TEXT_WEIGHT, lineHeight: TEXT_LINE_HEIGHT, padding: `${TEXT_PAD_Y}em ${TEXT_PAD_X}em`, boxSizing: "border-box",
        color: state.color, caretColor: state.color, background: rgba(plate.fill, plate.fillOpacity), borderRadius: `${TEXT_PLATE_RADIUS_EM}em`,
        boxShadow: `0 0 0 ${2 / k}px #6de7d4`, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "normal",
      } : { left: 0, top: 0, width: 1, height: 1, fontSize: MIN_FONT_PX, padding: 0 }}
      onChange={(event) => { if (open) onChange(event.target.value); }}
      onKeyDown={(event) => {
        if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          // A toolbar popover took this Esc first (Radix listens on the document in capture): it closes only the popover.
          if (event.nativeEvent.defaultPrevented) return;
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key !== "Enter") return;
        // Virtual keyboards have no Shift+Enter: on touch Enter is a new line and «Готово» or Ctrl+Enter saves.
        if (event.ctrlKey || event.metaKey || (!coarse && !event.shiftKey && !event.altKey)) {
          event.preventDefault();
          onCommit();
        }
      }}
      onBlur={(event) => {
        if (!open) return;
        const doc = event.currentTarget.ownerDocument;
        if (!doc.hasFocus()) return; // another window took focus: keep editing
        const next = event.relatedTarget as Element | null;
        if (next && typeof next.closest === "function" && next.closest(".annotation-toolbar,[data-slot=popover-content],[data-text-editor]")) return;
        onCommit();
      }}
    />
    {/* data-text-editor: a press here is part of the editing, the workspace does not save the text on it. */}
    {showActions && <div ref={actionsRef} data-gesture-ignore data-text-editor className="absolute z-20 flex flex-col items-start gap-1.5 text-base" style={{ left, top, transform: unscale === 1 ? undefined : `scale(${unscale})`, transformOrigin: "0 0" }} onPointerDown={keepFocus} onMouseDown={keepFocus}>
      {preview && <svg aria-hidden width={preview.width} height={preview.height} viewBox={`0 0 ${preview.width} ${preview.height}`} className="block max-w-none rounded-md shadow-lg ring-1 ring-[#6de7d4]/70"><TextMark data={preview.data} box={preview.view} /></svg>}
      {chem && <div className="flex max-w-[min(92vw,31rem)] flex-wrap gap-1">
        {FORMULA_SIGNS.map((sign) => <button key={sign.title} type="button" title={sign.title} aria-label={sign.title} className={`grid place-items-center rounded-lg bg-[#1c2c45] px-1.5 text-base font-semibold text-white shadow-lg hover:bg-[#2a3f61] ${coarse ? "h-10 min-w-10" : "h-8 min-w-8"}`} onClick={() => typeSign(sign)}>{sign.label}</button>)}
      </div>}
      {(coarse || counter) && <div className="flex items-center gap-1.5">
        {coarse && <button type="button" className="flex h-10 items-center gap-1.5 rounded-lg bg-[#6de7d4] px-3 text-base font-semibold text-[#10243a] shadow-lg" onClick={onCommit}><Check size={18} />Готово</button>}
        {coarse && <button type="button" title="Закрыть без сохранения" aria-label="Закрыть без сохранения" className="grid size-10 place-items-center rounded-lg bg-[#1c2c45] text-base text-white shadow-lg" onClick={onCancel}><X size={18} /></button>}
        {counter && <span className="rounded-md bg-[#0e192c]/85 px-2 py-0.5 text-xs tabular-nums text-slate-200">{text.length}/{TEXT_MAX_CHARS}</span>}
      </div>}
    </div>}
  </>;
}
