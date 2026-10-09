import { estimateMeasureEm, TEXT_WEIGHT, textFontCss, type MeasureEm } from "@/lib/annotation-text";

const MEASURE_PX = 100;
const CACHE_LIMIT = 2000;

type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

// Created on first use in the browser; the opener's canvas also serves PiP (same fonts, same realm).
let context: Context | null | undefined;
let contextFont = "";
const cache = new Map<string, number>();
const measures = new Map<number, MeasureEm>();

function canvasContext(): Context | null {
  if (context !== undefined) return context;
  if (typeof window === "undefined") return null;
  let next: Context | null = null;
  try {
    if (typeof OffscreenCanvas === "function") next = new OffscreenCanvas(1, 1).getContext("2d");
  } catch {
    next = null;
  }
  if (!next) {
    try {
      next = globalThis.document?.createElement("canvas").getContext("2d") ?? null;
    } catch {
      next = null;
    }
  }
  context = next;
  return next;
}

function measureEm(text: string, weight: number): number {
  if (!text) return 0;
  const key = `${weight}:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const ctx = canvasContext();
  if (!ctx) return estimateMeasureEm(text);
  const font = textFontCss(MEASURE_PX, weight);
  if (contextFont !== font) {
    ctx.font = font;
    contextFont = font;
  }
  const width = ctx.measureText(text).width / MEASURE_PX;
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, width);
  return width;
}

// Width in em of TEXT_FONT at `weight`; stable per weight, safe to call during server render (estimates there).
export function getMeasureEm(weight = TEXT_WEIGHT): MeasureEm {
  let measure = measures.get(weight);
  if (!measure) {
    measure = (text: string) => measureEm(text, weight);
    measures.set(weight, measure);
  }
  return measure;
}
