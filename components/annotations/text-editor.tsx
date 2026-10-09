"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { Check, X } from "lucide-react";
import { getMeasureEm } from "@/components/annotations/text-measure";
import { fontPx as unitsToFontPx, TEXT_FONT, type Size } from "@/lib/annotation-geometry";
import { plateFor, TEXT_LINE_HEIGHT, TEXT_MAX_CHARS, TEXT_PAD_X, TEXT_PAD_Y, TEXT_PLATE_RADIUS_EM, TEXT_WEIGHT, textMetrics } from "@/lib/annotation-text";
import type { Point } from "@/lib/confa-types";

// targetId: the saved text being edited (absent for a new mark); original: what it was, to skip unchanged saves.
export type TextEditorState = { key: string; targetId?: string; point: Point; color: string; fontSize: number; maxWidth: number; text: string; original?: { text: string; color: string; fontSize: number } };
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

const MIN_FONT_PX = 16; // iOS zooms the page into inputs with a smaller computed font
const COUNTER_FROM = 400;
const ACTIONS_GAP = 6;
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return Number.isFinite(value) ? `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})` : hex;
}

// Mounted while text can be opened, so focus() runs inside the user's click (iOS shows the keyboard only then).
// The textarea has a computed font of at least 16 px and is scaled down to the mark's size, so lines wrap where the saved mark will.
export function TextEditor({ editorRef, state, box, coarse, scale = 1, onChange, onCommit, onCancel }: Props) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const px = state ? unitsToFontPx(state.fontSize, box.height) : MIN_FONT_PX;
  const editorFont = Math.max(MIN_FONT_PX, px);
  const k = px > 0 ? px / editorFont : 1;
  const metrics = useMemo(() => state ? textMetrics({ text: state.text, fontSize: state.fontSize, maxWidth: state.maxWidth, box, measure: getMeasureEm() }) : null, [state, box]);
  const left = state ? state.point[0] * box.width : 0;
  const top = state && metrics ? Math.max(0, Math.min(state.point[1] * box.height, box.height - metrics.h * box.height)) : 0;
  const cssWidth = state ? state.maxWidth * box.width / k : 1;
  const open = state !== null;
  const text = state?.text ?? "";
  const counter = text.length > COUNTER_FROM;
  const showActions = open && (coarse || counter);
  const plate = plateFor(state?.color ?? "#ffffff");
  const unscale = 1 / (scale > 0 ? scale : 1);

  // Auto-grow and the actions row below the plate (above it near the bottom edge): DOM writes only.
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
    const actions = actionsRef.current;
    if (!actions) return;
    const below = top + height * k + ACTIONS_GAP;
    const own = actions.offsetHeight * unscale;
    actions.style.top = `${below + own <= box.height ? below : Math.max(0, top - own - ACTIONS_GAP)}px`;
    actions.style.left = `${Math.max(0, Math.min(left, box.width - actions.offsetWidth * unscale))}px`;
  }, [editorRef, open, text, editorFont, cssWidth, k, top, left, box, unscale, showActions]);

  // Fallback for openings outside a click (the click handler focuses synchronously).
  const key = state?.key;
  useEffect(() => {
    const element = editorRef.current;
    if (key && element && element.ownerDocument.activeElement !== element) element.focus({ preventScroll: true });
  }, [editorRef, key]);

  return <>
    <textarea
      ref={editorRef}
      aria-label="Текст пометки"
      tabIndex={open ? 0 : -1}
      aria-hidden={open ? undefined : true}
      rows={1}
      maxLength={TEXT_MAX_CHARS}
      enterKeyHint={coarse ? "enter" : "done"}
      placeholder={coarse ? "Текст…" : "Текст… Enter — сохранить"}
      spellCheck
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
        if (next && typeof next.closest === "function" && next.closest(".annotation-toolbar,[data-slot=popover-content]")) return;
        onCommit();
      }}
    />
    {showActions && <div ref={actionsRef} data-gesture-ignore className="absolute z-20 flex items-center gap-1.5 text-base" style={{ left, top, transform: unscale === 1 ? undefined : `scale(${unscale})`, transformOrigin: "0 0" }} onPointerDown={keepFocus} onMouseDown={keepFocus}>
      {coarse && <button type="button" className="flex h-10 items-center gap-1.5 rounded-lg bg-[#6de7d4] px-3 text-base font-semibold text-[#10243a] shadow-lg" onClick={onCommit}><Check size={18} />Готово</button>}
      {coarse && <button type="button" title="Закрыть без сохранения" aria-label="Закрыть без сохранения" className="grid size-10 place-items-center rounded-lg bg-[#1c2c45] text-base text-white shadow-lg" onClick={onCancel}><X size={18} /></button>}
      {counter && <span className="rounded-md bg-[#0e192c]/85 px-2 py-0.5 text-xs tabular-nums text-slate-200">{text.length}/{TEXT_MAX_CHARS}</span>}
    </div>}
  </>;
}
